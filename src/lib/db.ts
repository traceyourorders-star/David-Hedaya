import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = config.databasePath;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY, source TEXT NOT NULL, fetched_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, created_at INTEGER NOT NULL,
      verdict TEXT NOT NULL, conviction INTEGER NOT NULL, price REAL, report TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_analyses_ticker ON analyses(ticker, created_at);
    CREATE TABLE IF NOT EXISTS iv_history (
      ticker TEXT NOT NULL, date TEXT NOT NULL, atm_iv REAL NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY (ticker, date)
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      ticker TEXT PRIMARY KEY, added_at INTEGER NOT NULL, snapshot TEXT
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, created_at INTEGER NOT NULL,
      kind TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS monitor_status (
      id INTEGER PRIMARY KEY CHECK (id = 1), started_at INTEGER, heartbeat_at INTEGER, last_error TEXT, interval_sec INTEGER
    );
  `);
  return db;
}

export interface AnalysisRow {
  id: number;
  ticker: string;
  created_at: number;
  verdict: string;
  conviction: number;
  price: number | null;
}

export function saveAnalysis(ticker: string, verdict: string, conviction: number, price: number | null, report: unknown): number {
  const r = getDb()
    .prepare("INSERT INTO analyses (ticker, created_at, verdict, conviction, price, report) VALUES (?,?,?,?,?,?)")
    .run(ticker, Date.now(), verdict, conviction, price, JSON.stringify(report));
  return Number(r.lastInsertRowid);
}

export function listAnalyses(limit = 50, ticker?: string): AnalysisRow[] {
  const d = getDb();
  const rows = ticker
    ? d.prepare("SELECT id,ticker,created_at,verdict,conviction,price FROM analyses WHERE ticker=? ORDER BY created_at DESC LIMIT ?").all(ticker, limit)
    : d.prepare("SELECT id,ticker,created_at,verdict,conviction,price FROM analyses ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows as unknown as AnalysisRow[];
}

export function getAnalysis(id: number): unknown | null {
  const row = getDb().prepare("SELECT report FROM analyses WHERE id=?").get(id) as { report: string } | undefined;
  return row ? JSON.parse(row.report) : null;
}

export function recordIv(ticker: string, date: string, atmIv: number, source: string) {
  getDb().prepare("INSERT OR REPLACE INTO iv_history (ticker,date,atm_iv,source) VALUES (?,?,?,?)").run(ticker, date, atmIv, source);
}

export function ivHistory(ticker: string, sinceDate: string): { date: string; atm_iv: number }[] {
  return getDb()
    .prepare("SELECT date, atm_iv FROM iv_history WHERE ticker=? AND date>=? ORDER BY date")
    .all(ticker, sinceDate) as unknown as { date: string; atm_iv: number }[];
}
