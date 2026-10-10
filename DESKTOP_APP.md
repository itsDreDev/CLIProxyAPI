# Subscription Desk desktop

The Tauri 2 app adds native windows, a tray menu, and start/stop controls to the
existing Next.js dashboard. It bundles the Go proxy and compiled dashboard;
installed users do not need Node.js or Go. The dashboard remains accessible in
a browser over Tailscale.

## Use the app

Open **Subscription Desk** and choose **This computer** on the computer that will
host your shared proxy. Click **Start proxy**, then **Copy key** and **Open
dashboard**. Paste the management key into the dashboard to unlock it, and
connect your ChatGPT and Claude accounts there. Provider sign-in opens in your
system browser.

The app creates a dedicated configuration and auth directory under its private
application data directory. The controls show its configuration path. Your
checkout's `config.yaml` and accounts are preserved. The original management
key is retained in a separate private file because the Go server hashes the
configuration's key on startup. Key copying goes directly from Rust to the
system clipboard, without sending the key into the controls webview. Unix
profile directories have mode 0700 and files have mode 0600.

Closing a window leaves the app in the tray. Use **Show Controls** or **Show
Dashboard** to reopen it, **Start Proxy** and **Stop Proxy** to control the owned
server, and **Quit** to exit. Stop and Quit terminate only a process launched by
this app. If port 8317 already has a listener, the app reports it as externally
managed; use that proxy's existing management key. A TCP listener alone does not
confirm that it is CLIProxyAPI. Stop the external proxy before starting the app's
own profile if you want to use the desktop's generated key and account store.

## Share one host with Tailscale

Keep the host app running and connected to Tailscale. Sign into the same tailnet
on each client computer. On the host, publish its localhost listener privately:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8317
tailscale serve status
```

Use the actual port from the desktop profile if you changed it. If that HTTPS
port already serves another app, use an unused port such as 8443 and include it
in the connection URL. Tailscale may ask you to enable tailnet HTTPS. Restrict
tailnet access to the intended devices and retain separate management/client
keys. The [shared-host guide](SUBSCRIPTION_GUI.md#one-shared-proxy-through-tailscale)
also provides a configuration-checking setup helper for source checkouts.

On each client desktop, choose **Connect shared host**, enter the complete
`https://<host>.<tailnet>.ts.net` origin, and click **Use this host**. Open the
dashboard and unlock it with the host's management key. Shared-host selection
does not establish reachability; an unavailable host is reported when its
dashboard is opened. You can also use the dashboard in a browser at
`https://<host>.<tailnet>.ts.net/subscriptions/`.

Connecting to a shared host stops a local proxy owned by this app. The selected
host stays active for the current app session. Every device uses the same host
accounts and provider allowances; tokens are stored on that host. Remote OAuth
uses the dashboard's manual callback flow. Copy the callback URL from the system
browser back into the dashboard when its localhost redirect cannot complete on
the browsing computer.

Configure your tools with the host's client key and
`https://<host>.<tailnet>.ts.net/v1` API base URL. Tailscale Serve persists its
mapping, but exiting the host app stops its owned proxy. Keep the host app open
in the tray while other computers need it.

## Build from source

Requires Node.js 24+, Go 1.26+, Rust 1.90+, and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
For Debian/Ubuntu, the native build dependencies are:

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev build-essential patchelf
```

From the checkout root:

```sh
npm ci --prefix gui
npm ci --prefix desktop
npm run desktop:build --prefix desktop
```

This builds the Next.js dashboard, a Go sidecar matching Rust's host target,
the native controls, and platform installers. Build each package on its target
operating system. Installer output is under
`desktop/src-tauri/target/release/bundle/`. Linux uses GTK/WebKitGTK, macOS uses
WKWebView, and Windows uses WebView2. The GitHub desktop workflow builds Linux,
Windows, and macOS installers as downloadable artifacts. Those installers are
unsigned; signing requires platform signing credentials.

For native development:

```sh
npm run desktop:dev --prefix desktop
```

Vite serves the small native controls UI on localhost:1420. The account dashboard
is still the existing Next.js export embedded in the Go sidecar; account changes
continue using TanStack Query's polling and focus/reconnect refresh. Rebuild the
sidecar after changing the Go code or account dashboard.

The packaging script accepts `--target <Rust-target-triple>` when preparing a
specific sidecar. `--skip-frontend` reuses an existing compiled dashboard:

```sh
node scripts/prepare-desktop.mjs --target aarch64-apple-darwin
```

## Checks and native access

```sh
npm run build --prefix desktop
node --test desktop/tests/*.test.mjs
npm run test:e2e --prefix desktop
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --no-default-features
cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml
```

The pure Rust tests do not need GTK/WebKit development libraries. Browser tests
exercise the controls with simulated Tauri IPC and the production CSP; they
require a built `desktop/dist` and Chromium. Native checks and packaging require
the platform libraries. These checks use isolated configuration and test
credentials, without signing into provider accounts.

After preparing the sidecar, add `-- --include-ignored` to the Rust test command
to include the real Go start/stop and key-preservation integration check. On
Linux, an optional test opens the compiled app through real WebKit automation:

```sh
python3 desktop/tests/native-smoke.py \
  --application /absolute/path/to/subscription-desk \
  --driver /path/to/tauri-driver \
  --native-driver /path/to/WebKitWebDriver
```

This needs Python 3, Xvfb, `dbus-run-session`, ImageMagick's `import`, `xclip`,
Tauri's `tauri-driver`, and WebKitWebDriver. The native
binary must use the bundled controls assets and have its packaged Go sidecar
next to it. The smoke check uses a temporary profile and port, verifies native
IPC and the real management API, and saves a screenshot outside the checkout.

Only the bundled controls window receives native permissions. The dashboard
opens in a separate window at the proxy's actual origin with no native
capabilities; it cannot start processes, read files, or retrieve native keys.
Dashboard navigation is restricted to the selected origin. Only provider OAuth
links open in the system browser. No general shell execution or filesystem
permissions are exposed to the webviews.
