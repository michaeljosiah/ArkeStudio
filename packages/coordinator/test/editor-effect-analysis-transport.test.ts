import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EffectFeatureManifestSchema, effectAudioSourceFingerprintMaterial, effectManifestFingerprintMaterial, type EffectFeatureManifest } from "@arke-studio/contracts";
import { Coordinator } from "../src/coordinator.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { EFFECT_ANALYSIS_CACHE, effectAnalysisHash, saveEffectManifest } from "../src/productions/editor-effect-analysis-cache.js";
import { makeTempRoot, WORLD_ID } from "./world/helpers.js";

function manifest(): EffectFeatureManifest {
  const descriptor: EffectFeatureManifest["descriptor"] = { profileId: "audible-pcm-v1", binding: { kind: "composition-mix" }, frameRate: 24,
    startFrame: 0, endFrame: 2, selectedClipIds: [], placedWindows: [], audibleWindows: [], contributions: [], sources: [],
    mix: { speechFirst: true, duckingDb: -9, lookAheadMs: 80, releaseMs: 400, limiterCeilingDb: -1 }, speech: [],
    native: { profileId: "audible-pcm-v1", decoder: { versionConfigHash: "1".repeat(64), executableHash: "2".repeat(64) },
      canonical: { sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "dbl", limiterDelaySamples: 239,
        limiter: { attackMs: 5, releaseMs: 50, level: false, asc: false, latency: false, levelIn: 1, levelOut: 1, ceiling: 0.9 } },
      analysis: { sampleRate: 48000, channels: 2, sampleFormat: "f32le", monoPolicy: "duplicate-unity", resamplerProfile: "swr-v1" } } };
  const payload: Omit<EffectFeatureManifest, "manifestKey"> = { schemaVersion: 1, profileId: "audible-pcm-v1", descriptor,
    sourceFingerprint: effectAnalysisHash(effectAudioSourceFingerprintMaterial(descriptor)), pcmHash: "3".repeat(64),
    features: { startFrame: 0, endFrame: 2, beat: [0, 0], bass: [0, 0], energy: [0, 0] }, likelyBeats: [], silent: true };
  return EffectFeatureManifestSchema.parse({ ...payload, manifestKey: effectAnalysisHash(effectManifestFingerprintMaterial(payload)) });
}

test("the authenticated coordinator media route serves only exact current-world analysis manifests", async t => {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "logs/changes.jsonl"), appVersion: "test",
    transportAuth: { token: "a".repeat(64), allowedOrigins: ["http://localhost:5173"] } });
  t.after(() => coordinator.stop());
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore(); assert.ok(store);
  const value = manifest(), relative = `${EFFECT_ANALYSIS_CACHE}/${value.manifestKey}.json`;
  await saveEffectManifest(store, value, new Set());
  const arbitrary = "artifacts/private-record.json";
  await writeFile(join(worldDir, arbitrary), '{"private":"ordinary JSON is not media"}');
  // Even a real file at the requested other-world path cannot borrow the open world's route.
  const otherCache = join(root, "worlds/another-world", EFFECT_ANALYSIS_CACHE);
  await mkdir(otherCache, { recursive: true });
  await writeFile(join(otherCache, `${value.manifestKey}.json`), JSON.stringify(value));
  const { port, token } = await coordinator.start(0), base = `http://127.0.0.1:${port}/media/the-undersong/`;
  for (const suffix of ["", "?token=wrong"]) {
    const denied = await fetch(base + relative + suffix); assert.equal(denied.status, 401); await denied.text();
  }
  const authenticated = { headers: { Authorization: `Bearer ${token}`, Origin: "http://localhost:5173" } };
  const response = await fetch(base + relative, authenticated);
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), value);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
  const browser = await fetch(`${base}${relative}?token=${token}`);
  assert.equal(browser.status, 200); assert.deepEqual(await browser.json(), value);
  for (const path of [
    arbitrary, "productions/saltlight/timeline.json", ".cache/editor-effects/analysis/arbitrary.json",
    `${EFFECT_ANALYSIS_CACHE}/${value.sourceFingerprint}.ref`, `${EFFECT_ANALYSIS_CACHE}/${"f".repeat(64)}.json`,
    `${EFFECT_ANALYSIS_CACHE}/..%2f..%2f..%2fartifacts%2fprivate-record.json`,
    `${EFFECT_ANALYSIS_CACHE}/%2e%2e%5c%2e%2e%5c%2e%2e%5cartifacts%5cprivate-record.json`,
    `${EFFECT_ANALYSIS_CACHE}/${value.manifestKey}.json%00`,
  ]) {
    const denied = await fetch(base + path, authenticated); assert.equal(denied.status, 404, path); await denied.text();
  }
  const other = await fetch(`http://127.0.0.1:${port}/media/another-world/${relative}`, authenticated);
  assert.equal(other.status, 404); await other.text();
  await writeFile(join(worldDir, relative), JSON.stringify({ ...value, pcmHash: "4".repeat(64) }));
  const corrupt = await fetch(base + relative, authenticated); assert.equal(corrupt.status, 404); await corrupt.text();
});
