export const money = (x: number | null | undefined, d = 2) =>
  x == null || !Number.isFinite(x) ? "n/a" : `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const num = (x: number | null | undefined, d = 2) =>
  x == null || !Number.isFinite(x) ? "n/a" : x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (x: number | null | undefined, d = 1, signed = false) =>
  x == null || !Number.isFinite(x) ? "n/a" : `${signed && x > 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
export const int = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "n/a" : Math.round(x).toLocaleString("en-US"));
export const big = (x: number | null | undefined) => {
  if (x == null || !Number.isFinite(x)) return "n/a";
  const a = Math.abs(x);
  return a >= 1e12 ? `${(x / 1e12).toFixed(2)}T` : a >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : x.toFixed(0);
};
export const signCls = (x: number | null | undefined) => (x == null ? "" : x > 0 ? "up" : x < 0 ? "down" : "");
export const dirBadge = (d: string) => (/bull|call|positive/i.test(d) ? "badge bull" : /bear|put|negative/i.test(d) ? "badge bear" : "badge neutral");
export const ago = (ms: number | null | undefined, now = Date.now()) => {
  if (!ms) return "n/a";
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
