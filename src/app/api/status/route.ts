import { providerStatuses, config } from "@/lib/config";
import { localClock } from "@/lib/market-time";
import * as tradier from "@/lib/providers/tradier";
import { monitorStatus } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let clock = localClock();
  let clockError: string | null = null;
  if (config.tradierToken) {
    try { clock = (await tradier.getClock()).data; } catch (e) { clockError = (e as Error).message; }
  }
  let monitor;
  try { monitor = monitorStatus(); } catch (e) { monitor = { enabled: config.monitorEnabled, running: false, note: `Database unavailable: ${(e as Error).message}` }; }
  return Response.json({ providers: providerStatuses(), clock, clockError, monitor, riskFreeRate: config.riskFreeRate, serverTime: Date.now() });
}
