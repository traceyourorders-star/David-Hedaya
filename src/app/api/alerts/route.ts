import { getDb } from "@/lib/db";
import { checkTicker } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = getDb().prepare("SELECT id, ticker, created_at, kind, severity, message, acknowledged FROM alerts ORDER BY created_at DESC LIMIT 100").all();
  return Response.json({ alerts: rows });
}

/** { action: "ack", id } or { action: "check", ticker } (run one monitor check now). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; id?: number; ticker?: string };
  if (body.action === "ack" && typeof body.id === "number") {
    getDb().prepare("UPDATE alerts SET acknowledged=1 WHERE id=?").run(body.id);
    return Response.json({ ok: true });
  }
  if (body.action === "check" && typeof body.ticker === "string") {
    try {
      const fired = await checkTicker(body.ticker.toUpperCase());
      return Response.json({ ok: true, fired });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 502 });
    }
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
