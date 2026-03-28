// ══════════════════════════════════════════════════════════════════════════════
// SIGNAL HISTORY — Track signal changes per ticker over time
// Stores rolling window of evaluations in localStorage per ticker
// ══════════════════════════════════════════════════════════════════════════════

const MAX_HISTORY = 20;
const SIGNAL_RANK = { SELL: 0, HOLD: 1, BUY: 2 };

/**
 * Get the signal history for a ticker.
 * @param {string} ticker
 * @returns {Array<{ signal: string, compositeScore: number, confidence: number, evaluatedAt: string }>}
 */
export function getSignalHistory(ticker) {
  const raw = localStorage.getItem(`signal_history:${ticker.toUpperCase()}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Record a new signal evaluation for a ticker.
 * Returns a SignalChange object if the signal changed from the previous entry, null otherwise.
 * @param {string} ticker
 * @param {{ signal: string, compositeScore: number, confidence: number, evaluatedAt: string }} entry
 * @returns {{ ticker: string, previousSignal: string, currentSignal: string, changedAt: string, direction: string } | null}
 */
export function recordSignal(ticker, entry) {
  const key = `signal_history:${ticker.toUpperCase()}`;
  const history = getSignalHistory(ticker);
  const previous = history.length > 0 ? history[history.length - 1] : null;

  // Append new entry and trim to MAX_HISTORY
  history.push(entry);
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  localStorage.setItem(key, JSON.stringify(history));

  // Determine if signal changed
  if (previous && previous.signal !== entry.signal) {
    const prevRank = SIGNAL_RANK[previous.signal];
    const currRank = SIGNAL_RANK[entry.signal];
    return {
      ticker: ticker.toUpperCase(),
      previousSignal: previous.signal,
      currentSignal: entry.signal,
      changedAt: entry.evaluatedAt,
      direction: currRank > prevRank ? "upgrade" : currRank < prevRank ? "downgrade" : "lateral",
    };
  }

  return null;
}

/**
 * Get recent signal changes across multiple tickers within the last N days.
 * Returns at most one change per ticker (the most recent), sorted by most recent first.
 * @param {string[]} tickers
 * @param {number} withinDays
 * @returns {Array<{ ticker: string, previousSignal: string, currentSignal: string, changedAt: string, direction: string }>}
 */
export function getRecentChanges(tickers, withinDays = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - withinDays);
  const changes = [];

  for (const ticker of tickers) {
    const history = getSignalHistory(ticker);
    // Walk backward through history looking for signal transitions
    for (let i = history.length - 1; i > 0; i--) {
      const entryDate = new Date(history[i].evaluatedAt);
      if (entryDate < cutoff) break;

      if (history[i].signal !== history[i - 1].signal) {
        const prevRank = SIGNAL_RANK[history[i - 1].signal];
        const currRank = SIGNAL_RANK[history[i].signal];
        changes.push({
          ticker: ticker.toUpperCase(),
          previousSignal: history[i - 1].signal,
          currentSignal: history[i].signal,
          changedAt: history[i].evaluatedAt,
          direction: currRank > prevRank ? "upgrade" : currRank < prevRank ? "downgrade" : "lateral",
        });
        break; // Only report most recent change per ticker
      }
    }
  }

  return changes.sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime());
}

/**
 * Get the most recent signal change for a specific ticker (if any, from last evaluation).
 * Compares the last two history entries.
 * @param {string} ticker
 * @returns {{ previousSignal: string, currentSignal: string, direction: string } | null}
 */
export function getLastSignalChange(ticker) {
  const history = getSignalHistory(ticker);
  if (history.length < 2) return null;
  const prev = history[history.length - 2];
  const curr = history[history.length - 1];
  if (prev.signal === curr.signal) return null;
  const prevRank = SIGNAL_RANK[prev.signal];
  const currRank = SIGNAL_RANK[curr.signal];
  return {
    previousSignal: prev.signal,
    currentSignal: curr.signal,
    direction: currRank > prevRank ? "upgrade" : currRank < prevRank ? "downgrade" : "lateral",
  };
}
