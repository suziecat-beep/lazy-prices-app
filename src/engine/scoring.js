// ══════════════════════════════════════════════════════════════════════════════
// COMPOSITE SCORING ENGINE
// ══════════════════════════════════════════════════════════════════════════════

import { FMPClient } from "../api/fmp.js";
import { EarningsSurpriseFactor } from "../factors/earnings-surprise.js";
import { RevenueGrowthFactor } from "../factors/revenue-growth.js";
import { GrossMarginFactor } from "../factors/gross-margin.js";
import { AccrualsRatioFactor } from "../factors/accruals-ratio.js";
import { PriceMomentumFactor } from "../factors/price-momentum.js";
import { CONFIG } from "../config.js";

const FACTORS = [
  new EarningsSurpriseFactor(),
  new RevenueGrowthFactor(),
  new GrossMarginFactor(),
  new AccrualsRatioFactor(),
  new PriceMomentumFactor(),
];

/**
 * Derive BUY / HOLD / SELL from composite score.
 */
function getSignal(composite) {
  if (composite >= CONFIG.signalThresholds.buy) return "BUY";
  if (composite <= CONFIG.signalThresholds.sell) return "SELL";
  return "HOLD";
}

/**
 * Confidence reflects signal strength and data coverage.
 * A composite of ±0.6 with all factors = ~60% confidence.
 */
function getConfidence(composite, validCount, totalCount) {
  const base = Math.abs(composite) * 100;
  const coverage_penalty = totalCount > 0
    ? ((totalCount - validCount) / totalCount) * 20
    : 0;
  return Math.max(0, Math.round(base - coverage_penalty));
}

/**
 * Run the full evaluation pipeline for a given ticker.
 *
 * @param {string} ticker
 * @param {string} apiKey
 * @param {function} onProgress  - optional callback(factorName, result) for live updates
 * @returns {Promise<{
 *   ticker: string,
 *   composite: number,
 *   signal: "BUY"|"HOLD"|"SELL",
 *   confidence: number,
 *   factorCount: number,
 *   totalFactors: number,
 *   factors: Array,
 *   apiCallCount: number
 * }>}
 */
export async function evaluateTicker(ticker, apiKey, onProgress) {
  if (!ticker || !apiKey) throw new Error("Ticker and API key are required");

  const symbol = ticker.toUpperCase().trim();
  const client = new FMPClient(apiKey);

  // Validate ticker exists first
  const quoteData = await client.quote(symbol);
  const quoteArr = Array.isArray(quoteData) ? quoteData : [];
  if (quoteArr.length === 0 || !quoteArr[0]?.symbol) {
    throw new Error(`Ticker "${symbol}" not found. Check the symbol and try again.`);
  }

  // Evaluate all factors — run them sequentially so cache benefits factors 2+3
  const factorResults = [];
  for (const factor of FACTORS) {
    const result = await factor.evaluate(symbol, client);
    factorResults.push(result);
    if (onProgress) onProgress(factor.name, result);
  }

  // Compute composite (only valid factors contribute)
  const valid = factorResults.filter((f) => f.score !== null && f.score !== undefined && f.signal !== "ERROR");

  if (valid.length === 0) {
    return {
      ticker: symbol,
      composite: 0,
      signal: "HOLD",
      confidence: 0,
      factorCount: 0,
      totalFactors: FACTORS.length,
      factors: factorResults,
      apiCallCount: client.callCount,
    };
  }

  const totalWeight = valid.reduce((sum, f) => sum + f.weight, 0);
  const weightedSum = valid.reduce((sum, f) => sum + f.score * f.weight, 0);
  const composite = Math.round((weightedSum / totalWeight) * 1000) / 1000;

  return {
    ticker: symbol,
    composite,
    signal: getSignal(composite),
    confidence: getConfidence(composite, valid.length, FACTORS.length),
    factorCount: valid.length,
    totalFactors: FACTORS.length,
    factors: factorResults,
    apiCallCount: client.callCount,
  };
}
