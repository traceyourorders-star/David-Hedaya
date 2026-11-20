import { listAnalyses } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const t = new URL(req.url).searchParams.get("ticker")?.toUpperCase() || undefined;
  return Response.json({ analyses: listAnalyses(50, t) });
}
