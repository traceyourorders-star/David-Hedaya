// TEST-ONLY mock of the Tradier + Finnhub REST shapes, used to exercise the full pipeline and UI
// end-to-end without network access. Every value is synthetic (seeded random walk + Black-Scholes)
// and every headline says it is a fixture. Never point a real deployment at this server.
//
//   node tests/e2e/mock-providers.mjs 4010
//   TRADIER_TOKEN=x TRADIER_BASE_URL=http://localhost:4010/tradier FINNHUB_API_KEY=x FINNHUB_BASE_URL=http://localhost:4010/finnhub npm start
import http from "node:http";

const PORT = Number(process.argv[2] || 4010);
const DAY = 86_400_000;

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function normCdf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2); return 0.5 * (1 + Math.sign(x) * y); }
function bs(S, K, T, r, v, type) {
  const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
  const price = type === "call" ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2) : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
  const pdf = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
  return { price, delta: type === "call" ? normCdf(d1) : normCdf(d1) - 1, gamma: pdf / (S * v * Math.sqrt(T)), vega: S * pdf * Math.sqrt(T) / 100, theta: (-S * pdf * v / (2 * Math.sqrt(T))) / 365 };
}
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const isWeekday = (ms) => { const d = new Date(ms).getUTCDay(); return d !== 0 && d !== 6; };

// Build a deterministic daily path per symbol ending yesterday-ish
const cache = new Map();
function path(sym) {
  if (cache.has(sym)) return cache.get(sym);
  const seed = [...sym].reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const r = rng(seed);
  const days = [];
  let p = sym === "SPY" ? 520 : 80 + (seed % 120);
  const drift = sym === "SPY" ? 0.0004 : 0.0011, vol = sym === "SPY" ? 0.009 : 0.022;
  const end = Date.now();
  for (let t = end - 4 * 365 * DAY; t <= end; t += DAY) {
    if (!isWeekday(t)) continue;
    const z = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    const o = p; p = p * Math.exp(drift + vol * z);
    days.push({ date: iso(t), open: +o.toFixed(2), high: +(Math.max(o, p) * (1 + r() * 0.008)).toFixed(2), low: +(Math.min(o, p) * (1 - r() * 0.008)).toFixed(2), close: +p.toFixed(2), volume: Math.round(2e7 * (0.6 + r())) });
  }
  cache.set(sym, days);
  return days;
}
function resample(days, keyFn) {
  const out = []; let cur = null, k = null;
  for (const d of days) { const kk = keyFn(d.date); if (kk !== k) { if (cur) out.push(cur); cur = { ...d }; k = kk; } else { cur.high = Math.max(cur.high, d.high); cur.low = Math.min(cur.low, d.low); cur.close = d.close; cur.volume += d.volume; } }
  if (cur) out.push(cur); return out;
}
function intraday(sym, minutes, sessions) {
  const days = path(sym).slice(-sessions);
  const r = rng(minutes * 97 + sym.length);
  const out = [];
  for (const d of days) {
    let p = d.open; const n = Math.floor(390 / minutes);
    const step = (d.close - d.open) / n;
    for (let i = 0; i < n; i++) {
      const ts = Date.parse(`${d.date}T14:30:00Z`) + i * minutes * 60_000;
      const o = p; p = o + step + (r() - 0.5) * o * 0.002 * Math.sqrt(minutes);
      out.push({ time: new Date(ts).toISOString().slice(0, 19), timestamp: ts / 1000, open: +o.toFixed(2), high: +(Math.max(o, p) * 1.0005).toFixed(2), low: +(Math.min(o, p) * 0.9995).toFixed(2), close: +p.toFixed(2), volume: Math.round(5e4 * (0.5 + r()) * minutes), vwap: +((o + p) / 2).toFixed(2) });
    }
  }
  return out;
}
function expirations() {
  const out = []; const now = Date.now();
  for (let t = now + DAY; t < now + 200 * DAY; t += DAY) if (new Date(t).getUTCDay() === 5) out.push(iso(t));
  return out;
}
function chain(sym, exp) {
  const S = path(sym).at(-1).close, T = Math.max(1, (Date.parse(exp) - Date.now()) / DAY) / 365;
  const step = S > 200 ? 5 : S > 50 ? 2.5 : 1; const out = []; const r = rng(Math.round(T * 1e4));
  for (let K = Math.round(S * 0.7 / step) * step; K <= S * 1.3; K += step) {
    for (const type of ["call", "put"]) {
      const iv = 0.36 + 0.12 * Math.max(0, (S - K) / S) + 0.02 * Math.exp(-T * 20);
      const g = bs(S, K, T, 0.04, iv, type);
      const half = Math.max(0.02, g.price * (0.015 + 0.04 * Math.abs(K / S - 1)));
      const oi = Math.round(8000 * Math.exp(-Math.abs(K / S - 1) * 12) * (0.5 + r()));
      const vol = Math.round(oi * (0.2 + r() * (K % (step * 4) === 0 ? 2.5 : 0.6)));
      out.push({ symbol: `${sym}${exp.replace(/-/g, "").slice(2)}${type[0].toUpperCase()}${String(K * 1000).padStart(8, "0")}`, option_type: type, strike: K, expiration_date: exp, bid: +Math.max(0, g.price - half).toFixed(2), ask: +(g.price + half).toFixed(2), last: +g.price.toFixed(2), volume: vol, open_interest: oi, bid_date: Date.now() - 60_000, ask_date: Date.now() - 60_000, contract_size: 100, greeks: { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, rho: 0, mid_iv: iv, bid_iv: iv - 0.005, ask_iv: iv + 0.005, updated_at: new Date().toISOString() } });
    }
  }
  return out;
}

function tradier(p, q) {
  const sym = (q.get("symbol") || q.get("symbols") || "X").toUpperCase();
  if (p === "/markets/clock") return { clock: { state: "open", description: "TEST FIXTURE clock (always open)", timestamp: Math.floor(Date.now() / 1000), next_change: "16:00" } };
  if (p === "/markets/quotes") return { quotes: { quote: sym.split(",").map((s) => { const d = path(s); const l = d.at(-1), pr = d.at(-2); return { symbol: s, description: `${s} TEST FIXTURE INC`, last: l.close, bid: +(l.close - 0.02).toFixed(2), ask: +(l.close + 0.02).toFixed(2), change: +(l.close - pr.close).toFixed(2), change_percentage: +((l.close / pr.close - 1) * 100).toFixed(2), open: l.open, high: l.high, low: l.low, prevclose: pr.close, volume: l.volume, average_volume: 2e7, week_52_high: Math.max(...d.slice(-252).map((x) => x.high)), week_52_low: Math.min(...d.slice(-252).map((x) => x.low)), trade_date: Date.now() - 30_000, bid_date: Date.now() - 30_000, ask_date: Date.now() - 30_000 }; }) } };
  if (p === "/markets/history") {
    const start = q.get("start") || "2000-01-01"; const d = path(sym).filter((x) => x.date >= start); const iv = q.get("interval");
    const rows = iv === "weekly" ? resample(d, (s) => { const t = Date.parse(s); return iso(t - new Date(t).getUTCDay() * DAY); }) : iv === "monthly" ? resample(d, (s) => s.slice(0, 7)) : d;
    return { history: { day: rows } };
  }
  if (p === "/markets/timesales") { const iv = q.get("interval"); const m = iv === "1min" ? 1 : iv === "5min" ? 5 : 15; return { series: { data: intraday(sym, m, m === 1 ? 1 : m === 5 ? 5 : 20) } }; }
  if (p === "/markets/options/expirations") return { expirations: { date: expirations() } };
  if (p === "/markets/options/chains") return { options: { option: chain(sym, q.get("expiration")) } };
  return null;
}

function finnhub(p, q) {
  const sym = (q.get("symbol") || "X").toUpperCase();
  const now = Date.now();
  if (p === "/stock/profile2") return { name: `${sym} Test Fixture Inc`, ticker: sym, exchange: "TEST", finnhubIndustry: "Semiconductors", marketCapitalization: 250000, weburl: "https://example.com" };
  if (p === "/stock/metric") return { metric: { peTTM: 31.2, beta: 1.4, grossMarginTTM: 61.5, revenueGrowthTTMYoy: 22.1 } };
  if (p === "/stock/recommendation") return [{ period: iso(now).slice(0, 8) + "01", strongBuy: 12, buy: 20, hold: 8, sell: 1, strongSell: 0 }, {}, {}, { period: "x", strongBuy: 10, buy: 19, hold: 10, sell: 2, strongSell: 0 }];
  if (p === "/stock/insider-transactions") return { data: [{ name: "FIXTURE, OFFICER", share: 1000, change: -5000, filingDate: iso(now - 9 * DAY), transactionDate: iso(now - 10 * DAY), transactionCode: "S", transactionPrice: 100 }] };
  if (p === "/calendar/earnings") {
    const d = path(sym); const past = []; for (let i = d.length - 60; i > 0 && past.length < 12; i -= 63) past.push({ date: d[i].date, epsActual: 1, epsEstimate: 0.9, hour: i % 2 ? "amc" : "bmo", quarter: 1, year: 2026, revenueActual: 1, revenueEstimate: 1, symbol: sym });
    return { earningsCalendar: [...past, { date: iso(now + 34 * DAY), epsActual: null, epsEstimate: 1.1, hour: "amc", quarter: 4, year: 2026, revenueActual: null, revenueEstimate: null, symbol: sym }] };
  }
  if (p === "/stock/upgrade-downgrade") return "FORBIDDEN";
  if (p === "/company-news") return [
    { id: 1, datetime: Math.floor((now - 2 * 3600_000) / 1000), headline: `[TEST FIXTURE] ${sym} beats estimates and raises guidance`, summary: "Synthetic fixture item used for automated UI tests.", source: "FixtureWire", url: "https://example.com/a", category: "company", related: sym },
    { id: 2, datetime: Math.floor((now - 3 * 3600_000) / 1000), headline: `[TEST FIXTURE] ${sym} beats estimates, raises guidance`, summary: "Duplicate story from a second outlet (dedup test).", source: "FixtureNews", url: "https://example.com/b", category: "company", related: sym },
    { id: 3, datetime: Math.floor((now - 3 * DAY) / 1000), headline: `[TEST FIXTURE] Regulators open probe into ${sym} pricing`, summary: "Synthetic negative item.", source: "FixtureDaily", url: "https://example.com/c", category: "company", related: sym },
    { id: 4, datetime: Math.floor((now - 12 * DAY) / 1000), headline: `[TEST FIXTURE] ${sym} announces partnership`, summary: "Synthetic item.", source: "FixtureWire", url: "https://example.com/d", category: "company", related: sym },
  ];
  if (p === "/news") return [{ id: 9, datetime: Math.floor((now - 5 * 3600_000) / 1000), headline: "[TEST FIXTURE] Fed holds rates steady, signals patience on inflation", summary: "Synthetic macro item.", source: "FixtureWire", url: "https://example.com/m", category: "general", related: "" }];
  return null;
}

http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const [, ns, ...rest] = u.pathname.split("/");
  const p = "/" + rest.join("/");
  const body = ns === "tradier" ? tradier(p, u.searchParams) : ns === "finnhub" ? finnhub(p, u.searchParams) : null;
  if (body === "FORBIDDEN") { res.writeHead(403); return res.end("{}"); }
  if (body == null) { res.writeHead(404); return res.end("{}"); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}).listen(PORT, () => console.log(`mock providers on :${PORT}`));
