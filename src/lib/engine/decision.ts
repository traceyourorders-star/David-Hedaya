import type { Direction } from "../types";
import type { DailyStats, TradePlan, RelStrength } from "../quant/technical";
import type { OptionsAnalytics } from "../quant/options";
import type { StrategyCandidate, StrategySelection } from "../quant/strategies";
import { empiricalReturns } from "../quant/strategies";

export type Verdict = "BUY CALLS" | "BUY PUTS" | "USE A DEBIT SPREAD" | "WAIT" | "NO TRADE";
export type Timing = "BUY NOW" | "WAIT FOR A DIP" | "WAIT FOR BREAKOUT CONFIRMATION" | "WAIT UNTIL AFTER EARNINGS" | "AVOID THIS TRADE";

export interface Component {
  key: string;
  label: string;
  weight: number;
  score: number | null; // -1..1, null = unavailable
  detail: string;
}

export interface Scenario {
  name: "Bull" | "Base" | "Bear";
  low: number;
  high: number;
  historicalFrequency: number | null;
  assumptions: string;
  drivers: string[];
}

export interface Trigger { price: number | null; condition: string; newAction: string }

export interface Decision {
  direction: Direction;
  composite: number;
  conviction: number;
  convictionExplanation: string[];
  components: Component[];
  penalties: { label: string; points: number }[];
  verdict: Verdict;
  verdictDetail: string;
  timing: Timing;
  timingReason: string;
  preferred: "conservative" | "aggressive" | null;
  preferredReason: string;
  triggers: Trigger[];
  scenarios: Scenario[];
  narrative: { whatToConsider: string; whyItMakesSense: string[]; whyItCouldFail: string[]; enterNowOrWait: string; whatChangesMyMind: string[]; betterRiskAdjusted: string };
  outlook: "Bullish" | "Bearish" | "Neutral";
}

export interface DecisionInputs {
  spot: number;
  marketOpen: boolean;
  quotesExecutable: boolean;
  tech: { score: number; trend: Direction; conflicts: string[]; coverage: number };
  stats: DailyStats;
  plan: TradePlan;
  breakout: { state: "breakout" | "breakdown" | "inside"; detail: string };
  rel: RelStrength;
  news: { score: number | null; label: string; count: number; aiRisks: string[]; aiCatalysts: string[] };
  analyst: { score: number | null; detail: string };
  insider: { score: number | null; detail: string };
  options: OptionsAnalytics | null;
  strategies: StrategySelection;
  earnings: { date: string | null; daysAway: number | null; hour: string | null };
  holdingDays: number;
  dailyCloses: number[];
  dataGaps: string[];
}

const clamp = (x: number, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

function riskAdjusted(c: StrategyCandidate | null): number | null {
  if (!c) return null;
  if (c.expectedValueEmpirical != null) return c.expectedValueEmpirical / c.maxLossPerUnit;
  const p = c.popModel.value ?? 0;
  const rr = c.rewardRisk ?? 1.5;
  return p * rr - (1 - p);
}

export function decide(i: DecisionInputs): Decision {
  const comps: Component[] = [];
  comps.push({ key: "technical", label: "Multi-timeframe technicals", weight: 0.3, score: i.tech.coverage > 0 ? i.tech.score : null, detail: `Weighted trend score ${i.tech.score.toFixed(2)} across available timeframes (${i.tech.trend}).` });
  const mom = i.breakout.state === "breakout" ? 0.8 : i.breakout.state === "breakdown" ? -0.8 : clamp(((i.stats.ret20d ?? 0) / Math.max(i.stats.atrPct ?? 0.02, 0.005)) / 10);
  comps.push({ key: "momentum", label: "Breakout / momentum", weight: 0.1, score: mom, detail: i.breakout.detail });
  comps.push({ key: "news", label: "News sentiment", weight: 0.15, score: i.news.score, detail: i.news.score == null ? "No news data connected." : `${i.news.label} across ${i.news.count} deduplicated stories.` });
  const fundScores = [i.analyst.score, i.insider.score].filter((x): x is number => x != null);
  comps.push({ key: "fundamental", label: "Analyst & insider positioning", weight: 0.1, score: fundScores.length ? fundScores.reduce((a, b) => a + b, 0) / fundScores.length : null, detail: [i.analyst.detail, i.insider.detail].join(" ") });
  const mkt = i.rel.spyTrend == null ? null : i.rel.spyTrend === "bullish" ? 0.6 : i.rel.spyTrend === "bearish" ? -0.6 : 0;
  comps.push({ key: "market", label: "Broad market (SPY) trend", weight: 0.1, score: mkt, detail: i.rel.spyTrend ? `SPY daily trend is ${i.rel.spyTrend}.` : "SPY data unavailable." });
  const rs = i.rel.vsSpy20 != null ? clamp((i.rel.vsSpy20 * 0.6 + (i.rel.vsSector20 ?? i.rel.vsSpy20) * 0.4) / 0.08) : null;
  comps.push({
    key: "relative", label: "Relative strength (vs SPY & sector)", weight: 0.1, score: rs,
    detail: i.rel.vsSpy20 != null ? `20-day: ${pct(i.rel.vsSpy20)} vs SPY${i.rel.vsSector20 != null ? `, ${pct(i.rel.vsSector20)} vs ${i.rel.sectorEtf}` : ""}.` : "Benchmark data unavailable.",
  });
  let flow: number | null = null, flowDetail = "Option chain unavailable.";
  if (i.options) {
    const o = i.options;
    const callPrem = o.unusual.filter((u) => u.type === "call").reduce((s, u) => s + u.premium, 0);
    const putPrem = o.unusual.filter((u) => u.type === "put").reduce((s, u) => s + u.premium, 0);
    const parts: number[] = [];
    if (o.pcrVolume != null) parts.push(clamp((0.9 - o.pcrVolume) / 0.6));
    if (callPrem + putPrem > 0) parts.push(clamp((callPrem - putPrem) / (callPrem + putPrem)));
    if (o.skew25 != null) parts.push(clamp((0.05 - o.skew25) / 0.08) * 0.5);
    flow = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    flowDetail = `Put/call volume ${o.pcrVolume?.toFixed(2) ?? "n/a"}, unusual call premium $${(callPrem / 1e6).toFixed(2)}M vs put $${(putPrem / 1e6).toFixed(2)}M, 25d skew ${o.skew25 != null ? (o.skew25 * 100).toFixed(1) + " pts" : "n/a"}. Flow is noisy: hedges and closing trades look identical to directional bets.`;
  }
  comps.push({ key: "flow", label: "Options positioning", weight: 0.15, score: flow, detail: flowDetail });

  const avail = comps.filter((c) => c.score != null);
  const wAvail = avail.reduce((s, c) => s + c.weight, 0);
  const wAll = comps.reduce((s, c) => s + c.weight, 0);
  const composite = wAvail ? avail.reduce((s, c) => s + c.weight * (c.score as number), 0) / wAvail : 0;
  const direction: Direction = composite > 0.15 ? "bullish" : composite < -0.15 ? "bearish" : "neutral";
  const sgn = Math.sign(composite);
  const agreeing = avail.filter((c) => Math.abs(c.score as number) > 0.1);
  const agreement = agreeing.length ? agreeing.filter((c) => Math.sign(c.score as number) === sgn).length / agreeing.length : 0;
  const coverage = wAvail / wAll;

  let conviction = Math.min(1, Math.abs(composite) / 0.6) * 100 * (0.5 + 0.5 * agreement) * (0.4 + 0.6 * coverage);
  const penalties: { label: string; points: number }[] = [];
  const pen = (label: string, points: number) => { penalties.push({ label, points }); conviction -= points; };
  if (i.tech.conflicts.length) pen(`${i.tech.conflicts.length} timeframe conflict(s)`, Math.min(15, 5 * i.tech.conflicts.length));
  if (i.options && ["D", "F"].includes(i.options.liquidity.grade)) pen(`Poor options liquidity (grade ${i.options.liquidity.grade})`, 20);
  if (i.earnings.daysAway != null && i.earnings.daysAway >= 0 && i.earnings.daysAway <= 7) pen("Earnings within 7 days (binary event)", 10);
  if (i.options?.pricing.verdict === "rich") pen("Options expensive vs realized volatility", 5);
  if (!i.strategies.conservative && !i.strategies.aggressive && direction !== "neutral") pen("No liquid defined-risk structure available", 25);
  if (!i.options) pen("No option chain data", 25);
  conviction = Math.round(clamp(conviction, 0, 100));

  const convictionExplanation = [
    `Composite signal ${composite.toFixed(2)} on a -1 (bearish) to +1 (bullish) scale from ${avail.length}/${comps.length} available components.`,
    `${Math.round(agreement * 100)}% of non-neutral components agree with the ${direction} direction; data coverage ${Math.round(coverage * 100)}% of model weight.`,
    "Conviction measures strength and agreement of evidence. It is NOT a probability of profit.",
  ];

  // ---- timing ----
  const p = i.plan;
  let timing: Timing = "BUY NOW";
  let timingReason = "Direction, momentum and entry location are aligned.";
  const earnSoon = i.earnings.daysAway != null && i.earnings.daysAway >= 0 && i.earnings.daysAway <= 5;
  const anyStrategy = !!(i.strategies.conservative || i.strategies.aggressive);
  if (direction === "neutral" || conviction < 35 || !anyStrategy || !i.options) {
    timing = direction === "neutral" && p.confirmation ? "WAIT FOR BREAKOUT CONFIRMATION" : "AVOID THIS TRADE";
    timingReason =
      !i.options ? "No option chain data: an options trade cannot be evaluated."
      : direction === "neutral" ? `Signals are mixed (composite ${composite.toFixed(2)}). ${p.confirmation?.rule ?? ""}`
      : !anyStrategy ? "No contract met liquidity and risk filters."
      : `Conviction ${conviction}/100 is below the 35 threshold.`;
  } else if (earnSoon) {
    timing = "WAIT UNTIL AFTER EARNINGS";
    timingReason = `Earnings on ${i.earnings.date} (${i.earnings.hour ?? "time n/a"}) in ${i.earnings.daysAway} day(s). Implied volatility usually collapses after the report; buying premium now pays for an event that is a coin-flip on direction.`;
  } else if (p.extended) {
    timing = "WAIT FOR A DIP";
    timingReason = `Price is extended (${p.extendedReason}). Better entry in the ${p.dipZone ? `${p.dipZone.low.toFixed(2)}-${p.dipZone.high.toFixed(2)}` : "pullback"} zone, which also tightens the distance to invalidation.`;
  } else if (p.nearTrigger || conviction < 50) {
    timing = "WAIT FOR BREAKOUT CONFIRMATION";
    timingReason = p.confirmation ? `${conviction < 50 ? `Conviction ${conviction} is moderate. ` : ""}Price is just short of the trigger: ${p.confirmation.rule}.` : "Wait for confirmation.";
  }
  if (timing === "BUY NOW" && !i.marketOpen) timingReason += " Market is closed: quotes are from the last session; re-run the analysis after the open before entering.";
  if (timing === "BUY NOW" && !i.quotesExecutable) timingReason += " Quotes are delayed/indicative; confirm live bid/ask at your broker and use a limit order.";

  // ---- preferred strategy ----
  const raC = riskAdjusted(i.strategies.conservative), raA = riskAdjusted(i.strategies.aggressive);
  let preferred: Decision["preferred"] = null, preferredReason = "No qualifying strategy.";
  if (raC != null || raA != null) {
    preferred = raA != null && (raC == null || raA > raC + 0.05) ? "aggressive" : "conservative";
    const s = preferred === "conservative" ? i.strategies.conservative! : i.strategies.aggressive!;
    preferredReason = `${preferred === "conservative" ? "Conservative" : "Aggressive"} setup has the better risk-adjusted profile (${s.expectedValueEmpirical != null ? `historical-distribution expectancy ${(s.expectedValueEmpirical / s.maxLossPerUnit * 100).toFixed(0)}% of max loss` : "model-based score"} vs ${raC != null && raA != null ? `${((preferred === "conservative" ? raA : raC) * 100).toFixed(0)}% for the alternative` : "no alternative"}). Expectancy assumes no directional edge; your directional thesis is what must add the edge.`;
  }

  // ---- verdict ----
  let verdict: Verdict;
  let verdictDetail: string;
  const best = preferred === "aggressive" ? i.strategies.aggressive : i.strategies.conservative;
  if (timing === "AVOID THIS TRADE") {
    verdict = direction === "neutral" && p.confirmation ? "WAIT" : "NO TRADE";
    verdictDetail = timingReason;
  } else if (timing !== "BUY NOW") {
    verdict = "WAIT";
    verdictDetail = `${direction === "bullish" ? "Bullish" : "Bearish"} bias, but ${timing.toLowerCase()}. ${timingReason}`;
  } else if (best && (best.legs.length > 1 || i.options?.pricing.verdict === "rich")) {
    verdict = "USE A DEBIT SPREAD";
    verdictDetail = `${direction === "bullish" ? "Bull call" : "Bear put"} debit spread: defined risk, and the short leg offsets ${i.options?.pricing.verdict === "rich" ? "rich implied volatility and " : ""}time decay.`;
  } else {
    verdict = direction === "bullish" ? "BUY CALLS" : "BUY PUTS";
    verdictDetail = `Long ${direction === "bullish" ? "calls" : "puts"}: options are ${i.options?.pricing.verdict ?? "n/a"} relative to realized volatility, so paying for full upside is reasonable.`;
  }

  // ---- triggers ----
  const triggers: Trigger[] = [];
  if (direction !== "neutral") {
    if (p.confirmation && !p.alreadyConfirmed) triggers.push({ price: p.confirmation.price, condition: p.confirmation.rule, newAction: timing === "BUY NOW" ? "Adds confirmation; keep position" : "Upgrade to BUY NOW (re-run analysis)" });
    if (p.dipZone && p.extended) triggers.push({ price: direction === "bullish" ? p.dipZone.high : p.dipZone.low, condition: `Pullback into ${p.dipZone.low.toFixed(2)}-${p.dipZone.high.toFixed(2)} that holds`, newAction: "Better entry: re-run analysis" });
    if (p.invalidation) triggers.push({ price: p.invalidation.price, condition: p.invalidation.rule, newAction: "Thesis invalid: exit / NO TRADE" });
  } else if (p.confirmation) {
    triggers.push({ price: p.confirmation.price, condition: p.confirmation.rule, newAction: "Directional setup emerges: re-run analysis" });
  }
  if (i.earnings.date) triggers.push({ price: null, condition: `Earnings ${i.earnings.date}`, newAction: "Re-evaluate after the report; IV will reset" });
  if (i.options?.iv30) triggers.push({ price: null, condition: `30-day IV moves above ${(i.options.iv30 * 1.2 * 100).toFixed(0)}% or below ${(i.options.iv30 * 0.8 * 100).toFixed(0)}%`, newAction: "Re-price strategies (spread vs long option choice changes)" });

  // ---- scenarios ----
  const H = Math.max(5, i.holdingDays);
  const vol = i.options?.iv30 ?? i.stats.hv20 ?? 0.35;
  const sH = vol * Math.sqrt(H / 365);
  const S = i.spot;
  const hist = empiricalReturns(i.dailyCloses, Math.max(1, Math.round((H * 252) / 365)));
  const freq = (lo: number, hi: number) => (hist.effective >= 8 ? hist.rets.filter((x) => { const v = S * Math.exp(x); return v >= lo && v < hi; }).length / hist.rets.length : null);
  const t1 = p.targets[0]?.price;
  const bullHigh = Math.max(S * (1 + 1.5 * sH), direction === "bullish" && t1 ? t1 : 0);
  const bearLow = Math.min(S * (1 - 1.5 * sH), direction === "bearish" && t1 ? t1 : Infinity);
  const ass = `Over ${H} calendar days, ${(vol * 100).toFixed(0)}% annualized ${i.options?.iv30 ? "implied" : "realized"} volatility (1 sigma = ${pct(sH)}), zero drift. Frequency = share of the stock's own de-meaned historical ${H}-day moves landing in the range.`;
  const scenarios: Scenario[] = [
    { name: "Bull", low: S * (1 + 0.5 * sH), high: bullHigh, historicalFrequency: freq(S * (1 + 0.5 * sH), Infinity), assumptions: ass, drivers: (direction === "bullish" ? i.news.aiCatalysts : []).slice(0, 3).concat(p.direction === "bullish" && p.confirmation ? [`Break of ${p.confirmation.price.toFixed(2)}`] : []) },
    { name: "Base", low: S * (1 - 0.5 * sH), high: S * (1 + 0.5 * sH), historicalFrequency: freq(S * (1 - 0.5 * sH), S * (1 + 0.5 * sH)), assumptions: ass, drivers: ["Range-bound trade; time decay erodes long premium"] },
    { name: "Bear", low: bearLow, high: S * (1 - 0.5 * sH), historicalFrequency: freq(0, S * (1 - 0.5 * sH)), assumptions: ass, drivers: i.news.aiRisks.slice(0, 3).concat(p.invalidation && direction === "bullish" ? [`Loss of ${p.invalidation.price.toFixed(2)}`] : []) },
  ];

  // ---- narrative ----
  const support = avail.filter((c) => Math.sign(c.score as number) === sgn && Math.abs(c.score as number) > 0.1).sort((a, b) => b.weight * Math.abs(b.score!) - a.weight * Math.abs(a.score!));
  const oppose = avail.filter((c) => Math.sign(c.score as number) === -sgn && Math.abs(c.score as number) > 0.1);
  const bestS = best;
  const whatToConsider =
    verdict === "NO TRADE"
      ? `Stand aside on ${direction === "neutral" ? "a directional options trade" : "this setup"}. ${verdictDetail}`
      : verdict === "WAIT"
        ? `Do not enter yet. ${timingReason}${bestS ? ` If the trigger hits, the leading candidate is the ${bestS.name}, re-priced at that time.` : ""}`
        : `Consider the ${bestS?.name ?? "selected structure"} at a limit near $${bestS?.limitPrice.toFixed(2)} per share ($${bestS ? (bestS.limitPrice * 100).toFixed(0) : "-"} per unit), sized by the risk panel.`;
  const whyItCouldFail = [
    ...oppose.map((c) => `${c.label} points the other way: ${c.detail}`),
    ...i.tech.conflicts,
    ...(bestS?.warnings ?? []),
    "Options can lose money even when direction is right: if the move is too small, too slow (theta), or implied volatility falls (vega).",
    ...i.dataGaps.map((g) => `Data gap: ${g}`),
  ];
  const enterNowOrWait =
    timing === "BUY NOW" ? `Entering now is reasonable. ${timingReason}` : `${timing}. ${timingReason}`;
  return {
    direction, composite, conviction, convictionExplanation, components: comps, penalties, verdict, verdictDetail, timing, timingReason,
    preferred, preferredReason, triggers, scenarios,
    narrative: {
      whatToConsider,
      whyItMakesSense: support.length ? support.map((c) => `${c.label}: ${c.detail}`) : ["No component provides a clear edge."],
      whyItCouldFail,
      enterNowOrWait,
      whatChangesMyMind: triggers.map((t) => `${t.condition}${t.price != null ? ` (${t.price.toFixed(2)})` : ""} -> ${t.newAction}`),
      betterRiskAdjusted: preferredReason,
    },
    outlook: direction === "bullish" ? "Bullish" : direction === "bearish" ? "Bearish" : "Neutral",
  };
}
