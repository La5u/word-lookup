const WORD = /^\p{L}[\p{L}\p{M}]*(?:['’\-]\p{L}[\p{L}\p{M}]*)*$/u;
const WORD_EDGE = /[\p{L}\p{M}'’\-]/u;
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
let popup;
let requestId = 0;
let enabled = false;
let sourceLanguage = "en";
let showExamples = true;
let showGender = true;
let showNotFound = false;
let settingsReady = false;
const changedSettings = new Set();

chrome.storage.local.get({
  enabled: true,
  sourceLanguage: "en",
  showExamples: true,
  showGender: true,
  showNotFound: false
}).then((settings) => {
  if (!changedSettings.has("sourceLanguage")) {
    sourceLanguage = WORD_LOOKUP_LANGUAGES[settings.sourceLanguage]
      ? settings.sourceLanguage
      : "en";
  }
  if (!changedSettings.has("enabled")) enabled = settings.enabled !== false;
  if (!changedSettings.has("showExamples")) showExamples = settings.showExamples !== false;
  if (!changedSettings.has("showGender")) showGender = settings.showGender !== false;
  if (!changedSettings.has("showNotFound")) showNotFound = settings.showNotFound === true;
  settingsReady = true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  Object.keys(changes).forEach((key) => changedSettings.add(key));

  if (changes.sourceLanguage) {
    sourceLanguage = WORD_LOOKUP_LANGUAGES[changes.sourceLanguage.newValue]
      ? changes.sourceLanguage.newValue
      : "en";
    removePopup();
  }
  if (changes.showExamples) {
    showExamples = changes.showExamples.newValue !== false;
    removePopup();
  }
  if (changes.showGender) {
    showGender = changes.showGender.newValue !== false;
    removePopup();
  }
  if (changes.showNotFound) {
    showNotFound = changes.showNotFound.newValue === true;
    removePopup();
  }
  if (changes.enabled) {
    enabled = changes.enabled.newValue !== false;
    if (!enabled) removePopup();
  }
});

document.addEventListener("mouseup", handleMouseUp);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") removePopup();
});
window.addEventListener("resize", removePopup);
window.addEventListener("scroll", (event) => {
  if (!popup?.contains(event.target)) removePopup();
}, true);

async function handleMouseUp(event) {
  if (!settingsReady || !enabled) return;
  if (popup?.contains(event.target)) return;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    removePopup();
    return;
  }

  const language = sourceLanguage;
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

  const id = ++requestId;

  try {
    const result = await lookup(word, lookupWord, language);
    if (id !== requestId) return;
    renderResult(result, rect);
    enrichNounGender(result, rect, id);
  } catch (error) {
    if (id === requestId) renderError(word, error.code, language, rect);
  }
}

async function lookup(word, lookupWord, language) {
  const first = await fetchEntry(lookupWord, language);
  lookupWord = first.word;
  const firstEntries = first.entries;
  const form = findForm(firstEntries, language);
  if (!form || form.lemma.toLocaleLowerCase() === lookupWord.toLocaleLowerCase()) {
    const entries = summarize(firstEntries, language);
    return {
      word,
      headword: lookupWord,
      reduced: lookupWord !== word,
      variants: first.variants,
      language,
      entries,
      genders: [],
      url: pageUrl(lookupWord)
    };
  }

  const visited = new Set([lookupWord.toLocaleLowerCase()]);
  let lemma = form.lemma;
  let lemmaEntries = [];

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const key = lemma.toLocaleLowerCase();
    if (visited.has(key)) break;
    visited.add(key);
    const fetched = await fetchEntry(lemma, language);
    lemma = fetched.word;
    lemmaEntries = fetched.entries;
    const next = findForm(lemmaEntries, language);
    if (!next || visited.has(next.lemma.toLocaleLowerCase())) break;
    if (depth === MAX_DEPTH - 1) break;
    lemma = next.lemma;
  }

  const targetPartOfSpeech = form.partOfSpeech.toLowerCase() === "participle"
    ? "verb"
    : form.partOfSpeech.toLowerCase();
  const matchingEntries = lemmaEntries.filter((entry) =>
    entry.partOfSpeech?.toLowerCase() === targetPartOfSpeech);
  const entries = summarize(matchingEntries.length ? matchingEntries : lemmaEntries, language);
  return {
    word,
    relationship: form.relationship,
    lemma,
    language,
    entries,
    genders: [],
    url: pageUrl(lemma)
  };
}

async function fetchEntry(word, language) {
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
  if (id === requestId && popup && genders.length) renderResult({ ...result, genders }, rect);
}

async function fetchNounGenders(word, language, entries) {
  if (!showGender || !WORD_LOOKUP_LANGUAGES[language]?.apy
    || !entries.some((entry) => entry.partOfSpeech.toLowerCase() === "noun")) return [];

  try {
    const response = await chrome.runtime.sendMessage({ type: "fetchGender", word, language });
    return response?.ok && Array.isArray(response.data) ? response.data : [];
  } catch {
    return [];
  }
}

function findForm(entries, language) {
  if (!entries.length || entries.some((entry) => !isFormOnly(entry, language))) return null;

  const matches = entries.flatMap((entry) => (entry.definitions || [])
    .map((item) => parseFormDefinition(item.definition, language))
    .filter(Boolean)
    .map((form) => ({ ...form, partOfSpeech: entry.partOfSpeech || "Entry" })));
  const lemmas = new Set(matches.map((match) =>
    match.lemma.toLocaleLowerCase(language)));
  return lemmas.size === 1 ? matches[0] : null;
}

function parseFormDefinition(html, language) {
  const parsed = new DOMParser().parseFromString(html || "", "text/html");
  const form = parsed.querySelector(".form-of-definition");
  const text = parsed.body.textContent.replace(/\s+/g, " ").trim();

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
  }

  // Conservative fallback for older responses without form-of CSS classes.
  const fallback = text.match(/^((?:(?:first|second|third)(?:-person)?|simple past|past tense|past participle|present participle|gerund|plural|singular|infinitive|imperative|feminine|masculine|comparative|superlative|inflection|spelling|form)\b.*?\bof)\s+([\p{L}\p{M}'’\-]+)$/iu);
  return fallback ? { relationship: text, lemma: fallback[2] } : null;
}

function summarize(entries, language) {
  return entries.map((entry) => {
    const senses = (entry.definitions || [])
      .map((item) => ({
        gloss: textFromHtml(item.definition),
        example: textFromHtml(item.parsedExamples?.[0]?.example || item.examples?.[0]),
        translation: textFromHtml(item.parsedExamples?.[0]?.translation),
        form: isFormDefinitionHtml(item.definition)
      }))
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

function isFormDefinitionHtml(html) {
  const parsed = new DOMParser().parseFromString(html || "", "text/html");
  const text = parsed.body.textContent.replace(/\s+/g, " ").trim();
  return Boolean(parsed.querySelector(".form-of-definition"))
    || /^(?:contraction|plural|singular|inflection|form|simple past|past tense|past participle|present participle|gerund|infinitive|imperative|feminine|masculine|comparative|superlative|(?:first|second|third)(?:-person)?)\b.*\bof\b/iu.test(text);
}

function isFormOnly(entry, language) {
  const definitions = entry.definitions || [];
  return definitions.length > 0 && definitions.every((item) =>
    isFormDefinitionHtml(item.definition) || Boolean(parseFormDefinition(item.definition, language)));
}

function textFromHtml(html) {
  const parsed = new DOMParser().parseFromString(html || "", "text/html");
  parsed.querySelectorAll("style, script").forEach((node) => node.remove());
  return parsed.body.textContent.replace(/\s+/g, " ").trim();
}

function pageUrl(word) {
  return `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`;
}

function hasWholeWordBoundaries(range) {
  const before = adjacentCharacter(range.startContainer, range.startOffset, -1);
  const after = adjacentCharacter(range.endContainer, range.endOffset, 1);
  return !WORD_EDGE.test(before) && !WORD_EDGE.test(after);
}

function normalizeSelectedWord(word, range, language) {
  if (!WORD.test(word)) return null;

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

    const list = document.createElement("ol");
    entry.senses.forEach((sense) => {
      const item = element("li", sense.gloss, sense.form ? "wl-form" : undefined);
      if (showExamples && sense.example) {
        item.appendChild(element("div", sense.example, "wl-example"));
      }
      if (showExamples && sense.translation) {
        item.appendChild(element("div", sense.translation, "wl-translation"));
      }
      list.appendChild(item);
    });
    popup.appendChild(list);
  });

  const link = element("a", "Full Wiktionary entry", "wl-link");
  link.href = result.url;
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

function renderError(word, code, language, rect) {
  if (code === "not_found" && !showNotFound) {
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

function positionPopup(rect) {
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
  popup?.remove();
  popup = null;
  requestId += 1;
}
