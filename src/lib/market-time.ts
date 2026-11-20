// Market-time helpers (shared client/server). All market logic is in America/New_York.
import type { MarketClock } from "./types";

export const MARKET_TZ = "America/New_York";

// NYSE full-day holidays (fallback only; Tradier's clock is preferred when connected).
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const EARLY_CLOSE = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);

export function etParts(ms: number) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
    weekday: p.weekday as string,
  };
}

export function etDate(ms: number) {
  return etParts(ms).date;
}

export function isTradingDay(date: string) {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d !== 0 && d !== 6 && !HOLIDAYS.has(date);
}

export function localClock(now = Date.now()): MarketClock {
  const { date, minutes } = etParts(now);
  const close = EARLY_CLOSE.has(date) ? 13 * 60 : 16 * 60;
  let state: MarketClock["state"] = "closed";
  if (isTradingDay(date)) {
    if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) state = "premarket";
    else if (minutes >= 9 * 60 + 30 && minutes < close) state = "open";
    else if (minutes >= close && minutes < 20 * 60) state = "postmarket";
  }
  return {
    state,
    description: `Computed locally from the NYSE calendar (${state}). Connect Tradier for the authoritative exchange clock.`,
    asOf: now,
    source: "Local NYSE calendar (fallback)",
  };
}

/** Most recent completed-or-current regular session date (ET). */
export function lastSessionDate(now = Date.now()): string {
  let ms = now;
  const { date, minutes } = etParts(ms);
  if (isTradingDay(date) && minutes >= 9 * 60 + 30) return date;
  for (let i = 0; i < 10; i++) {
    ms -= 86_400_000;
    const d = etDate(ms);
    if (isTradingDay(d)) return d;
  }
  return date;
}

export function fmtEt(ms: number | null | undefined) {
  if (!ms) return "n/a";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  }).format(new Date(ms));
}

export function daysBetween(fromDate: string, toDate: string) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

export function addDays(date: string, n: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
