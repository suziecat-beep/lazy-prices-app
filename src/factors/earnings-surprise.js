// ══════════════════════════════════════════════════════════════════════════════
// FACTOR 1 — Earnings Growth Trajectory
// Weight: 0.12
//
// Uses quarterly income statement EPS (free-tier compatible).
// Computes YoY EPS growth for the latest quarter and sequential EPS trend.
// ══════════════════════════════════════════════════════════════════════════════

import { FactorBase, clamp, scoreToSignal } from "./factor-base.js";
import { CONFIG } from "../config.js";

export class EarningsSurpriseFactor extends FactorBase {
  constructor() {
    super("Earnings Growth Trajectory", CONFIG.weights.earningsSurprise);
    this.category = "fundamental";
  }

  async fetchData(ticker, client) {
    // 5 quarters gives us latest + 4 prior (1 YoY pair + sequential trend)
    return client.incomeStatement(ticker, "quarter", 5);
  }

  computeScore(rawData) {
    const records = Array.isArray(rawData) ? rawData : [];
    if (records.length < 2) {
      return { score: 0, signal: "NEUTRAL", details: { error: "Insufficient EPS data" } };
    }

    const quarters = records.map((q) => ({
      date: q.date,
      eps: q.epsDiluted ?? q.eps ?? 0,
      revenue: q.revenue ?? 0,
      netIncome: q.netIncome ?? 0,
    }));

    // YoY EPS growth: compare Q0 (latest) to Q4 (same quarter last year)
    let yoy_eps_growth_pct = null;
    if (quarters.length >= 5) {
      const epsNow = quarters[0].eps;
      const epsYearAgo = quarters[4].eps;
      if (epsYearAgo !== 0) {
        yoy_eps_growth_pct = ((epsNow - epsYearAgo) / Math.abs(epsYearAgo)) * 100;
      } else {
        yoy_eps_growth_pct = epsNow > 0 ? 100 : epsNow < 0 ? -100 : 0;
      }
    }

    // Sequential EPS trend (newest to oldest)
    const epsVals = quarters.map((q) => q.eps);
    let increasing = 0;
    let decreasing = 0;
    for (let i = 0; i < epsVals.length - 1; i++) {
      if (epsVals[i] > epsVals[i + 1]) increasing++;
      else if (epsVals[i] < epsVals[i + 1]) decreasing++;
    }

    let trajectory;
    if (increasing >= 3 && decreasing === 0) trajectory = "CONSECUTIVE_BEATS";
    else if (decreasing >= 3 && increasing === 0) trajectory = "CONSECUTIVE_MISSES";
    else if (increasing > decreasing) trajectory = "IMPROVING";
    else if (decreasing > increasing) trajectory = "DETERIORATING";
    else trajectory = "MIXED";

    // Primary score from YoY growth (if available), else from trajectory
    const growth = yoy_eps_growth_pct ?? 0;
    let score;
    if (trajectory === "CONSECUTIVE_BEATS") {
      if (growth > 20) score = 0.9;
      else if (growth > 5) score = 0.7;
      else score = 0.5;
    } else if (trajectory === "IMPROVING") {
      if (growth > 10) score = 0.5;
      else score = 0.3;
    } else if (trajectory === "MIXED") {
      score = growth > 0 ? 0.1 : -0.1;
    } else if (trajectory === "DETERIORATING") {
      if (growth >= 0) score = -0.2;
      else score = -0.4;
    } else {
      // CONSECUTIVE_MISSES
      if (growth >= -5) score = -0.5;
      else if (growth >= -20) score = -0.7;
      else score = -0.9;
    }

    score = clamp(score);
    return {
      score,
      signal: scoreToSignal(score),
      details: {
        quarters,
        trajectory,
        yoy_eps_growth_pct: yoy_eps_growth_pct !== null ? Math.round(yoy_eps_growth_pct * 100) / 100 : null,
        avg_surprise_pct: yoy_eps_growth_pct !== null ? Math.round(yoy_eps_growth_pct * 100) / 100 : 0,
        score,
      },
    };
  }
}
