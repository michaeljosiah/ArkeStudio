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
import { EffectFeatureManifestSchema, effectAudioSourceFingerprintMaterial, effectManifestFingerprintMaterial } from "../../../packages/contracts/src/editor-effect-analysis.ts";
import { prepareEffectReactions } from "../../../packages/contracts/src/editor-effect-reaction.ts";

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
const sha = value => createHash("sha256").update(value).digest("hex");
function reactionFixture() {
  const manifestsByKey = {}, manifestKeyByEffectId = {}, effects = [];
  for (const [index, preset] of ["dust", "embers"].entries()) {
    const binding = index === 0 ? { kind: "audio-track", trackId: "tr_song" } : { kind: "video-sound", clipId: "cl_video" };
    const descriptor = { profileId: "audible-pcm-v1", binding, frameRate: 24, startFrame: 0, endFrame: 480,
      selectedClipIds: [index === 0 ? "cl_song" : "cl_video"], placedWindows: [{ startSec: 0, endSec: 20 }], audibleWindows: [{ startSec: 0, endSec: 20 }],
      contributions: [], sources: [], mix: { speechFirst: true, duckingDb: -9, lookAheadMs: 80, releaseMs: 400, limiterCeilingDb: -1 }, speech: [],
      native: { profileId: "audible-pcm-v1", decoder: { versionConfigHash: sha("version"), executableHash: sha("decoder") },
        canonical: { sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "dbl", limiterDelaySamples: 239,
          limiter: { attackMs: 5, releaseMs: 50, level: false, asc: false, latency: false, levelIn: 1, levelOut: 1, ceiling: 0.9 } },
        analysis: { sampleRate: 48000, channels: 2, sampleFormat: "f32le", monoPolicy: "duplicate-unity", resamplerProfile: "swr-v1" } } };
    const signal = Array.from({ length: 480 }, (_, frame) => index === 0 ? Math.round((0.5 + 0.4 * Math.sin(frame / 17)) * 10000) / 10000 : frame % 43 < 17 ? 0.85 : 0.15);
    const payload = { schemaVersion: 1, profileId: "audible-pcm-v1", descriptor, sourceFingerprint: sha(effectAudioSourceFingerprintMaterial(descriptor)), pcmHash: sha(`signal-${index}`),
      features: { startFrame: 0, endFrame: 480, beat: signal.map((value, frame) => frame % 24 === 0 ? value : 0), bass: signal, energy: signal }, likelyBeats: [], silent: false };
    const manifest = EffectFeatureManifestSchema.parse({ ...payload, manifestKey: sha(effectManifestFingerprintMaterial(payload)) });
    const effect = defaultEffectClip({ id: `cl_reaction_${index}`, lineageId: `ef_reaction_${index}`, seed: 42 + index, startFrame: 48, durationFrames: 360, preset });
    effect.simulationOriginFrame = -24; effect.audioInput = binding; effect.motion.speed = 0.1 + index * 0.1;
    effect.appearance = { amount: 0.9, size: 0.65, opacity: 0.9, colour: index === 0 ? "#ff8040" : "#4080ff" };
    effect.reaction = { ...effect.reaction, enabled: true, preset: "custom", strength: 0.9, beat: 0, bass: index, energy: 1 - index, property: "speed", limit: 0.7, smoothingFrames: 11 - index * 6 };
    manifestsByKey[manifest.manifestKey] = manifest; manifestKeyByEffectId[effect.id] = manifest.manifestKey; effects.push(effect);
  }
  return { effects, sources: { manifestsByKey, manifestKeyByEffectId }, startFrame: 120, endFrame: 360 };
}
const reactive = reactionFixture();
const prepared = prepareEffectReactions(reactive.effects, reactive.sources.manifestsByKey, reactive.sources.manifestKeyByEffectId, reactive);
const reactivePixels = (frame, preparedMap = prepared) => {
  const pixels = new Uint8ClampedArray(320 * 180 * 4); for (let at = 3; at < pixels.length; at += 4) pixels[at] = 255;
  return compositeRgba(pixels, renderEffectLayersRgba(reactive.effects, frame, 24, 320, 180, preparedMap));
};
const install = { kind: "analysis", analysisEpoch: 7, effects: reactive.effects, startFrame: reactive.startFrame, endFrame: reactive.endFrame, ...reactive.sources };
for (const [index, absoluteFrame] of [240, 241, 173, 240, 359].entries()) {
  const pixels = reactivePixels(absoluteFrame);
  assert.notDeepEqual(pixels, reactivePixels(absoluteFrame, {}), "reactive fixture must differ from base atmosphere");
  cases.push({ preset: "two-bound-speed-reactions", expectedSha256: sha(pixels), ...(index === 0 ? { install } : {}), request: {
    id: 10 + index, generation: 7, absoluteFrame, frameRate: 24, width: 320, height: 180, pictures: [], composition: reactive.effects, analysisEpoch: 7,
  } });
}
const baseRequest = { id: 20, generation: 7, absoluteFrame: 240, frameRate: 24, width: 320, height: 180, pictures: [], composition: reactive.effects, analysisEpoch: 7 };
cases.push({ preset: "obsolete-analysis-epoch", expectedError: "obsolete analysis", install: { ...install, analysisEpoch: 8, manifestsByKey: {}, manifestKeyByEffectId: {} }, request: baseRequest });
cases.push({ preset: "cleared-analysis-base", expectedSha256: sha(reactivePixels(240, {})), request: { ...baseRequest, id: 21, analysisEpoch: 8 } });
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
  const ask = request => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Effect worker response timed out")); }, 10000);
    const cleanup = () => { clearTimeout(timer); worker.removeEventListener("message", message); worker.removeEventListener("error", error); };
    const message = event => { cleanup(); resolve(event.data); };
    const error = event => { cleanup(); reject(new Error(event.message || "Effect module worker failed under file CSP")); };
    worker.addEventListener("message", message); worker.addEventListener("error", error);
    worker.postMessage(request, []);
  });
  try {
    for (const row of cases) {
      const started = performance.now();
      if (row.install) {
        const installed = await ask(row.install);
        if (installed.kind !== "analysis-ready" || installed.analysisEpoch !== row.install.analysisEpoch || installed.error) throw new Error("Packaged reaction installation failed: " + JSON.stringify(installed));
      }
      const result = await ask(row.request);
      if (row.expectedError) {
        if (!result.error?.includes(row.expectedError) || result.analysisEpoch !== row.request.analysisEpoch || result.id !== row.request.id) throw new Error("An obsolete packaged reaction epoch was accepted");
        results.push({ preset: row.preset, epoch: result.analysisEpoch, staleEpochRejected: true }); continue;
      }
      if (result.error) throw new Error(result.error);
      if (result.id !== row.request.id || result.generation !== 7 || result.absoluteFrame !== row.request.absoluteFrame || result.analysisEpoch !== row.request.analysisEpoch || result.width !== 320 || result.height !== 180 || !(result.pixels instanceof Uint8ClampedArray) || result.pixels.byteLength !== 320*180*4) throw new Error("Invalid packaged worker response");
      const digest = await crypto.subtle.digest("SHA-256", result.pixels);
      const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2,"0")).join("");
      if (sha256 !== row.expectedSha256) throw new Error(row.preset + " differs from the Node RGBA raster");
      results.push({ preset: row.preset, frame: result.absoluteFrame, epoch: result.analysisEpoch ?? 0, sha256, differingBytes: 0, elapsedMs: performance.now() - started });
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
  assert.equal(result.results.length, 13); assert.deepEqual(result.violations, []);
  assert.equal(result.results.filter(row => row.preset === "two-bound-speed-reactions").length, 5);
  assert.ok(result.results.some(row => row.staleEpochRejected));
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
  console.log(JSON.stringify({ check: "sandboxed Electron file-page packaged effects worker", electron: result.electron, chromium: result.chromium, cases: result.results.length, reactingFrames: 5, staleEpochRejected: true, differingBytes: 0, cspViolations: result.violations.length, worker: workerName }));
} finally {
  verifyTemp();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
