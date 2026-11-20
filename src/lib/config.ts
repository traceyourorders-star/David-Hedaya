
export type ProviderId = "tradier" | "finnhub" | "edgar" | "anthropic";

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  configured: boolean;
  purpose: string;
  missingHint?: string;
  dataQuality?: string;
}

const env = (k: string) => (process.env[k] ?? "").trim();

export const config = {
  tradierToken: env("TRADIER_TOKEN"),
  tradierEnv: (env("TRADIER_ENV") || "sandbox") as "sandbox" | "production",
  finnhubKey: env("FINNHUB_API_KEY"),
  secUserAgent: env("SEC_USER_AGENT"),
  anthropicKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL") || "claude-opus-5-5",
  riskFreeRate: Number(env("RISK_FREE_RATE") || "0.04"),
  monitorEnabled: env("MONITOR_ENABLED") === "true",
  monitorIntervalSec: Math.max(60, Number(env("MONITOR_INTERVAL_SECONDS") || "300")),
  databasePath: env("DATABASE_PATH") || "./data/research.db",
  // Integration-test overrides (point at a mock server). When set, every source label says so.
  tradierBaseOverride: env("TRADIER_BASE_URL"),
  finnhubBaseOverride: env("FINNHUB_BASE_URL"),
};

export function tradierBase() {
  if (config.tradierBaseOverride) return config.tradierBaseOverride;
  return config.tradierEnv === "production" ? "https://api.tradier.com/v1" : "https://sandbox.tradier.com/v1";
}

export function providerStatuses(): ProviderStatus[] {
  return [
    {
      id: "tradier",
      name: "Tradier Market Data",
      configured: !!config.tradierToken,
      purpose: "Quotes, intraday/daily/weekly/monthly bars, option expirations, option chains with greeks & IV, market clock",
      missingHint: "Set TRADIER_TOKEN (free sandbox token at developer.tradier.com gives 15-minute delayed data; a brokerage production token gives real-time).",
      dataQuality: config.tradierToken
        ? config.tradierEnv === "production"
          ? "Real-time (production token)"
          : "15-minute DELAYED (sandbox token) - quotes are not executable"
        : undefined,
    },
    {
      id: "finnhub",
      name: "Finnhub",
      configured: !!config.finnhubKey,
      purpose: "Company & market news, profile, fundamentals, analyst recommendation trends, insider transactions, earnings calendar & history",
      missingHint: "Set FINNHUB_API_KEY (free key at finnhub.io).",
    },
    {
      id: "edgar",
      name: "SEC EDGAR",
      configured: !!config.secUserAgent,
      purpose: "Regulatory filings (8-K, 10-Q, 10-K, Form 4, 13G/13D, S-3...)",
      missingHint: 'Set SEC_USER_AGENT to "AppName contact-email" as required by the SEC fair-access policy.',
    },
    {
      id: "anthropic",
      name: "Claude (Anthropic)",
      configured: !!config.anthropicKey,
      purpose: "News impact analysis, verified/rumor/speculation labelling, priced-in assessment, plain-English verdict narrative",
      missingHint: "Set ANTHROPIC_API_KEY. Without it a lexicon heuristic is used and labelled as such.",
    },
  ];
}
