// ══════════════════════════════════════════════════════════════════════════════
// FACTOR METHODOLOGIES — Tooltip content for each scoring factor
// Maps factor names (as used in the scoring engine) to educational tooltips
// ══════════════════════════════════════════════════════════════════════════════

export const FACTOR_METHODOLOGIES = {
  "Earnings Growth Trajectory": {
    displayName: "Earnings Surprise (SUE)",
    whatItMeasures: "How much a company's actual earnings exceeded or fell short of analyst expectations, standardized across quarters.",
    whyItMatters: "Academic research shows that stocks with positive earnings surprises tend to continue outperforming for 1-3 quarters (post-earnings announcement drift).",
    scoring: "Positive score = recent earnings beats. Negative = recent earnings misses. Stronger and more consistent surprises score higher.",
  },
  "Revenue Growth Trend": {
    displayName: "Revenue Growth Trend",
    whatItMeasures: "The trajectory of a company's top-line revenue growth over recent quarters, looking for acceleration or deceleration.",
    whyItMatters: "Accelerating revenue growth often precedes stock outperformance, while decelerating growth can signal trouble ahead.",
    scoring: "Positive score = revenue growth is accelerating or consistently strong. Negative = growth is slowing or revenues are declining.",
  },
  "Gross Margin Stability": {
    displayName: "Gross Margin Stability",
    whatItMeasures: "Whether a company's gross profit margins are holding steady, expanding, or contracting over recent quarters.",
    whyItMatters: "Stable or expanding margins indicate pricing power and operational efficiency. Contracting margins often precede earnings disappointments.",
    scoring: "Positive score = margins stable or expanding. Negative = margins compressing. Large swings lower confidence.",
  },
  "Accruals Ratio": {
    displayName: "Accruals Ratio",
    whatItMeasures: "The gap between a company's reported earnings and its actual cash flow. High accruals mean earnings are driven more by accounting adjustments than real cash.",
    whyItMatters: "Research by Sloan (1996) shows that companies with high accruals tend to underperform \u2014 their earnings quality is lower and more likely to reverse.",
    scoring: "Positive score = low accruals (earnings backed by real cash flow). Negative = high accruals (earnings quality concerns).",
  },
  "Price Momentum (12-1)": {
    displayName: "Price Momentum (12-1)",
    whatItMeasures: "The stock's total return over the past 12 months, excluding the most recent month (to avoid short-term reversal effects).",
    whyItMatters: "Jegadeesh & Titman's research demonstrates that stocks with strong recent performance tend to continue performing well over the next 3-12 months.",
    scoring: "Positive score = strong price momentum. Negative = weak or negative momentum. Measured relative to market benchmarks.",
  },
  "10-K Filing Similarity": {
    displayName: "10-K Filing Similarity",
    whatItMeasures: "How much a company's annual 10-K filing language changed compared to the prior year, using semantic text analysis.",
    whyItMatters: "Based on the 'Lazy Prices' research paper \u2014 large language changes in filings often signal material business shifts that predict future returns.",
    scoring: "Positive score = filing language is stable (no red flags). Negative = significant language changes detected (potential risk or undisclosed developments).",
  },
  "Insider Trading": {
    displayName: "Insider Buying vs. Selling",
    whatItMeasures: "The balance of stock purchases vs. sales by company executives and directors (Form 4 filings) over recent months.",
    whyItMatters: "Insiders have the deepest knowledge of their company's prospects. Cluster buying by multiple insiders is one of the strongest bullish signals.",
    scoring: "Positive score = net insider buying, especially by multiple insiders. Negative = heavy insider selling. Routine 10b5-1 plan sales are discounted.",
  },
  "Analyst Dispersion": {
    displayName: "Analyst Forecast Dispersion",
    whatItMeasures: "How much disagreement exists among Wall Street analysts in their earnings estimates for the company.",
    whyItMatters: "Low dispersion means consensus is tight and surprises are less likely. High dispersion signals uncertainty and potential for large moves in either direction.",
    scoring: "Positive score = low dispersion (high analyst agreement). Negative = high dispersion (uncertainty). Extreme dispersion lowers confidence regardless of direction.",
  },
};

// Short key mapping for signal history storage (factor name → chart key)
export const FACTOR_CHART_KEYS = {
  "Earnings Growth Trajectory": "sue",
  "Revenue Growth Trend": "revenueGrowth",
  "Gross Margin Stability": "grossMargin",
  "Accruals Ratio": "accruals",
  "Price Momentum (12-1)": "momentum",
  "10-K Filing Similarity": "tenKSimilarity",
  "Insider Trading": "insiderBuying",
  "Analyst Dispersion": "analystDispersion",
};

// Reverse mapping (chart key → factor name)
export const CHART_KEY_TO_FACTOR = Object.fromEntries(
  Object.entries(FACTOR_CHART_KEYS).map(([k, v]) => [v, k])
);

// Colors for each factor line on the score history chart
export const FACTOR_COLORS = {
  "Earnings Growth Trajectory": "#3B82F6",
  "Revenue Growth Trend": "#10B981",
  "Gross Margin Stability": "#F59E0B",
  "Accruals Ratio": "#8B5CF6",
  "Price Momentum (12-1)": "#EC4899",
  "10-K Filing Similarity": "#06B6D4",
  "Insider Trading": "#F97316",
  "Analyst Dispersion": "#EF4444",
};
