const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const source = readFileSync("content.js", "utf8");

function harness(settings = {
  enabled: true,
  sourceLanguage: "en",
  showExamples: true,
  showGender: true,
  showNotFound: false
}) {
  const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: 800 },
    innerHeight: { configurable: true, value: 600 }
  });
  let storageChanged;
  const messages = [];
  const context = vm.createContext({
    console,
    document,
    window,
    Node: window.Node,
    DOMParser: class {
      parseFromString(value) {
        return parseHTML(`<!doctype html><html><body>${value}</body></html>`).document;
      }
    },
    WORD_LOOKUP_LANGUAGES: {
      en: { name: "English" },
      de: { name: "German", apy: "deu", preserveCase: true },
      fr: { name: "French", apy: "fra" }
    },
    chrome: {
      storage: {
        local: { get: async () => settings },
        onChanged: { addListener(listener) { storageChanged = listener; } }
      },
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          return { ok: false, error: "not_found" };
        }
      }
    },
    getComputedStyle: (node) => ({
      display: node?.tagName === "SPAN" ? "inline" : "block"
    })
  });
  vm.runInContext(source, context);
  return {
    context,
    document,
    messages,
    storageChanged,
    run(expression) { return vm.runInContext(expression, context); }
  };
}

const form = (relationship, lemma, language = "en") => ({
  definition: `<span class="form-of-definition">${relationship} <span class="form-of-definition-link"><span lang="${language}"><a title="${lemma}">${lemma}</a></span></span></span>`
});

test("recognizes French and Italian elisions when only the word is selected", () => {
  const { context, document, run } = harness();
  const cases = [
    ["fr", "l’", "article"],
    ["fr", "qu’", "il"],
    ["fr", "d’", "accord"],
    ["it", "l’", "amico"],
    ["it", "dell’", "acqua"]
  ];

  for (const [language, prefix, selected] of cases) {
    for (const split of [false, true]) {
      const paragraph = document.createElement("p");
      if (split) {
        const prefixNode = document.createElement("span");
        prefixNode.textContent = prefix;
        const selectedNode = document.createElement("span");
        selectedNode.textContent = selected;
        paragraph.append(prefixNode, selectedNode);
      } else {
        paragraph.textContent = prefix + selected;
      }
      document.body.replaceChildren(paragraph);
      const text = split ? paragraph.lastChild.firstChild : paragraph.firstChild;
      const start = split ? 0 : prefix.length;
      const end = start + selected.length;
      context.fixtureRange = {
        startContainer: text,
        startOffset: start,
        endContainer: text,
        endOffset: end,
        cloneRange() {
          let endOffset = end;
          return {
            setStart() {},
            setEnd(_container, offset) { endOffset = offset; },
            toString() {
              return prefix + selected.slice(0, split ? endOffset : endOffset - prefix.length);
            }
          };
        }
      };
      const result = run(`normalizeSelectedWord(${JSON.stringify(selected)}, fixtureRange, ${JSON.stringify(language)})`);
      assert.equal(JSON.stringify(result), JSON.stringify({
        word: prefix + selected,
        lookupWord: selected
      }));
    }
  }
});

test("keeps lexical homographs alongside form relationships", () => {
  const { context, run } = harness();
  context.fixtureEntries = [
    { partOfSpeech: "Verb", definitions: [form("simple past of", "go"), form("past participle of", "go")] },
    { partOfSpeech: "Noun", definitions: [{ definition: "A course or way." }] }
  ];

  assert.equal(run("findForm(fixtureEntries, 'en')"), null);
  const entries = run("summarize(fixtureEntries, 'en')");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].senses[0].form, true);
  assert.equal(entries[1].senses[0].form, false);
});

test("resolves unambiguous form-only entries but not multiple lemmas", () => {
  const { context, run } = harness();
  context.fixtureEntries = [
    { partOfSpeech: "Verb", definitions: [form("simple past of", "walk"), form("past participle of", "walk")] }
  ];
  let result = run("findForm(fixtureEntries, 'en')");
  assert.equal(result.lemma, "walk");

  context.fixtureEntries.push({
    partOfSpeech: "Verb",
    definitions: [form("first-person singular present of", "wander")]
  });
  result = run("findForm(fixtureEntries, 'en')");
  assert.equal(result, null);
});

test("keeps multiple form lemmas visible for ambiguous words", () => {
  const { context, run } = harness();
  for (const entries of [
    [
      { partOfSpeech: "Noun", definitions: [form("plural of", "allée", "fr")] },
      { partOfSpeech: "Participle", definitions: [form("feminine plural of", "allé", "fr")] }
    ],
    [
      { partOfSpeech: "Verb", definitions: [form("first-person singular present indicative of", "être", "fr")] },
      { partOfSpeech: "Verb", definitions: [form("first-person singular present indicative of", "suivre", "fr")] }
    ]
  ]) {
    context.fixtureEntries = entries;
    assert.equal(run("findForm(fixtureEntries, 'fr')"), null);
    assert.equal(run("summarize(fixtureEntries, 'fr').flatMap(entry => entry.senses).every(sense => sense.form)"), true);
  }
});

test("keeps multiple inflections around a lexical homograph", () => {
  const { context, run } = harness();
  context.fixtureEntries = [
    { partOfSpeech: "Noun", definitions: [form("plural of", "fly")] },
    { partOfSpeech: "Noun", definitions: [{ definition: "The open area above a stage." }] },
    { partOfSpeech: "Verb", definitions: [form("third-person singular present of", "fly")] }
  ];
  assert.equal(run("findForm(fixtureEntries, 'en')"), null);
  const entries = run("summarize(fixtureEntries, 'en')");
  assert.equal(entries.flatMap((entry) => entry.senses).filter((sense) => sense.form).length, 2);
  assert.equal(entries.flatMap((entry) => entry.senses).filter((sense) => !sense.form).length, 1);
});

test("does not redirect contractions with multiple components", () => {
  const { context, run } = harness();
  context.fixtureEntries = [{
    partOfSpeech: "Contraction",
    definitions: [{
      definition: '<span class="form-of-definition">contraction of <span class="form-of-definition-link"><i lang="fr"><a title="à">à</a></i></span> + <span class="form-of-definition-link"><i lang="fr"><a title="le">le</a></i></span></span>'
    }]
  }];
  assert.equal(run("findForm(fixtureEntries, 'fr')"), null);
  assert.equal(run("summarize(fixtureEntries, 'fr')[0].senses[0].form"), true);

  context.fixtureEntries = [{
    partOfSpeech: "Contraction",
    definitions: [{ definition: 'Contraction of <b><span lang="fr"><a title="à">à</a></span></b> + <b><span lang="fr"><a title="les">les</a></span></b> (to the)' }]
  }];
  assert.equal(run("findForm(fixtureEntries, 'fr')"), null);
  assert.equal(run("summarize(fixtureEntries, 'fr')[0].senses[0].form"), true);
});

test("does not redirect an entry containing both lexical and form senses", () => {
  const { context, run } = harness();
  context.fixtureEntries = [{
    partOfSpeech: "Adjective",
    definitions: [form("comparative of", "good"), { definition: "More desirable." }]
  }];
  assert.equal(run("findForm(fixtureEntries, 'en')"), null);
});

test("recognizes compound form entries, gerunds, and conservative classless text", () => {
  const { context, run } = harness();
  context.fixture = form("gerund of", "gehen", "de").definition;
  let result = run("parseFormDefinition(fixture, 'de')");
  assert.equal(result.lemma, "gehen");

  context.fixtureEntry = {
    definitions: [
      form("inflection of", "clôturer", "fr"),
      { definition: '<span class="form-of-definition">first-person singular present indicative</span>' }
    ]
  };
  assert.equal(run("isFormOnly(fixtureEntry, 'fr')"), true);

  context.fixture = "simple past of walk";
  result = run("parseFormDefinition(fixture, 'en')");
  assert.equal(result.lemma, "walk");
  context.fixture = "A past version of John";
  assert.equal(run("parseFormDefinition(fixture, 'en')"), null);
});

test("stops a form chain when the lemma has lexical senses for the target POS", async () => {
  const { context, run } = harness();
  context.lookupResponses = {
    ouverte: {
      word: "ouverte",
      entries: [{ partOfSpeech: "Adjective", definitions: [form("feminine singular of", "ouvert", "fr")] }]
    },
    ouvert: {
      word: "ouvert",
      entries: [
        { partOfSpeech: "Adjective", definitions: [{ definition: "Not closed." }] },
        { partOfSpeech: "Participle", definitions: [form("past participle of", "ouvrir", "fr")] }
      ]
    }
  };
  run("fetchEntry = async (word) => lookupResponses[word]");

  const result = await run("lookup('ouverte', 'ouverte', 'fr')");
  assert.equal(result.lemma, "ouvert");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].partOfSpeech, "Adjective");
  assert.equal(result.entries[0].senses[0].gloss, "Not closed.");
});

test("renders inflection summaries once as small secondary text", () => {
  const { context, document, run } = harness();
  context.fixtureEntries = [
    { partOfSpeech: "Noun", definitions: [{ definition: "A fence or wall." }] },
    {
      partOfSpeech: "Verb",
      definitions: [
        { definition: '<span class="form-of-definition">inflection of <span class="form-of-definition-link"><span lang="fr"><a title="clôturer">clôturer</a></span></span>:</span><ol><li><span class="form-of-definition">first/third-person singular present indicative/subjunctive</span></li><li><span class="form-of-definition">second-person singular present imperative</span></li></ol>' },
        { definition: '<span class="form-of-definition">first/third-person singular present indicative/subjunctive</span>' },
        { definition: '<span class="form-of-definition">second-person singular present imperative</span>' }
      ]
    }
  ];
  context.fixtureResult = {
    word: "clôture",
    headword: "clôture",
    language: "fr",
    genders: [],
    url: "https://en.wiktionary.org/wiki/clôture",
    entries: run("summarize(fixtureEntries, 'fr')")
  };

  run("renderResult(fixtureResult, { left: 10, top: 10, right: 20, bottom: 20 })");
  const forms = document.querySelectorAll("li.wl-form");
  assert.equal(forms.length, 1);
  assert.match(forms[0].textContent, /^inflection of clôturer/);
});

test("labels both German capitalization variants", () => {
  const { context, document, run } = harness();
  context.fixtureEntries = [
    { lookupVariant: "Machen", partOfSpeech: "Noun", definitions: [{ definition: "The act of making." }] },
    { lookupVariant: "machen", partOfSpeech: "Verb", definitions: [{ definition: "To make." }] }
  ];
  context.fixtureResult = {
    word: "Machen",
    headword: "Machen",
    variants: ["Machen", "machen"],
    language: "de",
    genders: [],
    url: "https://en.wiktionary.org/wiki/Machen",
    entries: run("summarize(fixtureEntries, 'de')")
  };

  run("renderResult(fixtureResult, { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.equal(document.querySelector(".wl-title").textContent, "Machen / machen");
  assert.deepEqual(
    [...document.querySelectorAll(".wl-entry")].map((entry) => entry.textContent),
    ["noun · Machen", "verb · machen"]
  );
});

test("not-found messages are opt-in while other errors remain visible", () => {
  const { document, run } = harness();
  run("showNotFound = false; renderError('missing', 'not_found', 'en', { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.equal(document.querySelector("#word-lookup-popup"), null);

  run("showNotFound = true; renderError('missing', 'not_found', 'en', { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.match(document.querySelector(".wl-error").textContent, /No English entry/);

  run("showNotFound = false; renderError('word', 'unavailable', 'en', { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.match(document.querySelector(".wl-error").textContent, /unavailable/);
});

test("requests noun gender only when enabled and supported", async () => {
  const { context, messages, run } = harness();
  context.chrome.runtime.sendMessage = async (message) => {
    messages.push(message);
    return { ok: true, data: ["f"] };
  };

  let result = await run("fetchNounGenders('maison', 'fr', [{ partOfSpeech: 'Noun' }])");
  assert.equal(JSON.stringify(result), JSON.stringify(["f"]));
  assert.equal(JSON.stringify(messages[0]), JSON.stringify({
    type: "fetchGender",
    word: "maison",
    language: "fr"
  }));

  run("showGender = false");
  result = await run("fetchNounGenders('maison', 'fr', [{ partOfSpeech: 'Noun' }])");
  assert.equal(result.length, 0);
  result = await run("fetchNounGenders('house', 'en', [{ partOfSpeech: 'Noun' }])");
  assert.equal(result.length, 0);
  result = await run("fetchNounGenders('marcher', 'fr', [{ partOfSpeech: 'Verb' }])");
  assert.equal(result.length, 0);
  assert.equal(messages.length, 1);
});

test("example sentences are shown by default and can be hidden", () => {
  const { context, document, run } = harness();
  context.fixtureResult = {
    word: "cat",
    headword: "cat",
    language: "en",
    genders: [],
    url: "https://en.wiktionary.org/wiki/cat",
    entries: [{
      partOfSpeech: "Noun",
      senses: [{ gloss: "A small animal.", example: "The cat slept.", translation: "Le chat dormait." }]
    }]
  };

  run("showExamples = true; renderResult(fixtureResult, { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.equal(document.querySelector(".wl-example")?.textContent, "The cat slept.");
  run("showExamples = false; renderResult(fixtureResult, { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.equal(document.querySelector(".wl-example"), null);
  assert.equal(document.querySelector(".wl-translation"), null);
});

test("dismissal and setting changes invalidate pending lookups", () => {
  const { run, storageChanged } = harness();
  const initial = run("requestId");
  run("removePopup()");
  assert.equal(run("requestId"), initial + 1);
  storageChanged({ showExamples: { newValue: false } }, "local");
  assert.equal(run("requestId"), initial + 2);
  assert.equal(run("showExamples"), false);
  storageChanged({ showGender: { newValue: false } }, "local");
  assert.equal(run("requestId"), initial + 3);
  assert.equal(run("showGender"), false);
  storageChanged({ showNotFound: { newValue: true } }, "local");
  assert.equal(run("requestId"), initial + 4);
  assert.equal(run("showNotFound"), true);
});

test("popup positioning keeps its final height within the chosen side", () => {
  const { context, run } = harness();
  const style = {};
  context.fakePopup = {
    get offsetHeight() { return Math.min(500, Number.parseInt(style.maxHeight, 10) || 500); },
    offsetWidth: 300,
    style
  };
  run("popup = fakePopup; positionPopup({ left: 760, top: 550, right: 780, bottom: 570 })");
  assert.equal(context.fakePopup.style.maxHeight, "360px");
  assert.equal(context.fakePopup.style.left, "492px");
  assert.equal(context.fakePopup.style.top, "182px");
});
