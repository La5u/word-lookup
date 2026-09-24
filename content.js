const WORD_EDGE = /[\p{L}\p{M}'’\-]/u;
const FORM_WORDS = "contraction|plural|singular|inflection|form|simple past|past tense|past participle|present participle|gerund|infinitive|imperative|feminine|masculine|comparative|superlative|spelling|(?:first|second|third)(?:-person)?";
const FORM_HINT = new RegExp(`form-of-definition|(?:${FORM_WORDS})\\b.{0,120}\\bof\\b`, "iu");
const FORM_LABEL = new RegExp(`^(?:${FORM_WORDS})\\b.*\\bof\\b`, "iu");
// Conservative fallback for older responses without form-of CSS classes.
const FORM_FALLBACK = new RegExp(`^((?:${FORM_WORDS})\\b.*?\\bof)\\s+([\\p{L}\\p{M}'’\\-]+)$`, "iu");
const ELISIONS = {
  fr: {
    start: /^(?:[cdjlmnstç]|qu)['’](?=\p{L})/iu,
    end: /(?:[cdjlmnstç]|qu)['’]$/iu
  },
  it: {
    start: /^(?:l|un|d|all|dall|dell|nell|sull|coll|quest|quell|bell|senz)['’](?=\p{L})/iu,
    end: /(?:l|un|d|all|dall|dell|nell|sull|coll|quest|quell|bell|senz)['’]$/iu
  }
};
const POS_LABELS = {
  fr: {
    noun: "nom",
    verb: "verbe",
    adjective: "adjectif",
    adverb: "adverbe",
    "proper noun": "nom propre",
    participle: "participe",
    pronoun: "pronom",
    preposition: "préposition",
    conjunction: "conjonction",
    interjection: "interjection",
    article: "article",
    determiner: "déterminant",
    numeral: "numéral"
  }
};
const MAX_DEPTH = 3;
const MAX_GLOSSES = 3;
const LOADING_DELAY_MS = 180;
// Wiktionary can take seconds for a large lemma page; show the form description meanwhile.
const PARTIAL_DELAY_MS = 400;
let popup;
// The selected word; the popup follows it when the page scrolls or resizes.
let anchor = null;
let activeResult = null;
let loadingTimer = null;
let requestId = 0;
const settings = { ...DEFAULT_SETTINGS };
let settingsReady = false;
const changedSettings = new Set();

chrome.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!changedSettings.has(key)) settings[key] = normalizeSetting(key, stored[key]);
  }
}).catch(() => {
  // Defaults remain usable if extension storage is temporarily unavailable.
}).finally(() => {
  settingsReady = true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes).filter((key) => Object.hasOwn(DEFAULT_SETTINGS, key));
  for (const key of keys) {
    changedSettings.add(key);
    settings[key] = normalizeSetting(key, changes[key].newValue);
  }
  if (keys.some((key) => key !== "enabled") || (changes.enabled && !settings.enabled)) {
    removePopup();
  }
});

document.addEventListener("mouseup", handleMouseUp);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") removePopup();
});
window.addEventListener("resize", followAnchor);
// Pages scroll on their own too (lazy images, scroll anchoring), so reposition
// rather than close, and never cancel a lookup that is still loading.
window.addEventListener("scroll", (event) => {
  if (popup && !popup.contains(event.target)) followAnchor();
}, true);

async function handleMouseUp(event) {
  if (!event.isTrusted || !settingsReady || !settings.enabled) return;
  if (popup?.contains(event.target)) return;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    removePopup();
    return;
  }

  const language = settings.sourceLanguage;
  const selectedWord = selection.toString().normalize("NFC");
  const range = selection.getRangeAt(0);
  const normalized = normalizeSelectedWord(selectedWord, range, language);
  if (!normalized) {
    removePopup();
    return;
  }
  if (event.target instanceof Node && !selection.containsNode(event.target, true)) {
    removePopup();
    return;
  }

  const { word, lookupWord } = normalized;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    removePopup();
    return;
  }

  removePopup();
  anchor = range.cloneRange();
  const id = requestId;
  scheduleLoading(word, rect, id);

  try {
    const result = await lookup(word, lookupWord, language, (interim) => {
      if (id === requestId) {
        clearLoadingTimer();
        renderResult(interim, rect);
      }
    });
    if (id !== requestId) return;
    clearLoadingTimer();
    renderResult(result, rect);
    recordLookup(result);
    enrichNounGender(result, rect, id).catch(() => {
      // Gender enrichment is optional and never changes lookup history.
    });
    enrichMixedForms(result, rect, id).catch(() => {
      // The selected word's own definitions remain available on failure.
    });
  } catch (error) {
    if (id !== requestId) return;
    clearLoadingTimer();
    renderError(word, error.code, language, rect);
  }
}

function scheduleLoading(word, rect, id) {
  clearLoadingTimer();
  if (!settings.showLoading) return;
  loadingTimer = setTimeout(() => {
    loadingTimer = null;
    if (id === requestId) renderLoading(word, rect);
  }, LOADING_DELAY_MS);
}

function clearLoadingTimer() {
  if (loadingTimer === null) return;
  clearTimeout(loadingTimer);
  loadingTimer = null;
}

function recordLookup(result) {
  const message = {
    type: "recordLookup",
    word: result.page,
    language: result.language
  };
  try {
    Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {});
  } catch {
    // History is best-effort and must not turn a displayed result into an error.
  }
}

async function lookup(word, lookupWord, language, onPartial) {
  const first = await fetchEntry(lookupWord, language);
  lookupWord = first.word;
  const firstEntries = first.entries;
  const original = () => ({
    word,
    headword: lookupWord,
    reduced: lookupWord !== word,
    variants: first.variants,
    language,
    entries: summarize(firstEntries, language),
    genders: [],
    page: lookupWord
  });
  const collected = collectForms(firstEntries, language);
  const { forms, formOnly } = collected;
  const form = findForm(firstEntries, language, collected);
  if (formOnly && !form && forms.length > 1) {
    onPartial?.(original());
    return resolveForms(forms, language, firstEntries, (resolved) =>
      combineForms(word, resolved, language, original));
  }
  if (!form || form.lemma.toLocaleLowerCase(language) === lookupWord.toLocaleLowerCase(language)) {
    const result = original();
    if (!form) {
      const mixedForms = formOnly ? [] : forms.filter(({ lemma }) =>
        isLookupWord(lemma) && lemma.toLocaleLowerCase(language) !== lookupWord.toLocaleLowerCase(language));
      if (mixedForms.length) {
        result.enrichForms = () => resolveForms(mixedForms, language, firstEntries,
          (resolved) => combineMixedForms(result, resolved));
      }
    }
    return result;
  }

  const visited = new Set([lookupWord.toLocaleLowerCase(language)]);
  let lemma = form.lemma;
  let lemmaEntries = [];
  const partial = onPartial && setTimeout(() => onPartial(original()), PARTIAL_DELAY_MS);

  try {
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const key = lemma.toLocaleLowerCase(language);
      if (visited.has(key)) break;
      visited.add(key);
      let fetched;
      try {
        fetched = await fetchEntry(lemma, language);
      } catch {
        return original();
      }
      lemma = fetched.word;
      lemmaEntries = fetched.entries;
      const next = findForm(lemmaEntries, language);
      if (!next || visited.has(next.lemma.toLocaleLowerCase(language))) break;
      if (depth === MAX_DEPTH - 1) break;
      lemma = next.lemma;
    }
  } finally {
    clearTimeout(partial);
  }

  const matchingEntries = entriesForForm(form, lemmaEntries);
  const entries = summarize(matchingEntries.length ? matchingEntries : lemmaEntries, language);
  return {
    word,
    relationship: form.relationship,
    lemma,
    language,
    entries,
    genders: [],
    page: lemma
  };
}

async function fetchEntry(word, language) {
  if (!isLookupWord(word)) {
    throw Object.assign(new Error("invalid"), { code: "invalid" });
  }
  const response = await chrome.runtime.sendMessage({ type: "fetchEntry", word, language });
  if (!response?.ok) {
    throw Object.assign(new Error(response?.error || "unavailable"), {
      code: response?.error || "unavailable"
    });
  }
  return response.data;
}

async function enrichNounGender(result, rect, id) {
  const headword = result.lemma || result.headword;
  const genders = await fetchNounGenders(headword, result.language, result.entries);
  if (id === requestId && popup && genders.length && activeResult) {
    renderResult({ ...activeResult, genders }, rect);
  }
}

async function enrichMixedForms(result, rect, id) {
  if (!result.enrichForms) return;
  const enriched = await result.enrichForms();
  if (id === requestId && popup) {
    renderResult({ ...enriched, genders: activeResult?.genders || [] }, rect);
  }
}

async function fetchNounGenders(word, language, entries) {
  if (!settings.showGender || !WORD_LOOKUP_LANGUAGES[language]?.apy
    || !entries.some((entry) => entry.partOfSpeech.toLowerCase() === "noun")) return [];

  try {
    const response = await chrome.runtime.sendMessage({ type: "fetchGender", word, language });
    return response?.ok && Array.isArray(response.data) ? response.data : [];
  } catch {
    return [];
  }
}

function findForm(entries, language, { forms, formOnly } = collectForms(entries, language)) {
  if (!formOnly) return null;
  const lemmas = new Set(forms.map(({ lemma }) => lemma.toLocaleLowerCase(language)));
  return lemmas.size === 1 ? forms[0] : null;
}

function collectForms(entries, language) {
  const forms = [];
  let formOnly = entries.length > 0;
  for (const [sourceIndex, entry] of entries.entries()) {
    if (!entry.definitions?.length) formOnly = false;
    for (const item of entry.definitions || []) {
      if (!FORM_HINT.test(item.definition)) {
        formOnly = false;
        continue;
      }
      const source = parseHtml(item.definition);
      const parsed = parseFormDefinition(item.definition, language, source);
      if (!isFormDefinitionHtml(item.definition, source) && !parsed) formOnly = false;
      if (parsed && isLookupWord(parsed.lemma)) {
        forms.push({ ...parsed, partOfSpeech: entry.partOfSpeech || "Entry", sourceIndex });
      }
    }
  }
  return { forms, formOnly };
}

// Fetch one lemma now. Other distinct lemmas are requested only on expansion.
async function resolveForms(forms, language, firstEntries, display) {
  const seen = new Set();
  const unique = forms.filter((form) => {
    const key = form.lemma.toLocaleLowerCase(language);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const first = await resolveForm(unique[0], language, firstEntries);
  const result = display([first]);
  if (unique.length > 1) {
    result.formCount = unique.length;
    result.expandForms = async () => {
      const remaining = await Promise.all(unique.slice(1).map((form) =>
        resolveForm(form, language, firstEntries)));
      return display([first, ...remaining]);
    };
  }
  return result;
}

async function resolveForm(form, language, firstEntries) {
  try {
    const fetched = await fetchEntry(form.lemma, language);
    const matchingEntries = entriesForForm(form, fetched.entries);
    return { form, entries: matchingEntries.length ? matchingEntries : fetched.entries,
      resolvedWord: fetched.word };
  } catch {
    // Retain the selected word's form descriptions for an unavailable lemma.
    const key = form.lemma.toLocaleLowerCase(language);
    const entries = firstEntries.filter((entry) => collectForms([entry], language).forms
      .some((candidate) => candidate.lemma.toLocaleLowerCase(language) === key));
    return { form, entries };
  }
}

// A participle form belongs to its verb's entries.
function entriesForForm(form, entries) {
  const partOfSpeech = form.partOfSpeech.toLowerCase();
  const target = partOfSpeech === "participle" ? "verb" : partOfSpeech;
  return entries.filter((entry) => entry.partOfSpeech?.toLowerCase() === target);
}

function combineMixedForms(original, resolved) {
  const entries = [];
  original.entries.forEach((entry, index) => {
    entries.push(entry);
    for (const { form, resolvedWord, entries: lemmaEntries } of resolved) {
      if (!resolvedWord || form.sourceIndex !== index) continue;
      entries.push(...summarize(entriesForForm(form, lemmaEntries), original.language)
        .map((item) => ({ ...item, variant: resolvedWord })));
    }
  });
  return { ...original, entries, enrichForms: undefined };
}

function combineForms(word, resolved, language, original) {
  const firstResolved = resolved.find(({ resolvedWord }) => resolvedWord);
  if (!firstResolved) return original();
  return {
    word,
    relationship: resolved.map(({ form }) => form.relationship).join(" / "),
    lemma: resolved.map(({ form }) => form.lemma).join(" / "),
    language,
    entries: summarize(resolved.flatMap(({ entries }) => entries), language),
    genders: [],
    page: firstResolved.resolvedWord
  };
}

function parseFormDefinition(html, language, source = parseHtml(html)) {
  const { parsed, text } = source;
  const form = parsed.querySelector(".form-of-definition");

  if (form) {
    const localizedLinks = [...form.querySelectorAll(
      `.form-of-definition-link [lang="${language}"] a`
    )];
    const links = localizedLinks.length
      ? localizedLinks
      : [...form.querySelectorAll(".form-of-definition-link a")];
    if (links.length === 1) return {
      lemma: links[0].getAttribute("title") || links[0].textContent.trim(),
      relationship: form.textContent.replace(/\s+/g, " ").trim()
    };

    // A structured target without a link is usually a red-link typo. Ignore it
    // rather than letting its text make an otherwise unambiguous form ambiguous.
    if (form.querySelector(".form-of-definition-link")) return null;
  }

  const fallback = text.match(FORM_FALLBACK);
  return fallback ? { relationship: text, lemma: fallback[2] } : null;
}

function summarize(entries, language) {
  return entries.map((entry) => {
    const senses = (entry.definitions || [])
      .map((item) => {
        const source = parseHtml(item.definition);
        return {
          gloss: source.text,
          example: parseHtml(item.parsedExamples?.[0]?.example || item.examples?.[0]).text,
          translation: parseHtml(item.parsedExamples?.[0]?.translation).text,
          form: isFormDefinitionHtml(item.definition, source)
        };
      })
      .filter((sense) => sense.gloss)
      .filter((sense, index, all) => !sense.form || !all.slice(0, index)
        .some((previous) => previous.form && previous.gloss.includes(sense.gloss)))
      .slice(0, MAX_GLOSSES);
    return {
      partOfSpeech: entry.partOfSpeech || "Entry",
      variant: entry.lookupVariant,
      senses
    };
  }).filter((entry) => entry.senses.length);
}

function isFormDefinitionHtml(html, source = parseHtml(html)) {
  const { parsed, text } = source;
  return Boolean(parsed.querySelector(".form-of-definition"))
    || FORM_LABEL.test(text);
}

function parseHtml(html) {
  const parsed = new DOMParser().parseFromString(
    typeof html === "string" ? html : "",
    "text/html"
  );
  parsed.querySelectorAll("style, script").forEach((node) => node.remove());
  return {
    parsed,
    text: parsed.body.textContent.replace(/\s+/g, " ").trim()
  };
}

function hasWholeWordBoundaries(range) {
  const before = adjacentCharacter(range.startContainer, range.startOffset, -1);
  const after = adjacentCharacter(range.endContainer, range.endOffset, 1);
  return !WORD_EDGE.test(before) && !WORD_EDGE.test(after);
}

function normalizeSelectedWord(word, range, language) {
  if (!isLookupWord(word)) return null;

  const elision = ELISIONS[language];
  if (hasWholeWordBoundaries(range)) {
    return { word, lookupWord: elision ? word.replace(elision.start, "") : word };
  }

  if (!elision || WORD_EDGE.test(adjacentCharacter(range.endContainer, range.endOffset, 1))) {
    return null;
  }

  const before = precedingText(range, 7);
  const match = before.match(elision.end);
  if (!match || WORD_EDGE.test(before[match.index - 1] || "")) return null;

  return { word: match[0] + word, lookupWord: word };
}

function precedingText(range, limit) {
  let boundary = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  while (boundary?.parentElement && !isLayoutBoundary(boundary)) {
    boundary = boundary.parentElement;
  }

  const context = range.cloneRange();
  context.setStart(boundary || document.body, 0);
  context.setEnd(range.startContainer, range.startOffset);
  return context.toString().slice(-limit);
}

function adjacentCharacter(container, offset, direction) {
  if (container.nodeType === Node.TEXT_NODE) {
    const index = direction < 0 ? offset - 1 : offset;
    if (index >= 0 && index < container.data.length) return container.data[index];
  } else if (direction < 0 && offset > 0) {
    const found = edgeCharacter(container.childNodes[offset - 1], direction);
    if (found) return found;
  } else if (direction > 0 && offset < container.childNodes.length) {
    const found = edgeCharacter(container.childNodes[offset], direction);
    if (found) return found;
  }

  let node = container;
  while (node && node !== document.body) {
    if (node.nodeType === Node.ELEMENT_NODE && isLayoutBoundary(node)) return "";
    let sibling = direction < 0 ? node.previousSibling : node.nextSibling;
    while (sibling) {
      const found = edgeCharacter(sibling, direction);
      if (found) return found;
      sibling = direction < 0 ? sibling.previousSibling : sibling.nextSibling;
    }
    node = node.parentNode;
  }
  return "";
}

function isLayoutBoundary(node) {
  const display = getComputedStyle(node).display;
  return display !== "inline" && display !== "contents";
}

function edgeCharacter(node, direction) {
  if (node.nodeType === Node.TEXT_NODE) {
    return direction < 0 ? node.data.at(-1) || "" : node.data[0] || "";
  }
  const children = node.childNodes;
  for (let index = direction < 0 ? children.length - 1 : 0;
    index >= 0 && index < children.length;
    index += direction) {
    const found = edgeCharacter(children[index], direction);
    if (found) return found;
  }
  return "";
}

function createPopup(role) {
  popup?.remove();
  popup = document.createElement("aside");
  popup.id = "word-lookup-popup";
  popup.setAttribute("role", role);
  document.documentElement.appendChild(popup);
}

function renderResult(result, rect) {
  activeResult = result;
  createPopup("dialog");

  const headword = result.lemma || result.headword || result.word;
  const displayedHeadword = result.variants?.length
    ? result.variants.join(" / ")
    : headword;
  popup.setAttribute("aria-label", `Word lookup: ${displayedHeadword}`);
  const gender = [...new Set(result.genders || [])].join(", ");
  const title = element(
    "strong",
    gender ? `${displayedHeadword} · ${gender}` : displayedHeadword
  );
  title.className = "wl-title";
  popup.appendChild(title);

  if (result.relationship) {
    popup.appendChild(element(
      "div",
      `${result.word} — ${localizeRelationship(result.relationship, result.language)}`,
      "wl-relationship"
    ));
  } else if (result.reduced) {
    popup.appendChild(element("div", result.word, "wl-relationship"));
  }

  result.entries.forEach((entry) => {
    const partOfSpeech = localizePartOfSpeech(entry.partOfSpeech, result.language);
    const entryLabel = entry.variant ? `${partOfSpeech} · ${entry.variant}` : partOfSpeech;
    popup.appendChild(element("div", entryLabel, "wl-entry"));

    const list = document.createElement("ul");
    entry.senses.forEach((sense) => {
      const item = element("li", sense.gloss, sense.form ? "wl-form" : undefined);
      if (settings.showExamples && sense.example) {
        item.appendChild(element("div", sense.example, "wl-example"));
      }
      if (settings.showExamples && sense.translation) {
        item.appendChild(element("div", sense.translation, "wl-translation"));
      }
      list.appendChild(item);
    });
    popup.appendChild(list);
  });

  if (result.expandForms) {
    popup.appendChild(element("div", result.lemma
      ? `First of ${result.formCount} forms` : "Form descriptions", "wl-form-count"));
    const button = element("button", "Show all forms", "wl-expand");
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Loading forms…";
      // An in-flight gender response for the first form must not replace all forms.
      const id = ++requestId;
      try {
        const expanded = await result.expandForms();
        if (id === requestId && popup) renderResult(expanded, rect);
      } catch {
        if (id === requestId && popup?.contains(button)) {
          button.disabled = false;
          button.textContent = "Show all forms";
        }
      }
    });
    popup.appendChild(button);
  }

  const link = element("a", "Full Wiktionary entry", "wl-link");
  link.href = pageUrl(result.page);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  popup.appendChild(link);
  positionPopup(rect);
}

function localizePartOfSpeech(partOfSpeech, language) {
  const key = partOfSpeech.toLocaleLowerCase("en");
  return POS_LABELS[language]?.[key] || key;
}

function localizeRelationship(text, language) {
  if (language !== "fr") return text;

  const conjugation = text.match(/^((?:first|second|third)(?:\/(?:first|second|third))?)-person (singular|plural)(?: (present|imperfect|future|past historic|simple past))?(?: (indicative(?:\/subjunctive)?|subjunctive|conditional|imperative))? of (.+)$/i);
  if (conjugation) {
    const people = { first: "1re", second: "2e", third: "3e" };
    const number = conjugation[2] === "singular" ? "singulier" : "pluriel";
    const tense = {
      present: "du présent",
      imperfect: "de l'imparfait",
      future: "du futur",
      "past historic": "du passé simple",
      "simple past": "du passé simple"
    }[conjugation[3]?.toLowerCase()] || "";
    const mood = conjugation[4] ? {
      indicative: "de l'indicatif",
      "indicative/subjunctive": "de l'indicatif ou du subjonctif",
      subjunctive: "du subjonctif",
      conditional: "du conditionnel",
      imperative: "de l'impératif"
    }[conjugation[4].toLowerCase()] : "de l'indicatif";
    const person = conjugation[1].split("/").map((item) => people[item.toLowerCase()]).join(" ou ");
    return `${person} personne du ${number}${tense ? ` ${tense}` : ""} ${mood}`;
  }

  const forms = [
    [/^past participle of (.+)$/i, "participe passé"],
    [/^present participle of (.+)$/i, "participe présent"],
    [/^plural of (.+)$/i, "pluriel"],
    [/^singular of (.+)$/i, "singulier"],
    [/^feminine of (.+)$/i, "féminin"],
    [/^masculine of (.+)$/i, "masculin"],
    [/^inflection of (.+?)(?::)?$/i, "forme fléchie"]
  ];
  for (const [pattern, replacement] of forms) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

function renderLoading(word, rect) {
  createPopup("status");
  popup.setAttribute("aria-label", `Word lookup: ${word}`);
  popup.replaceChildren(
    element("strong", word, "wl-title"),
    element("div", "Looking up…", "wl-loading")
  );
  positionPopup(rect);
}

function renderError(word, code, language, rect) {
  if (code === "not_found" && !settings.showNotFound) {
    removePopup();
    return;
  }

  const languageName = WORD_LOOKUP_LANGUAGES[language]?.name || "selected language";
  const messages = {
    not_found: `No ${languageName} entry found.`,
    unavailable: "Wiktionary is currently unavailable.",
    invalid: "This word cannot be looked up."
  };

  createPopup("status");
  popup.setAttribute("aria-label", `Word lookup: ${word}`);
  popup.replaceChildren(
    element("strong", word, "wl-title"),
    element("div", messages[code] || "Lookup failed.", "wl-error")
  );
  positionPopup(rect);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function followAnchor() {
  if (!popup) return;
  const rect = anchor?.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)
    || rect.bottom < 0 || rect.top > window.innerHeight) {
    removePopup();
    return;
  }
  positionPopup(rect);
}

function positionPopup(rect) {
  // Late renders (gender, lemma definitions) use the word's current position.
  const current = anchor?.getBoundingClientRect();
  if (current && (current.width || current.height)) rect = current;
  const gap = 8;
  const viewportWidth = Math.max(0, window.innerWidth);
  const viewportHeight = Math.max(0, window.innerHeight);
  const viewportMaxHeight = Math.min(360, Math.max(0, viewportHeight - gap * 2));
  popup.style.maxHeight = `${viewportMaxHeight}px`;

  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - gap);
  const spaceAbove = Math.max(0, rect.top - gap);
  const initialHeight = Math.min(popup.offsetHeight, viewportMaxHeight);
  const showAbove = spaceBelow < initialHeight && spaceAbove > spaceBelow;
  const availableHeight = showAbove ? spaceAbove : spaceBelow;
  popup.style.maxHeight = `${Math.min(viewportMaxHeight, availableHeight)}px`;

  const width = Math.min(popup.offsetWidth, Math.max(0, viewportWidth - gap * 2));
  const height = Math.min(popup.offsetHeight, availableHeight);
  const desiredTop = showAbove ? rect.top - height - gap : rect.bottom + gap;
  const left = Math.max(gap, Math.min(rect.left, viewportWidth - width - gap));
  const top = Math.max(gap, Math.min(desiredTop, viewportHeight - height - gap));

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function removePopup() {
  clearLoadingTimer();
  popup?.remove();
  popup = null;
  anchor = null;
  activeResult = null;
  requestId += 1;
}
