// ══════════════════════════════════════════════════════════════════════════════
// API CACHING LAYER — localStorage-backed cache for FMP API responses
// Configurable TTL (default 24h), auto-eviction, and stats
// ══════════════════════════════════════════════════════════════════════════════

const CACHE_PREFIX = "fmp_cache:";
const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Build a cache key from endpoint + params.
 * Format: fmp_cache:{endpoint}:{serialized params}
 */
export function getCacheKey(endpoint, params = {}) {
  const paramStr = Object.keys(params).length > 0 ? JSON.stringify(params) : "";
  return `${CACHE_PREFIX}${endpoint}:${paramStr}`;
}

/**
 * Get a cached response. Returns null if missing or expired.
 */
export function getCached(endpoint, params = {}) {
  const key = getCacheKey(endpoint, params);
  const raw = localStorage.getItem(key);
  if (!raw) return null;

  try {
    const cached = JSON.parse(raw);
    const age = Date.now() - new Date(cached.timestamp).getTime();
    if (age < (cached.ttl || DEFAULT_TTL)) {
      return cached.data;
    }
    // Expired
    localStorage.removeItem(key);
    return null;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

/**
 * Store a response in the cache.
 */
export function setCache(endpoint, params = {}, data, ttl = DEFAULT_TTL) {
  const key = getCacheKey(endpoint, params);
  const entry = {
    data,
    timestamp: new Date().toISOString(),
    ttl,
  };
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // localStorage full — evict oldest entries and retry
    clearOldestCacheEntries(5);
    try {
      localStorage.setItem(key, JSON.stringify(entry));
    } catch {
      // Silent fail — caching is nice-to-have
    }
  }
}

/**
 * Get the remaining TTL for a cached entry in milliseconds. Returns null if not cached.
 */
export function getCacheTTLRemaining(endpoint, params = {}) {
  const key = getCacheKey(endpoint, params);
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw);
    const age = Date.now() - new Date(cached.timestamp).getTime();
    const ttl = cached.ttl || DEFAULT_TTL;
    const remaining = ttl - age;
    return remaining > 0 ? remaining : null;
  } catch {
    return null;
  }
}

/**
 * Clear all FMP cache entries.
 */
export function clearAllCache() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
  keys.forEach(k => localStorage.removeItem(k));
}

/**
 * Get cache statistics.
 */
export function getCacheStats() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
  let oldest = null;
  let totalSize = 0;

  keys.forEach(k => {
    const raw = localStorage.getItem(k);
    if (raw) {
      totalSize += raw.length * 2; // rough byte estimate (UTF-16)
      try {
        const parsed = JSON.parse(raw);
        if (!oldest || parsed.timestamp < oldest) oldest = parsed.timestamp;
      } catch { /* skip */ }
    }
  });

  return {
    entryCount: keys.length,
    oldestEntry: oldest,
    totalSizeKB: Math.round(totalSize / 1024),
  };
}

/**
 * Evict the N oldest cache entries to free space.
 */
function clearOldestCacheEntries(count) {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
  const entries = keys.map(k => {
    try {
      const parsed = JSON.parse(localStorage.getItem(k) || "{}");
      return { key: k, timestamp: parsed.timestamp || "" };
    } catch {
      return { key: k, timestamp: "" };
    }
  });
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  entries.slice(0, count).forEach(e => localStorage.removeItem(e.key));
}
