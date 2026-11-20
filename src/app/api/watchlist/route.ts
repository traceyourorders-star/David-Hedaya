import { getDb } from "@/lib/db";
import { checkTicker } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const valid = (t: unknown): t is string => typeof t === "string" && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t);

export async function GET() {
  const rows = getDb().prepare("SELECT ticker, added_at, snapshot FROM watchlist ORDER BY added_at").all() as { ticker: string; added_at: number; snapshot: string | null }[];
  return Response.json({ watchlist: rows.map((r) => ({ ticker: r.ticker, addedAt: r.added_at, snapshot: r.snapshot ? JSON.parse(r.snapshot) : null })) });
}

export async function POST(req: Request) {
  const { ticker } = (await req.json().catch(() => ({}))) as { ticker?: string };
  const t = ticker?.toUpperCase();
  if (!valid(t)) return Response.json({ error: "Invalid ticker" }, { status: 400 });
  getDb().prepare("INSERT OR IGNORE INTO watchlist (ticker, added_at) VALUES (?, ?)").run(t, Date.now());
  // take a baseline snapshot so the monitor has something to compare against
  let baselineError: string | null = null;
  try { await checkTicker(t); } catch (e) { baselineError = (e as Error).message; }
  return Response.json({ ok: true, baselineError });
}

export async function DELETE(req: Request) {
  const t = new URL(req.url).searchParams.get("ticker")?.toUpperCase();
  if (!valid(t)) return Response.json({ error: "Invalid ticker" }, { status: 400 });
  getDb().prepare("DELETE FROM watchlist WHERE ticker=?").run(t);
  return Response.json({ ok: true });
}
