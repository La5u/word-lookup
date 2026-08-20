const API = "https://en.wiktionary.org/api/rest_v1/page/definition/";
const PAGE_API = "https://en.wiktionary.org/api/rest_v1/page/html/";
const API_USER_AGENT = "WordLookup/0.1 (https://github.com/La5u/wiktionary-lookup)";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["fetchEntry", "fetchPage"].includes(message.type)) return;

  const request = message.type === "fetchEntry"
    ? fetchEntry(message.word, message.language)
    : fetchPage(message.word);
  request
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function fetchEntry(word, language) {
  if (!/^\p{L}[\p{L}\p{M}'’\-]*$/u.test(word) || !/^[a-z]{2,3}$/.test(language)) {
    throw new Error("Invalid lookup");
  }
  const response = await fetch(API + encodeURIComponent(word), {
    headers: {
      Accept: "application/json",
      "Api-User-Agent": API_USER_AGENT
    }
  });
  if (response.status === 404) throw new Error("No Wiktionary entry found");
  if (!response.ok) throw new Error("Wiktionary is unavailable");

  const data = await response.json();
  const entries = Array.isArray(data[language]) ? data[language] : [];
  if (!entries.length) throw new Error("No entry in the selected language");
  return entries;
}

async function fetchPage(word) {
  if (!/^\p{L}[\p{L}\p{M}'’\-]*$/u.test(word)) throw new Error("Invalid lookup");
  const response = await fetch(PAGE_API + encodeURIComponent(word), {
    headers: { "Api-User-Agent": API_USER_AGENT }
  });
  if (!response.ok) throw new Error("Wiktionary page is unavailable");
  return response.text();
}
