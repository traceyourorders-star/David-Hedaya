import { getAnalysis } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const report = getAnalysis(Number(id));
  if (!report) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ report });
}
