const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const sharedSource = readFileSync("shared.js", "utf8");
const source = readFileSync("content.js", "utf8");

function harness(settings = {
  enabled: true,
  sourceLanguage: "en",
  showExamples: true,
  showGender: true,
  showNotFound: false,
  showLoading: false
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
    }),
    setTimeout,
    clearTimeout
  });
  vm.runInContext(sharedSource, context);
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

test("ignores synthetic mouse events", async () => {
  const { context, run } = harness();
  context.window.getSelection = () => {
    throw new Error("synthetic event reached selection handling");
  };
  await run("handleMouseUp({ isTrusted: false })");
});

test("uses defaults when the initial storage read fails", async () => {
  const { run } = harness(Promise.reject(new Error("storage unavailable")));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run("settingsReady"), true);
  assert.equal(run("settings.enabled"), true);
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

test("ignores a structured red-link typo when other forms agree on the lemma", async () => {
  const { context, run } = harness();
  context.lookupResponses = {
    transmis: {
      word: "transmis",
      entries: [
        { partOfSpeech: "Participle", definitions: [form("past participle of", "transmettre", "fr")] },
        {
          partOfSpeech: "Participle",
          definitions: [{
            definition: '<span class="form-of-definition">masculine plural of <span class="form-of-definition-link"><i lang="fr"><span class="new">transmi</span></i></span></span>'
          }]
        },
        { partOfSpeech: "Verb", definitions: [form("first/second-person singular past historic of", "transmettre", "fr")] }
      ]
    },
    transmettre: {
      word: "transmettre",
      entries: [{ partOfSpeech: "Verb", definitions: [{ definition: "To transmit or pass on." }] }]
    }
  };
  run("fetchEntry = async (word) => lookupResponses[word]");

  const result = await run("lookup('transmis', 'transmis', 'fr')");
  assert.equal(result.lemma, "transmettre");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].senses[0].gloss, "To transmit or pass on.");
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

test("keeps adjective senses visible while adding a participle's verb meaning", async () => {
  const { context, document, run } = harness();
  context.lookupResponses = {
    "déplacé": { word: "déplacé", entries: [
      { partOfSpeech: "Participle", definitions: [form("past participle of", "déplacer", "fr")] },
      { partOfSpeech: "Adjective", definitions: [
        { definition: "Inappropriate, uncalled-for." },
        { definition: "Rude, offensive." }
      ] }
    ] },
    "déplacer": { word: "déplacer", entries: [
      { partOfSpeech: "Verb", definitions: [{ definition: "To move or shift." }] },
      { partOfSpeech: "Noun", definitions: [{ definition: "Unrelated sense." }] }
    ] }
  };
  context.requests = [];
  context.releaseLemma = null;
  run("fetchEntry = async (word) => { requests.push(word); if (word === 'déplacer') await new Promise((resolve) => { releaseLemma = resolve; }); return lookupResponses[word]; }");
  const result = await run("lookup('déplacé', 'déplacé', 'fr')");
  assert.equal(JSON.stringify(context.requests), JSON.stringify(["déplacé"]));
  assert.equal(result.page, "déplacé");
  context.initialResult = result;
  run("renderResult(initialResult, { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.equal(document.querySelectorAll(".wl-entry").length, 2);
  assert.match(document.querySelector("#word-lookup-popup").textContent, /Inappropriate, uncalled-for/);

  const pending = run("enrichMixedForms(initialResult, { left: 10, top: 10, right: 20, bottom: 20 }, requestId)");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(context.requests), JSON.stringify(["déplacé", "déplacer"]));
  assert.match(document.querySelector("#word-lookup-popup").textContent, /Rude, offensive/);
  context.releaseLemma();
  await pending;
  assert.equal(JSON.stringify([...document.querySelectorAll(".wl-entry")].map((item) => item.textContent)),
    JSON.stringify(["participe", "verbe · déplacer", "adjectif"]));
  assert.match(document.querySelector("#word-lookup-popup").textContent, /To move or shift/);
  assert.doesNotMatch(document.querySelector("#word-lookup-popup").textContent, /Unrelated sense/);
  assert.match(document.querySelector("#word-lookup-popup").textContent, /Rude, offensive/);
  assert.equal(document.querySelector(".wl-link").href, "https://en.wiktionary.org/wiki/d%C3%A9plac%C3%A9");
});

test("mixed lexical entries defer other form lemmas until Show all forms", async () => {
  const { context, document, run } = harness();
  context.lookupResponses = {
    sample: { word: "sample", entries: [
      { partOfSpeech: "Verb", definitions: [form("inflection of", "first")] },
      { partOfSpeech: "Verb", definitions: [form("inflection of", "second")] },
      { partOfSpeech: "Adjective", definitions: [{ definition: "An independent meaning." }] }
    ] },
    first: { word: "first", entries: [{ partOfSpeech: "Verb", definitions: [{ definition: "One meaning." }] }] },
    second: { word: "second", entries: [{ partOfSpeech: "Verb", definitions: [{ definition: "Another meaning." }] }] }
  };
  context.requests = [];
  run("fetchEntry = async (word) => { requests.push(word); return lookupResponses[word]; }");
  const result = await run("lookup('sample', 'sample', 'en')");
  assert.equal(JSON.stringify(context.requests), JSON.stringify(["sample"]));
  context.initialResult = result;
  run("renderResult(initialResult, { left: 10, top: 10, right: 20, bottom: 20 })");
  await run("enrichMixedForms(initialResult, { left: 10, top: 10, right: 20, bottom: 20 }, requestId)");
  assert.equal(JSON.stringify(context.requests), JSON.stringify(["sample", "first"]));
  assert.equal(document.querySelector(".wl-expand").textContent, "Show all forms");
  document.querySelector(".wl-expand").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(context.requests), JSON.stringify(["sample", "first", "second"]));
  assert.equal(document.querySelector(".wl-expand"), null);
  assert.match(document.querySelector("#word-lookup-popup").textContent, /An independent meaning/);
  assert.match(document.querySelector("#word-lookup-popup").textContent, /Another meaning/);
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
  assert.equal(run("collectForms([fixtureEntry], 'fr').formOnly"), true);

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

test("resolves French forms with different lemmas to their lexical definitions", async () => {
  const { context, run } = harness();
  context.lookupResponses = {
    gouges: {
      word: "gouges",
      entries: [
        { partOfSpeech: "Noun", definitions: [form("plural of", "gouge", "fr")] },
        { partOfSpeech: "Verb", definitions: [form("second-person singular present of", "gouger", "fr")] }
      ]
    },
    gouge: {
      word: "gouge",
      entries: [{ partOfSpeech: "Noun", definitions: [{ definition: "A chisel with a curved blade." }] }]
    },
    gouger: {
      word: "gouger",
      entries: [{ partOfSpeech: "Verb", definitions: [{ definition: "To cut or scoop with a gouge." }] }]
    }
  };
  run("fetchEntry = async (word) => lookupResponses[word]");

  const result = await run("lookup('gouges', 'gouges', 'fr')");
  assert.equal(result.lemma, "gouge");
  assert.equal(result.formCount, 2);
  const expanded = await result.expandForms();
  assert.equal(expanded.lemma, "gouge / gouger");
  assert.equal(JSON.stringify(expanded.entries.map((entry) => entry.senses[0].gloss)), JSON.stringify([
    "A chisel with a curved blade.",
    "To cut or scoop with a gouge."
  ]));
  assert.equal(expanded.entries.every((entry) => entry.senses.every((sense) => !sense.form)), true);
});

test("only fetches the first ambiguous lemma until Show all forms is clicked", async () => {
  const { context, document, run } = harness();
  context.lookupResponses = {
    axes: { word: "axes", entries: [
      { partOfSpeech: "Noun", definitions: [form("plural of", "axe")] },
      { partOfSpeech: "Noun", definitions: [form("plural of", "axis")] }
    ] },
    axe: { word: "axe", entries: [{ partOfSpeech: "Noun", definitions: [{ definition: "A chopping tool." }] }] },
    axis: { word: "axis", entries: [{ partOfSpeech: "Noun", definitions: [{ definition: "A line of rotation." }] }] }
  };
  context.requests = [];
  run("fetchEntry = async (word) => { requests.push(word); return lookupResponses[word]; }");
  const result = await run("lookup('axes', 'axes', 'en')");
  assert.equal(JSON.stringify(context.requests), JSON.stringify(["axes", "axe"]));
  assert.equal(result.lemma, "axe");

  context.firstResult = result;
  run("renderResult(firstResult, { left: 10, top: 10, right: 20, bottom: 20 })");
  const button = document.querySelector(".wl-expand");
  assert.equal(button.textContent, "Show all forms");
  context.finishGender = null;
  run("fetchNounGenders = () => new Promise((resolve) => { finishGender = resolve; })");
  const oldGender = run("enrichNounGender(firstResult, { left: 10, top: 10, right: 20, bottom: 20 }, requestId)");
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(context.requests), JSON.stringify(["axes", "axe", "axis"]));
  assert.equal(document.querySelector(".wl-title").textContent, "axe / axis");
  assert.equal(document.querySelector(".wl-expand"), null);
  context.finishGender(["f"]);
  await oldGender;
  assert.equal(document.querySelector(".wl-title").textContent, "axe / axis");
  assert.equal(JSON.stringify([...document.querySelectorAll("#word-lookup-popup li")]
    .map((item) => item.textContent)), JSON.stringify(["A chopping tool.", "A line of rotation."]));
});

test("shows the selected form before the first lemma request completes", async () => {
  const { context, run } = harness();
  context.lookupResponses = {
    axes: { word: "axes", entries: [
      { partOfSpeech: "Noun", definitions: [form("plural of", "axe")] },
      { partOfSpeech: "Noun", definitions: [form("plural of", "axis")] }
    ] },
    axe: { word: "axe", entries: [{ partOfSpeech: "Noun", definitions: [{ definition: "A chopping tool." }] }] }
  };
  context.releaseFirst = null;
  context.interim = null;
  run("fetchEntry = async (word) => { if (word === 'axe') await new Promise((resolve) => { releaseFirst = resolve; }); return lookupResponses[word]; }");
  const pending = run("lookup('axes', 'axes', 'en', (result) => { interim = result; })");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.interim.headword, "axes");
  assert.equal(context.interim.entries.length, 2);
  assert.equal(typeof context.releaseFirst, "function");
  context.releaseFirst();
  const result = await pending;
  assert.equal(result.lemma, "axe");
});

test("lookup follows an inflected word to its lemma's lexical definitions", async () => {
  const { context, run } = harness();
  context.lookupResponses = {
    went: {
      word: "went",
      entries: [{
        partOfSpeech: "Verb",
        definitions: [form("simple past of", "go")]
      }]
    },
    go: {
      word: "go",
      entries: [{
        partOfSpeech: "Verb",
        definitions: [{ definition: "To move from one place to another." }]
      }]
    }
  };
  run("fetchEntry = async (word) => lookupResponses[word]");

  const result = await run("lookup('went', 'went', 'en')");
  assert.equal(result.lemma, "go");
  assert.equal(result.entries[0].partOfSpeech, "Verb");
  assert.equal(result.entries[0].senses[0].gloss, "To move from one place to another.");
  assert.equal(result.entries[0].senses[0].form, false);
});

test("falls back to the selected entry when its lemma lookup fails", async () => {
  const { context, run } = harness();
  context.lookupResponses = {
    went: { word: "went", entries: [{ partOfSpeech: "Verb", definitions: [form("simple past of", "go")] }] }
  };
  run("fetchEntry = async (word) => { if (!lookupResponses[word]) throw Object.assign(new Error('missing'), { code: 'not_found' }); return lookupResponses[word]; }");

  const result = await run("lookup('went', 'went', 'en')");
  assert.equal(result.headword, "went");
  assert.equal(result.page, "went");
  assert.equal(result.entries[0].senses[0].gloss, "simple past of go");
});

test("keeps resolved lemmas and original forms when another lemma fails", async () => {
  const { context, run } = harness();
  context.lookupResponses = {
    forms: { word: "forms", entries: [
      { partOfSpeech: "Verb", definitions: [form("plural of", "missing")] },
      { partOfSpeech: "Noun", definitions: [form("plural of", "found")] }
    ] },
    found: { word: "found", entries: [
      { partOfSpeech: "Noun", definitions: [{ definition: "A real definition." }] }
    ] }
  };
  run("fetchEntry = async (word) => { if (!lookupResponses[word]) throw Object.assign(new Error('missing'), { code: 'not_found' }); return lookupResponses[word]; }");

  const result = await run("lookup('forms', 'forms', 'en')");
  assert.equal(result.headword, "forms");
  const expanded = await result.expandForms();
  assert.equal(expanded.page, "found");
  assert.equal(JSON.stringify(expanded.entries.map((entry) => entry.senses[0].gloss)),
    JSON.stringify(["plural of missing", "A real definition."]));

  run("fetchEntry = async (word) => { if (word !== 'forms') throw new Error('offline'); return lookupResponses.forms; }");
  const fallback = await run("lookup('forms', 'forms', 'en')");
  assert.equal(fallback.headword, "forms");
  assert.equal(fallback.entries.length, 2);
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
    page: "clôture",
    entries: run("summarize(fixtureEntries, 'fr')")
  };

  run("renderResult(fixtureResult, { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.equal(document.querySelectorAll("#word-lookup-popup ul > li").length, 2);
  assert.equal(document.querySelectorAll("#word-lookup-popup ol").length, 0);
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
    page: "Machen",
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
  run("settings.showNotFound = false; renderError('missing', 'not_found', 'en', { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.equal(document.querySelector("#word-lookup-popup"), null);

  run("settings.showNotFound = true; renderError('missing', 'not_found', 'en', { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.match(document.querySelector(".wl-error").textContent, /No English entry/);

  run("settings.showNotFound = false; renderError('word', 'unavailable', 'en', { left: 10, top: 10, right: 20, bottom: 20 })");
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

  run("settings.showGender = false");
  result = await run("fetchNounGenders('maison', 'fr', [{ partOfSpeech: 'Noun' }])");
  assert.equal(result.length, 0);
  result = await run("fetchNounGenders('house', 'en', [{ partOfSpeech: 'Noun' }])");
  assert.equal(result.length, 0);
  result = await run("fetchNounGenders('marcher', 'fr', [{ partOfSpeech: 'Verb' }])");
  assert.equal(result.length, 0);
  assert.equal(messages.length, 1);
});

test("history records only the displayed headword and language", () => {
  const { messages, run } = harness();
  run("recordLookup({ word: 'cats', language: 'en', headword: 'cat', page: 'cat', entries: [{ partOfSpeech: 'Noun', senses: [{ gloss: 'A small animal.' }] }], genders: ['m'] })");
  const message = messages.at(-1);
  assert.equal(JSON.stringify(message), JSON.stringify({
    type: "recordLookup", word: "cat", language: "en"
  }));
});

test("example sentences are shown by default and can be hidden", () => {
  const { context, document, run } = harness();
  context.fixtureResult = {
    word: "cat",
    headword: "cat",
    language: "en",
    genders: [],
    page: "cat",
    entries: [{
      partOfSpeech: "Noun",
      senses: [{ gloss: "A small animal.", example: "The cat slept.", translation: "Le chat dormait." }]
    }]
  };

  run("settings.showExamples = true; renderResult(fixtureResult, { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.equal(document.querySelector(".wl-example")?.textContent, "The cat slept.");
  run("settings.showExamples = false; renderResult(fixtureResult, { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.equal(document.querySelector(".wl-example"), null);
  assert.equal(document.querySelector(".wl-translation"), null);
});

test("loading indicator is delayed and cancelled when the lookup is dismissed", () => {
  const { context, document, run } = harness();
  const callbacks = [];
  const cleared = [];
  context.setTimeout = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  context.clearTimeout = (id) => cleared.push(id);

  run("settings.showLoading = true; requestId = 4; scheduleLoading('word', { left: 10, top: 10, right: 20, bottom: 20 }, 4)");
  assert.equal(document.querySelector(".wl-loading"), null);
  run("removePopup()");
  callbacks[0]();
  assert.equal(document.querySelector(".wl-loading"), null);
  assert.deepEqual(cleared, [1]);

  run("requestId = 6; scheduleLoading('word', { left: 10, top: 10, right: 20, bottom: 20 }, 6)");
  callbacks[1]();
  assert.equal(document.querySelector(".wl-loading").textContent, "Looking up…");
});

test("dismissal and setting changes invalidate pending lookups", () => {
  const { run, storageChanged } = harness();
  const initial = run("requestId");
  run("removePopup()");
  assert.equal(run("requestId"), initial + 1);
  storageChanged({ showExamples: { newValue: false } }, "local");
  assert.equal(run("requestId"), initial + 2);
  assert.equal(run("settings.showExamples"), false);
  storageChanged({ showGender: { newValue: false } }, "local");
  assert.equal(run("requestId"), initial + 3);
  assert.equal(run("settings.showGender"), false);
  storageChanged({ showNotFound: { newValue: true } }, "local");
  assert.equal(run("requestId"), initial + 4);
  assert.equal(run("settings.showNotFound"), true);
});

test("dismisses the old popup immediately when a new lookup starts", async () => {
  const { context, document, run } = harness();
  await new Promise((resolve) => setImmediate(resolve));
  const wordNode = document.createTextNode("new");
  document.body.appendChild(wordNode);
  context.fakeSelection = {
    rangeCount: 1,
    isCollapsed: false,
    toString: () => "new",
    getRangeAt: () => ({
      startContainer: wordNode, startOffset: 0,
      endContainer: wordNode, endOffset: 3,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 30, bottom: 20, width: 20, height: 10 })
    }),
    containsNode: () => true
  };
  context.window.getSelection = () => context.fakeSelection;
  run("renderLoading('old', { left: 10, top: 10, right: 20, bottom: 20 })");
  assert.equal(document.querySelector(".wl-title").textContent, "old");
  run("lookup = () => new Promise(() => {})");
  run("handleMouseUp({ isTrusted: true, target: fakeSelection.getRangeAt().startContainer })");
  assert.equal(document.querySelector("#word-lookup-popup"), null);
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
