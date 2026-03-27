// ══════════════════════════════════════════════════════════════════════════════
// COMPOSITE SCORING ENGINE
// ══════════════════════════════════════════════════════════════════════════════

import { FMPClient } from "../api/fmp.js";
import { EarningsSurpriseFactor } from "../factors/earnings-surprise.js";
import { RevenueGrowthFactor } from "../factors/revenue-growth.js";
import { GrossMarginFactor } from "../factors/gross-margin.js";
import { AccrualsRatioFactor } from "../factors/accruals-ratio.js";
import { PriceMomentumFactor } from "../factors/price-momentum.js";
import { InsiderTradingFactor } from "../factors/insider-trading.js";
import { AnalystDispersionFactor } from "../factors/analyst-dispersion.js";
import { CONFIG } from "../config.js";

const FACTORS = [
  new EarningsSurpriseFactor(),
  new RevenueGrowthFactor(),
  new GrossMarginFactor(),
  new AccrualsRatioFactor(),
  new PriceMomentumFactor(),
  new InsiderTradingFactor(),
  new AnalystDispersionFactor(),
];

function getSignal(composite) {
  if (composite >= CONFIG.signalThresholds.buy) return "BUY";
  if (composite <= CONFIG.signalThresholds.sell) return "SELL";
  return "HOLD";
}

function getConfidence(composite, validCount, totalCount) {
  const base = Math.abs(composite) * 100;
  const penalty = totalCount > 0 ? ((totalCount - validCount) / totalCount) * 20 : 0;
  return Math.max(0, Math.round(base - penalty));
}

/**
 * Compute composite score from an array of factor results.
 * Pure function — usable by the UI to recalculate when adding the filing factor.
 */
export function computeComposite(factorResults) {
  const valid = factorResults.filter(
    (f) => f && f.score !== null && f.score !== undefined && f.signal !== "ERROR"
  );
  if (valid.length === 0) {
    return { composite: 0, signal: "HOLD", confidence: 0, factorCount: 0, totalFactors: factorResults.length };
  }
  const totalWeight = valid.reduce((sum, f) => sum + f.weight, 0);
  const weightedSum = valid.reduce((sum, f) => sum + f.score * f.weight, 0);
  const composite = Math.round((weightedSum / totalWeight) * 1000) / 1000;
  return {
    composite,
    signal: getSignal(composite),
    confidence: getConfidence(composite, valid.length, factorResults.length),
    factorCount: valid.length,
    totalFactors: factorResults.length,
  };
}

/**
 * Run the full evaluation pipeline for a given ticker (5 API-based factors).
 * Returns the factor results and a composite. The UI may recalculate the composite
 * after adding the 10-K filing similarity factor.
 */
export async function evaluateTicker(ticker, onProgress) {
  if (!ticker) throw new Error("Ticker is required");

  const symbol = ticker.toUpperCase().trim();
  const client = new FMPClient();

  // Validate ticker exists first — also captures company name
  const quoteData = await client.quote(symbol);
  const quoteArr = Array.isArray(quoteData) ? quoteData : [];
  if (quoteArr.length === 0 || !quoteArr[0]?.symbol) {
    throw new Error(`Ticker "${symbol}" not found. Check the symbol and try again.`);
  }
  const companyName = quoteArr[0].name || symbol;
  const price = quoteArr[0].price ?? null;

  // Evaluate all factors sequentially (cache benefits factors 2+3)
  const factorResults = [];
  for (const factor of FACTORS) {
    const result = await factor.evaluate(symbol, client);
    factorResults.push(result);
    if (onProgress) onProgress(factor.name, result);
  }

  const comp = computeComposite(factorResults);

  return {
    ticker: symbol,
    companyName,
    price,
    ...comp,
    factors: factorResults,
    apiCallCount: client.callCount,
  };
}
