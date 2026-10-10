import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const managementKey = "subscription-gui-e2e-management-key";
export const initialClientKey = "subscription-gui-e2e-client-key";

export async function startProxy() {
  if (process.env.SUBSCRIPTION_GUI_BASE_URL) {
    const url = new URL(process.env.SUBSCRIPTION_GUI_BASE_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('SUBSCRIPTION_GUI_BASE_URL must be an HTTP origin without credentials');
    return { url: url.origin, stop: async () => {} };
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const listener = createServer();
  await new Promise((resolveListen, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const port = listener.address().port;
  await new Promise(resolveClose => listener.close(resolveClose));
  const directory = await mkdtemp(join(tmpdir(), "subscription-gui-e2e-"));
  await mkdir(join(directory, "auths"));
  const config = join(directory, "config.yaml");
  await writeFile(config, `config-version: 8
server:
  host: "127.0.0.1"
  port: ${port}
management:
  allow-remote: false
  secret-key: "${managementKey}"
  disable-control-panel: false
  disable-auto-update-panel: true
access:
  api-keys:
    - "${initialClientKey}"
oauth:
  auth-dir: ${JSON.stringify(join(directory, "auths"))}
routing:
  strategy: "round-robin"
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PGSTORE_|GITSTORE_|OBJECTSTORE_)/.test(key)));
  const child = spawn(process.env.SUBSCRIPTION_GUI_BINARY || join(root, "cli-proxy-api"), ["--config", config, "--local-model"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let spawnError;
  child.once("error", error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data).slice(-10000); });
  const url = `http://127.0.0.1:${port}`;
  async function stop() {
    if (child.exitCode === null && !spawnError) {
      const exited = new Promise(resolveExit => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) throw spawnError || new Error(`Proxy exited: ${output}`);
      try {
        const response = await fetch(`${url}/subscriptions/`);
        if (response.ok) return { url, stop };
      } catch {}
      await new Promise(resolvePoll => setTimeout(resolvePoll, 100));
    }
    throw new Error(`Proxy did not become ready. Build cli-proxy-api first.\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
