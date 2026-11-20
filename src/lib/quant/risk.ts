// Position sizing (shared client + server). Defaults protect capital.

export interface RiskProfile {
  budget: number; // total capital set aside for options trading
  maxRiskPct: number; // max fraction of budget at risk on one trade (0.02 = 2%)
  maxLossDollars: number; // absolute cap per trade
  preference: "conservative" | "aggressive";
  holdingDays: number;
  commissionPerContract: number;
}

export const DEFAULT_RISK: RiskProfile = {
  budget: 10000,
  maxRiskPct: 0.02,
  maxLossDollars: 250,
  preference: "conservative",
  holdingDays: 21,
  commissionPerContract: 0.65,
};

export interface SizingResult {
  contracts: number;
  riskBudget: number;
  bindingConstraint: string;
  maxLossTotal: number;
  capitalDeployed: number;
  pctOfBudget: number;
  feasible: boolean;
  note: string;
}

/**
 * `maxLossPerUnit` is the true worst-case loss of one unit (one contract or one spread) including
 * entry and exit commissions. Defined-risk debit positions cannot lose more than that, so sizing uses it
 * directly; exit slippage is reported separately because it only applies to early exits.
 */
export function sizePosition(p: RiskProfile, maxLossPerUnit: number, exitSlippagePerUnit: number, costPerUnit: number): SizingResult {
  const pctCap = p.budget * p.maxRiskPct;
  const riskBudget = Math.min(pctCap, p.maxLossDollars > 0 ? p.maxLossDollars : Infinity);
  const binding =
    riskBudget === pctCap
      ? `${(p.maxRiskPct * 100).toFixed(1)}% of the $${p.budget.toLocaleString()} budget`
      : `your max acceptable loss of $${p.maxLossDollars.toLocaleString()}`;
  const contracts = maxLossPerUnit > 0 ? Math.floor(riskBudget / maxLossPerUnit) : 0;
  const maxLossTotal = contracts * maxLossPerUnit;
  const capitalDeployed = contracts * costPerUnit;
  return {
    contracts,
    riskBudget,
    bindingConstraint: binding,
    maxLossTotal,
    capitalDeployed,
    pctOfBudget: p.budget ? capitalDeployed / p.budget : 0,
    feasible: contracts >= 1,
    note:
      contracts >= 1
        ? `${contracts} unit(s): worst case -$${maxLossTotal.toFixed(0)} (${((maxLossTotal / p.budget) * 100).toFixed(2)}% of budget). Estimated slippage if closed early: ~$${(exitSlippagePerUnit * contracts).toFixed(0)}. Never add to a losing position.`
        : `One unit risks $${maxLossPerUnit.toFixed(0)}, more than your $${riskBudget.toFixed(0)} per-trade limit (${binding}). Skip it or choose a cheaper defined-risk structure; do not override the limit.`,
  };
}
