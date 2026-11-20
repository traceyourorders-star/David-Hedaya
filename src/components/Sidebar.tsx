"use client";

import { useCallback, useEffect, useState } from "react";
import { ago } from "@/lib/format";

interface HistRow { id: number; ticker: string; created_at: number; verdict: string; conviction: number; price: number | null }
interface WatchRow { ticker: string; addedAt: number; snapshot: { at: number; price: number | null; iv30: number | null } | null }
interface AlertRow { id: number; ticker: string; created_at: number; kind: string; severity: string; message: string; acknowledged: number }

export default function Sidebar({ onAnalyze, onOpen, current, refreshKey }: { onAnalyze: (t: string) => void; onOpen: (id: number) => void; current: string | null; refreshKey: number }) {
  const [hist, setHist] = useState<HistRow[]>([]);
  const [watch, setWatch] = useState<WatchRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/history").then((r) => r.json()).then((j) => setHist(j.analyses ?? [])).catch(() => {});
    fetch("/api/watchlist").then((r) => r.json()).then((j) => setWatch(j.watchlist ?? [])).catch(() => {});
    fetch("/api/alerts").then((r) => r.json()).then((j) => setAlerts(j.alerts ?? [])).catch(() => {});
  }, []);
  useEffect(load, [load, refreshKey]);

  const add = async (t: string) => {
    const r = await fetch("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker: t }) }).then((x) => x.json());
    setMsg(r.baselineError ? `Added ${t}; baseline snapshot failed: ${r.baselineError}` : `Added ${t} with a baseline snapshot.`);
    load();
  };
  const remove = async (t: string) => { await fetch(`/api/watchlist?ticker=${t}`, { method: "DELETE" }); load(); };
  const check = async (t: string) => {
    const r = await fetch("/api/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "check", ticker: t }) }).then((x) => x.json());
    setMsg(r.ok ? `${t}: ${r.fired.length} new alert(s).` : `${t}: ${r.error}`);
    load();
  };
  const ack = async (id: number) => { await fetch("/api/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ack", id }) }); load(); };

  const open = alerts.filter((a) => !a.acknowledged);
  return (
    <aside className="stack">
      <section className="panel">
        <h2>Watchlist & monitoring</h2>
        {current && !watch.some((w) => w.ticker === current) && <button className="btn small" onClick={() => add(current)}>+ Watch {current}</button>}
        {msg && <p className="tiny sec">{msg}</p>}
        {watch.length === 0 ? <p className="small muted">No tickers watched. Monitoring checks price moves, level crosses from the last analysis, IV changes, option liquidity, new headlines, filings and earnings dates.</p> : (
          <table>
            <tbody>
              {watch.map((w) => (
                <tr key={w.ticker}>
                  <td><button className="btn link mono" onClick={() => onAnalyze(w.ticker)}>{w.ticker}</button></td>
                  <td className="tiny muted">{w.snapshot ? `checked ${ago(w.snapshot.at)}` : "no snapshot"}</td>
                  <td className="right"><button className="btn small" onClick={() => check(w.ticker)} title="Run one monitoring check now">Check</button> <button className="btn small" onClick={() => remove(w.ticker)} aria-label={`Remove ${w.ticker}`}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="panel">
        <h2>Alerts {open.length ? `(${open.length})` : ""}</h2>
        {alerts.length === 0 ? <p className="small muted">No alerts yet.</p> : alerts.slice(0, 25).map((a) => (
          <div key={a.id} className="news-item small" style={{ opacity: a.acknowledged ? 0.5 : 1 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span><span className={`badge ${a.severity === "critical" ? "bear" : a.severity === "warning" ? "warn" : ""}`}>{a.severity === "critical" ? "▲ CRITICAL" : a.severity === "warning" ? "! WARNING" : "i INFO"}</span> <b className="mono">{a.ticker}</b></span>
              <span className="tiny muted">{ago(a.created_at)}</span>
            </div>
            <div className="sec" style={{ marginTop: 4 }}>{a.message}</div>
            {!a.acknowledged && <button className="btn link tiny" onClick={() => ack(a.id)}>Acknowledge</button>}
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>Research history</h2>
        {hist.length === 0 ? <p className="small muted">Analyses are saved here automatically.</p> : (
          <table>
            <tbody>
              {hist.slice(0, 30).map((h) => (
                <tr key={h.id}>
                  <td><button className="btn link mono" onClick={() => onOpen(h.id)}>{h.ticker}</button></td>
                  <td className="tiny">{h.verdict}<div className="muted">conv. {h.conviction}</div></td>
                  <td className="tiny muted right">{ago(h.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </aside>
  );
}
