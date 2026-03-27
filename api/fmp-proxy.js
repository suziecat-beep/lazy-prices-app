// Vercel serverless function — proxies FMP API requests so the key stays server-side.
// The API key is read from the Vercel environment variable FMP_API_KEY.

const FMP_BASE = "https://financialmodelingprep.com/stable";

export default async function handler(req, res) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "FMP_API_KEY not configured on server" });
  }

  const { endpoint, ...params } = req.query;
  if (!endpoint) {
    return res.status(400).json({ error: "Missing 'endpoint' query parameter" });
  }

  // Only allow known FMP endpoints (prevent open relay)
  const allowed = [
    "quote",
    "income-statement",
    "balance-sheet-statement",
    "cash-flow-statement",
    "historical-price-eod/full",
    "insider-trading",
    "analyst-estimates",
  ];
  if (!allowed.includes(endpoint)) {
    return res.status(400).json({ error: `Endpoint "${endpoint}" is not allowed` });
  }

  const url = new URL(`${FMP_BASE}/${endpoint}`);
  url.searchParams.set("apikey", apiKey);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  try {
    const response = await fetch(url.toString());
    const text = await response.text();

    // Forward FMP's status code and body as-is
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(response.status);

    // Try to return as JSON, fall back to text
    try {
      res.json(JSON.parse(text));
    } catch {
      res.send(text);
    }
  } catch (err) {
    res.status(502).json({ error: `Upstream error: ${err.message}` });
  }
}
