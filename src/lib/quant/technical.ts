import type { Bar, Direction } from "../types";
import {
  atr, bollinger, clusterLevels, ema, historicalVol, last, macd, normSlope, percentileRank, pivots, relativeVolume, rsi, sessionVwap, sma,
} from "./indicators";

export type TfKey = "1m" | "5m" | "15m" | "1h" | "1D" | "1W" | "1M";

export interface TimeframeSignal {
  tf: TfKey;
  available: boolean;
  bars: number;
  asOf: string | null;
  close: number | null;
  trend: Direction;
  score: number; // -1..1
  rsi: number | null;
  macdHist: number | null;
  vsVwap: number | null; // % above session VWAP (intraday)
  notes: string[];
}

const dir = (s: number): Direction => (s > 0.25 ? "bullish" : s < -0.25 ? "bearish" : "neutral");
const fin = (x: number) => (Number.isFinite(x) ? x : null);

export function scoreTimeframe(tf: TfKey, b: Bar[]): TimeframeSignal {
  const intraday = ["1m", "5m", "15m", "1h"].includes(tf);
  const minBars = intraday ? 30 : tf === "1M" ? 12 : 30;
  if (b.length < minBars) {
    return { tf, available: false, bars: b.length, asOf: b.length ? last(b).date : null, close: b.length ? last(b).c : null, trend: "neutral", score: 0, rsi: null, macdHist: null, vsVwap: null, notes: [`Insufficient bars (${b.length}/${minBars})`] };
  }
  const c = b.map((x) => x.c);
  const px = last(c);
  const fastN = tf === "1M" ? 6 : 20;
  const slowN = tf === "1M" ? 12 : 50;
  const f = sma(c, fastN), s = sma(c, Math.min(slowN, c.length - 1));
  const r = rsi(c, 14), m = macd(c);
  const comps: number[] = [];
  const notes: string[] = [];
  const fLast = last(f), sLast = last(s);
  if (Number.isFinite(fLast)) {
    comps.push(px > fLast ? 1 : -1);
    notes.push(`Price ${px > fLast ? "above" : "below"} ${fastN}-period MA`);
    const sl = normSlope(f, 10);
    comps.push(sl > 0.0005 ? 1 : sl < -0.0005 ? -1 : 0);
  }
  if (Number.isFinite(sLast)) comps.push(px > sLast ? 1 : -1);
  if (Number.isFinite(fLast) && Number.isFinite(sLast)) comps.push(fLast > sLast ? 0.5 : -0.5);
  const h = last(m.hist), hPrev = m.hist[m.hist.length - 2];
  if (Number.isFinite(h)) {
    comps.push(h > 0 ? (h > hPrev ? 1 : 0.5) : h < hPrev ? -1 : -0.5);
    notes.push(`MACD histogram ${h > 0 ? "positive" : "negative"} and ${h > hPrev ? "rising" : "falling"}`);
  }
  const rl = last(r);
  if (Number.isFinite(rl)) {
    comps.push(rl > 60 ? 1 : rl > 52 ? 0.5 : rl < 40 ? -1 : rl < 48 ? -0.5 : 0);
    if (rl > 70) notes.push(`RSI ${rl.toFixed(0)} overbought`);
    else if (rl < 30) notes.push(`RSI ${rl.toFixed(0)} oversold`);
  }
  let vsVwap: number | null = null;
  if (intraday) {
    const vw = b[b.length - 1].vwap ?? last(sessionVwap(b));
    if (vw) {
      vsVwap = (px / vw - 1) * 100;
      comps.push(px > vw ? 1 : -1);
      notes.push(`Price ${px > vw ? "above" : "below"} session VWAP (${vsVwap.toFixed(2)}%)`);
    }
  }
  const score = comps.length ? comps.reduce((a, x) => a + x, 0) / comps.length : 0;
  return { tf, available: true, bars: b.length, asOf: last(b).date, close: px, trend: dir(score), score, rsi: fin(rl), macdHist: fin(h), vsVwap, notes };
}

export interface KeyLevel { price: number; label: string; kind: "support" | "resistance"; strength: number }

export interface DailyStats {
  close: number;
  sma20: number | null; sma50: number | null; sma100: number | null; sma200: number | null; ema9: number | null; ema21: number | null;
  rsi14: number | null; macd: number | null; macdSignal: number | null; macdHist: number | null;
  bbUpper: number | null; bbLower: number | null; bbPctB: number | null; bbWidth: number | null;
  atr14: number | null; atrPct: number | null;
  hv10: number | null; hv20: number | null; hv60: number | null; hv20Percentile: number | null;
  relVolume: number | null; avgVolume20: number | null;
  high20: number; low20: number; high52w: number; low52w: number;
  ret5d: number | null; ret20d: number | null; ret60d: number | null;
  goldenCross: boolean | null;
}

export function dailyStats(b: Bar[]): DailyStats {
  const c = b.map((x) => x.c), v = b.map((x) => x.v);
  const bb = bollinger(c), m = macd(c), a = atr(b);
  const hv20 = historicalVol(c, 20);
  const ret = (n: number) => (c.length > n ? c[c.length - 1] / c[c.length - 1 - n] - 1 : null);
  const s50 = last(sma(c, 50)), s200 = last(sma(c, 200));
  const prior = b.slice(-21, -1);
  const yr = b.slice(-252);
  return {
    close: last(c),
    sma20: fin(last(sma(c, 20))), sma50: fin(s50), sma100: fin(last(sma(c, 100))), sma200: fin(s200),
    ema9: fin(last(ema(c, 9))), ema21: fin(last(ema(c, 21))),
    rsi14: fin(last(rsi(c))), macd: fin(last(m.line)), macdSignal: fin(last(m.signal)), macdHist: fin(last(m.hist)),
    bbUpper: fin(last(bb.upper)), bbLower: fin(last(bb.lower)), bbPctB: fin(last(bb.pctB)), bbWidth: fin(last(bb.width)),
    atr14: fin(last(a)), atrPct: fin(last(a) / last(c)),
    hv10: fin(last(historicalVol(c, 10))), hv20: fin(last(hv20)), hv60: fin(last(historicalVol(c, 60))),
    hv20Percentile: percentileRank(hv20, 252),
    relVolume: fin(last(relativeVolume(v))), avgVolume20: fin(last(sma(v, 20))),
    high20: prior.length ? Math.max(...prior.map((x) => x.h)) : last(b).h,
    low20: prior.length ? Math.min(...prior.map((x) => x.l)) : last(b).l,
    high52w: Math.max(...yr.map((x) => x.h)), low52w: Math.min(...yr.map((x) => x.l)),
    ret5d: ret(5), ret20d: ret(20), ret60d: ret(60),
    goldenCross: Number.isFinite(s50) && Number.isFinite(s200) ? s50 > s200 : null,
  };
}

export function keyLevels(b: Bar[], st: DailyStats): { supports: KeyLevel[]; resistances: KeyLevel[] } {
  const px = st.close;
  const tol = (st.atr14 ?? px * 0.02) * 0.5;
  const recent = b.slice(-250);
  const lv: KeyLevel[] = clusterLevels(pivots(recent, 5), tol, px).map((l) => ({
    price: l.price, label: l.label, kind: l.kind, strength: Math.min(5, l.touches + (recent.length - l.lastIdx < 60 ? 1 : 0)),
  }));
  const add = (price: number | null, label: string, strength: number) => {
    if (price && Number.isFinite(price)) lv.push({ price, label, kind: price < px ? "support" : "resistance", strength });
  };
  add(st.sma20, "20-day SMA", 1);
  add(st.sma50, "50-day SMA", 2);
  add(st.sma100, "100-day SMA", 2);
  add(st.sma200, "200-day SMA", 3);
  add(st.high52w, "52-week high", 3);
  add(st.low52w, "52-week low", 3);
  add(st.high20, "20-day high", 2);
  add(st.low20, "20-day low", 2);
  if (b.length > 1) {
    add(b[b.length - 2].h, "Prior session high", 1);
    add(b[b.length - 2].l, "Prior session low", 1);
  }
  // merge levels within tolerance, keep strongest label
  const merged: KeyLevel[] = [];
  for (const l of lv.sort((a, b2) => a.price - b2.price)) {
    const m = merged[merged.length - 1];
    if (m && Math.abs(m.price - l.price) <= tol * 0.6) {
      if (l.strength > m.strength) merged[merged.length - 1] = { ...l, strength: Math.min(5, l.strength + 1), label: `${l.label} + ${m.label}` };
      else m.strength = Math.min(5, m.strength + 1);
    } else merged.push({ ...l });
  }
  const supports = merged.filter((l) => l.price < px * 0.999).sort((a, b2) => b2.price - a.price).slice(0, 6);
  const resistances = merged.filter((l) => l.price > px * 1.001).sort((a, b2) => a.price - b2.price).slice(0, 6);
  return { supports, resistances };
}

export interface Gap { date: string; pct: number; direction: "up" | "down"; filled: boolean }

export function gapAnalysis(b: Bar[], lookback = 60, minPct = 0.015): { todayGapPct: number | null; gaps: Gap[] } {
  const out: Gap[] = [];
  const start = Math.max(1, b.length - lookback);
  for (let i = start; i < b.length; i++) {
    const pc = b[i - 1].c;
    const pct = b[i].o / pc - 1;
    if (Math.abs(pct) < minPct) continue;
    const after = b.slice(i);
    const filled = pct > 0 ? after.some((x) => x.l <= pc) : after.some((x) => x.h >= pc);
    out.push({ date: b[i].date, pct, direction: pct > 0 ? "up" : "down", filled });
  }
  const n = b.length;
  return { todayGapPct: n > 1 ? b[n - 1].o / b[n - 2].c - 1 : null, gaps: out.reverse().slice(0, 8) };
}

export interface RelStrength { vsSpy20: number | null; vsSpy60: number | null; vsSector20: number | null; vsSector60: number | null; sectorEtf: string | null; spyTrend: Direction | null }

function alignedReturn(a: Bar[], n: number) {
  return a.length > n ? a[a.length - 1].c / a[a.length - 1 - n].c - 1 : null;
}

export function relativeStrength(stock: Bar[], spy: Bar[] | null, sector: Bar[] | null, sectorEtf: string | null): RelStrength {
  const d = (x: number | null, y: number | null) => (x == null || y == null ? null : x - y);
  return {
    vsSpy20: spy ? d(alignedReturn(stock, 20), alignedReturn(spy, 20)) : null,
    vsSpy60: spy ? d(alignedReturn(stock, 60), alignedReturn(spy, 60)) : null,
    vsSector20: sector ? d(alignedReturn(stock, 20), alignedReturn(sector, 20)) : null,
    vsSector60: sector ? d(alignedReturn(stock, 60), alignedReturn(sector, 60)) : null,
    sectorEtf,
    spyTrend: spy && spy.length >= 60 ? scoreTimeframe("1D", spy).trend : null,
  };
}

const TF_WEIGHT: Record<TfKey, number> = { "1M": 0.1, "1W": 0.2, "1D": 0.35, "1h": 0.15, "15m": 0.1, "5m": 0.05, "1m": 0.05 };

export function combineTimeframes(tfs: TimeframeSignal[]) {
  const avail = tfs.filter((t) => t.available);
  const wsum = avail.reduce((s, t) => s + TF_WEIGHT[t.tf], 0);
  const score = wsum ? avail.reduce((s, t) => s + TF_WEIGHT[t.tf] * t.score, 0) / wsum : 0;
  const conflicts: string[] = [];
  const g = (k: TfKey) => avail.find((t) => t.tf === k);
  const pairs: [TfKey, TfKey, string][] = [
    ["1D", "1W", "Daily vs weekly"],
    ["1W", "1M", "Weekly vs monthly"],
    ["1h", "1D", "Hourly vs daily"],
    ["15m", "1h", "15-minute vs hourly"],
  ];
  for (const [a, b, label] of pairs) {
    const A = g(a), B = g(b);
    if (A && B && A.trend !== "neutral" && B.trend !== "neutral" && A.trend !== B.trend)
      conflicts.push(`${label}: ${A.tf} is ${A.trend} while ${B.tf} is ${B.trend}. ${["1h", "15m"].includes(a) ? "Short-term counter-move inside the larger trend; timing risk is higher." : "The higher timeframe usually dominates; size down or wait for alignment."}`);
  }
  return { score, trend: dir(score), conflicts, coverage: wsum };
}

export interface TradePlan {
  direction: Direction;
  confirmation: { price: number; rule: string } | null;
  invalidation: { price: number; rule: string } | null;
  targets: { price: number; label: string }[];
  dipZone: { low: number; high: number } | null;
  extended: boolean;
  extendedReason: string | null;
  nearTrigger: boolean; // price is within 0.5 ATR of the confirmation level
  alreadyConfirmed: boolean;
}

export function tradePlan(direction: Direction, st: DailyStats, lv: { supports: KeyLevel[]; resistances: KeyLevel[] }): TradePlan {
  const px = st.close, A = st.atr14 ?? px * 0.02;
  const res = lv.resistances, sup = lv.supports;
  if (direction === "neutral") {
    const r = res[0], s = sup[0];
    return {
      direction,
      confirmation: r ? { price: r.price + 0.1 * A, rule: `Bullish trigger: daily close above ${r.label} (${r.price.toFixed(2)}). Bearish trigger: close below ${s ? s.price.toFixed(2) : "support"}.` } : null,
      invalidation: null,
      targets: [],
      dipZone: null,
      extended: false,
      extendedReason: null,
      nearTrigger: !!r && r.price - px < 0.5 * A,
      alreadyConfirmed: false,
    };
  }
  const bull = direction === "bullish";
  const ahead = bull ? res : sup; // levels in the direction of the trade
  const behind = bull ? sup : res;
  const sign = bull ? 1 : -1;
  // invalidation: first level behind price at least 0.5 ATR away, with a 0.25 ATR buffer
  const inv = behind.find((l) => Math.abs(px - l.price) >= 0.5 * A);
  const invalidation = inv
    ? { price: inv.price - sign * 0.25 * A, rule: `Daily close ${bull ? "below" : "above"} ${inv.label} (${inv.price.toFixed(2)}) with a 0.25 ATR buffer` }
    : { price: px - sign * 2 * A, rule: "No nearby structural level; 2x ATR(14) from current price" };
  // confirmation: first level ahead within 3 ATR
  const conf = ahead.find((l) => Math.abs(l.price - px) <= 3 * A);
  const recentExtreme = bull ? st.high20 : st.low20;
  const alreadyConfirmed = bull ? px > recentExtreme : px < recentExtreme;
  const confirmation = conf
    ? { price: conf.price + sign * 0.1 * A, rule: `Daily close ${bull ? "above" : "below"} ${conf.label} (${conf.price.toFixed(2)}) on above-average volume` }
    : { price: recentExtreme, rule: alreadyConfirmed ? `Already through the 20-day ${bull ? "high" : "low"}; must hold ${bull ? "above" : "below"} ${recentExtreme.toFixed(2)}` : `Close ${bull ? "above the 20-day high" : "below the 20-day low"} (${recentExtreme.toFixed(2)})` };
  const beyond = ahead.filter((l) => (bull ? l.price > confirmation.price : l.price < confirmation.price)).slice(0, 2);
  const targets = beyond.map((l) => ({ price: l.price, label: l.label }));
  if (targets.length < 2) {
    targets.push({ price: px + sign * 2 * A, label: "2x ATR projection" });
    if (targets.length < 2) targets.push({ price: px + sign * 3.5 * A, label: "3.5x ATR projection" });
  }
  targets.sort((a, b) => sign * (a.price - b.price));
  const distFromMa = st.sma20 ? (px - st.sma20) / A : 0;
  let extendedReason: string | null = null;
  if (bull && (distFromMa > 2 || (st.rsi14 ?? 50) > 72)) extendedReason = distFromMa > 2 ? `${distFromMa.toFixed(1)} ATR above the 20-day SMA` : `RSI ${st.rsi14?.toFixed(0)} overbought`;
  if (!bull && (distFromMa < -2 || (st.rsi14 ?? 50) < 28)) extendedReason = distFromMa < -2 ? `${(-distFromMa).toFixed(1)} ATR below the 20-day SMA` : `RSI ${st.rsi14?.toFixed(0)} oversold`;
  const anchor = bull ? Math.max(st.ema21 ?? 0, sup[0]?.price ?? 0) : Math.min(st.ema21 ?? Infinity, res[0]?.price ?? Infinity);
  const dipZone = Number.isFinite(anchor) && anchor > 0
    ? bull ? { low: anchor - 0.25 * A, high: anchor + 0.5 * A } : { low: anchor - 0.5 * A, high: anchor + 0.25 * A }
    : null;
  return {
    direction, confirmation, invalidation, targets: targets.slice(0, 3), dipZone,
    extended: !!extendedReason, extendedReason,
    nearTrigger: !alreadyConfirmed && Math.abs(confirmation.price - px) < 0.5 * A,
    alreadyConfirmed,
  };
}

export function breakoutState(b: Bar[], st: DailyStats): { state: "breakout" | "breakdown" | "inside"; detail: string } {
  const px = st.close;
  const rv = st.relVolume ?? 1;
  if (px > st.high20) return { state: "breakout", detail: `Close above prior 20-day high ${st.high20.toFixed(2)} on ${rv.toFixed(1)}x relative volume${rv < 1.2 ? " (weak volume confirmation)" : ""}` };
  if (px < st.low20) return { state: "breakdown", detail: `Close below prior 20-day low ${st.low20.toFixed(2)} on ${rv.toFixed(1)}x relative volume${rv < 1.2 ? " (weak volume confirmation)" : ""}` };
  return { state: "inside", detail: `Inside the 20-day range ${st.low20.toFixed(2)} - ${st.high20.toFixed(2)}` };
}
