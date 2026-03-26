// ══════════════════════════════════════════════════════════════════════════════
// FMP API CLIENT — all HTTP calls go through here
// Uses the /stable/ API (v3 was deprecated Aug 2025)
// ══════════════════════════════════════════════════════════════════════════════

const FMP_BASE = "https://financialmodelingprep.com/stable";

export class FMPClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    // In-memory cache keyed by "endpoint|paramString" — lives for one client instance
    this._cache = new Map();
    this.callCount = 0;
  }

  async fetch(endpoint, params = {}) {
    const cacheKey = endpoint + "|" + JSON.stringify(params);
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const url = new URL(`${FMP_BASE}/${endpoint}`);
    url.searchParams.set("apikey", this.apiKey);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

    this.callCount++;
    const response = await globalThis.fetch(url.toString());

    if (!response.ok) {
      throw new Error(`FMP API error: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();

    // FMP sometimes returns non-JSON error strings with 200 status
    if (text.startsWith("Premium") || text.startsWith("Query Error")) {
      throw new Error(`FMP: ${text.slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`FMP: unexpected response — ${text.slice(0, 200)}`);
    }

    // Surface FMP's own error messages (they return 200 with an error key)
    if (data && data["Error Message"]) {
      throw new Error(`FMP: ${data["Error Message"]}`);
    }

    this._cache.set(cacheKey, data);
    return data;
  }

  // ── Convenience methods ──────────────────────────────────────────────────
  // Stable API: ticker is passed as ?symbol= query param (not in URL path)
  // Free tier limit: max 5 for financial statement endpoints

  async incomeStatement(ticker, period = "quarter", limit = 5) {
    return this.fetch("income-statement", { symbol: ticker, period, limit });
  }

  async balanceSheet(ticker, period = "annual", limit = 2) {
    return this.fetch("balance-sheet-statement", { symbol: ticker, period, limit });
  }

  async cashFlowStatement(ticker, period = "annual", limit = 2) {
    return this.fetch("cash-flow-statement", { symbol: ticker, period, limit });
  }

  async historicalPrice(ticker, from, to) {
    return this.fetch("historical-price-eod/full", { symbol: ticker, from, to });
  }

  async quote(ticker) {
    return this.fetch("quote", { symbol: ticker });
  }
}
