import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EFFECT_ANALYSIS_PROFILE, effectManifestFingerprintMaterial } from "@arke-studio/contracts";
import { EFFECT_ANALYSIS_CACHE, cachedEffectManifest, effectAnalysisHash, readEffectManifest, saveEffectManifest } from "../../src/productions/editor-effect-analysis-cache.js";
import { WorldStore } from "../../src/world/store.js";
import { analysisFixture } from "../media/effect-analysis-fixture.js";
import { closeOnCleanup, tempDir } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";

async function world() {
  const store = await WorldStore.open(await makeTempWorld());
  closeOnCleanup(() => store.close());
  return store;
}
const cachePath = (store: WorldStore, name: string) => join(store.dir, EFFECT_ANALYSIS_CACHE, name);

test("exact content-addressed cache reuse leaves authored state and cache file identity unchanged", async () => {
  const store = await world(), manifest = analysisFixture();
  const state = store.getBundle(), journal = await readFile(join(store.dir, "changes.jsonl"), "utf8");
  await saveEffectManifest(store, manifest, new Set());
  const path = cachePath(store, `${manifest.manifestKey}.json`), before = await lstat(path);
  assert.deepEqual(await readEffectManifest(store, manifest.manifestKey), manifest);
  assert.deepEqual(await cachedEffectManifest(store, manifest.sourceFingerprint), manifest);
  await saveEffectManifest(store, manifest, new Set([manifest.manifestKey]));
  const after = await lstat(path);
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual((await readdir(cachePath(store, ""))).sort(), [`${manifest.manifestKey}.json`, `${manifest.sourceFingerprint}.ref`].sort());
  assert.equal(await readFile(join(store.dir, "changes.jsonl"), "utf8"), journal);
  assert.deepEqual(store.getBundle(), state);
  await store.close();
  assert.equal(await readEffectManifest(store, manifest.manifestKey), null);
});

test("cache reads reject truncated, unknown, hash-tampered and oversized manifest bytes", async () => {
  const store = await world(), manifest = analysisFixture();
  await saveEffectManifest(store, manifest, new Set());
  const path = cachePath(store, `${manifest.manifestKey}.json`);
  const changed = structuredClone(manifest); changed.features.energy[0] = 0.9;
  for (const bytes of ["{", JSON.stringify({ ...manifest, future: true }), JSON.stringify(changed),
    `${JSON.stringify(manifest)}${" ".repeat(EFFECT_ANALYSIS_PROFILE.maxManifestBytes)}`]) {
    await writeFile(path, bytes);
    assert.equal(await readEffectManifest(store, manifest.manifestKey), null);
    assert.equal(await cachedEffectManifest(store, manifest.sourceFingerprint), null);
  }
  const forged = structuredClone(manifest); forged.sourceFingerprint = "1".repeat(64);
  forged.manifestKey = effectAnalysisHash(effectManifestFingerprintMaterial(forged));
  await writeFile(cachePath(store, `${forged.manifestKey}.json`), JSON.stringify(forged));
  assert.equal(await readEffectManifest(store, forged.manifestKey), null);
  assert.equal(await readEffectManifest(store, "../outside"), null);
});

test("cache refuses invalid manifest and source identities before creating a lookup reference", async () => {
  const store = await world(), manifest = analysisFixture();
  const wrongKey = { ...manifest, manifestKey: "1".repeat(64) };
  await assert.rejects(saveEffectManifest(store, wrongKey, new Set()), /identity/);
  const wrongSource = { ...manifest, sourceFingerprint: "2".repeat(64) };
  wrongSource.manifestKey = effectAnalysisHash(effectManifestFingerprintMaterial(wrongSource));
  await assert.rejects(saveEffectManifest(store, wrongSource, new Set()), /identity|source/i);
  assert.equal(await cachedEffectManifest(store, wrongSource.sourceFingerprint), null);
});

test("malformed, oversized, missing and other-source lookup references are cache misses", async () => {
  const store = await world(), manifest = analysisFixture();
  const other = analysisFixture({ binding: { kind: "audio-clip", clipId: "cl_other" } });
  await saveEffectManifest(store, manifest, new Set());
  await saveEffectManifest(store, other, new Set());
  const ref = cachePath(store, `${manifest.sourceFingerprint}.ref`);
  for (const content of ["../outside", `${manifest.manifestKey}\n`, "z".repeat(64), "0".repeat(64), other.manifestKey]) {
    await writeFile(ref, content);
    assert.equal(await cachedEffectManifest(store, manifest.sourceFingerprint), null);
  }
  assert.equal(await cachedEffectManifest(store, "../outside"), null);
});

test("redirected cache paths cannot read, replace or prune external files", async () => {
  const store = await world(), manifest = analysisFixture(), outside = await tempDir("arke-effect-analysis-outside-");
  const external = join(outside, "editor-effects", "analysis");
  await mkdir(external, { recursive: true });
  const marker = join(external, `${manifest.manifestKey}.json`), bytes = JSON.stringify(manifest);
  await writeFile(marker, bytes);
  await writeFile(join(external, `${manifest.sourceFingerprint}.ref`), manifest.manifestKey);
  await symlink(outside, join(store.dir, ".cache"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await readEffectManifest(store, manifest.manifestKey), null);
  assert.equal(await cachedEffectManifest(store, manifest.sourceFingerprint), null);
  await assert.rejects(saveEffectManifest(store, manifest, new Set()), /path-invalid/);
  assert.equal(await readFile(marker, "utf8"), bytes);
  assert.equal((await readdir(external)).length, 2);
});

test("read-only worlds may reuse existing validated analysis but cannot create cache entries", async () => {
  const owner = await world(), manifest = analysisFixture();
  await saveEffectManifest(owner, manifest, new Set());
  await owner.close();
  const reader = await WorldStore.open(owner.dir, { readOnly: true }); closeOnCleanup(() => reader.close());
  assert.deepEqual(await cachedEffectManifest(reader, manifest.sourceFingerprint), manifest);
  const before = (await readdir(cachePath(reader, ""))).sort();
  await assert.rejects(saveEffectManifest(reader, analysisFixture({ energy: 0.4 }), new Set()), /read-only/);
  assert.deepEqual((await readdir(cachePath(reader, ""))).sort(), before);
});
