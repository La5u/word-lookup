const controls = {
  enabled: document.querySelector("#enabled"),
  showExamples: document.querySelector("#show-examples"),
  showGender: document.querySelector("#show-gender"),
  showNotFound: document.querySelector("#show-not-found"),
  showLoading: document.querySelector("#show-loading"),
  sourceLanguage: document.querySelector("#language")
};
const settingsTab = document.querySelector("#settings-tab");
const historyTab = document.querySelector("#history-tab");
const settingsPanel = document.querySelector("#settings-panel");
const historyPanel = document.querySelector("#history-panel");
const historyList = document.querySelector("#history-list");
const clearHistory = document.querySelector("#clear-history");
const changedSettings = new Set();
let settingsLoaded = false;
let historyChanged = false;
let history = [];

for (const [code, { name }] of Object.entries(WORD_LOOKUP_LANGUAGES)) {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = name;
  controls.sourceLanguage.appendChild(option);
}

chrome.storage.local.get({ ...DEFAULT_SETTINGS, [HISTORY_KEY]: [] }).then((stored) => {
  for (const key of Object.keys(controls)) {
    if (!changedSettings.has(key)) showSetting(key, stored[key]);
  }
  if (!historyChanged) history = normalizeHistory(stored[HISTORY_KEY]);
  settingsLoaded = true;
  renderHistory();
}).catch(() => {
  settingsLoaded = true;
  renderHistory();
});

if (chrome.storage.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!settingsLoaded) {
      Object.keys(changes).forEach((key) => changedSettings.add(key));
    }
    for (const key of Object.keys(controls)) {
      if (changes[key]) showSetting(key, changes[key].newValue);
    }
    if (changes[HISTORY_KEY]) {
      historyChanged = true;
      history = normalizeHistory(changes[HISTORY_KEY].newValue);
      renderHistory();
    }
  });
}

settingsTab.addEventListener("click", () => selectTab("settings"));
historyTab.addEventListener("click", () => selectTab("history"));
for (const tab of [settingsTab, historyTab]) {
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const chooseHistory = event.key === "ArrowRight" || event.key === "End";
    selectTab(chooseHistory ? "history" : "settings");
    (chooseHistory ? historyTab : settingsTab).focus();
  });
}

for (const [key, control] of Object.entries(controls)) {
  control.addEventListener("change", () => {
    changedSettings.add(key);
    chrome.storage.local.set({ [key]: control[controlProperty(key)] });
  });
}

clearHistory.addEventListener("click", () => {
  history = [];
  historyChanged = true;
  renderHistory();
  sendHistoryMutation({ type: "clearHistory" });
});

function selectTab(tab) {
  const settingsSelected = tab === "settings";
  settingsTab.setAttribute("aria-selected", String(settingsSelected));
  historyTab.setAttribute("aria-selected", String(!settingsSelected));
  settingsTab.setAttribute("tabindex", settingsSelected ? "0" : "-1");
  historyTab.setAttribute("tabindex", settingsSelected ? "-1" : "0");
  settingsPanel.hidden = !settingsSelected;
  historyPanel.hidden = settingsSelected;
  if (!settingsSelected) renderHistory();
}

function controlProperty(key) {
  return key === "sourceLanguage" ? "value" : "checked";
}

function showSetting(key, value) {
  controls[key][controlProperty(key)] = normalizeSetting(key, value);
}

function renderHistory() {
  historyList.replaceChildren();
  clearHistory.disabled = history.length === 0;

  if (!history.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "No successful lookups yet.";
    historyList.appendChild(empty);
    return;
  }

  history.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-entry";

    const word = document.createElement("div");
    word.className = "history-word";
    word.textContent = entry.word;
    item.appendChild(word);

    const languageName = WORD_LOOKUP_LANGUAGES[entry.language]?.name || entry.language;
    const language = document.createElement("div");
    language.className = "history-language";
    language.textContent = languageName;
    item.appendChild(language);

    const link = document.createElement("a");
    link.className = "history-link";
    link.href = pageUrl(entry.word);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Wiktionary entry";
    item.appendChild(link);

    historyList.appendChild(item);
  });
}

// The storage change listener renders the result; only failures need a reload.
function sendHistoryMutation(message) {
  Promise.resolve()
    .then(() => chrome.runtime.sendMessage(message))
    .then((response) => {
      if (!response?.ok) reloadHistory();
    })
    .catch(reloadHistory);
}

function reloadHistory() {
  chrome.storage.local.get({ [HISTORY_KEY]: [] }).then((settings) => {
    historyChanged = true;
    history = normalizeHistory(settings[HISTORY_KEY]);
    renderHistory();
  }).catch(() => {});
}
