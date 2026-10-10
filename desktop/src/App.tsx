import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  command,
  nativeAvailable,
  publicError,
  remoteOrigin,
  type ProxyStatus,
} from "./native";

type Mode = "local" | "remote";
interface Activity {
  id: number;
  message: string;
  failed: boolean;
  time: string;
}

export function App() {
  const native = nativeAvailable();
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [mode, setMode] = useState<Mode>("local");
  const [origin, setOrigin] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [activity, setActivity] = useState<Activity[]>([]);
  const [lastChecked, setLastChecked] = useState("");
  const operation = useRef(false);
  const refreshPending = useRef(false);
  const mounted = useRef(false);
  const nextActivity = useRef(0);
  const lastReportedError = useRef("");
  const statusGeneration = useRef(0);

  const log = useCallback((message: string, failed = false) => {
    setActivity((current) =>
      [
        {
          id: ++nextActivity.current,
          message,
          failed,
          time: new Date().toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
        ...current,
      ].slice(0, 8),
    );
  }, []);

  useEffect(() => {
    if (!native) return;
    let active = true;
    let unlisten: UnlistenFn | undefined;
    const release = (listener: UnlistenFn) => {
      void Promise.resolve()
        .then(listener)
        .catch(() => {});
    };
    void listen<unknown>("desktop-error", (event) => {
      if (!active) return;
      const message = publicError(event.payload);
      setError(message);
        lastReportedError.current = message;
      log(message, true);
    })
      .then((listener) => {
        if (active) unlisten = listener;
        else release(listener);
      })
      .catch((caught) => {
        if (!active) return;
        const message = `Could not receive tray updates. ${publicError(caught)}`;
        setError(message);
        log(message, true);
      });
    return () => {
      active = false;
      if (unlisten) release(unlisten);
    };
  }, [native, log]);

  const refresh = useCallback(
    async (initial = false) => {
      if (!native || refreshPending.current || operation.current) return;
      refreshPending.current = true;
      const generation = statusGeneration.current;
      try {
        const next = await command<ProxyStatus>("get_status");
        if (!mounted.current || generation !== statusGeneration.current) return;
        setStatus(next);
        setLastChecked(
          new Date().toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        );
        if (initial) {
          setMode(next.mode);
          if (next.mode === "remote" && next.endpoint)
            setOrigin(new URL(next.endpoint).origin);
        }
        const message = next.error ? publicError(next.error) : "";
        setStatusError(message);
        if (message && message !== lastReportedError.current)
          log(message, true);
        lastReportedError.current = message;
      } catch (caught) {
        if (!mounted.current || generation !== statusGeneration.current) return;
        const message = publicError(caught);
        setStatusError(message);
        if (message !== lastReportedError.current) log(message, true);
        lastReportedError.current = message;
      } finally {
        refreshPending.current = false;
      }
    },
    [native, log],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", visible);
    };
  }, [refresh]);

  const perform = async (name: string, action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    statusGeneration.current += 1;
    setPending(name);
    setError("");
    setStatusError("");
    setFeedback("");
    try {
      await action();
    } catch (caught) {
      const message = publicError(caught);
      setError(message);
      log(message, true);
    } finally {
      operation.current = false;
      setPending("");
    }
  };

  const changeToLocal = () =>
    void perform("local", async () => {
      const next = await command<ProxyStatus>("use_local");
      setStatus(next);
      setMode("local");
      log("Selected the proxy on this computer.");
    });

  const connectRemote = (event: FormEvent) => {
    event.preventDefault();
    void perform("remote", async () => {
      const address = remoteOrigin(origin);
      const next = await command<ProxyStatus>("connect_remote", {
        origin: address,
      });
      setStatus(next);
      setMode("remote");
      setOrigin(address);
      log("Selected the shared proxy host.");
      setFeedback(
        "Shared host selected. Open the dashboard and unlock it with that host’s management key.",
      );
    });
  };

  const changeProxy = (start: boolean) =>
    void perform(start ? "start" : "stop", async () => {
      const next = await command<ProxyStatus>(
        start ? "start_proxy" : "stop_proxy",
      );
      setStatus(next);
      log(
        start
          ? "Started the proxy on this computer."
          : "Stopped the proxy started by this app.",
      );
    });

  const copyKey = () =>
    void perform("copy-key", async () => {
      await command("copy_management_key");
      setFeedback(
        "Management key copied. Paste it into the dashboard to unlock your local proxy.",
      );
      log("Copied the local management key to the clipboard.");
    });

  const canOpen =
    !!status &&
    (status.mode === "remote" ? !!status.dashboard_url : status.running);
  const localSelected = mode === "local";
  const tailscale =
    status?.mode === "remote" &&
    (() => {
      try {
        const url = new URL(status.endpoint);
        return url.protocol === "https:" && url.hostname.endsWith(".ts.net");
      } catch {
        return false;
      }
    })();
  const label = !native
    ? "Desktop app required"
    : statusError
      ? "Status unavailable"
      : !status
        ? "Checking proxy…"
        : status.mode === "remote"
          ? "Shared host selected"
          : status.running
            ? "Proxy running"
            : "Proxy stopped";

  return (
    <div className="desktop-shell">
      <header className="app-header">
        <a className="brand" href="#home" aria-label="Subscription Desk home">
          <span className="brand-icon" aria-hidden="true">
            s<span>▰</span>
          </span>
          <span>
            subscription
            <br />
            <strong>desk</strong>
          </span>
        </a>
        <span className="desktop-label">
          <span className="status-dot" /> DESKTOP WORKSPACE
        </span>
      </header>
      <main>
        <div className="heading">
          <div>
            <p className="eyebrow">YOUR AI, YOUR WORKSPACE</p>
            <h1>
              A desk for your subscriptions<span>.</span>
            </h1>
            <p className="subtitle">
              Start a proxy here, or connect to the shared host your devices
              already use.
            </p>
          </div>
          <span className="platform-mark" aria-hidden="true">
            ◈
          </span>
        </div>
        {!native && (
          <div id="desktop-required" className="notice" role="status">
            <strong>Open the desktop app to get started.</strong>
            <p>
              This browser preview cannot start or stop a proxy. Native controls
              become available when you launch Subscription Desk on your
              computer.
            </p>
          </div>
        )}
        <div className="workspace-grid">
          <section className="mode-panel" aria-labelledby="choose-host">
            <p className="eyebrow" id="choose-host">
              CHOOSE YOUR WORKSPACE
            </p>
            <button
              id="host-local"
              type="button"
              className={`mode-card ${localSelected ? "selected" : ""}`}
              aria-pressed={localSelected}
              disabled={!native || !!pending || !status}
              onClick={changeToLocal}
            >
              <span className="mode-icon" aria-hidden="true">
                ▣
              </span>
              <span>
                <strong>Host this computer</strong>
                <small>Run your own local proxy</small>
              </span>
              <span className="selection" aria-hidden="true">
                {localSelected ? "✓" : "→"}
              </span>
            </button>
            <button
              id="connect-shared"
              type="button"
              className={`mode-card ${!localSelected ? "selected" : ""}`}
              aria-pressed={!localSelected}
              disabled={!native || !!pending || !status}
              onClick={() => {
                setMode("remote");
                setError("");
                setFeedback("");
              }}
            >
              <span className="mode-icon warm" aria-hidden="true">
                ⌘
              </span>
              <span>
                <strong>Connect shared host</strong>
                <small>One proxy, across your devices</small>
              </span>
              <span className="selection" aria-hidden="true">
                {!localSelected ? "✓" : "→"}
              </span>
            </button>
            <div className="workspace-note">
              <span aria-hidden="true">◈</span>
              <p>
                Credentials stay on the proxy host. Your dashboard opens in its
                own window.
              </p>
            </div>
          </section>
          <section className="control-panel" aria-labelledby="workspace-title">
            <div className="panel-top">
              <span className="eyebrow">
                {localSelected ? "ON THIS COMPUTER" : "YOUR SHARED WORKSPACE"}
              </span>
              <span
                id="proxy-status"
                className={`status-badge ${status?.mode === "local" && status.running ? "ready" : ""}`}
                role="status"
              >
                <span className="status-dot" />
                {label}
              </span>
            </div>
            <h2 id="workspace-title">
              {localSelected
                ? "Make yourself at home."
                : "Bring your devices together."}
            </h2>
            <p className="panel-description">
              {localSelected
                ? "Subscription Desk runs CLIProxyAPI with a dedicated local profile. Connect your accounts in the dashboard when the proxy is ready."
                : "Use your shared proxy’s Tailscale HTTPS address. Accounts and routing stay on that host, and every device uses the same API endpoint."}
            </p>
            {localSelected ? (
              <>
                <div className="local-actions">
                  <button
                    id="start-proxy"
                    type="button"
                    className="primary"
                    disabled={
                      !native ||
                      !!pending ||
                      !status ||
                      status.mode !== "local" ||
                      status.running
                    }
                    onClick={() => changeProxy(true)}
                  >
                    {pending === "start" ? "Starting proxy…" : "Start proxy"}{" "}
                    <span aria-hidden="true">→</span>
                  </button>
                  <button
                    id="stop-proxy"
                    type="button"
                    className="outline"
                    disabled={
                      !native ||
                      !!pending ||
                      !status ||
                      status.mode !== "local" ||
                      !status.running ||
                      !status.owned
                    }
                    onClick={() => changeProxy(false)}
                  >
                    {pending === "stop" ? "Stopping…" : "Stop proxy"}
                  </button>
                </div>
                {status?.mode === "local" &&
                  status.running &&
                  !status.owned && (
                    <p className="field-note">
                      This proxy was started outside the desktop app. Its
                      process is managed separately.
                    </p>
                  )}
                <div className="profile-row">
                  <div>
                    <strong>Dashboard management key</strong>
                    <small>Stored in your native local profile</small>
                  </div>
                  <button
                    id="copy-management-key"
                    type="button"
                    className="quiet"
                    disabled={
                      !native ||
                      !!pending ||
                      !status ||
                      status.mode !== "local" ||
                      (status.running && !status.owned)
                    }
                    onClick={copyKey}
                  >
                    {pending === "copy-key" ? "Copying…" : "Copy key ↗"}
                  </button>
                </div>
              </>
            ) : (
              <form id="remote-form" onSubmit={connectRemote}>
                <label htmlFor="remote-origin">
                  Tailscale HTTPS proxy address
                </label>
                <div className="remote-input">
                  <input
                    id="remote-origin"
                    type="url"
                    required
                    placeholder="https://proxy.example.ts.net"
                    autoComplete="off"
                    spellCheck={false}
                    value={origin}
                    disabled={!native || !!pending}
                    onChange={(event) => setOrigin(event.target.value)}
                  />
                  <button
                    id="save-remote"
                    className="primary"
                    type="submit"
                    disabled={!native || !!pending}
                  >
                    {pending === "remote" ? "Saving…" : "Use this host"}{" "}
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
                <p className="field-note">
                  Open the dashboard and use the shared host’s management key to
                  unlock it. No accounts are copied to this device.
                </p>
              </form>
            )}
            {(error || statusError) && (
              <div id="desktop-error" className="error" role="alert">
                {error || statusError}
              </div>
            )}
            {feedback && (
              <div id="desktop-feedback" className="feedback" role="status">
                {feedback}
              </div>
            )}
            <div className="connection-details">
              <div>
                <span>Active proxy endpoint</span>
                <code id="proxy-endpoint">
                  {status?.endpoint || "Waiting for a native profile"}
                </code>
              </div>
              {tailscale && (
                <span id="tailscale-host" className="tailscale-tag">
                  Tailscale HTTPS hostname
                </span>
              )}
            </div>
            <button
              id="open-dashboard"
              className="outline full-width"
              type="button"
              disabled={!native || !!pending || !canOpen}
              onClick={() =>
                void perform("open", async () => {
                  await command("open_dashboard");
                  log("Opened the subscription dashboard.");
                })
              }
            >
              {pending === "open"
                ? "Opening dashboard…"
                : "Open subscription dashboard"}{" "}
              <span aria-hidden="true">↗</span>
            </button>
            <p className="field-note dashboard-note">
              {status?.mode === "remote"
                ? "Shared-host availability is confirmed by the dashboard when you unlock it."
                : "Use the system tray to open your workspace or start and stop the local proxy."}
            </p>
          </section>
        </div>
        <section className="activity-panel" aria-labelledby="activity-title">
          <div className="section-heading">
            <h3 id="activity-title">Workspace activity</h3>
            <span>
              {native && lastChecked
                ? `Checked ${lastChecked} · updates every 2s`
                : "Native status only"}
            </span>
          </div>
          <ol id="activity-log">
            {activity.length ? (
              activity.map((item) => (
                <li key={item.id} className={item.failed ? "failed" : ""}>
                  <span className="event-dot" />
                  <span>{item.message}</span>
                  <time>{item.time}</time>
                </li>
              ))
            ) : (
              <li className="empty-log">
                <span className="event-dot" />
                <span>
                  Start your local proxy or choose a shared host to begin.
                </span>
              </li>
            )}
          </ol>
        </section>
      </main>
      <footer>
        <span>SUBSCRIPTION DESK</span>
        <span>
          Powered by CLIProxyAPI <span>·</span> Your workflow, on your terms
        </span>
      </footer>
    </div>
  );
}
