"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProgressEvent, Report } from "@/lib/engine/report-types";
import { DEFAULT_RISK, type RiskProfile } from "@/lib/quant/risk";
import { fmtEt } from "@/lib/market-time";
import { ago, money } from "@/lib/format";
import ReportView from "./ReportView";
import Sidebar from "./Sidebar";

interface Status {
  providers: { id: string; name: string; configured: boolean; purpose: string; missingHint?: string; dataQuality?: string }[];
  clock: { state: string; description: string; asOf: number; source: string };
  clockError: string | null;
  monitor: { enabled: boolean; running: boolean; note: string; lastHeartbeat?: number | null };
}

interface Step { step: string; status: "running" | "done" | "skipped" | "error"; detail?: string }

const RISK_KEY = "oi.risk.v1";

function loadRisk(): RiskProfile {
  try {
    const raw = localStorage.getItem(RISK_KEY);
    if (raw) return { ...DEFAULT_RISK, ...JSON.parse(raw) };
  } catch { /* storage may be unavailable */ }
  return DEFAULT_RISK;
}

export default function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [ticker, setTicker] = useState("");
  const [risk, setRisk] = useState<RiskProfile>(DEFAULT_RISK);
  const [showRisk, setShowRisk] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setRisk(loadRisk());
    fetch("/api/status").then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);

  const updateRisk = (patch: Partial<RiskProfile>) => {
    setRisk((r) => {
      const next = { ...r, ...patch };
      try { localStorage.setItem(RISK_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const analyze = useCallback(async (sym?: string) => {
    const t = (sym ?? ticker).trim().toUpperCase();
    if (!t) return;
    setTicker(t);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setError(null);
    setSteps([]);
    try {
      const res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker: t, risk }), signal: ctrl.signal });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as ProgressEvent;
          if (ev.type === "progress") {
            setSteps((s) => {
              const i = s.findIndex((x) => x.step === ev.step);
              const item = { step: ev.step, status: ev.status, detail: ev.detail };
              if (i >= 0) { const c = [...s]; c[i] = item; return c; }
              return [...s, item];
            });
          } else if (ev.type === "report") {
            setReport(ev.report);
            setRefreshKey((k) => k + 1);
          } else if (ev.type === "error") {
            setError(ev.message);
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [ticker, risk]);

  const loadHistorical = async (id: number) => {
    const r = await fetch(`/api/history/${id}`).then((x) => x.json());
    if (r.report) { setReport(r.report); setSteps([]); setError(null); setTicker(r.report.ticker); }
  };

  const configured = status?.providers.filter((p) => p.configured).length ?? 0;
  const tradier = status?.providers.find((p) => p.id === "tradier");

  return (
    <>
      <header className="topbar">
        <div className="row">
          <span className="brand"><b>&#9632;</b> OPTIONS<b>/</b>INTELLIGENCE</span>
          {status && (
            <span className="pill" title={status.clock.description}>
              <span className={`dot ${status.clock.state === "open" ? "ok" : status.clock.state === "closed" ? "off" : "warn"}`} />
              Market {status.clock.state.toUpperCase()} <span className="muted">· {status.clock.source}</span>
            </span>
          )}
        </div>
        <div className="row">
          {status?.providers.map((p) => (
            <span key={p.id} className="pill" title={p.configured ? `${p.purpose}${p.dataQuality ? ` - ${p.dataQuality}` : ""}` : p.missingHint}>
              <span className={`dot ${p.configured ? (p.id === "tradier" && p.dataQuality?.includes("DELAYED") ? "warn" : "ok") : "off"}`} />
              {p.name}
            </span>
          ))}
          {status && (
            <span className="pill" title={status.monitor.note}>
              <span className={`dot ${status.monitor.running ? "ok" : "off"}`} />
              Monitor {status.monitor.running ? "running" : status.monitor.enabled ? "not confirmed" : "off"}
            </span>
          )}
        </div>
      </header>

      <div className="shell">
        <main className="stack">
          <section className="panel">
            <form className="search" onSubmit={(e) => { e.preventDefault(); analyze(); }}>
              <input
                className="ticker" value={ticker} placeholder="Enter ticker (NVDA, TSLA, AAPL...)" aria-label="Ticker symbol"
                onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9.\-]/g, ""))} maxLength={10} autoFocus
              />
              <button className="btn primary" type="submit" disabled={running || !ticker}>{running ? "Researching..." : "Analyze"}</button>
              {report && !running && <button className="btn" type="button" onClick={() => analyze(report.ticker)} title="Re-fetch prices, chains and news, bypassing the cache">Refresh</button>}
              <button className="btn" type="button" onClick={() => setShowRisk((s) => !s)}>Risk settings {showRisk ? "▲" : "▼"}</button>
            </form>
            <div className="small muted" style={{ marginTop: 8 }}>
              Budget {money(risk.budget, 0)} · max {(risk.maxRiskPct * 100).toFixed(1)}% / {money(risk.maxLossDollars, 0)} per trade · {risk.preference} · {risk.holdingDays}-day horizon · {money(risk.commissionPerContract)}/contract
            </div>
            {showRisk && <RiskSettings risk={risk} onChange={updateRisk} />}
            {status && configured < 4 && (
              <div className="banner warn" style={{ marginTop: 12 }}>
                <b>{4 - configured} data source(s) not connected.</b> The app never substitutes made-up data, so the sections depending on them will be marked unavailable.
                <ul className="plain small" style={{ marginTop: 6 }}>
                  {status.providers.filter((p) => !p.configured).map((p) => <li key={p.id}><b>{p.name}</b>: {p.missingHint}</li>)}
                </ul>
              </div>
            )}
            {tradier?.configured && tradier.dataQuality?.includes("DELAYED") && (
              <div className="banner info" style={{ marginTop: 12 }}>Tradier sandbox data is delayed ~15 minutes. All prices are indicative, not executable quotes.</div>
            )}
          </section>

          {(running || steps.length > 0) && (
            <section className="panel">
              <h2>Research pipeline {running ? "· running" : "· complete"}</h2>
              <div className="steps">
                {steps.map((s) => (
                  <div key={s.step} className={`step ${s.status}`} title={s.detail}>
                    <span className="ic">{s.status === "done" ? "✓" : s.status === "error" ? "✕" : s.status === "skipped" ? "–" : "◌"}</span>
                    <span>{s.step}{s.status !== "done" && s.status !== "running" && <span className="muted"> ({s.status})</span>}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {error && <div className="banner bad"><b>Analysis failed:</b> {error}</div>}

          {report ? (
            <ReportView key={refreshKey} report={report} risk={risk} />
          ) : (
            !running && (
              <section className="panel empty">
                Enter a ticker to run the full research workflow: live quote, multi-timeframe technicals, the real option chain,
                news and filings, historical studies, two defined-risk strategies and a final decision.
              </section>
            )
          )}
          {report && <p className="tiny muted">Report generated {fmtEt(report.generatedAt)} ({ago(report.generatedAt)}). Saved as analysis #{report.analysisId ?? "n/a"}.</p>}
        </main>
        <Sidebar onAnalyze={analyze} onOpen={loadHistorical} current={report?.ticker ?? null} refreshKey={refreshKey} />
      </div>
      <p className="disclaimer">
        Research and decision-support tool, not investment advice. Options can lose 100% of the premium paid, and a correct directional call can still lose money through time decay or falling implied volatility.
        Conviction scores measure the strength and agreement of evidence, not a probability of profit. No brokerage account is connected and no orders are ever placed.
      </p>
    </>
  );
}

function RiskSettings({ risk, onChange }: { risk: RiskProfile; onChange: (p: Partial<RiskProfile>) => void }) {
  const f = (label: string, el: React.ReactNode, hint?: string) => (
    <label className="col small" style={{ gap: 4 }}>
      <span className="muted">{label}</span>
      {el}
      {hint && <span className="tiny muted">{hint}</span>}
    </label>
  );
  const numIn = (v: number, set: (n: number) => void, step = 1) => (
    <input type="number" value={Number.isFinite(v) ? v : 0} step={step} onChange={(e) => set(Number(e.target.value))} />
  );
  return (
    <div className="grid3" style={{ marginTop: 14, gap: 12 }}>
      {f("Total trading budget ($)", numIn(risk.budget, (n) => onChange({ budget: n }), 500), "Capital set aside for options; the app never assumes you deploy it all.")}
      {f("Max risk per trade (% of budget)", numIn(+(risk.maxRiskPct * 100).toFixed(2), (n) => onChange({ maxRiskPct: n / 100 }), 0.5), "1-2% is a common professional limit.")}
      {f("Max acceptable loss per trade ($)", numIn(risk.maxLossDollars, (n) => onChange({ maxLossDollars: n }), 25), "The smaller of this and the % limit binds.")}
      {f("Preference", (
        <select value={risk.preference} onChange={(e) => onChange({ preference: e.target.value as RiskProfile["preference"] })}>
          <option value="conservative">Conservative</option>
          <option value="aggressive">Aggressive</option>
        </select>
      ))}
      {f("Intended holding period (days)", numIn(risk.holdingDays, (n) => onChange({ holdingDays: n })), "Drives the backtest horizon, scenarios and time stops.")}
      {f("Commission per contract ($)", numIn(risk.commissionPerContract, (n) => onChange({ commissionPerContract: n }), 0.05), "Charged on entry and exit, per leg.")}
      <p className="tiny muted" style={{ gridColumn: "1 / -1", margin: 0 }}>Changes to sizing apply instantly below; holding period and commissions are used by the strategy engine on the next analysis.</p>
    </div>
  );
}
