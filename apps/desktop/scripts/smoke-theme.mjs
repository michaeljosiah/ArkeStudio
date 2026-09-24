import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";

// Exercise the real preload and theme bootstrap on a sandboxed file page, including the
// very first root stamp after reload. All native theme overrides belong to this test process.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-theme-"));
const withinTemp = relative(tmpdir(), dir);
if (withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Smoke directory escaped its parent");
try {
  await build({ entryPoints: [join(root, "apps/desktop/src/preload.ts")], bundle: true,
    platform: "node", format: "cjs", external: ["electron"], outfile: join(dir, "preload.cjs") });
  await build({ stdin: { contents: `import { initializeTheme, setThemePreference } from "./packages/client/src/lib/theme.ts";
    initializeTheme(); window.firstTheme = document.documentElement.dataset.theme; window.selectTheme = setThemePreference;`,
    resolveDir: root }, bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" }, outfile: join(dir, "renderer.js") });
  await writeFile(join(dir, "index.html"), '<!doctype html><html><head><script defer src="renderer.js"></script></head><body>Theme reload</body></html>');
  await writeFile(join(dir, "main.cjs"), `
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
app.disableHardwareAcceleration();
app.setPath("userData", join(__dirname, "profile"));
const timeout = setTimeout(() => { console.error("Theme smoke timed out"); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  nativeTheme.themeSource = "dark";
  let preference = "system";
  let window;
  const theme = () => ({ preference, resolved: preference === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : preference });
  ipcMain.on("arke:get-theme", event => { event.returnValue = event.sender === window?.webContents ? theme() : null; });
  ipcMain.on("arke:set-host-theme", (event, value) => { preference = value; event.sender.send("arke:theme-changed", theme()); });
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: join(__dirname, "preload.cjs"), additionalArguments: ["--arke-theme-preference=system", "--arke-resolved-theme=light"] } });
  const read = () => window.webContents.executeJavaScript('({ first: window.firstTheme, theme: document.documentElement.dataset.theme, dark: document.documentElement.classList.contains("dark"), scheme: document.documentElement.style.colorScheme, prefersDark: matchMedia("(prefers-color-scheme: dark)").matches })');
  const check = async expected => {
    assert.deepEqual(await read(), { first: expected, theme: expected, dark: expected === "dark", scheme: expected, prefersDark: true });
  };
  await window.loadFile(join(__dirname, "index.html"));
  await check("dark");
  // Choose Light against a dark system, then reload the SAME BrowserWindow. Startup arguments
  // remain stale; the private IPC snapshot must retain the live choice before first paint.
  await window.webContents.executeJavaScript('window.selectTheme("light")');
  await new Promise(resolve => { window.webContents.once("did-finish-load", resolve); window.reload(); });
  await check("light");
  await window.webContents.executeJavaScript('window.selectTheme("dark")');
  await new Promise(resolve => { window.webContents.once("did-finish-load", resolve); window.reload(); });
  await check("dark");
  // A live system update also survives reload, without changing the OS preference.
  preference = "system";
  nativeTheme.themeSource = "light";
  window.webContents.send("arke:theme-changed", theme());
  await new Promise(resolve => { window.webContents.once("did-finish-load", resolve); window.reload(); });
  assert.deepEqual(await read(), { first: "light", theme: "light", dark: false, scheme: "light", prefersDark: false });
  window.destroy(); clearTimeout(timeout);
  console.log("[smoke] system theme and explicit choices survive sandboxed file-page reload before first paint");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(dir, "main.cjs")], { stdio: "inherit", windowsHide: true, env });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, "sandboxed theme smoke failed");
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
