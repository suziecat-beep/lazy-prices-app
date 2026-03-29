// ══════════════════════════════════════════════════════════════════════════════
// BATCH EVALUATE — Sequential evaluation of all watchlist tickers
// Runs evaluateTicker for each, with progress callbacks and 200ms delay
// ══════════════════════════════════════════════════════════════════════════════

import { evaluateTicker } from "../engine/scoring.js";
import { saveTickerData, getTickerData } from "../storage.js";
import { recordSignal } from "./signalHistory.js";

const BATCH_KEY = "batch_results";

/**
 * Evaluate all tickers sequentially.
 * @param {string[]} tickers
 * @param {(current: number, total: number, ticker: string) => void} onProgress
 * @returns {Promise<{ results: Array<{ ticker, signal, compositeScore, confidence, fromCache, evaluatedAt, error? }>, signalChanges: Array }>}
 */
export async function batchEvaluate(tickers, onProgress) {
  const results = [];
  const signalChanges = [];

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

      const evaluatedAt = new Date().toISOString();
      results.push({
        ticker: evaluation.ticker,
        companyName: evaluation.companyName,
        signal: evaluation.signal,
        compositeScore: evaluation.composite,
        confidence: evaluation.confidence,
        fromCache: evaluation.fromCache,
        evaluatedAt,
      });

      // Record signal and track changes (include factor breakdown for history chart)
      if (evaluation.signal && evaluation.signal !== "ERROR") {
        const factors = {};
        for (const f of evaluation.factors) {
          if (f.score !== null && f.score !== undefined && f.signal !== "ERROR") {
            factors[f.name] = f.score;
          }
        }
        const change = recordSignal(evaluation.ticker, {
          signal: evaluation.signal,
          compositeScore: evaluation.composite,
          confidence: evaluation.confidence,
          evaluatedAt,
          factors,
        });
        if (change) signalChanges.push(change);
      }
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
    signalChanges,
    completedAt: new Date().toISOString(),
  };
  localStorage.setItem(BATCH_KEY, JSON.stringify(batch));

  return { results, signalChanges };
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
