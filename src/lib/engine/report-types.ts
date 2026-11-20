// Report shape shared by the server pipeline and the client dashboard (type-only imports).
import type { Bar, DataNote, MarketClock, Quote, SourceRef } from "../types";
import type { DailyStats, Gap, KeyLevel, RelStrength, TimeframeSignal, TradePlan } from "../quant/technical";
import type { OptionsAnalytics } from "../quant/options";
import type { StrategySelection } from "../quant/strategies";
import type { SizingResult, RiskProfile } from "../quant/risk";
import type { EarningsReaction, ModelPricedBacktest, StudyResult } from "../quant/backtest";
import type { Decision } from "./decision";
import type { NewsReport } from "../news/analyze";

export interface FilingRef { form: string; filingDate: string; acceptedAt: string | null; description: string; url: string; significance: string }

export interface Report {
  ticker: string;
  company: string;
  generatedAt: number;
  analysisId: number | null;
  riskFreeRate: number;
  riskProfile: RiskProfile;
  market: {
    clock: MarketClock;
    quote: Quote | null;
    quoteSource: string | null;
    quoteFetchedAt: number | null;
    executable: boolean;
    executableNote: string;
    lastSession: string;
  };
  profile: { name: string; industry: string | null; marketCap: number | null; exchange: string | null; web: string | null; sectorEtf: string | null } | null;
  fundamentals: { metrics: Record<string, number | null>; analyst: { detail: string; latest: { period: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number } | null }; insider: { detail: string; buys: number; sells: number; buyValue: number; sellValue: number; recent: { name: string; date: string; code: string; shares: number; price: number }[] }; upgrades: { date: string; company: string; action: string; from: string; to: string }[] | null };
  technical: {
    timeframes: TimeframeSignal[];
    combined: { score: number; trend: "bullish" | "bearish" | "neutral"; conflicts: string[]; coverage: number };
    stats: DailyStats | null;
    levels: { supports: KeyLevel[]; resistances: KeyLevel[] };
    plan: TradePlan | null;
    breakout: { state: "breakout" | "breakdown" | "inside"; detail: string } | null;
    gaps: { todayGapPct: number | null; gaps: Gap[] };
    rel: RelStrength;
    chart: Record<string, Bar[]>;
  };
  options: OptionsAnalytics | null;
  chainsMeta: { expirationsAvailable: number; fetched: string[]; fetchedAt: number | null; source: string | null };
  strategies: StrategySelection;
  sizing: { conservative: SizingResult | null; aggressive: SizingResult | null };
  backtest: { horizonDays: number; similar: StudyResult | null; breakout: StudyResult | null; modelSpread: ModelPricedBacktest | null; earnings: { reactions: EarningsReaction[]; avgAbsMove: number | null; medianAbsMove: number | null; impliedMove: number | null; comparison: string } | null };
  news: NewsReport;
  filings: FilingRef[];
  catalyst: { label: string; date: string | null; detail: string } | null;
  decision: Decision;
  dataNotes: DataNote[];
  sources: SourceRef[];
  timingsMs: Record<string, number>;
}

export type ProgressEvent =
  | { type: "progress"; step: string; status: "running" | "done" | "skipped" | "error"; detail?: string }
  | { type: "report"; report: Report }
  | { type: "error"; message: string };
