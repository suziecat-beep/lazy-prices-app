// ══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE LAYER — localStorage wrapper for watchlist & per-ticker data
// ══════════════════════════════════════════════════════════════════════════════

const WATCHLIST_KEY = "lp_watchlist";
const TICKER_PREFIX = "lp_ticker_";

// ── Watchlist ──────────────────────────────────────────────────────────────

export function getWatchlist() {
  try {
    return JSON.parse(localStorage.getItem(WATCHLIST_KEY)) || [];
  } catch {
    return [];
  }
}

export function saveWatchlist(tickers) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(tickers));
}

export function addToWatchlist(ticker) {
  const sym = ticker.toUpperCase().trim();
  const list = getWatchlist();
  if (!list.includes(sym)) {
    list.push(sym);
    saveWatchlist(list);
  }
  return list;
}

export function removeFromWatchlist(ticker) {
  const sym = ticker.toUpperCase().trim();
  const list = getWatchlist().filter((t) => t !== sym);
  saveWatchlist(list);
  localStorage.removeItem(TICKER_PREFIX + sym);
  return list;
}

// ── Per-ticker data ────────────────────────────────────────────────────────

export function getTickerData(ticker) {
  try {
    return JSON.parse(localStorage.getItem(TICKER_PREFIX + ticker.toUpperCase()));
  } catch {
    return null;
  }
}

export function saveTickerData(ticker, data) {
  const key = TICKER_PREFIX + ticker.toUpperCase();
  localStorage.setItem(
    key,
    JSON.stringify({ ...data, lastUpdated: Date.now() })
  );
}

// ── Export / Import ────────────────────────────────────────────────────────

export function exportWatchlistJSON() {
  const list = getWatchlist();
  const data = { watchlist: list, tickers: {} };
  list.forEach((t) => {
    const d = getTickerData(t);
    if (d) data.tickers[t] = d;
  });
  return JSON.stringify(data, null, 2);
}

export function importWatchlistJSON(jsonStr) {
  const data = JSON.parse(jsonStr);
  if (Array.isArray(data.watchlist)) saveWatchlist(data.watchlist);
  if (data.tickers) {
    Object.entries(data.tickers).forEach(([t, d]) => {
      localStorage.setItem(TICKER_PREFIX + t.toUpperCase(), JSON.stringify(d));
    });
  }
}
