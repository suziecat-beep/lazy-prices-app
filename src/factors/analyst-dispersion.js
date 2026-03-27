// ══════════════════════════════════════════════════════════════════════════════
// FACTOR 8 — Analyst Forecast Dispersion
// Weight: 0.10
//
// Low dispersion (analyst consensus) is mildly bullish; high dispersion
// (disagreement) is bearish.  Uses range-based proxy since FMP provides
// high/low/avg but not standard deviation.
// ══════════════════════════════════════════════════════════════════════════════

import { FactorBase, clamp, scoreToSignal } from "./factor-base.js";
import { CONFIG } from "../config.js";

/**
 * Linear interpolation within dispersion bands.
 * Maps dispersion → score using the spec's table with smooth transitions.
 */
function dispersionToScore(disp) {
  if (disp < 0.10) {
    // 0.00→+0.6  to  0.10→+0.3  (lerp)
    return 0.6 - (disp / 0.10) * 0.3;
  }
  if (disp < 0.25) {
    // 0.10→+0.3  to  0.25→0.0
    return 0.3 - ((disp - 0.10) / 0.15) * 0.3;
  }
  if (disp < 0.50) {
    // 0.25→0.0  to  0.50→-0.3
    return 0.0 - ((disp - 0.25) / 0.25) * 0.3;
  }
  if (disp < 1.00) {
    // 0.50→-0.3  to  1.00→-0.6
    return -0.3 - ((disp - 0.50) / 0.50) * 0.3;
  }
  return -0.6;
}

/**
 * Absolute-spread scoring for near-zero EPS.
 */
function absoluteSpreadToScore(spread) {
  if (spread < 0.05) return 0.6;
  if (spread < 0.15) return 0.3;
  if (spread < 0.30) return 0.0;
  if (spread < 0.50) return -0.3;
  return -0.6;
}

export class AnalystDispersionFactor extends FactorBase {
  constructor() {
    super("Analyst Dispersion", CONFIG.weights.analystDispersion);
    this.category = "intermediate";
  }

  async fetchData(ticker, client) {
    return client.analystEstimates(ticker);
  }

  computeScore(rawData) {
    const records = Array.isArray(rawData) ? rawData : [];
    if (records.length === 0) {
      return {
        score: 0,
        signal: "NEUTRAL",
        details: {
          note: "No analyst estimates available",
          confidence: "low",
        },
      };
    }

    // Find the forward quarter: closest period end date on or after today
    const today = new Date().toISOString().split("T")[0];
    const forward = records
      .filter((r) => r.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));

    // If no future period, use the most recent one
    const est = forward.length > 0 ? forward[0] : records[0];

    const epsHigh = est.estimatedEpsHigh ?? null;
    const epsLow = est.estimatedEpsLow ?? null;
    const epsAvg = est.estimatedEpsAvg ?? null;
    const numAnalysts = est.numberAnalystEstimatedEps ?? 0;

    // Single analyst — dispersion is meaningless
    if (numAnalysts <= 1) {
      return {
        score: 0,
        signal: "NEUTRAL",
        details: {
          note: numAnalysts === 1
            ? "Only 1 analyst covers this stock — dispersion not meaningful"
            : "No analyst count available",
          period: est.date,
          numAnalysts,
          confidence: "low",
        },
      };
    }

    if (epsHigh === null || epsLow === null || epsAvg === null) {
      return {
        score: 0,
        signal: "NEUTRAL",
        details: {
          note: "Incomplete estimate data",
          period: est.date,
          confidence: "low",
        },
      };
    }

    // Compute dispersion
    let dispersion;
    let useAbsolute = false;
    const absAvg = Math.abs(epsAvg);

    if (absAvg < 0.01) {
      // Near-zero EPS — use absolute spread
      dispersion = epsHigh - epsLow;
      useAbsolute = true;
    } else {
      dispersion = (epsHigh - epsLow) / absAvg;
    }

    // Base score
    const baseScore = useAbsolute
      ? absoluteSpreadToScore(dispersion)
      : dispersionToScore(dispersion);

    // Analyst count modifier
    let modifier;
    if (numAnalysts >= 10) modifier = 1.0;
    else if (numAnalysts >= 5) modifier = 0.8;
    else if (numAnalysts >= 3) modifier = 0.6;
    else modifier = 0.3;

    const finalScore = clamp(baseScore * modifier);

    // Confidence
    let confidence;
    if (numAnalysts >= 10) confidence = "high";
    else if (numAnalysts >= 5) confidence = "medium";
    else confidence = "low";

    return {
      score: finalScore,
      signal: scoreToSignal(finalScore),
      details: {
        period: est.date,
        epsHigh,
        epsLow,
        epsAvg,
        numAnalysts,
        dispersion: Math.round(dispersion * 1000) / 1000,
        useAbsoluteSpread: useAbsolute,
        modifier,
        confidence,
        score: finalScore,
      },
    };
  }
}
