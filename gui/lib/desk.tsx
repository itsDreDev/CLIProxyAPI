"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Account, OAuthSession, ProxyConfig } from "./contracts";
import { subscriptionAccounts } from "./accounts";
import { createClient, ManagementError, retryManagementQuery, type LiveManagementAPI } from "./client";

interface Desk {
  api: LiveManagementAPI;
  connected: boolean;
  unlock(key: string): Promise<void>;
  lock(): void;
  epoch: number;
}

const DeskContext = createContext<Desk | null>(null);
const accountKey = (epoch: number) => ["desk", epoch, "accounts"] as const;
const settingsKey = (epoch: number) => ["desk", epoch, "settings"] as const;
const oauthLifetime = 5 * 60 * 1000;
export const ACCOUNT_POLL_INTERVAL_MS = 5000;

function readAccounts(data: { files?: unknown }): Account[] {
  if (!data || !Array.isArray(data.files) || data.files.some(account =>
    !account || typeof account !== "object" || typeof account.name !== "string" ||
    [account.provider, account.type, account.account_type].some(value => value !== undefined && typeof value !== "string"),
  )) throw new Error("The proxy returned an unexpected account list.");
  return subscriptionAccounts(data.files as Account[]);
}

export function DeskProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: {
      retry: retryManagementQuery,
      retryDelay: attempt => Math.min(1000 * 2 ** attempt, 5000),
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
      refetchIntervalInBackground: false,
      staleTime: 0,
    } },
  }));
  const epochRef = useRef(0);
  const lockRef = useRef<() => void>(() => {});
  const [api] = useState(() => createClient(undefined, () => lockRef.current()));
  const [session, setSession] = useState({ connected: false, epoch: 0 });

  const lock = useCallback(() => {
    const epoch = ++epochRef.current;
    api.setKey("");
    queryClient.clear();
    setSession({ connected: false, epoch });
  }, [api, queryClient]);
  lockRef.current = lock;

  const unlock = useCallback(async (value: string) => {
    const key = value.trim();
    if (!key) throw new Error("Enter the management key.");
    const epoch = ++epochRef.current;
    api.setKey(key);
    queryClient.clear();
    setSession({ connected: false, epoch });
    try {
      const accounts = readAccounts(await api.request<{ files?: unknown }>("/credentials"));
      if (epochRef.current !== epoch) throw new ManagementError("The dashboard session changed.", -1);
      queryClient.setQueryData(accountKey(epoch), accounts);
      setSession({ connected: true, epoch });
    } catch (error) {
      if (epochRef.current === epoch) lock();
      throw error;
    }
  }, [api, lock, queryClient]);

  const value = useMemo(() => ({ api, lock, unlock, ...session }), [api, lock, unlock, session]);
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState !== "hidden") void queryClient.refetchQueries({ type: "active" }, { cancelRefetch: false });
    };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [queryClient]);
  useEffect(() => () => {
    epochRef.current += 1;
    api.setKey("");
    queryClient.clear();
  }, [api, queryClient]);
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => { if (event.persisted) lock(); };
    window.addEventListener("pagehide", lock);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pagehide", lock);
      window.removeEventListener("pageshow", restore);
    };
  }, [lock]);
  return <QueryClientProvider client={queryClient}><DeskContext.Provider value={value}>{children}</DeskContext.Provider></QueryClientProvider>;
}

function useDeskContext(): Desk {
  const desk = useContext(DeskContext);
  if (!desk) throw new Error("Desk hooks must be used inside DeskProvider.");
  return desk;
}

export function useDesk() {
  const { api, connected, unlock, lock } = useDeskContext();
  return { api, connected, unlock, lock };
}

export function useAccounts() {
  const { api, connected, epoch } = useDeskContext();
  return useQuery({
    queryKey: accountKey(epoch),
    queryFn: async ({ signal }) => readAccounts(await api.request<{ files?: unknown }>("/credentials", { signal })),
    enabled: connected,
    refetchInterval: ACCOUNT_POLL_INTERVAL_MS,
  });
}

export function useSettings(enabled: boolean) {
  const { api, connected, epoch } = useDeskContext();
  return useQuery({
    queryKey: settingsKey(epoch),
    queryFn: ({ signal }) => api.request<ProxyConfig>("/config", { signal }),
    enabled: connected && enabled,
  });
}

export interface OAuthStatus { status: "wait" | "ok" | "error"; error?: string }

function pendingOAuth(query: { state: { data: unknown; error: Error | null } }): boolean {
  const data = query.state.data as OAuthStatus | undefined;
  if (data && data.status !== "wait") return false;
  const error = query.state.error;
  return !error || retryManagementQuery(0, error);
}

export function useOAuthStatus(session: OAuthSession | null) {
  const { api, connected, epoch } = useDeskContext();
  const queryClient = useQueryClient();
  const sessionId = session ? `${epoch}:${session.provider}:${session.state}:${session.started}` : "";
  const [expiredSession, setExpiredSession] = useState("");
  const expired = !!session && (expiredSession === sessionId || Date.now() >= session.started + oauthLifetime);
  useEffect(() => {
    if (!session || !connected) return;
    const timer = setTimeout(() => setExpiredSession(sessionId), Math.max(0, session.started + oauthLifetime - Date.now()));
    return () => clearTimeout(timer);
  }, [session, sessionId, connected]);
  useEffect(() => {
    if (expired) void queryClient.cancelQueries({
      queryKey: ["desk", epoch, "oauth", session?.provider, session?.state, session?.started],
      exact: true,
    });
  }, [expired, epoch, session?.provider, session?.state, session?.started, queryClient]);

  const result = useQuery({
    queryKey: ["desk", epoch, "oauth", session?.provider, session?.state, session?.started],
    queryFn: async ({ signal }): Promise<OAuthStatus> => {
      if (!session || Date.now() >= session.started + oauthLifetime) {
        return { status: "error", error: "This sign-in has expired. Close this window and start again." };
      }
      const result = await api.request<OAuthStatus>(`/oauth/status?state=${encodeURIComponent(session.state)}`, { signal });
      if (!result || !["wait", "ok", "error"].includes(result.status)) throw new Error("The proxy returned an unexpected sign-in status.");
      return result;
    },
    enabled: query => connected && !!session && !expired && pendingOAuth(query),
    refetchInterval: query => pendingOAuth(query) && !expired ? 1500 : false,
  });

  if (expired && result.data?.status !== "ok") {
    return { ...result, data: { status: "error" as const, error: "This sign-in has expired. Close this window and start again." } };
  }
  return result;
}

export function useInvalidateAccounts() {
  const queryClient = useQueryClient();
  const { epoch } = useDeskContext();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: accountKey(epoch) }),
      queryClient.invalidateQueries({ queryKey: settingsKey(epoch) }),
    ]);
  }, [epoch, queryClient]);
}
