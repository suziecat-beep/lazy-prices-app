// ══════════════════════════════════════════════════════════════════════════════
// BATCH EVALUATE — Sequential evaluation of all watchlist tickers
// Runs evaluateTicker for each, with progress callbacks and 200ms delay
// ══════════════════════════════════════════════════════════════════════════════

import { evaluateTicker } from "../engine/scoring.js";
import { saveTickerData, getTickerData } from "../storage.js";

const BATCH_KEY = "batch_results";

/**
 * Evaluate all tickers sequentially.
 * @param {string[]} tickers
 * @param {(current: number, total: number, ticker: string) => void} onProgress
 * @returns {Promise<Array<{ ticker, signal, compositeScore, confidence, fromCache, evaluatedAt, error? }>>}
 */
export async function batchEvaluate(tickers, onProgress) {
  const results = [];

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    if (onProgress) onProgress(i + 1, tickers.length, ticker);

    try {
      const evaluation = await evaluateTicker(ticker);

      // Persist to per-ticker storage (same as individual evaluate)
      const existing = getTickerData(ticker);
      saveTickerData(ticker, {
        ...existing,
        ticker: evaluation.ticker,
        companyName: evaluation.companyName,
        price: evaluation.price,
        factors: evaluation.factors,
        apiCallCount: evaluation.apiCallCount,
        cacheHits: evaluation.cacheHits,
        fromCache: evaluation.fromCache,
        filing: existing?.filing || null,
      });

      results.push({
        ticker: evaluation.ticker,
        companyName: evaluation.companyName,
        signal: evaluation.signal,
        compositeScore: evaluation.composite,
        confidence: evaluation.confidence,
        fromCache: evaluation.fromCache,
        evaluatedAt: new Date().toISOString(),
      });
    } catch (err) {
      results.push({
        ticker,
        companyName: getTickerData(ticker)?.companyName || ticker,
        signal: "ERROR",
        compositeScore: null,
        confidence: null,
        fromCache: false,
        evaluatedAt: new Date().toISOString(),
        error: err.message || "Unknown error",
      });
    }

    // Small delay between tickers to be respectful to the API
    if (i < tickers.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Persist batch results
  const batch = {
    results,
    completedAt: new Date().toISOString(),
  };
  localStorage.setItem(BATCH_KEY, JSON.stringify(batch));

  return results;
}

/**
 * Load persisted batch results from localStorage.
 */
export function loadBatchResults() {
  try {
    const raw = localStorage.getItem(BATCH_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Clear persisted batch results.
 */
export function clearBatchResults() {
  localStorage.removeItem(BATCH_KEY);
}
