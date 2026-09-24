const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const sharedSource = readFileSync("shared.js", "utf8");
const backgroundSource = readFileSync("background.js", "utf8");
const historySource = readFileSync("history.js", "utf8");
const settingsHtml = readFileSync("settings.html", "utf8");
const settingsSource = readFileSync("settings.js", "utf8");
const languages = {
  en: { name: "English" },
  fr: { name: "French", apy: "fra" }
};

async function ticks() {
  await Promise.resolve();
  await Promise.resolve();
}

function backgroundHarness(initial = {}) {
  let messageListener;
  let values = {
    enabled: true,
    lookupHistory: [],
    ...initial
  };
  const context = vm.createContext({
    AbortController,
    TextEncoder,
    URL,
    URLSearchParams,
    WORD_LOOKUP_LANGUAGES: languages,
    fetch: async () => ({ ok: true, status: 200, json: async () => null }),
    clearTimeout,
    setTimeout,
    chrome: {
      runtime: {
        getManifest: () => ({ version: "0.0.0" }),
        onMessage: { addListener(listener) { messageListener = listener; } }
      },
      storage: {
        local: {
          get: async () => ({ ...values }),
          set: async (changes) => { values = { ...values, ...changes }; }
        }
      }
    }
  });
  vm.runInContext(sharedSource, context);
  vm.runInContext(historySource, context);
  vm.runInContext(backgroundSource, context);
  return {
    async send(message) {
      return new Promise((resolve) => {
        assert.equal(messageListener(message, {}, resolve), true);
      });
    },
    get values() { return values; },
    run(expression) { return vm.runInContext(expression, context); }
  };
}

test("successful history keeps only recent word/language pairs", async () => {
  const harness = backgroundHarness();
  await harness.send({
    type: "recordLookup", word: "chat", language: "fr", headword: "chat", timestamp: 1
  });
  await harness.send({
    type: "recordLookup", word: "dog", language: "en", headword: "dog", timestamp: 2
  });
  await harness.send({
    type: "recordLookup", word: "chat", language: "fr", headword: "chats", timestamp: 3
  });

  assert.equal(JSON.stringify(harness.values.lookupHistory), JSON.stringify([
    { word: "chat", language: "fr" },
    { word: "dog", language: "en" }
  ]));

  for (let index = 0; index < 101; index += 1) {
    await harness.send({
      type: "recordLookup",
      word: `word${String.fromCodePoint(0x4e00 + index)}`,
      language: "en",
      timestamp: index + 10
    });
  }
  assert.equal(harness.values.lookupHistory.length, 100);
  assert.equal(harness.values.lookupHistory[0].word, `word${String.fromCodePoint(0x4e00 + 100)}`);
  assert.equal(harness.values.lookupHistory.some((entry) => entry.word === "word一"), false);
});

test("history records keep only the compact storage schema", async () => {
  const harness = backgroundHarness();
  const response = await harness.send({
    type: "recordLookup",
    word: "house",
    language: "en",
    headword: "ignored",
    url: "javascript:alert(1)",
    timestamp: Number.NaN,
    snapshot: { entries: [{ partOfSpeech: "Noun" }], genders: ["f"] },
    entries: [{ partOfSpeech: "Noun", senses: [{ gloss: "ignored" }] }],
    genders: ["m"]
  });

  assert.equal(response.ok, true);
  const [entry] = harness.values.lookupHistory;
  assert.deepEqual(Object.keys(entry).sort(), ["language", "word"]);
});

test("old history is reduced to valid words and languages", async () => {
  const harness = backgroundHarness({ lookupHistory: [
    {
      word: "keep",
      language: "en",
      headword: "keep",
      url: "javascript:alert(1)",
      timestamp: 0
    },
    { word: "bad language", language: "en", timestamp: 0 },
    { word: "bad-language", language: "__proto__", timestamp: 0 },
    { word: "valid", language: "en", timestamp: "old" }
  ] });
  await harness.send({ type: "recordLookup", word: "new", language: "fr" });
  assert.equal(JSON.stringify(harness.values.lookupHistory), JSON.stringify([
    { word: "new", language: "fr" },
    { word: "keep", language: "en" },
    { word: "valid", language: "en" }
  ]));
});

test("record and clear history mutations are serialized", async () => {
  const harness = backgroundHarness();
  const record = harness.send({
    type: "recordLookup", word: "cat", language: "en", timestamp: 1
  });
  const clear = harness.send({ type: "clearHistory" });
  await Promise.all([record, clear]);
  assert.equal(JSON.stringify(harness.values.lookupHistory), "[]");

  await harness.send({ type: "recordLookup", word: "cat", language: "en", timestamp: 2 });
  const nextRecord = harness.send({ type: "recordLookup", word: "dog", language: "en", timestamp: 3 });
  await nextRecord;
  assert.equal(JSON.stringify(harness.values.lookupHistory.map((entry) => entry.word)), JSON.stringify(["dog", "cat"]));
});

function settingsHarness(initialHistory = []) {
  const { document, window } = parseHTML(settingsHtml);
  let values = {
    enabled: true,
    sourceLanguage: "en",
    showExamples: true,
    showGender: true,
    showNotFound: false,
    showLoading: false,
    lookupHistory: initialHistory
  };
  let storageChanged;
  const writes = [];
  const historyMessages = [];
  const context = vm.createContext({
    document,
    URL,
    TextEncoder,
    WORD_LOOKUP_LANGUAGES: languages,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          historyMessages.push(message);
          if (message.type === "clearHistory") values = { ...values, lookupHistory: [] };
          return { ok: true, data: values.lookupHistory };
        }
      },
      storage: {
        local: {
          get: async () => ({ ...values }),
          set: async (changes) => {
            writes.push(changes);
            const oldValues = values;
            values = { ...values, ...changes };
            if (storageChanged) {
              const changesForEvent = Object.fromEntries(Object.keys(changes).map((key) => [key, {
                oldValue: oldValues[key],
                newValue: values[key]
              }]));
              storageChanged(changesForEvent, "local");
            }
          }
        },
        onChanged: { addListener(listener) { storageChanged = listener; } }
      }
    }
  });
  vm.runInContext(sharedSource, context);
  vm.runInContext(historySource, context);
  vm.runInContext(settingsSource, context);
  return {
    document,
    window,
    writes,
    historyMessages,
    get values() { return values; },
    async ready() { await ticks(); },
    external(changes) { storageChanged(changes, "local"); },
    run(expression) { return vm.runInContext(expression, context); }
  };
}

test("history tab lists old and new words, derives safe links, and clears all", async () => {
  const harness = settingsHarness([
    { word: "chat", language: "fr", url: "javascript:alert(1)", timestamp: 1 },
    { word: "dog", language: "en" }
  ]);
  await harness.ready();

  assert.match(harness.document.querySelector("label[for=language]").textContent, /Word language/);
  harness.document.querySelector("#history-tab").click();
  assert.equal(harness.document.querySelector("#history-panel").hidden, false);
  assert.equal(harness.document.querySelectorAll(".history-entry").length, 2);
  assert.equal(harness.document.querySelector(".history-word").textContent, "chat");
  assert.equal(harness.document.querySelector(".history-link").href,
    "https://en.wiktionary.org/wiki/chat");
  assert.equal(harness.document.querySelector(".history-delete"), null);
  assert.equal(harness.document.querySelector("#export-history"), null);
  harness.document.querySelector("#clear-history").click();
  await harness.ready();
  assert.equal(JSON.stringify(harness.values.lookupHistory), "[]");
  assert.equal(harness.historyMessages.at(-1).type, "clearHistory");
});

test("popup tabs support arrow-key navigation", async () => {
  const harness = settingsHarness();
  await harness.ready();
  const settingsTab = harness.document.querySelector("#settings-tab");
  const historyTab = harness.document.querySelector("#history-tab");
  const right = new harness.window.Event("keydown", { cancelable: true });
  Object.defineProperty(right, "key", { value: "ArrowRight" });
  settingsTab.dispatchEvent(right);
  assert.equal(historyTab.getAttribute("aria-selected"), "true");
  assert.equal(historyTab.getAttribute("tabindex"), "0");
  assert.equal(settingsTab.getAttribute("tabindex"), "-1");

  const home = new harness.window.Event("keydown", { cancelable: true });
  Object.defineProperty(home, "key", { value: "Home" });
  historyTab.dispatchEvent(home);
  assert.equal(settingsTab.getAttribute("aria-selected"), "true");
});

test("loading preference persists and external enabled changes update the popup", async () => {
  const harness = settingsHarness();
  await harness.ready();
  const loading = harness.document.querySelector("#show-loading");
  loading.checked = true;
  loading.dispatchEvent(new harness.window.Event("change"));
  assert.equal(JSON.stringify(harness.writes.at(-1)), JSON.stringify({ showLoading: true }));

  harness.external({ enabled: { oldValue: true, newValue: false } });
  assert.equal(harness.document.querySelector("#enabled").checked, false);
});
