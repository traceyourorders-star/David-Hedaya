import { runResearch } from "@/lib/engine/research";
import type { ProgressEvent } from "@/lib/engine/report-types";
import { DEFAULT_RISK, type RiskProfile } from "@/lib/quant/risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function sanitizeRisk(r: Partial<RiskProfile> | undefined): RiskProfile {
  const n = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    budget: n(r?.budget, DEFAULT_RISK.budget, 100, 1e9),
    maxRiskPct: n(r?.maxRiskPct, DEFAULT_RISK.maxRiskPct, 0.001, 0.25),
    maxLossDollars: n(r?.maxLossDollars, DEFAULT_RISK.maxLossDollars, 0, 1e8),
    preference: r?.preference === "aggressive" ? "aggressive" : "conservative",
    holdingDays: Math.round(n(r?.holdingDays, DEFAULT_RISK.holdingDays, 1, 120)),
    commissionPerContract: n(r?.commissionPerContract, DEFAULT_RISK.commissionPerContract, 0, 10),
  };
}

/** Streams newline-delimited JSON progress events, ending with the full report. */
export async function POST(req: Request) {
  let body: { ticker?: string; risk?: Partial<RiskProfile> };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const ticker = (body.ticker ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return Response.json({ error: "Invalid ticker symbol" }, { status: 400 });
  const risk = sanitizeRisk(body.risk);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ProgressEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        const report = await runResearch(ticker, risk, send, true);
        send({ type: "report", report });
      } catch (e) {
        send({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
