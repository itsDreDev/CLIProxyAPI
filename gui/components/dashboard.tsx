"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  accountStatus,
  callbackPayload,
  oauthConnectionMode,
  providerOf,
  totals,
  type OAuthConnectionMode,
} from "../lib/accounts";
import type {
  Account,
  AccountModel,
  OAuthSession,
  ProxyConfig,
} from "../lib/contracts";
import {
  ACCOUNT_POLL_INTERVAL_MS,
  useAccounts,
  useDesk,
  useInvalidateAccounts,
  useOAuthStatus,
  useSettings,
} from "../lib/desk";

type Page = "accounts" | "activity" | "settings";
type DialogName = "unlock" | "connect" | "oauth" | "details" | "remove" | null;
const cadence = ACCOUNT_POLL_INTERVAL_MS / 1000;
const pageLabels = {
  accounts: "Accounts",
  activity: "Activity",
  settings: "Connection & routing",
};
const number = (value?: number) =>
  new Intl.NumberFormat().format(Number(value) || 0);
const identity = (account: Account) =>
  account.email || account.label || account.name;
const providerName = (provider: string) =>
  provider === "codex" ? "ChatGPT" : "Claude";
const date = (value?: string) => {
  const parsed = value ? new Date(value) : null;
  return parsed &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.getFullYear() > 1970
    ? parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not yet";
};
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request could not be completed.";
const statusOf = (error: unknown) =>
  error && typeof error === "object" && "status" in error
    ? error.status
    : undefined;

const currentConnectionMode = () =>
  oauthConnectionMode(
    window.location.origin,
    process.env.NODE_ENV === "development"
      ? process.env.NEXT_PUBLIC_API_ORIGIN
      : undefined,
  );

function Modal({
  name,
  titleId,
  children,
  onClose,
}: {
  name: string;
  titleId: string;
  children: ReactNode;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      id={`${name}-dialog`}
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose?.();
      }}
    >
      {children}
    </dialog>
  );
}

function CloseButton({
  onClick,
  label = "Close",
  id,
}: {
  onClick: () => void;
  label?: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      className="icon-button"
      type="button"
      aria-label={label}
      onClick={onClick}
    >
      ×
    </button>
  );
}

function ProviderLogo({ provider }: { provider: string }) {
  return (
    <span
      aria-hidden="true"
      className={`provider-logo ${provider === "codex" ? "openai-logo" : "claude-logo"}`}
    >
      ✳
    </span>
  );
}

export function Dashboard() {
  const { api, connected, unlock, lock } = useDesk();
  const query = useAccounts();
  const invalidateAccounts = useInvalidateAccounts();
  const [page, setPage] = useState<Page>("accounts");
  const [network, setNetwork] = useState<OAuthConnectionMode | null>(null);
  const [dialog, setDialog] = useState<DialogName>("unlock");
  const [key, setKey] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [session, setSession] = useState<OAuthSession | null>(null);
  const [callback, setCallback] = useState("");
  const [callbackReceived, setCallbackReceived] = useState(false);
  const [selected, setSelected] = useState<Account | null>(null);
  const [models, setModels] = useState<AccountModel[] | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const startingOAuth = useRef(false);
  const generation = useRef(0);
  const detailsRequest = useRef(0);
  const oauth = useOAuthStatus(session);
  const accounts = connected ? query.data || [] : [];
  const summary = totals(accounts);
  const visible = accounts.filter(
    (account) =>
      (filter === "all" || providerOf(account) === filter) &&
      `${identity(account)} ${account.name}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );

  useEffect(() => {
    try {
      setNetwork(currentConnectionMode());
    } catch {
      setToast({
        message:
          "The proxy API origin is invalid. Check the dashboard configuration.",
        error: true,
      });
    }
  }, []);

  useEffect(() => {
    const update = () => {
      const hash = window.location.hash.slice(1);
      setPage(hash === "activity" || hash === "settings" ? hash : "accounts");
    };
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  useEffect(() => {
    if (connected) {
      setDialog((current) => (current === "unlock" ? null : current));
      return;
    }
    generation.current += 1;
    detailsRequest.current += 1;
    setDialog("unlock");
    setKey("");
    setSession(null);
    setCallback("");
    setCallbackReceived(false);
    setSelected(null);
    setModels(null);
    setModelsError("");
    setSearch("");
    setFilter("all");
    setToast(null);
    startingOAuth.current = false;
  }, [connected]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (oauth.data?.status !== "ok" || !session) return;
    setToast({
      message: `${providerName(session.provider)} account connected.`,
      error: false,
    });
    setSession(null);
    setCallback("");
    setCallbackReceived(false);
    setDialog(null);
    void invalidateAccounts();
  }, [oauth.data, session, invalidateAccounts]);

  const notify = useCallback(
    (message: string, error = false) => setToast({ message, error }),
    [],
  );
  const run = async (name: string, action: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(name));
    try {
      await action();
    } catch (error) {
      if (statusOf(error) === -1) return;
      if (statusOf(error) === 401) lock();
      notify(messageOf(error), true);
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      });
    }
  };
  const openConnect = () =>
    setDialog(connected ? (session ? "oauth" : "connect") : "unlock");
  const close = () => {
    detailsRequest.current += 1;
    setDialog(null);
    setSelected(null);
    setModels(null);
    setModelsError("");
  };

  const lockDashboard = () => {
    if (session)
      void api
        .request(`/oauth/session?state=${encodeURIComponent(session.state)}`, {
          method: "DELETE",
        })
        .catch(() => {});
    generation.current += 1;
    setKey("");
    setUnlockError("");
    setSession(null);
    setCallback("");
    setSelected(null);
    setModels(null);
    setToast(null);
    lock();
    setDialog("unlock");
  };

  const submitUnlock = async (event: FormEvent) => {
    event.preventDefault();
    const supplied = key.trim();
    setKey("");
    setUnlockError("");
    setBusy((current) => new Set(current).add("unlock"));
    try {
      await unlock(supplied);
      setDialog(null);
    } catch (error) {
      setUnlockError(messageOf(error));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete("unlock");
        return next;
      });
    }
  };

  const startOAuth = async (provider: "codex" | "claude") => {
    if (!connected) {
      setDialog("unlock");
      return;
    }
    if (session) {
      setDialog("oauth");
      return;
    }
    if (startingOAuth.current) return;
    startingOAuth.current = true;
    const currentGeneration = generation.current;
    // Open during the click event so browsers allow the sign-in tab.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    await run("oauth-start", async () => {
      let created: { url: string; state: string } | undefined;
      try {
        created = await api.request<{ url: string; state: string }>(
          `/oauth/auth-url?provider=${provider}&is_webui=${currentConnectionMode().isWebUI}`,
        );
        const url = new URL(created.url);
        if (
          url.protocol !== "https:" ||
          typeof created.state !== "string" ||
          !created.state
        )
          throw new Error("The proxy returned an invalid sign-in link.");
        if (currentGeneration !== generation.current) {
          popup?.close();
          return;
        }
        setSession({
          provider,
          state: created.state,
          url: url.href,
          started: Date.now(),
        });
        setCallback("");
        setCallbackReceived(false);
        setDialog("oauth");
        if (popup) popup.location.replace(url.href);
        else notify("Use “Open sign-in page” to continue.");
      } catch (error) {
        popup?.close();
        if (created?.state)
          await api
            .request(
              `/oauth/session?state=${encodeURIComponent(created.state)}`,
              { method: "DELETE" },
            )
            .catch(() => {});
        throw error;
      }
    });
    startingOAuth.current = false;
  };

  const cancelOAuth = () =>
    run("oauth-cancel", async () => {
      if (session)
        await api.request(
          `/oauth/session?state=${encodeURIComponent(session.state)}`,
          { method: "DELETE" },
        );
      setSession(null);
      setCallback("");
      setCallbackReceived(false);
      setDialog(null);
    });

  const details = (account: Account) => {
    const currentGeneration = generation.current;
    const request = ++detailsRequest.current;
    setSelected(account);
    setModels(null);
    setModelsError("");
    setDialog("details");
    void run(`details:${account.name}`, async () => {
      try {
        const result = await api.request<{ models?: AccountModel[] }>(
          `/credentials/models?name=${encodeURIComponent(account.name)}`,
        );
        if (
          currentGeneration === generation.current &&
          request === detailsRequest.current
        )
          setModels(result.models || []);
      } catch (error) {
        if (
          currentGeneration === generation.current &&
          request === detailsRequest.current
        )
          setModelsError(messageOf(error));
        throw error;
      }
    });
  };

  const importCredential = (file?: File) =>
    run("import", async () => {
      if (!file) return;
      if (file.size > 1024 * 1024)
        throw new Error("Choose a credential JSON file smaller than 1 MB.");
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error("This file is not valid JSON.");
      }
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        !["codex", "claude"].includes(providerOf(data as Partial<Account>))
      )
        throw new Error("Choose a Codex or Claude credential JSON file.");
      const form = new FormData();
      form.append(
        "file",
        file,
        `${providerOf(data as Partial<Account>)}-import-${crypto.randomUUID()}.json`,
      );
      await api.request("/credentials", { method: "POST", body: form });
      notify("Account credential imported.");
      await invalidateAccounts();
    });

  const stale = connected && query.isError;
  const updated = query.dataUpdatedAt
    ? new Date(query.dataUpdatedAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";
  const oauthMessage =
    oauth.data?.status === "error"
      ? oauth.data.error || "Sign-in failed. Close this window and try again."
      : oauth.isError
        ? `${messageOf(oauth.error)} Retrying…`
        : callbackReceived
          ? "Callback received. Waiting for the proxy to save your credentials…"
          : network?.remote
            ? "Finish sign-in in the new tab, then paste the complete callback URL or Claude code#state below. This page checks completion automatically every 1.5 seconds."
            : "Complete sign-in in the new tab. This page updates automatically every 1.5 seconds.";

  return (
    <>
      <aside className="sidebar">
        <a href="#accounts" className="brand">
          <span className="brand-icon">
            s<span>▰</span>
          </span>
          <span>
            subscription
            <br />
            <strong>desk</strong>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">P</span>
          <div>
            Personal workspace
            <small>
              CLIProxyAPI / {network?.remote ? "shared host" : "local"}
            </small>
          </div>
          <span className="local-dot" />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {(["accounts", "activity", "settings"] as Page[]).map(
            (name, index) => (
              <a
                key={name}
                href={`#${name}`}
                data-page={name}
                className={page === name ? "active" : ""}
                aria-current={page === name ? "page" : undefined}
              >
                <span aria-hidden="true">{["▦", "↗", "⚙"][index]}</span>
                {pageLabels[name]}
                {name === "accounts" && (
                  <span id="nav-count" className="count">
                    {accounts.length}
                  </span>
                )}
              </a>
            ),
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-icon">◈</div>
          <strong>
            {network?.remote
              ? "Credentials stay on the proxy host."
              : "Your accounts, on your machine."}
          </strong>
          <p>
            Sign in with your subscriptions.
            <br />
            {network?.remote
              ? "Use one shared proxy across your devices."
              : "Keep credentials in your local proxy."}
          </p>
          <a href="/management.html">Advanced management ↗</a>
          <div className="version">
            <span className="local-dot" />{" "}
            {network?.remote ? "Shared dashboard" : "Local dashboard"}{" "}
            <span>v1.0</span>
          </div>
        </div>
      </aside>
      <div className="shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span>
            <strong id="breadcrumb-page">{pageLabels[page]}</strong>
          </div>
          <div className="topbar-actions">
            <span
              id="connection-status"
              role="status"
              className={`connection-status ${stale ? "error" : connected ? "connected" : ""}`}
            >
              {stale
                ? "Live updates interrupted"
                : connected
                  ? `Live · every ${cadence}s`
                  : "Disconnected"}
            </span>
            {connected && (
              <button
                id="lock-button"
                className="quiet"
                type="button"
                onClick={lockDashboard}
              >
                Lock dashboard
              </button>
            )}
            <span className="avatar">P</span>
          </div>
        </header>
        <main>
          {stale && (
            <div id="stale-notice" className="notice" role="status">
              Account data may be out of date. {messageOf(query.error)} Live
              updates will retry automatically.
            </div>
          )}
          <section
            id="page-accounts"
            className="page"
            hidden={page !== "accounts"}
          >
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR AI, IN ONE PLACE</div>
                <h1>
                  Subscription accounts<span>.</span>
                </h1>
                <p>Bring your ChatGPT and Claude accounts together.</p>
              </div>
              <button
                className="primary"
                id="add-account"
                type="button"
                onClick={openConnect}
              >
                <span>＋</span> Connect account
              </button>
            </div>
            <div className="stats">
              <div className="stat">
                <span>Connected accounts</span>
                <strong id="stat-total">
                  {connected ? number(accounts.length) : "—"}
                </strong>
                <small>ChatGPT & Claude</small>
              </div>
              <div className="stat">
                <span>Ready to use</span>
                <strong id="stat-active">
                  {connected ? number(summary.ready) : "—"}
                </strong>
                <small>
                  <i className="local-dot" /> Enabled and available
                </small>
              </div>
              <div className="stat">
                <span>Proxy requests</span>
                <strong id="stat-requests">
                  {connected ? number(summary.requests) : "—"}
                </strong>
                <small>Since proxy restart</small>
              </div>
              <div className="stat">
                <span>Success rate</span>
                <strong id="stat-success">
                  {connected && summary.requests
                    ? `${Math.round((summary.success / summary.requests) * 100)}%`
                    : "—"}
                </strong>
                <small>Across your connected accounts</small>
              </div>
            </div>
            <div className="section-heading">
              <h2>Your providers</h2>
              <span>Subscription access via OAuth</span>
            </div>
            <div className="providers">
              {(["codex", "claude"] as const).map((provider) => {
                const count = accounts.filter(
                  (account) => providerOf(account) === provider,
                ).length;
                return (
                  <article
                    key={provider}
                    className={`provider-card ${provider === "codex" ? "chatgpt" : "claude"}`}
                  >
                    <div className="provider-top">
                      <ProviderLogo provider={provider} />
                      <span className="provider-tag">
                        {provider === "codex" ? "OpenAI" : "Anthropic"}
                      </span>
                    </div>
                    <h3>{providerName(provider)}</h3>
                    <p>
                      Your {providerName(provider)} subscription, connected
                      through {provider === "codex" ? "Codex" : "Claude Code"}.
                    </p>
                    <div className="provider-bottom">
                      <span id={`${provider}-count`}>
                        {count
                          ? `${count} account${count === 1 ? "" : "s"} connected`
                          : "No accounts connected"}
                      </span>
                      <button
                        data-connect={provider}
                        className="outline"
                        type="button"
                        disabled={busy.has("oauth-start")}
                        onClick={() => void startOAuth(provider)}
                      >
                        Connect {providerName(provider)} <span>↗</span>
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="section-heading account-heading">
              <div>
                <h2>
                  Connected accounts{" "}
                  <span id="list-count" className="count">
                    {accounts.length}
                  </span>
                </h2>
                <p>Manage which accounts your proxy can use.</p>
              </div>
              <div className="table-tools">
                <button
                  id="import-account"
                  className="quiet"
                  type="button"
                  disabled={busy.has("import")}
                  onClick={() =>
                    connected ? importRef.current?.click() : setDialog("unlock")
                  }
                >
                  ↑ Import JSON
                </button>
                <input
                  id="import-file"
                  type="file"
                  accept=".json,application/json"
                  hidden
                  ref={importRef}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void importCredential(file);
                  }}
                />
                <button
                  id="refresh-list"
                  className="quiet"
                  type="button"
                  disabled={query.isFetching}
                  onClick={() =>
                    connected
                      ? void run("list", invalidateAccounts)
                      : setDialog("unlock")
                  }
                >
                  ↻ {query.isFetching && connected ? "Refreshing…" : "Refresh"}
                </button>
              </div>
            </div>
            <div className="account-panel">
              <div className="filters">
                <div className="tabs" aria-label="Filter accounts">
                  {["all", "codex", "claude"].map((provider) => (
                    <button
                      key={provider}
                      data-filter={provider}
                      aria-pressed={filter === provider}
                      className={filter === provider ? "selected" : ""}
                      type="button"
                      onClick={() => setFilter(provider)}
                    >
                      {provider === "all"
                        ? "All accounts"
                        : providerName(provider)}
                    </button>
                  ))}
                </div>
                <label className="search">
                  <span aria-hidden="true">⌕</span>
                  <input
                    type="search"
                    id="account-search"
                    aria-label="Search accounts"
                    placeholder="Search accounts…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
              </div>
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label="Connected accounts table"
              >
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Plan</th>
                      <th>Status</th>
                      <th>Requests</th>
                      <th>Last refreshed</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody id="account-rows">
                    {visible.map((account) => {
                      const status = accountStatus(account);
                      const provider = providerOf(account);
                      return (
                        <tr key={account.name}>
                          <td>
                            <div className="account-identity">
                              <ProviderLogo provider={provider} />
                              <div>
                                <strong title={identity(account)}>
                                  {identity(account)}
                                </strong>
                                <small>
                                  {providerName(provider)} · {account.name}
                                </small>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="plan">
                              {account.id_token?.plan_type ||
                                account.plan_type ||
                                "Not reported"}
                            </span>
                          </td>
                          <td>
                            <span
                              className={`badge ${status.className}`}
                              title={account.status_message}
                            >
                              {status.label}
                            </span>
                          </td>
                          <td>
                            {number(
                              (Number(account.success) || 0) +
                                (Number(account.failed) || 0),
                            )}
                          </td>
                          <td>{date(account.last_refresh)}</td>
                          <td>
                            <div className="row-actions">
                              <button
                                className="quiet"
                                data-action="toggle"
                                type="button"
                                aria-label={`${status.label === "Paused" ? "Resume" : "Pause"} ${identity(account)}`}
                                disabled={busy.has(`toggle:${account.name}`)}
                                onClick={() =>
                                  void run(
                                    `toggle:${account.name}`,
                                    async () => {
                                      const disabled = !(
                                        account.disabled ||
                                        account.status === "disabled"
                                      );
                                      await api.request("/credentials/status", {
                                        method: "PATCH",
                                        body: {
                                          name: account.name,
                                          auth_index: account.auth_index,
                                          disabled,
                                        },
                                      });
                                      notify(
                                        `Account ${disabled ? "paused" : "resumed"}.`,
                                      );
                                      await invalidateAccounts();
                                    },
                                  )
                                }
                              >
                                {status.label === "Paused" ? "Resume" : "Pause"}
                              </button>
                              <button
                                className="quiet"
                                data-action="details"
                                type="button"
                                aria-label={`Details for ${identity(account)}`}
                                onClick={() => details(account)}
                              >
                                Details ↗
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!visible.length && (
                <div id="empty-state" className="empty-state">
                  <span className="empty-icon">◈</span>
                  <h3>
                    {accounts.length
                      ? "No matching accounts."
                      : "A home for your AI accounts."}
                  </h3>
                  <p>
                    {accounts.length
                      ? "Try a different provider filter or search."
                      : connected
                        ? "Connect your first ChatGPT or Claude account to get started."
                        : "Unlock your proxy, then connect your first ChatGPT or Claude account."}
                  </p>
                  {!accounts.length && (
                    <button
                      id="empty-connect"
                      type="button"
                      className="outline"
                      onClick={openConnect}
                    >
                      Get connected ↗
                    </button>
                  )}
                </div>
              )}
              <div className="table-footer">
                <span id="last-updated">
                  {connected && updated
                    ? `Updated ${updated} · automatic refresh every ${cadence}s`
                    : "Waiting for connection"}
                </span>
                <span>
                  Credentials stay on the proxy host{" "}
                  <span className="local-dot" />
                </span>
              </div>
            </div>
            <div className="footnote">
              <span>ⓘ</span>
              <p>
                This dashboard manages subscription access through your proxy.
                Billing, renewals, and cancellations are managed in{" "}
                <a
                  href="https://chatgpt.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ChatGPT ↗
                </a>{" "}
                and{" "}
                <a
                  href="https://claude.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Claude ↗
                </a>
                .
              </p>
            </div>
          </section>
          <section
            id="page-activity"
            className="page"
            hidden={page !== "activity"}
          >
            <div className="page-heading">
              <div>
                <div className="eyebrow">THE BIG PICTURE</div>
                <h1>
                  Proxy activity<span>.</span>
                </h1>
                <p>
                  Request counts observed by this proxy, since its last restart.
                </p>
              </div>
            </div>
            <div className="activity-layout">
              <div className="account-panel">
                <div className="panel-heading">
                  <h2>Requests by account</h2>
                  <span className="muted">Successful / failed</span>
                </div>
                <div id="activity-chart" className="activity-chart">
                  {accounts.length ? (
                    accounts.map((account) => (
                      <div className="chart-row" key={account.name}>
                        <div className="chart-label">
                          <span>{identity(account)}</span>
                          <span>
                            {number(account.success)} / {number(account.failed)}
                          </span>
                        </div>
                        <div className="chart-track">
                          <progress
                            value={Number(account.success) || 0}
                            max={Math.max(
                              1,
                              ...accounts.map(
                                (item) =>
                                  (Number(item.success) || 0) +
                                  (Number(item.failed) || 0),
                              ),
                            )}
                            aria-label={`Successful requests for ${identity(account)}`}
                          />
                          <progress
                            className="failed"
                            value={Number(account.failed) || 0}
                            max={Math.max(
                              1,
                              ...accounts.map(
                                (item) =>
                                  (Number(item.success) || 0) +
                                  (Number(item.failed) || 0),
                              ),
                            )}
                            aria-label={`Failed requests for ${identity(account)}`}
                          />
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="muted">
                      Connect an account to see its proxy activity here.
                    </p>
                  )}
                </div>
              </div>
              <div className="account-panel activity-note">
                <span className="privacy-icon">↗</span>
                <h2>Know what you&apos;re measuring.</h2>
                <p>
                  These counts cover requests routed through this proxy. They do
                  not include activity in the ChatGPT or Claude apps.
                </p>
                <p>
                  Provider limits are shown as observed cooldowns on your
                  account. Remaining subscription allowances are not estimated.
                </p>
              </div>
            </div>
          </section>
          <section
            id="page-settings"
            className="page"
            hidden={page !== "settings"}
          >
            <div className="page-heading">
              <div>
                <div className="eyebrow">MAKE IT YOURS</div>
                <h1>
                  Connection & routing<span>.</span>
                </h1>
                <p>
                  Connect your tools and choose how accounts share requests.
                </p>
              </div>
            </div>
            {connected ? (
              <Settings
                enabled={page === "settings"}
                notify={notify}
                run={run}
                busy={busy}
                network={network}
              />
            ) : (
              <div className="account-panel settings-card">
                <p>
                  Unlock the dashboard to manage routing and client API keys.
                </p>
                <button
                  className="primary"
                  type="button"
                  onClick={() => setDialog("unlock")}
                >
                  Unlock dashboard
                </button>
              </div>
            )}
          </section>
        </main>
        <footer className="main-footer">
          <span>SUBSCRIPTION DESK</span>
          <span>
            Built for your workflow <span>·</span> Powered by CLIProxyAPI
          </span>
        </footer>
      </div>
      {dialog === "unlock" && (
        <Modal name="unlock" titleId="unlock-title">
          <form id="unlock-form" onSubmit={(event) => void submitUnlock(event)}>
            <span className="dialog-icon">◈</span>
            <div className="eyebrow">WELCOME TO YOUR WORKSPACE</div>
            <h2 id="unlock-title">Let&apos;s get connected.</h2>
            <p>Enter your proxy management key to access your accounts.</p>
            <label htmlFor="management-key">Management key</label>
            <input
              id="management-key"
              type="password"
              autoComplete="off"
              required
              placeholder="Your management key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <p className="field-note">
              Kept in memory for this tab. Reloading locks the dashboard.
            </p>
            {unlockError && (
              <div id="unlock-error" className="error" role="alert">
                {unlockError}
              </div>
            )}
            <button
              className="primary full-width"
              type="submit"
              disabled={busy.has("unlock")}
            >
              {busy.has("unlock") ? "Connecting…" : "Unlock dashboard"}{" "}
              <span>→</span>
            </button>
          </form>
        </Modal>
      )}
      {dialog === "connect" && (
        <Modal name="connect" titleId="connect-title" onClose={close}>
          <div className="dialog-heading">
            <span className="eyebrow">ADD AN ACCOUNT</span>
            <CloseButton onClick={close} />
          </div>
          <h2 id="connect-title">Choose your provider.</h2>
          <p>Sign in securely in a new browser tab.</p>
          <div className="connect-options">
            {(["codex", "claude"] as const).map((provider) => (
              <button
                data-connect={provider}
                type="button"
                key={provider}
                disabled={busy.has("oauth-start")}
                onClick={() => void startOAuth(provider)}
              >
                <ProviderLogo provider={provider} />
                <span>
                  <strong>{providerName(provider)}</strong>
                  <small>
                    Connect through{" "}
                    {provider === "codex" ? "Codex" : "Claude Code"} OAuth
                  </small>
                </span>
                <span>↗</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {dialog === "oauth" && session && (
        <Modal
          name="oauth"
          titleId="oauth-title"
          onClose={() => void cancelOAuth()}
        >
          <div className="dialog-heading">
            <span className="eyebrow">CONNECT YOUR ACCOUNT</span>
            <CloseButton
              id="cancel-oauth"
              onClick={() => void cancelOAuth()}
              label="Cancel sign-in"
            />
          </div>
          <h2 id="oauth-title">Connect {providerName(session.provider)}.</h2>
          <p
            id="oauth-status"
            role="status"
            className={oauth.data?.status === "error" ? "error-text" : ""}
          >
            {oauthMessage}
          </p>
          {network?.remote && (
            <div id="remote-oauth-guidance" className="notice" role="note">
              This proxy runs on another host. After sign-in, a redirect to
              localhost refers to this browsing device and may fail to load.
              Copy the complete callback URL from that tab&apos;s address bar
              and paste it below, or paste the Claude authorization{" "}
              <code>code#state</code>.
            </div>
          )}
          {toast?.error && (
            <div className="error" role="alert">
              {toast.message}
            </div>
          )}
          <a
            id="oauth-link"
            className="outline full-width"
            href={session.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open sign-in page ↗
          </a>
          <form
            id="callback-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run("callback", async () => {
                await api.request("/oauth/callback", {
                  method: "POST",
                  body: callbackPayload(callback, session),
                });
                setCallback("");
                setCallbackReceived(true);
                notify("Callback received. Finishing sign-in…");
              });
            }}
          >
            <label htmlFor="callback-input">
              Have a callback URL or authorization code?
            </label>
            <input
              id="callback-input"
              aria-describedby={
                network?.remote ? "remote-oauth-guidance" : undefined
              }
              type="text"
              autoComplete="off"
              placeholder="Paste the returned URL or code"
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
            />
            <button
              className="quiet"
              type="submit"
              disabled={busy.has("callback") || oauth.data?.status === "error"}
            >
              Complete sign-in →
            </button>
          </form>
          <p className="field-note">
            Credentials are saved by the proxy after authorization succeeds.
          </p>
          <button
            className="quiet full-width"
            type="button"
            disabled={busy.has("oauth-cancel")}
            onClick={() => void cancelOAuth()}
          >
            Cancel sign-in
          </button>
        </Modal>
      )}
      {dialog === "details" && selected && (
        <Modal name="details" titleId="details-title" onClose={close}>
          <div className="dialog-heading">
            <span className="eyebrow">ACCOUNT DETAILS</span>
            <CloseButton onClick={close} />
          </div>
          <h2 id="details-title">{identity(selected)}</h2>
          <div id="details-content">
            <AccountDetails account={selected} />{" "}
            <h3 className="muted">Available models</h3>
            <div className="model-list">
              {modelsError ? (
                <p className="error-text" role="alert">
                  {modelsError}
                </p>
              ) : models === null ? (
                <p className="muted">Loading available models…</p>
              ) : models.length ? (
                models.map((model, index) => (
                  <code key={`${model.id || model.name}-${index}`}>
                    {model.id || model.name}
                  </code>
                ))
              ) : (
                <p className="muted">No models currently registered.</p>
              )}
            </div>
            <div className="dialog-actions">
              <button
                id="refresh-credential"
                type="button"
                className="outline"
                disabled={busy.has("refresh-credential")}
                onClick={() =>
                  void run("refresh-credential", async () => {
                    await api.request("/credentials/refresh", {
                      method: "POST",
                      body: {
                        name: selected.name,
                        auth_index: selected.auth_index,
                      },
                    });
                    notify("Account credentials refreshed.");
                    close();
                    await invalidateAccounts();
                  })
                }
              >
                Refresh sign-in
              </button>
              <button
                id="remove-credential"
                type="button"
                className="danger"
                onClick={() => setDialog("remove")}
              >
                Remove account
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "remove" && selected && (
        <Modal name="remove" titleId="remove-title" onClose={close}>
          <form
            id="remove-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run("remove", async () => {
                await api.request(
                  `/credentials?name=${encodeURIComponent(selected.name)}`,
                  { method: "DELETE" },
                );
                close();
                notify("Account disconnected.");
                await invalidateAccounts();
              });
            }}
          >
            <div className="dialog-heading">
              <span className="eyebrow">DISCONNECT ACCOUNT</span>
              <CloseButton onClick={close} />
            </div>
            <h2 id="remove-title">Remove this account?</h2>
            <p id="remove-description">
              Disconnect {identity(selected)} from your{" "}
              {network?.remote ? "shared" : "local"} proxy.
            </p>
            <p>
              The stored credential file will be deleted. You can sign in again
              later. Your provider subscription stays active.
            </p>
            <div className="dialog-actions">
              <button type="button" className="outline" onClick={close}>
                Keep account
              </button>
              <button
                className="danger"
                type="submit"
                disabled={busy.has("remove")}
              >
                Remove account
              </button>
            </div>
          </form>
        </Modal>
      )}
      {toast && (
        <div
          id="toast"
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.message}
        </div>
      )}
    </>
  );
}

function AccountDetails({ account }: { account: Account }) {
  const pairs: [string, string][] = [
    ["Provider", providerName(providerOf(account))],
    ["Status", accountStatus(account).label],
    ["Details", account.status_message || "No errors reported"],
    ["Credential file", account.name],
    ["Last refreshed", date(account.last_refresh)],
    ["Next retry", date(account.next_retry_after)],
    [
      "Requests",
      `${number(account.success)} successful · ${number(account.failed)} failed`,
    ],
  ];
  if (account.id_token?.chatgpt_subscription_active_until)
    pairs.push([
      "Subscription end (reported by provider)",
      date(account.id_token.chatgpt_subscription_active_until),
    ]);
  if (account.quota?.observed_at)
    pairs.push(["Quota last observed", date(account.quota.observed_at)]);
  pairs.push(...Object.entries(account.quota?.signals || {}));
  return (
    <dl className="details-list">
      {pairs.map(([name, value], index) => (
        <div key={`${name}-${index}`}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Settings({
  enabled,
  notify,
  run,
  busy,
  network,
}: {
  enabled: boolean;
  notify: (message: string, error?: boolean) => void;
  run: (name: string, action: () => Promise<void>) => Promise<void>;
  busy: Set<string>;
  network: OAuthConnectionMode | null;
}) {
  const { api } = useDesk();
  const query = useSettings(enabled);
  const [strategy, setStrategy] = useState("round-robin");
  const [keys, setKeys] = useState<string[]>([]);
  const endpoint = network ? `${network.proxyOrigin}/v1` : "";
  useEffect(() => {
    if (query.data) {
      setStrategy(query.data.routing?.strategy || "round-robin");
      setKeys(query.data.access?.["api-keys"] || []);
    }
  }, [query.data]);
  const copy = async (value: string) => {
    if (!navigator.clipboard)
      throw new Error(
        "Clipboard access is unavailable. Open this dashboard on localhost or HTTPS.",
      );
    await navigator.clipboard.writeText(value);
    notify("Copied to clipboard.");
  };
  return (
    <>
      {query.isError && (
        <div className="notice" role="status">
          Could not load settings. {messageOf(query.error)}{" "}
          <button
            className="quiet"
            onClick={() => void query.refetch()}
            type="button"
          >
            Retry
          </button>
        </div>
      )}
      <div className="settings-layout">
        <section className="account-panel settings-card">
          <h2>
            {network?.remote ? "Shared API endpoint" : "Local API endpoint"}
          </h2>
          <p>Use this base URL in an OpenAI-compatible client.</p>
          <div className="copy-field">
            <code id="api-endpoint">{endpoint}</code>
            <button
              id="copy-endpoint"
              className="quiet"
              type="button"
              onClick={() => void run("copy-endpoint", () => copy(endpoint))}
            >
              Copy
            </button>
          </div>
          <p className="muted">
            Use a client API key below. The dashboard management key is
            separate.
          </p>
        </section>
        <section
          className="account-panel settings-card network-card"
          id="network-card"
        >
          <h2>Proxy host & devices</h2>
          <p>
            {network?.remote
              ? "One shared proxy serves your devices. Use the same API endpoint above on every computer; accounts and routing are managed on that proxy host."
              : "This browser connects to a proxy on this computer. To use one shared proxy from other devices, open its shared hostname and use that host's API endpoint."}
          </p>
          <dl className="details-list">
            <dt>Dashboard origin</dt>
            <dd>
              <code id="dashboard-origin">
                {network?.dashboardOrigin || "Loading…"}
              </code>
            </dd>
            <dt>Proxy origin</dt>
            <dd>
              <code id="proxy-origin">
                {network?.proxyOrigin || "Loading…"}
              </code>
            </dd>
          </dl>
          {network?.tailscaleHTTPS && (
            <p id="tailscale-https" className="network-status">
              <span className="local-dot" /> Tailscale HTTPS hostname detected
            </p>
          )}
          <p className="muted">
            Your management key stays in this tab&apos;s memory. Subscription
            credentials stay on the proxy host.
          </p>
        </section>
        <form
          id="routing-form"
          className="account-panel settings-card"
          onSubmit={(event) => {
            event.preventDefault();
            void run("routing", async () => {
              await api.request("/config/routing/strategy", {
                method: "PUT",
                body: strategy,
              });
              notify("Routing strategy saved.");
              await query.refetch();
            });
          }}
        >
          <h2>Account routing</h2>
          <p>Choose how the proxy selects matching, available accounts.</p>
          <label htmlFor="routing-strategy">Routing strategy</label>
          <select
            id="routing-strategy"
            value={strategy}
            onChange={(event) => setStrategy(event.target.value)}
            disabled={!query.data}
          >
            <option value="round-robin">
              Round robin — rotate between accounts
            </option>
            <option value="weighted-round-robin">
              Weighted round robin — use credential weights
            </option>
            <option value="fill-first">
              Fill first — use the first available account
            </option>
          </select>
          <button
            className="primary"
            type="submit"
            disabled={!query.data || busy.has("routing")}
          >
            Save routing
          </button>
        </form>
        <section className="account-panel settings-card">
          <h2>Client API keys</h2>
          <p>
            These keys let your tools call the{" "}
            {network?.remote ? "shared" : "local"} proxy.
          </p>
          <div id="client-keys" className="client-keys">
            {query.isPending ? (
              <p className="muted">Loading client API keys…</p>
            ) : keys.length ? (
              keys.map((key, index) => (
                <div className="client-key" key={index}>
                  <code>{key.slice(0, 6)}••••••••</code>
                  <button
                    data-copy-key={index}
                    className="quiet"
                    type="button"
                    onClick={() =>
                      void run(`copy-key:${index}`, () => copy(key))
                    }
                  >
                    Copy key
                  </button>
                </div>
              ))
            ) : (
              <p className="muted">No client API keys configured.</p>
            )}
          </div>
          <button
            id="generate-key"
            className="outline"
            type="button"
            disabled={!query.data || busy.has("generate-key")}
            onClick={() =>
              void run("generate-key", async () => {
                const config = await api.request<ProxyConfig>("/config");
                const bytes = crypto.getRandomValues(new Uint8Array(24));
                const key = `sk-local-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
                const nextKeys = [...(config.access?.["api-keys"] || []), key];
                await api.request("/config/access/api-keys", {
                  method: "PUT",
                  body: nextKeys,
                });
                setKeys(nextKeys);
                notify(
                  "Client key saved. Use “Copy key” to connect your tool.",
                );
                await query.refetch();
              })
            }
          >
            ＋ Generate client key
          </button>
        </section>
        <section className="account-panel settings-card">
          <h2>Private by default</h2>
          <p>
            Your management key is held in this tab&apos;s memory. Locking the
            dashboard or reloading clears access.
          </p>
          <p>
            Subscription credentials stay with your proxy. Use a client key when
            connecting your tools.
          </p>
        </section>
      </div>
    </>
  );
}
