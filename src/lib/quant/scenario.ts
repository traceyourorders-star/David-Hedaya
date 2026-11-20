// Position repricing under price / volatility / time scenarios (shared client + server).
import { bsPrice } from "./blackscholes";

export interface PricedLeg {
  action: "buy" | "sell";
  type: "call" | "put";
  strike: number;
  dte: number; // calendar days to expiration at analysis time
  iv: number; // annualized IV at entry
  qty: number; // contracts per 1 unit of the strategy (normally 1)
}

/** Value of one unit of the position (per share; x100 for dollars) at a given state. */
export function positionValue(legs: PricedLeg[], S: number, daysForward: number, ivShift: number, r: number): number {
  let v = 0;
  for (const l of legs) {
    const T = Math.max(l.dte - daysForward, 0) / 365;
    const sigma = Math.max(0.01, l.iv + ivShift);
    const p = bsPrice({ S, K: l.strike, T, r, sigma, type: l.type });
    v += (l.action === "buy" ? 1 : -1) * p * l.qty;
  }
  return v;
}

export function expirationPayoff(legs: PricedLeg[], S: number): number {
  return legs.reduce((s, l) => s + (l.action === "buy" ? 1 : -1) * l.qty * Math.max(0, l.type === "call" ? S - l.strike : l.strike - S), 0);
}

export interface ScenarioCell { movePct: number; price: number; value: number; pnl: number; pnlPct: number }
export interface ScenarioRow { label: string; daysForward: number; isExpiration: boolean; cells: ScenarioCell[] }

export const DEFAULT_MOVES = [-0.15, -0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.15];

/**
 * P/L grid per strategy unit in dollars (x100 multiplier). `entryCost` is the per-share debit paid.
 * `exitCostPerShare` approximates slippage + commissions when closing before expiration.
 */
export function scenarioGrid(
  legs: PricedLeg[],
  spot: number,
  entryCost: number,
  r: number,
  opts: { ivShift?: number; moves?: number[]; dayPoints?: number[]; exitCostPerShare?: number } = {},
): ScenarioRow[] {
  const dte = Math.min(...legs.map((l) => l.dte));
  const moves = opts.moves ?? DEFAULT_MOVES;
  const ivShift = opts.ivShift ?? 0;
  const exitCost = opts.exitCostPerShare ?? 0;
  const days = (opts.dayPoints ?? [0, Math.round(dte * 0.25), Math.round(dte * 0.5), Math.round(dte * 0.75)]).filter(
    (d, i, a) => d < dte && a.indexOf(d) === i,
  );
  const rows: ScenarioRow[] = days.map((d) => ({
    label: d === 0 ? "Today" : `+${d}d`,
    daysForward: d,
    isExpiration: false,
    cells: moves.map((m) => {
      const S = spot * (1 + m);
      const value = positionValue(legs, S, d, ivShift, r);
      // never worse than letting a debit position expire worthless (you would not pay to close it)
      const pnl = Math.max((value - entryCost - exitCost) * 100, -entryCost * 100);
      return { movePct: m, price: S, value, pnl, pnlPct: entryCost > 0 ? pnl / (entryCost * 100) : 0 };
    }),
  }));
  rows.push({
    label: `Expiration (${dte}d)`,
    daysForward: dte,
    isExpiration: true,
    cells: moves.map((m) => {
      const S = spot * (1 + m);
      const value = expirationPayoff(legs, S);
      const pnl = (value - entryCost) * 100 - (value > 0 ? exitCost * 100 : 0);
      return { movePct: m, price: S, value, pnl, pnlPct: entryCost > 0 ? pnl / (entryCost * 100) : 0 };
    }),
  });
  return rows;
}

/** Dense P/L curves for charting: one series per date point plus the expiration payoff. */
export function pnlCurves(legs: PricedLeg[], spot: number, entryCost: number, r: number, ivShift: number, dayPoints: number[], rangePct = 0.2, steps = 81) {
  const dte = Math.min(...legs.map((l) => l.dte));
  const pts: Record<string, number>[] = [];
  for (let i = 0; i < steps; i++) {
    const S = spot * (1 - rangePct + (2 * rangePct * i) / (steps - 1));
    const row: Record<string, number> = { price: Number(S.toFixed(2)) };
    for (const d of dayPoints) if (d < dte) row[`d${d}`] = Number(((positionValue(legs, S, d, ivShift, r) - entryCost) * 100).toFixed(2));
    row.expiration = Number(((expirationPayoff(legs, S) - entryCost) * 100).toFixed(2));
    pts.push(row);
  }
  return pts;
}
