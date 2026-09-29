import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { estimateSpeechMicroUsd, NARRATOR_PREVIEW_TEXT, VOICE_PREVIEW_SCOPE, supportsVoiceUse,
  voiceFormatForModel, voiceTargetKey, type VoiceCandidate, type ModelManifest, type DomainEvent, type Job } from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { SidecarLike } from "./service.js";
import { cachedVoiceAudioLooksRight } from "./service.js";
import { atomicWriteFile } from "../world/atomic.js";

const MAX_SAMPLE_BYTES = 12 * 1024 * 1024;

/** Provider metadata is not permission to fetch an arbitrary host or forward credentials. */
export function approvedVoiceSample(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port &&
      parsed.hostname === "storage.googleapis.com" && parsed.pathname.startsWith("/eleven-public-prod/");
  } catch { return false; }
}

export class CataloguePreviewService {
  private voices = new Map<string, VoiceCandidate>();
  private requests = new Map<string, { abort: AbortController; jobId?: string }>();
  private results = new Map<string, Extract<DomainEvent, { type: "voice.catalogue-preview" }>>();
  private closed = false;
  constructor(private readonly deps: {
    root: string;
    sidecar: SidecarLike | null;
    manifest: ModelManifest | undefined;
    enqueue?: (input: EnqueueInput) => Promise<Job>;
    cancel?: (id: string) => Promise<void>;
    emit: (event: DomainEvent) => void;
    fetch?: typeof fetch;
  }) {}

  catalogue(voices: VoiceCandidate[]): VoiceCandidate[] {
    const annotated = voices.map(voice => {
      const model = this.deps.manifest?.models.find(m => m.id === voice.model && m.provider === voice.provider);
      let preview: NonNullable<VoiceCandidate["preview"]> = { kind: "unavailable", reason: "No preview available" };
      if (supportsVoiceUse(voice, "narration") && !voice.unavailableReason) {
        if (approvedVoiceSample(voice.previewUrl)) preview = { kind: "sample", microUsd: 0 };
        else if (voice.provider === "kokoro" && this.deps.sidecar) preview = { kind: "generate", microUsd: 0 };
        else if (model && this.deps.enqueue && model.capability === "voice-tts") {
          preview = { kind: "generate", microUsd: estimateSpeechMicroUsd(model, NARRATOR_PREVIEW_TEXT) };
        }
      }
      return { ...voice, preview };
    });
    this.voices = new Map(annotated.map(v => [voiceTargetKey(v), v]));
    return annotated;
  }

  private result(requestId: string, result: Omit<Extract<DomainEvent, { type: "voice.catalogue-preview" }>, "at" | "type" | "requestId">): void {
    const event = { at: new Date().toISOString(), type: "voice.catalogue-preview" as const, requestId, ...result };
    this.results.delete(requestId);
    this.results.set(requestId, event);
    if (this.results.size > 32) this.results.delete(this.results.keys().next().value!);
    this.deps.emit(event);
  }

  initialEvents(): DomainEvent[] { return [...this.results.values()]; }

  observeJob(job: Job): void {
    if (job.worldId !== VOICE_PREVIEW_SCOPE) return;
    if (job.status === "needs-reconciliation" || job.finalization?.status === "failed") {
      const id = job.params["cataloguePreviewRequestId"];
      if (typeof id !== "string" || !this.requests.has(id)) return;
      this.result(id, { status: "failed", error: "The preview needs attention in Activity. It may already have been charged." });
      this.requests.delete(id);
    }
  }

  async request(input: { requestId: string; provider: string; model: string; voiceId: string; maxMicroUsd: number }): Promise<void> {
    if (this.closed || this.requests.has(input.requestId)) return;
    const work = { abort: new AbortController(), jobId: undefined as string | undefined };
    this.requests.set(input.requestId, work);
    this.result(input.requestId, { status: "loading" });
    try {
      const voice = this.voices.get(voiceTargetKey(input));
      if (!voice || voice.preview?.kind === "unavailable" || !voice.preview) throw new Error("Refresh the catalogue and choose an available voice.");
      const sample = voice.preview.kind === "sample";
      const model = this.deps.manifest?.models.find(m => m.id === voice.model && m.provider === voice.provider);
      const format = sample ? "mp3" : voice.provider === "kokoro" ? "wav" : model ? voiceFormatForModel(model) : "mp3";
      const hash = createHash("sha256").update(JSON.stringify([voiceTargetKey(voice), sample ? voice.previewUrl : NARRATOR_PREVIEW_TEXT, format, 1])).digest("hex");
      const file = `${hash}.${format}`;
      const absolute = join(this.deps.root, "audio", file);
      const cached = await readFile(absolute).catch(() => null);
      if (work.abort.signal.aborted) return;
      if (cached && cachedVoiceAudioLooksRight(cached, format)) {
        this.result(input.requestId, { status: "ready", file });
        return;
      }
      const price = sample || voice.provider === "kokoro" ? 0 : model ? estimateSpeechMicroUsd(model, NARRATOR_PREVIEW_TEXT) : Infinity;
      if (price > input.maxMicroUsd) throw new Error("The preview price changed. Refresh the catalogue before generating it.");
      if (sample) {
        const response = await (this.deps.fetch ?? fetch)(voice.previewUrl!, {
          redirect: "error", signal: AbortSignal.any([work.abort.signal, AbortSignal.timeout(30_000)]),
        });
        if (!response.ok || !response.body) throw new Error("The provider sample could not be loaded. Try again.");
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_SAMPLE_BYTES) throw new Error("The provider sample is too large.");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const bytes = Buffer.concat(chunks);
        if (!cachedVoiceAudioLooksRight(bytes, "mp3")) throw new Error("The provider sample is not valid audio.");
        if (work.abort.signal.aborted) return;
        await atomicWriteFile(absolute, bytes);
      } else if (voice.provider === "kokoro") {
        const bytes = await this.deps.sidecar!.synthesize({ voiceId: voice.voiceId, text: NARRATOR_PREVIEW_TEXT }, { signal: work.abort.signal });
        if (!cachedVoiceAudioLooksRight(bytes, "wav")) throw new Error("The voice engine returned invalid audio.");
        if (work.abort.signal.aborted) return;
        await atomicWriteFile(absolute, bytes);
      } else {
        if (!model || !this.deps.enqueue) throw new Error("Preview generation is unavailable.");
        const job = await this.deps.enqueue({
          worldId: VOICE_PREVIEW_SCOPE, target: { kind: "voice-preview", id: hash },
          provider: voice.provider, model: voice.model, capability: "voice-tts",
          idempotencyKey: input.requestId,
          params: { voiceId: voice.voiceId, voiceLabel: voice.label, text: NARRATOR_PREVIEW_TEXT, audioFormat: format, cataloguePreviewRequestId: input.requestId },
          estimatedMicroUsd: price, landing: { dir: "audio", name: file },
        });
        work.jobId = job.id;
        if (work.abort.signal.aborted) await this.deps.cancel?.(job.id);
        else if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled" || job.status === "needs-reconciliation") this.terminal(job);
        else this.result(input.requestId, { status: "queued" });
        return;
      }
      if (!work.abort.signal.aborted) this.result(input.requestId, { status: "ready", file });
    } catch (error) {
      if (!work.abort.signal.aborted) this.result(input.requestId, { status: "failed", error: error instanceof Error ? error.message : "Preview failed. Try again." });
    } finally {
      if (!work.jobId) this.requests.delete(input.requestId);
    }
  }

  terminal(job: Job): void {
    if (job.worldId !== VOICE_PREVIEW_SCOPE) return;
    const id = job.params["cataloguePreviewRequestId"];
    if (typeof id !== "string") return;
    const request = this.requests.get(id);
    if (!request || request.abort.signal.aborted) return;
    if (job.status === "succeeded" && job.landing) this.result(id, { status: "ready", file: job.landing.name });
    else this.result(id, { status: "failed", error: "Preview generation did not complete. Check Activity before trying again." });
    this.requests.delete(id);
  }

  async cancel(requestId: string): Promise<void> {
    this.results.delete(requestId);
    const request = this.requests.get(requestId);
    if (!request) return;
    request.abort.abort();
    if (request.jobId) await this.deps.cancel?.(request.jobId);
    this.requests.delete(requestId);
  }

  close(): void {
    this.closed = true;
    for (const request of this.requests.values()) request.abort.abort();
  }

  async serve(file: string): Promise<{ path: string; contentType: string } | null> {
    if (!/^[a-f0-9]{64}\.(mp3|wav|flac)$/.test(file)) return null;
    try {
      const root = await realpath(join(this.deps.root, "audio"));
      const resolved = await realpath(join(root, file));
      const rel = relative(root, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) return null;
      return { path: resolved, contentType: file.endsWith("mp3") ? "audio/mpeg" : file.endsWith("flac") ? "audio/flac" : "audio/wav" };
    } catch { return null; }
  }
}
