const HISTORY_KEY = "lookupHistory";
const HISTORY_LIMIT = 100;

// Old records with timestamps, URLs, or snapshots are reduced to word + language.
function normalizeHistory(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const result = [];
  for (const item of entries.slice(0, 1000)) {
    const entry = historyEntryFromLookup(item);
    if (!entry) continue;
    const key = `${entry.language}\u0000${entry.word}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length === HISTORY_LIMIT) break;
  }
  return result;
}

function historyEntryFromLookup(item) {
  if (!item || typeof item.word !== "string" || !isSupportedLanguage(item.language)) return null;
  const word = item.word.normalize("NFC");
  if (!isLookupWord(word)) return null;
  return { word, language: item.language };
}
