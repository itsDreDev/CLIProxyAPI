import { invoke, isTauri } from "@tauri-apps/api/core";

export interface ProxyStatus {
  running: boolean;
  owned: boolean;
  mode: "local" | "remote";
  dashboard_url: string;
  endpoint: string;
  config_path: string;
  error?: string;
}

export const nativeAvailable = () => isTauri();

export async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!nativeAvailable())
    throw new Error(
      "Open Subscription Desk in the desktop app to manage a proxy.",
    );
  return invoke<T>(name, args);
}

export function remoteOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(
      "Enter the complete shared proxy address, such as https://proxy.example.ts.net.",
    );
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".ts.net") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new Error(
      "Use a Tailscale HTTPS address ending in .ts.net, without a path, password, query, or fragment.",
    );
  }
  return url.origin;
}

export function publicError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "The desktop operation could not be completed.";
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [hidden]")
    .replace(
      /([?&](?:code|state|token|key|access_token|refresh_token)=)[^&\s]+/gi,
      "$1[hidden]",
    )
    .replace(
      /((?:management[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[hidden]",
    )
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[hidden]")
    .slice(0, 500);
}
