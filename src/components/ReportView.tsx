"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Report } from "@/lib/engine/report-types";
import type { StrategyCandidate } from "@/lib/quant/strategies";
import type { StudyResult } from "@/lib/quant/backtest";
import { sizePosition, type RiskProfile } from "@/lib/quant/risk";
import { fmtEt } from "@/lib/market-time";
import { ago, big, dirBadge, int, money, num, pct, signCls } from "@/lib/format";
import PriceChart from "./PriceChart";
import ScenarioSimulator from "./ScenarioSimulator";

export default function ReportView({ report: R, risk }: { report: Report; risk: RiskProfile }) {
  const q = R.market.quote;
  const spot = q?.last ?? null;
  const D = R.decision;
  const cons = R.strategies.conservative, aggr = R.strategies.aggressive;
  const allCandidates = [cons, aggr, ...R.strategies.alternatives.conservative, ...R.strategies.alternatives.aggressive].filter((x): x is StrategyCandidate => !!x);

  return (
    <div className="stack">
      {/* ---------- Header ---------- */}
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="tiny muted" style={{ letterSpacing: "0.1em" }}>STOCK INTELLIGENCE REPORT</div>
            <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
              <span className="mono" style={{ fontSize: 30, fontWeight: 800 }}>{R.ticker}</span>
              <span className="sec">{R.company}</span>
              {R.profile?.industry && <span className="badge">{R.profile.industry}</span>}
            </div>
          </div>
          <div className="right">
            <div className="mono" style={{ fontSize: 30, fontWeight: 700 }}>{spot != null ? money(spot) : "n/a"}</div>
            {q && <div className={`mono ${signCls(q.change)}`}>{q.change != null ? `${q.change > 0 ? "+" : ""}${num(q.change)}` : ""} ({pct(q.changePct != null ? q.changePct / 100 : null, 2, true)})</div>}
            <div className="tiny muted">
              {q?.tradeTime ? `Last trade ${fmtEt(q.tradeTime)}` : "No live quote"} · {R.market.quoteSource ?? "no provider"}
            </div>
          </div>
        </div>
        {R.market.quoteSource?.startsWith("TEST ENDPOINT") && (
          <div className="banner bad" style={{ marginTop: 10 }}>
            <b>TEST FIXTURE DATA.</b> This server is pointed at a mock provider endpoint (TRADIER_BASE_URL / FINNHUB_BASE_URL). Nothing on this page is real market data or real news.
          </div>
        )}
        <div className={`banner ${R.market.executable ? "info" : "warn"}`} style={{ marginTop: 10 }}>
          <b>{R.market.clock.state === "open" ? "Market open" : `Market ${R.market.clock.state}`}</b> ({R.market.clock.source}, as of {fmtEt(R.market.clock.asOf)}). {R.market.executableNote}
        </div>
        <div className="grid4" style={{ marginTop: 12 }}>
          <Stat label="Overall outlook" value={<span className={dirBadge(D.outlook)} style={{ fontSize: 14 }}>{D.outlook.toUpperCase()}</span>} sub={`Composite ${D.composite.toFixed(2)}`} />
          <Stat label="AI conviction score" value={<span className="mono">{D.conviction}<span className="muted small">/100</span></span>} sub={<div className="gauge" style={{ marginTop: 6 }}><div style={{ width: `${D.conviction}%` }} /></div>} />
          <Stat label="News sentiment" value={R.news.sentiment.label} sub={R.news.ai.available ? "Claude-assessed" : R.news.sentiment.label === "Unavailable" ? "No news source" : "Lexicon heuristic"} />
          <Stat label="Technical trend" value={<span className={dirBadge(R.technical.combined.trend)} style={{ fontSize: 14 }}>{R.technical.combined.trend.toUpperCase()}</span>} sub={`${R.technical.timeframes.filter((t) => t.available).length}/7 timeframes`} />
        </div>
        <div className="grid2" style={{ marginTop: 12 }}>
          <div className="stat">
            <div className="label">Expected price scenarios ({risk.holdingDays}d)</div>
            <table style={{ marginTop: 4 }}>
              <tbody>
                {D.scenarios.map((s) => (
                  <tr key={s.name}>
                    <td><span className={dirBadge(s.name === "Bull" ? "bull" : s.name === "Bear" ? "bear" : "n")}>{s.name}</span></td>
                    <td className="num">{money(s.low)} - {money(s.high)}</td>
                    <td className="num tiny muted" title="Share of the stock's own historical moves of this horizon that landed in the range">{s.historicalFrequency != null ? `hist. ${pct(s.historicalFrequency, 0)}` : "freq. n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tiny muted" style={{ marginTop: 4 }}>{D.scenarios[0]?.assumptions}</div>
          </div>
          <div className="stat">
            <div className="label">Important upcoming catalyst</div>
            <div className="value" style={{ fontSize: 16 }}>{R.catalyst ? `${R.catalyst.label}${R.catalyst.date ? ` · ${R.catalyst.date}` : ""}` : "None identified"}</div>
            <div className="sub">{R.catalyst?.detail ?? "No earnings date from the connected calendar and no catalyst flagged by news analysis."}</div>
          </div>
        </div>
      </section>

      {/* ---------- Verdict ---------- */}
      <section className="verdict">
        <div className="tiny muted" style={{ letterSpacing: "0.1em" }}>FINAL AI TRADING VERDICT · BEST ACTION RIGHT NOW</div>
        <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
          <span className="action" style={{ color: D.verdict.startsWith("BUY") || D.verdict.startsWith("USE") ? "var(--accent)" : "var(--text)" }}>{D.verdict}</span>
          <span className={`badge ${D.timing === "BUY NOW" ? "bull" : D.timing === "AVOID THIS TRADE" ? "bear" : "warn"}`} style={{ fontSize: 13, padding: "4px 10px" }}>{D.timing}</span>
        </div>
        <p className="sec" style={{ marginBottom: 12 }}>{D.verdictDetail}</p>
        <div className="grid2">
          <div>
            <h3>1. What to consider doing</h3>
            <p className="small">{D.narrative.whatToConsider}</p>
            <h3>2. Why this makes sense</h3>
            <ul className="plain small">{D.narrative.whyItMakesSense.map((x, i) => <li key={i}>{x}</li>)}</ul>
            <h3>3. Why it could fail</h3>
            <ul className="plain small">{D.narrative.whyItCouldFail.slice(0, 10).map((x, i) => <li key={i}>{x}</li>)}</ul>
          </div>
          <div>
            <h3>4. Enter now or wait?</h3>
            <p className="small">{D.narrative.enterNowOrWait}</p>
            <h3>5. What would change my mind</h3>
            <table>
              <thead><tr><th>Level</th><th>Condition</th><th>New action</th></tr></thead>
              <tbody>
                {D.triggers.map((t, i) => (
                  <tr key={i}><td className="num">{t.price != null ? money(t.price) : "-"}</td><td className="small">{t.condition}</td><td className="small">{t.newAction}</td></tr>
                ))}
              </tbody>
            </table>
            <h3>6. Better risk-adjusted opportunity</h3>
            <p className="small">{D.narrative.betterRiskAdjusted}</p>
          </div>
        </div>
        <details style={{ marginTop: 12 }}>
          <summary className="small">How the conviction score was computed</summary>
          <ul className="plain small">{D.convictionExplanation.map((x, i) => <li key={i}>{x}</li>)}</ul>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Component</th><th className="num">Weight</th><th className="num">Score</th><th>Evidence</th></tr></thead>
            <tbody>
              {D.components.map((c) => (
                <tr key={c.key}>
                  <td className="small">{c.label}</td>
                  <td className="num">{(c.weight * 100).toFixed(0)}%</td>
                  <td className={`num ${signCls(c.score)}`}>{c.score == null ? "n/a" : c.score.toFixed(2)}</td>
                  <td className="small sec">{c.detail}</td>
                </tr>
              ))}
              {D.penalties.map((p) => <tr key={p.label}><td className="small" colSpan={2}>Penalty</td><td className="num down">-{p.points}</td><td className="small sec">{p.label}</td></tr>)}
            </tbody>
          </table>
        </details>
      </section>

      {/* ---------- Strategies ---------- */}
      <section className="panel">
        <h2>The two best options setups</h2>
        {!cons && !aggr ? (
          <div className="banner warn">{R.strategies.notes.join(" ") || "No strategies generated."}</div>
        ) : (
          <>
            <StrategyTable cons={cons} aggr={aggr} />
            {R.strategies.notes.length > 0 && <p className="tiny muted">{R.strategies.notes.join(" ")}</p>}
            <p className="tiny muted">
              {R.strategies.evaluated} structures evaluated from {R.chainsMeta.fetched.length} expirations ({R.chainsMeta.source}, fetched {R.chainsMeta.fetchedAt ? fmtEt(R.chainsMeta.fetchedAt) : "n/a"}); {R.strategies.rejectedIlliquid} rejected for liquidity.
              Entry = estimated limit (mid + 25% toward the natural price); confirm the live bid/ask before ordering. Only long options and debit spreads are ever proposed.
            </p>
            <div className="grid2" style={{ marginTop: 8 }}>
              {cons && <StrategyCard c={cons} />}
              {aggr && <StrategyCard c={aggr} />}
            </div>
          </>
        )}
      </section>

      {/* ---------- Risk ---------- */}
      <RiskPanel R={R} risk={risk} />

      {/* ---------- Chart & technicals ---------- */}
      <section className="panel">
        <h2>Price action</h2>
        <PriceChart chart={R.technical.chart} levels={R.technical.levels} plan={R.technical.plan} />
      </section>
      <TechnicalPanel R={R} />

      {/* ---------- Options ---------- */}
      <OptionsPanel R={R} />

      <section className="panel">
        <h2>Scenario simulator</h2>
        {spot ? <ScenarioSimulator candidates={allCandidates} spot={spot} r={R.riskFreeRate} /> : <p className="muted small">Requires a live price and option chain.</p>}
      </section>

      <NewsPanel R={R} />
      <BacktestPanel R={R} />
      <CoveragePanel R={R} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function probText(c: StrategyCandidate) {
  return c.popEmpirical.available ? pct(c.popEmpirical.value, 0) : "unavailable";
}

function StrategyTable({ cons, aggr }: { cons: StrategyCandidate | null; aggr: StrategyCandidate | null }) {
  const rows: [string, (c: StrategyCandidate) => React.ReactNode][] = [
    ["Direction", (c) => <span className={dirBadge(c.direction)}>{c.direction}</span>],
    ["Strategy", (c) => c.name.split(" (")[0].replace(/ Buy.*/, "")],
    ["Expiration", (c) => `${c.expiration} (${c.dte}d)`],
    ["Strike(s)", (c) => c.legs.map((l) => `${l.action === "buy" ? "+" : "-"}${l.strike}${l.type === "call" ? "C" : "P"}`).join(" / ")],
    ["Bid / Ask (legs)", (c) => c.legs.map((l) => `${num(l.bid)} / ${num(l.ask)}`).join(" · ")],
    ["Entry price (est. limit)", (c) => <>{money(c.limitPrice)} <span className="tiny muted">(mid {money(c.midDebit)}, natural {money(c.naturalDebit)})</span></>],
    ["Maximum loss", (c) => <span className="down">{money(c.maxLossPerUnit, 0)}</span>],
    ["Maximum profit", (c) => (c.maxProfitPerUnit == null ? "Unlimited" : <span className="up">{money(c.maxProfitPerUnit, 0)}</span>)],
    ["Break-even (expiration)", (c) => <>{money(c.breakeven)} <span className="tiny muted">({pct(c.breakevenMovePct, 1, true)})</span></>],
    ["Prob. of profit (historical)", (c) => <span title={c.popEmpirical.method}>{probText(c)}</span>],
    ["Market-implied (risk-neutral)", (c) => <span title={c.popModel.method}>{pct(c.popModel.value, 0)}</span>],
    ["Target exit", (c) => <>{money(c.target.price)} by day {c.target.byDay} <span className="tiny muted">est. {money(c.target.estPnl, 0)}</span></>],
    ["Max holding period", (c) => `${c.maxHoldDays} days (exit by ${c.exitByDate})`],
    ["Risk level", (c) => c.riskLevel],
  ];
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th></th><th>Conservative</th><th>Aggressive</th></tr></thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}><td className="muted small">{label}</td><td className="mono small">{cons ? f(cons) : "-"}</td><td className="mono small">{aggr ? f(aggr) : "-"}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StrategyCard({ c }: { c: StrategyCandidate }) {
  return (
    <div className="stat">
      <div className="label">{c.profile} · score {c.score.toFixed(2)}</div>
      <div style={{ fontWeight: 600, margin: "4px 0 8px" }}>{c.name}</div>
      <div className="kv">
        <span>Legs</span><span className="mono small">{c.legs.map((l) => `${l.action.toUpperCase()} ${l.symbol} · Δ${l.delta.toFixed(2)} · IV ${pct(l.iv)}${l.ivSource === "computed" ? "*" : ""} · OI ${int(l.openInterest)} · vol ${int(l.volume)}`).join("\n")}</span>
        <span>Greeks / unit</span><span className="mono small">Δ {c.netDelta.toFixed(2)} · Θ {c.thetaPerDay != null ? money(c.thetaPerDay) : "n/a"}/day{c.thetaPctPerDay != null ? ` (${pct(c.thetaPctPerDay)})` : ""} · Vega {c.netVega != null ? money(c.netVega) : "n/a"}/pt</span>
        <span>Reward / risk</span><span className="mono small">{c.rewardRisk != null ? c.rewardRisk.toFixed(2) : "open-ended"}</span>
        <span>Expectancy</span><span className="mono small" title="Average P/L over the stock's own de-meaned historical moves (no directional edge assumed)">{c.expectedValueEmpirical != null ? money(c.expectedValueEmpirical, 0) : "n/a"}</span>
        <span>Take profit</span><span className="small">{c.takeProfit}</span>
        <span>Exit / stop</span><span className="small">{c.stopLoss}</span>
      </div>
      <ul className="plain small" style={{ marginTop: 8 }}>{c.rationale.map((x, i) => <li key={i}>{x}</li>)}</ul>
      {c.warnings.length > 0 && <ul className="plain small" style={{ color: "#f5d27a" }}>{c.warnings.map((x, i) => <li key={i}>⚠ {x}</li>)}</ul>}
      <p className="tiny muted">Probability method: {c.popEmpirical.method}</p>
      {c.legs.some((l) => l.ivSource === "computed") && <p className="tiny muted">* IV solved from the mid price (provider IV unavailable).</p>}
    </div>
  );
}

function RiskPanel({ R, risk }: { R: Report; risk: RiskProfile }) {
  const sz = (c: StrategyCandidate | null) => (c ? sizePosition(risk, c.maxLossPerUnit, c.exitSlippagePerUnit, c.limitPrice * 100) : null);
  const items = [["Conservative", R.strategies.conservative, sz(R.strategies.conservative)], ["Aggressive", R.strategies.aggressive, sz(R.strategies.aggressive)]] as const;
  const feeChanged = Math.abs(risk.commissionPerContract - R.riskProfile.commissionPerContract) > 1e-9;
  return (
    <section className="panel">
      <h2>Risk management & position sizing</h2>
      <p className="small sec">
        Per-trade risk budget: <b>{money(Math.min(risk.budget * risk.maxRiskPct, risk.maxLossDollars || Infinity), 0)}</b> (the smaller of {pct(risk.maxRiskPct)} of {money(risk.budget, 0)} and {money(risk.maxLossDollars, 0)}).
        Sizing uses each structure&apos;s true maximum loss including round-trip commissions. Capital not allocated stays in cash.
      </p>
      {feeChanged && <div className="banner info small">Commission setting changed since this analysis ran; max-loss figures use {money(R.riskProfile.commissionPerContract)}/contract until you re-analyze.</div>}
      <div className="grid2">
        {items.map(([label, c, s]) => (
          <div className="stat" key={label}>
            <div className="label">{label}{risk.preference === label.toLowerCase() ? " · your preference" : ""}</div>
            {c && s ? (
              <>
                <div className="value mono">{s.contracts} unit{s.contracts === 1 ? "" : "s"}</div>
                <div className="kv small" style={{ marginTop: 6 }}>
                  <span>Max loss / unit</span><span className="mono">{money(c.maxLossPerUnit, 0)}</span>
                  <span>Worst case total</span><span className="mono down">{money(s.maxLossTotal, 0)}</span>
                  <span>Capital deployed</span><span className="mono">{money(s.capitalDeployed, 0)} ({pct(s.pctOfBudget)})</span>
                  <span>Exit slippage est.</span><span className="mono">{money(c.exitSlippagePerUnit * s.contracts, 0)}</span>
                  <span>Invalidation</span><span className="small">{R.technical.plan?.invalidation?.rule ?? "n/a"}</span>
                </div>
                <p className={`small ${s.feasible ? "sec" : ""}`} style={{ color: s.feasible ? undefined : "#f5d27a" }}>{s.note}</p>
              </>
            ) : <p className="small muted">No strategy.</p>}
          </div>
        ))}
      </div>
      <ul className="plain tiny muted" style={{ marginTop: 8 }}>
        <li>Never average down automatically; a losing defined-risk trade is closed at its stop, not added to.</li>
        <li>Stops on options should be based on the underlying&apos;s invalidation level and position value, not on wide intraday option quotes.</li>
      </ul>
    </section>
  );
}

function TechnicalPanel({ R }: { R: Report }) {
  const T = R.technical, s = T.stats, p = T.plan;
  return (
    <section className="panel">
      <h2>Technical analysis engine</h2>
      {!s ? <p className="muted small">Price history unavailable.</p> : (
        <>
          <div className="grid2">
            <div>
              <h3>Multi-timeframe read</h3>
              <table>
                <thead><tr><th>TF</th><th>Trend</th><th className="num">Score</th><th className="num">RSI</th><th>Notes</th></tr></thead>
                <tbody>
                  {T.timeframes.map((t) => (
                    <tr key={t.tf}>
                      <td className="mono">{t.tf}</td>
                      <td>{t.available ? <span className={dirBadge(t.trend)}>{t.trend}</span> : <span className="muted small">n/a</span>}</td>
                      <td className={`num ${signCls(t.score)}`}>{t.available ? t.score.toFixed(2) : "-"}</td>
                      <td className="num">{t.rsi != null ? t.rsi.toFixed(0) : "-"}</td>
                      <td className="tiny sec">{t.notes.slice(0, 3).join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {T.combined.conflicts.length > 0 && <div className="banner warn small" style={{ marginTop: 8 }}><b>Conflicting signals:</b><ul className="plain">{T.combined.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul></div>}
            </div>
            <div>
              <h3>Trade plan ({p?.direction ?? "n/a"})</h3>
              <div className="kv">
                <span>Confirms</span><span className="small">{p?.confirmation ? <><b className="mono">{money(p.confirmation.price)}</b> · {p.confirmation.rule}</> : "n/a"}</span>
                <span>Invalidates</span><span className="small">{p?.invalidation ? <><b className="mono">{money(p.invalidation.price)}</b> · {p.invalidation.rule}</> : "n/a"}</span>
                <span>Targets</span><span className="small">{p?.targets.length ? p.targets.map((t) => `${money(t.price)} (${t.label})`).join(" → ") : "n/a"}</span>
                <span>Entry quality</span><span className="small">{p?.extended ? `Extended: ${p.extendedReason}` : "Not extended"}{p?.dipZone ? ` · dip zone ${money(p.dipZone.low)}-${money(p.dipZone.high)}` : ""}</span>
                <span>Structure</span><span className="small">{T.breakout?.detail}</span>
              </div>
              <h3>Key levels</h3>
              <div className="grid2" style={{ gap: 8 }}>
                <table><thead><tr><th>Resistance</th><th className="num">★</th></tr></thead><tbody>{T.levels.resistances.map((l) => <tr key={l.price}><td className="small"><span className="mono">{money(l.price)}</span> <span className="tiny muted">{l.label}</span></td><td className="num tiny">{l.strength}</td></tr>)}</tbody></table>
                <table><thead><tr><th>Support</th><th className="num">★</th></tr></thead><tbody>{T.levels.supports.map((l) => <tr key={l.price}><td className="small"><span className="mono">{money(l.price)}</span> <span className="tiny muted">{l.label}</span></td><td className="num tiny">{l.strength}</td></tr>)}</tbody></table>
              </div>
            </div>
          </div>
          <h3>Indicators (daily)</h3>
          <div className="grid4">
            <Stat label="RSI(14)" value={num(s.rsi14, 1)} sub={s.rsi14 != null ? (s.rsi14 > 70 ? "Overbought" : s.rsi14 < 30 ? "Oversold" : "Neutral zone") : ""} />
            <Stat label="MACD hist" value={num(s.macdHist, 3)} sub={`MACD ${num(s.macd, 2)} / signal ${num(s.macdSignal, 2)}`} />
            <Stat label="Moving averages" value={<span className="small mono">20 {num(s.sma20)} · 50 {num(s.sma50)}</span>} sub={`100 ${num(s.sma100)} · 200 ${num(s.sma200)}${s.goldenCross != null ? (s.goldenCross ? " · 50>200" : " · 50<200") : ""}`} />
            <Stat label="Bollinger %B" value={num(s.bbPctB, 2)} sub={`Width ${pct(s.bbWidth)} · ${num(s.bbLower)}-${num(s.bbUpper)}`} />
            <Stat label="ATR(14)" value={money(s.atr14)} sub={`${pct(s.atrPct, 2)} of price`} />
            <Stat label="Realized vol" value={pct(s.hv20)} sub={`10d ${pct(s.hv10)} · 60d ${pct(s.hv60)} · 1y pctile ${s.hv20Percentile != null ? s.hv20Percentile.toFixed(0) : "n/a"}`} />
            <Stat label="Relative volume" value={`${num(s.relVolume, 2)}x`} sub={`20d avg ${big(s.avgVolume20)}`} />
            <Stat label="Returns" value={<span className={`small mono ${signCls(s.ret20d)}`}>20d {pct(s.ret20d, 1, true)}</span>} sub={`5d ${pct(s.ret5d, 1, true)} · 60d ${pct(s.ret60d, 1, true)}`} />
            <Stat label="vs SPY (20d / 60d)" value={<span className={`small mono ${signCls(T.rel.vsSpy20)}`}>{pct(T.rel.vsSpy20, 1, true)}</span>} sub={pct(T.rel.vsSpy60, 1, true)} />
            <Stat label={`vs sector ${T.rel.sectorEtf ?? ""}`} value={<span className={`small mono ${signCls(T.rel.vsSector20)}`}>{pct(T.rel.vsSector20, 1, true)}</span>} sub={pct(T.rel.vsSector60, 1, true)} />
            <Stat label="52-week range" value={<span className="small mono">{num(s.low52w)} - {num(s.high52w)}</span>} sub={`${pct(s.close / s.high52w - 1, 1, true)} from high`} />
            <Stat label="Gap today" value={pct(T.gaps.todayGapPct, 2, true)} sub={`${T.gaps.gaps.filter((g) => !g.filled).length} unfilled gap(s) >1.5% in 60d`} />
          </div>
          {T.gaps.gaps.length > 0 && (
            <details style={{ marginTop: 8 }}><summary className="small">Gap analysis</summary>
              <table><tbody>{T.gaps.gaps.map((g) => <tr key={g.date}><td className="mono small">{g.date}</td><td className={`num ${g.direction === "up" ? "up" : "down"}`}>{pct(g.pct, 1, true)}</td><td className="small">{g.filled ? "filled" : "unfilled"}</td></tr>)}</tbody></table>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function OptionsPanel({ R }: { R: Report }) {
  const O = R.options;
  const term = useMemo(() => (O ? O.expiries.filter((e) => e.atmIv != null).map((e) => ({ dte: e.dte, iv: Number(((e.atmIv as number) * 100).toFixed(2)), exp: e.expiration })) : []), [O]);
  if (!O) return <section className="panel"><h2>Options intelligence</h2><p className="muted small">Option chain unavailable ({R.dataNotes.find((n) => n.area.startsWith("Option"))?.detail ?? "no data provider connected"}).</p></section>;
  return (
    <section className="panel">
      <h2>Options intelligence</h2>
      <div className="grid4">
        <Stat label="30d ATM IV" value={pct(O.iv30)} sub={`HV20 ${pct(O.hv20)} · ratio ${num(O.ivHvRatio, 2)}`} />
        <Stat label="IV rank / pctile" value={O.ivRank.value != null ? `${O.ivRank.value.toFixed(0)} / ${O.ivRank.percentile?.toFixed(0)}` : "n/a"} sub={<span title={O.ivRank.note}>{O.ivRank.observations} obs. recorded</span>} />
        <Stat label="Pricing" value={<span className={`badge ${O.pricing.verdict === "rich" ? "warn" : O.pricing.verdict === "cheap" ? "bull" : ""}`}>{O.pricing.verdict.toUpperCase()}</span>} sub="vs realized vol" />
        <Stat label="Liquidity grade" value={O.liquidity.grade} sub={`median spread ${pct(O.liquidity.medianSpreadPct)}`} />
        <Stat label="Put/call (volume)" value={num(O.pcrVolume, 2)} sub={`OI ratio ${num(O.pcrOi, 2)}`} />
        <Stat label="25Δ skew" value={O.skew25 != null ? `${(O.skew25 * 100).toFixed(1)} pts` : "n/a"} sub="put IV - call IV" />
        <Stat label="Term structure" value={O.termStructure} sub="front vs 45d+" />
        <Stat label="Quote times" value={<span className="small">{O.newestQuoteMs ? ago(O.newestQuoteMs) : "n/a"}</span>} sub={O.newestQuoteMs ? fmtEt(O.newestQuoteMs) : ""} />
      </div>
      <ul className="plain small sec" style={{ marginTop: 10 }}>
        <li>{O.pricing.note}</li><li>{O.termNote}</li><li>{O.skewNote}</li><li>{O.liquidity.note}</li><li className="muted">{O.ivRank.note}</li>
      </ul>
      <div className="grid2" style={{ marginTop: 8 }}>
        <div>
          <h3>IV term structure</h3>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={term} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="#1d1e22" />
                <XAxis dataKey="dte" tick={{ fill: "#8a8a84", fontSize: 11 }} stroke="#34353b" tickFormatter={(v) => `${v}d`} />
                <YAxis tick={{ fill: "#8a8a84", fontSize: 11 }} stroke="#34353b" tickFormatter={(v) => `${v}%`} domain={["auto", "auto"]} width={44} />
                <Tooltip contentStyle={{ background: "#191a1e", border: "1px solid #34353b", borderRadius: 8, fontSize: 12 }} formatter={(v) => [`${v}%`, "ATM IV"]} labelFormatter={(v, p) => `${p?.[0]?.payload?.exp ?? ""} (${v} DTE)`} />
                <Line dataKey="iv" stroke="#3987e5" strokeWidth={2} dot={{ r: 4, fill: "#3987e5", stroke: "#131417", strokeWidth: 2 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="tablewrap">
          <h3>Expected moves by expiration</h3>
          <table>
            <thead><tr><th>Expiry</th><th className="num">DTE</th><th className="num">ATM IV</th><th className="num">Straddle</th><th className="num">Implied move</th><th className="num">P/C vol</th></tr></thead>
            <tbody>
              {O.expiries.map((e) => (
                <tr key={e.expiration}>
                  <td className="mono small">{e.expiration}{R.catalyst?.date && e.expiration >= R.catalyst.date && O.expiries.find((x) => x.expiration >= R.catalyst!.date!) === e ? " ★" : ""}</td>
                  <td className="num">{e.dte}</td>
                  <td className="num">{pct(e.atmIv)}</td>
                  <td className="num">{money(e.straddleMid)}</td>
                  <td className="num">±{pct(e.impliedMovePct)}</td>
                  <td className="num">{e.callVolume ? num(e.putVolume / e.callVolume, 2) : "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tiny muted">Implied move = ATM straddle mid / spot. ★ first expiry after the catalyst.</p>
        </div>
      </div>
      <h3>Unusual options activity (volume &gt; 1.5x open interest, ≥500 contracts)</h3>
      {O.unusual.length === 0 ? <p className="small muted">None detected in the fetched expirations.</p> : (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Contract</th><th className="num">Volume</th><th className="num">OI</th><th className="num">Vol/OI</th><th className="num">Mid</th><th className="num">Premium</th><th className="num">IV</th></tr></thead>
            <tbody>
              {O.unusual.map((u) => (
                <tr key={u.symbol}>
                  <td className="mono small"><span className={dirBadge(u.type)}>{u.type.toUpperCase()}</span> {u.strike} {u.expiration}</td>
                  <td className="num">{int(u.volume)}</td><td className="num">{int(u.openInterest)}</td><td className="num">{num(u.volOiRatio, 1)}</td>
                  <td className="num">{money(u.mid)}</td><td className="num">${big(u.premium)}</td><td className="num">{pct(u.iv)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tiny muted">Volume vs open interest cannot tell buyers from sellers or opening from closing trades; treat as a clue, not a signal.</p>
        </div>
      )}
    </section>
  );
}

function NewsPanel({ R }: { R: Report }) {
  const N = R.news;
  const groups: [string, typeof N.clusters][] = [
    ["Today", N.clusters.filter((c) => c.bucket === "today")],
    ["Past 24 hours", N.clusters.filter((c) => c.bucket === "24h")],
    ["Past 7 days", N.clusters.filter((c) => c.bucket === "7d")],
    ["Past 30 days", N.clusters.filter((c) => c.bucket === "30d")],
  ];
  return (
    <section className="panel">
      <h2>News & media intelligence</h2>
      <div className="grid4">
        <Stat label="Today" value={N.counts.today} sub="stories" />
        <Stat label="24 hours" value={N.counts.h24} />
        <Stat label="7 days" value={N.counts.d7} />
        <Stat label="30 days" value={N.counts.d30} sub={`${N.counts.rawItems} raw items → ${N.counts.deduplicated} after dedup`} />
      </div>
      <p className="tiny muted">Sentiment method: {N.sentiment.method}</p>
      {N.ai.summary && (
        <div className="banner info" style={{ marginTop: 8 }}>
          <b>Claude synthesis</b> <span className="tiny">({N.ai.model})</span>: {N.ai.summary}
          <div className="grid2" style={{ marginTop: 6 }}>
            <div><b className="small">Key risks</b><ul className="plain small">{N.ai.keyRisks.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
            <div><b className="small">Catalysts</b><ul className="plain small">{N.ai.catalysts.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          </div>
        </div>
      )}
      <p className="tiny muted">{N.ai.note}</p>
      {groups.map(([label, items]) => items.length > 0 && (
        <details key={label} open={label !== "Past 30 days"} style={{ marginTop: 10 }}>
          <summary><b>{label}</b> <span className="muted small">({items.length})</span></summary>
          {items.slice(0, 25).map((c) => <NewsRow key={c.id} c={c} />)}
        </details>
      ))}
      {N.macro.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary><b>Macro, Fed & geopolitical</b> <span className="muted small">({N.macro.length})</span></summary>
          {N.macro.map((c) => <NewsRow key={c.id} c={c} />)}
        </details>
      )}
      <div className="grid2" style={{ marginTop: 14 }}>
        <div>
          <h3>SEC filings (30 days)</h3>
          {R.filings.length === 0 ? <p className="small muted">None (or EDGAR not connected).</p> : (
            <table><tbody>{R.filings.slice(0, 15).map((f) => (
              <tr key={f.url}><td className="mono small">{f.filingDate}</td><td><a href={f.url} target="_blank" rel="noreferrer" className="small"><b>{f.form}</b> {f.description}</a><div className="tiny muted">{f.significance}</div></td></tr>
            ))}</tbody></table>
          )}
        </div>
        <div>
          <h3>Analysts & insiders</h3>
          <p className="small sec">{R.fundamentals.analyst.detail}</p>
          {R.fundamentals.upgrades ? (
            R.fundamentals.upgrades.length ? <table><tbody>{R.fundamentals.upgrades.slice(0, 8).map((u, i) => <tr key={i}><td className="mono small">{u.date}</td><td className="small">{u.company}: {u.action} {u.from ? `${u.from} → ` : ""}{u.to}</td></tr>)}</tbody></table> : <p className="small muted">No rating changes in 90 days.</p>
          ) : <p className="tiny muted">Upgrade/downgrade history unavailable on the current Finnhub plan.</p>}
          <p className="small sec">{R.fundamentals.insider.detail}</p>
          {R.fundamentals.insider.recent.length > 0 && (
            <table><tbody>{R.fundamentals.insider.recent.slice(0, 8).map((x, i) => <tr key={i}><td className="mono small">{x.date}</td><td className="small">{x.name}</td><td className="small">{x.code === "P" ? "Buy" : x.code === "S" ? "Sell" : x.code}</td><td className="num">{int(x.shares)}</td></tr>)}</tbody></table>
          )}
        </div>
      </div>
      <h3>Coverage achieved</h3>
      <ul className="plain small sec">
        {N.coverage.map((c) => <li key={c.provider}><span className={`dot ${c.status === "ok" ? "ok" : "off"}`} /> {c.provider}: {c.detail}</li>)}
        {N.notConnected.map((c) => <li key={c.name} className="muted"><span className="dot off" /> {c.name}: {c.howToConnect}</li>)}
      </ul>
    </section>
  );
}

function NewsRow({ c }: { c: Report["news"]["clusters"][number] }) {
  return (
    <div className="news-item">
      <div className="row" style={{ gap: 6 }}>
        {c.ai ? <span className={dirBadge(c.ai.impact)}>{c.ai.impact.toUpperCase()} {"●".repeat(c.ai.magnitude)}</span> : <span className={dirBadge(c.lexiconScore > 0.2 ? "bull" : c.lexiconScore < -0.2 ? "bear" : "n")}>{c.lexiconScore > 0.2 ? "POSITIVE*" : c.lexiconScore < -0.2 ? "NEGATIVE*" : "NEUTRAL*"}</span>}
        {c.ai && <span className={`badge ${c.ai.verification === "verified" ? "bull" : c.ai.verification === "reported" ? "" : "warn"}`}>{c.ai.verification}</span>}
        {c.ai && <span className="badge">priced in: {c.ai.pricedIn}</span>}
        <span className="badge">{c.kind}</span>
        <span className="tiny muted">{fmtEt(c.firstReported)}{c.ai?.eventDate ? ` · event ${c.ai.eventDate}` : ""}</span>
        {c.priceMoveSince != null && <span className={`tiny mono ${signCls(c.priceMoveSince)}`}>stock {pct(c.priceMoveSince, 1, true)} since</span>}
      </div>
      <div style={{ marginTop: 4 }}><a href={c.sources[0].url} target="_blank" rel="noreferrer">{c.headline}</a></div>
      {c.ai ? (
        <div className="small sec" style={{ marginTop: 2 }}>{c.ai.explanation} <span className="muted">Options: {c.ai.optionsImplication}</span></div>
      ) : c.summary ? <div className="small muted" style={{ marginTop: 2 }}>{c.summary.slice(0, 240)}{c.summary.length > 240 ? "..." : ""}</div> : null}
      <div className="tiny muted" style={{ marginTop: 2 }}>
        {c.sources.length} source{c.sources.length > 1 ? "s" : ""}: {c.sources.slice(0, 5).map((s, i) => <span key={i}>{i > 0 && ", "}<a href={s.url} target="_blank" rel="noreferrer">{s.source}</a></span>)}
        {!c.ai && " · *keyword heuristic, not verified"}
      </div>
    </div>
  );
}

function StudyTable({ s }: { s: StudyResult }) {
  const row = (label: string, x: StudyResult["inSample"]) => (
    <tr><td className="small">{label}</td><td className="num">{x.n}</td><td className="num">{pct(x.hitRate, 0)}</td><td className={`num ${signCls(x.mean)}`}>{pct(x.mean, 2, true)}</td><td className="num">{pct(x.median, 2, true)}</td><td className="num down">{pct(x.worst, 1, true)}</td><td className="num up">{pct(x.best, 1, true)}</td></tr>
  );
  return (
    <div className="stat">
      <div style={{ fontWeight: 600 }}>{s.name}</div>
      <p className="tiny muted" style={{ margin: "2px 0 6px" }}>{s.description}</p>
      <table>
        <thead><tr><th></th><th className="num">n</th><th className="num">Hit</th><th className="num">Mean</th><th className="num">Median</th><th className="num">Worst</th><th className="num">Best</th></tr></thead>
        <tbody>{row(`In-sample (< ${s.splitDate ?? "?"})`, s.inSample)}{row("Out-of-sample", s.outOfSample)}{row("Baseline (all periods)", s.baseline)}</tbody>
      </table>
      <p className="small" style={{ marginBottom: 0 }}>{s.verdict}</p>
    </div>
  );
}

function BacktestPanel({ R }: { R: Report }) {
  const B = R.backtest;
  return (
    <section className="panel">
      <h2>Historical testing</h2>
      <p className="small sec">All studies use actual historical daily bars from the connected provider; signals use only data available on each date, events are non-overlapping, and the last 30% of history is held out as out-of-sample. Horizon: {B.horizonDays} trading days.</p>
      {!B.similar && !B.earnings ? <p className="muted small">Not enough price history (needs 300+ daily bars).</p> : (
        <>
          <div className="grid2">
            {B.similar && <StudyTable s={B.similar} />}
            {B.breakout && <StudyTable s={B.breakout} />}
          </div>
          {B.modelSpread && (
            <div className="stat" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600 }}>Options strategy simulation (model-priced)</div>
              <p className="tiny muted" style={{ margin: "2px 0 6px" }}>{B.modelSpread.description}</p>
              {B.modelSpread.available ? (
                <table>
                  <thead><tr><th></th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">Mean return</th><th className="num">Median</th><th className="num">Worst</th></tr></thead>
                  <tbody>
                    {[["In-sample", B.modelSpread.inSample], ["Out-of-sample", B.modelSpread.outOfSample]].map(([l, x]) => {
                      const st = x as StudyResult["inSample"];
                      return <tr key={l as string}><td className="small">{l as string}</td><td className="num">{st.n}</td><td className="num">{pct(st.hitRate, 0)}</td><td className={`num ${signCls(st.mean)}`}>{pct(st.mean, 1, true)}</td><td className="num">{pct(st.median, 1, true)}</td><td className="num down">{pct(st.worst, 0, true)}</td></tr>;
                    })}
                  </tbody>
                </table>
              ) : <p className="small muted">Fewer than 5 historical occurrences; not reported.</p>}
              <details><summary className="tiny">Assumptions (read before relying on this)</summary><ul className="plain tiny muted">{B.modelSpread.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></details>
            </div>
          )}
          {B.earnings && (
            <div className="stat" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600 }}>Previous earnings reactions</div>
              <p className="small">{B.earnings.comparison}</p>
              <div className="row small mono">
                <span>Avg |move| {pct(B.earnings.avgAbsMove)}</span><span>Median |move| {pct(B.earnings.medianAbsMove)}</span>
              </div>
              <div className="tablewrap" style={{ marginTop: 6 }}>
                <table><tbody><tr>{B.earnings.reactions.slice(0, 12).map((e) => <td key={e.date} className="num tiny"><div className="muted">{e.date}</div><div className={signCls(e.movePct)}>{pct(e.movePct, 1, true)}</div></td>)}</tr></tbody></table>
              </div>
            </div>
          )}
        </>
      )}
      <p className="tiny muted">Small samples, regime changes and survivorship (this is a stock that still trades today) limit what history can say. Past frequencies are not predictions.</p>
    </section>
  );
}

function CoveragePanel({ R }: { R: Report }) {
  return (
    <section className="panel">
      <h2>Data coverage, gaps & sources</h2>
      {R.dataNotes.length === 0 ? <p className="small sec">All data sources responded.</p> : (
        <table>
          <thead><tr><th>Area</th><th>Status</th><th>Detail</th><th>How to fix</th></tr></thead>
          <tbody>{R.dataNotes.map((n, i) => <tr key={i}><td className="small">{n.area}</td><td><span className={`badge ${n.status === "ok" ? "bull" : "warn"}`}>{n.status}</span></td><td className="small sec">{n.detail}</td><td className="small muted">{n.fix ?? ""}</td></tr>)}</tbody>
        </table>
      )}
      <h3>Key supporting sources</h3>
      <ul className="plain small">
        {R.sources.slice(0, 20).map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> <span className="muted tiny">· {s.source}{s.publishedAt ? ` · ${fmtEt(s.publishedAt)}` : ""}</span></li>)}
      </ul>
      <details><summary className="tiny">Pipeline timings</summary><div className="tiny mono muted">{Object.entries(R.timingsMs).map(([k, v]) => `${k}: ${v}ms`).join(" · ")}</div></details>
    </section>
  );
}
