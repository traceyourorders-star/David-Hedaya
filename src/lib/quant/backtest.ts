// Historical studies on REAL historical daily bars. Every signal at day i uses only data up to i
// (trailing indicators, pivots not used), and outcomes are measured strictly after i.
import type { Bar, Direction } from "../types";
import { bsPrice } from "./blackscholes";
import { historicalVol, macd, rsi, sma } from "./indicators";

export interface SampleStats {
  n: number;
  hitRate: number | null; // fraction of outcomes in the trade's favour
  mean: number | null;
  median: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  worst: number | null;
  best: number | null;
}

export interface StudyResult {
  name: string;
  description: string;
  horizonDays: number;
  inSample: SampleStats;
  outOfSample: SampleStats;
  baseline: SampleStats; // unconditional forward returns over the same period
  splitDate: string | null;
  verdict: string;
  available: boolean;
}

function stats(xs: number[], favourable: (x: number) => boolean): SampleStats {
  if (!xs.length) return { n: 0, hitRate: null, mean: null, median: null, avgWin: null, avgLoss: null, worst: null, best: null };
  const s = [...xs].sort((a, b) => a - b);
  const wins = xs.filter(favourable), losses = xs.filter((x) => !favourable(x));
  return {
    n: xs.length,
    hitRate: wins.length / xs.length,
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    median: s[Math.floor(s.length / 2)],
    avgWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null,
    avgLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
    worst: s[0],
    best: s[s.length - 1],
  };
}

export function signatureAt(c: number[], i: number, s20: number[], s50: number[], hist: number[], r: number[]): string | null {
  if (![s20[i], s50[i], hist[i], r[i]].every(Number.isFinite)) return null;
  const rb = r[i] < 40 ? "rsi<40" : r[i] > 60 ? "rsi>60" : "rsi40-60";
  return [c[i] > s50[i] ? "above50" : "below50", s20[i] > s50[i] ? "20>50" : "20<50", hist[i] > 0 ? "macd+" : "macd-", rb].join("|");
}

function evaluate(
  name: string, description: string, bars: Bar[], h: number, idxs: number[], fav: (x: number) => boolean, oosFrac = 0.3,
): StudyResult {
  const c = bars.map((b) => b.c);
  const n = c.length;
  const eligibleEnd = n - h; // outcome must be fully observed
  // non-overlapping events
  const events: number[] = [];
  let lastI = -Infinity;
  for (const i of idxs) if (i < eligibleEnd && i - lastI >= h) { events.push(i); lastI = i; }
  const firstIdx = 60;
  const splitIdx = Math.floor(firstIdx + (eligibleEnd - firstIdx) * (1 - oosFrac));
  const fwd = (i: number) => c[i + h] / c[i] - 1;
  const ins = events.filter((i) => i < splitIdx).map(fwd);
  const oos = events.filter((i) => i >= splitIdx).map(fwd);
  const base: number[] = [];
  for (let i = firstIdx; i < eligibleEnd; i += h) base.push(fwd(i));
  const inS = stats(ins, fav), outS = stats(oos, fav), bS = stats(base, fav);
  const available = inS.n + outS.n >= 5;
  let verdict = "Too few historical occurrences to draw a conclusion.";
  if (available) {
    const edgeIn = (inS.hitRate ?? 0) - (bS.hitRate ?? 0);
    const edgeOut = outS.n >= 3 ? (outS.hitRate ?? 0) - (bS.hitRate ?? 0) : null;
    if (edgeOut == null) verdict = `In-sample hit rate ${pct(inS.hitRate)} vs ${pct(bS.hitRate)} baseline; too few out-of-sample events (${outS.n}) to validate.`;
    else if (edgeIn > 0.05 && edgeOut > 0.03) verdict = `Edge held out-of-sample: ${pct(outS.hitRate)} vs ${pct(bS.hitRate)} baseline (n=${outS.n}). Weak evidence, small sample.`;
    else if (edgeIn > 0.05 && edgeOut <= 0.03) verdict = `In-sample edge did NOT persist out-of-sample (${pct(outS.hitRate)} vs ${pct(bS.hitRate)} baseline). Treat as no edge.`;
    else verdict = `No meaningful edge versus the unconditional baseline.`;
  }
  return { name, description, horizonDays: h, inSample: inS, outOfSample: outS, baseline: bS, splitDate: bars[splitIdx]?.date ?? null, verdict, available };
}

const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(0)}%`);

export function similarSetupStudy(bars: Bar[], h: number, direction: Direction): StudyResult {
  const c = bars.map((b) => b.c);
  const s20 = sma(c, 20), s50 = sma(c, 50), r = rsi(c), m = macd(c);
  const cur = signatureAt(c, c.length - 1, s20, s50, m.hist, r);
  const idxs: number[] = [];
  if (cur) for (let i = 60; i < c.length - 1; i++) if (signatureAt(c, i, s20, s50, m.hist, r) === cur) idxs.push(i);
  const fav = direction === "bearish" ? (x: number) => x < 0 : (x: number) => x > 0;
  return evaluate(
    "Similar technical setups",
    `Past days with the same trend/momentum signature as today (${cur ?? "n/a"}); forward ${h}-day return. Non-overlapping events; first 70% in-sample, last 30% out-of-sample.`,
    bars, h, idxs, fav,
  );
}

export function breakoutStudy(bars: Bar[], h: number, kind: "breakout" | "breakdown"): StudyResult {
  const idxs: number[] = [];
  const vol = sma(bars.map((b) => b.v), 20);
  for (let i = 21; i < bars.length - 1; i++) {
    const prior = bars.slice(i - 20, i);
    const hi = Math.max(...prior.map((b) => b.h)), lo = Math.min(...prior.map((b) => b.l));
    const rv = vol[i - 1] > 0 ? bars[i].v / vol[i - 1] : 1;
    if (kind === "breakout" && bars[i].c > hi && rv > 1.2) idxs.push(i);
    if (kind === "breakdown" && bars[i].c < lo && rv > 1.2) idxs.push(i);
  }
  const fav = kind === "breakdown" ? (x: number) => x < 0 : (x: number) => x > 0;
  return evaluate(
    kind === "breakout" ? "20-day breakouts" : "20-day breakdowns",
    `Closes ${kind === "breakout" ? "above the prior 20-day high" : "below the prior 20-day low"} on >1.2x relative volume; forward ${h}-day return.`,
    bars, h, idxs, fav,
  );
}

export interface EarningsReaction { date: string; hour: string; movePct: number; absMovePct: number }

export function earningsReactions(bars: Bar[], events: { date: string; hour: string }[]): { reactions: EarningsReaction[]; avgAbsMove: number | null; medianAbsMove: number | null } {
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  const out: EarningsReaction[] = [];
  for (let e of events) {
    let i = idx.get(e.date);
    if (i == null) {
      // announcement on a non-trading day: use next session
      const nxt = bars.findIndex((b) => b.date > e.date);
      if (nxt <= 0) continue;
      i = nxt;
      e = { ...e, hour: "bmo" };
    }
    let from: number, to: number;
    if (e.hour === "amc") { from = i; to = i + 1; } else if (e.hour === "bmo") { from = i - 1; to = i; } else { from = i - 1; to = i + 1; }
    if (from < 0 || to >= bars.length) continue;
    const mv = bars[to].c / bars[from].c - 1;
    out.push({ date: e.date, hour: e.hour, movePct: mv, absMovePct: Math.abs(mv) });
  }
  const abs = out.map((x) => x.absMovePct).sort((a, b) => a - b);
  return {
    reactions: out.sort((a, b) => b.date.localeCompare(a.date)),
    avgAbsMove: abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : null,
    medianAbsMove: abs.length ? abs[Math.floor(abs.length / 2)] : null,
  };
}

export interface ModelPricedBacktest {
  available: boolean;
  description: string;
  assumptions: string[];
  trades: number;
  inSample: SampleStats;
  outOfSample: SampleStats;
  splitDate: string | null;
}

/**
 * Debit-vertical simulation on historical signal dates. Underlying prices are real; option prices are
 * Black-Scholes estimates with IV = trailing 20d realized vol x `ivMultiplier` (today's IV/HV ratio) because
 * no historical option quotes are connected. Transaction costs: per-leg half-spread + commissions.
 */
export function modelPricedSpreadBacktest(
  bars: Bar[], direction: Direction, h: number, r: number, ivMultiplier: number, opts: { widthSigma?: number; halfSpreadPct?: number; feePerContract?: number } = {},
): ModelPricedBacktest {
  const assumptions = [
    "Underlying entry/exit prices are actual historical daily closes.",
    "Option prices are MODELLED with Black-Scholes; historical option quotes are not available from the connected providers.",
    `IV at each date = trailing 20-day realized vol x ${ivMultiplier.toFixed(2)} (today's IV/HV ratio, clamped 0.8-2.0).`,
    `Costs: ${(opts.halfSpreadPct ?? 0.04) * 100}% of each leg's price paid on entry and on exit (half bid/ask) plus $${(opts.feePerContract ?? 0.65).toFixed(2)} per contract per side.`,
    "Long strike = at-the-money, short strike ~1 sigma away; position opened at the signal close, closed after the holding period with 14+ days remaining.",
    "Single-ticker study on a currently listed stock: subject to survivorship bias.",
  ];
  if (direction === "neutral" || bars.length < 300) {
    return { available: false, description: "Not run (neutral read or < 300 bars).", assumptions, trades: 0, inSample: stats([], () => true), outOfSample: stats([], () => true), splitDate: null };
  }
  const isCall = direction === "bullish";
  const c = bars.map((b) => b.c);
  const hv = historicalVol(c, 20);
  const s20 = sma(c, 20), s50 = sma(c, 50), rr = rsi(c), m = macd(c);
  const cur = signatureAt(c, c.length - 1, s20, s50, m.hist, rr);
  const mult = Math.max(0.8, Math.min(2, ivMultiplier));
  const halfSp = opts.halfSpreadPct ?? 0.04, fee = opts.feePerContract ?? 0.65;
  const dteDays = Math.round((h * 365) / 252) + 21;
  const pnls: { i: number; ret: number }[] = [];
  let lastI = -Infinity;
  for (let i = 60; i < c.length - h; i++) {
    if (i - lastI < h) continue;
    if (signatureAt(c, i, s20, s50, m.hist, rr) !== cur || !Number.isFinite(hv[i]) || !Number.isFinite(hv[i + h])) continue;
    lastI = i;
    const S0 = c[i], sig0 = hv[i] * mult;
    const step = S0 > 200 ? 5 : S0 > 50 ? 2.5 : 1;
    const K1 = Math.round(S0 / step) * step;
    const move = S0 * sig0 * Math.sqrt(dteDays / 365);
    const K2 = isCall ? Math.max(K1 + step, Math.round((S0 + move) / step) * step) : Math.min(K1 - step, Math.round((S0 - move) / step) * step);
    const type = isCall ? "call" : "put";
    const T0 = dteDays / 365;
    const p1 = bsPrice({ S: S0, K: K1, T: T0, r, sigma: sig0, type }), p2 = bsPrice({ S: S0, K: K2, T: T0, r, sigma: sig0, type });
    const entry = p1 * (1 + halfSp) - p2 * (1 - halfSp) + (2 * fee) / 100;
    if (entry <= 0.05) continue;
    const S1 = c[i + h], sig1 = hv[i + h] * mult, T1 = (dteDays - Math.round((h * 365) / 252)) / 365;
    const q1 = bsPrice({ S: S1, K: K1, T: T1, r, sigma: sig1, type }), q2 = bsPrice({ S: S1, K: K2, T: T1, r, sigma: sig1, type });
    const exit = Math.max(0, q1 * (1 - halfSp) - q2 * (1 + halfSp)) - (2 * fee) / 100;
    pnls.push({ i, ret: exit / entry - 1 });
  }
  const splitIdx = Math.floor(60 + (c.length - h - 60) * 0.7);
  const fav = (x: number) => x > 0;
  const ins = stats(pnls.filter((p) => p.i < splitIdx).map((p) => p.ret), fav);
  const oos = stats(pnls.filter((p) => p.i >= splitIdx).map((p) => p.ret), fav);
  return {
    available: pnls.length >= 5,
    description: `${isCall ? "Bull call" : "Bear put"} debit spread opened on each past occurrence of today's setup signature (${cur}), held ${h} trading days. Returns are on the debit paid.`,
    assumptions,
    trades: pnls.length,
    inSample: ins,
    outOfSample: oos,
    splitDate: bars[splitIdx]?.date ?? null,
  };
}
