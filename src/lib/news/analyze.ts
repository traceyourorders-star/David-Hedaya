import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import type { Bar } from "../types";
import { etParts, fmtEt } from "../market-time";

export type NewsKind = "company" | "market" | "filing" | "insider" | "analyst" | "earnings";

export interface NewsItem {
  headline: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: number; // epoch ms as reported by the provider
  kind: NewsKind;
  provider: string;
}

export interface AiAssessment {
  impact: "bullish" | "bearish" | "neutral";
  magnitude: number; // 1-5
  verification: "verified" | "reported" | "rumor" | "speculation";
  pricedIn: "likely" | "partially" | "unlikely" | "unclear";
  eventDate: string | null;
  explanation: string;
  optionsImplication: string;
}

export interface NewsCluster {
  id: string;
  headline: string;
  summary: string;
  kind: NewsKind;
  sources: { source: string; url: string; publishedAt: number; provider: string }[];
  firstReported: number;
  bucket: "today" | "24h" | "7d" | "30d" | "older";
  lexiconScore: number; // -1..1
  priceMoveSince: number | null;
  ai: AiAssessment | null;
}

export interface NewsReport {
  clusters: NewsCluster[];
  macro: NewsCluster[];
  counts: { today: number; h24: number; d7: number; d30: number; rawItems: number; deduplicated: number };
  sentiment: { label: "Positive" | "Negative" | "Mixed" | "Neutral" | "Unavailable"; score: number | null; method: string };
  ai: { available: boolean; model: string | null; summary: string | null; keyRisks: string[]; catalysts: string[]; note: string };
  coverage: { provider: string; status: "ok" | "unavailable" | "error"; detail: string }[];
  notConnected: { name: string; howToConnect: string }[];
}

const STOP = new Set("the a an and or of to in on for with at by from as is are was be its it this that after amid over new says said stock stocks shares inc corp co ltd".split(" "));
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
const jaccard = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};

const POS = ["beat", "beats", "surge", "surges", "soar", "soars", "record", "upgrade", "upgraded", "raises", "raised", "outperform", "strong", "growth", "approval", "approved", "wins", "partnership", "expands", "rally", "rallies", "jumps", "gains", "exceeds", "buyback", "repurchase", "tops", "bullish", "accelerat", "boost"];
const NEG = ["miss", "misses", "plunge", "plunges", "falls", "drop", "drops", "downgrade", "downgraded", "cuts", "lowers", "underperform", "weak", "lawsuit", "probe", "investigation", "recall", "delay", "delays", "bearish", "slump", "loss", "layoffs", "fraud", "decline", "warning", "warns", "halt", "subpoena", "tariff", "sinks", "tumbles", "short seller", "antitrust"];

export function lexiconScore(text: string): number {
  const t = text.toLowerCase();
  let p = 0, n = 0;
  for (const w of POS) if (t.includes(w)) p++;
  for (const w of NEG) if (t.includes(w)) n++;
  return p + n ? (p - n) / (p + n) : 0;
}

export function dedupe(items: NewsItem[]): NewsCluster[] {
  const sorted = [...items].sort((a, b) => a.publishedAt - b.publishedAt);
  const clusters: (NewsCluster & { _tok: Set<string> })[] = [];
  for (const it of sorted) {
    const tok = tokens(it.headline);
    const match = clusters.find((c) => c.kind === it.kind && jaccard(c._tok, tok) >= 0.5);
    const src = { source: it.source, url: it.url, publishedAt: it.publishedAt, provider: it.provider };
    if (match) {
      if (!match.sources.some((s) => s.url === it.url)) match.sources.push(src);
    } else {
      clusters.push({
        id: `n${clusters.length + 1}`, headline: it.headline, summary: it.summary, kind: it.kind, sources: [src],
        firstReported: it.publishedAt, bucket: "older", lexiconScore: lexiconScore(`${it.headline} ${it.summary}`), priceMoveSince: null, ai: null, _tok: tok,
      });
    }
  }
  return clusters.map(({ _tok, ...c }) => c);
}

export function bucketOf(ms: number, now: number): NewsCluster["bucket"] {
  const age = now - ms;
  if (etParts(ms).date === etParts(now).date && age >= 0) return "today";
  if (age <= 86_400_000) return "24h";
  if (age <= 7 * 86_400_000) return "7d";
  if (age <= 30 * 86_400_000) return "30d";
  return "older";
}

/** Price change from the last close before publication to the current price: a measure of what has been absorbed. */
export function moveSince(ms: number, daily: Bar[], price: number | null): number | null {
  if (!price || !daily.length) return null;
  const p = etParts(ms);
  const afterClose = p.minutes >= 16 * 60;
  const ref = [...daily].reverse().find((b) => (afterClose ? b.date <= p.date : b.date < p.date));
  return ref ? price / ref.c - 1 : null;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "summary", "key_risks", "catalysts"],
  properties: {
    summary: { type: "string", description: "3-5 sentence synthesis of what matters for the stock and its options now." },
    key_risks: { type: "array", items: { type: "string" } },
    catalysts: { type: "array", items: { type: "string" } },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "impact", "magnitude", "verification", "priced_in", "event_date", "explanation", "options_implication"],
        properties: {
          id: { type: "string" },
          impact: { type: "string", enum: ["bullish", "bearish", "neutral"] },
          magnitude: { type: "integer", description: "1 (trivial) to 5 (thesis-changing)" },
          verification: { type: "string", enum: ["verified", "reported", "rumor", "speculation"] },
          priced_in: { type: "string", enum: ["likely", "partially", "unlikely", "unclear"] },
          event_date: { type: ["string", "null"], description: "YYYY-MM-DD when the underlying event occurred, if different from publication; else null" },
          explanation: { type: "string" },
          options_implication: { type: "string" },
        },
      },
    },
  },
} as const;

interface AiOut {
  summary: string;
  key_risks: string[];
  catalysts: string[];
  items: { id: string; impact: AiAssessment["impact"]; magnitude: number; verification: AiAssessment["verification"]; priced_in: AiAssessment["pricedIn"]; event_date: string | null; explanation: string; options_implication: string }[];
}

export async function aiAnalyze(ticker: string, company: string, clusters: NewsCluster[], context: string): Promise<{ out: AiOut | null; model: string | null; error: string | null }> {
  if (!config.anthropicKey) return { out: null, model: null, error: "ANTHROPIC_API_KEY not set" };
  const top = clusters.slice(0, 40);
  if (!top.length) return { out: null, model: null, error: "No news items to analyze" };
  const lines = top.map((c) =>
    [
      `[${c.id}] (${c.kind}) first reported ${fmtEt(c.firstReported)}; ${c.sources.length} source(s): ${[...new Set(c.sources.map((s) => s.source))].join(", ")}`,
      `Headline: ${c.headline}`,
      c.summary ? `Summary: ${c.summary.slice(0, 500)}` : "",
      c.priceMoveSince != null ? `Stock move since publication (close-to-now): ${(c.priceMoveSince * 100).toFixed(2)}%` : "",
    ].filter(Boolean).join("\n"),
  );
  const client = new Anthropic({ apiKey: config.anthropicKey });
  try {
    const resp = await client.beta.messages.create({
      model: config.anthropicModel,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> } },
      system:
        "You are a buy-side equity and options analyst. Assess each news item ONLY from the text provided; never invent facts, numbers or events. " +
        "Label verification strictly: 'verified' = company press release, regulatory filing or on-record statement; 'reported' = reputable outlet reporting facts; " +
        "'rumor' = unnamed sources / 'people familiar'; 'speculation' = opinion, forecasts, social chatter. " +
        "Judge 'priced_in' using the stock move since publication when provided. Explain the likely effect on the stock AND on its options (IV, skew, event premium). Be concise.",
      messages: [
        {
          role: "user",
          content: `Ticker: ${ticker} (${company})\nMarket context: ${context}\n\nNews items (deduplicated):\n\n${lines.join("\n\n")}\n\nReturn an assessment for every item id.`,
        },
      ],
    });
    if (resp.stop_reason === "refusal") return { out: null, model: resp.model, error: "Model declined the request" };
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const parsed = JSON.parse(text) as AiOut;
    return { out: parsed, model: resp.model, error: null };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { out: null, model: null, error: "Anthropic authentication failed - check ANTHROPIC_API_KEY" };
    if (e instanceof Anthropic.RateLimitError) return { out: null, model: null, error: "Anthropic rate limit reached" };
    if (e instanceof Anthropic.APIError) return { out: null, model: null, error: `Anthropic API error ${e.status ?? ""}: ${e.message}` };
    if (e instanceof SyntaxError) return { out: null, model: null, error: "Model output was not valid JSON" };
    return { out: null, model: null, error: (e as Error).message };
  }
}

const MACRO = /\b(fed|fomc|powell|rate (cut|hike)|interest rates?|inflation|cpi|pce|jobs report|payrolls|unemployment|gdp|treasury|yields?|tariffs?|recession|geopolit|war|sanction|opec|china)\b/i;
export const isMacro = (s: string) => MACRO.test(s);
