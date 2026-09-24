// Captures store screenshots: real Wikipedia pages, real extension popup.
// Usage: node screenshots/capture.mjs "$PWD" "$PWD/screenshots" [french,german,...]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const [, , extensionDir, outDir, only] = process.argv;
const scratch = process.env.TMPDIR ? `${process.env.TMPDIR}/word-lookup-capture-` : "/tmp/word-lookup-capture-";
const port = 9333;

const shots = [
  { name: "french", language: "fr", url: "https://fr.wikipedia.org/wiki/Croissant_(viennoiserie)", words: ["beurre", "pâte", "boulangerie", "farine", "forme"] },
  { name: "german", language: "de", url: "https://de.wikipedia.org/wiki/Kaffee", words: ["Getränk", "Bohnen", "Röstung", "Samen", "Pflanze"] },
  { name: "spanish", language: "es", url: "https://es.wikipedia.org/wiki/Chocolate", words: ["semillas", "cacao", "alimento", "árbol", "sabor"] },
  { name: "italian", language: "it", url: "https://it.wikipedia.org/wiki/Gelato", words: ["freddo", "dolce", "zucchero", "latte", "congelato", "alimento", "panna"] },
  { name: "swedish", language: "sv", url: "https://sv.wikipedia.org/wiki/Kanelbulle", words: ["bulle", "kanel", "deg", "socker", "smör", "vetebulle", "bakverk"] }
].filter((shot) => !only || only.split(",").includes(shot.name));

mkdirSync(outDir, { recursive: true });
const browser = spawn("chromium", [
  "--headless=new", "--no-first-run", "--hide-scrollbars", "--lang=en-US",
  `--user-data-dir=${scratch}profile`, `--remote-debugging-port=${port}`,
  `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
  "--window-size=1280,800", "about:blank"
], { stdio: "ignore" });

let socket;
try {
  let version;
  for (let i = 0; i < 50 && !version; i += 1) {
    await sleep(200);
    version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null);
  }
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const evaluate = async (session, expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true }, session);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };

  let worker;
  for (let i = 0; i < 50 && !worker; i += 1) {
    const { targetInfos } = await send("Target.getTargets");
    worker = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
    if (!worker) await sleep(200);
  }
  const settingsUrl = worker.url.replace(/background\.js$/, "settings.html");
  const { targetId: settingsTarget } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: workerSession } = await send("Target.attachToTarget", { targetId: settingsTarget, flatten: true });
  // Navigate after attaching; a URL passed to createTarget can still be loading on first evaluate.
  await send("Page.navigate", { url: settingsUrl }, workerSession);
  for (let i = 0; i < 50; i += 1) {
    await sleep(200);
    const { result } = await send("Runtime.evaluate",
      { expression: "typeof chrome?.storage?.local", returnByValue: true }, workerSession);
    if (result.value === "object") break;
  }

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: page } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, page);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, page);

  for (const shot of shots) {
    await evaluate(workerSession, `chrome.storage.local.set(${JSON.stringify({
      enabled: true, sourceLanguage: shot.language, showExamples: true, showGender: true
    })})`);
    await send("Page.navigate", { url: shot.url }, page);
    await sleep(4000);
    await evaluate(page, `(() => {
      // Hide fundraising, site notices, and article maintenance banners.
      const style = document.createElement("style");
      style.textContent = "#centralNotice, #siteNotice, .cn-fundraising, .frb, .bandeau-container, .ambox { display: none !important; }";
      document.head.appendChild(style);
      const words = ${JSON.stringify(shot.words)};
      const pattern = new RegExp("(^|[^\\\\p{L}])(" + words.join("|") + ")(?![\\\\p{L}])", "gu");
      window.__candidates = [];
      for (const paragraph of document.querySelectorAll("#mw-content-text p")) {
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());) {
          if (node.parentElement.closest("a, sup, b, i")) continue;
          for (const match of node.data.matchAll(pattern)) {
            const start = match.index + match[1].length;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + match[2].length);
            window.__candidates.push({ word: match[2], range });
          }
        }
      }
      return window.__candidates.length;
    })()`);
    let point = null;
    for (let index = 0; ; index += 1) {
      point = await evaluate(page, `(() => {
        const candidate = window.__candidates[${index}];
        if (!candidate) return null;
        let rect = candidate.range.getBoundingClientRect();
        // Keep the article title in view when the word is near the top.
        if (rect.top > 420 || rect.top < 120) window.scrollBy(0, rect.top - 300);
        rect = candidate.range.getBoundingClientRect();
        return { word: candidate.word, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (!point) break;
      await sleep(800);
      for (const clickCount of [1, 2]) {
        const base = { x: point.x, y: point.y, button: "left", clickCount };
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...base }, page);
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base }, page);
        await sleep(80);
      }
      // Move the pointer away so no hover state or tooltip appears in the capture.
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1270, y: 790 }, page);
      let state = "missing";
      for (let i = 0; i < 60 && state === "missing"; i += 1) {
        await sleep(250);
        state = await evaluate(page, `(() => {
          const popup = document.querySelector("#word-lookup-popup");
          if (!popup?.querySelector(".wl-link")) return "missing";
          return popup.scrollHeight > popup.clientHeight + 1 ? "clipped" : "ok";
        })()`);
      }
      // Gender and lemma definitions arrive after the first render; wait until the popup settles.
      let previous = "";
      for (let stable = 0, i = 0; stable < 6 && i < 60; i += 1) {
        await sleep(250);
        const html = await evaluate(page, `document.querySelector("#word-lookup-popup")?.innerHTML || ""`);
        stable = html === previous ? stable + 1 : 0;
        previous = html;
      }
      state = await evaluate(page, `(() => {
        const popup = document.querySelector("#word-lookup-popup");
        if (!popup?.querySelector(".wl-link")) return "missing";
        return popup.scrollHeight > popup.clientHeight + 1 ? "clipped" : "ok";
      })()`);
      if (state === "ok") break;
      console.error(`${shot.name}: skipped ${point.word} (${state})`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" }, page);
    }
    if (!point) {
      console.error(`${shot.name}: no usable word`);
      continue;
    }
    const { data } = await send("Page.captureScreenshot", { format: "png" }, page);
    const file = `${outDir}/${shot.name}.png`;
    writeFileSync(file, Buffer.from(data, "base64"));
    const title = await evaluate(page, `document.querySelector("#word-lookup-popup .wl-title").textContent`);
    console.log(`${file}: ${point.word} -> ${title}`);
  }
} finally {
  socket?.close();
  browser.kill();
}
