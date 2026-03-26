// ══════════════════════════════════════════════════════════════════════════════
// FACTOR BASE — shared interface for all factors
// ══════════════════════════════════════════════════════════════════════════════

export class FactorBase {
  constructor(name, weight) {
    this.name = name;
    this.weight = weight;
    this.category = "";
  }

  /**
   * Fetch raw data from FMP API.
   * @param {string} ticker
   * @param {import('../api/fmp.js').FMPClient} client
   * @returns {Promise<object>}
   */
  async fetchData(ticker, client) {
    throw new Error("fetchData() must be implemented");
  }

  /**
   * Compute the factor score from raw data.
   * @param {object} rawData
   * @returns {{ score: number, signal: string, details: object }}
   */
  computeScore(rawData) {
    throw new Error("computeScore() must be implemented");
  }

  /**
   * Full pipeline: fetch + compute.
   * Returns null on any error so the composite engine can skip this factor gracefully.
   * @param {string} ticker
   * @param {import('../api/fmp.js').FMPClient} client
   * @returns {Promise<{ name, category, weight, score, signal, details } | null>}
   */
  async evaluate(ticker, client) {
    try {
      const rawData = await this.fetchData(ticker, client);
      const result = this.computeScore(rawData);
      return {
        name: this.name,
        category: this.category,
        weight: this.weight,
        ...result,
      };
    } catch (err) {
      console.warn(`[${this.name}] failed for ${ticker}:`, err.message);
      return {
        name: this.name,
        category: this.category,
        weight: this.weight,
        score: null,
        signal: "ERROR",
        details: { error: err.message },
      };
    }
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Clamp a value to [-1, +1] */
export function clamp(val) {
  return Math.max(-1, Math.min(1, val));
}

/** Derive signal label from score */
export function scoreToSignal(score) {
  if (score === null || score === undefined) return "ERROR";
  if (score >= 0.25) return "BULLISH";
  if (score <= -0.25) return "BEARISH";
  return "NEUTRAL";
}
