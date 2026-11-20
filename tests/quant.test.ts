import { describe, expect, it } from "vitest";
import { bsGreeks, bsPrice, impliedVol, normCdf, probAbove } from "@/lib/quant/blackscholes";
import { atr, bollinger, ema, historicalVol, macd, rsi, sma, aggregate } from "@/lib/quant/indicators";
import { scenarioGrid, expirationPayoff, positionValue } from "@/lib/quant/scenario";
import { sizePosition, DEFAULT_RISK } from "@/lib/quant/risk";
import { buildStrategies, empiricalReturns } from "@/lib/quant/strategies";
import { analyzeOptions, interpIv } from "@/lib/quant/options";
import { dailyStats, keyLevels, tradePlan, scoreTimeframe, combineTimeframes } from "@/lib/quant/technical";
import { similarSetupStudy, earningsReactions, modelPricedSpreadBacktest } from "@/lib/quant/backtest";
import { decide } from "@/lib/engine/decision";
import { parseChain, parseDaily, parseQuote, parseTimesales } from "@/lib/providers/tradier";
import { dedupe, lexiconScore } from "@/lib/news/analyze";
import { localClock, lastSessionDate } from "@/lib/market-time";
import type { Bar, OptionContract } from "@/lib/types";

// ---------- deterministic synthetic fixtures (TEST ONLY) ----------
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function synthBars(n: number, drift = 0.0005, vol = 0.02, seed = 7): Bar[] {
  const r = rng(seed);
  const out: Bar[] = [];
  let p = 100;
  const start = Date.parse("2023-01-02T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const z = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    const o = p;
    p = p * Math.exp(drift + vol * z);
    const h = Math.max(o, p) * (1 + r() * 0.01), l = Math.min(o, p) * (1 - r() * 0.01);
    const t = start + i * 86_400_000;
    out.push({ t, date: new Date(t).toISOString().slice(0, 10), o, h, l, c: p, v: 1e6 * (0.5 + r()) });
  }
  return out;
}
function synthChain(spot: number, exp: string, dte: number, iv: number, r = 0.04): OptionContract[] {
  const out: OptionContract[] = [];
  for (let k = Math.round(spot * 0.7); k <= Math.round(spot * 1.3); k += 1) {
    for (const type of ["call", "put"] as const) {
      const T = dte / 365;
      const sk = iv + (type === "put" ? 0.02 : 0) * (spot / k);
      const p = bsPrice({ S: spot, K: k, T, r, sigma: sk, type });
      const g = bsGreeks({ S: spot, K: k, T, r, sigma: sk, type });
      const half = Math.max(0.01, p * 0.02);
      out.push({
        symbol: `X${exp}${type[0]}${k}`, type, strike: k, expiration: exp, bid: Math.max(0, +(p - half).toFixed(2)), ask: +(p + half).toFixed(2), last: p,
        volume: 1000, openInterest: 5000, bidTime: 1, askTime: 1, contractSize: 100,
        greeks: { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, rho: null, midIv: sk, bidIv: null, askIv: null, updatedAt: null },
      });
    }
  }
  return out;
}

describe("Black-Scholes", () => {
  it("normCdf is accurate", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
  });
  it("satisfies put-call parity", () => {
    const S = 100, K = 105, T = 0.5, r = 0.04, sigma = 0.3;
    const c = bsPrice({ S, K, T, r, sigma, type: "call" }), p = bsPrice({ S, K, T, r, sigma, type: "put" });
    expect(c - p).toBeCloseTo(S - K * Math.exp(-r * T), 6);
  });
  it("matches a textbook value", () => {
    // Hull: S=42, K=40, r=10%, sigma=20%, T=0.5 -> call 4.76, put 0.81
    expect(bsPrice({ S: 42, K: 40, T: 0.5, r: 0.1, sigma: 0.2, type: "call" })).toBeCloseTo(4.76, 2);
    expect(bsPrice({ S: 42, K: 40, T: 0.5, r: 0.1, sigma: 0.2, type: "put" })).toBeCloseTo(0.81, 2);
  });
  it("implied vol round-trips", () => {
    const p = bsPrice({ S: 100, K: 110, T: 0.25, r: 0.04, sigma: 0.42, type: "call" });
    expect(impliedVol(p, 100, 110, 0.25, 0.04, "call")!).toBeCloseTo(0.42, 4);
    expect(impliedVol(0.0001, 100, 50, 0.25, 0.04, "call")).toBeNull(); // below intrinsic
  });
  it("greeks have the right signs", () => {
    const g = bsGreeks({ S: 100, K: 100, T: 0.25, r: 0.04, sigma: 0.3, type: "put" });
    expect(g.delta).toBeLessThan(0);
    expect(g.theta).toBeLessThan(0);
    expect(g.vega).toBeGreaterThan(0);
    expect(probAbove(100, 100, 1, 0, 0.2)).toBeLessThan(0.5); // lognormal drift correction
  });
});

describe("indicators", () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it("sma/ema", () => {
    expect(sma(x, 3)[2]).toBe(2);
    expect(sma(x, 3)[9]).toBe(9);
    expect(Number.isNaN(sma(x, 3)[1])).toBe(true);
    expect(ema(x, 3)[2]).toBe(2);
  });
  it("rsi is 100 for monotonic up series and within bounds otherwise", () => {
    expect(rsi(Array.from({ length: 30 }, (_, i) => i + 1))[29]).toBe(100);
    const b = synthBars(200);
    const r = rsi(b.map((y) => y.c)).filter(Number.isFinite);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...r)).toBeLessThanOrEqual(100);
  });
  it("macd/bollinger/atr/hv produce finite values after warm-up", () => {
    const b = synthBars(300, 0, 0.02);
    const c = b.map((y) => y.c);
    expect(Number.isFinite(macd(c).hist[299])).toBe(true);
    const bb = bollinger(c);
    expect(bb.upper[299]).toBeGreaterThan(bb.lower[299]);
    expect(atr(b)[299]).toBeGreaterThan(0);
    const hv = historicalVol(c, 60)[299];
    expect(hv).toBeGreaterThan(0.2);
    expect(hv).toBeLessThan(0.45); // true vol = 0.02*sqrt(252) = 0.317
  });
  it("indicators do not look ahead", () => {
    const c = synthBars(300).map((b) => b.c);
    const full = rsi(c), cut = rsi(c.slice(0, 200));
    expect(cut[199]).toBeCloseTo(full[199], 10);
    expect(macd(c.slice(0, 200)).hist[199]).toBeCloseTo(macd(c).hist[199], 10);
  });
  it("aggregates 15m bars into hourly per session", () => {
    const bars: Bar[] = Array.from({ length: 8 }, (_, i) => ({ t: i, date: `2026-01-0${i < 4 ? 5 : 6}T10:00`, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 10 }));
    const h = aggregate(bars, 4);
    expect(h).toHaveLength(2);
    expect(h[0].v).toBe(40);
    expect(h[0].h).toBe(4);
  });
});

describe("scenario & risk", () => {
  const legs = [
    { action: "buy" as const, type: "call" as const, strike: 100, dte: 30, iv: 0.3, qty: 1 },
    { action: "sell" as const, type: "call" as const, strike: 110, dte: 30, iv: 0.3, qty: 1 },
  ];
  it("spread payoff is capped at width", () => {
    expect(expirationPayoff(legs, 150)).toBe(10);
    expect(expirationPayoff(legs, 90)).toBe(0);
    expect(positionValue(legs, 105, 0, 0, 0.04)).toBeGreaterThan(0);
  });
  it("grid has expiration row and IV collapse lowers long-premium value", () => {
    const g = scenarioGrid([legs[0]], 100, 3.5, 0.04);
    expect(g[g.length - 1].isExpiration).toBe(true);
    const crush = scenarioGrid([legs[0]], 100, 3.5, 0.04, { ivShift: -0.15 });
    expect(crush[0].cells[4].pnl).toBeLessThan(g[0].cells[4].pnl);
  });
  it("sizing respects the tighter limit and refuses oversize trades", () => {
    const s = sizePosition({ ...DEFAULT_RISK, budget: 10000, maxRiskPct: 0.02, maxLossDollars: 150 }, 60, 5, 58);
    expect(s.riskBudget).toBe(150);
    expect(s.contracts).toBe(2);
    expect(s.maxLossTotal).toBeLessThanOrEqual(150);
    const no = sizePosition(DEFAULT_RISK, 900, 5, 890);
    expect(no.feasible).toBe(false);
    expect(no.contracts).toBe(0);
  });
});

describe("options analytics & strategies", () => {
  const spot = 100;
  const chains = { "2026-12-18": synthChain(spot, "2026-12-18", 28, 0.35), "2027-01-15": synthChain(spot, "2027-01-15", 56, 0.33) };
  const dte = { "2026-12-18": 28, "2027-01-15": 56 };
  it("computes ATM IV, expected moves, term structure", () => {
    const a = analyzeOptions(chains, dte, spot, 0.04, 0.3, []);
    expect(a.iv30!).toBeGreaterThan(0.33);
    expect(a.iv30!).toBeLessThan(0.38);
    expect(a.expiries[0].impliedMovePct!).toBeGreaterThan(0.05);
    expect(a.ivRank.value).toBeNull(); // no recorded history -> honest "unavailable"
    expect(a.liquidity.grade).toMatch(/[AB]/);
    expect(interpIv(a.expiries, 28)).toBeCloseTo(a.expiries[0].atmIv!, 6);
  });
  it("builds only defined-risk debit structures with consistent math", () => {
    const closes = synthBars(800, 0.0003, 0.02).map((b) => b.c * (spot / 100));
    const sel = buildStrategies({
      chains, dteByExp: dte, spot, r: 0.04, direction: "bullish", targets: [{ price: 108, label: "R1" }], invalidation: { price: 94, rule: "test" },
      dailyCloses: closes, oneSigmaPct30: 0.1, ivRich: false, commissionPerContract: 0.65, holdingDays: 21, earningsDate: null, today: "2026-11-20",
    });
    expect(sel.conservative).not.toBeNull();
    expect(sel.aggressive).not.toBeNull();
    for (const c of [sel.conservative!, sel.aggressive!, ...sel.alternatives.conservative]) {
      expect(c.direction).toBe("CALL");
      expect(c.legs.filter((l) => l.action === "sell").length).toBeLessThanOrEqual(c.legs.filter((l) => l.action === "buy").length);
      expect(c.maxLossPerUnit).toBeCloseTo(c.limitPrice * 100 + c.legs.length * 2 * 0.65, 6);
      expect(c.limitPrice).toBeGreaterThanOrEqual(c.midDebit - 1e-9);
      expect(c.limitPrice).toBeLessThanOrEqual(c.naturalDebit + 1e-9);
      if (c.legs.length === 2) {
        const w = Math.abs(c.legs[0].strike - c.legs[1].strike);
        expect(c.maxProfitPerUnit!).toBeCloseTo((w - c.limitPrice) * 100 - 4 * 0.65, 6);
        expect(c.breakeven).toBeCloseTo(c.legs[0].strike + c.limitPrice, 6);
      }
      expect(c.popEmpirical.available).toBe(true);
    }
    expect(sel.conservative!.legs).toHaveLength(2);
  });
  it("neutral direction produces no trades", () => {
    const sel = buildStrategies({
      chains, dteByExp: dte, spot, r: 0.04, direction: "neutral", targets: [], invalidation: null, dailyCloses: [], oneSigmaPct30: 0.1,
      ivRich: false, commissionPerContract: 0.65, holdingDays: 21, earningsDate: null, today: "2026-11-20",
    });
    expect(sel.conservative).toBeNull();
    expect(sel.aggressive).toBeNull();
  });
  it("empirical probability is unavailable with too little history", () => {
    expect(empiricalReturns([100, 101, 102], 20).effective).toBe(0);
    const e = empiricalReturns(synthBars(800).map((b) => b.c), 20);
    expect(Math.abs(e.rets.reduce((a, b) => a + b, 0) / e.rets.length)).toBeLessThan(1e-9); // de-meaned
  });
});

describe("technical, backtest, decision", () => {
  const bars = synthBars(800, 0.001, 0.015, 11);
  const st = dailyStats(bars);
  const lv = keyLevels(bars, st);
  it("levels are on the correct side of price", () => {
    expect(lv.supports.every((l) => l.price < st.close)).toBe(true);
    expect(lv.resistances.every((l) => l.price > st.close)).toBe(true);
  });
  it("bullish plan: invalidation below price, targets above", () => {
    const p = tradePlan("bullish", st, lv);
    expect(p.invalidation!.price).toBeLessThan(st.close);
    expect(p.targets.every((t) => t.price > st.close)).toBe(true);
    const q = tradePlan("bearish", st, lv);
    expect(q.invalidation!.price).toBeGreaterThan(st.close);
  });
  it("timeframes combine and flag conflicts", () => {
    const up = scoreTimeframe("1D", synthBars(200, 0.004, 0.005, 3));
    const down = scoreTimeframe("1W", synthBars(200, -0.004, 0.005, 3));
    expect(up.trend).toBe("bullish");
    expect(down.trend).toBe("bearish");
    expect(combineTimeframes([up, down]).conflicts.length).toBe(1);
  });
  it("studies split in/out of sample and never use the unobserved future", () => {
    const s = similarSetupStudy(bars, 15, "bullish");
    expect(s.inSample.n + s.outOfSample.n).toBeGreaterThan(0);
    expect(s.splitDate! < bars[bars.length - 1].date).toBe(true);
    const m = modelPricedSpreadBacktest(bars, "bullish", 15, 0.04, 1.1);
    expect(m.assumptions.join(" ")).toMatch(/MODELLED/);
  });
  it("earnings reactions handle amc/bmo timing", () => {
    const b = bars.slice(0, 10);
    const e = earningsReactions(b, [{ date: b[3].date, hour: "amc" }, { date: b[6].date, hour: "bmo" }]);
    expect(e.reactions).toHaveLength(2);
    const amc = e.reactions.find((x) => x.hour === "amc")!;
    expect(amc.movePct).toBeCloseTo(b[4].c / b[3].c - 1, 10);
  });
  it("decision never forces a trade without options data", () => {
    const d = decide({
      spot: st.close, marketOpen: false, quotesExecutable: false, tech: { score: 0.8, trend: "bullish", conflicts: [], coverage: 1 }, stats: st,
      plan: tradePlan("bullish", st, lv), breakout: { state: "inside", detail: "" },
      rel: { vsSpy20: 0.05, vsSpy60: 0.1, vsSector20: 0.03, vsSector60: 0.05, sectorEtf: "XLK", spyTrend: "bullish" },
      news: { score: 0.5, label: "Positive", count: 5, aiRisks: [], aiCatalysts: [] }, analyst: { score: 0.5, detail: "" }, insider: { score: null, detail: "" },
      options: null, strategies: { conservative: null, aggressive: null, alternatives: { conservative: [], aggressive: [] }, evaluated: 0, rejectedIlliquid: 0, notes: [] },
      earnings: { date: null, daysAway: null, hour: null }, holdingDays: 21, dailyCloses: bars.map((b) => b.c), dataGaps: [],
    });
    expect(d.verdict).toBe("NO TRADE");
    expect(d.timing).toBe("AVOID THIS TRADE");
    expect(d.conviction).toBeLessThanOrEqual(100);
    expect(d.convictionExplanation.join(" ")).toMatch(/NOT a probability/);
  });
});

describe("provider parsing & news", () => {
  it("parses Tradier payload shapes", () => {
    const q = parseQuote({ symbol: "AAPL", last: 190.1, bid: 190.0, ask: 190.2, change: 1.2, change_percentage: 0.64, trade_date: 1763650000000 });
    expect(q.last).toBe(190.1);
    expect(q.tradeTime).toBe(1763650000000);
    expect(parseDaily([{ date: "2026-11-19", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }])[0].c).toBe(1.5);
    expect(parseTimesales([{ time: "2026-11-19T09:30:00", timestamp: 1763562600, open: 1, high: 1, low: 1, close: 1, volume: 5, vwap: 1 }])[0].t).toBe(1763562600000);
    const ch = parseChain([{ symbol: "AAPL261218C00190000", option_type: "call", strike: 190, expiration_date: "2026-12-18", bid: 5, ask: 5.2, last: 5.1, volume: 10, open_interest: 100, greeks: { delta: 0.5, mid_iv: 0.3 } }]);
    expect(ch[0].greeks!.midIv).toBe(0.3);
  });
  it("deduplicates near-identical headlines and scores sentiment", () => {
    const base = { summary: "", url: "u", kind: "company" as const, provider: "x" };
    const c = dedupe([
      { ...base, headline: "Acme beats earnings estimates, raises guidance", source: "A", publishedAt: 2, url: "a" },
      { ...base, headline: "Acme beats earnings estimates and raises guidance", source: "B", publishedAt: 1, url: "b" },
      { ...base, headline: "Acme faces antitrust probe", source: "C", publishedAt: 3, url: "c" },
    ]);
    expect(c).toHaveLength(2);
    expect(c[0].sources).toHaveLength(2);
    expect(c[0].firstReported).toBe(1);
    expect(lexiconScore("Acme beats and raises")).toBeGreaterThan(0);
    expect(lexiconScore("Acme faces antitrust probe")).toBeLessThan(0);
  });
  it("market clock fallback", () => {
    expect(localClock(Date.parse("2026-11-21T15:00:00Z")).state).toBe("closed"); // Saturday
    expect(localClock(Date.parse("2026-11-20T15:00:00Z")).state).toBe("open"); // Fri 10:00 ET
    expect(localClock(Date.parse("2026-11-26T15:00:00Z")).state).toBe("closed"); // Thanksgiving
    expect(lastSessionDate(Date.parse("2026-11-22T15:00:00Z"))).toBe("2026-11-20");
  });
});
