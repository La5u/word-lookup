const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const sharedSource = readFileSync("shared.js", "utf8");
const source = readFileSync("background.js", "utf8");
const historySource = readFileSync("history.js", "utf8");
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
    TextEncoder,
    URL,
    URLSearchParams,
    WORD_LOOKUP_LANGUAGES: languages,
    clearTimeout: timers.clearTimeout || clearTimeout,
    fetch,
    setTimeout: timers.setTimeout || setTimeout,
    chrome: {
      runtime: {
        getManifest: () => ({ version: "0.0.0" }),
        onMessage: { addListener(value) { listener = value; } }
      }
    }
  });
  vm.runInContext(sharedSource, context);
  vm.runInContext(historySource, context);
  vm.runInContext(source, context);
  return (message) => new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
  });
}

function definitionUrlWord(url) {
  return decodeURIComponent(url.split("/").at(-1));
}

function apiEntry(partOfSpeech, definition) {
  return { partOfSpeech, definitions: [{ definition }] };
}

test("prefers a lowercase common entry over an exact proper noun", async () => {
  const requested = [];
  const send = harness(async (url) => {
    const word = definitionUrlWord(url);
    requested.push(word);
    if (word === "House") {
      return response({ en: [apiEntry("Proper noun", "A family or dynastic name.")] });
    }
    if (word === "house") {
      return response({ en: [apiEntry("Noun", "A building in which people live.")] });
    }
    throw new Error(`unexpected ${word}`);
  });

  const result = await send({ type: "fetchEntry", word: "House", language: "en" });
  assert.equal(result.ok, true);
  assert.equal(result.data.word, "house");
  assert.deepEqual(requested, ["House", "house"]);
});

test("returns both German capitalization variants when both have entries", async () => {
  const data = {
    Machen: { de: [apiEntry("Noun", "The act of making.")] },
    machen: { de: [apiEntry("Verb", "To make or do.")] },
    Haus: { de: [apiEntry("Noun", "A building in which people live.")] },
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
    if (word === "Garten") {
      return response({ de: [apiEntry("Noun", "A cultivated outdoor area.")] });
    }
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
    return response(word === "Kind"
      ? { de: [apiEntry("Noun", "A child.")] }
      : null);
  });

  const result = await send({ type: "fetchEntry", word: "kind", language: "de" });
  assert.equal(result.ok, true);
  assert.equal(result.data.word, "Kind");
});

test("normalizes malformed definition entries and examples at the API boundary", async () => {
  const send = harness(async (url) => {
    if (definitionUrlWord(url) === "malformed") {
      return response({ en: [null, { partOfSpeech: "Verb" }, { definitions: [] }] });
    }
    return response({
      en: [
        null,
        {
          partOfSpeech: { value: "not text" },
          definitions: [
            null,
            {
              definition: "A valid definition.",
              parsedExamples: [
                { example: "Use it.", translation: "Utilisez-le." },
                { example: { malformed: true } },
                "A string example."
              ],
              examples: [{ example: "Fallback example." }, null, 42]
            }
          ]
        },
        { partOfSpeech: "Verb", definitions: { malformed: true } },
        { partOfSpeech: "Noun", definitions: [] },
        { partOfSpeech: "Adjective" }
      ]
    });
  });

  const result = await send({ type: "fetchEntry", word: "word", language: "en" });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.data.entries), JSON.stringify([{
    partOfSpeech: "Entry",
    definitions: [{
      definition: "A valid definition.",
      parsedExamples: [
        { example: "Use it.", translation: "Utilisez-le." },
        { example: "A string example." }
      ],
      examples: ["Fallback example."]
    }]
  }]));

  const malformed = await send({ type: "fetchEntry", word: "malformed", language: "en" });
  assert.deepEqual([malformed.ok, malformed.error], [false, "not_found"]);
});

test("rejects non-string and overlong lookup words consistently", async () => {
  let calls = 0;
  const send = harness(async () => {
    calls += 1;
    return response({ en: [] });
  });

  const longWord = "a".repeat(201);
  const invalidEntry = await send({ type: "fetchEntry", word: longWord, language: "en" });
  const invalidGender = await send({ type: "fetchGender", word: 42, language: "fr" });
  assert.deepEqual([invalidEntry.ok, invalidEntry.error], [false, "invalid"]);
  assert.deepEqual([invalidGender.ok, invalidGender.error], [false, "invalid"]);
  assert.equal(calls, 0);
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

test("case-preserving languages request both spellings in parallel", async () => {
  const requested = [];
  let releaseExact;
  const send = harness(async (url) => {
    requested.push(decodeURIComponent(url.split("/").pop()));
    if (url.endsWith("/Haus")) await new Promise((resolve) => { releaseExact = resolve; });
    return response({ de: [{ partOfSpeech: "Noun", definitions: [{ definition: "house" }] }] });
  });

  const pending = send({ type: "fetchEntry", word: "Haus", language: "de" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requested.sort(), ["Haus", "haus"]);
  releaseExact();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(requested.length, 2);
});
