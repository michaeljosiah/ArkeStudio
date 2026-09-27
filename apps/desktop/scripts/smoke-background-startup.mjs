import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-background-startup-"));
const withinTemp = relative(tmpdir(), dir);
if (withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Smoke directory escaped its parent");
try {
  await build({ entryPoints: [join(root, "apps/desktop/src/startup.ts")], bundle: true,
    platform: "node", format: "cjs", outfile: join(dir, "startup.cjs") });
  await build({ stdin: { contents: 'import { initializeTheme } from "./packages/client/src/lib/theme.ts"; initializeTheme();', resolveDir: root },
    bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" }, outfile: join(dir, "renderer.js") });
  await writeFile(join(dir, "index.html"), '<!doctype html><html><head><script defer src="renderer.js"></script></head><body>Background startup</body></html>');
  await writeFile(join(dir, "main.cjs"), `(${electronMain.toString()})(${JSON.stringify(join(root, "apps/desktop/dist/preload.cjs"))}).catch(error => { console.error(error); require("electron").app.exit(1); });`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(dir, "main.cjs")], { stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true, env });
  let completed = false;
  child.on("message", message => { if (message === "complete") completed = true; });
  assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }), 0);
  assert.ok(completed, "Electron must finish every assertion before exiting");
} finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }

async function electronMain(preload) {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { join } = require("node:path");
  const assert = require("node:assert/strict");
  const { isBackgroundLogin, StartupWindowPresentation, StartupController, launchDesktop } = require("./startup.cjs");
  app.disableHardwareAcceleration(); app.setPath("userData", join(__dirname, "profile"));
  const timeout = setTimeout(() => { console.error("Background startup smoke timed out"); app.exit(1); }, 30000);
  await app.whenReady();
  app.on("window-all-closed", () => {});
  ipcMain.on("arke:get-theme", event => { event.returnValue = { preference: "system", resolved: "light" }; });
  for (const platform of ["win32", "darwin"]) {
    const background = isBackgroundLogin(platform, platform === "win32" ? ["--remote-background"] : [], { wasOpenedAtLogin: true });
    const window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    let shown = 0, painted = false, themed = false, initialized = false;
    window.on("show", () => { shown++; });
    const presentation = new StartupWindowPresentation(background, () => window.showInactive());
    const ready = () => { if (painted && themed) presentation.present(); };
    const themeReady = event => { if (event.sender === window.webContents) { themed = true; ready(); } };
    ipcMain.on("arke:theme-ready", themeReady);
    window.once("ready-to-show", () => { painted = true; ready(); });
    await window.loadFile(join(__dirname, "index.html"));
    await presentation.ready;
    const controller = new StartupController({ initialize: async () => { initialized = true; return { port: 1 }; },
      cleanup: async () => {}, publish: () => {}, report: error => { throw error; } });
    await launchDesktop(() => presentation.ready, controller);
    presentation.present(); // The readiness-timeout fallback must also remain hidden.
    assert.ok(initialized); assert.equal(shown, 0); assert.equal(window.isVisible(), false);
    const failure = new StartupController({ initialize: async () => { throw new Error("unavailable host"); },
      cleanup: async () => {}, publish: state => { if (state.status === "failed") presentation.reveal(); }, report: () => {} });
    await failure.run();
    assert.equal(shown, 1); assert.equal(window.isVisible(), true);
    ipcMain.off("arke:theme-ready", themeReady); window.destroy();
  }
  clearTimeout(timeout);
  console.log("[smoke] sandboxed file-page login startup stays hidden through first paint, fallback and host initialization; failures reveal recovery (Windows and macOS launch inputs)");
  process.send("complete");
  app.exit(0);
}
