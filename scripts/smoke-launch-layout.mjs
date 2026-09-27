import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { parseHTML } from "linkedom";

// Render the real launch components and styles in Chromium at turn 158's viewports.
// Fixtures keep this visual gate away from the owner's data and provider runtimes.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-launch-layout-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].map(match => match[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(link =>
  link.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t158 style")].map(style => style.outerHTML).join("\n");
for (const [suffix, id] of [["a", "ls158a"], ["b", "ls158b"], ["c", "ls158c"], ["d", "ls158d"],
  ["e", "ls158e"], ["f", "ls158f"], ["g1", "ls158g1"], ["g2", "ls158g2"], ["g3", "ls158g3"],
  ["h", "ls158h"], ["i1", "ls158i1"], ["i2", "ls158i2"], ["i3", "ls158i3"], ["j", "pair158j"]]) {
  const frame = master.getElementById(id).outerHTML.replaceAll('src="assets/', 'src="/design/assets/');
  await writeFile(join(dir, "master-" + suffix + ".html"), '<!doctype html><html><head><meta charset="utf-8">' + masterLinks + masterStyles +
    '<style>body{margin:0}.ls158 .play,.ls158 .sb,.ls158 .hi{display:none!important}</style></head><body>' + frame + '</body></html>');
}
await build({
  stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router";
import { StartupScreen } from "./screens/launch";
import { RemoteEntry } from "./components/remote-entry";
import { PairingPrompt } from "./components/pairing-prompt";
import { __setBridgeForTest, __setStateForTest } from "./lib/store";
import { FIXTURE_STATE } from "../test/fixture-state";
${styles}
let renderer;
const settle = () => new Promise(resolve => setTimeout(resolve, 100));
window.mountLaunch = async (mode, desktop) => {
  renderer?.unmount();
  const state = structuredClone(FIXTURE_STATE);
  state.app.version = "0.5.53";
  if (mode === "setup") {
    state.app.health.harness = { status: "starting" };
    state.app.health.voice = { status: "starting" };
    state.app.setup = { running: true, diskFreeMb: 100000, diskCheckedAt: null, components: [{
      id: "voxa-kokoro", displayName: "Voxa", state: "downloading", purpose: "", sizeMb: 3100,
      installLocation: "", bytesDone: 1.8 * 1024 ** 3, bytesTotal: 3.1 * 1024 ** 3,
      bytesPerSecond: 12.4 * 1024 ** 2, pauseSupported: true
    }] };
  }
  const bridge = { connect() {}, send() {}, subscribe() {},
    startupState: () => mode === "failure" ? { status: "failed", detail: "port 8791 is already in use" } : null,
    remoteAccess: async () => ({ status: { enabled: true, running: true, pairingDuration: 90, devices: [],
      pending: [{ id: "3f1c6a2e-8b1d-4c5e-9f0a-1b2c3d4e5f60", name: "Pixel 9", expiresAt: Date.now() + 252000 }] } })
  };
  if (desktop) window.arke = bridge; else delete window.arke;
  __setBridgeForTest(bridge);
  __setStateForTest(state, { connection: mode === "connecting" ? "connecting" : mode === "offline" ? "closed" : mode === "expired" ? "auth-refused" : "open" });
  Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { getHighEntropyValues: async () => ({ model: "Pixel 9" }) } });
  window.fetch = async path => new Response(null, { status: path === "/remote/session" ? 401 : mode === "pending" ? 202 : 410 });
  renderer = createRoot(document.getElementById("root"));
  flushSync(() => renderer.render(<MemoryRouter initialEntries={[mode === "setup" || mode === "connecting" ? "/starting" : "/"]}>
    {mode === "pair" || mode === "typing" || mode === "pending" ? <RemoteEntry><div /></RemoteEntry> : <StartupScreen />}
    {mode === "approval" && <PairingPrompt />}
  </MemoryRouter>));
  await settle(); await document.fonts.ready; await settle();
  if (mode === "typing") {
    const input = document.querySelector("input");
    input.focus(); input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await settle();
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
window.measureLaunch = () => {
  const bounds = selector => { const e = document.querySelector(selector); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  return { viewport: [innerWidth, innerHeight], className: document.querySelector(".fy-launch").className,
    active: document.activeElement?.tagName, art: bounds(".fy-launch__art"), mark: bounds(".fy-launch__mark"),
    hello: bounds(".fy-launch__hello"), ways: bounds(".fy-launch__ways"), setup: bounds(".fy-launch__setup"),
    foot: bounds(".fy-launch__foot"), direction: getComputedStyle(document.querySelector(".fy-launch__ways") ?? document.querySelector(".fy-launch")).flexDirection,
    overflow: document.documentElement.scrollWidth > innerWidth,
    targets: [...document.querySelectorAll(".fy-launch button:not(:disabled), .fy-launch input")].filter(e => e.getBoundingClientRect().width).map(e => ({
      text: e.textContent || e.placeholder, height: Math.max(e.getBoundingClientRect().height, parseFloat(getComputedStyle(e, "::after").height) || 0)
    }))
  };
};
` },
  bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" },
  // Desktop Chromium has no mobile safe-area override. Substitute only env() inputs in this
  // fixture bundle so the reference's 20px home-indicator inset is represented faithfully.
  plugins: [{ name: "fixture-safe-area", setup(build) {
    build.onLoad({ filter: /\.css$/ }, async ({ path }) => ({ loader: "css", resolveDir: fileURLToPath(new URL(".", pathToFileURL(path))),
      contents: (await readFile(path, "utf8")).replace(/env\(safe-area-inset-(\w+)(?:,\s*0px)?\)/g, "var(--smoke-safe-$1, 0px)") }));
  } }],
  loader: { ".woff": "file", ".woff2": "file" }, outfile: join(dir, "view.js"),
});
await copyFile(join(root, "packages/client/public/launch-harbour.webp"), join(dir, "launch-harbour.webp"));
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
await writeFile(join(dir, "main.cjs"), `(${electronMain.toString()})().catch(error => { console.error(error); require("electron").app.exit(1); });`);
const child = spawn(require("electron"), [join(dir, "main.cjs")], { windowsHide: true, stdio: "inherit",
  env: { ...process.env, ARKE_LAUNCH_DESIGN: join(root, "design-system") } });
assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }), 0);
console.log("Launch layout screenshots and measurements: " + dir);

async function electronMain() {
  const { app, BrowserWindow, protocol, net } = require("electron");
  const { join } = require("node:path");
  const { pathToFileURL } = require("node:url");
  const { writeFile } = require("node:fs/promises");
  const assert = require("node:assert/strict");
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.setPath("userData", join(__dirname, "profile"));
  const timeout = setTimeout(() => app.exit(1), 120000);
  await app.whenReady();
  protocol.handle("https", request => {
    const path = new URL(request.url).pathname;
    return net.fetch(pathToFileURL(path.startsWith("/design/") ? join(process.env.ARKE_LAUNCH_DESIGN, path.slice(8)) :
      join(__dirname, path === "/" ? "index.html" : path.slice(1))).href);
  });
  const window = new BrowserWindow({ show: false, useContentSize: true, width: 1360, height: 850,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL("https://michael-desktop.test/");
  const records = [];
  let previousImage;
  for (const [name, width, height, mode, desktop] of [
    ["158a-desktop", 1360, 850, "ready", true], ["158b-fold7", 984, 1092, "ready", true],
    ["158c-phone", 390, 844, "ready", false], ["phone-small", 375, 812, "ready", false],
    ["158d-smallest-window", 1024, 640, "ready", true], ["fold7-landscape", 1092, 984, "ready", true],
    ["158e-setup-desktop", 1360, 850, "setup", true], ["158f-setup-fold7", 984, 1092, "setup", true],
    ["158g-connecting", 390, 844, "connecting", false], ["158g-offline", 390, 844, "offline", false],
    ["158g-expired", 390, 844, "expired", false], ["158h-studio-failed", 1360, 850, "failure", true],
    ["158i-pair", 390, 844, "pair", false], ["158i-typing", 390, 544, "typing", false],
    ["158i-pending", 390, 844, "pending", false], ["158j-approval", 1360, 850, "approval", true],
  ]) {
    window.setContentSize(width, height);
    const stacked = width < 900 || width / height < 1.2;
    await window.webContents.executeJavaScript(`document.documentElement.style.setProperty("--smoke-safe-top", "${stacked ? width < 600 ? 47 : 32 : 0}px");
      document.documentElement.style.setProperty("--smoke-safe-bottom", "${stacked ? 20 : 0}px");`);
    window.webContents.focus();
    await window.webContents.executeJavaScript(`window.mountLaunch(${JSON.stringify(mode)}, ${desktop})`, true);
    const measured = await window.webContents.executeJavaScript("window.measureLaunch()");
    assert.equal(measured.overflow, false, name + " sideways overflow");
    if (mode === "typing") assert.ok(measured.className.includes("fy-launch--typing"), JSON.stringify(measured));
    for (const target of measured.targets) assert.ok(target.height >= 48, name + " touch target: " + JSON.stringify(target));
    records.push({ name, ...measured });
    window.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 100));
    let screenshot = (await window.webContents.capturePage()).toPNG();
    if (previousImage?.equals(screenshot)) {
      await new Promise(resolve => setTimeout(resolve, 500));
      screenshot = (await window.webContents.capturePage()).toPNG();
      assert.ok(!previousImage.equals(screenshot), name + " compositor retained the previous frame");
    }
    previousImage = screenshot;
    await writeFile(join(__dirname, name + ".png"), screenshot);
  }
  await writeFile(join(__dirname, "measurements.json"), JSON.stringify(records, null, 2));
  for (const [suffix, width, height] of [["a",1360,850],["b",984,1092],["c",390,844],["d",1024,640],["e",1360,850],["f",984,1092],
    ["g1",390,844],["g2",390,844],["g3",390,844],["h",1360,850],["i1",390,844],["i2",390,844],["i3",390,844],["j",1360,850]]) {
    window.setContentSize(width, height);
    await window.loadURL("https://michael-desktop.test/master-" + suffix + ".html");
    await window.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(resolve => setTimeout(resolve, 100)))");
    await writeFile(join(__dirname, "master-" + suffix + ".png"), (await window.webContents.capturePage()).toPNG());
    const bounds = await window.webContents.executeJavaScript(`Object.fromEntries(["art","pane","wm","hello","ways","way","setup","once","foot"].map(c => { const e=document.querySelector("."+c);const b=e?.getBoundingClientRect();return [c, b && {x:b.x,y:b.y,width:b.width,height:b.height,font:getComputedStyle(e).font}]; }))`);
    await writeFile(join(__dirname, "master-" + suffix + ".json"), JSON.stringify(bounds, null, 2));
  }
  clearTimeout(timeout); window.destroy(); app.exit(0);
}
