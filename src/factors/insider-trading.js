// ══════════════════════════════════════════════════════════════════════════════
// FACTOR 7 — Insider Buying vs. Selling
// Weight: 0.12
//
// 6-month lookback on SEC Form 4 filings. Net buy/sell dollar ratio with
// cluster bonus when 3+ unique insiders purchase.
// ══════════════════════════════════════════════════════════════════════════════

import { FactorBase, clamp, scoreToSignal } from "./factor-base.js";
import { CONFIG } from "../config.js";

export class InsiderTradingFactor extends FactorBase {
  constructor() {
    super("Insider Trading", CONFIG.weights.insiderTrading);
    this.category = "fundamental";
  }

  async fetchData(ticker, client) {
    return client.insiderTrading(ticker);
  }

  computeScore(rawData) {
    const records = Array.isArray(rawData) ? rawData : [];

    // 6-month cutoff
    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const cutoff = sixMonthsAgo.toISOString().split("T")[0];

    // Filter: last 6 months, only P-Purchase / S-Sale, common stock only,
    // exclude 10% owners
    const filtered = records.filter((t) => {
      if (!t.transactionDate || t.transactionDate < cutoff) return false;
      const type = (t.transactionType || "").toLowerCase();
      if (type !== "p-purchase" && type !== "s-sale") return false;
      const sec = (t.securityName || "").toLowerCase();
      if (!sec.includes("common")) return false;
      const owner = (t.typeOfOwner || "").toLowerCase();
      if (owner.includes("10 percent") || owner.includes("10%")) return false;
      return true;
    });

    if (filtered.length === 0) {
      return {
        score: 0,
        signal: "NEUTRAL",
        details: {
          note: "No insider trading activity detected in the last 6 months",
          totalTransactions: 0,
          buyVolume: 0,
          sellVolume: 0,
          netRatio: 0,
          uniqueBuyers: 0,
          clusterMultiplier: 1.0,
          confidence: "low",
        },
      };
    }

    // Compute dollar volumes
    let buyVolume = 0;
    let sellVolume = 0;
    const uniqueBuyers = new Set();
    let buyCount = 0;
    let sellCount = 0;

    for (const t of filtered) {
      const dollars = (t.securitiesTransacted || 0) * (t.price || 0);
      const type = (t.transactionType || "").toLowerCase();
      if (type === "p-purchase") {
        buyVolume += dollars;
        buyCount++;
        if (t.reportingName) uniqueBuyers.add(t.reportingName.toLowerCase());
      } else {
        sellVolume += dollars;
        sellCount++;
      }
    }

    // Net ratio [-1, +1]
    const total = buyVolume + sellVolume;
    const netRatio = total > 0 ? (buyVolume - sellVolume) / total : 0;

    // Cluster bonus
    const numUniqueBuyers = uniqueBuyers.size;
    let clusterMultiplier = 1.0;
    if (numUniqueBuyers >= 5) clusterMultiplier = 1.5;
    else if (numUniqueBuyers >= 3) clusterMultiplier = 1.25;

    const rawScore = netRatio * clusterMultiplier;
    const score = clamp(rawScore);

    // Confidence
    const txCount = filtered.length;
    let confidence;
    if (txCount >= 10) confidence = "high";
    else if (txCount >= 3) confidence = "medium";
    else confidence = "low";

    return {
      score,
      signal: scoreToSignal(score),
      details: {
        totalTransactions: txCount,
        buyCount,
        sellCount,
        buyVolume: Math.round(buyVolume),
        sellVolume: Math.round(sellVolume),
        netRatio: Math.round(netRatio * 1000) / 1000,
        uniqueBuyers: numUniqueBuyers,
        clusterMultiplier,
        confidence,
        score,
      },
    };
  }
}
