// ══════════════════════════════════════════════════════════════════════════════
// FACTOR 2 — Revenue Growth Trend
// Weight: 0.10
// Adapted for free-tier FMP (max 5 quarterly records)
// ══════════════════════════════════════════════════════════════════════════════

import { FactorBase, clamp, scoreToSignal } from "./factor-base.js";
import { CONFIG } from "../config.js";

export class RevenueGrowthFactor extends FactorBase {
  constructor() {
    super("Revenue Growth Trend", CONFIG.weights.revenueGrowth);
    this.category = "fundamental";
  }

  async fetchData(ticker, client) {
    // Shares the same call as Factor 1 and 3 — served from cache
    return client.incomeStatement(ticker, "quarter", 5);
  }

  computeScore(rawData) {
    const records = Array.isArray(rawData) ? rawData : [];
    if (records.length < 2) {
      return { score: 0, signal: "NEUTRAL", details: { error: "Insufficient revenue data" } };
    }

    const quarters = records.map((q) => ({
      date: q.date,
      revenue: q.revenue ?? 0,
    }));

    // YoY growth (Q0 vs Q4 — same quarter last year)
    let yoy = null;
    if (quarters.length >= 5) {
      const r0 = quarters[0].revenue;
      const r4 = quarters[4].revenue;
      yoy = r4 !== 0 ? ((r0 - r4) / Math.abs(r4)) * 100 : (r0 > 0 ? 100 : -100);
    }

    // QoQ growth for each adjacent pair (newest first)
    const growthData = quarters.map((q, i) => {
      const prior = i + 1 < quarters.length ? quarters[i + 1] : null;
      const qoq = prior && prior.revenue !== 0
        ? ((q.revenue - prior.revenue) / Math.abs(prior.revenue)) * 100
        : null;
      return { date: q.date, revenue: q.revenue, qoq_growth_pct: qoq, yoy_growth_pct: i === 0 ? yoy : null };
    });

    // Sequential revenue direction for trend classification
    let up = 0, down = 0;
    for (let i = 0; i < quarters.length - 1; i++) {
      if (quarters[i].revenue > quarters[i + 1].revenue) up++;
      else if (quarters[i].revenue < quarters[i + 1].revenue) down++;
    }

    let trend;
    if (up >= 3 && down === 0) trend = "ACCELERATING";
    else if (down >= 3 && up === 0) trend = "DECELERATING";
    else if (Math.abs(up - down) <= 1) trend = "STABLE";
    else trend = "MIXED";

    // Refine using YoY when available
    if (yoy !== null) {
      if (yoy > 15 && trend !== "DECELERATING") trend = "ACCELERATING";
      else if (yoy < -10 && trend !== "ACCELERATING") trend = "DECELERATING";
    }

    const latest_yoy = yoy ?? 0;
    const latest_qoq = growthData[0]?.qoq_growth_pct ?? null;

    // Score mapping
    let score;
    if (trend === "ACCELERATING") {
      if (latest_yoy > 20) score = 0.9;
      else if (latest_yoy >= 5) score = 0.7;
      else score = 0.5;
    } else if (trend === "STABLE") {
      if (latest_yoy > 10) score = 0.4;
      else if (latest_yoy >= 0) score = 0.1;
      else score = -0.3;
    } else if (trend === "MIXED") {
      score = latest_yoy > 0 ? 0.1 : -0.2;
    } else {
      // DECELERATING
      if (latest_yoy > 0) score = -0.4;
      else if (latest_yoy >= -10) score = -0.6;
      else score = -0.9;
    }

    score = clamp(score);
    return {
      score,
      signal: scoreToSignal(score),
      details: {
        quarters: growthData,
        trend,
        latest_yoy_pct: yoy !== null ? Math.round(yoy * 100) / 100 : null,
        latest_qoq_pct: latest_qoq !== null ? Math.round(latest_qoq * 100) / 100 : null,
        score,
      },
    };
  }
}
