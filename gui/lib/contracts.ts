export interface Account {
  name: string;
  id?: string;
  auth_index?: string;
  provider?: string;
  type?: string;
  email?: string;
  label?: string;
  account_type?: string;
  status?: string;
  status_message?: string;
  disabled?: boolean;
  unavailable?: boolean;
  success?: number;
  failed?: number;
  last_refresh?: string;
  next_retry_after?: string;
  plan_type?: string;
  id_token?: { plan_type?: string; chatgpt_subscription_active_until?: string };
  quota?: { observed_at?: string; signals?: Record<string, string> };
}
export interface OAuthSession { provider: 'codex' | 'claude'; state: string; url: string; started: number }
export interface ProxyConfig { routing?: { strategy?: string }; access?: { 'api-keys'?: string[] } }
export interface AccountModel { id?: string; name?: string }
export interface APIOptions { method?: string; body?: unknown }
export interface ManagementAPI {
  setKey(key: string): void;
  request<T = unknown>(path: string, options?: APIOptions): Promise<T>;
}
