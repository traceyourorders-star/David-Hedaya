import { config } from "./config";
import { getDb } from "./db";
import * as tradier from "./providers/tradier";
import * as fh from "./providers/finnhub";
import * as edgar from "./providers/edgar";
import { addDays, daysBetween, etDate, lastSessionDate } from "./market-time";
import { summarizeExpiry } from "./quant/options";
import type { Report } from "./engine/report-types";

interface Snapshot {
  at: number;
  price: number | null;
  iv30: number | null;
  atmSpreadPct: number | null;
  newsIds: number[];
  filings: string[];
  earningsDate: string | null;
}

function addAlert(ticker: string, kind: string, severity: "info" | "warning" | "critical", message: string) {
  getDb().prepare("INSERT INTO alerts (ticker, created_at, kind, severity, message) VALUES (?,?,?,?,?)").run(ticker, Date.now(), kind, severity, message);
}

function latestPlan(ticker: string): Report["technical"]["plan"] | null {
  const row = getDb().prepare("SELECT report FROM analyses WHERE ticker=? ORDER BY created_at DESC LIMIT 1").get(ticker) as { report: string } | undefined;
  if (!row) return null;
  try { return (JSON.parse(row.report) as Report).technical.plan; } catch { return null; }
}

export async function checkTicker(ticker: string): Promise<string[]> {
  const db = getDb();
  const row = db.prepare("SELECT snapshot FROM watchlist WHERE ticker=?").get(ticker) as { snapshot: string | null } | undefined;
  const prev: Snapshot | null = row?.snapshot ? JSON.parse(row.snapshot) : null;
  const today = etDate(Date.now());
  const fired: string[] = [];
  const fire = (kind: string, sev: "info" | "warning" | "critical", msg: string) => { addAlert(ticker, kind, sev, msg); fired.push(msg); };

  const snap: Snapshot = { at: Date.now(), price: null, iv30: null, atmSpreadPct: null, newsIds: [], filings: [], earningsDate: null };
  if (config.tradierToken) {
    const q = (await tradier.getQuotes([ticker], true)).data[0];
    snap.price = q?.last ?? null;
    const exps = (await tradier.getExpirations(ticker)).data;
    const target = exps.map((e) => ({ e, d: daysBetween(today, e) })).filter((x) => x.d >= 20).sort((a, b) => Math.abs(a.d - 30) - Math.abs(b.d - 30))[0];
    if (target && snap.price) {
      const chain = (await tradier.getChain(ticker, target.e, true)).data;
      const s = summarizeExpiry(chain, snap.price, target.d, config.riskFreeRate);
      snap.iv30 = s.atmIv;
      snap.atmSpreadPct = s.atmSpreadPct;
    }
  }
  if (config.finnhubKey) {
    const news = (await fh.companyNews(ticker, addDays(today, -2), today, true)).data;
    snap.newsIds = news.map((n) => n.id);
    const cal = (await fh.earningsCalendar(ticker, today, addDays(today, 120))).data;
    snap.earningsDate = cal.map((c) => c.date).sort()[0] ?? null;
    if (prev) {
      const fresh = news.filter((n) => !prev.newsIds.includes(n.id));
      for (const n of fresh.slice(0, 3)) fire("news", "info", `New headline: ${n.headline} (${n.source})`);
    }
  }
  if (config.secUserAgent) {
    const f = (await edgar.recentFilings(ticker, addDays(today, -7))).data;
    snap.filings = f.map((x) => x.accession);
    if (prev) for (const x of f.filter((x) => !prev.filings.includes(x.accession)).slice(0, 3)) fire("filing", x.form === "8-K" ? "warning" : "info", `New SEC filing: ${x.form} ${x.description}`);
  }
  if (prev) {
    if (prev.price && snap.price) {
      const mv = snap.price / prev.price - 1;
      if (Math.abs(mv) >= 0.03) fire("price", Math.abs(mv) >= 0.06 ? "critical" : "warning", `Price moved ${(mv * 100).toFixed(1)}% since last check (${prev.price.toFixed(2)} -> ${snap.price.toFixed(2)})`);
      const plan = latestPlan(ticker);
      if (plan) {
        const crossed = (lvl: number | undefined) => lvl != null && (prev.price! - lvl) * (snap.price! - lvl) < 0;
        if (crossed(plan.confirmation?.price)) fire("breakout", "critical", `Crossed the confirmation level ${plan.confirmation!.price.toFixed(2)} from the last analysis: re-run the analysis.`);
        if (crossed(plan.invalidation?.price)) fire("invalidation", "critical", `Crossed the invalidation level ${plan.invalidation!.price.toFixed(2)}: the last thesis is invalid.`);
      }
    }
    if (prev.iv30 && snap.iv30 && Math.abs(snap.iv30 / prev.iv30 - 1) >= 0.15) fire("iv", "warning", `30-day ATM IV changed from ${(prev.iv30 * 100).toFixed(1)}% to ${(snap.iv30 * 100).toFixed(1)}%`);
    if (prev.atmSpreadPct != null && snap.atmSpreadPct != null && snap.atmSpreadPct > Math.max(0.1, prev.atmSpreadPct * 2)) fire("liquidity", "warning", `ATM option spread widened to ${(snap.atmSpreadPct * 100).toFixed(1)}% of mid`);
    if (snap.earningsDate && snap.earningsDate !== prev.earningsDate) fire("earnings", "warning", `Earnings date ${prev.earningsDate ? `changed from ${prev.earningsDate} to` : "announced:"} ${snap.earningsDate}`);
  }
  db.prepare("UPDATE watchlist SET snapshot=? WHERE ticker=?").run(JSON.stringify(snap), ticker);
  if (snap.iv30) {
    try { db.prepare("INSERT OR REPLACE INTO iv_history (ticker,date,atm_iv,source) VALUES (?,?,?,?)").run(ticker, lastSessionDate(), snap.iv30, "monitor ATM ~30d"); } catch { /* ignore */ }
  }
  return fired;
}

export async function runMonitorCycle() {
  const db = getDb();
  const tickers = (db.prepare("SELECT ticker FROM watchlist").all() as { ticker: string }[]).map((r) => r.ticker);
  let lastError: string | null = null;
  for (const t of tickers) {
    try { await checkTicker(t); } catch (e) { lastError = `${t}: ${(e as Error).message}`; }
  }
  db.prepare("UPDATE monitor_status SET heartbeat_at=?, last_error=? WHERE id=1").run(Date.now(), lastError);
}

const g = globalThis as unknown as { __monitorTimer?: ReturnType<typeof setInterval> };

export function startMonitor() {
  if (!config.monitorEnabled || g.__monitorTimer) return;
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO monitor_status (id, started_at, heartbeat_at, last_error, interval_sec) VALUES (1, ?, NULL, NULL, ?)").run(Date.now(), config.monitorIntervalSec);
  g.__monitorTimer = setInterval(() => { runMonitorCycle().catch(() => {}); }, config.monitorIntervalSec * 1000);
  runMonitorCycle().catch(() => {});
}

export function monitorStatus() {
  const row = getDb().prepare("SELECT started_at, heartbeat_at, last_error, interval_sec FROM monitor_status WHERE id=1").get() as
    | { started_at: number; heartbeat_at: number | null; last_error: string | null; interval_sec: number }
    | undefined;
  const running = !!row?.heartbeat_at && Date.now() - row.heartbeat_at < (row.interval_sec * 2 + 60) * 1000 && !!g.__monitorTimer;
  return {
    enabled: config.monitorEnabled,
    running,
    startedAt: row?.started_at ?? null,
    lastHeartbeat: row?.heartbeat_at ?? null,
    lastError: row?.last_error ?? null,
    intervalSec: config.monitorIntervalSec,
    note: !config.monitorEnabled
      ? "Monitoring is OFF. Set MONITOR_ENABLED=true and keep the server running to monitor the watchlist."
      : running ? `Running in the server process; checks the watchlist every ${config.monitorIntervalSec}s.` : "Enabled but no recent heartbeat: the monitor is not currently confirmed running.",
  };
}
