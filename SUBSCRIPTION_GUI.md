# Subscription Desk

Run one Docker web app on a computer that stays on, then use its browser dashboard
and API from your other devices through Tailscale. ChatGPT and Claude accounts,
credentials, routing, and client keys stay on that shared proxy host.

The image builds this fork's Next.js dashboard and Go server together. The server
serves `/subscriptions/`; production needs no separate Node.js web server.

## Docker quickstart

Use a Linux host with Docker Engine, Compose, Node.js 24+, and Tailscale. Client
devices can use a browser on any operating system. Run these commands from this
fork's checkout:

```sh
npm ci --prefix gui
node scripts/setup-subscriptions.mjs --docker
```

Setup keeps the original management key in the private
`docker-data/config/management-key` file (permissions `0600`). Copy that key into
a password manager and use it to unlock the dashboard. The proxy hashes the key
in `config.yaml` on startup; use the original key rather than that hash. Setup
also creates a separate random client API key and preserves existing configuration.
For an existing profile, setup preserves the key file or recovers a plaintext
key from the config. If only a hashed config remains, restore your saved original
key into `docker-data/config/management-key` with permissions `0600`, then rerun
setup.
The Docker profile has its own `docker-data/` directory. Run setup as its owner;
`runtime.env` records that user's UID/GID, and the container runs as that user so
configuration changes and credentials remain readable from the host. To reuse accounts from
an earlier installation, import their credential JSON through the dashboard
after starting this app.

```sh
docker compose --env-file docker-data/runtime.env up -d --build
docker compose --env-file docker-data/runtime.env ps
docker compose --env-file docker-data/runtime.env logs --tail=50 cli-proxy-api
```

Open <http://127.0.0.1:8317/subscriptions/> on the host and unlock with your
management key. Compose builds the local fork image, including its dashboard.
Compose uses Linux host networking with no published ports. The proxy binds
`127.0.0.1:8317` on the host, and Tailscale provides the shared HTTPS URL.
Compose checks dashboard health on that port. If you change `server.port`, set
`CLI_PROXY_HEALTH_PORT` to the same value when running Compose.

The Docker profile keeps `server.host: "127.0.0.1"`,
`management.allow-remote: false`, and `server.trusted-proxies: []`. Management
still requires its key. Keep these settings when customizing the profile.
The helper checks both the profile and the running host-network container before
enabling sharing.

## One shared proxy through Tailscale

Install and sign into Tailscale on the proxy host and every client device using
the same tailnet. Tailscale runs on the host outside Docker. Authenticate it
there, then enable the private HTTPS mapping:

```sh
tailscale up
node scripts/tailscale-subscriptions.mjs enable --docker
```

Tailscale may ask you to enable tailnet HTTPS. The helper prints the confirmed
dashboard URL and API base URL, for example:

```text
Dashboard: https://your-host.your-tailnet.ts.net/subscriptions/
API base:  https://your-host.your-tailnet.ts.net/v1
```

Open the dashboard URL from another Tailscale device and unlock it with the
host's management key. In OpenAI-compatible tools, use the API base URL and a
client API key from **Connection & routing**. Anthropic-compatible tools use the
same HTTPS origin and `/v1/messages`. Every device shares the accounts and their
provider allowances; install the proxy only on the host.

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) follows your
tailnet access rules. Limit access to the intended users and devices. The helper
preserves other Serve mappings and never enables public Funnel. If HTTPS port
443 is occupied, add `--https-port 8443` to each helper command; the printed URLs
include that port.

```sh
node scripts/tailscale-subscriptions.mjs status --docker
node scripts/tailscale-subscriptions.mjs disable --docker
```

Status reports Tailscale configuration; confirm remote access by opening the
printed dashboard URL on another device. Requests through Serve share the
loopback management rate-limit source, so repeated invalid keys can temporarily
block other dashboard operators.

## Connect accounts from any device

Choose **Connect ChatGPT** or **Connect Claude** and finish sign-in in the new
browser tab. When you access the shared host, completion is manual: a provider's
redirect to localhost refers to the computer you are browsing on and may fail
to load. Copy the complete callback URL from that tab's address bar and paste it
into the dashboard, or paste Claude's authorization `code#state`. Keep the
provider's registered redirect URI unchanged. The proxy validates the state,
completes authorization, and saves the credential on the host.

You can connect multiple accounts, import credential JSON, search/filter,
pause/resume routing, inspect reported plans and models, refresh credentials,
and remove accounts. Billing, renewals, and cancellation remain in the provider's
account settings. Remaining subscription allowances are not estimated.

Accounts and activity refresh every five seconds in visible tabs and refresh on
focus/reconnection. Activity counts cover proxy requests since its last restart.
The dashboard keeps its management key in tab memory; locking or reloading
clears access and private cached data. Client API keys are separate from the
management key. Advanced management remains at `/management.html`.

## Persistence, restarts, updates, and backup

Compose keeps persistent data in these host paths:

| Host path | Contents |
| --- | --- |
| `docker-data/config/config.yaml` | Configuration, routing, and client keys |
| `docker-data/config/management-key` | Original dashboard management key (`0600`) |
| `docker-data/runtime.env` | Host UID/GID for Compose; contains no keys |
| `docker-data/auths/` | Saved provider credentials |
| `docker-data/logs/` | Proxy logs |

Accounts survive container restarts, image updates, and container recreation.
Keep all of `docker-data/` when moving to another host.
Tailscale authentication stays in the host's own Tailscale state.

Enable Docker and Tailscale to start with the host. Compose uses
`restart: unless-stopped`, so the container resumes when Docker starts unless
you explicitly stopped it. See [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/).
The background [Tailscale Serve mapping](https://tailscale.com/docs/reference/tailscale-cli/serve#effects-of-rebooting-and-restarting)
resumes when the host and Tailscale restart.

```sh
# Stop or resume the app while preserving its data:
docker compose --env-file docker-data/runtime.env stop
docker compose --env-file docker-data/runtime.env up -d

# After updating this checkout, rebuild this fork and replace the container:
git pull --ff-only
docker compose --env-file docker-data/runtime.env up -d --build
```

For a consistent backup, stop the app, copy `docker-data/` to your private backup
location, and start it again. Keep the backup private: it contains provider
credentials and the original management key. To restore, put those directories
back in the checkout. If restoring under a different UID/GID, update
`CLI_PROXY_USER` in `runtime.env` and restore file ownership to that user.
Rerun setup as that user, start the app with the Compose command above, and
authenticate Tailscale on the new host before enabling its mapping.
To remove the container while preserving the bind-mounted data, use
`docker compose --env-file docker-data/runtime.env down`.

## Docker smoke check

Test a built image with temporary configuration and credentials:

```sh
python3 scripts/tests/docker-smoke.py --image subscription-desk:local
# Include the browser dashboard suite (requires installed Chromium):
python3 scripts/tests/docker-smoke.py --image subscription-desk:local --browser
```

The check uses its own container and files, tests management and client keys,
embedded dashboard assets, and persistence across restarts/recreation. It leaves
your production profile untouched.

## Development and checks

Docker handles the production frontend and Go build. For local development,
install Go 1.26+ and Node.js 24+, then run:

```sh
npm ci --prefix gui
npm run build --prefix gui
go build -o cli-proxy-api ./cmd/server
node scripts/setup-subscriptions.mjs
# Save the original management.secret-key before the first start:
./cli-proxy-api --config config.yaml --local-model
```

For frontend hot reload, run `npm run dev --prefix gui` and open
<http://localhost:3000/subscriptions/>. `PROXY_API_ORIGIN` selects the Go backend;
it defaults to `http://127.0.0.1:8317`. Rebuild the frontend and Go binary to
include dashboard changes in a production binary.

```sh
npm test --prefix gui
npm run typecheck --prefix gui
npm run build --prefix gui
go test ./...
go build -o cli-proxy-api ./cmd/server

# Browser checks against an isolated proxy:
npm exec --prefix gui -- playwright install chromium
npm run test:e2e --prefix gui
```

Browser tests use temporary configuration and test credentials. Set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium executable if needed.
The dashboard uses `/v8/management`, remains unavailable in Home mode or when
the control panel is disabled, and applies the proxy's management authentication.
