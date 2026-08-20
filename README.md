# Word Lookup

A minimal Manifest V3 browser extension. Select one complete word on a page and
release the mouse button to see its entry from English Wiktionary. English is the
default source language; click the extension icon to select English, French,
Spanish, German, or Italian.
Lookups are enabled by default and can be turned off from the same popup.

## Install locally

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.

`manifest.json` is the Chromium development manifest. To build both browser
packages, run `./build.sh`; it creates separate ZIP files in `dist/` using
`manifest.chromium.json` and `manifest.firefox.json`.

For Firefox 140+, extract the Firefox ZIP, open
`about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and
select its `manifest.json`.

The extension requests access to `en.wiktionary.org` only for definition
lookups. Selected words are sent there; locally, it stores only the enabled
preference and chosen source-language code.

Definitions and examples come from English Wiktionary contributors. Each popup
links to its source entry. Wiktionary text is available under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) and, unless
otherwise noted, the GFDL. This extension is not endorsed by or affiliated with
the Wikimedia Foundation.

## Roadmap

- Add Portuguese, Dutch, Polish, Swedish, Norwegian, Danish, and Romanian as
  source-language options.
- Separate the source language from the interface and definition language.
- Add localized parts of speech and grammatical descriptions for every source
  language.
- Add caching and rate-limit backoff while preserving automatic selection.
