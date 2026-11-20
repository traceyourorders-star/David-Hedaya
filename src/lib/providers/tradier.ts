import { config, tradierBase } from "../config";
import { fetchJson, ProviderError } from "../http";
import { cached, Sourced } from "../cache";
import type { Bar, MarketClock, OptionContract, Quote } from "../types";

const SRC = () =>
  config.tradierBaseOverride
    ? `TEST ENDPOINT ${config.tradierBaseOverride} (not market data)`
    : `Tradier (${config.tradierEnv === "production" ? "real-time" : "sandbox, 15-min delayed"})`;

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  if (!config.tradierToken) throw new ProviderError("Tradier", "not_configured", "Tradier: TRADIER_TOKEN not set");
  const qs = new URLSearchParams(params).toString();
  return fetchJson<T>("Tradier", `${tradierBase()}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${config.tradierToken}`, Accept: "application/json" },
  });
}

const arr = <T,>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);

// ---------- quote ----------
interface TQuote {
  symbol: string; description?: string; last?: number; bid?: number; ask?: number; bidsize?: number; asksize?: number;
  change?: number; change_percentage?: number; open?: number; high?: number; low?: number; prevclose?: number;
  volume?: number; average_volume?: number; week_52_high?: number; week_52_low?: number; trade_date?: number;
  bid_date?: number; ask_date?: number;
}

export function parseQuote(q: TQuote): Quote {
  return {
    symbol: q.symbol,
    description: q.description,
    last: num(q.last), bid: num(q.bid), ask: num(q.ask), bidSize: num(q.bidsize), askSize: num(q.asksize),
    change: num(q.change), changePct: num(q.change_percentage), open: num(q.open), high: num(q.high), low: num(q.low),
    prevClose: num(q.prevclose), volume: num(q.volume), avgVolume: num(q.average_volume),
    week52High: num(q.week_52_high), week52Low: num(q.week_52_low),
    tradeTime: num(q.trade_date), quoteTime: num(q.ask_date) ?? num(q.bid_date),
  };
}

export async function getQuotes(symbols: string[], force = false): Promise<Sourced<Quote[]>> {
  return cached(`tradier:quotes:${symbols.join(",")}`, SRC(), 10_000, async () => {
    const r = await get<{ quotes?: { quote?: TQuote | TQuote[]; unmatched_symbols?: unknown } }>("/markets/quotes", {
      symbols: symbols.join(","),
      greeks: "false",
    });
    return arr(r.quotes?.quote).map(parseQuote);
  }, force);
}

// ---------- bars ----------
interface TDay { date: string; open: number; high: number; low: number; close: number; volume: number }

export function parseDaily(days: TDay[]): Bar[] {
  return days
    .filter((d) => Number.isFinite(d.close))
    .map((d) => ({ t: Date.parse(`${d.date}T00:00:00Z`), date: d.date, o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume ?? 0 }));
}

export async function getHistory(symbol: string, interval: "daily" | "weekly" | "monthly", start: string, force = false): Promise<Sourced<Bar[]>> {
  return cached(`tradier:history:${symbol}:${interval}:${start}`, SRC(), interval === "daily" ? 5 * 60_000 : 30 * 60_000, async () => {
    const r = await get<{ history?: { day?: TDay | TDay[] } | null }>("/markets/history", { symbol, interval, start });
    return parseDaily(arr(r.history?.day));
  }, force);
}

interface TTimesale { time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number; vwap?: number; price?: number }

export function parseTimesales(rows: TTimesale[]): Bar[] {
  return rows
    .filter((d) => Number.isFinite(d.close))
    .map((d) => ({ t: d.timestamp * 1000, date: d.time, o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume ?? 0, vwap: d.vwap }));
}

export async function getIntraday(symbol: string, interval: "1min" | "5min" | "15min", startEt: string, force = false): Promise<Sourced<Bar[]>> {
  return cached(`tradier:ts:${symbol}:${interval}:${startEt}`, SRC(), 60_000, async () => {
    const r = await get<{ series?: { data?: TTimesale | TTimesale[] } | null }>("/markets/timesales", {
      symbol, interval, start: startEt, session_filter: "open",
    });
    return parseTimesales(arr(r.series?.data));
  }, force);
}

// ---------- options ----------
export async function getExpirations(symbol: string, force = false): Promise<Sourced<string[]>> {
  return cached(`tradier:exp:${symbol}`, SRC(), 30 * 60_000, async () => {
    const r = await get<{ expirations?: { date?: string | string[] } | null }>("/markets/options/expirations", {
      symbol, includeAllRoots: "false",
    });
    return arr(r.expirations?.date);
  }, force);
}

interface TOption {
  symbol: string; option_type: "call" | "put"; strike: number; expiration_date: string; bid: number | null; ask: number | null;
  last: number | null; volume: number | null; open_interest: number | null; bid_date?: number; ask_date?: number; contract_size?: number;
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number; rho?: number; mid_iv?: number; bid_iv?: number; ask_iv?: number; updated_at?: string } | null;
}

export function parseChain(rows: TOption[]): OptionContract[] {
  return rows.map((o) => ({
    symbol: o.symbol,
    type: o.option_type,
    strike: o.strike,
    expiration: o.expiration_date,
    bid: num(o.bid),
    ask: num(o.ask),
    last: num(o.last),
    volume: num(o.volume) ?? 0,
    openInterest: num(o.open_interest) ?? 0,
    bidTime: num(o.bid_date),
    askTime: num(o.ask_date),
    contractSize: o.contract_size ?? 100,
    greeks: o.greeks
      ? {
          delta: num(o.greeks.delta), gamma: num(o.greeks.gamma), theta: num(o.greeks.theta), vega: num(o.greeks.vega),
          rho: num(o.greeks.rho), midIv: num(o.greeks.mid_iv) || null, bidIv: num(o.greeks.bid_iv) || null,
          askIv: num(o.greeks.ask_iv) || null, updatedAt: o.greeks.updated_at ?? null,
        }
      : null,
  }));
}

export async function getChain(symbol: string, expiration: string, force = false): Promise<Sourced<OptionContract[]>> {
  return cached(`tradier:chain:${symbol}:${expiration}`, SRC(), 30_000, async () => {
    const r = await get<{ options?: { option?: TOption | TOption[] } | null }>("/markets/options/chains", {
      symbol, expiration, greeks: "true",
    });
    return parseChain(arr(r.options?.option));
  }, force);
}

// ---------- clock ----------
export async function getClock(force = false): Promise<Sourced<MarketClock>> {
  return cached("tradier:clock", SRC(), 30_000, async () => {
    const r = await get<{ clock: { state: string; description: string; timestamp: number; next_change?: string } }>("/markets/clock", {});
    const s = r.clock.state;
    return {
      state: (["premarket", "open", "postmarket", "closed"].includes(s) ? s : "closed") as MarketClock["state"],
      description: r.clock.description,
      asOf: r.clock.timestamp * 1000,
      nextChange: r.clock.next_change,
      source: "Tradier market clock",
    };
  }, force);
}
