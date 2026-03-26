// ══════════════════════════════════════════════════════════════════════════════
// FACTOR 5 — Price Momentum (12-month minus 1-month, Jegadeesh-Titman)
// Weight: 0.08
// Adapted for FMP /stable/ API: flat array response, `close` field (no adjClose)
// ══════════════════════════════════════════════════════════════════════════════

import { FactorBase, clamp, scoreToSignal } from "./factor-base.js";
import { CONFIG } from "../config.js";

/**
 * Walk backward from today counting only weekdays (Mon-Fri).
 * Does not account for market holidays — acceptable approximation.
 */
function getTradeDate(daysAgo) {
  let date = new Date();
  let count = 0;
  while (count < daysAgo) {
    date.setDate(date.getDate() - 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return date.toISOString().split("T")[0]; // "YYYY-MM-DD"
}

/**
 * Find the price on or nearest before a target date in a sorted price array.
 * @param {Array<{date: string, close: number}>} prices - sorted descending by date
 * @param {string} targetDate - "YYYY-MM-DD"
 */
function nearestPrice(prices, targetDate) {
  for (const p of prices) {
    if (p.date <= targetDate) return p;
  }
  return prices[prices.length - 1];
}

export class PriceMomentumFactor extends FactorBase {
  constructor() {
    super("Price Momentum (12-1)", CONFIG.weights.priceMomentum);
    this.category = "intermediate";
  }

  async fetchData(ticker, client) {
    const from = getTradeDate(252); // ~12 months back
    const to = getTradeDate(0);     // today
    return client.historicalPrice(ticker, from, to);
  }

  computeScore(rawData) {
    // Stable API returns a flat array (not { historical: [...] })
    const historical = Array.isArray(rawData) ? rawData : (rawData?.historical ?? []);
    if (historical.length < 22) {
      return { score: 0, signal: "NEUTRAL", details: { error: "Insufficient price history" } };
    }

    // Sort descending (most recent first), use `close` (stable API has no adjClose)
    const prices = [...historical]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((p) => ({ date: p.date, close: p.close ?? 0 }));

    const date_1m_ago = getTradeDate(21);
    const date_12m_ago = getTradeDate(252);

    const p_current = prices[0];
    const p_1m = nearestPrice(prices, date_1m_ago);
    const p_12m = nearestPrice(prices, date_12m_ago);

    if (!p_12m || p_12m.close === 0) {
      return { score: 0, signal: "NEUTRAL", details: { error: "Cannot locate 12m price anchor" } };
    }

    const momentum_return = ((p_1m.close - p_12m.close) / p_12m.close) * 100;
    const recent_return = p_1m.close !== 0
      ? ((p_current.close - p_1m.close) / p_1m.close) * 100
      : 0;

    // Score mapping
    let score;
    if (momentum_return > 40) score = 0.9;
    else if (momentum_return >= 20) score = 0.7;
    else if (momentum_return >= 10) score = 0.5;
    else if (momentum_return >= 5) score = 0.3;
    else if (momentum_return >= 0) score = 0.1;
    else if (momentum_return >= -5) score = -0.1;
    else if (momentum_return >= -10) score = -0.3;
    else if (momentum_return >= -20) score = -0.5;
    else if (momentum_return >= -40) score = -0.7;
    else score = -0.9;

    score = clamp(score);
    return {
      score,
      signal: scoreToSignal(score),
      details: {
        price_12m_ago: Math.round(p_12m.close * 100) / 100,
        price_1m_ago: Math.round(p_1m.close * 100) / 100,
        price_current: Math.round(p_current.close * 100) / 100,
        momentum_return_pct: Math.round(momentum_return * 100) / 100,
        recent_1m_return_pct: Math.round(recent_return * 100) / 100,
        date_12m_ago: p_12m.date,
        date_1m_ago: p_1m.date,
        score,
      },
    };
  }
}
