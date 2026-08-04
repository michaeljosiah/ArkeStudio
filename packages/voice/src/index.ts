import { z } from "zod";
import type { VoiceCandidate } from "@arke-studio/contracts";

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
  return health.ok && health.architecture === architecture && health.engines.includes("kokoro") && health.engines.includes("whisper");
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
  if (!health.ok || health.unavailableReason !== undefined) {
    return { state: "unavailable", detail: health.unavailableReason ?? "a local model failed verification" };
  }
  return { state: "ready", detail: `Voxa ${health.version} · ${health.architecture}` };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The protocol client (R-1..R-3): /tts, /stt, /voices, /health on loopback. /voice (realtime)
 * is mounted by the sidecar and deliberately unused in v1 (D3).
 */
export class VoxaClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
  ) {}

  async health(): Promise<SidecarHealth | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`);
      if (res.status >= 400) return null;
      return SidecarHealthSchema.parse(await res.json());
    } catch {
      return null;
    }
  }

  async listVoices(): Promise<LocalVoice[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/voices`);
      if (res.status >= 400) return [];
      const parsed = z.array(LocalVoiceSchema).safeParse(await res.json());
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  /** Local synthesis: no queue, no ledger, zero cost (R-2) — the compute is this machine's. */
  async synthesize(input: { voiceId: string; text: string; params?: Record<string, number> }): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: input.voiceId, text: input.text, ...input.params }),
    });
    if (res.status >= 400) throw new Error(`voxa: synthesis failed (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Local transcription (R-17): audio never leaves the machine — this URL is loopback. */
  async transcribe(audio: Uint8Array, contentType: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/stt`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: Buffer.from(audio),
    });
    if (res.status >= 400) throw new Error(`voxa: transcription failed (HTTP ${res.status})`);
    const body = (await res.json()) as { text?: string };
    return body.text ?? "";
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
    voiceId: v.id,
    label: v.label,
    attributes: v.attributes,
    local: true,
    canClone: false,
  }));
}
