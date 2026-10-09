import type { Account, OAuthSession } from "./contracts";

export interface OAuthConnectionMode {
  dashboardOrigin: string;
  proxyOrigin: string;
  isWebUI: boolean;
  remote: boolean;
  tailscaleHTTPS: boolean;
}

export function oauthConnectionMode(
  origin: string,
  apiOrigin?: string,
): OAuthConnectionMode {
  const dashboard = new URL(origin);
  const proxy = new URL(apiOrigin || origin);
  if (
    ![dashboard.protocol, proxy.protocol].every(
      (protocol) => protocol === "http:" || protocol === "https:",
    )
  ) {
    throw new Error("The dashboard and proxy origins must use HTTP or HTTPS.");
  }
  const loopback = (url: URL) => {
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return (
      hostname === "localhost" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  };
  const isWebUI = loopback(dashboard) && loopback(proxy);
  return {
    dashboardOrigin: dashboard.origin,
    proxyOrigin: proxy.origin,
    isWebUI,
    remote: !isWebUI,
    tailscaleHTTPS:
      proxy.protocol === "https:" &&
      proxy.hostname.toLowerCase().endsWith(".ts.net"),
  };
}

export function providerOf(account: Partial<Account>): string {
  const provider = String(account.provider || account.type || "")
    .trim()
    .toLowerCase();
  return provider === "anthropic" ? "claude" : provider;
}

export function subscriptionAccounts(files: Account[]): Account[] {
  return files.filter(
    (account) =>
      ["codex", "claude"].includes(providerOf(account)) &&
      account.account_type?.toLowerCase() !== "api_key",
  );
}

export function accountStatus(
  account: Partial<Account> & {
    quota?: Account["quota"] & { exceeded?: boolean };
  },
) {
  if (account.disabled || account.status === "disabled")
    return { label: "Paused", className: "paused", ready: false };
  if (account.quota?.exceeded || account.unavailable)
    return { label: "Limited", className: "problem", ready: false };
  if (account.status === "error" || account.status === "pending") {
    return {
      label: account.status === "error" ? "Needs attention" : "Pending",
      className: "problem",
      ready: false,
    };
  }
  return { label: "Ready", className: "", ready: true };
}

export function totals(accounts: Account[]) {
  const count = (value: unknown) =>
    Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const success = accounts.reduce(
    (sum, account) => sum + count(account.success),
    0,
  );
  const failed = accounts.reduce(
    (sum, account) => sum + count(account.failed),
    0,
  );
  return {
    success,
    failed,
    requests: success + failed,
    ready: accounts.filter((account) => accountStatus(account).ready).length,
  };
}

export function callbackPayload(input: string, session: OAuthSession) {
  const value = input.trim();
  if (!value) throw new Error("Paste a callback URL or authorization code.");
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || states[0] !== session.state)
      throw new Error(
        "This callback belongs to a different sign-in. Check the callback state.",
      );
    return {
      provider: session.provider,
      state: session.state,
      redirect_url: value,
    };
  }
  const [code, state, extra] = value.split("#");
  if (extra !== undefined || (state !== undefined && state !== session.state)) {
    throw new Error("This authorization code belongs to a different sign-in.");
  }
  if (!code.trim())
    throw new Error("Paste a callback URL or authorization code.");
  return { provider: session.provider, state: session.state, code };
}
