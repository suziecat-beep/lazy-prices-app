// ══════════════════════════════════════════════════════════════════════════════
// FACTOR 4 — Accruals Ratio (Sloan 1996)
// Weight: 0.08
// ══════════════════════════════════════════════════════════════════════════════

import { FactorBase, clamp, scoreToSignal } from "./factor-base.js";
import { CONFIG } from "../config.js";

export class AccrualsRatioFactor extends FactorBase {
  constructor() {
    super("Accruals Ratio", CONFIG.weights.accrualsRatio);
    this.category = "fundamental";
  }

  async fetchData(ticker, client) {
    // Three parallel fetches (all cached individually)
    const [income, cashFlow, balanceSheet] = await Promise.all([
      client.incomeStatement(ticker, "annual", 2),
      client.cashFlowStatement(ticker, "annual", 2),
      client.balanceSheet(ticker, "annual", 2),
    ]);
    return { income, cashFlow, balanceSheet };
  }

  computeScore({ income, cashFlow, balanceSheet }) {
    const incArr = Array.isArray(income) ? income : [];
    const cfArr = Array.isArray(cashFlow) ? cashFlow : [];
    const bsArr = Array.isArray(balanceSheet) ? balanceSheet : [];

    if (incArr.length === 0 || cfArr.length === 0 || bsArr.length === 0) {
      return { score: 0, signal: "NEUTRAL", details: { error: "Missing financial statement data" } };
    }

    const ni0 = incArr[0]?.netIncome ?? 0;
    const cfo0 = cfArr[0]?.operatingCashFlow ?? 0;
    const ta0 = bsArr[0]?.totalAssets ?? 1;

    const accruals = ni0 - cfo0;
    const accruals_ratio = ta0 !== 0 ? accruals / ta0 : 0;

    // Prior year for change
    let prior_accruals_ratio = null;
    let accruals_change = null;
    if (incArr.length >= 2 && cfArr.length >= 2 && bsArr.length >= 2) {
      const ni1 = incArr[1]?.netIncome ?? 0;
      const cfo1 = cfArr[1]?.operatingCashFlow ?? 0;
      const ta1 = bsArr[1]?.totalAssets ?? 1;
      prior_accruals_ratio = ta1 !== 0 ? (ni1 - cfo1) / ta1 : 0;
      accruals_change = accruals_ratio - prior_accruals_ratio;
    }

    // Base score from absolute accruals_ratio
    let score;
    if (accruals_ratio < -0.10) score = 0.8;
    else if (accruals_ratio < -0.06) score = 0.5;
    else if (accruals_ratio < -0.02) score = 0.2;
    else if (accruals_ratio < 0.02) score = 0.0;
    else if (accruals_ratio < 0.05) score = -0.3;
    else if (accruals_ratio < 0.10) score = -0.6;
    else score = -0.9;

    // Adjustment for YoY change
    if (accruals_change !== null) {
      if (accruals_change > 0.03) score -= 0.1;
      else if (accruals_change < -0.03) score += 0.1;
    }

    score = clamp(score);
    return {
      score,
      signal: scoreToSignal(score),
      details: {
        net_income: ni0,
        operating_cash_flow: cfo0,
        total_assets: ta0,
        accruals,
        accruals_ratio: Math.round(accruals_ratio * 10000) / 10000,
        prior_accruals_ratio: prior_accruals_ratio !== null ? Math.round(prior_accruals_ratio * 10000) / 10000 : null,
        accruals_change: accruals_change !== null ? Math.round(accruals_change * 10000) / 10000 : null,
        score,
      },
    };
  }
}
