# Subscription Desk

This fork adds a Next.js dashboard for ChatGPT (Codex OAuth) and Claude (Claude
Code OAuth) subscriptions. The Go proxy serves the compiled dashboard at
`/subscriptions/`; production runs as one binary without a Node.js server.

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
