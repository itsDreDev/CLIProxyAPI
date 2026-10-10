# Subscription Desk

This fork adds a Next.js dashboard for ChatGPT (Codex OAuth) and Claude (Claude
Code OAuth) subscriptions. The Go proxy serves the compiled dashboard at
`/subscriptions/`; production runs as one binary without a Node.js server.
The optional [Tauri desktop app](DESKTOP_APP.md) bundles this same server and
dashboard with native tray and process controls.

## Build and start

Requires Go 1.26+ and Node.js 24+. Node is needed for building the frontend and
running tests. It is not needed to run the compiled proxy.

```sh
npm ci --prefix gui
npm run build --prefix gui

go build -o cli-proxy-api ./cmd/server
node scripts/setup-subscriptions.mjs
```

Before starting, copy `management.secret-key` from the generated `config.yaml`
into a password manager. The proxy hashes this value on startup, so the stored
hash cannot unlock the dashboard.

```sh
./cli-proxy-api --config config.yaml --local-model
```

Open <http://127.0.0.1:8317/subscriptions/> and enter your original management key.
Setup binds to localhost and generates separate random management and client
keys. It preserves any existing `config.yaml`. For an existing configuration,
set a known `management.secret-key` before starting and ensure
`management.disable-control-panel` is false. Use your configured server port.

## One shared proxy through Tailscale

Run this proxy on one computer that stays on. Sign into Tailscale on that host
and each computer that will use it, using the same tailnet. Install the proxy
only on the host; accounts, routing, activity, and credentials live there.
Every connected device draws from the same provider account allowances.

The setup script above creates the shared-host configuration:

```yaml
server:
  host: "127.0.0.1"
  port: 8317
  trusted-proxies: []
  tls:
    enable: false
management:
  allow-remote: false
```

Keep your generated management and client keys. Tailscale Serve provides HTTPS
and forwards the whole origin to localhost. Management still requires its key;
the empty trusted-proxy list preserves the backend's loopback access check.
The setup helper validates an existing configuration without rewriting it.
Restart the proxy with that file after any configuration changes; the helper
checks the file and dashboard availability, rather than inspecting the active
process's listening interfaces.

Start the proxy as described above, then in another terminal on the host:

```sh
tailscale up
node scripts/tailscale-subscriptions.mjs enable
```

Tailscale may ask you to enable HTTPS for your tailnet. The helper prints the
dashboard URL and client API base URL once Serve confirms the mapping. Open the
dashboard URL from another Tailscale computer and unlock it with the management
key. For OpenAI-compatible tools, use the printed `https://<host>.ts.net/v1`
base URL and a client API key from Connection & routing. Tools using the native
Anthropic protocol use the same HTTPS origin with their `/v1/messages` endpoint.
There is no need to expose port 8317 on your LAN or install Node on client devices.

Serve is private to your tailnet and its access rules. The helper never enables
public Funnel, resets Serve, or overwrites another app's mapping. If HTTPS port
443 is occupied, use `--https-port 8443`; the printed URLs include that port.
Use `--config /path/to/config.yaml` for another configuration path. Setup requires
the dependencies installed by `npm ci --prefix gui`.

```sh
node scripts/tailscale-subscriptions.mjs status
node scripts/tailscale-subscriptions.mjs disable
# With a custom port, use that same --https-port value for every command.
```

Disable uses the backend port in the supplied configuration to identify its
mapping. If you moved the file, pass its new path with `--config`. If the backend
port changed or the file was deleted, inspect `tailscale serve status` and remove
the old mapping with `tailscale serve --https=443 off` (using its actual HTTPS
port). That command removes everything served on the selected port, so check
the mapping first.

Status reports Tailscale state and configured mappings; it does not establish
that the proxy or another computer is reachable. The background Serve mapping
persists, while the proxy must keep running. On Linux, you can run the proxy
under a user service by saving this as
`~/.config/systemd/user/cliproxy-subscriptions.service`, replacing both checkout
paths with your actual absolute path:

```ini
[Unit]
Description=Shared subscription proxy
After=network-online.target

[Service]
WorkingDirectory=/absolute/path/to/CLIProxyAPI
ExecStart=/absolute/path/to/CLIProxyAPI/cli-proxy-api --config /absolute/path/to/CLIProxyAPI/config.yaml --local-model
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now cliproxy-subscriptions
# Keep user services running after logout on the host:
loginctl enable-linger "$USER"
```

Stop a foreground copy of the proxy before starting the service. Restrict
tailnet access to the intended users/devices. Failed management-key attempts
through Serve share the existing loopback rate-limit bucket, so repeated bad
keys can temporarily block all dashboard operators. A `MANAGEMENT_PASSWORD`
environment override changes the upstream management policy; the host's
loopback listener remains the network boundary for this setup.

When signing into ChatGPT or Claude from another computer, the dashboard uses
manual completion. Finish provider sign-in, then paste the complete callback
URL from the browser's address bar (even if its localhost page fails), or the
Claude authorization code with its state, into the dashboard. The host completes
the exchange and saves the credential. The provider's registered localhost
redirect URI remains unchanged.

See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and the
[Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
for tailnet HTTPS and access setup.

Docker builds and release pipelines build the frontend before compiling Go.
Generated dashboard assets are ignored in Git; source is under `gui/`. A Go
build made without the frontend export serves an explicit build instruction
instead of a partial dashboard.

## Live updates

Next.js App Router and React provide the interface. TanStack Query manages
server state, caching, revalidation, request cancellation, and bounded retries.
The dashboard uses the current `/v8/management` API.

Accounts and activity refresh every five seconds while the tab is visible,
and revalidate on focus/reconnection. Account changes invalidate cached data.
Pending OAuth sessions poll every 1.5 seconds and stop after completion,
cancellation, failure, or expiry. The proxy management API has no SSE or
WebSocket account feed, so these are automatic polling updates.

The management key is kept in memory; locking or reloading clears credentials
and private query data. API calls stay on the same origin. The bundled Go server
sets a Content Security Policy with hashes for Next.js's exact inline bootstrap
scripts. Existing management authentication and remote-access restrictions apply.

## Account management

Connect multiple ChatGPT and Claude accounts through browser OAuth. If automatic
redirection fails, paste the returned callback URL or authorization code.
Import credential JSON without overwriting an existing filename. Search and
filter accounts, pause/resume routing, inspect reported plans, registered models,
observed quota signals, refresh credentials, or remove accounts.

Activity shows successful and failed requests routed through this proxy since
its last restart. Provider app usage is not included. Plans and quota details
are shown when reported; remaining subscription allowances are not estimated.
Billing, plan changes, renewals, and cancellation remain in the provider's own
account settings. Live OAuth token exchange needs your own provider accounts.

Use the Connection & routing page to set account routing and generate or copy
client API keys for tools. Client keys are separate from the management key.
The upstream advanced panel remains at `/management.html`. The dashboard is
unavailable in Home mode or when the control panel is disabled.

## Development and checks

Run the Go backend on its usual port, then start Next.js with hot reload:

```sh
npm run dev --prefix gui
# Open http://localhost:3000/subscriptions/
```

Dev API requests forward to `http://127.0.0.1:8317`; override this with
`PROXY_API_ORIGIN` when using another backend port. Rebuild the frontend and Go
binary to include source changes in the bundled production dashboard.
The client endpoint shown in development points to the Go backend directly.

```sh
npm test --prefix gui
npm run typecheck --prefix gui
npm run build --prefix gui
go test ./...
go build -o cli-proxy-api ./cmd/server

# Browser integration checks against an isolated local proxy:
cd gui
npx playwright install chromium
npm run test:e2e
```

Browser checks use temporary configuration and auth files rather than personal
credentials. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium path
when desired. The fork retains the upstream Go module name for simpler merges;
`origin` is your fork and `upstream` is the original repository.
