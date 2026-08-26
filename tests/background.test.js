const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync("background.js", "utf8");
const languages = {
  en: { name: "English" },
  fr: { name: "French", apy: "fra" },
  es: { name: "Spanish", apy: "spa" },
  de: { name: "German", apy: "deu", preserveCase: true },
  it: { name: "Italian", apy: "ita" },
  nl: { name: "Dutch", apy: "nld" },
  sv: { name: "Swedish", apy: "swe" },
  ro: { name: "Romanian", apy: "ron" }
};

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => String(data)
  };
}

function harness(fetch, timers = {}) {
  let listener;
  const context = vm.createContext({
    AbortController,
    URL,
    URLSearchParams,
    WORD_LOOKUP_LANGUAGES: languages,
    clearTimeout: timers.clearTimeout || clearTimeout,
    fetch,
    setTimeout: timers.setTimeout || setTimeout,
    chrome: {
      runtime: {
        onMessage: { addListener(value) { listener = value; } }
      }
    }
  });
  vm.runInContext(source, context);
  return (message) => new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
  });
}

function definitionUrlWord(url) {
  return decodeURIComponent(url.split("/").at(-1));
}

test("prefers a lowercase common entry over an exact proper noun", async () => {
  const requested = [];
  const send = harness(async (url) => {
    const word = definitionUrlWord(url);
    requested.push(word);
    if (word === "House") return response({ en: [{ partOfSpeech: "Proper noun" }] });
    if (word === "house") return response({ en: [{ partOfSpeech: "Noun" }] });
    throw new Error(`unexpected ${word}`);
  });

  const result = await send({ type: "fetchEntry", word: "House", language: "en" });
  assert.equal(result.ok, true);
  assert.equal(result.data.word, "house");
  assert.deepEqual(requested, ["House", "house"]);
});

test("returns both German capitalization variants when both have entries", async () => {
  const data = {
    Machen: { de: [{ partOfSpeech: "Noun" }] },
    machen: { de: [{ partOfSpeech: "Verb" }] },
    Haus: { de: [{ partOfSpeech: "Noun" }] },
    haus: null
  };
  const send = harness(async (url) => response(data[definitionUrlWord(url)]));

  const variants = await send({ type: "fetchEntry", word: "Machen", language: "de" });
  assert.equal(variants.data.word, "Machen");
  assert.equal(JSON.stringify(variants.data.variants), JSON.stringify(["Machen", "machen"]));
  assert.equal(
    JSON.stringify(variants.data.entries.map((entry) => entry.lookupVariant)),
    JSON.stringify(["Machen", "machen"])
  );

  const noun = await send({ type: "fetchEntry", word: "Haus", language: "de" });
  assert.equal(noun.data.word, "Haus");
  assert.equal(noun.data.variants, undefined);
});

test("keeps an exact German result when the lowercase probe fails", async () => {
  const send = harness(async (url) => {
    const word = definitionUrlWord(url);
    if (word === "Garten") return response({ de: [{ partOfSpeech: "Noun" }] });
    throw new Error("lowercase probe failed");
  });

  const result = await send({ type: "fetchEntry", word: "Garten", language: "de" });
  assert.equal(result.ok, true);
  assert.equal(result.data.word, "Garten");
  assert.equal(result.data.variants, undefined);
});

test("falls back from a lowercase German spelling to title case", async () => {
  const send = harness(async (url) => {
    const word = definitionUrlWord(url);
    return response(word === "Kind" ? { de: [{ partOfSpeech: "Noun" }] } : null);
  });

  const result = await send({ type: "fetchEntry", word: "kind", language: "de" });
  assert.equal(result.ok, true);
  assert.equal(result.data.word, "Kind");
});

test("maps supported languages to Apertium and extracts noun genders only", async () => {
  const requested = [];
  const send = harness(async (url) => {
    const parsed = new URL(url);
    requested.push([parsed.searchParams.get("lang"), parsed.searchParams.get("q")]);
    return response([[
      "word/one<n><m><sg>/two<n><f><sg>/three<n><nt><sg>/four<n><ut><sg>/five<n><mf><sg>/six<adj><m><sg>",
      "word"
    ]]);
  });

  const mappings = { fr: "fra", es: "spa", de: "deu", it: "ita", nl: "nld", sv: "swe", ro: "ron" };
  for (const [language, apy] of Object.entries(mappings)) {
    const result = await send({ type: "fetchGender", word: "word", language });
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result.data), JSON.stringify(["m", "f", "n", "c", "m/f"]));
    assert.equal(requested.at(-1)[0], apy);
  }
  assert.equal(requested.every(([, word]) => word === "word"), true);

  const unsupported = await send({ type: "fetchGender", word: "house", language: "en" });
  assert.deepEqual([unsupported.ok, unsupported.error], [false, "invalid"]);
  assert.equal(requested.length, Object.keys(mappings).length);
});

test("ignores malformed and unknown Apertium analyses", async () => {
  const send = harness(async () => response([
    ["word/*word/word<adj><f><sg>/word<n><un><sg>", "word"],
    null,
    [42, "word"]
  ]));
  const result = await send({ type: "fetchGender", word: "word", language: "fr" });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.data), "[]");
});

test("times out a stalled fetch and evicts it from the cache", async () => {
  let calls = 0;
  const fetch = (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      else signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), {
        name: "AbortError"
      })), { once: true });
    });
  };
  const send = harness(fetch, {
    setTimeout(callback) { queueMicrotask(callback); return 1; },
    clearTimeout() {}
  });

  const first = await send({ type: "fetchEntry", word: "stall", language: "en" });
  const second = await send({ type: "fetchEntry", word: "stall", language: "en" });
  assert.deepEqual([first.ok, first.error], [false, "unavailable"]);
  assert.deepEqual([second.ok, second.error], [false, "unavailable"]);
  assert.equal(calls, 2);
});
