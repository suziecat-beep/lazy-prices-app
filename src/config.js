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

export const LOCAL_STORAGE_KEY = "fmp_api_key";

export function getApiKey() {
  return localStorage.getItem(LOCAL_STORAGE_KEY) || "";
}

export function setApiKey(key) {
  localStorage.setItem(LOCAL_STORAGE_KEY, key.trim());
}

export function clearApiKey() {
  localStorage.removeItem(LOCAL_STORAGE_KEY);
}
