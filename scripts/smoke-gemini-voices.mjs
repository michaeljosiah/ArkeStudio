import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { SHIPPED_MANIFEST } from "../packages/providers/src/manifest-data.ts";

// Real picker components/styles, scripted catalogue: opening these never calls a provider.
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-gemini-voices-"));
const styles = [...(await readFile(join(root, "packages/client/src/main.tsx"), "utf8")).matchAll(/^import "([^\"]+\.css)";/gm)].map(m => m[0]).join("\n");
await build({ stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router";
import { VoicePickerDialog } from "./components/voice-picker";
import { NarratorDialog } from "./screens/audiobook-narrator";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "./lib/store";
import { FIXTURE_STATE } from "../test/fixture-state";
const SHIPPED_MANIFEST = ${JSON.stringify(SHIPPED_MANIFEST)};
${styles}
const voices = [
 { provider: "elevenlabs", model: "eleven-v3", voiceId: "old", label: "Existing voice", local: false },
 { provider: "google", model: "gemini-3.8-flash-tts", voiceId: "Charon", label: "Charon", local: false },
 { provider: "google", model: "gemini-3.8-flash-lite-tts", voiceId: "Charon", label: "Charon", local: false },
 { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", label: "George", local: true }
].map(v => ({ ...v, attributes: [], canClone: false, usedBy: [] }));
let renderer;
window.mountPicker = async mode => {
 renderer?.unmount(); window.sent = [];
 __setBridgeForTest({ send: json => window.sent.push(JSON.parse(json)) });
 __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, manifest: SHIPPED_MANIFEST } });
 renderer = createRoot(document.getElementById("root"));
 flushSync(() => renderer.render(<MemoryRouter>{mode === "book"
 ? <NarratorDialog worldId={FIXTURE_STATE.world.meta.worldId} productionId="saltlight" narratorLabel="Existing voice" appLabel="George" bookNarrator={voices[0]} trial={null} data="" onClose={() => {}} />
 : <VoicePickerDialog open use="narration" chosenId="old" chosenProvider="elevenlabs" chosenModel="eleven-v3" onClose={() => {}} onPick={() => {}} />}</MemoryRouter>));
 flushSync(() => __applyEventForTest({ type: "voice.catalogue", at: "2026-09-27T12:00:00Z", voices }));
 await document.fonts.ready;
 await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};` }, bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" },
  loader: { ".woff": "file", ".woff2": "file" }, outfile: join(dir, "view.js") });
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
await writeFile(join(dir, "main.cjs"), `(${electronMain.toString()})().catch(error => { console.error(error); require("electron").app.exit(1); });`);
const child = spawn(createRequire(import.meta.url)("electron"), [join(dir, "main.cjs")], { windowsHide: true, stdio: "inherit" });
assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }), 0);
console.log("Gemini picker screenshots: " + dir);

async function electronMain() {
  const { app, BrowserWindow } = require("electron");
  const { join } = require("node:path");
  const { writeFile } = require("node:fs/promises");
  const assert = require("node:assert/strict");
  app.disableHardwareAcceleration(); app.setPath("userData", join(__dirname, "profile"));
  const timeout = setTimeout(() => app.exit(1), 60000);
  await app.whenReady();
  const window = new BrowserWindow({ show: false, useContentSize: true, width: 1200, height: 790,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  await window.loadFile(join(__dirname, "index.html"));
  for (const [width, height] of [[1200, 790], [1024, 640]]) {
    window.setContentSize(width, height);
    for (const mode of ["book", "routine"]) {
      await window.webContents.executeJavaScript(`window.mountPicker(${JSON.stringify(mode)})`);
      const state = await window.webContents.executeJavaScript(`({ text: document.body.innerText, sent: window.sent,
        selected: document.querySelector('[aria-selected="true"], .fy-voices__row--on')?.textContent,
        nameWidths: [...document.querySelectorAll('.fy-abnarr__who')].map(e => e.getBoundingClientRect().width),
        overflow: document.documentElement.scrollWidth > innerWidth })`);
      assert.match(state.text, mode === "book" ? /Gemini Flash · Recommended/ : /Gemini Flash-Lite · Recommended/);
      assert.match(state.selected, /Existing voice/);
      assert.equal(state.overflow, false);
      assert.ok(state.nameWidths.every(width => width > 120), "price copy must leave room for the voice identity");
      assert.ok(state.sent.every(message => message.kind === "voice-catalogue"));
      await writeFile(join(__dirname, `${mode}-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  clearTimeout(timeout); window.destroy(); app.quit();
}
