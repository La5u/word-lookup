# Word Lookup

Word Lookup is a small browser extension that shows English Wiktionary
definitions for a selected word. It supports English, French, Spanish, German,
Italian, Dutch, Swedish, and Romanian source words.

## How it works

1. Select one complete word on a web page.
2. The content script sends the word and selected source language to the
   extension's background script.
3. The background script requests the word's entry from English Wiktionary.
4. The extension extracts definitions, parts of speech, example sentences, and
   links to related headwords, then displays them beside the selection.
5. When noun gender is enabled for a supported language, the background script
   also asks Apertium for morphological analysis.

Lookups, examples, noun genders, and “no entry found” messages can be configured
from the extension popup. Preferences are stored locally by the browser.

## APIs

- **English Wiktionary REST API**
  (`https://en.wiktionary.org/api/rest_v1/page/definition/`) provides
  definitions, parts of speech, examples, and inflection information.
  English Wiktionary contains entries for words from all supported source
  languages.

- **Apertium APY** (`https://www.apertium.org/apy/analyze`) provides
  morphological analysis used only to identify noun gender. No request
  is made to Apertium when noun genders are disabled or the selected language is
  unsupported by the analyzer.

Selected words are sent to these services as needed. The extension does not run
a server and locally stores only its enabled preferences and source-language
choice.

Definitions and examples come from English Wiktionary contributors. Wiktionary
text is available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
and, unless otherwise noted, the GFDL. Noun analysis is provided by
[Apertium](https://www.apertium.org/). This extension is not endorsed by or
affiliated with the Wikimedia Foundation.

## Install locally

### Chromium, Chrome, or Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.

### Firefox 140+

1. Run `./build.sh`.
2. Extract `dist/word-lookup-0.2.0-firefox.zip`.
3. Open `about:debugging#/runtime/this-firefox`.
4. Choose **Load Temporary Add-on** and select the extracted `manifest.json`.

## Build

Run:

```sh
./build.sh
```

This creates separate Chromium and Firefox ZIP files in `dist/`. The extension
itself is plain HTML, CSS, and JavaScript. Building requires only standard shell
tools, Python 3, and `zip`; Node.js and npm are not required.

## Tests

npm is used only for development tests. It installs `linkedom`, which supplies a
small DOM implementation so the content and settings scripts can be tested in
Node.js.

```sh
npm install
npm test
```

To run syntax checks, tests, and package builds together:

```sh
npm run check
```
