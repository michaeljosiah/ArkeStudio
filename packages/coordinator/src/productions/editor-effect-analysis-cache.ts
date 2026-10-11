import { createHash } from "node:crypto";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { EFFECT_ANALYSIS_PROFILE, EffectFeatureManifestSchema, effectManifestFingerprintMaterial, effectAudioSourceFingerprintMaterial, type EffectFeatureManifest } from "@arke-studio/contracts";
import { containedWorldFilePath } from "../world/contained-file.js";
import type { WorldStore } from "../world/store.js";

export const EFFECT_ANALYSIS_CACHE = ".cache/editor-effects/analysis";
export const effectAnalysisHash = (content: string) => createHash("sha256").update(content).digest("hex");
const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);

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
    const path = await containedWorldFilePath(store.dir, `${EFFECT_ANALYSIS_CACHE}/${manifest.manifestKey}.json`, true);
    const entries = await readdir(dirname(path), { withFileTypes: true });
    if (entries.length > 1024) throw new Error("Audio analysis cache exceeds its file budget");
    const files = [];
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.(json|ref)$/.test(entry.name) || entry.isSymbolicLink() || !entry.isFile()) throw new Error("Audio analysis cache contains an unsupported file");
      const file = await containedWorldFilePath(store.dir, `${EFFECT_ANALYSIS_CACHE}/${entry.name}`), info = await lstat(file);
      if (info.size > (entry.name.endsWith(".json") ? EFFECT_ANALYSIS_PROFILE.maxManifestBytes : 64)) throw new Error("Audio analysis cache contains an oversized file");
      files.push({ file, name: entry.name, info });
    }
    let total = files.reduce((sum, file) => sum + file.info.size, 0), count = files.length;
    for (const file of files.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
      if (total + Buffer.byteLength(bytes) + 64 <= EFFECT_ANALYSIS_PROFILE.maxCacheBytes && count < 1022) break;
      if (retained.has(file.name.slice(0, 64)) || file.name.startsWith(manifest.manifestKey)) continue;
      const current = await lstat(file.file);
      if (current.dev !== file.info.dev || current.ino !== file.info.ino || current.isSymbolicLink()) throw new Error("Audio analysis cache changed during pruning");
      await unlink(file.file); total -= file.info.size; count--;
    }
    if (total + Buffer.byteLength(bytes) + 64 > EFFECT_ANALYSIS_PROFILE.maxCacheBytes || count >= 1022) throw new Error("Audio analysis cache is full; finish pending reviews before preparing more sources");
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
    await write(`${EFFECT_ANALYSIS_CACHE}/${manifest.manifestKey}.json`, bytes);
    await write(`${EFFECT_ANALYSIS_CACHE}/${manifest.sourceFingerprint}.ref`, manifest.manifestKey);
    await store.assertOwnership();
  });
}
