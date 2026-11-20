"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { StrategyCandidate } from "@/lib/quant/strategies";
import { pnlCurves, scenarioGrid } from "@/lib/quant/scenario";
import { money, pct } from "@/lib/format";

const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500"];

export default function ScenarioSimulator({ candidates, spot, r }: { candidates: StrategyCandidate[]; spot: number; r: number }) {
  const [sel, setSel] = useState(0);
  const [ivShift, setIvShift] = useState(0);
  const [contracts, setContracts] = useState(1);
  const c = candidates[sel];
  const dte = c?.dte ?? 0;
  const dayPoints = useMemo(() => [0, Math.round(dte * 0.25), Math.round(dte * 0.5), Math.round(dte * 0.75)].filter((d, i, a) => d < dte && a.indexOf(d) === i), [dte]);
  const exitCost = c ? c.exitSlippagePerUnit / 100 : 0;
  const grid = useMemo(() => (c ? scenarioGrid(c.pricedLegs, spot, c.limitPrice, r, { ivShift: ivShift / 100, dayPoints, exitCostPerShare: exitCost }) : []), [c, spot, r, ivShift, dayPoints, exitCost]);
  const curves = useMemo(() => (c ? pnlCurves(c.pricedLegs, spot, c.limitPrice, r, ivShift / 100, dayPoints, 0.2) : []), [c, spot, r, ivShift, dayPoints]);
  if (!c) return <p className="muted small">No strategy available to simulate.</p>;
  const scaled = curves.map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, k === "price" ? v : v * contracts])));
  const series = [...dayPoints.map((d, i) => ({ key: `d${d}`, name: d === 0 ? "Today (model)" : `+${d} days (model)`, color: COLORS[i % 4] })), { key: "expiration", name: "At expiration (payoff)", color: "#9085e9" }];

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        <label className="small col" style={{ gap: 4 }}>
          <span className="muted">Strategy</span>
          <select value={sel} onChange={(e) => setSel(Number(e.target.value))}>
            {candidates.map((x, i) => <option key={x.id} value={i}>{x.profile === "conservative" ? "Conservative" : "Aggressive"}: {x.name}</option>)}
          </select>
        </label>
        <label className="small col" style={{ gap: 4, minWidth: 220 }}>
          <span className="muted">Implied volatility shift: <b className="mono">{ivShift > 0 ? "+" : ""}{ivShift} vol pts</b> {ivShift <= -10 ? "(IV collapse)" : ivShift >= 10 ? "(IV expansion)" : ""}</span>
          <input type="range" min={-30} max={30} step={1} value={ivShift} onChange={(e) => setIvShift(Number(e.target.value))} aria-label="Implied volatility shift" />
        </label>
        <label className="small col" style={{ gap: 4, width: 110 }}>
          <span className="muted">Units</span>
          <input type="number" min={1} max={100} value={contracts} onChange={(e) => setContracts(Math.max(1, Number(e.target.value) || 1))} />
        </label>
      </div>
      <div className="small sec">
        Entry {money(c.limitPrice)} per share x 100 x {contracts} = <b>{money(c.limitPrice * 100 * contracts)}</b> debit · max loss {money(c.maxLossPerUnit * contracts)} · max profit {c.maxProfitPerUnit == null ? "unlimited" : money(c.maxProfitPerUnit * contracts)} · break-even {money(c.breakeven)}
      </div>
      <div style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer>
          <LineChart data={scaled} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke="#1d1e22" />
            <XAxis dataKey="price" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "#8a8a84", fontSize: 11 }} tickFormatter={(v) => `$${Number(v).toFixed(0)}`} stroke="#34353b" />
            <YAxis tick={{ fill: "#8a8a84", fontSize: 11 }} tickFormatter={(v) => `$${Number(v).toFixed(0)}`} stroke="#34353b" width={64} />
            <Tooltip
              contentStyle={{ background: "#191a1e", border: "1px solid #34353b", borderRadius: 8, fontSize: 12 }}
              labelFormatter={(v) => `Underlying $${Number(v).toFixed(2)} (${pct(Number(v) / spot - 1, 1, true)})`}
              formatter={(v, name) => [money(Number(v), 0), String(name)]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine y={0} stroke="#5a5a55" />
            <ReferenceLine x={Number(spot.toFixed(2))} stroke="#ff9f1a" strokeDasharray="4 4" label={{ value: "Spot", fill: "#ff9f1a", fontSize: 11, position: "insideTopLeft" }} />
            <ReferenceLine x={Number(c.breakeven.toFixed(2))} stroke="#8a8a84" strokeDasharray="2 4" label={{ value: "B/E", fill: "#8a8a84", fontSize: 11, position: "insideTopRight" }} />
            {series.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={false} strokeDasharray={s.key === "expiration" ? "6 3" : undefined} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Date \ Stock move</th>
              {grid[0]?.cells.map((x) => <th key={x.movePct} className="num">{pct(x.movePct, 0, true)}<div className="tiny muted">{money(x.price)}</div></th>)}
            </tr>
          </thead>
          <tbody>
            {grid.map((row) => (
              <tr key={row.label}>
                <td className="mono small">{row.label}{row.isExpiration && <div className="tiny muted">payoff</div>}</td>
                {row.cells.map((x) => (
                  <td key={x.movePct} className={`num ${x.pnl > 0 ? "up" : x.pnl < 0 ? "down" : ""}`}>
                    {money(x.pnl * contracts, 0)}
                    <div className="tiny muted">{pct(x.pnlPct, 0, true)}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="tiny muted">
        Pre-expiration values are Black-Scholes estimates (European exercise, no dividends, each leg&apos;s current IV {ivShift !== 0 ? `shifted ${ivShift > 0 ? "+" : ""}${ivShift} pts` : "held constant"}, risk-free {pct(r)}), net of estimated exit slippage and commissions.
        Expiration row is the exact intrinsic payoff. Real fills, skew changes and early assignment can differ. &quot;Sideways&quot; is the 0% column.
      </p>
    </div>
  );
}
