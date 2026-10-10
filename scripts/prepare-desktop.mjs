#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platforms = {
  "x86_64-unknown-linux-gnu": ["linux", "amd64"],
  "aarch64-unknown-linux-gnu": ["linux", "arm64"],
  "x86_64-apple-darwin": ["darwin", "amd64"],
  "aarch64-apple-darwin": ["darwin", "arm64"],
  "x86_64-pc-windows-msvc": ["windows", "amd64"],
  "aarch64-pc-windows-msvc": ["windows", "arm64"],
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error)
    throw new Error(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${command} failed with exit code ${result.status}.`);
}

async function npmCLI() {
  const candidates = [
    process.env.npm_execpath,
    resolve(
      dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    ),
    resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    "/usr/share/nodejs/npm/bin/npm-cli.js",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(
    "Cannot find npm. Run this through npm run prepare:proxy --prefix desktop.",
  );
}

async function main() {
  let target;
  let skipFrontend = false;
  const args = process.argv.slice(2);
  while (args.length) {
    const option = args.shift();
    if (option === "--target") target = args.shift();
    else if (option === "--skip-frontend") skipFrontend = true;
    else if (option === "--help") {
      console.log(
        "Usage: node scripts/prepare-desktop.mjs [--target Rust-target-triple] [--skip-frontend]\nBuilds the bundled Next.js dashboard and Go sidecar for a desktop package.",
      );
      return;
    } else throw new Error(`Unknown option: ${option}`);
    if (option === "--target" && !target)
      throw new Error("--target needs a Rust target triple.");
  }
  if (!target) {
    const result = spawnSync("rustc", ["--print", "host-tuple"], {
      encoding: "utf8",
    });
    if (result.error || result.status !== 0)
      throw new Error("Install Rust 1.90+ to determine the desktop target.");
    target = result.stdout.trim();
  }
  const platform = platforms[target];
  if (!platform) throw new Error(`Unsupported desktop target: ${target}`);
  if (!skipFrontend) {
    run(process.execPath, [
      await npmCLI(),
      "run",
      "build",
      "--prefix",
      resolve(root, "gui"),
    ]);
  } else {
    try {
      await access(resolve(root, "internal/subscriptiongui/web/index.html"));
    } catch {
      throw new Error("Build the GUI first before using --skip-frontend.");
    }
  }
  const directory = resolve(root, "desktop/src-tauri/binaries");
  await mkdir(directory, { recursive: true });
  const [goos, goarch] = platform;
  const output = resolve(
    directory,
    `subscription-desk-proxy-${target}${goos === "windows" ? ".exe" : ""}`,
  );
  run(
    "go",
    ["build", "-trimpath", "-ldflags=-s -w", "-o", output, "./cmd/server"],
    {
      env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
    },
  );
  console.log(`Prepared desktop proxy sidecar: ${output}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
