import {
  EFFECT_ANALYSIS_PROFILE,
  EffectFeatureManifestSchema,
  effectAudioSourceFingerprintMaterial,
  effectManifestFingerprintMaterial,
  type EffectFeatureManifest,
} from "@arke-studio/contracts";

const cancelled = () => new DOMException("The effect analysis is no longer needed.", "AbortError");
const hash = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
};

/** Limit the stream before parsing: Content-Length alone cannot bound a chunked response. */
async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  const limit = EFFECT_ANALYSIS_PROFILE.maxManifestBytes;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new Error("The reaction manifest exceeds the supported size.");
  if (!response.body) throw new Error("The reaction manifest has no content.");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  try {
    while (true) {
      if (signal.aborted) throw cancelled();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("The reaction manifest exceeds the supported size.");
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The server-owned key is an immutable content identity, not permission to trust fetched JSON. */
export async function readEffectManifest(url: string, manifestKey: string, sourceFingerprint: string, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<EffectFeatureManifest> {
  if (!/^[a-f0-9]{64}$/.test(manifestKey) || !/^[a-f0-9]{64}$/.test(sourceFingerprint)) throw new Error("The reaction manifest identity is invalid.");
  const response = await fetcher(url, { signal });
  if (!response.ok) throw new Error(`The reaction manifest could not be read (${response.status}).`);
  const manifest = EffectFeatureManifestSchema.parse(JSON.parse(await boundedText(response, signal)));
  if (manifest.manifestKey !== manifestKey || manifest.sourceFingerprint !== sourceFingerprint) throw new Error("The reaction manifest belongs to another source.");
  const [contentHash, sourceHash] = await Promise.all([
    hash(effectManifestFingerprintMaterial(manifest)), hash(effectAudioSourceFingerprintMaterial(manifest.descriptor)),
  ]);
  if (signal.aborted) throw cancelled();
  if (contentHash !== manifestKey || sourceHash !== sourceFingerprint) throw new Error("The reaction manifest failed its content check.");
  return manifest;
}

interface CacheEntry {
  key: string;
  sourceFingerprint: string;
  controller: AbortController;
  promise: Promise<EffectFeatureManifest>;
  resolve: (manifest: EffectFeatureManifest) => void;
  reject: (error: unknown) => void;
  started: boolean;
  settled: boolean;
}

/** Eight visible sources, two bounded fetches; leaving a source cancels obsolete requests. */
export class EffectManifestCache {
  private entries = new Map<string, CacheEntry>();
  private retained = new Set<string>();
  private running = 0;
  private closed = false;
  constructor(private urlFor: (key: string) => string, private fetcher: typeof fetch = fetch) {}

  retain(keys: ReadonlySet<string>): void {
    if (keys.size > 8) throw new Error("At most eight simultaneous reaction sources are supported.");
    this.retained = new Set(keys);
    for (const [key, entry] of this.entries) {
      if (!entry.settled && !keys.has(key)) this.remove(key, entry);
    }
    this.prune();
  }

  get(key: string, sourceFingerprint: string): Promise<EffectFeatureManifest> {
    if (this.closed) return Promise.reject(cancelled());
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.sourceFingerprint !== sourceFingerprint) return Promise.reject(new Error("The reaction source identity changed."));
      this.entries.delete(key); this.entries.set(key, existing);
      return existing.promise;
    }
    let resolve!: CacheEntry["resolve"], reject!: CacheEntry["reject"];
    const promise = new Promise<EffectFeatureManifest>((yes, no) => { resolve = yes; reject = no; });
    const entry: CacheEntry = { key, sourceFingerprint, controller: new AbortController(), promise, resolve, reject, started: false, settled: false };
    this.entries.set(key, entry); this.prune(); this.pump();
    return promise;
  }

  retry(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.remove(key, entry);
  }

  destroy(): void {
    this.closed = true;
    for (const [key, entry] of this.entries) this.remove(key, entry);
  }

  private remove(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    entry.controller.abort();
    if (!entry.settled) entry.reject(cancelled());
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 8) break;
      if (!this.retained.has(key)) this.remove(key, entry);
    }
  }

  private pump(): void {
    if (this.closed) return;
    for (const entry of this.entries.values()) {
      if (this.running >= 2) break;
      if (entry.started || entry.settled) continue;
      entry.started = true; this.running++;
      void readEffectManifest(this.urlFor(entry.key), entry.key, entry.sourceFingerprint, entry.controller.signal, this.fetcher)
        .then(entry.resolve, entry.reject).finally(() => {
          entry.settled = true; this.running--; this.pump();
        });
    }
  }
}
