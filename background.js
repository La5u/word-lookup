if (typeof WORD_LOOKUP_LANGUAGES === "undefined") importScripts("languages.js");

const API = "https://en.wiktionary.org/api/rest_v1/page/definition/";
const APERTIUM_API = "https://www.apertium.org/apy/analyze";
const API_USER_AGENT = "WordLookup/0.2.0 (https://github.com/La5u/word-lookup)";
const CACHE_LIMIT = 100;
const FETCH_TIMEOUT_MS = 10000;
const cache = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["fetchEntry", "fetchGender"].includes(message.type)) return;

  const request = message.type === "fetchEntry"
    ? fetchEntry(message.word, message.language)
    : fetchGender(message.word, message.language);
  request
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({
      ok: false,
      error: error.code || "unavailable"
    }));
  return true;
});

async function fetchEntry(word, language) {
  if (!/^\p{L}[\p{L}\p{M}'’\-]*$/u.test(word) || !WORD_LOOKUP_LANGUAGES[language]) {
    throw lookupError("invalid");
  }

  const exactEntries = entriesFor(await fetchDefinitions(word), language);
  const lowercase = word.toLocaleLowerCase(language);
  const preserveCase = WORD_LOOKUP_LANGUAGES[language].preserveCase;
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

  if (WORD_LOOKUP_LANGUAGES[language].preserveCase) {
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
  return Array.isArray(data?.[language]) ? data[language] : [];
}

async function fetchDefinitions(word) {
  return fetchCached(
    "definition:" + word,
    API + encodeURIComponent(word),
    { "Api-User-Agent": API_USER_AGENT }
  );
}

async function fetchGender(word, language) {
  const apy = WORD_LOOKUP_LANGUAGES[language]?.apy;
  if (!/^\p{L}[\p{L}\p{M}'’\-]*$/u.test(word) || !apy) throw lookupError("invalid");
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
