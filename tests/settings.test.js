const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const html = readFileSync("settings.html", "utf8");
const source = readFileSync("settings.js", "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

test("example sentences default to enabled and persist changes", async () => {
  const { document, window } = parseHTML(html);
  const pending = deferred();
  const writes = [];
  const context = vm.createContext({
    document,
    WORD_LOOKUP_LANGUAGES: { en: { name: "English" }, de: { name: "German" } },
    chrome: {
      storage: {
        local: {
          get: () => pending.promise,
          set: (value) => writes.push(value)
        }
      }
    }
  });
  vm.runInContext(source, context);

  pending.resolve({
    enabled: true,
    sourceLanguage: "en",
    showExamples: true,
    showGender: true,
    showNotFound: false
  });
  await tick();
  const checkbox = document.querySelector("#show-examples");
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  checkbox.dispatchEvent(new window.Event("change"));
  assert.equal(JSON.stringify(writes.at(-1)), JSON.stringify({ showExamples: false }));

  const gender = document.querySelector("#show-gender");
  assert.equal(gender.checked, true);
  gender.checked = false;
  gender.dispatchEvent(new window.Event("change"));
  assert.equal(JSON.stringify(writes.at(-1)), JSON.stringify({ showGender: false }));

  const notFound = document.querySelector("#show-not-found");
  assert.equal(notFound.checked, false);
  notFound.checked = true;
  notFound.dispatchEvent(new window.Event("change"));
  assert.equal(JSON.stringify(writes.at(-1)), JSON.stringify({ showNotFound: true }));
});

test("a user change is not overwritten by a delayed storage read", async () => {
  const { document, window } = parseHTML(html);
  const pending = deferred();
  const context = vm.createContext({
    document,
    WORD_LOOKUP_LANGUAGES: { en: { name: "English" } },
    chrome: { storage: { local: { get: () => pending.promise, set() {} } } }
  });
  vm.runInContext(source, context);

  const checkbox = document.querySelector("#show-examples");
  checkbox.checked = false;
  checkbox.dispatchEvent(new window.Event("change"));
  const gender = document.querySelector("#show-gender");
  gender.checked = false;
  gender.dispatchEvent(new window.Event("change"));
  const notFound = document.querySelector("#show-not-found");
  notFound.checked = true;
  notFound.dispatchEvent(new window.Event("change"));
  pending.resolve({
    enabled: true,
    sourceLanguage: "en",
    showExamples: true,
    showGender: true,
    showNotFound: false
  });
  await tick();
  assert.equal(checkbox.checked, false);
  assert.equal(gender.checked, false);
  assert.equal(notFound.checked, true);
});
