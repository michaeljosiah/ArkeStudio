import { z } from "zod";
import { KOKORO_VOICE_MODEL, type VoiceCandidate } from "@arke-studio/contracts";

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
    const started = Date.now();
    const lifecycleSignal = this.requests.signal;
    const release = await this.acquireSynthesis(options.signal, lifecycleSignal, this.timeouts.tts);
    try {
      const remainingMs = Math.max(1, this.timeouts.tts - (Date.now() - started));
      return await this.request(
        "tts",
        "/tts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voice: input.voiceId, text: input.text, ...input.params }),
        },
        options.signal,
        async (res) => {
          if (res.status >= 400) throw new Error(`voxa: synthesis failed (HTTP ${res.status})`);
          return new Uint8Array(await res.arrayBuffer());
        },
        lifecycleSignal,
        remainingMs,
        this.timeouts.tts,
      );
    } finally {
      release();
    }
  }

  /** Local transcription (R-17): audio never leaves the machine — this URL is loopback. */
  async transcribe(audio: Uint8Array, contentType: string, options: VoxaRequestOptions = {}): Promise<string> {
    return this.request(
      "stt",
      "/stt",
      {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: Buffer.from(audio),
      },
      options.signal,
      async (res) => {
        if (res.status >= 400) throw new Error(`voxa: transcription failed (HTTP ${res.status})`);
        const body = (await res.json()) as { text?: string };
        return body.text ?? "";
      },
    );
  }

  /** Cancel active and queued work before replacing the supervised process. Future calls remain valid. */
  cancelPending(): void {
    this.requests.abort();
    if (!this.disposed) this.requests = new AbortController();
  }

  dispose(): void {
    this.disposed = true;
    this.requests.abort();
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
    read: (response: Response) => Promise<T>,
    lifecycleSignal: AbortSignal = this.requests.signal,
    timeoutMs: number = this.timeouts[operation],
    reportedTimeoutMs: number = timeoutMs,
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
      const work = this.fetchImpl(`${this.resolvedBaseUrl()}${path}`, { ...init, signal: controller.signal })
        .then(read)
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            throw cause === "timeout"
              ? new VoxaTimeoutError(operation, reportedTimeoutMs)
              : new VoxaCancelledError(operation);
          }
          throw error;
        });
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

/**
 * The shipped Kokoro presets, used when the sidecar is absent so the picker can still render
 * the local column with its honest one-liner: local means presets, cloud means cloning (D4).
 */
export const KOKORO_PRESETS: LocalVoice[] = [
  { id: "af_bella", label: "Bella", engine: "kokoro", language: "en-US", attributes: ["warm", "low", "even", "female"] },
  { id: "af_nicole", label: "Nicole", engine: "kokoro", language: "en-US", attributes: ["bright", "quick", "female"] },
  { id: "am_michael", label: "Michael", engine: "kokoro", language: "en-US", attributes: ["deep", "steady", "male"] },
  { id: "am_adam", label: "Adam", engine: "kokoro", language: "en-US", attributes: ["dry", "measured", "male"] },
  { id: "bf_emma", label: "Emma", engine: "kokoro", language: "en-GB", attributes: ["cool", "precise", "female", "coastal"] },
  { id: "bm_george", label: "George", engine: "kokoro", language: "en-GB", attributes: ["low", "gravel", "male", "weathered"] },
];

/** Local catalogue as picker candidates: a fixed set, never cloneable (R-6, D4). */
export function localCandidates(voices: LocalVoice[]): VoiceCandidate[] {
  return voices.map((v) => ({
    provider: "kokoro",
    model: KOKORO_VOICE_MODEL,
    voiceId: v.id,
    label: v.label,
    attributes: v.attributes,
    local: true,
    canClone: false,
  }));
}
