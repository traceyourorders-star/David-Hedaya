import { config } from "../config";
import { fetchJson, ProviderError } from "../http";
import { cached, Sourced } from "../cache";

export interface Filing { form: string; filingDate: string; acceptedAt: string | null; description: string; url: string; accession: string }

function headers() {
  if (!config.secUserAgent) throw new ProviderError("SEC EDGAR", "not_configured", "SEC EDGAR: SEC_USER_AGENT not set");
  return { "User-Agent": config.secUserAgent, Accept: "application/json" };
}

async function cikFor(ticker: string): Promise<string | null> {
  const map = await cached("edgar:tickers", "SEC EDGAR", 7 * 24 * 3600_000, async () => {
    const raw = await fetchJson<Record<string, { cik_str: number; ticker: string }>>("SEC EDGAR", "https://www.sec.gov/files/company_tickers.json", { headers: headers() });
    const out: Record<string, number> = {};
    for (const v of Object.values(raw)) out[v.ticker.toUpperCase()] = v.cik_str;
    return out;
  });
  const cik = map.data[ticker.toUpperCase().replace(".", "-")];
  return cik ? String(cik).padStart(10, "0") : null;
}

export async function recentFilings(ticker: string, sinceDate: string): Promise<Sourced<Filing[]>> {
  return cached(`edgar:filings:${ticker}:${sinceDate}`, "SEC EDGAR", 15 * 60_000, async () => {
    const cik = await cikFor(ticker);
    if (!cik) return [];
    const sub = await fetchJson<{
      filings: { recent: { form: string[]; filingDate: string[]; acceptanceDateTime: string[]; accessionNumber: string[]; primaryDocument: string[]; primaryDocDescription: string[] } };
    }>("SEC EDGAR", `https://data.sec.gov/submissions/CIK${cik}.json`, { headers: headers() });
    const r = sub.filings.recent;
    const out: Filing[] = [];
    for (let i = 0; i < r.form.length; i++) {
      if (r.filingDate[i] < sinceDate) continue;
      const acc = r.accessionNumber[i];
      out.push({
        form: r.form[i],
        filingDate: r.filingDate[i],
        acceptedAt: r.acceptanceDateTime?.[i] ?? null,
        description: r.primaryDocDescription?.[i] || r.form[i],
        accession: acc,
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, "")}/${r.primaryDocument[i]}`,
      });
    }
    return out;
  });
}
