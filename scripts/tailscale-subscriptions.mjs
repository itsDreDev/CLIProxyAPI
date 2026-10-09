#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const cli = process.env.TAILSCALE_BIN || "tailscale";

async function tailscale(args) {
  try {
    const { stdout } = await execute(cli, args, { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Install Tailscale first.");
    throw new Error(
      `Tailscale ${args[0]} failed: ${error.stderr?.trim() || "check daemon access and Tailscale status"}`,
    );
  }
}

function portNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Ports must be integers between 1 and 65535.");
  }
  return port;
}

function connection(status, httpsPort) {
  const name = status.Self?.DNSName?.replace(/\.$/, "");
  const origin =
    status.BackendState === "Running" && name && /^[a-z0-9.-]+$/i.test(name)
      ? `https://${name}${httpsPort === 443 ? "" : `:${httpsPort}`}`
      : null;
  return {
    backendState: status.BackendState,
    dashboardURL: origin ? `${origin}/subscriptions/` : null,
    clientBaseURL: origin ? `${origin}/v1` : null,
  };
}

function mapping(config, name, port, target) {
  const hostPort = `${name}:${port}`;
  if (config.AllowFunnel?.[hostPort])
    throw new Error(
      "This port has public Funnel access. Disable that mapping first or choose another HTTPS port.",
    );
  for (const foreground of Object.values(config.Foreground || {})) {
    if (
      foreground.TCP?.[port] ||
      foreground.Web?.[hostPort] ||
      foreground.AllowFunnel?.[hostPort]
    ) {
      throw new Error(
        "This port has a foreground Tailscale mapping. Stop it or choose another HTTPS port.",
      );
    }
  }
  const webEntries = Object.entries(config.Web || {}).filter(([key]) =>
    key.endsWith(`:${port}`),
  );
  const tcp = config.TCP?.[port];
  if (!tcp && webEntries.length === 0) return "absent";
  const handlers = config.Web?.[hostPort]?.Handlers;
  const proxy = handlers?.["/"]?.Proxy;
  if (
    tcp?.HTTPS === true &&
    !tcp.HTTP &&
    !tcp.TCPForward &&
    !tcp.TerminateTLS &&
    webEntries.length === 1 &&
    handlers &&
    Object.keys(handlers).length === 1 &&
    Object.keys(handlers["/"]).length === 1 &&
    proxy?.replace(/\/$/, "") === target
  ) {
    return "owned";
  }
  throw new Error(
    "This HTTPS port already serves another app. Existing mappings were preserved; choose --https-port 8443 or another unused port.",
  );
}

async function loadConfig(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `Cannot read ${path}. Run node scripts/setup-subscriptions.mjs first, or pass --config.`,
    );
  }
  let parse;
  try {
    ({ parse } = createRequire(resolve(root, "gui/package.json"))("yaml"));
  } catch {
    throw new Error("Install setup dependencies first: npm ci --prefix gui");
  }
  let config;
  try {
    config = parse(source, { merge: true });
  } catch {
    throw new Error(
      "Configuration contains invalid YAML; fix it before enabling Tailscale.",
    );
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Configuration must be a YAML mapping.");
  const value = (group, key, legacy) =>
    Object.hasOwn(config[group] || {}, key)
      ? config[group][key]
      : config[legacy];
  return {
    port: portNumber(value("server", "port", "port") ?? 8317),
    host: value("server", "host", "host"),
    tls:
      (Object.hasOwn(config.server?.tls || {}, "enable")
        ? config.server.tls.enable
        : config.tls?.enable) ?? false,
    trustedProxies: value("server", "trusted-proxies", "trusted-proxies") ?? [],
    management: { ...config["remote-management"], ...config.management },
    keys: value("access", "api-keys", "api-keys") || [],
  };
}

function validateProfile(config) {
  if (config.host !== "127.0.0.1")
    throw new Error(
      'Shared-host setup requires server.host: "127.0.0.1". Update the configuration and restart the proxy.',
    );
  if (config.tls !== false)
    throw new Error(
      "Shared-host setup requires server.tls.enable: false; Tailscale provides HTTPS.",
    );
  if (!Array.isArray(config.trustedProxies) || config.trustedProxies.length)
    throw new Error(
      "Shared-host setup requires server.trusted-proxies: [] so keyed management requests through Serve remain local.",
    );
  if (config.management["allow-remote"] === true)
    throw new Error(
      "Set management.allow-remote: false for the shared-host profile.",
    );
  if (!config.management["secret-key"])
    throw new Error(
      "Set a management.secret-key before enabling the dashboard.",
    );
  if (config.management["disable-control-panel"] === true)
    throw new Error(
      "Set management.disable-control-panel: false to enable the dashboard.",
    );
  if (
    !Array.isArray(config.keys) ||
    !config.keys.some((key) => typeof key === "string" && key.trim())
  )
    throw new Error(
      "Set at least one access.api-keys entry before sharing the proxy.",
    );
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(
      "Usage: node scripts/tailscale-subscriptions.mjs status|enable|disable [--config path] [--https-port 443]\nShares the whole proxy privately through Tailscale Serve. Never enables Funnel or resets other mappings.",
    );
    return;
  }
  const command = args.shift() || "status";
  if (!["status", "enable", "disable"].includes(command))
    throw new Error(
      "Choose status, enable, or disable. Use --help for options.",
    );
  let configPath = resolve(root, "config.yaml");
  let httpsPort = 443;
  while (args.length) {
    const option = args.shift();
    const value = args.shift();
    if (!value) throw new Error(`Missing value for ${option}.`);
    if (option === "--config") configPath = resolve(value);
    else if (option === "--https-port") httpsPort = portNumber(value);
    else throw new Error(`Unknown option: ${option}`);
  }
  const status = JSON.parse(await tailscale(["status", "--json"]));
  let serve = JSON.parse(await tailscale(["serve", "status", "--json"]));
  const urls = connection(status, httpsPort);
  if (command === "status") {
    console.log(JSON.stringify({ ...urls, serve }, null, 2));
    return;
  }
  if (!urls.dashboardURL)
    throw new Error(
      "Tailscale is not signed in with a DNS name. Run tailscale up on the proxy host, then retry.",
    );
  const config = await loadConfig(configPath);
  const target = `http://127.0.0.1:${config.port}`;
  const name = new URL(urls.dashboardURL).hostname;
  const existing = mapping(serve, name, httpsPort, target);
  if (command === "disable") {
    if (existing === "owned")
      await tailscale(["serve", `--https=${httpsPort}`, "off"]);
    console.log(
      "Shared proxy mapping disabled. Other Tailscale mappings were preserved.",
    );
    return;
  }
  validateProfile(config);
  let response;
  try {
    response = await fetch(`${target}/subscriptions/`);
  } catch {
    throw new Error(
      "Start the proxy with this configuration before enabling Tailscale Serve.",
    );
  }
  if (!response.ok || !(await response.text()).includes("Subscription Desk"))
    throw new Error(
      "The bundled dashboard is unavailable. Build the GUI and restart the proxy with this configuration.",
    );
  if (existing !== "owned") {
    await tailscale(["serve", "--bg", `--https=${httpsPort}`, "--yes", target]);
    serve = JSON.parse(await tailscale(["serve", "status", "--json"]));
    if (mapping(serve, name, httpsPort, target) !== "owned")
      throw new Error(
        "Tailscale did not confirm the expected private HTTPS mapping. Check tailscale serve status.",
      );
  }
  console.log(JSON.stringify({ ...urls, target, private: true }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
