import { z } from "zod";
import { AcousticWordsSchema, KOKORO_VOICE_MODEL, type AcousticWords, type VoiceCandidate } from "@arke-studio/contracts";
import { isWavContentType, transcriptionWav } from "./wav.js";

export { decodeWav, encodePcm16Wav, isWavContentType, resample, transcriptionWav, TRANSCRIPTION_RATE } from "./wav.js";

/**
 * The Voxa sidecar client (SPEC-011): local inference only — cloud speech goes through the
 * provider path and the job queue so there is exactly one money path (D1, D2). The sidecar is
 * a supervised loopback service; this client never talks to anything else.
 */

export const LocalVoiceSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    engine: z.enum(["kokoro", "espeak-ng"]),
    language: z.string().min(1),
    /** Descriptive attributes used by honest attribute-overlap matching (SPEC-011 R-7). */
    attributes: z.array(z.string()),
  })
  .strict();
export type LocalVoice = z.infer<typeof LocalVoiceSchema>;

export const SidecarHealthSchema = z
  .object({
    ok: z.boolean(),
    version: z.string().min(1),
    protocolVersion: z.literal(1),
    architecture: z.enum(["x64", "arm64"]),
    engines: z.array(z.enum(["kokoro", "whisper"])),
    engineStatus: z
      .object({
        kokoro: z.object({ ready: z.boolean(), reason: z.string().optional() }).strict(),
        whisper: z.object({ ready: z.boolean(), reason: z.string().optional() }).strict(),
      })
      .strict(),
    /** Model-download state (R-3): absent when nothing is downloading. */
    downloading: z
      .object({ model: z.string(), receivedMb: z.number(), totalMb: z.number() })
      .strict()
      .optional(),
    /** A model failed verification: running but unable to serve (§2.10). */
    unavailableReason: z.string().optional(),
    wordTiming: z.object({ ready: z.boolean(), reason: z.string().optional() }).strict().optional(),
  })
  .strict();
export type SidecarHealth = z.infer<typeof SidecarHealthSchema>;

export function compatibleSidecarHealth(health: SidecarHealth, architecture: "x64" | "arm64"): boolean {
  return health.architecture === architecture && health.engines.includes("kokoro") && health.engines.includes("whisper");
}

/** The four degradation states, each worth distinct copy (§2.10, T-17). */
export type SidecarState =
  | { state: "not-started"; detail: string }
  | { state: "downloading"; detail: string }
  | { state: "unavailable"; detail: string }
  | { state: "ready"; detail: string };

export function sidecarState(health: SidecarHealth | null): SidecarState {
  if (health === null) {
    return { state: "not-started", detail: "Voxa is not running — local voice and dictation are off; cloud voice still works" };
  }
  if (health.downloading) {
    const { model, receivedMb, totalMb } = health.downloading;
    return { state: "downloading", detail: `downloading ${model} — ${Math.round(receivedMb)} of ${Math.round(totalMb)} MB` };
  }
  if (health.engineStatus.kokoro.ready || health.engineStatus.whisper.ready) {
    return { state: "ready", detail: `Voxa ${health.version} · ${health.architecture}` };
  }
  return {
    state: "unavailable",
    detail:
      health.unavailableReason ??
      health.engineStatus.kokoro.reason ??
      health.engineStatus.whisper.reason ??
      "the local speech engines are unavailable",
  };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type VoxaOperation = "health" | "voices" | "tts" | "stt";

export class VoxaTimeoutError extends Error {
  readonly code = "VOXA_TIMEOUT";

  constructor(
    readonly operation: VoxaOperation,
    readonly timeoutMs: number,
  ) {
    super(`voxa: ${operation} timed out after ${timeoutMs} ms`);
    this.name = "VoxaTimeoutError";
  }
}

export class VoxaCancelledError extends Error {
  readonly code = "VOXA_CANCELLED";

  constructor(readonly operation: VoxaOperation) {
    super(`voxa: ${operation} was cancelled`);
    this.name = "VoxaCancelledError";
  }
}

export class VoxaRecoveryHeldError extends Error {
  readonly code = "VOXA_RECOVERY_HELD";
  constructor() { super("Voxa is recovering. Wait for local voice readiness before trying again."); this.name = "VoxaRecoveryHeldError"; }
}

export interface VoxaTimeouts {
  health: number;
  voices: number;
  tts: number;
  stt: number;
}

export const DEFAULT_VOXA_TIMEOUTS: VoxaTimeouts = {
  health: 3_000,
  voices: 5_000,
  // A safe 450-character chunk takes about 32 seconds on the measured CPU path.
  tts: 45_000,
  stt: 60_000,
};

export interface VoxaRequestOptions {
  signal?: AbortSignal;
  /** Private speech callers bound streamed bytes before assembling audio in memory. */
  maxAudioBytes?: number;
}

interface SynthesisWaiter {
  grant: () => void;
  cancel: () => void;
}

/**
 * The protocol client (R-1..R-3): /tts, /stt, /voices, /health on loopback. /voice (realtime)
 * is mounted by the sidecar and deliberately unused in v1 (D3).
 */
export class VoxaClient {
  private readonly timeouts: VoxaTimeouts;
  private requests = new AbortController();
  private disposed = false;
  private synthesisBusy = false;
  private readonly synthesisWaiters: SynthesisWaiter[] = [];
  private activeInference = 0;
  private recoveryWaiting = false;
  private recoveryHeld = false;
  private readonly inferenceIdle = new Set<() => void>();

  private inferenceChanged(): void { for (const listener of this.inferenceIdle) listener(); }
  private admitInference(operation: VoxaOperation): () => void {
    if (this.disposed) throw new VoxaCancelledError(operation);
    if (this.recoveryWaiting || this.recoveryHeld) throw new VoxaRecoveryHeldError();
    this.activeInference++; let released = false;
    return () => { if (released) return; released = true; this.activeInference--; this.inferenceChanged(); };
  }
  private async inference<T>(operation: VoxaOperation, run: (lifecycleSignal: AbortSignal, retain: (work: Promise<unknown>) => void) => Promise<T>): Promise<T> {
    const release = this.admitInference(operation), lifecycleSignal = this.requests.signal;
    let retained: Promise<unknown> | undefined;
    try { return await run(lifecycleSignal, work => { retained = work; }); }
    finally { if (retained) void retained.then(release, release); else release(); }
  }

  /** One host-owned reservation drains admitted synthesis/transcription, including queued
   * synthesis and response-body reads. It never submits or replays an inference request. */
  async reserveRuntime(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.disposed) throw new VoxaCancelledError("health");
    if (this.recoveryWaiting || this.recoveryHeld) throw new VoxaRecoveryHeldError();
    this.recoveryWaiting = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const done = (error?: unknown) => { this.inferenceIdle.delete(check); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
        const check = () => { if (this.disposed) done(new VoxaCancelledError("health")); else if (this.activeInference === 0) done(); };
        const abort = () => done(signal.reason ?? new Error("Voxa recovery cancelled."));
        this.inferenceIdle.add(check); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort(); else check();
      });
      signal.throwIfAborted(); if (this.disposed) throw new VoxaCancelledError("health");
      this.recoveryWaiting = false; this.recoveryHeld = true; let released = false;
      return () => { if (released) return; released = true; this.recoveryHeld = false; this.inferenceChanged(); };
    } catch (error) { this.recoveryWaiting = false; this.inferenceChanged(); throw error; }
  }

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string | (() => string),
    options: { timeouts?: Partial<VoxaTimeouts> } = {},
  ) {
    this.timeouts = { ...DEFAULT_VOXA_TIMEOUTS, ...options.timeouts };
  }

  async health(options: VoxaRequestOptions = {}): Promise<SidecarHealth | null> {
    try {
      return await this.request("health", "/health", {}, options.signal, async (res) => {
        if (res.status >= 400) return null;
        return SidecarHealthSchema.parse(await res.json());
      });
    } catch (error) {
      if (error instanceof VoxaTimeoutError || error instanceof VoxaCancelledError) throw error;
      return null;
    }
  }

  async listVoices(options: VoxaRequestOptions = {}): Promise<LocalVoice[]> {
    try {
      return await this.request("voices", "/voices", {}, options.signal, async (res) => {
        if (res.status >= 400) return [];
        const parsed = z.array(LocalVoiceSchema).safeParse(await res.json());
        return parsed.success ? parsed.data : [];
      });
    } catch (error) {
      if (error instanceof VoxaTimeoutError || error instanceof VoxaCancelledError) throw error;
      return [];
    }
  }

  /** Local synthesis: no queue, no ledger, zero cost (R-2) — the compute is this machine's. */
  async synthesize(
    input: { voiceId: string; text: string; params?: Record<string, number> },
    options: VoxaRequestOptions = {},
  ): Promise<Uint8Array> {
    const maxAudioBytes = options.maxAudioBytes;
    const callerSignal = options.signal, body = JSON.stringify({ voice: input.voiceId, text: input.text, ...input.params });
    if (maxAudioBytes !== undefined && (!Number.isSafeInteger(maxAudioBytes) || maxAudioBytes < 1 || maxAudioBytes > 16 * 1024 ** 2)) throw new Error("Invalid local audio bound.");
    let privateBase: string | undefined;
    if (maxAudioBytes !== undefined) {
      const url = new URL(this.resolvedBaseUrl());
      if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Private local speech route is unavailable.");
      privateBase = url.origin;
    }
    return this.inference("tts", async (lifecycleSignal, retain) => {
      const started = Date.now();
      const release = await this.acquireSynthesis(callerSignal, lifecycleSignal, this.timeouts.tts);
      let retained: Promise<unknown> | undefined;
      try {
        const remainingMs = Math.max(1, this.timeouts.tts - (Date.now() - started));
        return await this.request(
          "tts", "/tts",
          { method: "POST", headers: { "Content-Type": "application/json" }, body, ...(privateBase ? { redirect: "error" as const } : {}) },
          callerSignal,
          async (res, signal) => {
            if (res.status >= 400) throw new Error(`voxa: synthesis failed (HTTP ${res.status})`);
            if (maxAudioBytes !== undefined) return boundedAudio(res, maxAudioBytes, signal);
            return new Uint8Array(await res.arrayBuffer());
          },
          lifecycleSignal, remainingMs, this.timeouts.tts, privateBase,
          privateBase ? work => { retained = work; retain(work); } : undefined,
        );
      } finally { if (retained) void retained.then(release, release); else release(); }
    });
  }

  /**
   * Local transcription (R-17): audio never leaves the machine — this URL is loopback. A WAV is
   * converted to the 16 kHz mono 16-bit PCM `/stt` accepts first (see wav.ts); other content goes
   * as it came.
   */
  async transcribe(audio: Uint8Array, contentType: string, options: VoxaRequestOptions = {}): Promise<string> {
    return this.inference("stt", async lifecycleSignal => {
      if (isWavContentType(contentType)) audio = await transcriptionWav(audio);
      return this.request("stt", "/stt", { method: "POST", headers: { "Content-Type": contentType }, body: Buffer.from(audio) }, options.signal, async res => {
        if (res.status >= 400) throw new Error(`voxa: transcription failed (HTTP ${res.status})`);
        const body = (await res.json()) as { text?: string };
        return body.text ?? "";
      }, lifecycleSignal);
    });
  }

  /** Native acoustic word bounds, never the sentence-duration estimate used by older sidecars. */
  async transcribeWords(audio: Uint8Array, options: VoxaRequestOptions = {}): Promise<AcousticWords> {
    return this.inference("stt", async lifecycleSignal => {
      const wav = await transcriptionWav(audio);
      return this.request("stt", "/stt/words", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: Buffer.from(wav) }, options.signal, async (res, signal) => {
        if (res.status >= 400) throw new Error(await wordTimingFailure(res, signal));
        return AcousticWordsSchema.parse(await res.json());
      }, lifecycleSignal, Math.max(this.timeouts.stt, 300_000));
    });
  }

  /** Cancel active and queued work before replacing the supervised process. Future calls remain valid. */
  cancelPending(): void {
    this.requests.abort();
    if (!this.disposed) this.requests = new AbortController();
  }

  dispose(): void {
    this.disposed = true;
    this.requests.abort();
    this.inferenceChanged();
  }

  private resolvedBaseUrl(): string {
    const value = typeof this.baseUrl === "function" ? this.baseUrl() : this.baseUrl;
    return value.replace(/\/$/, "");
  }

  private async request<T>(
    operation: VoxaOperation,
    path: string,
    init: RequestInit,
    callerSignal: AbortSignal | undefined,
    read: (response: Response, signal: AbortSignal) => Promise<T>,
    lifecycleSignal: AbortSignal = this.requests.signal,
    timeoutMs: number = this.timeouts[operation],
    reportedTimeoutMs: number = timeoutMs,
    pinnedBase?: string,
    retain?: (work: Promise<unknown>) => void,
  ): Promise<T> {
    if (this.disposed || lifecycleSignal.aborted || callerSignal?.aborted) {
      throw new VoxaCancelledError(operation);
    }

    const controller = new AbortController();
    let cause: "timeout" | "cancelled" = "cancelled";
    let rejectAbort: (reason: Error) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const cancel = () => {
      cause = "cancelled";
      controller.abort();
      rejectAbort(new VoxaCancelledError(operation));
    };
    lifecycleSignal.addEventListener("abort", cancel, { once: true });
    callerSignal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      cause = "timeout";
      controller.abort();
      rejectAbort(new VoxaTimeoutError(operation, reportedTimeoutMs));
    }, timeoutMs);

    try {
      const work = this.fetchImpl(`${pinnedBase ?? this.resolvedBaseUrl()}${path}`, { ...init, signal: controller.signal })
        .then(response => read(response, controller.signal))
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            throw cause === "timeout"
              ? new VoxaTimeoutError(operation, reportedTimeoutMs)
              : new VoxaCancelledError(operation);
          }
          throw error;
        });
      retain?.(work);
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      lifecycleSignal.removeEventListener("abort", cancel);
      callerSignal?.removeEventListener("abort", cancel);
    }
  }

  private acquireSynthesis(
    callerSignal: AbortSignal | undefined,
    lifecycleSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<() => void> {
    if (this.disposed || lifecycleSignal.aborted || callerSignal?.aborted) {
      return Promise.reject(new VoxaCancelledError("tts"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        lifecycleSignal.removeEventListener("abort", waiter.cancel);
        callerSignal?.removeEventListener("abort", waiter.cancel);
      };
      const refuse = (error: Error) => {
        if (settled) return;
        settled = true;
        const index = this.synthesisWaiters.indexOf(waiter);
        if (index >= 0) this.synthesisWaiters.splice(index, 1);
        cleanup();
        reject(error);
      };
      const waiter: SynthesisWaiter = {
        grant: () => {
          if (settled) return;
          settled = true;
          cleanup();
          this.synthesisBusy = true;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.synthesisBusy = false;
            this.pumpSynthesis();
          });
        },
        cancel: () => refuse(new VoxaCancelledError("tts")),
      };
      timer = setTimeout(() => refuse(new VoxaTimeoutError("tts", timeoutMs)), timeoutMs);
      lifecycleSignal.addEventListener("abort", waiter.cancel, { once: true });
      callerSignal?.addEventListener("abort", waiter.cancel, { once: true });
      this.synthesisWaiters.push(waiter);
      this.pumpSynthesis();
    });
  }

  private pumpSynthesis(): void {
    if (this.synthesisBusy) return;
    this.synthesisWaiters.shift()?.grant();
  }
}

async function boundedAudio(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Local speech returned no audio.");
  let cancelling: Promise<void> | undefined;
  const cancel = () => cancelling ??= reader.cancel().catch(() => {});
  const abort = () => { void cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > max)) throw new Error("Local speech exceeds its audio bound.");
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
      bytes += value.byteLength;
      if (bytes > max || chunks.length >= 16384) throw new Error("Local speech exceeds its audio bound.");
      chunks.push(value);
    }
    const audio = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
    return audio;
  } finally { signal.removeEventListener("abort", abort); await cancel(); reader.releaseLock(); }
}

const wordTimingProblem = z.object({ detail: z.string().max(512) });
const wordTimingReasons = new Map([
  ["Word timing requires at least 0.2 seconds of audio.", "word timing needs at least 0.2 seconds of audio"],
  ["The recognizer returned text without usable word timings.", "the recognizer returned no usable word timing"],
  ["Long audio requires a measurable silent pause within each 28-second alignment window.", "word timing needs a silent pause within each 28-second section"],
  ["Invalid audio duration.", "word timing could not read the recording’s duration"],
  ["The recognizer returned multiple words under one timestamp.", "the recognizer grouped multiple words under one timestamp"],
  ["The recognizer returned out-of-order tokens.", "word timing contains out-of-order words"],
  ["A word has no usable acoustic interval or an unresolved pause.", "a word has no usable timing or an unresolved pause"],
]);

/** Other local readers may preserve these safe refusals without trusting arbitrary exception text. */
export function wordTimingRefusalReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const reasons = [...wordTimingReasons.values(), "word timing contains overlapping or ambiguous words", "word timing contains invalid word bounds or confidence"];
  return reasons.find(reason => reason === error.message);
}

/** SPEC-047 R-184: explain only known local refusals, never echo response text or a transcript. */
async function wordTimingFailure(response: Response, signal: AbortSignal): Promise<string> {
  const fallback = `voxa: word timing failed (HTTP ${response.status})`;
  if (response.status !== 422 || response.body === null ||
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/problem+json") return fallback;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let expired = false;
  const timer = setTimeout(() => { expired = true; cancel(); }, 1000);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (expired) return fallback;
      if (done) break;
      size += value.byteLength;
      if (size > 2048) return fallback;
      chunks.push(value);
    }
    const parsed = wordTimingProblem.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) return fallback;
    const detail = parsed.data.detail;
    if (/^The recognizer returned ambiguous or overlapping word bounds at word \d+ \([^()\r\n]+ seconds\)\.$/.test(detail))
      return "word timing contains overlapping or ambiguous words";
    if (/^The recognizer returned invalid token bounds or confidence \([^()\r\n]+\)\.$/.test(detail))
      return "word timing contains invalid word bounds or confidence";
    return wordTimingReasons.get(detail) ?? fallback;
  } catch {
    signal.throwIfAborted();
    return fallback;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/**
 * The shipped Kokoro presets: a fixed local catalogue that cannot clone. Other local engines may
 * declare cloning independently (SPEC-011 D4 as amended by SPEC-022).
 */
export const KOKORO_PRESETS: LocalVoice[] = [
  { id: "af_bella", label: "Bella", engine: "kokoro", language: "en-US", attributes: ["warm", "low", "even", "female"] },
  { id: "af_nicole", label: "Nicole", engine: "kokoro", language: "en-US", attributes: ["bright", "quick", "female"] },
  { id: "am_michael", label: "Michael", engine: "kokoro", language: "en-US", attributes: ["deep", "steady", "male"] },
  { id: "am_adam", label: "Adam", engine: "kokoro", language: "en-US", attributes: ["dry", "measured", "male"] },
  { id: "bf_emma", label: "Emma", engine: "kokoro", language: "en-GB", attributes: ["cool", "precise", "female", "coastal"] },
  { id: "bm_george", label: "George", engine: "kokoro", language: "en-GB", attributes: ["low", "gravel", "male", "weathered"] },
];

/** Kokoro catalogue as picker candidates: a fixed set, never cloneable (R-6, D4). */
export function localCandidates(voices: LocalVoice[]): VoiceCandidate[] {
  return voices.map((v) => ({
    provider: "kokoro",
    model: KOKORO_VOICE_MODEL,
    voiceId: v.id,
    label: v.label,
    attributes: v.attributes,
    facets: { language: v.language, gender: v.attributes.find(a => a === "male" || a === "female") },
    local: true,
    canClone: false,
  }));
}
