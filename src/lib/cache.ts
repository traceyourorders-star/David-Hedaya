import { getDb } from "./db";

export interface Sourced<T> {
  data: T;
  source: string;
  fetchedAt: number; // epoch ms when the provider responded
  fromCache: boolean;
}

const mem = new Map<string, { fetchedAt: number; source: string; payload: unknown }>();

/**
 * Read-through cache. Every value carries the provider name and the time it was fetched,
 * so the UI can always show data age. `force` bypasses the cache (used by "Refresh").
 */
export async function cached<T>(
  key: string,
  source: string,
  ttlMs: number,
  loader: () => Promise<T>,
  force = false,
): Promise<Sourced<T>> {
  const now = Date.now();
  if (!force) {
    const m = mem.get(key);
    if (m && now - m.fetchedAt < ttlMs) return { data: m.payload as T, source: m.source, fetchedAt: m.fetchedAt, fromCache: true };
    try {
      const row = getDb().prepare("SELECT source, fetched_at, payload FROM cache WHERE key=?").get(key) as
        | { source: string; fetched_at: number; payload: string }
        | undefined;
      if (row && now - row.fetched_at < ttlMs) {
        const payload = JSON.parse(row.payload);
        mem.set(key, { fetchedAt: row.fetched_at, source: row.source, payload });
        return { data: payload as T, source: row.source, fetchedAt: row.fetched_at, fromCache: true };
      }
    } catch {
      /* cache is best-effort */
    }
  }
  const data = await loader();
  const fetchedAt = Date.now();
  mem.set(key, { fetchedAt, source, payload: data });
  try {
    getDb()
      .prepare("INSERT OR REPLACE INTO cache (key, source, fetched_at, payload) VALUES (?,?,?,?)")
      .run(key, source, fetchedAt, JSON.stringify(data));
  } catch {
    /* ignore */
  }
  return { data, source, fetchedAt, fromCache: false };
}
