# Asset Evaluation Model — Tier 1 Implementation Spec

## Project Context

This project transforms an existing web-based artifact (HTML/JS site analyzing 10-K filing language changes) into a full **11-point asset evaluation and trading signal model**. The model takes a stock ticker as input and returns a **BUY / HOLD / SELL** signal based on the composite score of all 11 factors.

This spec covers the **first 5 factors (Tier 1)** — the highest-impact, lowest-effort signals to implement. The remaining 6 factors will be added in subsequent tiers.

### End-State Architecture (for reference)
```
User inputs ticker
    → Data Fetcher Layer (API calls)
    → Factor Computation Layer (11 modules, each returns a score)
    → Composite Scoring Engine (weighted aggregation)
    → Signal Output: BUY / HOLD / SELL + confidence level + factor breakdown
    → (Future) Brokerage Integration for trade execution
    → (Future) Derivatives/options/hedging layer
```

### Data Provider: Financial Modeling Prep (FMP)

**Base URL:** `https://financialmodelingprep.com/api/v3/`
**Auth:** API key passed as query param `?apikey=YOUR_KEY`
**Free tier:** 250 calls/day (sufficient for dev; $19/mo paid tier for production)
**Docs:** https://site.financialmodelingprep.com/developer/docs

Store the API key in an environment variable: `FMP_API_KEY`

---

## Overall File Structure

```
project-root/
├── index.html                  # Existing artifact (10-K analyzer UI)
├── config.js                   # API keys, scoring weights, thresholds
├── api/
│   └── fmp.js                  # FMP API client (all HTTP calls go through here)
├── factors/
│   ├── factor-base.js          # Base class / shared interface for all factors
│   ├── earnings-surprise.js    # Factor 1: Earnings Surprise Trajectory
│   ├── revenue-growth.js       # Factor 2: Revenue Growth Trend
│   ├── gross-margin.js         # Factor 3: Gross Margin Stability
│   ├── accruals-ratio.js       # Factor 4: Accruals Ratio
│   └── price-momentum.js       # Factor 5: Price Momentum (12-1)
├── engine/
│   ├── scoring.js              # Composite scoring engine
│   └── signal.js               # BUY/HOLD/SELL signal generator
├── ui/
│   └── dashboard.js            # UI rendering for factor breakdown + signal
└── utils/
    └── helpers.js              # Date math, formatting, statistics helpers
```

---

## Shared Interfaces & Conventions

### Factor Interface

Every factor module MUST export a class or object that implements this interface:

```javascript
// factors/factor-base.js

class FactorBase {
    constructor(name, weight) {
        this.name = name;       // e.g., "Earnings Surprise Trajectory"
        this.weight = weight;   // default weight in composite score (0.0 - 1.0)
        this.category = "";     // "fundamental", "intermediate", "sophisticated"
    }

    /**
     * Fetch raw data from FMP API for a given ticker.
     * @param {string} ticker - Stock ticker symbol (e.g., "AAPL")
     * @returns {Promise<object>} - Raw API response data
     */
    async fetchData(ticker) {
        throw new Error("fetchData() must be implemented");
    }

    /**
     * Compute the factor score from raw data.
     * @param {object} rawData - Output from fetchData()
     * @returns {object} - { score: number (-1 to +1), signal: string, details: object }
     *   score: -1.0 (max bearish) to +1.0 (max bullish), 0 = neutral
     *   signal: "BULLISH" | "BEARISH" | "NEUTRAL"
     *   details: factor-specific breakdown for UI display
     */
    computeScore(rawData) {
        throw new Error("computeScore() must be implemented");
    }

    /**
     * Full pipeline: fetch + compute.
     * @param {string} ticker
     * @returns {Promise<object>} - { name, score, signal, weight, details }
     */
    async evaluate(ticker) {
        const rawData = await this.fetchData(ticker);
        const result = this.computeScore(rawData);
        return {
            name: this.name,
            category: this.category,
            weight: this.weight,
            ...result
        };
    }
}
```

### Scoring Convention (ALL factors use this)

| Score Range | Meaning |
|-------------|---------|
| +0.7 to +1.0 | Strongly bullish |
| +0.3 to +0.7 | Moderately bullish |
| 0.0 to +0.3 | Slightly bullish / neutral |
| -0.3 to 0.0 | Slightly bearish / neutral |
| -0.7 to -0.3 | Moderately bearish |
| -1.0 to -0.7 | Strongly bearish |

### FMP API Client

```javascript
// api/fmp.js

const FMP_BASE = "https://financialmodelingprep.com/api/v3";

class FMPClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    async fetch(endpoint, params = {}) {
        const url = new URL(`${FMP_BASE}/${endpoint}`);
        url.searchParams.set("apikey", this.apiKey);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

        const response = await fetch(url.toString());
        if (!response.ok) {
            throw new Error(`FMP API error: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }

    // Convenience methods for common endpoints
    async incomeStatement(ticker, period = "quarter", limit = 8) {
        return this.fetch(`income-statement/${ticker}`, { period, limit });
    }

    async balanceSheet(ticker, period = "quarter", limit = 8) {
        return this.fetch(`balance-sheet-statement/${ticker}`, { period, limit });
    }

    async cashFlowStatement(ticker, period = "quarter", limit = 8) {
        return this.fetch(`cash-flow-statement/${ticker}`, { period, limit });
    }

    async historicalPrice(ticker, from, to) {
        return this.fetch(`historical-price-full/${ticker}`, { from, to });
    }

    async earningsSurprises(ticker) {
        return this.fetch(`earnings-surprises/${ticker}`);
    }

    async quote(ticker) {
        return this.fetch(`quote/${ticker}`);
    }
}
```

---

## Factor 1: Earnings Surprise Trajectory (SUE)

### Purpose
Measures whether the company has been beating or missing analyst EPS estimates over the last 4 quarters, and by how much. Consecutive misses combined with a high-change 10-K is a strong bearish signal. References the Standardized Unexpected Earnings (SUE) measure from the academic literature.

### FMP API Endpoint
```
GET /api/v3/earnings-surprises/{ticker}
```

**Response shape (array, most recent first):**
```json
[
    {
        "date": "2025-01-30",
        "symbol": "AAPL",
        "actualEarningResult": 2.40,
        "estimatedEarning": 2.35
    }
]
```

### Computation Logic

```
For each of the last 4 quarters:
    surprise_pct[i] = (actual - estimated) / abs(estimated) * 100

    If estimated == 0:
        surprise_pct[i] = actual > 0 ? +100 : actual < 0 ? -100 : 0

trajectory_classification:
    - "CONSECUTIVE_BEATS": all 4 quarters actual > estimated
    - "CONSECUTIVE_MISSES": all 4 quarters actual < estimated
    - "IMPROVING": most recent 2 quarters are beats, prior 2 include misses
    - "DETERIORATING": most recent 2 quarters include misses, prior 2 were beats
    - "MIXED": anything else

avg_surprise_pct = mean(surprise_pct[0..3])

Score mapping:
    CONSECUTIVE_BEATS + avg_surprise > 5%    → +0.9
    CONSECUTIVE_BEATS + avg_surprise 1-5%    → +0.7
    CONSECUTIVE_BEATS + avg_surprise 0-1%    → +0.5
    IMPROVING                                → +0.3
    MIXED + avg_surprise > 0                 → +0.1
    MIXED + avg_surprise <= 0                → -0.1
    DETERIORATING                            → -0.3
    CONSECUTIVE_MISSES + avg_surprise -1-0%  → -0.5
    CONSECUTIVE_MISSES + avg_surprise -5--1% → -0.7
    CONSECUTIVE_MISSES + avg_surprise < -5%  → -0.9
```

### Details Object (for UI display)
```json
{
    "quarters": [
        { "date": "2025-01-30", "actual": 2.40, "estimated": 2.35, "surprise_pct": 2.13 },
        ...
    ],
    "trajectory": "CONSECUTIVE_BEATS",
    "avg_surprise_pct": 3.45,
    "score": 0.7
}
```

### Default Weight: 0.12

---

## Factor 2: Revenue Growth Trend

### Purpose
Measures year-over-year and quarter-over-quarter top-line growth direction. A decelerating grower that is also a strong 10-K changer is a compounding red flag.

### FMP API Endpoint
```
GET /api/v3/income-statement/{ticker}?period=quarter&limit=8
```

**Key fields needed from response:** `date`, `revenue`

### Computation Logic

```
Pull last 8 quarters of revenue data (gives 4 quarters of YoY data).

For each of the last 4 quarters:
    yoy_growth[i] = (revenue[i] - revenue[i+4]) / abs(revenue[i+4]) * 100
    qoq_growth[i] = (revenue[i] - revenue[i+1]) / abs(revenue[i+1]) * 100

trend_classification (based on yoy_growth trajectory):
    yoy_growth values are ordered most recent → oldest

    If yoy_growth[0] > yoy_growth[1] > yoy_growth[2]:
        trend = "ACCELERATING"
    Else if yoy_growth[0] < yoy_growth[1] < yoy_growth[2]:
        trend = "DECELERATING"
    Else if all yoy_growth within ±2pp of each other:
        trend = "STABLE"
    Else:
        trend = "MIXED"

latest_yoy = yoy_growth[0]

Score mapping:
    ACCELERATING + latest_yoy > 20%     → +0.9
    ACCELERATING + latest_yoy 5-20%     → +0.7
    ACCELERATING + latest_yoy 0-5%      → +0.5
    STABLE + latest_yoy > 10%           → +0.4
    STABLE + latest_yoy 0-10%           → +0.1
    MIXED + latest_yoy > 0              → +0.1
    MIXED + latest_yoy <= 0             → -0.2
    STABLE + latest_yoy < 0             → -0.3
    DECELERATING + latest_yoy > 0       → -0.4
    DECELERATING + latest_yoy -10-0%    → -0.6
    DECELERATING + latest_yoy < -10%    → -0.9
```

### Details Object
```json
{
    "quarters": [
        { "date": "2024-12-31", "revenue": 124000000000, "yoy_growth_pct": 8.5, "qoq_growth_pct": 2.1 },
        ...
    ],
    "trend": "ACCELERATING",
    "latest_yoy_pct": 8.5,
    "latest_qoq_pct": 2.1,
    "score": 0.7
}
```

### Default Weight: 0.10

---

## Factor 3: Gross Margin Stability

### Purpose
Whether margins are expanding, stable, or compressing. Margin compression often precedes negative operational disclosures found in 10-K language changes.

### FMP API Endpoint
Same as Factor 2 — reuse the income statement data:
```
GET /api/v3/income-statement/{ticker}?period=quarter&limit=8
```

**Key fields:** `grossProfit`, `revenue`

### Computation Logic

```
For each of the last 8 quarters:
    gross_margin[i] = grossProfit[i] / revenue[i] * 100

For the most recent 4 quarters:
    avg_recent_margin = mean(gross_margin[0..3])
    avg_prior_margin = mean(gross_margin[4..7])
    margin_change_pp = avg_recent_margin - avg_prior_margin

Trend classification (using linear regression slope across 8 quarters):
    slope = linear_regression_slope(gross_margin[0..7])
        (x-axis = quarter index 0-7, y-axis = margin value)
        (quarter index 0 = most recent)

    If slope > +0.3 pp/quarter:
        trend = "EXPANDING"
    Else if slope < -0.3 pp/quarter:
        trend = "COMPRESSING"
    Else:
        trend = "STABLE"

    volatility = standard_deviation(gross_margin[0..7])
    is_volatile = volatility > 3.0  (flag if margins swing a lot)

Score mapping:
    EXPANDING + margin_change > 3pp    → +0.8
    EXPANDING + margin_change 1-3pp    → +0.5
    EXPANDING + margin_change 0-1pp    → +0.3
    STABLE + not volatile              → +0.1
    STABLE + volatile                  → -0.1
    COMPRESSING + margin_change 0--2pp → -0.4
    COMPRESSING + margin_change -2--5pp → -0.7
    COMPRESSING + margin_change < -5pp → -0.9
```

### Details Object
```json
{
    "quarters": [
        { "date": "2024-12-31", "gross_margin_pct": 46.2 },
        ...
    ],
    "trend": "STABLE",
    "avg_recent_margin_pct": 45.8,
    "avg_prior_margin_pct": 45.5,
    "margin_change_pp": 0.3,
    "volatility": 1.2,
    "slope_pp_per_quarter": 0.08,
    "score": 0.1
}
```

### Default Weight: 0.08

### Implementation Note
Factors 2 and 3 share the same API call. The FMP client should cache responses within a single evaluation run so you don't double-count against your API rate limit. Implement a simple in-memory cache keyed by `endpoint+ticker` that lives for the duration of one `evaluate(ticker)` call.

---

## Factor 4: Accruals Ratio

### Purpose
Measures the gap between reported earnings and actual cash flow from operations. High accruals (earnings running ahead of cash) is the classic Sloan (1996) anomaly. A high-accruals firm that is also a strong 10-K language changer is doubly at risk of future underperformance.

### FMP API Endpoints
Two calls needed (can be parallelized):

```
GET /api/v3/income-statement/{ticker}?period=annual&limit=2
GET /api/v3/cash-flow-statement/{ticker}?period=annual&limit=2
GET /api/v3/balance-sheet-statement/{ticker}?period=annual&limit=2
```

**Key fields:**
- Income statement: `netIncome`
- Cash flow: `operatingCashFlow`
- Balance sheet: `totalAssets`

### Computation Logic

```
Use the most recent annual data:

accruals = netIncome - operatingCashFlow
accruals_ratio = accruals / totalAssets

Industry context note: The raw accruals ratio is most meaningful
in cross-section. For a single-stock signal, use absolute thresholds
derived from the Sloan (1996) distribution:
    - Median accruals ratio is roughly -0.04 (cash > earnings is normal)
    - >+0.05 is high accruals (top decile, bearish)
    - <-0.10 is very low accruals (bottom decile, bullish — lots of cash backing earnings)

Also compute the year-over-year change:
    prior_accruals_ratio = (prior_netIncome - prior_operatingCashFlow) / prior_totalAssets
    accruals_change = accruals_ratio - prior_accruals_ratio

Score mapping:
    accruals_ratio < -0.10                    → +0.8 (very cash-backed earnings)
    accruals_ratio -0.10 to -0.06             → +0.5
    accruals_ratio -0.06 to -0.02             → +0.2 (normal range)
    accruals_ratio -0.02 to +0.02             → 0.0  (neutral)
    accruals_ratio +0.02 to +0.05             → -0.3
    accruals_ratio +0.05 to +0.10             → -0.6 (high accruals, bearish)
    accruals_ratio > +0.10                    → -0.9 (very high accruals, strongly bearish)

    Adjust by change: if accruals_change > +0.03 (accruals worsening), subtract 0.1
                      if accruals_change < -0.03 (accruals improving), add 0.1
    Clamp final score to [-1.0, +1.0]
```

### Details Object
```json
{
    "net_income": 94000000000,
    "operating_cash_flow": 110000000000,
    "total_assets": 352000000000,
    "accruals": -16000000000,
    "accruals_ratio": -0.045,
    "prior_accruals_ratio": -0.038,
    "accruals_change": -0.007,
    "score": 0.2
}
```

### Default Weight: 0.08

---

## Factor 5: Price Momentum (12-month minus 1-month, Jegadeesh-Titman)

### Purpose
The stock's 12-month return excluding the most recent month. This is the standard momentum measure from the academic literature. Knowing whether you're running with or against the momentum factor helps assess trade risk and timing.

### FMP API Endpoint
```
GET /api/v3/historical-price-full/{ticker}?from=YYYY-MM-DD&to=YYYY-MM-DD
```

**Key fields from `historical`:** `date`, `adjClose` (use adjusted close for splits/dividends)

### Computation Logic

```
today = current date
t_minus_1m = today - 21 trading days (approx 1 calendar month)
t_minus_12m = today - 252 trading days (approx 12 calendar months)

Fetch daily prices from t_minus_12m to today.

price_at_t_minus_12m = adjClose on or nearest to t_minus_12m
price_at_t_minus_1m = adjClose on or nearest to t_minus_1m

momentum_return = (price_at_t_minus_1m - price_at_t_minus_12m) / price_at_t_minus_12m * 100

Also compute the recent 1-month return for context:
price_today = most recent adjClose
recent_return = (price_today - price_at_t_minus_1m) / price_at_t_minus_1m * 100

Score mapping:
    momentum_return > +40%   → +0.9
    momentum_return +20-40%  → +0.7
    momentum_return +10-20%  → +0.5
    momentum_return +5-10%   → +0.3
    momentum_return 0-5%     → +0.1
    momentum_return -5-0%    → -0.1
    momentum_return -10--5%  → -0.3
    momentum_return -20--10% → -0.5
    momentum_return -40--20% → -0.7
    momentum_return < -40%   → -0.9
```

### Date Calculation Helper
```javascript
function getTradeDate(daysAgo) {
    // Walk backward from today, skipping weekends
    // Does NOT account for market holidays (acceptable approximation)
    let date = new Date();
    let count = 0;
    while (count < daysAgo) {
        date.setDate(date.getDate() - 1);
        const day = date.getDay();
        if (day !== 0 && day !== 6) count++;
    }
    return date.toISOString().split('T')[0]; // "YYYY-MM-DD"
}
```

### Details Object
```json
{
    "price_12m_ago": 142.50,
    "price_1m_ago": 178.30,
    "price_current": 182.10,
    "momentum_return_pct": 25.12,
    "recent_1m_return_pct": 2.13,
    "date_12m_ago": "2024-03-26",
    "date_1m_ago": "2025-02-24",
    "score": 0.7
}
```

### Default Weight: 0.08

---

## Composite Scoring Engine

### File: `engine/scoring.js`

```javascript
/**
 * Takes the results from all evaluated factors and produces a composite score.
 *
 * composite_score = sum(factor_score[i] * factor_weight[i]) / sum(factor_weight[i])
 *
 * This is a weighted average, not a simple sum, so it naturally stays in [-1, +1].
 * Weights are normalized so they always sum to 1.0 regardless of how many
 * factors are active (handles the case where a factor fails to fetch data).
 */

function computeComposite(factorResults) {
    // Filter out any factors that returned null/error
    const valid = factorResults.filter(f => f && f.score !== null && f.score !== undefined);

    if (valid.length === 0) return { composite: 0, signal: "NO_DATA", confidence: 0 };

    const totalWeight = valid.reduce((sum, f) => sum + f.weight, 0);
    const weightedSum = valid.reduce((sum, f) => sum + (f.score * f.weight), 0);
    const composite = weightedSum / totalWeight;

    return {
        composite: Math.round(composite * 1000) / 1000, // 3 decimal places
        signal: getSignal(composite),
        confidence: getConfidence(composite, valid.length),
        factorCount: valid.length,
        totalFactors: factorResults.length,
        factors: valid
    };
}
```

### Signal Thresholds

```
composite >= +0.25   → "BUY"
composite <= -0.25   → "SELL"
-0.25 < composite < +0.25 → "HOLD"
```

### Confidence Score

Confidence reflects both the strength of the signal and how many factors contributed:

```
base_confidence = abs(composite) / 1.0 * 100   (0-100%)
coverage_penalty = (totalFactors - validFactors) / totalFactors * 20
final_confidence = max(0, base_confidence - coverage_penalty)
```

A composite of +0.6 with all 5 factors reporting = ~60% confidence.
A composite of +0.6 with only 3 of 5 factors reporting = ~52% confidence.

---

## Default Weights (Tier 1 — 5 factors)

These weights are for Tier 1 only. When all 11 factors are implemented, the weights will be redistributed. For now, they sum to approximately 0.46, and the composite scoring engine normalizes them.

| Factor | Weight | Rationale |
|--------|--------|-----------|
| Earnings Surprise (SUE) | 0.12 | Strong empirical predictor, directly from paper |
| Revenue Growth Trend | 0.10 | Fundamental signal, compound interaction with 10-K |
| Gross Margin Stability | 0.08 | Leading indicator of operational stress |
| Accruals Ratio | 0.08 | Classic anomaly, paper controls for it explicitly |
| Price Momentum (12-1) | 0.08 | Risk/timing context, standard factor |

The user should be able to adjust these weights via `config.js`.

---

## Config File

```javascript
// config.js

const CONFIG = {
    fmp: {
        apiKey: process.env.FMP_API_KEY || "YOUR_KEY_HERE",
        baseUrl: "https://financialmodelingprep.com/api/v3",
        rateLimitPerDay: 250
    },

    weights: {
        earningsSurprise: 0.12,
        revenueGrowth: 0.10,
        grossMargin: 0.08,
        accrualsRatio: 0.08,
        priceMomentum: 0.08
        // Future Tier 2 & 3 factors will be added here
    },

    signalThresholds: {
        buy: 0.25,
        sell: -0.25
    },

    // Number of quarters of data to fetch for each factor
    dataDepth: {
        earningsSurpriseQuarters: 4,
        revenueQuarters: 8,
        marginQuarters: 8,
        accrualsYears: 2,
        momentumMonths: 13
    }
};
```

---

## API Call Budget Per Evaluation

Each full ticker evaluation uses these FMP API calls:

| Call | Endpoint | Used By |
|------|----------|---------|
| 1 | `earnings-surprises/{ticker}` | Factor 1 |
| 2 | `income-statement/{ticker}?period=quarter&limit=8` | Factors 2 & 3 (shared) |
| 3 | `income-statement/{ticker}?period=annual&limit=2` | Factor 4 |
| 4 | `cash-flow-statement/{ticker}?period=annual&limit=2` | Factor 4 |
| 5 | `balance-sheet-statement/{ticker}?period=annual&limit=2` | Factor 4 |
| 6 | `historical-price-full/{ticker}?from=...&to=...` | Factor 5 |

**Total: 6 API calls per ticker evaluation.**
At 250 calls/day on the free tier, you can evaluate ~41 tickers per day.

---

## UI Integration Notes

The existing artifact should be extended with:

1. **Ticker input field** — text input + "Evaluate" button
2. **Signal banner** — large BUY (green) / HOLD (yellow) / SELL (red) display with confidence %
3. **Factor breakdown table** — each factor showing:
   - Factor name
   - Individual score (-1 to +1) with a color-coded bar
   - Signal direction (BULLISH / BEARISH / NEUTRAL)
   - Key detail (e.g., "4 consecutive beats, avg +3.4%")
   - Weight in composite
4. **Factor detail expandable panels** — clicking a factor row shows the full details object with charts where appropriate (margin trend line, revenue bars, price chart)

---

## Error Handling Requirements

1. **API failures**: If a single factor's API call fails, that factor returns `null` and is excluded from the composite. The UI shows "Data unavailable" for that factor. Never let one factor failure crash the entire evaluation.
2. **Insufficient data**: If a company is too new (e.g., < 4 quarters of data), factors should gracefully degrade — use whatever data is available and note the reduced confidence.
3. **Rate limiting**: Track API call count. If approaching the daily limit, warn the user before running an evaluation.
4. **Invalid tickers**: Validate the ticker exists via the quote endpoint before running the full evaluation pipeline. Surface a clear error if the ticker is not found.

---

## Testing Checklist

After implementation, verify each factor against these known stocks:

| Ticker | Why | Expected patterns |
|--------|-----|-------------------|
| AAPL | Large cap, stable grower | Consistent beats, stable margins, positive momentum |
| SMCI | Volatile, high growth then problems | Revenue deceleration, margin compression |
| GME | Meme stock, unusual patterns | Mixed earnings, high momentum volatility |
| JNJ | Defensive, stable | Stable everything, near-neutral scores |
| RIVN | Pre-profit growth company | Negative earnings, potential accrual anomalies |

---

## Instructions for Claude Code

1. Read this entire spec first.
2. Set up the project structure as defined above.
3. Implement `api/fmp.js` first with request caching.
4. Implement each factor module in order (1 through 5).
5. Implement the composite scoring engine.
6. Integrate with the existing UI.
7. Test with the tickers in the testing checklist.
8. Commit to the connected GitHub repo.

The user's FMP API key should be prompted for on first run and stored in an env variable or config. Do not hardcode it.
