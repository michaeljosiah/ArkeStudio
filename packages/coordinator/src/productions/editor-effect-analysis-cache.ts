import { createHash } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { EFFECT_ANALYSIS_PROFILE, EffectFeatureManifestSchema, effectManifestFingerprintMaterial, effectAudioSourceFingerprintMaterial, type EffectFeatureManifest } from "@arke-studio/contracts";
import { DerivedCache, type DerivedCacheProblem } from "../media/derived-cache.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import type { WorldStore } from "../world/store.js";

export const EFFECT_ANALYSIS_CACHE = ".cache/editor-effects/analysis";
export const effectAnalysisHash = (content: string) => createHash("sha256").update(content).digest("hex");
const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);

const refusals: Record<DerivedCacheProblem, string> = {
  "too-large": "Audio analysis cache is full; finish pending reviews before preparing more sources",
  unsafe: "Audio analysis cache contains an unsupported file",
  changed: "Audio analysis cache changed during pruning",
  full: "Audio analysis cache is full; finish pending reviews before preparing more sources",
};

/** Manifests and their lookup references, the oldest written evicted first. */
const analyses = new DerivedCache(EFFECT_ANALYSIS_CACHE, {
  owns: /^[a-f0-9]{64}\.(json|ref)$/,
  // Room for a manifest and its reference on top of 1,021 others, as before.
  budget: { bytes: EFFECT_ANALYSIS_PROFILE.maxCacheBytes, files: 1023, graceMs: 0 },
  label: "world",
  refuse: (problem) => new Error(refusals[problem]),
});

/** The byte limit applies to the read itself, including a file growing during that read. */
async function readBounded(path: string, limit: number): Promise<string> {
  const identity = await lstat(path), file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || identity.isSymbolicLink() || before.dev !== identity.dev || before.ino !== identity.ino || before.size > limit) throw new Error("Analysis cache file is unavailable");
    const bytes = Buffer.alloc(limit + 1); let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await file.stat(), current = await lstat(path);
    if (used > limit || used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw new Error("Analysis cache file changed during read");
    return bytes.subarray(0, used).toString("utf8");
  } finally { await file.close(); }
}

export async function readEffectManifest(store: WorldStore, key: string): Promise<EffectFeatureManifest | null> {
  if (!validKey(key) || store.isClosed()) return null;
  try {
    const path = await containedWorldFilePath(store.dir, `${EFFECT_ANALYSIS_CACHE}/${key}.json`);
    const manifest = EffectFeatureManifestSchema.parse(JSON.parse(await readBounded(path, EFFECT_ANALYSIS_PROFILE.maxManifestBytes)));
    if (manifest.manifestKey !== key || effectAnalysisHash(effectManifestFingerprintMaterial(manifest)) !== key ||
      effectAnalysisHash(effectAudioSourceFingerprintMaterial(manifest.descriptor)) !== manifest.sourceFingerprint) return null;
    return manifest;
  } catch { return null; }
}

export async function cachedEffectManifest(store: WorldStore, sourceFingerprint: string): Promise<EffectFeatureManifest | null> {
  if (!validKey(sourceFingerprint)) return null;
  try {
    const path = await containedWorldFilePath(store.dir, `${EFFECT_ANALYSIS_CACHE}/${sourceFingerprint}.ref`);
    const key = await readBounded(path, 64);
    if (!validKey(key)) return null;
    const found = await readEffectManifest(store, key);
    return found?.sourceFingerprint === sourceFingerprint ? found : null;
  } catch { return null; }
}

/** Content addressed derived material, bounded on disk and replaceable without an Undo entry. */
export async function saveEffectManifest(store: WorldStore, manifest: EffectFeatureManifest, retained: ReadonlySet<string>): Promise<void> {
  const bytes = JSON.stringify(EffectFeatureManifestSchema.parse(manifest));
  if (effectAnalysisHash(effectManifestFingerprintMaterial(manifest)) !== manifest.manifestKey) throw new Error("Analysis manifest identity does not match its content");
  if (effectAnalysisHash(effectAudioSourceFingerprintMaterial(manifest.descriptor)) !== manifest.sourceFingerprint) throw new Error("Analysis source identity does not match its descriptor");
  await store.derivedWrite(async () => {
    const write = async (portable: string, content: string) => {
      const target = await containedWorldFilePath(store.dir, portable, true);
      try {
        const file = await open(target, "wx");
        try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await readBounded(target, portable.endsWith(".json") ? EFFECT_ANALYSIS_PROFILE.maxManifestBytes : 64).catch(() => null) !== content) {
          // Interrupted derived writes are disposable. An exact recheck prevents deleting a
          // cache entry another owner replaced after this job captured it.
          await store.assertOwnership();
          const before = await lstat(target);
          await containedWorldFilePath(store.dir, portable);
          const after = await lstat(target);
          if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Analysis cache changed before replacement");
          await unlink(target);
          const file = await open(target, "wx");
          try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
        }
      }
    };
    // What a review still shows, and this manifest, are pinned while the oldest others make room.
    const pins = [...retained, manifest.manifestKey, manifest.sourceFingerprint].map(key => analyses.hold(store.dir, `${EFFECT_ANALYSIS_CACHE}/${key}.json`));
    let reservation: () => void;
    try { reservation = await analyses.reserve(store.dir, Buffer.byteLength(bytes) + 64, 2, store.closingSignal); }
    finally { for (const release of pins) release(); }
    try {
      await write(`${EFFECT_ANALYSIS_CACHE}/${manifest.manifestKey}.json`, bytes);
      await write(`${EFFECT_ANALYSIS_CACHE}/${manifest.sourceFingerprint}.ref`, manifest.manifestKey);
      await store.assertOwnership();
    } finally { reservation(); }
  });
}
