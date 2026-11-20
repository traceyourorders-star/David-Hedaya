// Shared types (safe to import from client components).

export interface Bar {
  t: number; // epoch ms (bar start; daily bars = session date 00:00 ET expressed in UTC ms)
  date: string; // ISO date or datetime
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vwap?: number;
}

export interface Quote {
  symbol: string;
  description?: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  bidSize?: number | null;
  askSize?: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  avgVolume: number | null;
  week52High: number | null;
  week52Low: number | null;
  tradeTime: number | null; // epoch ms of last trade
  quoteTime: number | null; // epoch ms of bid/ask
}

export interface Greeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  midIv: number | null;
  bidIv: number | null;
  askIv: number | null;
  updatedAt: string | null;
}

export interface OptionContract {
  symbol: string;
  type: "call" | "put";
  strike: number;
  expiration: string; // YYYY-MM-DD
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number;
  openInterest: number;
  bidTime: number | null;
  askTime: number | null;
  contractSize: number;
  greeks: Greeks | null;
}

export interface MarketClock {
  state: "premarket" | "open" | "postmarket" | "closed";
  description: string;
  asOf: number;
  nextChange?: string;
  source: string;
}

export type Direction = "bullish" | "bearish" | "neutral";

export interface SourceRef {
  title: string;
  url: string;
  source: string;
  publishedAt?: number;
}

export interface DataNote {
  area: string;
  status: "ok" | "partial" | "unavailable";
  detail: string;
  fix?: string;
}
