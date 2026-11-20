# Options Intelligence

A research and decision-support app for stock options. You enter a ticker. The app pulls the quote, multi-timeframe price history, the real option chain, news and SEC filings. It runs technical, volatility, flow and historical studies, builds two defined-risk strategies, sizes them to your risk limits, and gives a final call: **BUY CALLS / BUY PUTS / USE A DEBIT SPREAD / WAIT / NO TRADE**, plus a timing call and the price levels that would change it.

> Not investment advice. No brokerage is connected and no orders are ever placed.

## Quick start

```bash
npm install
cp .env.example .env.local     # add your keys (see below)
npm run build && npm start     # or: npm run dev
# open http://localhost:3000
```

Node 22.13+ is required; the research database uses the built-in `node:sqlite`.

## Data sources and what each one unlocks

| Variable | Provider | Unlocks | Without it |
|---|---|---|---|
| `TRADIER_TOKEN`, `TRADIER_ENV` | [Tradier](https://developer.tradier.com) | Quote, 1m/5m/15m/hourly/daily/weekly/monthly bars, SPY and sector ETF benchmarks, expirations, option chains with greeks and IV, exchange clock | No price, technicals, options or strategies. The verdict is **NO TRADE** and says why |
| `FINNHUB_API_KEY` | [Finnhub](https://finnhub.io) | Company and market news, profile/sector, fundamentals, analyst trends, insider transactions, earnings calendar and history | News, analyst, insider, earnings and catalyst sections are marked unavailable |
| `SEC_USER_AGENT` | SEC EDGAR (free) | 8-K, 10-Q/K, Form 4, 13D/G, S-3 and other filings | Filings section unavailable |
| `ANTHROPIC_API_KEY` | Claude | For each story: impact, magnitude, whether it is verified, reported, rumor or speculation, whether it looks priced in, and its options implications; plus a synthesis, risks and catalysts | A keyword heuristic is used instead, and labelled as such |

A **sandbox** Tradier token gives **15-minute delayed** data, so the UI labels every price as indicative and never as an executable quote. A production (brokerage) token gives real-time data. Even then, the app marks quotes executable only when the market is open and the last trade is under 2 minutes old.

Not connected, and stated in the app: Reddit, X, and full-text Bloomberg/Reuters/WSJ (licensed feeds). Their headlines appear only when Finnhub's aggregator carries them.

## How the pipeline works

`POST /api/analyze` streams progress events (NDJSON) and finishes with the full report. The report is saved to SQLite (`/api/history`).

1. **Market state**: exchange clock (with a local NYSE-calendar fallback), quote age, and whether the quote is executable or indicative.
2. **Technical engine** (`src/lib/quant/technical.ts`, `indicators.ts`):
   - Indicators: RSI, MACD, VWAP, SMA 20/50/100/200, Bollinger, ATR, realized volatility (10/20/60 and its 1-year percentile), relative volume.
   - Gaps, swing-pivot support/resistance clustering, 20-day breakouts, relative strength versus SPY and the sector ETF.
   - Seven timeframes are scored and weighted, and conflicts between them are spelled out.
   - The trade plan gives confirmation price, invalidation price, targets, dip zone and whether the move is extended.
3. **Options engine** (`options.ts`):
   - ATM IV per expiration, 30-day IV interpolated in variance space, straddle-implied moves, term structure, 25-delta skew.
   - Put/call ratios, unusual activity (volume above 1.5× open interest), liquidity grade, and IV versus realized ("rich / fair / cheap").
   - IV rank is shown **only** once the app has recorded 20 or more daily IV observations itself, because the provider has no IV history.
4. **Strategies** (`strategies.ts`): long calls/puts and debit verticals only, never naked shorts. They are built from real bid/ask quotes.
   - Each candidate gets the estimated limit (mid + 25% toward the natural price), max loss including round-trip commissions, max profit, break-even, greeks and theta burden, a target-exit estimate, take-profit and stop rules, and a time stop.
   - Candidates are scored separately for the conservative and aggressive profiles. Picks that fit your per-trade risk limit are preferred.
   - **Probability of profit** comes from the stock's own historical moves over the same horizon (de-meaned, at least 8 independent windows). Otherwise it shows as *unavailable*. The risk-neutral Black-Scholes figure appears separately as a market-implied reference.
5. **Historical testing** (`backtest.ts`), on real daily bars:
   - Studies: setups like today's, 20-day breakouts/breakdowns, past earnings reactions versus the current implied move, and a debit-spread simulation.
   - Signals use only trailing data. Events don't overlap, and the last 30% of history is held out-of-sample against an unconditional baseline.
   - Option prices in the spread simulation are **modelled** (no historical option quotes), and the report says so.
6. **News** (`news/analyze.ts`): deduplicates stories across outlets and keeps the earliest timestamp. Stories are grouped into today, 24h, 7d and 30d, and each shows the stock's move since publication as a priced-in measure. Macro, Fed and geopolitical headlines get their own feed. Claude labels each story using structured outputs.
7. **Decision engine** (`engine/decision.ts`):
   - Seven weighted components: technicals, momentum, news, analysts and insiders, SPY regime, relative strength, options positioning.
   - Conviction = strength × agreement × data coverage, minus explicit penalties (timeframe conflicts, poor liquidity, earnings within 7 days, rich IV, no tradable structure). It is **not** a probability.
   - Outputs: the verdict, the timing call (BUY NOW / WAIT FOR A DIP / WAIT FOR BREAKOUT CONFIRMATION / WAIT UNTIL AFTER EARNINGS / AVOID), the trigger levels, bull/base/bear ranges with their assumptions, and six plain-English answers.
8. **Risk** (`quant/risk.ts`): units = floor(min(budget × risk %, max loss $) / true max loss per unit). If one unit is too big, the app says to skip the trade rather than override your limit. It never averages down.
9. **Scenario simulator**: Black-Scholes repricing at ±2/5/10/15%, flat, at several dates, with an IV shift slider (collapse or expansion). Expiration payoff is shown separately, and there's a P/L chart.

## Monitoring

Add tickers to the watchlist in the sidebar. Each check compares with the previous snapshot. It flags:

- moves of 3% or more
- crossing the last analysis's confirmation or invalidation level
- a 15% or larger change in 30-day IV
- the ATM spread widening
- new headlines
- new SEC filings
- earnings date changes

The **Check** button runs a check on demand. To run checks on a schedule, set `MONITOR_ENABLED=true` and keep the server running. The monitor then runs inside the Next.js process (`src/instrumentation.ts`) and writes a heartbeat. The UI reports it as *running* only while heartbeats are recent.

## Testing

```bash
npm test          # unit tests: pricing, indicators (incl. no-look-ahead), strategies, sizing, backtests, decision, parsers, clock
npm run typecheck
```

End-to-end without network access: `tests/e2e/mock-providers.mjs` serves **synthetic fixture data** in the Tradier and Finnhub response shapes. Pointing the app at it requires the test-only overrides `TRADIER_BASE_URL` / `FINNHUB_BASE_URL`. When they are set, every source label reads "TEST ENDPOINT" and the report shows a red "TEST FIXTURE DATA" banner. Never use these overrides with real money decisions.

```bash
node tests/e2e/mock-providers.mjs 4010 &
TRADIER_TOKEN=x TRADIER_BASE_URL=http://localhost:4010/tradier FINNHUB_API_KEY=x FINNHUB_BASE_URL=http://localhost:4010/finnhub npm start
```

## What works vs. what needs more

**Working now:**
- Everything above, given the API keys.
- Graceful degradation with explicit gap reporting when keys are missing or a plan tier blocks an endpoint (e.g. Finnhub upgrades/downgrades need premium).

**Needs credentials, subscriptions or more engineering:**
- Real-time quotes (Tradier production token).
- Historical option quotes for true options backtests (e.g. ORATS, Polygon options, CBOE DataShop). Until then, option backtests are model-priced and labelled.
- Social sentiment (Reddit/X APIs).
- Licensed full-text news.
- Push/email delivery of alerts (alerts are currently in-app).
- A separate always-on worker if you deploy serverless: the in-process monitor needs a long-running Node server.
- Brokerage connectivity is intentionally absent.
