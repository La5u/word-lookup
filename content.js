const WORD = /^\p{L}[\p{L}\p{M}]*(?:['’\-]\p{L}[\p{L}\p{M}]*)*$/u;
const WORD_EDGE = /[\p{L}\p{M}'’\-]/u;
const FRENCH_ELISION = /^(?:[cdjlmnstç]|qu)['’](?=\p{L})/iu;
const FORM_RELATION = /\b(?:plural|singular|participle|infinitive|imperative|person|tense|indicative|subjunctive|feminine|masculine|comparative|superlative|form|inflection|spelling)\b.*\bof\b/iu;
const FORM_DETAIL = /\b(?:first|second|third)(?:-person)?\b.*\b(?:singular|plural|indicative|subjunctive|imperative)\b/iu;
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
const LANGUAGE_NAMES = {
  en: "English",
  fr: "French",
  es: "Spanish",
  de: "German",
  it: "Italian"
};
const MAX_DEPTH = 3;
const MAX_GLOSSES = 3;
let popup;
let requestId = 0;
let enabled = false;

chrome.storage.local.get({ enabled: true }).then((settings) => {
  enabled = settings.enabled;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  enabled = changes.enabled.newValue ?? true;
  if (!enabled) removePopup();
});

document.addEventListener("mouseup", handleMouseUp);
document.addEventListener("mousedown", (event) => {
  if (!popup?.contains(event.target)) removePopup();
}, true);

async function handleMouseUp(event) {
  if (!enabled) return;
  if (popup?.contains(event.target)) return;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;

  const word = selection.toString().normalize("NFC");
  const range = selection.getRangeAt(0);
  if (!WORD.test(word) || !hasWholeWordBoundaries(range)) return;

  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;

  const id = ++requestId;

  try {
    const { sourceLanguage = "en" } = await chrome.storage.local.get("sourceLanguage");
    const lookupWord = sourceLanguage === "fr" ? word.replace(FRENCH_ELISION, "") : word;
    const result = await lookup(word, lookupWord, sourceLanguage);
    if (id !== requestId) return;
    renderResult(result, rect);
  } catch (error) {
    if (id === requestId) renderError(word, error.message, rect);
  }
}

async function lookup(word, lookupWord, language) {
  const firstEntries = await fetchEntry(lookupWord, language);
  const form = findForm(firstEntries, language);
  if (!form || form.lemma.toLocaleLowerCase() === lookupWord.toLocaleLowerCase()) {
    const entries = summarize(firstEntries);
    return {
      word,
      headword: lookupWord,
      reduced: lookupWord !== word,
      language,
      entries,
      genders: await fetchNounGenders(lookupWord, language, entries),
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
    lemmaEntries = await fetchEntry(lemma, language);
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
  const entries = summarize(matchingEntries.length ? matchingEntries : lemmaEntries);
  return {
    word,
    relationship: form.relationship,
    lemma,
    language,
    entries,
    genders: await fetchNounGenders(lemma, language, entries),
    url: pageUrl(lemma)
  };
}

async function fetchEntry(word, language) {
  const response = await chrome.runtime.sendMessage({ type: "fetchEntry", word, language });
  if (!response?.ok) throw new Error(response?.error || "Lookup failed");
  return response.data;
}

async function fetchNounGenders(word, language, entries) {
  if (!entries.some((entry) => entry.partOfSpeech.toLowerCase() === "noun")) return [];

  try {
    const response = await chrome.runtime.sendMessage({ type: "fetchPage", word });
    if (!response?.ok) return [];
    const parsed = new DOMParser().parseFromString(response.data, "text/html");
    const languageSection = parsed.querySelector(`h2#${LANGUAGE_NAMES[language]}`)?.closest("section");
    if (!languageSection) return [];

    return [...languageSection.querySelectorAll("section")]
      .filter((section) => section.querySelector(":scope > h3, :scope > h4, :scope > h5")
        ?.textContent.trim() === "Noun")
      .map((section) => section.querySelector(".headword-line .gender abbr")?.textContent.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findForm(entries, language) {
  let match = null;

  for (const entry of entries) {
    for (const item of entry.definitions || []) {
      const parsed = new DOMParser().parseFromString(item.definition || "", "text/html");
      const form = parsed.querySelector(".form-of-definition");
      const text = parsed.body.textContent.replace(/\s+/g, " ").trim();
      if (!isFormDefinition(parsed, text)) return null;

      const link = form?.querySelector(`.form-of-definition-link [lang="${language}"] a`)
        || form?.querySelector(".form-of-definition-link a");
      if (link) {
        match ||= {
          lemma: link.getAttribute("title") || link.textContent.trim(),
          relationship: form.textContent.replace(/\s+/g, " ").trim(),
          partOfSpeech: entry.partOfSpeech || "Entry"
        };
        continue;
      }

      // Conservative fallback for older responses without form-of CSS classes.
      const fallback = text.match(/^(.*(?:plural|singular|participle|infinitive|imperative|person|tense|form)\b.*?\bof)\s+([\p{L}\p{M}'’\-]+)$/iu);
      if (fallback) match ||= {
        relationship: text,
        lemma: fallback[2],
        partOfSpeech: entry.partOfSpeech || "Entry"
      };
    }
  }
  return match;
}

function summarize(entries) {
  const hasLexicalEntry = entries.some((entry) => !isFormOnly(entry));
  return entries.filter((entry) => !hasLexicalEntry || !isFormOnly(entry)).map((entry) => ({
    partOfSpeech: entry.partOfSpeech || "Entry",
    senses: (entry.definitions || [])
      .map((item) => ({
        gloss: textFromHtml(item.definition),
        example: textFromHtml(item.parsedExamples?.[0]?.example || item.examples?.[0]),
        translation: textFromHtml(item.parsedExamples?.[0]?.translation)
      }))
      .filter((sense) => sense.gloss)
      .slice(0, MAX_GLOSSES)
  })).filter((entry) => entry.senses.length);
}

function isFormOnly(entry) {
  const definitions = entry.definitions || [];
  return definitions.length > 0 && definitions.every((item) => {
    const parsed = new DOMParser().parseFromString(item.definition || "", "text/html");
    const text = parsed.body.textContent.replace(/\s+/g, " ").trim();
    return isFormDefinition(parsed, text);
  });
}

function isFormDefinition(parsed, text) {
  return Boolean(parsed.querySelector(".form-of-definition"))
    && (FORM_RELATION.test(text) || FORM_DETAIL.test(text));
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

function createPopup(rect, role) {
  popup?.remove();
  popup = document.createElement("aside");
  popup.id = "word-lookup-popup";
  popup.setAttribute("role", role);
  document.documentElement.appendChild(popup);
  positionPopup(rect);
}

function renderResult(result, rect) {
  createPopup(rect, "dialog");

  const headword = result.lemma || result.headword || result.word;
  const gender = [...new Set(result.genders || [])].join(", ");
  const title = element("strong", gender ? `${headword} · ${gender}` : headword);
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
    popup.appendChild(element("div", partOfSpeech, "wl-entry"));

    const list = document.createElement("ol");
    entry.senses.forEach((sense) => {
      const item = element("li", sense.gloss);
      if (sense.example) {
        item.appendChild(element("div", sense.example, "wl-example"));
      }
      if (sense.translation) {
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

function renderError(word, message, rect) {
  createPopup(rect, "status");
  popup.replaceChildren(
    element("strong", word, "wl-title"),
    element("div", message, "wl-error")
  );
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function positionPopup(rect) {
  const gap = 8;
  const width = 300;
  const left = Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap));
  const top = Math.max(gap, Math.min(rect.bottom + gap, window.innerHeight - 180));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  popup.style.maxHeight = `${Math.max(80, window.innerHeight - top - gap)}px`;
}

function removePopup() {
  popup?.remove();
  popup = null;
  requestId += 1;
}
