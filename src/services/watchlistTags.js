// ══════════════════════════════════════════════════════════════════════════════
// WATCHLIST TAGS — User-defined categories for organizing watchlist tickers
// Stores tags and assignments in localStorage under 'watchlist_tags'
// ══════════════════════════════════════════════════════════════════════════════

const STORAGE_KEY = "watchlist_tags";

const TAG_COLORS = [
  "#3B82F6", // blue
  "#10B981", // emerald
  "#F59E0B", // amber
  "#EF4444", // red
  "#8B5CF6", // violet
  "#EC4899", // pink
  "#06B6D4", // cyan
  "#F97316", // orange
];

const DEFAULT_SUGGESTED_TAGS = [
  "Tech", "Value", "Growth", "Speculative", "Dividend", "Earnings Watch",
];

let _idCounter = 0;

function generateId() {
  _idCounter++;
  return `tag_${Date.now()}_${_idCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Get the full tag store from localStorage.
 * @returns {{ tags: Array<{ id: string, name: string, color: string }>, assignments: Record<string, string[]> }}
 */
export function getTagStore() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { tags: [], assignments: {} };
  try {
    return JSON.parse(raw);
  } catch {
    return { tags: [], assignments: {} };
  }
}

function saveTagStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/**
 * Create a new tag with auto-assigned color.
 * @param {string} name
 * @returns {{ id: string, name: string, color: string }}
 */
export function createTag(name) {
  const store = getTagStore();
  const color = TAG_COLORS[store.tags.length % TAG_COLORS.length];
  const tag = { id: generateId(), name: name.trim(), color };
  store.tags.push(tag);
  saveTagStore(store);
  return tag;
}

/**
 * Delete a tag and remove it from all ticker assignments.
 * @param {string} tagId
 */
export function deleteTag(tagId) {
  const store = getTagStore();
  store.tags = store.tags.filter(t => t.id !== tagId);
  // Remove from all assignments
  for (const ticker of Object.keys(store.assignments)) {
    store.assignments[ticker] = store.assignments[ticker].filter(id => id !== tagId);
    if (store.assignments[ticker].length === 0) {
      delete store.assignments[ticker];
    }
  }
  saveTagStore(store);
}

/**
 * Rename a tag.
 * @param {string} tagId
 * @param {string} newName
 */
export function renameTag(tagId, newName) {
  const store = getTagStore();
  const tag = store.tags.find(t => t.id === tagId);
  if (tag) {
    tag.name = newName.trim();
    saveTagStore(store);
  }
}

/**
 * Assign a tag to a ticker.
 * @param {string} ticker
 * @param {string} tagId
 */
export function assignTag(ticker, tagId) {
  const store = getTagStore();
  const key = ticker.toUpperCase();
  if (!store.assignments[key]) store.assignments[key] = [];
  if (!store.assignments[key].includes(tagId)) {
    store.assignments[key].push(tagId);
    saveTagStore(store);
  }
}

/**
 * Remove a tag from a ticker.
 * @param {string} ticker
 * @param {string} tagId
 */
export function removeTagFromTicker(ticker, tagId) {
  const store = getTagStore();
  const key = ticker.toUpperCase();
  if (store.assignments[key]) {
    store.assignments[key] = store.assignments[key].filter(id => id !== tagId);
    if (store.assignments[key].length === 0) {
      delete store.assignments[key];
    }
    saveTagStore(store);
  }
}

/**
 * Get all tags assigned to a ticker.
 * @param {string} ticker
 * @returns {Array<{ id: string, name: string, color: string }>}
 */
export function getTickerTags(ticker) {
  const store = getTagStore();
  const ids = store.assignments[ticker.toUpperCase()] || [];
  return ids.map(id => store.tags.find(t => t.id === id)).filter(Boolean);
}

/**
 * Get all tickers that have a given tag.
 * @param {string} tagId
 * @returns {string[]}
 */
export function getTickersByTag(tagId) {
  const store = getTagStore();
  return Object.entries(store.assignments)
    .filter(([, ids]) => ids.includes(tagId))
    .map(([ticker]) => ticker);
}

/**
 * Get the default suggested tags (for initial setup UI).
 * @returns {string[]}
 */
export function getDefaultSuggestedTags() {
  return DEFAULT_SUGGESTED_TAGS;
}
