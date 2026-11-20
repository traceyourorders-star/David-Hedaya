import { config } from "../config";
import { ProviderError } from "../http";
import * as tradier from "../providers/tradier";
import * as fh from "../providers/finnhub";
import * as edgar from "../providers/edgar";
import { ivHistory, recordIv, saveAnalysis } from "../db";
import type { Bar, DataNote, MarketClock, OptionContract, Quote, SourceRef } from "../types";
import { addDays, daysBetween, etDate, lastSessionDate, localClock } from "../market-time";
import { aggregate } from "../quant/indicators";
import {
  breakoutState, combineTimeframes, dailyStats, gapAnalysis, keyLevels, relativeStrength, scoreTimeframe, tradePlan, type TimeframeSignal,
} from "../quant/technical";
import { analyzeOptions } from "../quant/options";
import { buildStrategies, type StrategySelection } from "../quant/strategies";
import { sizePosition, type RiskProfile } from "../quant/risk";
import { breakoutStudy, earningsReactions, modelPricedSpreadBacktest, similarSetupStudy } from "../quant/backtest";
import { aiAnalyze, bucketOf, dedupe, isMacro, moveSince, type NewsCluster, type NewsItem, type NewsReport } from "../news/analyze";
import { decide } from "./decision";
import type { FilingRef, ProgressEvent, Report } from "./report-types";

type Emit = (e: ProgressEvent) => void;

const SECTOR_ETF: [RegExp, string][] = [
  [/semiconductor/i, "SMH"],
  [/technology|software|internet|it services|electronic|communications equipment/i, "XLK"],
  [/bank|financ|insurance|capital markets/i, "XLF"],
  [/biotech/i, "XBI"],
  [/pharma|health|medical|life sciences/i, "XLV"],
  [/oil|gas|energy/i, "XLE"],
  [/retail/i, "XRT"],
  [/media|telecom|entertainment|communication/i, "XLC"],
  [/auto|hotel|restaurant|leisure|consumer.*discretionary|textiles|apparel/i, "XLY"],
  [/food|beverage|tobacco|consumer products|household/i, "XLP"],
  [/utilit/i, "XLU"],
  [/real estate|reit/i, "XLRE"],
  [/aerospace|defense|industrial|machinery|airline|logistics|transport|construction|electrical equipment/i, "XLI"],
  [/chemical|metal|mining|materials|paper|packaging/i, "XLB"],
];

const FILING_SIGNIFICANCE: Record<string, string> = {
  "8-K": "Material event (results, guidance, M&A, leadership change, etc.)",
  "10-Q": "Quarterly report", "10-K": "Annual report", "4": "Insider transaction (Form 4)",
  "SC 13G": "Passive >5% ownership", "SC 13D": "Active >5% ownership (potential activism)", "SC 13G/A": "Ownership update", "SC 13D/A": "Activist ownership update",
  "S-3": "Shelf registration (potential share issuance / dilution)", "424B5": "Prospectus supplement (securities offering)", "DEF 14A": "Proxy statement",
  "13F-HR": "Institutional holdings report", "144": "Proposed sale of restricted stock by an insider",
};

export async function runResearch(rawTicker: string, risk: RiskProfile, emit: Emit, force = true): Promise<Report> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const notes: DataNote[] = [];
  const sources: SourceRef[] = [];
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) throw new Error("Invalid ticker symbol");

  const step = async <T>(name: string, fn: () => Promise<T>, fallback: T, area?: string): Promise<T> => {
    const s = Date.now();
    emit({ type: "progress", step: name, status: "running" });
    try {
      const v = await fn();
      emit({ type: "progress", step: name, status: "done" });
      return v;
    } catch (e) {
      const pe = e instanceof ProviderError ? e : null;
      const status = pe?.kind === "not_configured" ? "skipped" : "error";
      emit({ type: "progress", step: name, status, detail: (e as Error).message });
      notes.push({ area: area ?? name, status: "unavailable", detail: (e as Error).message, fix: pe?.kind === "not_configured" ? "Add the API key in .env.local (see README)." : pe?.kind === "plan" ? "Requires a higher provider plan." : undefined });
      return fallback;
    } finally {
      timings[name] = Date.now() - s;
    }
  };

  const now = Date.now();
  const today = etDate(now);
  const session = lastSessionDate(now);

  // ---- 1. Market clock & quote ----
  const clock: MarketClock = await step("Market clock", async () => (await tradier.getClock(force)).data, localClock(now), "Market clock");
  const quoteRes = await step("Live quote", () => tradier.getQuotes([ticker], force), null, "Quote");
  const quote: Quote | null = quoteRes?.data[0] ?? null;
  if (quoteRes && !quote) throw new Error(`No quote returned for ${ticker}. Check the symbol.`);
  const spot = quote?.last ?? (quote?.bid && quote?.ask ? (quote.bid + quote.ask) / 2 : null);
  const marketOpen = clock.state === "open";
  const quoteAge = quote?.tradeTime ? now - quote.tradeTime : null;
  const executable = marketOpen && config.tradierEnv === "production" && quoteAge != null && quoteAge < 120_000;
  const executableNote = !quote
    ? "No market data connected: nothing on this page is a live quote."
    : !marketOpen
      ? `Market is ${clock.state}. Prices are from the last session (${session}) or extended hours and are NOT executable quotes.`
      : config.tradierEnv !== "production"
        ? "Sandbox market data is delayed ~15 minutes. Prices are indicative only; confirm the live bid/ask at your broker."
        : quoteAge != null && quoteAge >= 120_000
          ? `Last trade is ${Math.round(quoteAge / 60000)} min old; quotes may be stale.`
          : "Real-time quote during regular trading hours. Still use limit orders.";

  // ---- 2. Profile / fundamentals (Finnhub) ----
  const prof = await step("Company profile", async () => (await fh.profile(ticker)).data, null, "Company profile");
  const industry = prof?.finnhubIndustry ?? null;
  const sectorEtf = industry ? SECTOR_ETF.find(([re]) => re.test(industry))?.[1] ?? null : null;

  // ---- 3. Price history ----
  const [daily, weekly, monthly, spyDaily, sectorDaily, m1, m5, m15] = await Promise.all([
    step("Daily bars (3y)", async () => (await tradier.getHistory(ticker, "daily", addDays(today, -3 * 365 - 30), force)).data, [] as Bar[], "Daily price history"),
    step("Weekly bars (5y)", async () => (await tradier.getHistory(ticker, "weekly", addDays(today, -5 * 365))).data, [] as Bar[], "Weekly price history"),
    step("Monthly bars (10y)", async () => (await tradier.getHistory(ticker, "monthly", addDays(today, -10 * 365))).data, [] as Bar[], "Monthly price history"),
    step("SPY benchmark", async () => (await tradier.getHistory("SPY", "daily", addDays(today, -400))).data, [] as Bar[], "SPY benchmark"),
    sectorEtf ? step(`Sector ETF ${sectorEtf}`, async () => (await tradier.getHistory(sectorEtf, "daily", addDays(today, -400))).data, [] as Bar[], "Sector benchmark") : Promise.resolve([] as Bar[]),
    step("1-minute bars", async () => (await tradier.getIntraday(ticker, "1min", `${session} 09:30`, force)).data, [] as Bar[], "1-minute bars"),
    step("5-minute bars", async () => (await tradier.getIntraday(ticker, "5min", `${addDays(session, -6)} 09:30`, force)).data, [] as Bar[], "5-minute bars"),
    step("15-minute bars", async () => (await tradier.getIntraday(ticker, "15min", `${addDays(session, -30)} 09:30`, force)).data, [] as Bar[], "15-minute bars"),
  ]);
  const h1 = aggregate(m15, 4);

  // ---- 4. Technical analysis ----
  const tfs: TimeframeSignal[] = [
    scoreTimeframe("1m", m1), scoreTimeframe("5m", m5), scoreTimeframe("15m", m15), scoreTimeframe("1h", h1),
    scoreTimeframe("1D", daily), scoreTimeframe("1W", weekly), scoreTimeframe("1M", monthly),
  ];
  const combined = combineTimeframes(tfs);
  // Use the live price as the last close for level/plan calculations when it is newer than the last daily bar
  const dailyForCalc = daily.length && spot && daily[daily.length - 1].date < session
    ? [...daily, { t: Date.parse(`${session}T00:00:00Z`), date: session, o: quote?.open ?? spot, h: quote?.high ?? spot, l: quote?.low ?? spot, c: spot, v: quote?.volume ?? 0 }]
    : daily.length && spot ? [...daily.slice(0, -1), { ...daily[daily.length - 1], c: spot, h: Math.max(daily[daily.length - 1].h, spot), l: Math.min(daily[daily.length - 1].l, spot) }] : daily;
  const stats = dailyForCalc.length >= 60 ? dailyStats(dailyForCalc) : null;
  if (!stats) notes.push({ area: "Technical analysis", status: "unavailable", detail: "Fewer than 60 daily bars available.", fix: "Connect Tradier (TRADIER_TOKEN)." });
  const levels = stats ? keyLevels(dailyForCalc, stats) : { supports: [], resistances: [] };
  const rel = relativeStrength(dailyForCalc, spyDaily.length ? spyDaily : null, sectorDaily.length ? sectorDaily : null, sectorEtf);
  const breakout = stats ? breakoutState(dailyForCalc, stats) : null;
  const gaps = dailyForCalc.length > 2 ? gapAnalysis(dailyForCalc) : { todayGapPct: null, gaps: [] };

  // ---- 5. Fundamentals, analysts, insiders, earnings ----
  const [metricsR, recs, ins, earnCal, upg] = await Promise.all([
    step("Fundamental metrics", async () => (await fh.metrics(ticker)).data.metric ?? {}, {} as Record<string, number | null>, "Fundamentals"),
    step("Analyst recommendations", async () => (await fh.recommendations(ticker)).data, [] as fh.FhRecommendation[], "Analyst recommendations"),
    step("Insider transactions", async () => (await fh.insiders(ticker, addDays(today, -90))).data, [] as fh.FhInsider[], "Insider transactions"),
    step("Earnings calendar", async () => (await fh.earningsCalendar(ticker, addDays(today, -3 * 365), addDays(today, 120))).data, [] as fh.FhEarningsCal[], "Earnings calendar"),
    step("Analyst upgrades/downgrades", async () => (await fh.upgrades(ticker, addDays(today, -90))).data, null as fh.FhUpgrade[] | null, "Upgrades/downgrades"),
  ]);
  const latestRec = recs[0] ?? null;
  let analystScore: number | null = null, analystDetail = "Analyst data unavailable.";
  if (latestRec) {
    const tot = latestRec.strongBuy + latestRec.buy + latestRec.hold + latestRec.sell + latestRec.strongSell;
    if (tot) {
      const lvl = (latestRec.strongBuy * 2 + latestRec.buy - latestRec.sell - latestRec.strongSell * 2) / (2 * tot);
      const prev = recs[3];
      const prevLvl = prev ? (prev.strongBuy * 2 + prev.buy - prev.sell - prev.strongSell * 2) / (2 * Math.max(1, prev.strongBuy + prev.buy + prev.hold + prev.sell + prev.strongSell)) : lvl;
      analystScore = Math.max(-1, Math.min(1, (lvl - 0.3) * 2 + (lvl - prevLvl) * 4));
      analystDetail = `Consensus (${latestRec.period}): ${latestRec.strongBuy + latestRec.buy} buy / ${latestRec.hold} hold / ${latestRec.sell + latestRec.strongSell} sell; ${lvl > prevLvl + 0.02 ? "improving" : lvl < prevLvl - 0.02 ? "deteriorating" : "stable"} vs 3 months ago. Sell-side ratings skew bullish, so the score is centred on a typical mix.`;
    }
  }
  const buys = ins.filter((x) => x.transactionCode === "P"), sells = ins.filter((x) => x.transactionCode === "S");
  const buyValue = buys.reduce((s, x) => s + Math.abs(x.change) * (x.transactionPrice || 0), 0);
  const sellValue = sells.reduce((s, x) => s + Math.abs(x.change) * (x.transactionPrice || 0), 0);
  const insiderScore = ins.length ? (buys.length ? Math.min(1, 0.3 + buys.length * 0.15) : sellValue > 25e6 ? -0.3 : sellValue > 0 ? -0.1 : 0) : null;
  const insiderDetail = ins.length
    ? `90-day insider activity: ${buys.length} open-market purchase(s) ($${(buyValue / 1e6).toFixed(2)}M), ${sells.length} sale(s) ($${(sellValue / 1e6).toFixed(2)}M). Sales are often planned (10b5-1) and weakly informative; purchases are more meaningful.`
    : "No insider transactions in 90 days (or data unavailable).";

  const future = earnCal.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const nextEarn = future[0] ?? null;
  const pastEarn = earnCal.filter((e) => e.date < today && e.epsActual != null);
  const earningsDaysAway = nextEarn ? daysBetween(today, nextEarn.date) : null;

  // ---- 6. Options chain ----
  const expirations = await step("Option expirations", async () => (await tradier.getExpirations(ticker, force)).data, [] as string[], "Option expirations");
  const dteByExp: Record<string, number> = {};
  for (const e of expirations) dteByExp[e] = daysBetween(today, e);
  const pickExps = (() => {
    const inRange = expirations.filter((e) => dteByExp[e] >= 1 && dteByExp[e] <= 130);
    if (inRange.length <= 9) return inRange;
    const want = [3, 7, 14, 21, 30, 45, 60, 90, 120];
    const set = new Set<string>();
    for (const w of want) {
      const best = inRange.reduce((a, b) => (Math.abs(dteByExp[b] - w) < Math.abs(dteByExp[a] - w) ? b : a));
      set.add(best);
    }
    return [...set].sort();
  })();
  const chains: Record<string, OptionContract[]> = {};
  let chainFetchedAt: number | null = null, chainSource: string | null = null;
  if (pickExps.length) {
    await step(`Option chains (${pickExps.length} expirations)`, async () => {
      const res = await Promise.all(pickExps.map((e) => tradier.getChain(ticker, e, force)));
      res.forEach((r, k) => {
        chains[pickExps[k]] = r.data;
        chainFetchedAt = Math.max(chainFetchedAt ?? 0, r.fetchedAt);
        chainSource = r.source;
      });
    }, undefined, "Option chains");
  } else if (quote) {
    notes.push({ area: "Option chains", status: "unavailable", detail: "No listed option expirations found for this symbol." });
  }
  const r = config.riskFreeRate;
  const hist = ivHistory(ticker, addDays(today, -400)).filter((x) => x.date < session).map((x) => x.atm_iv);
  const options = spot && Object.keys(chains).length ? analyzeOptions(chains, dteByExp, spot, r, stats?.hv20 ?? null, hist) : null;
  if (options?.iv30 && quote) {
    try { recordIv(ticker, session, options.iv30, "ATM IV interpolated to 30d from chain"); } catch { /* ignore */ }
  }

  // ---- 7. News, filings ----
  const [compNews, mktNews, filings] = await Promise.all([
    step("Company news (30d)", async () => (await fh.companyNews(ticker, addDays(today, -30), today, force)).data, [] as fh.FhNews[], "Company news"),
    step("Market & macro news", async () => (await fh.marketNews(force)).data, [] as fh.FhNews[], "Market news"),
    step("SEC EDGAR filings (30d)", async () => (await edgar.recentFilings(ticker, addDays(today, -30))).data, [] as edgar.Filing[], "SEC filings"),
  ]);
  const items: NewsItem[] = [
    ...compNews.map((n) => ({ headline: n.headline, summary: n.summary, source: n.source, url: n.url, publishedAt: n.datetime * 1000, kind: "company" as const, provider: "Finnhub" })),
    ...filings.filter((f) => ["8-K", "SC 13D", "SC 13D/A", "S-3", "424B5", "10-Q", "10-K"].includes(f.form)).map((f) => ({
      headline: `${f.form}: ${f.description}`, summary: FILING_SIGNIFICANCE[f.form] ?? "", source: "SEC EDGAR", url: f.url,
      publishedAt: f.acceptedAt ? Date.parse(f.acceptedAt) : Date.parse(`${f.filingDate}T12:00:00Z`), kind: "filing" as const, provider: "SEC EDGAR",
    })),
  ];
  const clusters: NewsCluster[] = dedupe(items).map((c) => ({ ...c, bucket: bucketOf(c.firstReported, now), priceMoveSince: moveSince(c.firstReported, daily, spot) }));
  clusters.sort((a, b) => b.firstReported - a.firstReported);
  const macroClusters = dedupe(
    mktNews.filter((n) => isMacro(`${n.headline} ${n.summary}`) && now - n.datetime * 1000 < 3 * 86_400_000)
      .map((n) => ({ headline: n.headline, summary: n.summary, source: n.source, url: n.url, publishedAt: n.datetime * 1000, kind: "market" as const, provider: "Finnhub" })),
  ).map((c) => ({ ...c, bucket: bucketOf(c.firstReported, now) })).sort((a, b) => b.firstReported - a.firstReported).slice(0, 12);

  // macro clusters were numbered independently; give them their own id space before AI analysis
  macroClusters.forEach((c, k) => (c.id = `m${k + 1}`));

  const ctx = `Price ${spot?.toFixed(2) ?? "n/a"} (${quote?.changePct?.toFixed(2) ?? "n/a"}% today); 20d return ${stats?.ret20d != null ? (stats.ret20d * 100).toFixed(1) + "%" : "n/a"}; technical trend ${combined.trend}; 30d IV ${options?.iv30 ? (options.iv30 * 100).toFixed(1) + "%" : "n/a"}; next earnings ${nextEarn?.date ?? "unknown"}.`;
  const ai = await step("AI news analysis (Claude)", async () => {
    if (!config.anthropicKey) throw new ProviderError("Anthropic", "not_configured", "ANTHROPIC_API_KEY not set; lexicon heuristic used instead");
    const res = await aiAnalyze(ticker, prof?.name ?? ticker, [...clusters.slice(0, 32), ...macroClusters.slice(0, 8)], ctx);
    if (res.error && config.anthropicKey) throw new Error(res.error);
    return res;
  }, { out: null, model: null, error: config.anthropicKey ? "failed" : "ANTHROPIC_API_KEY not set" }, "AI news analysis");
  if (ai.out) {
    const byId = new Map(ai.out.items.map((x) => [x.id, x]));
    for (const c of [...clusters, ...macroClusters]) {
      const a = byId.get(c.id);
      if (a) c.ai = { impact: a.impact, magnitude: Math.max(1, Math.min(5, a.magnitude)), verification: a.verification, pricedIn: a.priced_in, eventDate: a.event_date, explanation: a.explanation, optionsImplication: a.options_implication };
    }
  }

  const recent = clusters.filter((c) => c.bucket !== "older");
  let newsScore: number | null = null, newsLabel: NewsReport["sentiment"]["label"] = "Unavailable", method = "No news provider connected.";
  if (recent.length) {
    let num = 0, den = 0;
    for (const c of recent) {
      const w = (c.bucket === "today" ? 3 : c.bucket === "24h" ? 2.5 : c.bucket === "7d" ? 1.5 : 0.7) * (c.ai ? c.ai.magnitude / 2 : 1) * (c.ai?.verification === "rumor" || c.ai?.verification === "speculation" ? 0.5 : 1) * (c.ai?.pricedIn === "likely" ? 0.5 : 1);
      const s = c.ai ? (c.ai.impact === "bullish" ? 1 : c.ai.impact === "bearish" ? -1 : 0) : c.lexiconScore;
      num += w * s; den += w;
    }
    newsScore = den ? num / den : 0;
    const pos = recent.filter((c) => (c.ai ? c.ai.impact === "bullish" : c.lexiconScore > 0.2)).length;
    const neg = recent.filter((c) => (c.ai ? c.ai.impact === "bearish" : c.lexiconScore < -0.2)).length;
    newsLabel = newsScore > 0.2 ? "Positive" : newsScore < -0.2 ? "Negative" : pos && neg ? "Mixed" : "Neutral";
    method = ai.out
      ? `Claude (${ai.model}) per-story impact, weighted by recency, magnitude, verification and priced-in assessment.`
      : "Keyword lexicon heuristic weighted by recency (Claude analysis not available). Treat as a rough signal only.";
  }
  const news: NewsReport = {
    clusters, macro: macroClusters,
    counts: {
      today: clusters.filter((c) => c.bucket === "today").length,
      h24: clusters.filter((c) => c.bucket === "today" || c.bucket === "24h").length,
      d7: clusters.filter((c) => ["today", "24h", "7d"].includes(c.bucket)).length,
      d30: recent.length,
      rawItems: items.length,
      deduplicated: clusters.length,
    },
    sentiment: { label: newsLabel, score: newsScore, method },
    ai: {
      available: !!ai.out, model: ai.model, summary: ai.out?.summary ?? null, keyRisks: ai.out?.key_risks ?? [], catalysts: ai.out?.catalysts ?? [],
      note: ai.out ? "Generated from the listed headlines and summaries only; full article text was not read." : `AI analysis unavailable: ${ai.error}.`,
    },
    coverage: [
      { provider: "Finnhub company news", status: config.finnhubKey ? "ok" : "unavailable", detail: `${compNews.length} articles (30 days) from ${new Set(compNews.map((n) => n.source)).size} outlets` },
      { provider: "Finnhub market news", status: config.finnhubKey ? "ok" : "unavailable", detail: `${mktNews.length} general headlines scanned for macro/Fed/geopolitical keywords` },
      { provider: "SEC EDGAR", status: config.secUserAgent ? "ok" : "unavailable", detail: `${filings.length} filings in 30 days` },
    ],
    notConnected: [
      { name: "Reddit", howToConnect: "Requires a Reddit API app (OAuth client id/secret) under Reddit's Data API terms. Not connected; no social sentiment is inferred." },
      { name: "X (Twitter)", howToConnect: "Requires a paid X API plan with search access. Not connected." },
      { name: "Bloomberg / Reuters / WSJ full text", howToConnect: "Licensed feeds (Bloomberg B-PIPE/Terminal, Refinitiv, Dow Jones Newswires). Headlines from these outlets appear only when Finnhub's aggregator carries them." },
    ],
  };
  for (const c of clusters.slice(0, 25)) sources.push({ title: c.headline, url: c.sources[0].url, source: c.sources[0].source, publishedAt: c.firstReported });

  // ---- 8. Plan, strategies, backtests, decision ----
  const prelimDirection = combined.trend;
  const plan0 = stats ? tradePlan(prelimDirection, stats, levels) : null;
  const horizon = Math.max(3, Math.round((risk.holdingDays * 252) / 365));
  const btBars = dailyForCalc;
  const earningsStudy = pastEarn.length && btBars.length
    ? earningsReactions(btBars, pastEarn.map((e) => ({ date: e.date, hour: e.hour })))
    : null;

  // decision depends on strategies and strategies depend on direction: run decision once with prelim strategies,
  // then rebuild strategies for the final direction if it differs.
  const mkStrategies = (dir: "bullish" | "bearish" | "neutral", plan: typeof plan0): StrategySelection =>
    spot && options
      ? buildStrategies({
          chains, dteByExp, spot, r, direction: dir, targets: plan?.targets ?? [], invalidation: plan?.invalidation ?? null,
          dailyCloses: daily.map((b) => b.c), oneSigmaPct30: options.iv30 ? options.iv30 * Math.sqrt(30 / 365) : null,
          ivRich: options.pricing.verdict === "rich", commissionPerContract: risk.commissionPerContract, holdingDays: risk.holdingDays,
          earningsDate: nextEarn?.date ?? null, today,
          maxLossBudget: Math.min(risk.budget * risk.maxRiskPct, risk.maxLossDollars > 0 ? risk.maxLossDollars : Infinity),
        })
      : { conservative: null, aggressive: null, alternatives: { conservative: [], aggressive: [] }, evaluated: 0, rejectedIlliquid: 0, notes: ["No option chain data."] };

  const dataGaps = notes.map((n) => `${n.area}: ${n.detail}`);
  const baseInputs = {
    spot: spot ?? 0, marketOpen, quotesExecutable: executable,
    tech: combined, stats: stats!, breakout: breakout ?? { state: "inside" as const, detail: "n/a" }, rel,
    news: { score: newsScore, label: newsLabel, count: recent.length, aiRisks: news.ai.keyRisks, aiCatalysts: news.ai.catalysts },
    analyst: { score: analystScore, detail: analystDetail }, insider: { score: insiderScore, detail: insiderDetail },
    options, earnings: { date: nextEarn?.date ?? null, daysAway: earningsDaysAway, hour: nextEarn?.hour ?? null },
    holdingDays: risk.holdingDays, dailyCloses: daily.map((b) => b.c), dataGaps,
  };

  let decision;
  let strategies: StrategySelection;
  let plan = plan0;
  if (!stats || !spot) {
    strategies = mkStrategies("neutral", null);
    decision = decide({
      ...baseInputs,
      stats: stats ?? ({ close: spot ?? 0, atr14: null, atrPct: null, hv20: null, ret20d: null, high20: 0, low20: 0 } as unknown as NonNullable<typeof stats>),
      plan: { direction: "neutral", confirmation: null, invalidation: null, targets: [], dipZone: null, extended: false, extendedReason: null, nearTrigger: false, alreadyConfirmed: false },
      strategies,
    });
  } else {
    strategies = mkStrategies(prelimDirection, plan0);
    decision = decide({ ...baseInputs, plan: plan0!, strategies });
    if (decision.direction !== prelimDirection) {
      plan = tradePlan(decision.direction, stats, levels);
      strategies = mkStrategies(decision.direction, plan);
      decision = decide({ ...baseInputs, plan, strategies });
    }
  }
  emit({ type: "progress", step: "Strategy construction & decision", status: "done", detail: `${strategies.evaluated} structures evaluated` });

  const btDir = decision.direction === "neutral" ? (combined.score >= 0 ? "bullish" : "bearish") : decision.direction;
  const backtest = {
    horizonDays: horizon,
    similar: btBars.length >= 300 ? similarSetupStudy(btBars, horizon, btDir) : null,
    breakout: btBars.length >= 300 ? breakoutStudy(btBars, horizon, btDir === "bearish" ? "breakdown" : "breakout") : null,
    modelSpread: btBars.length >= 300 ? modelPricedSpreadBacktest(btBars, btDir, horizon, r, options?.ivHvRatio ?? 1.1, { feePerContract: risk.commissionPerContract }) : null,
    earnings: earningsStudy
      ? (() => {
          const exp = nextEarn ? options?.expiries.find((e) => e.expiration >= nextEarn.date) : null;
          const implied = exp?.impliedMovePct ?? null;
          return {
            ...earningsStudy,
            impliedMove: implied,
            comparison: implied != null && earningsStudy.avgAbsMove != null
              ? `The ${exp!.expiration} straddle prices a ${(implied * 100).toFixed(1)}% move (includes non-earnings days) vs an average historical earnings reaction of ${(earningsStudy.avgAbsMove * 100).toFixed(1)}% over ${earningsStudy.reactions.length} reports. ${implied > earningsStudy.avgAbsMove * 1.15 ? "Options look expensive into the event: long premium needs an unusually large move." : implied < earningsStudy.avgAbsMove * 0.85 ? "Options look cheap relative to history." : "Roughly in line with history."}`
              : "Implied earnings move unavailable (no expiry after the report in the fetched chains, or no upcoming date).",
          };
        })()
      : null,
  };
  if (!earningsStudy) notes.push({ area: "Earnings history", status: "unavailable", detail: "No past earnings dates available (Finnhub earnings calendar)." });

  const sizing = {
    conservative: strategies.conservative ? sizePosition(risk, strategies.conservative.maxLossPerUnit, strategies.conservative.exitSlippagePerUnit, strategies.conservative.limitPrice * 100) : null,
    aggressive: strategies.aggressive ? sizePosition(risk, strategies.aggressive.maxLossPerUnit, strategies.aggressive.exitSlippagePerUnit, strategies.aggressive.limitPrice * 100) : null,
  };

  const filingRefs: FilingRef[] = filings.slice(0, 30).map((f) => ({ form: f.form, filingDate: f.filingDate, acceptedAt: f.acceptedAt, description: f.description, url: f.url, significance: FILING_SIGNIFICANCE[f.form] ?? "" }));
  const catalyst = nextEarn
    ? { label: "Earnings report", date: nextEarn.date, detail: `${nextEarn.hour === "bmo" ? "Before open" : nextEarn.hour === "amc" ? "After close" : "Time TBD"}; EPS est. ${nextEarn.epsEstimate ?? "n/a"}; in ${earningsDaysAway} day(s).` }
    : news.ai.catalysts[0] ? { label: news.ai.catalysts[0], date: null, detail: "From AI news analysis (date not confirmed)." } : null;

  // Chart payload (trimmed)
  const chart: Record<string, Bar[]> = { "1D": daily.slice(-500), "1W": weekly.slice(-260), "1M": monthly.slice(-120), "1h": h1.slice(-200), "15m": m15.slice(-300), "5m": m5.slice(-400), "1m": m1.slice(-400) };

  if (quote) sources.unshift({ title: `${ticker} quote, bars and option chains`, url: "https://documentation.tradier.com/brokerage-api/markets/get-quotes", source: quoteRes!.source });
  if (prof?.weburl) sources.push({ title: `${prof.name} investor website`, url: prof.weburl, source: "Company" });
  for (const f of filingRefs.slice(0, 5)) sources.push({ title: `${f.form} ${f.description} (${f.filingDate})`, url: f.url, source: "SEC EDGAR" });

  const report: Report = {
    ticker,
    company: prof?.name ?? quote?.description ?? ticker,
    generatedAt: Date.now(),
    analysisId: null,
    riskFreeRate: r,
    riskProfile: risk,
    market: { clock, quote, quoteSource: quoteRes?.source ?? null, quoteFetchedAt: quoteRes?.fetchedAt ?? null, executable, executableNote, lastSession: session },
    profile: prof ? { name: prof.name ?? ticker, industry, marketCap: prof.marketCapitalization ?? null, exchange: prof.exchange ?? null, web: prof.weburl ?? null, sectorEtf } : null,
    fundamentals: {
      metrics: pickMetrics(metricsR),
      analyst: { detail: analystDetail, latest: latestRec ? { period: latestRec.period, strongBuy: latestRec.strongBuy, buy: latestRec.buy, hold: latestRec.hold, sell: latestRec.sell, strongSell: latestRec.strongSell } : null },
      insider: { detail: insiderDetail, buys: buys.length, sells: sells.length, buyValue, sellValue, recent: ins.slice(0, 12).map((x) => ({ name: x.name, date: x.transactionDate, code: x.transactionCode, shares: x.change, price: x.transactionPrice })) },
      upgrades: upg ? upg.slice(0, 15).map((u) => ({ date: new Date(u.gradeTime * 1000).toISOString().slice(0, 10), company: u.company, action: u.action, from: u.fromGrade, to: u.toGrade })) : null,
    },
    technical: { timeframes: tfs, combined, stats, levels, plan, breakout, gaps, rel, chart },
    options,
    chainsMeta: { expirationsAvailable: expirations.length, fetched: Object.keys(chains), fetchedAt: chainFetchedAt, source: chainSource },
    strategies,
    sizing,
    backtest,
    news,
    filings: filingRefs,
    catalyst,
    decision,
    dataNotes: notes,
    sources,
    timingsMs: { ...timings, total: Date.now() - t0 },
  };
  try {
    report.analysisId = saveAnalysis(ticker, decision.verdict, decision.conviction, spot, report);
  } catch (e) {
    notes.push({ area: "Research history", status: "unavailable", detail: `Could not save to database: ${(e as Error).message}` });
  }
  return report;
}

function pickMetrics(m: Record<string, number | null>): Record<string, number | null> {
  const keys = ["peTTM", "forwardPE", "psTTM", "pbAnnual", "epsGrowthTTMYoy", "revenueGrowthTTMYoy", "grossMarginTTM", "netProfitMarginTTM", "roeTTM", "totalDebt/totalEquityQuarterly", "beta", "52WeekHigh", "52WeekLow", "10DayAverageTradingVolume", "dividendYieldIndicatedAnnual", "marketCapitalization"];
  const out: Record<string, number | null> = {};
  for (const k of keys) if (k in m) out[k] = m[k];
  return out;
}
