// ══════════════════════════════════════════════════════════════════════════════
// CONFIG — weights, thresholds, data depth
// ══════════════════════════════════════════════════════════════════════════════

export const CONFIG = {
  fmp: {
    baseUrl: "https://financialmodelingprep.com/api/v3",
    rateLimitPerDay: 250,
  },

  weights: {
    earningsSurprise: 0.12,
    revenueGrowth: 0.10,
    grossMargin: 0.08,
    accrualsRatio: 0.08,
    priceMomentum: 0.08,
    filingSimilarity: 0.20,
  },

  signalThresholds: {
    buy: 0.25,
    sell: -0.25,
  },

  dataDepth: {
    earningsSurpriseQuarters: 4,
    revenueQuarters: 8,
    marginQuarters: 8,
    accrualsYears: 2,
    momentumMonths: 13,
  },
};

/**
 * Map 10-K average similarity (0-1) to the factor score scale (-1 to +1).
 * Based on the quintile thresholds from Cohen, Malloy & Nguyen (2018).
 */
export function similarityToFactorScore(avgSim) {
  if (avgSim >= 0.85) return 0.8;
  if (avgSim >= 0.72) return 0.4;
  if (avgSim >= 0.58) return 0.0;
  if (avgSim >= 0.42) return -0.4;
  return -0.8;
}
