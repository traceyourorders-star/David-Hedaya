// Technical indicators. All functions return arrays aligned to the input, NaN during warm-up.
// Every value at index i uses only data at or before i (no look-ahead).
import type { Bar } from "../types";

export function sma(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function ema(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    if (i === n - 1) {
      let s = 0;
      for (let j = 0; j < n; j++) s += x[j];
      prev = s / n;
      out[i] = prev;
    } else if (i >= n) {
      prev = x[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder RSI */
export function rsi(x: number[], n = 14): number[] {
  const out = new Array(x.length).fill(NaN);
  if (x.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = x[i] - x[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function macd(x: number[], fast = 12, slow = 26, signal = 9) {
  const ef = ema(x, fast), es = ema(x, slow);
  const line = x.map((_, i) => ef[i] - es[i]);
  const firstValid = line.findIndex((v) => Number.isFinite(v));
  const sig = new Array(x.length).fill(NaN);
  if (firstValid >= 0) {
    const e = ema(line.slice(firstValid), signal);
    for (let i = 0; i < e.length; i++) sig[firstValid + i] = e[i];
  }
  const hist = line.map((v, i) => v - sig[i]);
  return { line, signal: sig, hist };
}

export function bollinger(x: number[], n = 20, k = 2) {
  const mid = sma(x, n);
  const upper = new Array(x.length).fill(NaN), lower = new Array(x.length).fill(NaN), pctB = new Array(x.length).fill(NaN), width = new Array(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (x[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
    pctB[i] = upper[i] === lower[i] ? 0.5 : (x[i] - lower[i]) / (upper[i] - lower[i]);
    width[i] = mid[i] ? (upper[i] - lower[i]) / mid[i] : NaN;
  }
  return { mid, upper, lower, pctB, width };
}

export function trueRange(b: Bar[]): number[] {
  return b.map((bar, i) => (i === 0 ? bar.h - bar.l : Math.max(bar.h - bar.l, Math.abs(bar.h - b[i - 1].c), Math.abs(bar.l - b[i - 1].c))));
}

/** Wilder ATR */
export function atr(b: Bar[], n = 14): number[] {
  const tr = trueRange(b);
  const out = new Array(b.length).fill(NaN);
  if (b.length < n) return out;
  let a = 0;
  for (let i = 0; i < n; i++) a += tr[i];
  a /= n;
  out[n - 1] = a;
  for (let i = n; i < b.length; i++) {
    a = (a * (n - 1) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}

export function logReturns(x: number[]): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 1; i < x.length; i++) out[i] = Math.log(x[i] / x[i - 1]);
  return out;
}

/** Annualized close-to-close historical volatility over n returns. */
export function historicalVol(x: number[], n = 20, periodsPerYear = 252): number[] {
  const r = logReturns(x);
  const out = new Array(x.length).fill(NaN);
  for (let i = n; i < x.length; i++) {
    let m = 0;
    for (let j = i - n + 1; j <= i; j++) m += r[j];
    m /= n;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (r[j] - m) ** 2;
    out[i] = Math.sqrt(s / (n - 1)) * Math.sqrt(periodsPerYear);
  }
  return out;
}

/** Session VWAP for intraday bars (resets each ET date found in bar.date prefix). */
export function sessionVwap(b: Bar[]): number[] {
  const out: number[] = [];
  let day = "", pv = 0, vol = 0;
  for (const bar of b) {
    const d = bar.date.slice(0, 10);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (bar.h + bar.l + bar.c) / 3;
    pv += tp * bar.v;
    vol += bar.v;
    out.push(vol > 0 ? pv / vol : tp);
  }
  return out;
}

export function relativeVolume(v: number[], n = 20): number[] {
  const avg = sma(v, n);
  return v.map((x, i) => (i > 0 && Number.isFinite(avg[i - 1]) && avg[i - 1] > 0 ? x / avg[i - 1] : NaN));
}

export function last<T>(a: T[]): T {
  return a[a.length - 1];
}

/** Percentile rank (0-100) of the last finite value within the trailing window. */
export function percentileRank(x: number[], window = 252): number | null {
  const vals = x.slice(-window).filter(Number.isFinite);
  if (vals.length < 30) return null;
  const cur = vals[vals.length - 1];
  return (vals.filter((v) => v <= cur).length / vals.length) * 100;
}

export interface Pivot { idx: number; price: number; kind: "high" | "low" }

/** Swing pivots: a high/low that is the extreme of +/- k bars. Confirmed only k bars later (no look-ahead when used historically). */
export function pivots(b: Bar[], k = 5): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < b.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (b[j].h >= b[i].h) isH = false;
      if (b[j].l <= b[i].l) isL = false;
    }
    if (isH) out.push({ idx: i, price: b[i].h, kind: "high" });
    if (isL) out.push({ idx: i, price: b[i].l, kind: "low" });
  }
  return out;
}

export interface Level { price: number; touches: number; kind: "support" | "resistance"; label: string; lastIdx: number }

/** Cluster swing pivots within `tol` (absolute price) into horizontal levels. */
export function clusterLevels(piv: Pivot[], tol: number, currentPrice: number): Level[] {
  const sorted = [...piv].sort((a, b) => a.price - b.price);
  const clusters: Pivot[][] = [];
  for (const p of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(p.price - c[c.length - 1].price) <= tol) c.push(p);
    else clusters.push([p]);
  }
  return clusters.map((c) => {
    const price = c.reduce((s, p) => s + p.price, 0) / c.length;
    return {
      price,
      touches: c.length,
      kind: price < currentPrice ? "support" : "resistance",
      label: `Swing ${price < currentPrice ? "support" : "resistance"} (${c.length} touch${c.length > 1 ? "es" : ""})`,
      lastIdx: Math.max(...c.map((p) => p.idx)),
    } as Level;
  });
}

/** Least-squares slope of the last n values, as fraction of the mean per bar. */
export function normSlope(x: number[], n: number): number {
  const y = x.slice(-n).filter(Number.isFinite);
  if (y.length < 3) return 0;
  const m = y.length, mx = (m - 1) / 2, my = y.reduce((a, b) => a + b, 0) / m;
  let num = 0, den = 0;
  for (let i = 0; i < m; i++) { num += (i - mx) * (y[i] - my); den += (i - mx) ** 2; }
  return den && my ? num / den / my : 0;
}

/** Aggregate intraday bars into N-minute bars by session (e.g., 15m -> 60m). */
export function aggregate(b: Bar[], factor: number): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null, count = 0, day = "";
  for (const bar of b) {
    const d = bar.date.slice(0, 10);
    if (!cur || count >= factor || d !== day) {
      if (cur) out.push(cur);
      cur = { ...bar };
      count = 1;
      day = d;
    } else {
      cur.h = Math.max(cur.h, bar.h);
      cur.l = Math.min(cur.l, bar.l);
      cur.c = bar.c;
      cur.v += bar.v;
      count++;
    }
  }
  if (cur) out.push(cur);
  return out;
}
