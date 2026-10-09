#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Always initialize the checkout containing this script, regardless of cwd.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "config.yaml");
const authDir = resolve(root, "auths");
const secret = () => randomBytes(24).toString("hex");
const config = `# Personal subscription dashboard. Keep this file private.
config-version: 8
server:
  host: "127.0.0.1"
  port: 8317
management:
  allow-remote: false
  secret-key: "${secret()}"
  disable-control-panel: false
  disable-auto-update-panel: true
access:
  api-keys:
    - "sk-local-${secret()}"
oauth:
  auth-dir: ${JSON.stringify(authDir)}
routing:
  strategy: "round-robin"
observability:
  usage:
    usage-statistics-enabled: true
`;

try {
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  await writeFile(configPath, config, { flag: "wx", mode: 0o600 });
  console.log(
    "Created config.yaml with separate random management and client keys.",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("config.yaml already exists; your configuration was preserved.");
}
console.log(
  "Before starting the proxy, copy management.secret-key from config.yaml.",
);
console.log(
  "The proxy hashes the stored key on startup; keep your original key in a password manager.",
);
console.log("Start: ./cli-proxy-api --config config.yaml --local-model");
console.log("Dashboard: http://127.0.0.1:8317/subscriptions/");
