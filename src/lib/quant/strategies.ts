// Defined-risk strategy construction from an actual option chain. Only long options and debit
// verticals are generated: no naked short options or undefined-risk positions, ever.
import type { Direction, OptionContract } from "../types";
import { bsGreeks, probAbove } from "./blackscholes";
import { contractIv, mid, spreadPct } from "./options";
import { expirationPayoff, positionValue, type PricedLeg } from "./scenario";

export type StrategyKind = "long_call" | "long_put" | "bull_call_spread" | "bear_put_spread";

export interface StrategyLeg {
  action: "buy" | "sell";
  type: "call" | "put";
  strike: number;
  expiration: string;
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  iv: number;
  ivSource: "provider" | "computed";
  delta: number;
  theta: number | null;
  vega: number | null;
  openInterest: number;
  volume: number;
  spreadPct: number;
  quoteTime: number | null;
}

export interface ProbabilityEstimate {
  value: number | null;
  method: string;
  samples?: number;
  effectiveSamples?: number;
  available: boolean;
}

export interface StrategyCandidate {
  id: string;
  profile: "conservative" | "aggressive";
  kind: StrategyKind;
  name: string;
  direction: "CALL" | "PUT";
  expiration: string;
  dte: number;
  legs: StrategyLeg[];
  naturalDebit: number;
  midDebit: number;
  limitPrice: number; // estimated limit entry per share
  maxLossPerUnit: number; // $ incl. round-trip commissions
  maxProfitPerUnit: number | null; // $; null = theoretically unlimited
  breakeven: number;
  breakevenMovePct: number;
  rewardRisk: number | null;
  popEmpirical: ProbabilityEstimate;
  popModel: ProbabilityEstimate;
  expectedValueEmpirical: number | null;
  target: { price: number; label: string; byDay: number; estValue: number; estPnl: number; estPnlPct: number };
  takeProfit: string;
  stopLoss: string;
  maxHoldDays: number;
  exitByDate: string;
  thetaPerDay: number | null; // $ per unit per day
  thetaPctPerDay: number | null;
  netDelta: number;
  netVega: number | null;
  worstSpreadPct: number;
  minOpenInterest: number;
  exitSlippagePerUnit: number;
  spansEarnings: boolean;
  riskLevel: string;
  score: number;
  scoreBreakdown: Record<string, number>;
  rationale: string[];
  warnings: string[];
  pricedLegs: PricedLeg[];
}

export interface StrategyInputs {
  chains: Record<string, OptionContract[]>;
  dteByExp: Record<string, number>;
  spot: number;
  r: number;
  direction: Direction;
  targets: { price: number; label: string }[];
  invalidation: { price: number; rule: string } | null;
  dailyCloses: number[];
  oneSigmaPct30: number | null;
  ivRich: boolean;
  commissionPerContract: number;
  holdingDays: number;
  earningsDate: string | null;
  today: string;
  /** Per-trade $ risk limit from the user's risk profile; structures within it are preferred. */
  maxLossBudget?: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const tradingDays = (dte: number) => Math.max(1, Math.round((dte * 252) / 365));

/**
 * Historical distribution of H-trading-day log returns from the stock's own daily closes
 * (last ~3 years), de-meaned so past drift (and the survivorship tailwind of a stock that went up)
 * does not bias call vs put. Overlapping windows are used; effective independent samples = N / H.
 */
export function empiricalReturns(closes: number[], h: number, lookback = 756): { rets: number[]; effective: number } {
  const c = closes.slice(-lookback - h);
  const rets: number[] = [];
  for (let i = h; i < c.length; i++) rets.push(Math.log(c[i] / c[i - h]));
  if (!rets.length) return { rets, effective: 0 };
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  return { rets: rets.map((x) => x - m), effective: Math.floor(rets.length / h) };
}

function toLeg(o: OptionContract, action: "buy" | "sell", spot: number, T: number, r: number): StrategyLeg | null {
  const m = mid(o);
  const sp = spreadPct(o);
  if (m == null || o.bid == null || o.ask == null || o.bid <= 0 || sp == null) return null;
  const iv = contractIv(o, spot, T, r);
  if (!iv) return null;
  const delta = o.greeks?.delta ?? bsGreeks({ S: spot, K: o.strike, T, r, sigma: iv.iv, type: o.type }).delta;
  return {
    action, type: o.type, strike: o.strike, expiration: o.expiration, symbol: o.symbol, bid: o.bid, ask: o.ask, mid: m,
    iv: iv.iv, ivSource: iv.source, delta, theta: o.greeks?.theta ?? null, vega: o.greeks?.vega ?? null,
    openInterest: o.openInterest, volume: o.volume, spreadPct: sp, quoteTime: o.askTime ?? o.bidTime,
  };
}

function build(
  profile: "conservative" | "aggressive",
  kind: StrategyKind,
  legs: StrategyLeg[],
  dte: number,
  inp: StrategyInputs,
  emp: { rets: number[]; effective: number },
): StrategyCandidate | null {
  const { spot, r, commissionPerContract: fee } = inp;
  const isCall = legs[0].type === "call";
  const sign = (l: StrategyLeg) => (l.action === "buy" ? 1 : -1);
  const naturalDebit = legs.reduce((s, l) => s + (l.action === "buy" ? l.ask : -l.bid), 0);
  const midDebit = legs.reduce((s, l) => s + sign(l) * l.mid, 0);
  if (!(midDebit > 0.05) || !(naturalDebit > 0)) return null;
  // Estimated limit: mid plus a quarter of the distance to the natural price (a realistic fill assumption).
  const limitPrice = round2(midDebit + 0.25 * (naturalDebit - midDebit));
  const fees = legs.length * 2 * fee;
  const long = legs.find((l) => l.action === "buy")!;
  const short = legs.find((l) => l.action === "sell");
  const width = short ? Math.abs(short.strike - long.strike) : null;
  if (width != null && limitPrice >= width) return null;
  const maxLossPerUnit = limitPrice * 100 + fees;
  const maxProfitPerUnit = width != null ? (width - limitPrice) * 100 - fees : isCall ? null : (long.strike - limitPrice) * 100 - fees;
  const breakeven = isCall ? long.strike + limitPrice : long.strike - limitPrice;
  const pricedLegs: PricedLeg[] = legs.map((l) => ({ action: l.action, type: l.type, strike: l.strike, dte, iv: l.iv, qty: 1 }));

  // Probabilities
  const atmIv = long.iv;
  const T = dte / 365;
  const pModel = isCall ? probAbove(spot, breakeven, T, r, atmIv) : 1 - probAbove(spot, breakeven, T, r, atmIv);
  const popModel: ProbabilityEstimate = {
    value: pModel,
    available: true,
    method: `Risk-neutral lognormal (Black-Scholes) probability of finishing beyond break-even using the option's own IV ${(atmIv * 100).toFixed(1)}%. This is the market-implied reference, not a calibrated real-world forecast.`,
  };
  let popEmpirical: ProbabilityEstimate;
  let ev: number | null = null;
  if (emp.effective >= 8) {
    let wins = 0, pay = 0;
    for (const x of emp.rets) {
      const ST = spot * Math.exp(x);
      const v = expirationPayoff(pricedLegs, ST);
      if (v - limitPrice > fees / 100) wins++;
      pay += v;
    }
    popEmpirical = {
      value: wins / emp.rets.length,
      available: true,
      samples: emp.rets.length,
      effectiveSamples: emp.effective,
      method: `Share of the stock's own historical ${tradingDays(dte)}-trading-day moves (last ~3y, ${emp.rets.length} overlapping windows, ~${emp.effective} independent; de-meaned) that would have finished beyond break-even after fees. Assumes future moves resemble the past; no directional edge is assumed.`,
    };
    ev = (pay / emp.rets.length - limitPrice) * 100 - fees;
  } else {
    popEmpirical = {
      value: null,
      available: false,
      samples: emp.rets.length,
      effectiveSamples: emp.effective,
      method: `Unavailable: only ~${emp.effective} independent ${tradingDays(dte)}-day windows of price history (need >= 8).`,
    };
  }

  // Target scenario
  const sign1 = isCall ? 1 : -1;
  const tgt =
    inp.targets.find((t) => sign1 * (t.price - spot) > 0) ??
    (inp.oneSigmaPct30 ? { price: spot * (1 + sign1 * inp.oneSigmaPct30), label: "1-sigma implied move" } : { price: spot * (1 + sign1 * 0.05), label: "+/-5% reference move" });
  const maxHoldDays =
    profile === "conservative" ? Math.max(5, Math.min(inp.holdingDays, dte - 14)) : Math.max(2, Math.min(inp.holdingDays, Math.round(dte / 3)));
  const byDay = Math.min(maxHoldDays, Math.max(1, Math.round(dte * 0.5)));
  const estValue = positionValue(pricedLegs, tgt.price, byDay, 0, r);
  const exitSlippagePerUnit = legs.reduce((s, l) => s + (l.ask - l.bid) / 2, 0) * 100 + fees / 2;
  const estPnl = (estValue - limitPrice) * 100 - exitSlippagePerUnit - fees / 2;

  const thetaRaw = legs.every((l) => l.theta != null) ? legs.reduce((s, l) => s + sign(l) * (l.theta as number), 0) * 100 : null;
  const netVega = legs.every((l) => l.vega != null) ? legs.reduce((s, l) => s + sign(l) * (l.vega as number), 0) * 100 : null;
  const netDelta = legs.reduce((s, l) => s + sign(l) * l.delta, 0);
  const worstSpreadPct = Math.max(...legs.map((l) => l.spreadPct));
  const minOpenInterest = Math.min(...legs.map((l) => l.openInterest));
  const expDate = legs[0].expiration;
  const spansEarnings = !!inp.earningsDate && inp.earningsDate >= inp.today && inp.earningsDate <= expDate;
  const exitBy = new Date(Date.parse(`${inp.today}T00:00:00Z`) + maxHoldDays * 86_400_000).toISOString().slice(0, 10);

  const pop = popEmpirical.value ?? pModel;
  const rr = maxProfitPerUnit != null ? maxProfitPerUnit / maxLossPerUnit : null;
  const thetaPct = thetaRaw != null ? -thetaRaw / (limitPrice * 100) : null;
  const liq = clamp01(1 - worstSpreadPct / 0.15) * 0.7 + clamp01(Math.log10(Math.max(minOpenInterest, 1)) / 4) * 0.3;
  const retAtTarget = estPnl / maxLossPerUnit;
  const breakdown: Record<string, number> =
    profile === "conservative"
      ? {
          probability: 0.35 * pop,
          rewardRisk: 0.2 * clamp01((rr ?? 2) / 2),
          liquidity: 0.2 * liq,
          timeDecay: 0.15 * (1 - clamp01((thetaPct ?? 0.01) * 25)),
          targetCapture: 0.1 * clamp01(retAtTarget),
          earningsPenalty: spansEarnings ? -0.05 : 0,
        }
      : {
          payoffAtTarget: 0.4 * clamp01(retAtTarget / 2),
          probability: 0.2 * pop,
          liquidity: 0.2 * liq,
          timeDecay: 0.2 * (1 - clamp01((thetaPct ?? 0.02) * 15)),
          ivPenalty: inp.ivRich && !short ? -0.08 : 0,
          earningsPenalty: spansEarnings && !short ? -0.05 : 0,
        };
  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const names: Record<StrategyKind, string> = {
    long_call: "Long Call", long_put: "Long Put", bull_call_spread: "Bull Call Debit Spread", bear_put_spread: "Bear Put Debit Spread",
  };
  const legStr = legs.map((l) => `${l.action === "buy" ? "Buy" : "Sell"} ${l.strike}${l.type === "call" ? "C" : "P"}`).join(" / ");
  const rationale: string[] = [];
  const warnings: string[] = [];
  if (short) rationale.push(`Short ${short.strike} leg cuts the cost by $${(short.mid * 100).toFixed(0)} and offsets ${short.vega != null && long.vega ? Math.round((short.vega / long.vega) * 100) : "part of the"}% of vega/theta, in exchange for capping profit at the short strike.`);
  else rationale.push(`Single long ${long.type}: unlimited${isCall ? "" : " (to zero)"} upside, but pays full time value and full IV exposure.`);
  rationale.push(`Long leg delta ${long.delta.toFixed(2)}; needs ${((Math.abs(breakeven / spot - 1)) * 100).toFixed(1)}% move to break even at expiration.`);
  if (spansEarnings) warnings.push(`Expiration spans earnings (${inp.earningsDate}). Expect a volatility collapse after the report; a correct direction can still lose if the move is smaller than priced.`);
  if (worstSpreadPct > 0.08) warnings.push(`Wide bid/ask (${(worstSpreadPct * 100).toFixed(0)}% of mid on the worst leg): use limit orders only.`);
  if (minOpenInterest < 500) warnings.push(`Thin open interest (${minOpenInterest}) on at least one leg.`);
  if (thetaPct != null && thetaPct > 0.03) warnings.push(`Time decay ~${(thetaPct * 100).toFixed(1)}% of premium per day at current prices.`);
  if (inp.ivRich && !short) warnings.push("IV is rich relative to realized volatility; long premium is penalized.");

  const invalid = inp.invalidation ? `underlying closes ${isCall ? "below" : "above"} ${inp.invalidation.price.toFixed(2)} (${inp.invalidation.rule})` : "the thesis is invalidated";
  const takeProfit = short
    ? `Close at ~50-60% of max profit (spread value ~$${(limitPrice + 0.55 * (width! - limitPrice)).toFixed(2)}) or if the underlying reaches ${tgt.price.toFixed(2)} early.`
    : `Sell half at +60% (option ~$${(limitPrice * 1.6).toFixed(2)}), the rest at +100% or at ${tgt.price.toFixed(2)} on the underlying.`;
  const stopLoss = `Exit if ${invalid}, or if the position loses ${profile === "conservative" ? "50" : "50"}% of the debit (value ~$${(limitPrice * 0.5).toFixed(2)}), or on ${exitBy} (time stop) - whichever comes first. Never average down.`;

  return {
    id: `${profile}-${kind}-${expDate}-${legs.map((l) => l.strike).join("-")}`,
    profile, kind,
    name: `${names[kind]} ${legStr} (${expDate})`,
    direction: isCall ? "CALL" : "PUT",
    expiration: expDate, dte, legs,
    naturalDebit: round2(naturalDebit), midDebit: round2(midDebit), limitPrice,
    maxLossPerUnit, maxProfitPerUnit, breakeven, breakevenMovePct: breakeven / spot - 1, rewardRisk: rr,
    popEmpirical, popModel, expectedValueEmpirical: ev,
    target: { price: tgt.price, label: tgt.label, byDay, estValue, estPnl, estPnlPct: estPnl / (limitPrice * 100) },
    takeProfit, stopLoss, maxHoldDays, exitByDate: exitBy,
    thetaPerDay: thetaRaw, thetaPctPerDay: thetaPct, netDelta, netVega, worstSpreadPct, minOpenInterest, exitSlippagePerUnit,
    spansEarnings,
    riskLevel: profile === "conservative" ? (short ? "Moderate (defined, capped)" : "Moderate") : short ? "High (defined)" : "High (full premium at risk)",
    score, scoreBreakdown: breakdown, rationale, warnings, pricedLegs,
  };
}

export interface StrategySelection {
  conservative: StrategyCandidate | null;
  aggressive: StrategyCandidate | null;
  alternatives: { conservative: StrategyCandidate[]; aggressive: StrategyCandidate[] };
  evaluated: number;
  rejectedIlliquid: number;
  notes: string[];
}

export function buildStrategies(inp: StrategyInputs): StrategySelection {
  const notes: string[] = [];
  if (inp.direction === "neutral") {
    return {
      conservative: null, aggressive: null, alternatives: { conservative: [], aggressive: [] }, evaluated: 0, rejectedIlliquid: 0,
      notes: ["No directional edge: directional option structures are not generated for a neutral read. Waiting is the recommendation."],
    };
  }
  const isCall = inp.direction === "bullish";
  const type = isCall ? "call" : "put";
  const cons: StrategyCandidate[] = [], aggr: StrategyCandidate[] = [];
  let evaluated = 0, rejected = 0;
  const empCache = new Map<number, { rets: number[]; effective: number }>();
  const emp = (dte: number) => {
    const h = tradingDays(dte);
    if (!empCache.has(h)) empCache.set(h, empiricalReturns(inp.dailyCloses, h));
    return empCache.get(h)!;
  };

  for (const [exp, chain] of Object.entries(inp.chains)) {
    const dte = inp.dteByExp[exp];
    if (dte < 5 || dte > 120) continue;
    const T = dte / 365;
    const legsAll = chain
      .filter((o) => o.type === type)
      .sort((a, b) => (isCall ? a.strike - b.strike : b.strike - a.strike));
    const priced = legsAll.map((o) => ({ o, buy: toLeg(o, "buy", inp.spot, T, inp.r), sell: toLeg(o, "sell", inp.spot, T, inp.r) }));
    const liquid = (l: StrategyLeg | null, maxSp: number, minOi: number) => !!l && l.spreadPct <= maxSp && l.openInterest >= minOi;

    for (let i = 0; i < priced.length; i++) {
      const L = priced[i].buy;
      if (!L) continue;
      const ad = Math.abs(L.delta);
      // Long singles (aggressive only)
      if (dte >= 7 && dte <= 45 && ad >= 0.25 && ad <= 0.6) {
        evaluated++;
        if (liquid(L, 0.15, 100)) {
          const c = build("aggressive", isCall ? "long_call" : "long_put", [L], dte, inp, emp(dte));
          if (c) aggr.push(c);
        } else rejected++;
      }
      // Debit verticals
      if (ad < 0.3 || ad > 0.78) continue;
      for (let j = i + 1; j < priced.length; j++) {
        const Sh = priced[j].sell;
        if (!Sh) continue;
        const sd = Math.abs(Sh.delta);
        if (sd < 0.08 || sd > 0.48) continue;
        const width = Math.abs(Sh.strike - L.strike);
        if (width > inp.spot * 0.25) break;
        evaluated++;
        const consOk = dte >= 21 && dte <= 75 && ad >= 0.45 && liquid(L, 0.1, 100) && liquid(Sh, 0.12, 100);
        const aggrOk = dte >= 7 && dte <= 45 && ad <= 0.55 && liquid(L, 0.15, 50) && liquid(Sh, 0.2, 50);
        if (!consOk && !aggrOk) { rejected++; continue; }
        const kind = isCall ? "bull_call_spread" : "bear_put_spread";
        if (consOk) {
          const c = build("conservative", kind, [L, Sh], dte, inp, emp(dte));
          if (c && (c.rewardRisk ?? 0) >= 0.6) cons.push(c);
        }
        if (aggrOk) {
          const c = build("aggressive", kind, [L, Sh], dte, inp, emp(dte));
          if (c && (c.rewardRisk ?? 0) >= 1.2) aggr.push(c);
        }
      }
    }
  }
  cons.sort((a, b) => b.score - a.score);
  aggr.sort((a, b) => b.score - a.score);
  // Prefer the best-scoring structure whose max loss fits the user's per-trade limit.
  const budget = inp.maxLossBudget ?? Infinity;
  const fits = (c: StrategyCandidate) => c.maxLossPerUnit <= budget;
  const distinct = (a: StrategyCandidate) => !conservative || a.name !== conservative.name;
  const conservative = cons.find(fits) ?? cons[0] ?? null;
  const aggressive = aggr.find((a) => fits(a) && distinct(a)) ?? aggr.find(distinct) ?? null;
  if (Number.isFinite(budget)) {
    if (conservative && !fits(conservative)) notes.push(`No conservative structure fits your $${budget.toFixed(0)} per-trade risk limit; the best one is shown for reference but sizes to 0 units.`);
    if (aggressive && !fits(aggressive)) notes.push(`No aggressive structure fits your $${budget.toFixed(0)} per-trade risk limit; the best one is shown for reference but sizes to 0 units.`);
  }
  if (!conservative) notes.push("No conservative debit spread passed the liquidity filters (bid/ask <= 10-12% of mid, open interest >= 100, 21-75 DTE, reward/risk >= 0.6).");
  if (!aggressive) notes.push("No aggressive structure passed the liquidity filters (bid/ask <= 15-20% of mid, open interest >= 50, 7-45 DTE).");
  return { conservative, aggressive, alternatives: { conservative: cons.slice(1, 4), aggressive: aggr.filter((a) => a !== aggressive).slice(0, 3) }, evaluated, rejectedIlliquid: rejected, notes };
}
