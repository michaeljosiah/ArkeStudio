import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// A DOM shim cannot catch a flex column collapsing or a selection press covering real text.
// Render the actual chapter with fixture data in Chromium, without opening a user's world.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-chapter-layout-"));
const withinTemp = relative(tmpdir(), dir);
if (withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Smoke directory escaped its parent");
try {
  await build({
    stdin: { contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router";
import { ChapterScreen } from "./src/screens/chapter-workspace";
import { ProductionHomeScreen } from "./src/screens/production-dashboard";
import { __setBridgeForTest, __setStateForTest, __applyEventForTest } from "./src/lib/store";
import { FIXTURE_STATE } from "./test/fixture-state";
import "@fontsource/geist-sans/400.css";
import "./src/theme/tokens/colors.css";
import "./src/theme/tokens/typography.css";
import "./src/theme/tokens/spacing.css";
import "./src/theme/tokens/effects.css";
import "./src/theme/globals.css";
import "./src/components/ui.css";
import "./src/components/layout.css";
import "./src/components/editor/editor.css";
import "./src/domain/domain.css";
import "./src/screens/screens.css";
import "./src/screens/fidelity.css";

const check = (condition, message) => { if (!condition) throw new Error(message); };
const settle = () => new Promise(resolve => setTimeout(resolve, 100));
const text = "The ledger lay open beneath the lamp. Wren listened to the bells beyond the window.";
const sent = [];
let body = text;
__setBridgeForTest({ connect() {}, subscribe() {}, send(json) {
  const message = JSON.parse(json);
  sent.push(message);
  if (message.kind === "open-chapter") setTimeout(() => __applyEventForTest({
    at: "2026-09-24T12:00:00Z", type: "chapter.open-result", requestId: message.requestId,
    worldId: message.worldId, productionId: "saltlight", chapterId: "neap",
    disposition: "opened", body, version: 4, hash: "sha256:" + "a".repeat(64), versions: [1, 2, 3],
  }), 0);
} });
const chapter = { id: "neap", file: "01-neap", order: 1, title: "The ledger", status: "drafted",
  version: 4, words: 73, synopsis: "Wren listens for the bell.",
  implies: [{ id: "debt", kind: "canon", what: "The city owes a debt.", state: "open" }] };
let renderer;
window.mountSmoke = async (mode = "rich", kind) => {
  renderer?.unmount();
  const state = structuredClone(FIXTURE_STATE);
  const production = state.world.productions.find(p => p.meta.id === "saltlight");
  production.meta = { ...production.meta, format: kind ? "video" : "story", medium: kind ? "video" : "story", kind: kind ?? "novel" };
  production.story = { version: 1, targetLength: "80,000 words" };
  production.chapters = [chapter];
  body = mode === "source" ? text + "\\n\\n<br>" : text;
  if (kind) production.meta.models = { video: "retired-model" };
  __setStateForTest(state, { connection: "open" });
  const base = "/w/" + state.world.meta.worldId + "/p/saltlight";
  renderer = createRoot(document.getElementById("root"));
  renderer.render(<MemoryRouter initialEntries={[kind ? base : base + "/story/chapters/neap"]}>
    <Routes><Route path="/w/:worldId/p/:prodId" element={<ProductionHomeScreen />} />
    <Route path="/w/:worldId/p/:prodId/story/chapters/:chapterId" element={<ChapterScreen />} /></Routes>
  </MemoryRouter>);
  await settle(); await settle();
};
window.checkChapter = async mode => {
  const column = document.querySelector(".fy-ch__manuscript:not([hidden])");
  const editor = document.querySelector(mode === "source" ? ".fy-ch__source" : ".fy-ch__prose");
  check(editor, "chapter editor mounted");
  const height = editor.getBoundingClientRect().height;
  check(height >= 250, "manuscript has readable height: " + height);
  const frame = document.querySelector(".fy-ch__body");
  const side = document.querySelector(".fy-ch__side");
  if (getComputedStyle(frame).flexDirection === "column") {
    check(side.getBoundingClientRect().top >= column.getBoundingClientRect().bottom, "cards follow manuscript");
    frame.scrollTop = frame.scrollHeight;
    check(side.getBoundingClientRect().bottom <= frame.getBoundingClientRect().bottom + 1, "last side card is reachable");
    frame.scrollTop = 0;
  }
  if (mode === "source") {
    editor.focus(); editor.setSelectionRange(0, 36);
    editor.dispatchEvent(new Event("select", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
    await settle();
    const press = document.querySelector(".fy-ch__ask");
    check(press, "source selection offers Ask Arke");
    const rect = press.getBoundingClientRect();
    check(rect.left >= editor.getBoundingClientRect().right, "Ask Arke stays outside source text");
    check(rect.right <= column.getBoundingClientRect().right, "Ask Arke fits inside manuscript");
    press.click(); await settle();
    const menu = document.querySelector('[role="menu"]');
    check(menu && menu.getBoundingClientRect().right <= column.getBoundingClientRect().right, "selection menu fits");
  }
  check(document.querySelector('.fy-sw').dataset.dock === "true", "checked with the Arke dock open");
  return { mode, editorHeight: height, manuscript: column.getBoundingClientRect().height, viewport: [innerWidth, innerHeight] };
};
window.checkModels = async () => {
  const card = document.querySelector('[data-testid="models-card"]');
  check(card, "episodic Models card is mounted");
  check(card.textContent.includes("not in the manifest"), "stranded choice stays visible");
  card.querySelector('[aria-label="Use the default"]').click();
  await settle();
  const reset = sent.findLast(message => message.kind === "set-production-model");
  check(reset?.productionId === "saltlight" && reset.capability === "video" && reset.modelId === null, "reset clears this production's choice");
};
`, resolveDir: join(root, "packages/client"), loader: "tsx" },
    bundle: true, outfile: join(dir, "app.js"), platform: "browser", format: "iife",
    jsx: "automatic", loader: { ".woff": "dataurl", ".woff2": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  });
  await writeFile(join(dir, "index.html"), '<!doctype html><link rel="stylesheet" href="app.css"><style>#root{height:calc(100vh - 80px);margin-top:80px}</style><div id="root"></div><script src="app.js"></script>');
  await writeFile(join(dir, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
app.disableHardwareAcceleration();
app.setPath("userData", join(__dirname, "profile"));
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, useContentSize: true, width: 1200, height: 791,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadFile(join(__dirname, "index.html"));
  for (const [width, height] of [[1200,791], [1200,900], [1200,950], [1440,900], [1600,1000], [850,791]]) {
    window.setContentSize(width, height);
    await new Promise(resolve => setTimeout(resolve, 200));
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    for (const mode of ["rich", "source"]) {
      await window.webContents.executeJavaScript('mountSmoke(' + JSON.stringify(mode) + ')');
      const result = await window.webContents.executeJavaScript('checkChapter(' + JSON.stringify(mode) + ')');
      console.log(JSON.stringify({ width, height, ...result }));
      if (process.env.ARKE_LAYOUT_SCREENSHOT && width === 1200 && height === 791 && mode === "source") {
        await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        writeFileSync(process.env.ARKE_LAYOUT_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
      }
    }
  }
  for (const kind of ["series", "microdrama"]) {
    await window.webContents.executeJavaScript('mountSmoke("rich", ' + JSON.stringify(kind) + ')');
    await window.webContents.executeJavaScript('checkModels()');
    console.log(kind + ": Models reset passed");
  }
  clearTimeout(deadline);
  window.destroy();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`);
  const code = await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [join(dir, "main.cjs")], { env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Chapter layout smoke exited ${code}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
