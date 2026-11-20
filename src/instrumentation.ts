export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.MONITOR_ENABLED === "true") {
    const { startMonitor } = await import("./lib/monitor");
    startMonitor();
  }
}
