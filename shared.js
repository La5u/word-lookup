const WORD = /^\p{L}[\p{L}\p{M}]*(?:['’\-]\p{L}[\p{L}\p{M}]*)*$/u;
const MAX_WORD_LENGTH = 200;
// sourceLanguage is the word's language; the key name is kept for existing installations.
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  sourceLanguage: "en",
  showExamples: true,
  showGender: true,
  showNotFound: false,
  showLoading: false
});

function isLookupWord(word) {
  return typeof word === "string" && word.length <= MAX_WORD_LENGTH && WORD.test(word);
}

function isSupportedLanguage(language) {
  return typeof language === "string" && Object.hasOwn(WORD_LOOKUP_LANGUAGES, language);
}

function normalizeSetting(key, value) {
  if (key === "sourceLanguage") {
    return isSupportedLanguage(value) ? value : DEFAULT_SETTINGS.sourceLanguage;
  }
  return typeof value === "boolean" ? value : DEFAULT_SETTINGS[key];
}

function pageUrl(word) {
  return `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`;
}
