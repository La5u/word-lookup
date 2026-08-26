const enabled = document.querySelector("#enabled");
const showExamples = document.querySelector("#show-examples");
const showGender = document.querySelector("#show-gender");
const showNotFound = document.querySelector("#show-not-found");
const language = document.querySelector("#language");
const changedSettings = new Set();

for (const [code, { name }] of Object.entries(WORD_LOOKUP_LANGUAGES)) {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = name;
  language.appendChild(option);
}

chrome.storage.local.get({
  enabled: true,
  showExamples: true,
  showGender: true,
  showNotFound: false,
  sourceLanguage: "en"
}).then((settings) => {
  if (!changedSettings.has("enabled")) enabled.checked = settings.enabled !== false;
  if (!changedSettings.has("showExamples")) {
    showExamples.checked = settings.showExamples !== false;
  }
  if (!changedSettings.has("showGender")) {
    showGender.checked = settings.showGender !== false;
  }
  if (!changedSettings.has("showNotFound")) {
    showNotFound.checked = settings.showNotFound === true;
  }
  if (!changedSettings.has("sourceLanguage")) {
    language.value = WORD_LOOKUP_LANGUAGES[settings.sourceLanguage]
      ? settings.sourceLanguage
      : "en";
  }
});

enabled.addEventListener("change", () => {
  changedSettings.add("enabled");
  chrome.storage.local.set({ enabled: enabled.checked });
});

showExamples.addEventListener("change", () => {
  changedSettings.add("showExamples");
  chrome.storage.local.set({ showExamples: showExamples.checked });
});

showGender.addEventListener("change", () => {
  changedSettings.add("showGender");
  chrome.storage.local.set({ showGender: showGender.checked });
});

showNotFound.addEventListener("change", () => {
  changedSettings.add("showNotFound");
  chrome.storage.local.set({ showNotFound: showNotFound.checked });
});

language.addEventListener("change", () => {
  changedSettings.add("sourceLanguage");
  chrome.storage.local.set({ sourceLanguage: language.value });
});
