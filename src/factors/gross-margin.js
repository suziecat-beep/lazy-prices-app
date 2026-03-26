// ══════════════════════════════════════════════════════════════════════════════
// FACTOR 3 — Gross Margin Stability
// Weight: 0.08
// Shares income-statement fetch with Factors 1 & 2 (cached by FMPClient)
// Adapted for free-tier FMP (max 5 quarterly records)
// ══════════════════════════════════════════════════════════════════════════════

import { FactorBase, clamp, scoreToSignal } from "./factor-base.js";
import { CONFIG } from "../config.js";

export class GrossMarginFactor extends FactorBase {
  constructor() {
    super("Gross Margin Stability", CONFIG.weights.grossMargin);
    this.category = "fundamental";
  }

  async fetchData(ticker, client) {
    // Same call as Factors 1 & 2 — served from cache
    return client.incomeStatement(ticker, "quarter", 5);
  }

  computeScore(rawData) {
    const records = Array.isArray(rawData) ? rawData : [];
    if (records.length < 2) {
      return { score: 0, signal: "NEUTRAL", details: { error: "Insufficient margin data" } };
    }

    const quarters = records.map((q) => {
      const rev = q.revenue ?? 0;
      const gp = q.grossProfit ?? 0;
      const gross_margin_pct = rev !== 0 ? (gp / rev) * 100 : 0;
      return { date: q.date, gross_margin_pct };
    });

    const margins = quarters.map((q) => q.gross_margin_pct);

    // Split into recent (first 2-3) and prior (rest)
    const midpoint = Math.ceil(margins.length / 2);
    const recent = margins.slice(0, midpoint);
    const prior = margins.slice(midpoint);

    const avg_recent = recent.reduce((s, v) => s + v, 0) / recent.length;
    const avg_prior = prior.length > 0 ? prior.reduce((s, v) => s + v, 0) / prior.length : avg_recent;
    const margin_change_pp = avg_recent - avg_prior;

    // Linear regression slope (x=index 0=most recent, y=margin)
    const n = margins.length;
    const xMean = (n - 1) / 2;
    const yMean = margins.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    margins.forEach((y, x) => {
      num += (x - xMean) * (y - yMean);
      den += (x - xMean) ** 2;
    });
    // x=0 is most recent, so positive slope means margins were higher in past → compressing
    // Flip sign: slope>0 means expanding
    const slope_pp_per_quarter = den !== 0 ? -(num / den) : 0;

    // Trend classification
    let trend;
    if (slope_pp_per_quarter > 0.3) trend = "EXPANDING";
    else if (slope_pp_per_quarter < -0.3) trend = "COMPRESSING";
    else trend = "STABLE";

    // Volatility
    const variance = margins.reduce((s, v) => s + (v - yMean) ** 2, 0) / n;
    const volatility = Math.sqrt(variance);
    const is_volatile = volatility > 3.0;

    // Score mapping
    let score;
    if (trend === "EXPANDING") {
      if (margin_change_pp > 3) score = 0.8;
      else if (margin_change_pp >= 1) score = 0.5;
      else score = 0.3;
    } else if (trend === "STABLE") {
      score = is_volatile ? -0.1 : 0.1;
    } else {
      // COMPRESSING
      if (margin_change_pp >= -2) score = -0.4;
      else if (margin_change_pp >= -5) score = -0.7;
      else score = -0.9;
    }

    score = clamp(score);
    return {
      score,
      signal: scoreToSignal(score),
      details: {
        quarters,
        trend,
        avg_recent_margin_pct: Math.round(avg_recent * 100) / 100,
        avg_prior_margin_pct: Math.round(avg_prior * 100) / 100,
        margin_change_pp: Math.round(margin_change_pp * 100) / 100,
        volatility: Math.round(volatility * 100) / 100,
        slope_pp_per_quarter: Math.round(slope_pp_per_quarter * 1000) / 1000,
        is_volatile,
        score,
      },
    };
  }
}
