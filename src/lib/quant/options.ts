import type { OptionContract } from "../types";
import { impliedVol } from "./blackscholes";

export const mid = (o: OptionContract) => (o.bid != null && o.ask != null && o.ask > 0 && o.bid >= 0 ? (o.bid + o.ask) / 2 : null);
export const spreadPct = (o: OptionContract) => {
  const m = mid(o);
  return m && o.ask != null && o.bid != null && m > 0 ? (o.ask - o.bid) / m : null;
};

export interface IvPoint { iv: number; source: "provider" | "computed" }

/** IV for a contract: provider mid_iv (ORATS via Tradier) when present, else solved from the mid price. */
export function contractIv(o: OptionContract, S: number, T: number, r: number): IvPoint | null {
  const p = o.greeks?.midIv;
  if (p && p > 0.01 && p < 5) return { iv: p, source: "provider" };
  const m = mid(o);
  if (!m) return null;
  const iv = impliedVol(m, S, o.strike, T, r, o.type);
  return iv ? { iv, source: "computed" } : null;
}

export interface ExpirySummary {
  expiration: string;
  dte: number;
  atmStrike: number;
  atmIv: number | null;
  ivSource: "provider" | "computed" | null;
  straddleMid: number | null;
  impliedMovePct: number | null; // straddle / spot
  oneSigmaMovePct: number | null; // atmIv * sqrt(T)
  callVolume: number; putVolume: number; callOi: number; putOi: number;
  skew25: number | null; // put25 IV - call25 IV (vol points as fraction)
  atmSpreadPct: number | null;
  contracts: number;
}

export interface UnusualContract {
  symbol: string; type: "call" | "put"; strike: number; expiration: string; volume: number; openInterest: number; volOiRatio: number;
  premium: number; mid: number | null; iv: number | null;
}

export interface OptionsAnalytics {
  spot: number;
  expiries: ExpirySummary[];
  iv30: number | null;
  hv20: number | null;
  ivHvRatio: number | null;
  ivRank: { value: number | null; percentile: number | null; observations: number; note: string };
  termStructure: "contango" | "backwardation" | "flat" | "unknown";
  termNote: string;
  pcrVolume: number | null;
  pcrOi: number | null;
  skew25: number | null;
  skewNote: string;
  unusual: UnusualContract[];
  liquidity: { grade: "A" | "B" | "C" | "D" | "F"; medianSpreadPct: number | null; atmOi: number; note: string };
  pricing: { verdict: "rich" | "fair" | "cheap" | "unknown"; note: string };
  oldestQuoteMs: number | null;
  newestQuoteMs: number | null;
}

function nearest<T>(xs: T[], f: (x: T) => number): T | undefined {
  let best: T | undefined, bd = Infinity;
  for (const x of xs) {
    const d = f(x);
    if (d < bd) { bd = d; best = x; }
  }
  return best;
}

export function summarizeExpiry(chain: OptionContract[], spot: number, dte: number, r: number): ExpirySummary {
  const T = Math.max(dte, 0.5) / 365;
  const strikes = [...new Set(chain.map((c) => c.strike))];
  const atmStrike = nearest(strikes, (k) => Math.abs(k - spot)) ?? spot;
  const call = chain.find((c) => c.type === "call" && c.strike === atmStrike);
  const put = chain.find((c) => c.type === "put" && c.strike === atmStrike);
  const ivs = [call, put].map((c) => (c ? contractIv(c, spot, T, r) : null)).filter((x): x is IvPoint => !!x);
  const atmIv = ivs.length ? ivs.reduce((s, x) => s + x.iv, 0) / ivs.length : null;
  const cm = call ? mid(call) : null, pm = put ? mid(put) : null;
  const straddleMid = cm != null && pm != null ? cm + pm : null;
  const withDelta = chain.filter((c) => c.greeks?.delta != null);
  const c25 = nearest(withDelta.filter((c) => c.type === "call"), (c) => Math.abs((c.greeks!.delta as number) - 0.25));
  const p25 = nearest(withDelta.filter((c) => c.type === "put"), (c) => Math.abs((c.greeks!.delta as number) + 0.25));
  const c25iv = c25 ? contractIv(c25, spot, T, r)?.iv : undefined;
  const p25iv = p25 ? contractIv(p25, spot, T, r)?.iv : undefined;
  const sp = [call, put].map((c) => (c ? spreadPct(c) : null)).filter((x): x is number => x != null);
  return {
    expiration: chain[0]?.expiration ?? "",
    dte,
    atmStrike,
    atmIv,
    ivSource: ivs.length ? ivs[0].source : null,
    straddleMid,
    impliedMovePct: straddleMid != null ? straddleMid / spot : null,
    oneSigmaMovePct: atmIv != null ? atmIv * Math.sqrt(T) : null,
    callVolume: chain.filter((c) => c.type === "call").reduce((s, c) => s + c.volume, 0),
    putVolume: chain.filter((c) => c.type === "put").reduce((s, c) => s + c.volume, 0),
    callOi: chain.filter((c) => c.type === "call").reduce((s, c) => s + c.openInterest, 0),
    putOi: chain.filter((c) => c.type === "put").reduce((s, c) => s + c.openInterest, 0),
    skew25: c25iv != null && p25iv != null ? p25iv - c25iv : null,
    atmSpreadPct: sp.length ? Math.max(...sp) : null,
    contracts: chain.length,
  };
}

/** Linear interpolation of ATM IV in total-variance space to a target DTE. */
export function interpIv(ex: ExpirySummary[], targetDte = 30): number | null {
  const pts = ex.filter((e) => e.atmIv != null && e.dte > 0).sort((a, b) => a.dte - b.dte);
  if (!pts.length) return null;
  if (targetDte <= pts[0].dte) return pts[0].atmIv;
  if (targetDte >= pts[pts.length - 1].dte) return pts[pts.length - 1].atmIv;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (targetDte <= b.dte) {
      const va = a.atmIv! ** 2 * a.dte, vb = b.atmIv! ** 2 * b.dte;
      const w = (targetDte - a.dte) / (b.dte - a.dte);
      return Math.sqrt((va + w * (vb - va)) / targetDte);
    }
  }
  return null;
}

export function analyzeOptions(
  chains: Record<string, OptionContract[]>,
  dteByExp: Record<string, number>,
  spot: number,
  r: number,
  hv20: number | null,
  ivHistory: number[], // daily ATM 30d IV observations recorded by this app (oldest..newest), excluding today
  opts: { unusualMinVolume?: number } = {},
): OptionsAnalytics {
  const exps = Object.keys(chains).filter((e) => chains[e].length).sort();
  const expiries = exps.map((e) => summarizeExpiry(chains[e], spot, dteByExp[e], r));
  const iv30 = interpIv(expiries, 30);
  const ivHvRatio = iv30 && hv20 ? iv30 / hv20 : null;

  // IV rank/percentile only from genuinely recorded history
  let ivRank: OptionsAnalytics["ivRank"];
  if (iv30 != null && ivHistory.length >= 20) {
    const all = [...ivHistory, iv30];
    const lo = Math.min(...all), hi = Math.max(...all);
    ivRank = {
      value: hi > lo ? ((iv30 - lo) / (hi - lo)) * 100 : 50,
      percentile: (ivHistory.filter((x) => x < iv30).length / ivHistory.length) * 100,
      observations: ivHistory.length,
      note: `Based on ${ivHistory.length} daily ATM-IV observations recorded by this app (not a full 52-week history until 252 observations).`,
    };
  } else {
    ivRank = {
      value: null, percentile: null, observations: ivHistory.length,
      note: `Unavailable: needs >= 20 recorded daily IV observations (have ${ivHistory.length}). The connected provider does not supply historical IV; this app records one observation per ticker per day when analyzed or monitored. IV vs. realized volatility is used instead.`,
    };
  }

  const front = expiries.find((e) => e.dte >= 7 && e.atmIv != null);
  const back = [...expiries].reverse().find((e) => e.dte >= 45 && e.atmIv != null);
  let termStructure: OptionsAnalytics["termStructure"] = "unknown", termNote = "Not enough expirations with IV.";
  if (front && back && front !== back) {
    const d = front.atmIv! - back.atmIv!;
    termStructure = d > 0.02 ? "backwardation" : d < -0.02 ? "contango" : "flat";
    termNote =
      termStructure === "backwardation"
        ? `Front IV (${(front.atmIv! * 100).toFixed(1)}%, ${front.dte}d) above back IV (${(back.atmIv! * 100).toFixed(1)}%, ${back.dte}d): the market is pricing a near-term event or stress. Short-dated long premium is expensive and exposed to an IV crush.`
        : termStructure === "contango"
          ? `Normal upward-sloping term structure (front ${(front.atmIv! * 100).toFixed(1)}% vs back ${(back.atmIv! * 100).toFixed(1)}%).`
          : "Flat term structure.";
  }

  const all = exps.flatMap((e) => chains[e]);
  const cv = all.filter((c) => c.type === "call").reduce((s, c) => s + c.volume, 0);
  const pv = all.filter((c) => c.type === "put").reduce((s, c) => s + c.volume, 0);
  const co = all.filter((c) => c.type === "call").reduce((s, c) => s + c.openInterest, 0);
  const po = all.filter((c) => c.type === "put").reduce((s, c) => s + c.openInterest, 0);

  const ref = expiries.find((e) => e.dte >= 20 && e.skew25 != null) ?? expiries.find((e) => e.skew25 != null);
  const skew25 = ref?.skew25 ?? null;
  const skewNote =
    skew25 == null
      ? "Skew unavailable (no delta data)."
      : skew25 > 0.06
        ? `Steep put skew (+${(skew25 * 100).toFixed(1)} vol pts, 25-delta, ${ref!.dte}d): downside protection is in demand; puts are relatively expensive.`
        : skew25 < 0
          ? `Inverted skew (${(skew25 * 100).toFixed(1)} vol pts): calls priced above puts, typical of upside speculation.`
          : `Normal put skew (+${(skew25 * 100).toFixed(1)} vol pts, 25-delta, ${ref!.dte}d).`;

  const minVol = opts.unusualMinVolume ?? 500;
  const unusual: UnusualContract[] = all
    .filter((c) => c.volume >= minVol && c.volume > 1.5 * Math.max(c.openInterest, 1))
    .map((c) => {
      const m = mid(c);
      return {
        symbol: c.symbol, type: c.type, strike: c.strike, expiration: c.expiration, volume: c.volume, openInterest: c.openInterest,
        volOiRatio: c.volume / Math.max(c.openInterest, 1), premium: (m ?? c.last ?? 0) * c.volume * c.contractSize, mid: m,
        iv: c.greeks?.midIv ?? null,
      };
    })
    .sort((a, b) => b.premium - a.premium)
    .slice(0, 12);

  // liquidity: near-the-money contracts of the first two monthly-ish expiries
  const near = expiries.filter((e) => e.dte >= 7).slice(0, 2).flatMap((e) =>
    chains[e.expiration].filter((c) => Math.abs(c.strike / spot - 1) < 0.05),
  );
  const spreads = near.map(spreadPct).filter((x): x is number => x != null).sort((a, b) => a - b);
  const med = spreads.length ? spreads[Math.floor(spreads.length / 2)] : null;
  const atmOi = near.reduce((s, c) => s + c.openInterest, 0);
  const grade: OptionsAnalytics["liquidity"]["grade"] =
    med == null ? "F" : med <= 0.03 && atmOi > 5000 ? "A" : med <= 0.06 && atmOi > 1000 ? "B" : med <= 0.12 ? "C" : med <= 0.25 ? "D" : "F";
  const liquidity = {
    grade, medianSpreadPct: med, atmOi,
    note: med == null ? "No two-sided quotes near the money." : `Median near-the-money bid/ask spread ${(med * 100).toFixed(1)}% of mid; ${atmOi.toLocaleString()} open interest within 5% of spot.`,
  };

  let pricing: OptionsAnalytics["pricing"] = { verdict: "unknown", note: "IV or realized volatility unavailable." };
  if (ivHvRatio != null) {
    const rankHigh = ivRank.value != null && ivRank.value > 70, rankLow = ivRank.value != null && ivRank.value < 25;
    const verdict = ivHvRatio > 1.3 || rankHigh ? "rich" : ivHvRatio < 0.9 || rankLow ? "cheap" : "fair";
    pricing = {
      verdict,
      note: `30-day ATM IV ${(iv30! * 100).toFixed(1)}% vs 20-day realized ${(hv20! * 100).toFixed(1)}% (ratio ${ivHvRatio.toFixed(2)}). ${
        verdict === "rich" ? "Options are expensive relative to recent realized movement: favour debit spreads (short leg offsets IV) over naked long premium." : verdict === "cheap" ? "Options are inexpensive relative to realized movement: long premium is favoured if a move is expected." : "Options are roughly fairly priced relative to realized movement."
      } Realized volatility is backward-looking; a known upcoming event can justify a premium.`,
    };
  }

  const times = all.flatMap((c) => [c.bidTime, c.askTime]).filter((x): x is number => !!x);
  return {
    spot, expiries, iv30, hv20, ivHvRatio, ivRank, termStructure, termNote,
    pcrVolume: cv ? pv / cv : null, pcrOi: co ? po / co : null, skew25, skewNote, unusual, liquidity, pricing,
    oldestQuoteMs: times.length ? Math.min(...times) : null,
    newestQuoteMs: times.length ? Math.max(...times) : null,
  };
}
