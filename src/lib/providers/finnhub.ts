import { config } from "../config";
import { fetchJson, ProviderError } from "../http";
import { cached, Sourced } from "../cache";

const BASE = config.finnhubBaseOverride || "https://finnhub.io/api/v1";

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  if (!config.finnhubKey) throw new ProviderError("Finnhub", "not_configured", "Finnhub: FINNHUB_API_KEY not set");
  const qs = new URLSearchParams(params).toString();
  return fetchJson<T>("Finnhub", `${BASE}${path}?${qs}`, { headers: { "X-Finnhub-Token": config.finnhubKey } });
}

export interface FhNews { id: number; datetime: number; headline: string; summary: string; source: string; url: string; category: string; related: string }
export interface FhProfile { name?: string; ticker?: string; exchange?: string; finnhubIndustry?: string; marketCapitalization?: number; weburl?: string; logo?: string; ipo?: string; shareOutstanding?: number }
export interface FhRecommendation { period: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }
export interface FhInsider { name: string; share: number; change: number; filingDate: string; transactionDate: string; transactionCode: string; transactionPrice: number }
export interface FhEarningsCal { date: string; epsActual: number | null; epsEstimate: number | null; hour: string; quarter: number; year: number; revenueActual: number | null; revenueEstimate: number | null; symbol: string }
export interface FhUpgrade { symbol: string; gradeTime: number; fromGrade: string; toGrade: string; company: string; action: string }

const S = config.finnhubBaseOverride ? `TEST ENDPOINT ${config.finnhubBaseOverride} (not real news)` : "Finnhub";

export const companyNews = (symbol: string, from: string, to: string, force = false): Promise<Sourced<FhNews[]>> =>
  cached(`fh:news:${symbol}:${from}:${to}`, S, 5 * 60_000, () => get<FhNews[]>("/company-news", { symbol, from, to }), force);

export const marketNews = (force = false): Promise<Sourced<FhNews[]>> =>
  cached("fh:marketnews", S, 5 * 60_000, () => get<FhNews[]>("/news", { category: "general" }), force);

export const profile = (symbol: string): Promise<Sourced<FhProfile>> =>
  cached(`fh:profile:${symbol}`, S, 24 * 3600_000, () => get<FhProfile>("/stock/profile2", { symbol }));

export const metrics = (symbol: string): Promise<Sourced<{ metric: Record<string, number | null> }>> =>
  cached(`fh:metric:${symbol}`, S, 6 * 3600_000, () => get<{ metric: Record<string, number | null> }>("/stock/metric", { symbol, metric: "all" }));

export const recommendations = (symbol: string): Promise<Sourced<FhRecommendation[]>> =>
  cached(`fh:rec:${symbol}`, S, 6 * 3600_000, () => get<FhRecommendation[]>("/stock/recommendation", { symbol }));

export const insiders = (symbol: string, from: string): Promise<Sourced<FhInsider[]>> =>
  cached(`fh:insider:${symbol}:${from}`, S, 3600_000, async () => (await get<{ data: FhInsider[] }>("/stock/insider-transactions", { symbol, from })).data ?? []);

export const earningsCalendar = (symbol: string, from: string, to: string): Promise<Sourced<FhEarningsCal[]>> =>
  cached(`fh:earncal:${symbol}:${from}:${to}`, S, 3600_000, async () =>
    (await get<{ earningsCalendar: FhEarningsCal[] }>("/calendar/earnings", { symbol, from, to })).earningsCalendar ?? []);

export const upgrades = (symbol: string, from: string): Promise<Sourced<FhUpgrade[]>> =>
  cached(`fh:upg:${symbol}:${from}`, S, 3600_000, () => get<FhUpgrade[]>("/stock/upgrade-downgrade", { symbol, from }));

export const peers = (symbol: string): Promise<Sourced<string[]>> =>
  cached(`fh:peers:${symbol}`, S, 24 * 3600_000, () => get<string[]>("/stock/peers", { symbol }));
