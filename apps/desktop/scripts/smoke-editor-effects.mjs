import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { defaultEffectClip } from "../../../packages/contracts/src/editor-effects.ts";
import { compositeRgba, renderEffectLayersRgba } from "../../../packages/contracts/src/editor-effect-raster.ts";

// Verifies the actual Vite worker under the built page's CSP and Electron's file-origin sandbox.
// No preload, coordinator, world, credentials or model calls are involved. This is a packaged
// worker check, not the manual/Arke UI acceptance pass. Run after building the client:
// node --import tsx apps/desktop/scripts/smoke-editor-effects.mjs
const require = createRequire(import.meta.url);
const dist = fileURLToPath(new URL("../../../packages/client/dist/", import.meta.url));
const builtHtml = await readFile(join(dist, "index.html"), "utf8");
const csp = builtHtml.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/)?.[0];
assert.ok(csp, "built client page must carry its CSP");
const workers = (await readdir(join(dist, "assets"))).filter(name => /^editor-effect-preview\.worker-[\w-]+\.js$/.test(name));
assert.equal(workers.length, 1, "build the client so exactly one effects worker is available");
const workerName = workers[0];
const workerSource = await readFile(join(dist, "assets", workerName));
const cases = ["dust", "embers", "snow", "lights", "rain", "smoke"].map((preset, index) => {
  const effect = defaultEffectClip({ id: "cl_fx", lineageId: "ef_fx", seed: 42, startFrame: 0, durationFrames: 240, preset });
  effect.appearance = { amount: 1, size: 1, opacity: 1, colour: "#ff0000" };
  const pixels = new Uint8ClampedArray(320 * 180 * 4);
  for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
  compositeRgba(pixels, renderEffectLayersRgba([effect], 120, 24, 320, 180));
  return { preset, expectedSha256: createHash("sha256").update(pixels).digest("hex"), request: {
    id: index + 1, generation: 7, absoluteFrame: 120, frameRate: 24, width: 320, height: 180, pictures: [], composition: [effect],
  } };
});
const directory = await mkdtemp(join(tmpdir(), "arke-editor-effects-desktop-"));
const verifyTemp = () => {
  const path = relative(resolve(tmpdir()), resolve(directory));
  if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Temporary effects smoke directory escaped its parent");
};
verifyTemp();
try {
  await copyFile(join(dist, "assets", workerName), join(directory, workerName));
  await writeFile(join(directory, "index.html"), `<!doctype html><html><head><meta charset="utf-8">${csp}<title>Effects worker sandbox smoke</title></head><body><script src="runner.js"></script></body></html>`);
  await writeFile(join(directory, "runner.js"), `
const cases = ${JSON.stringify(cases)};
const violations = [];
document.addEventListener("securitypolicyviolation", event => violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
window.runEffectsSmoke = async () => {
  if (location.protocol !== "file:" || typeof require !== "undefined" || typeof process !== "undefined") throw new Error("Expected a sandboxed file page without Node");
  const worker = new Worker(new URL(${JSON.stringify(workerName)}, location.href), { type: "module" });
  const results = [];
  try {
    for (const row of cases) {
      const started = performance.now();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error("Effect worker response timed out")); }, 10000);
        const cleanup = () => { clearTimeout(timer); worker.removeEventListener("message", message); worker.removeEventListener("error", error); };
        const message = event => { cleanup(); resolve(event.data); };
        const error = event => { cleanup(); reject(new Error(event.message || "Effect module worker failed under file CSP")); };
        worker.addEventListener("message", message); worker.addEventListener("error", error);
        worker.postMessage(row.request);
      });
      if (result.error) throw new Error(result.error);
      if (result.id !== row.request.id || result.generation !== 7 || result.absoluteFrame !== 120 || result.width !== 320 || result.height !== 180 || !(result.pixels instanceof Uint8ClampedArray) || result.pixels.byteLength !== 320*180*4) throw new Error("Invalid packaged worker response");
      const digest = await crypto.subtle.digest("SHA-256", result.pixels);
      const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2,"0")).join("");
      if (sha256 !== row.expectedSha256) throw new Error(row.preset + " differs from the Node RGBA raster");
      results.push({ preset: row.preset, sha256, differingBytes: 0, elapsedMs: performance.now() - started });
    }
    if (violations.length) throw new Error("CSP violations: " + JSON.stringify(violations));
    return { protocol: location.protocol, nodeAvailable: typeof require !== "undefined", violations, results };
  } finally { worker.terminate(); }
};
`);
  await writeFile(join(directory, "main.cjs"), `
const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
app.setPath("userData", join(__dirname, "profile"));
const timeout = setTimeout(() => { console.error("Effects desktop smoke timed out"); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on("render-process-gone", (_event, details) => { console.error(details); app.exit(1); });
  await window.loadFile(join(__dirname, "index.html"));
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
  const result = await window.webContents.executeJavaScript("window.runEffectsSmoke()");
  assert.equal(result.results.length, 6); assert.deepEqual(result.violations, []);
  await writeFile(join(__dirname, "result.json"), JSON.stringify({ platform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome, sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, ...result }, null, 2));
  window.destroy(); clearTimeout(timeout); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(directory, "main.cjs")], { stdio: "inherit", windowsHide: true, env });
  const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
  assert.equal(code, 0, "sandboxed file-page effects worker smoke failed");
  const result = { ...JSON.parse(await readFile(join(directory, "result.json"), "utf8")), worker: workerName,
    workerSha256: createHash("sha256").update(workerSource).digest("hex"), cspSha256: createHash("sha256").update(csp).digest("hex") };
  if (process.env.ARKE_EFFECT_SMOKE_REPORT) await writeFile(resolve(process.env.ARKE_EFFECT_SMOKE_REPORT), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ check: "sandboxed Electron file-page packaged effects worker", electron: result.electron, chromium: result.chromium, presets: result.results.length, differingBytes: 0, cspViolations: result.violations.length, worker: workerName }));
} finally {
  verifyTemp();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
