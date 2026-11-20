// Black-Scholes-Merton pricing for European options (shared client/server).
// American early-exercise and discrete dividends are NOT modelled; this is labelled in the UI.

export function normCdf(x: number): number {
  // Abramowitz-Stegun 7.1.26 via erf, |error| < 7.5e-8
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export type OptType = "call" | "put";

export interface BsInput { S: number; K: number; T: number; r: number; sigma: number; type: OptType; q?: number }

export function bsPrice({ S, K, T, r, sigma, type, q = 0 }: BsInput): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === "call" ? S - K : K - S);
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / sq;
  const d2 = d1 - sq;
  return type === "call"
    ? S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
    : K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
}

export function bsGreeks({ S, K, T, r, sigma, type, q = 0 }: BsInput) {
  if (T <= 0 || sigma <= 0) {
    const itm = type === "call" ? S > K : S < K;
    return { delta: itm ? (type === "call" ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / sq;
  const d2 = d1 - sq;
  const pdf = normPdf(d1);
  const delta = type === "call" ? Math.exp(-q * T) * normCdf(d1) : Math.exp(-q * T) * (normCdf(d1) - 1);
  const gamma = (Math.exp(-q * T) * pdf) / (S * sq);
  const vega = (S * Math.exp(-q * T) * pdf * Math.sqrt(T)) / 100; // per 1 vol point
  const thetaYr =
    type === "call"
      ? (-S * pdf * sigma * Math.exp(-q * T)) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCdf(d2) + q * S * Math.exp(-q * T) * normCdf(d1)
      : (-S * pdf * sigma * Math.exp(-q * T)) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normCdf(-d2) - q * S * Math.exp(-q * T) * normCdf(-d1);
  return { delta, gamma, theta: thetaYr / 365, vega };
}

/** Implied volatility by bisection (robust). Returns null if price is outside no-arbitrage bounds. */
export function impliedVol(price: number, S: number, K: number, T: number, r: number, type: OptType): number | null {
  if (!(price > 0) || T <= 0) return null;
  const intrinsic = Math.max(0, type === "call" ? S - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S);
  if (price < intrinsic - 1e-9) return null;
  let lo = 1e-4, hi = 5;
  if (bsPrice({ S, K, T, r, sigma: hi, type }) < price) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice({ S, K, T, r, sigma: mid, type }) > price) hi = mid; else lo = mid;
    if (hi - lo < 1e-6) break;
  }
  return (lo + hi) / 2;
}

/** Risk-neutral probability that S_T > X under lognormal dynamics. */
export function probAbove(S: number, X: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return S > X ? 1 : 0;
  const d2 = (Math.log(S / X) + (r - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normCdf(d2);
}
