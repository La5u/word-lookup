// Firefox loads these through manifest background scripts instead.
if (typeof importScripts === "function") {
  importScripts("languages.js", "shared.js", "history.js");
}

const API = "https://en.wiktionary.org/api/rest_v1/page/definition/";
const APERTIUM_API = "https://www.apertium.org/apy/analyze";
const API_USER_AGENT = `WordLookup/${chrome.runtime.getManifest().version} (https://github.com/La5u/word-lookup)`;
const CACHE_LIMIT = 100;
const FETCH_TIMEOUT_MS = 10000;
const cache = new Map();
let historyWrite = Promise.resolve();
let enabledToggle = Promise.resolve();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["fetchEntry", "fetchGender", "recordLookup", "clearHistory"]
    .includes(message.type)) return;

  const request = message.type === "fetchEntry"
    ? fetchEntry(message.word, message.language)
    : message.type === "fetchGender"
      ? fetchGender(message.word, message.language)
      : queueHistoryMutation(message);
  request
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({
      ok: false,
      error: error.code || "unavailable"
    }));
  return true;
});

if (chrome.commands?.onCommand?.addListener) {
  chrome.commands.onCommand.addListener((command) => {
    if (command !== "toggle-enabled") return;
    enabledToggle = enabledToggle.then(async () => {
      const settings = await chrome.storage.local.get({ enabled: true });
      await chrome.storage.local.set({ enabled: settings.enabled === false });
    }).catch(() => {});
  });
}

function queueHistoryMutation(message) {
  const mutation = historyWrite.then(() =>
    message.type === "recordLookup" ? recordLookup(message) : clearHistory());
  historyWrite = mutation.catch(() => {});
  return mutation;
}

async function recordLookup(message) {
  const entry = historyEntryFromLookup(message);
  if (!entry) throw lookupError("invalid");

  const history = await storedHistory();
  const next = normalizeHistory([entry, ...history]);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return entry;
}

async function clearHistory() {
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  return [];
}

async function storedHistory() {
  const stored = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
  return normalizeHistory(stored?.[HISTORY_KEY]);
}

async function fetchEntry(word, language) {
  if (!isLookupWord(word) || !isSupportedLanguage(language)) {
    throw lookupError("invalid");
  }

  const lowercase = word.toLocaleLowerCase(language);
  const preserveCase = WORD_LOOKUP_LANGUAGES[language].preserveCase;
  // Case-preserving languages always need both spellings, so request them together.
  if (preserveCase && lowercase !== word) fetchDefinitions(lowercase).catch(() => {});
  const exactEntries = entriesFor(await fetchDefinitions(word), language);
  const exactIsProperNoun = exactEntries.length
    && exactEntries.every((entry) => entry.partOfSpeech?.toLowerCase() === "proper noun");

  if (lowercase !== word && (preserveCase || !exactEntries.length || exactIsProperNoun)) {
    let lowercaseEntries = [];
    try {
      lowercaseEntries = entriesFor(await fetchDefinitions(lowercase), language);
    } catch (error) {
      if (!exactEntries.length) throw error;
    }
    if (preserveCase && exactEntries.length && lowercaseEntries.length) {
      return {
        word,
        variants: [word, lowercase],
        entries: [
          ...exactEntries.map((entry) => ({ ...entry, lookupVariant: word })),
          ...lowercaseEntries.map((entry) => ({ ...entry, lookupVariant: lowercase }))
        ]
      };
    }
    if (lowercaseEntries.length) return { word: lowercase, entries: lowercaseEntries };
  }

  if (exactEntries.length) return { word, entries: exactEntries };

  if (preserveCase) {
    const [first = "", ...rest] = [...lowercase];
    const titlecase = first.toLocaleUpperCase(language) + rest.join("");
    if (titlecase !== word) {
      const titlecaseEntries = entriesFor(await fetchDefinitions(titlecase), language);
      if (titlecaseEntries.length) return { word: titlecase, entries: titlecaseEntries };
    }
  }

  throw lookupError("not_found");
}

function entriesFor(data, language) {
  if (!data || typeof data !== "object" || Array.isArray(data)
    || !Array.isArray(data[language])) return [];
  return data[language].map(normalizeEntry).filter(Boolean);
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || !Array.isArray(entry.definitions)) return null;
  const definitions = entry.definitions.map(normalizeDefinition).filter(Boolean);
  if (!definitions.length) return null;
  const partOfSpeech = typeof entry.partOfSpeech === "string" && entry.partOfSpeech.trim()
    ? entry.partOfSpeech
    : "Entry";
  return { partOfSpeech, definitions };
}

function normalizeDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)
    || typeof definition.definition !== "string" || !definition.definition.trim()) return null;

  const normalized = { definition: definition.definition };
  const parsedExamples = normalizeParsedExamples(definition.parsedExamples);
  const examples = normalizeExamples(definition.examples);
  if (parsedExamples.length) normalized.parsedExamples = parsedExamples;
  if (examples.length) normalized.examples = examples;
  return normalized;
}

function normalizeParsedExamples(examples) {
  if (!Array.isArray(examples)) return [];
  return examples.map((example) => {
    if (typeof example === "string") return { example };
    if (!example || typeof example !== "object" || Array.isArray(example)) return null;
    const normalized = {};
    if (typeof example.example === "string") normalized.example = example.example;
    if (typeof example.translation === "string") normalized.translation = example.translation;
    return Object.keys(normalized).length ? normalized : null;
  }).filter(Boolean);
}

function normalizeExamples(examples) {
  if (!Array.isArray(examples)) return [];
  return examples.map((example) => {
    if (typeof example === "string") return example;
    if (!example || typeof example !== "object" || Array.isArray(example)
      || typeof example.example !== "string") return null;
    return example.example;
  }).filter((example) => example !== null);
}

async function fetchDefinitions(word) {
  return fetchCached(
    "definition:" + word,
    API + encodeURIComponent(word),
    { "Api-User-Agent": API_USER_AGENT }
  );
}

async function fetchGender(word, language) {
  const apy = isSupportedLanguage(language) ? WORD_LOOKUP_LANGUAGES[language].apy : null;
  if (!isLookupWord(word) || !apy) throw lookupError("invalid");
  const query = new URLSearchParams({ q: word, lang: apy });
  const data = await fetchCached(
    `gender:${language}:${word}`,
    `${APERTIUM_API}?${query}`
  );
  return parseApertiumGenders(data);
}

function parseApertiumGenders(data) {
  const labels = { m: "m", f: "f", nt: "n", ut: "c", mf: "m/f" };
  const genders = new Set();

  for (const token of Array.isArray(data) ? data : []) {
    if (typeof token?.[0] !== "string") continue;
    for (const analysis of token[0].split("/").slice(1)) {
      if (!analysis.includes("<n>")) continue;
      const tag = analysis.match(/<(m|f|nt|ut|mf)>/)?.[1];
      if (tag) genders.add(labels[tag]);
    }
  }
  return [...genders];
}

function fetchCached(key, url, extraHeaders = {}) {
  if (cache.has(key)) {
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const value = fetch(url, {
    signal: controller.signal,
    headers: { Accept: "application/json", ...extraHeaders }
  }).then((response) => {
    if (response.status === 404) return null;
    if (!response.ok) throw lookupError("unavailable");
    return response.json();
  }).catch((error) => {
    cache.delete(key);
    throw error;
  }).finally(() => clearTimeout(timeout));
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

function lookupError(code) {
  return Object.assign(new Error(code), { code });
}
