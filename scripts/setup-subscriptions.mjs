#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Always initialize the checkout containing this script, regardless of cwd.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/setup-subscriptions.mjs [--docker]\nCreates a private profile without replacing existing configuration or credentials.");
  process.exit(0);
}
if (args.some((arg) => arg !== "--docker") || args.length > 1) {
  console.error("Unknown option. Use --help for options.");
  process.exit(1);
}
const docker = args.includes("--docker");
if (docker && (process.platform !== "linux" || !process.getuid || !process.getgid)) {
  console.error("The Docker shared-host profile requires a Linux Docker host.");
  process.exit(1);
}
const configPath = resolve(root, docker ? "docker-data/config/config.yaml" : "config.yaml");
const authDir = resolve(root, docker ? "docker-data/auths" : "auths");
const secret = () => randomBytes(24).toString("hex");
const managementKey = secret();
const config = `# Personal subscription dashboard. Keep this file private.
config-version: 8
server:
  host: "127.0.0.1"
  port: 8317
  trusted-proxies: []
  tls:
    enable: false
management:
  allow-remote: false
  secret-key: "${managementKey}"
  disable-control-panel: false
  disable-auto-update-panel: true
access:
  api-keys:
    - "sk-local-${secret()}"
oauth:
  auth-dir: ${JSON.stringify(docker ? "/CLIProxyAPI/auths" : authDir)}
routing:
  strategy: "round-robin"
observability:
${docker ? "  logs:\n    logging-to-file: true\n    logs-max-total-size-mb: 100\n    request-log: false\n" : ""}  usage:
    usage-statistics-enabled: true
`;

let created = false;
try {
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  if (docker) {
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await mkdir(resolve(root, "docker-data/logs"), { recursive: true, mode: 0o700 });
    const uid = process.getuid();
    const gid = process.getgid();
    for (const path of [authDir, dirname(configPath), resolve(root, "docker-data/logs"), configPath, resolve(root, "docker-data/runtime.env"), resolve(dirname(configPath), "management-key")]) {
      const metadata = await stat(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (metadata && metadata.uid !== uid) {
        throw new Error("Docker profile files must belong to the setup user. Restore docker-data ownership before retrying; existing data was preserved.");
      }
    }
    const runtimePath = resolve(root, "docker-data/runtime.env");
    const runtime = `CLI_PROXY_USER=${uid}:${gid}\n`;
    try {
      await writeFile(runtimePath, runtime, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await readFile(runtimePath, "utf8") !== runtime) {
        throw new Error("docker-data/runtime.env selects another user or contains unexpected settings. Existing data was preserved; run setup as the original profile owner.");
      }
    }
  }
  await writeFile(configPath, config, { flag: "wx", mode: 0o600 });
  created = true;
  console.log(
    `Created ${docker ? "docker-data/config/config.yaml" : "config.yaml"} with separate random management and client keys.`,
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(`${docker ? "docker-data/config/config.yaml" : "config.yaml"} already exists; your configuration was preserved.`);
}
if (docker) {
  const keyPath = resolve(dirname(configPath), "management-key");
  const existingKey = await readFile(keyPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let configured = managementKey;
  if (!created) {
    let parse;
    try {
      ({ parse } = createRequire(resolve(root, "gui/package.json"))("yaml"));
    } catch {
      throw new Error("Install setup dependencies with npm ci --prefix gui to validate the existing management key. Existing configuration was preserved.");
    }
    let existing;
    try {
      existing = parse(await readFile(configPath, "utf8"), { merge: true });
    } catch {
      throw new Error("The existing Docker configuration contains invalid YAML; it was preserved.");
    }
    configured = Object.hasOwn(existing?.management || {}, "secret-key")
      ? existing.management["secret-key"]
      : existing?.["remote-management"]?.["secret-key"];
  }
  if (typeof configured !== "string" || !configured) {
    throw new Error("Set a management secret in the existing Docker configuration; existing data was preserved.");
  }
  const validKey = (key) => key && key.length <= 72 && !/\s/.test(key) && !key.startsWith("$2");
  if (existingKey !== null) {
    if (!validKey(existingKey)) throw new Error("The saved management-key is invalid; restore the original private key. Existing data was preserved.");
    if (!configured.startsWith("$2") && configured !== existingKey) {
      throw new Error("The plaintext configuration and saved management-key disagree. Restore matching originals; existing data was preserved.");
    }
    await chmod(keyPath, 0o600);
  } else {
    if (configured.startsWith("$2")) {
      throw new Error("The original management key is unavailable. Restore docker-data/config/management-key from your saved original; the existing hashed configuration and credentials were preserved.");
    }
    if (!validKey(configured)) throw new Error("The management key is invalid; existing configuration was preserved.");
    await writeFile(keyPath, configured, { flag: "wx", mode: 0o600 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  console.log("Copy your management key from the private docker-data/config/management-key file; it survives config hashing and restarts.");
} else {
  console.log("Before starting the proxy, copy management.secret-key from config.yaml.");
  console.log("The proxy hashes the stored key on startup; keep your original key in a password manager.");
}
console.log(docker ? "Start: docker compose --env-file docker-data/runtime.env up -d --build" : "Start: ./cli-proxy-api --config config.yaml --local-model");
console.log("Dashboard: http://127.0.0.1:8317/subscriptions/");
