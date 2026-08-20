const enabled = document.querySelector("#enabled");
const language = document.querySelector("#language");
const status = document.querySelector("#status");

chrome.storage.local.get({ enabled: true, sourceLanguage: "en" }).then((settings) => {
  enabled.checked = settings.enabled;
  const { sourceLanguage } = settings;
  language.value = sourceLanguage;
});

enabled.addEventListener("change", async () => {
  await chrome.storage.local.set({ enabled: enabled.checked });
  showSaved();
});

language.addEventListener("change", async () => {
  await chrome.storage.local.set({ sourceLanguage: language.value });
  showSaved();
});

function showSaved() {
  status.textContent = "Saved";
  setTimeout(() => { status.textContent = ""; }, 1000);
}
