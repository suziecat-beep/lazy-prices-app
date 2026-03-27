// ══════════════════════════════════════════════════════════════════════════════
// FMP API CLIENT — routes through /api/fmp-proxy (Vercel serverless function)
// so the API key never touches the browser.
// ══════════════════════════════════════════════════════════════════════════════

export class FMPClient {
  constructor() {
    this._cache = new Map();
    this.callCount = 0;
  }

  async fetch(endpoint, params = {}) {
    const cacheKey = endpoint + "|" + JSON.stringify(params);
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const url = new URL("/api/fmp-proxy", window.location.origin);
    url.searchParams.set("endpoint", endpoint);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

    this.callCount++;
    const response = await globalThis.fetch(url.toString());

    if (response.status === 402) {
      throw new Error(`"${params.symbol || ""}" is not available on the free FMP plan. Only major-exchange stocks are supported.`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`API error (${response.status}): ${body.slice(0, 200) || response.statusText}`);
    }

    const text = await response.text();

    if (text.startsWith("Premium") || text.startsWith("Query Error")) {
      throw new Error(text.slice(0, 200));
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Unexpected response: ${text.slice(0, 200)}`);
    }

    if (data && data.error) {
      throw new Error(data.error);
    }
    if (data && data["Error Message"]) {
      throw new Error(data["Error Message"]);
    }

    this._cache.set(cacheKey, data);
    return data;
  }

  // ── Convenience methods ──────────────────────────────────────────────────

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

  async insiderTrading(ticker) {
    return this.fetch("insider-trading", { symbol: ticker });
  }

  async analystEstimates(ticker) {
    return this.fetch("analyst-estimates", { symbol: ticker });
  }
}
