import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMingModel, MING_MODELS, MING_CHUNK_CHARS } from "@arke-studio/contracts";
import { ProviderRequestRejectedError, type MingSynthesis } from "@arke-studio/providers";
import { ComfyUiDigestCache } from "../comfyui/digest-cache.js";
import { splitForSpeech } from "../voice/split.js";
import { MING_ASSETS } from "./ming-catalogue.js";
import type { MingBatchCommand } from "./ming.js";
import { MING_BATCH_AUDIO_BYTES, type MingBatchSpace, type MingBatchSpaceLease } from "../storage/ming-batches.js";
import { ImportStorageHeld } from "../storage/import-files.js";

/** Retain the sentence split used by Arke, with the auditioned forty-word ceiling as well. */
export function mingSpeechChunks(text: string): string[] {
  const atoms = text.trim().split(/(?<=[.!?])\s+/u).flatMap(sentence => splitForSpeech(sentence, MING_CHUNK_CHARS)).flatMap(part => {
    const words = part.split(/\s+/u);
    const chunks: string[] = [];
    while (words.length > 40) {
      let cut = 40;
      for (let at = 39; at >= 20; at--) if (/[,;:]$/u.test(words[at]!)) { cut = at + 1; break; }
      chunks.push(words.splice(0, cut).join(" "));
    }
    if (words.length) chunks.push(words.join(" "));
    return chunks;
  });
  const chunks: string[] = [];
  let held = "";
  for (const atom of atoms) {
    const combined = held ? `${held} ${atom}` : atom;
    if (held && (combined.length > MING_CHUNK_CHARS || combined.split(/\s+/u).length > 40)) { chunks.push(held); held = atom; }
    else held = combined;
  }
  if (held) chunks.push(held);
  return chunks;
}

export interface MingSpeechDeps {
  appRoot: string;
  python(): Promise<string | null>;
  run(command: MingBatchCommand, signal: AbortSignal): Promise<void>;
  processRunning(): boolean;
  worker?: string;
  platform?: string;
  arch?: string;
  /** Host/test seam; production uses the checked-in immutable publisher lock. */
  assets?: typeof MING_ASSETS;
  space?: MingBatchSpace;
}

/** Host-owned paths and verified bytes. No model download or Python installation during inference. */
export class MingSpeechService implements MingSynthesis {
  private active = 0;
  private fileChanges = 0;
  private readonly retainedCleanup = new Set<() => Promise<void>>();
  get busy(): boolean { return this.active > 0; }
  reserveFileChange(): () => void {
    if (this.active || this.deps.processRunning()) throw new Error("Stop the current Ming reading before changing its model files.");
    this.fileChanges++;
    let released = false;
    return () => { if (!released) { released = true; this.fileChanges--; } };
  }
  private readonly digests: ComfyUiDigestCache;
  constructor(private readonly deps: MingSpeechDeps) { this.digests = new ComfyUiDigestCache(deps.appRoot); }
  private files(model: string) {
    if (!isMingModel(model)) throw new Error("Unsupported Ming model.");
    const variant = MING_MODELS[model].variant;
    const assets = this.deps.assets ?? MING_ASSETS;
    const lock = assets.variants[variant];
    const runtime = join(this.deps.appRoot, "models", "ming", "runtime", variant);
    const weights = join(this.deps.appRoot, "models", "ming", "models", variant);
    return { variant, runtime, weights, lock,
      files: [...[assets.source, ...lock.wheels, ...(variant === "tiny" ? [assets.sdk] : [])].map(file => ({...file, path: join(runtime, file.file)})),
        ...lock.models.map(file => ({...file, path: join(weights, file.file)}))] };
  }
  async status(model: string): Promise<{ready: boolean; reason?: string}> {
    if (this.fileChanges) return {ready: false, reason: "Ming's model files are being changed. Wait for setup to finish."};
    if (!isMingModel(model)) return {ready: false, reason: "Unsupported Ming model."};
    if ((this.deps.platform ?? process.platform) !== "win32" || (this.deps.arch ?? process.arch) !== "x64") return {ready: false, reason: "Ming's managed runtime is qualified for Windows x64 with NVIDIA CUDA."};
    if (!(await this.deps.python())) return {ready: false, reason: "Choose Arke-managed ComfyUI to use its qualified Python runtime with Ming."};
    const files = this.files(model).files;
    const found = await Promise.all(files.map(async file => (await stat(file.path).catch(() => null))?.size === file.bytes));
    return found.every(Boolean) ? {ready: true} : {ready: false, reason: `Install or repair ${MING_MODELS[model].label} and its dependencies in Settings → Models.`};
  }
  async synthesize(input: Parameters<MingSynthesis["synthesize"]>[0], signal: AbortSignal): Promise<Uint8Array> {
    if (this.fileChanges) throw new Error("Ming's model files are being changed. Wait for setup to finish.");
    this.active++;
    try {
      for (const cleanup of this.retainedCleanup) { signal.throwIfAborted(); await cleanup(); }
      return await this.synthesizeOnce(input, signal);
    }
    finally { this.active--; }
  }
  private async synthesizeOnce(input: Parameters<MingSynthesis["synthesize"]>[0], signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const ready = await this.status(input.model);
    if (!ready.ready) throw new Error(ready.reason);
    const python = await this.deps.python();
    if (!python) throw new Error("Ming's shared runtime changed. Check Settings.");
    const files = this.files(input.model);
    for (const file of files.files) {
      signal.throwIfAborted();
      if (await this.digests.hashFile(file.path, signal) !== file.sha256) throw new Error(`Ming file verification failed: ${file.file}. Repair this model in Settings.`);
    }
    const staging = join(this.deps.appRoot, ".staging", "ming");
    await mkdir(staging, {recursive: true});
    const batch = await mkdtemp(join(staging, "batch-"));
    const cacheRoot = join(this.deps.appRoot, "runtime-cache", "ming");
    let space: MingBatchSpaceLease | undefined;
    let nativeHeld = false, nativeClaimed = false, hostSettled = false, cleanup: Promise<void> | undefined;
    const settle = async () => {
      if (nativeHeld || !hostSettled) return;
      // Only this batch's original owners can release it. Another queued/running batch
      // must neither strand these inputs nor authorize deleting its neighbour's files.
      this.retainedCleanup.add(settle);
      cleanup ??= (async () => { await space?.stop(); await rm(batch, {recursive: true, force: true}); await space?.settle(); })();
      try { await cleanup; this.retainedCleanup.delete(settle); } catch (error) { cleanup = undefined; throw error; }
    };
    try {
      const reference = join(batch, input.reference.contentType === "audio/wav" ? "reference.wav" : "reference.mp3");
      const request = { schemaVersion: 1, variant: files.variant, runtime: files.runtime, weights: files.weights,
        chunks: mingSpeechChunks(input.text), language: input.language, instructions: input.instructions ?? null,
        reference, transcript: input.reference.transcript, output: join(batch, "speech.wav"), seed: 1895 };
      const requestBytes = JSON.stringify(request), assetsBytes = JSON.stringify(this.deps.assets ?? MING_ASSETS);
      const inputs = input.reference.data.byteLength + Buffer.byteLength(requestBytes) + Buffer.byteLength(assetsBytes);
      space = await this.deps.space?.reserve(staging, cacheRoot,
        inputs + files.lock.expandedBytes + files.lock.expandedEntries * 8192 + MING_BATCH_AUDIO_BYTES + 65536, signal);
      signal.throwIfAborted();
      await writeFile(reference, input.reference.data, {flag: "wx"}); await space?.consumed(input.reference.data.byteLength);
      await writeFile(join(batch, "request.json"), requestBytes, {flag: "wx"}); await space?.consumed(Buffer.byteLength(requestBytes));
      await writeFile(join(batch, "assets.json"), assetsBytes, {flag: "wx"}); await space?.consumed(Buffer.byteLength(assetsBytes));
      try {
        await this.deps.run({ python, worker: this.deps.worker ?? join(dirname(fileURLToPath(import.meta.url)), "ming-worker.py"),
          args: ["--request", join(batch, "request.json"), "--assets", join(batch, "assets.json")],
          cacheRoot, storage: space,
          retain: () => {
            if (nativeClaimed || hostSettled) throw new Error("Ming batch ownership changed before launch.");
            nativeClaimed = true; nativeHeld = true;
            return async () => { await space?.stop(); nativeHeld = false; await settle(); };
          } }, signal);
      } catch (error) {
        const failure = join(batch, "failure.json");
        const info = await stat(failure).catch(() => null);
        if (!signal.aborted && !nativeHeld && info?.isFile() && info.size <= 2048) {
          const detail = JSON.parse(await readFile(failure, "utf8")) as {reason?: unknown};
          if (typeof detail.reason === "string" && detail.reason.length <= 500) throw new ProviderRequestRejectedError(detail.reason);
        }
        throw error;
      }
      signal.throwIfAborted();
      const result = JSON.parse(await readFile(join(batch, "result.json"), "utf8")) as {completedChunks?: number; expandedBytes?: number};
      if (result.completedChunks !== request.chunks.length) throw new Error("Ming did not complete every narration chunk.");
      const output = await stat(request.output);
      if (!output.isFile() || output.size < 44 || output.size > 64 * 1024 * 1024) throw new Error("Ming produced an invalid or oversized audio file.");
      if (result.expandedBytes !== undefined && (!Number.isSafeInteger(result.expandedBytes) || result.expandedBytes < 0 || result.expandedBytes > files.lock.expandedBytes)) throw new Error("Ming produced invalid storage accounting.");
      // The worker's closed phase receipt reports completed expansion. Older workers without
      // that receipt keep the whole expansion estimate until settlement; unknown is not free.
      await space?.consumed(output.size + (result.expandedBytes ?? 0));
      return new Uint8Array(await readFile(request.output));
    } catch (error) {
      space?.writeFailed(); if (nativeHeld) await space?.uncertain();
      if (!nativeHeld && error instanceof ImportStorageHeld) throw new ProviderRequestRejectedError(error.message);
      throw error;
    } finally {
      // Native cleanup may finish after the caller stopped waiting. Its retained release
      // closes this exact batch once host reads/writes have also finished, without replay.
      hostSettled = true; await settle();
    }
  }
}
