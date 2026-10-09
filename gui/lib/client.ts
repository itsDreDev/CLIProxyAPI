import type { APIOptions, ManagementAPI } from "./contracts";

export class ManagementError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ManagementError";
    this.status = status;
  }
}

export interface LiveManagementAPI extends ManagementAPI {
  request<T = unknown>(path: string, options?: APIOptions & { signal?: AbortSignal }): Promise<T>;
}

const base = "/v8/management";

export function createClient(
  fetcher?: typeof fetch,
  onUnauthorized?: () => void,
): LiveManagementAPI {
  let key = "";
  let generation = 0;
  const pending = new Set<AbortController>();

  function setKey(value: string) {
    key = value;
    generation += 1;
    for (const controller of pending) controller.abort();
    pending.clear();
  }

  return {
    setKey,
    async request<T>(path: string, { method = "GET", body, signal }: APIOptions & { signal?: AbortSignal } = {}): Promise<T> {
      if (!key) throw new ManagementError("Unlock the dashboard first.", 401);
      const target = new URL(`${base}${path}`, "http://management.invalid");
      if (!path.startsWith("/") || path.startsWith("//") || target.hash || !target.pathname.startsWith(`${base}/`)) {
        throw new ManagementError("Invalid management API path.", -1);
      }
      const currentGeneration = generation;
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
      pending.add(controller);
      const checkSession = () => {
        if (generation !== currentGeneration || controller.signal.aborted) {
          throw new ManagementError("The dashboard session changed or the request was cancelled.", -1);
        }
      };
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
      const options: RequestInit = {
        method, headers, signal: controller.signal,
        cache: "no-store", credentials: "omit", redirect: "error",
      };
      try {
        checkSession();
        if (body !== undefined) {
          if (typeof FormData !== "undefined" && body instanceof FormData) options.body = body;
          else {
            headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(body);
          }
        }
        const response = await (fetcher ?? globalThis.fetch)(`${base}${path}`, options);
        checkSession();
        if (response.status === 401) {
          setKey("");
          onUnauthorized?.();
          throw new ManagementError("Management key was rejected. Unlock the dashboard again.", 401);
        }
        const raw = await response.text();
        checkSession();
        let data: unknown;
        try { data = raw ? JSON.parse(raw) : {}; }
        catch {
          if (response.ok) throw new ManagementError("The proxy returned an unexpected response.", response.status);
          data = {};
        }
        if (!response.ok) {
          const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
          const detail = typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : undefined;
          const fallback = response.status === 404
            ? "Management API is unavailable. Set management.secret-key and restart the proxy."
            : `Request failed (${response.status}).`;
          throw new ManagementError(detail || fallback, response.status);
        }
        return data as T;
      } catch (error) {
        if (error instanceof ManagementError) throw error;
        checkSession();
        throw new ManagementError("Could not reach the proxy. Check that it is running.", 0);
      } finally {
        pending.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

export function retryManagementQuery(failureCount: number, error: Error): boolean {
  if (!(error instanceof ManagementError)) return false;
  return failureCount < 2 && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);
}
