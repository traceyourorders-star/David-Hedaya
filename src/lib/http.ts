
export class ProviderError extends Error {
  constructor(
    public provider: string,
    public kind: "not_configured" | "auth" | "plan" | "rate_limit" | "network" | "not_found" | "bad_response",
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 12000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: ctrl.signal, cache: "no-store" });
  } catch (e) {
    throw new ProviderError(provider, "network", `${provider}: network error (${(e as Error).message})`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new ProviderError(provider, "auth", `${provider}: authentication failed (401) - check the API key`, 401);
  if (res.status === 403) throw new ProviderError(provider, "plan", `${provider}: access denied (403) - endpoint may require a paid plan`, 403);
  if (res.status === 404) throw new ProviderError(provider, "not_found", `${provider}: not found (404)`, 404);
  if (res.status === 429) throw new ProviderError(provider, "rate_limit", `${provider}: rate limited (429)`, 429);
  if (!res.ok) throw new ProviderError(provider, "bad_response", `${provider}: HTTP ${res.status}`, res.status);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(provider, "bad_response", `${provider}: response was not JSON`);
  }
}
