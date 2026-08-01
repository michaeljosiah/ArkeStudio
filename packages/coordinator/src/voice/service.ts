import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  estimateMicroUsd,
  extractVoiceAttributes,
  previewLineFor,
  rankVoices,
  type DomainEvent,
  type ManifestModel,
  type ModelManifest,
  type PreviewLine,
  type Sheet,
  type VoiceCandidate,
  type WorldBundle,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import type { EnqueueInput } from "../queue/dispatcher.js";

/**
 * The voice service (SPEC-011): a unified catalogue over local presets and cloud voices
 * (R-6), honest attribute-overlap matching (R-7, R-8), preview lines from the character's own
 * words with a per-voice-and-line cache (R-9, R-10), and local dictation (R-17). Local
 * synthesis goes straight to the sidecar — no queue, no ledger, zero cost; cloud previews and
 * lines go through the queue like every other dispatch (R-2, D1).
 */

/** The sidecar slice this service needs; @arke-studio/voice's VoxaClient satisfies it. */
export interface SidecarLike {
  listVoices(): Promise<Array<{ id: string; label: string; attributes: string[] }>>;
  synthesize(input: { voiceId: string; text: string; params?: Record<string, number> }): Promise<Uint8Array>;
  transcribe(audio: Uint8Array, contentType: string): Promise<string>;
}

/** The one cloud-catalogue call the picker needs; ElevenLabsClient gains listVoicesCatalog. */
export interface CloudVoiceSource {
  provider: string;
  list(key: string): Promise<VoiceCandidate[]>;
}

export interface VoiceServiceDeps {
  sidecar: SidecarLike | null;
  localPresets: VoiceCandidate[];
  cloudSources: CloudVoiceSource[];
  getKey: (provider: string) => Promise<string | null>;
  emit: (event: DomainEvent) => void;
  clock?: () => string;
}

const PREVIEW_CACHE_DIR = ".cache/voice-previews";

export function previewCacheFile(provider: string, voiceId: string, line: string, ext: string): string {
  const key = createHash("sha256").update(`${provider}\n${voiceId}\n${line}`).digest("hex").slice(0, 24);
  return `${PREVIEW_CACHE_DIR}/${key}.${ext}`;
}

export class VoiceService {
  constructor(private readonly deps: VoiceServiceDeps) {}

  private now(): string {
    return (this.deps.clock ?? (() => new Date().toISOString()))();
  }

  /** The unified catalogue (R-6): local presets (or the live sidecar list) plus cloud voices. */
  async catalogue(): Promise<VoiceCandidate[]> {
    let local = this.deps.localPresets;
    if (this.deps.sidecar) {
      const live = await this.deps.sidecar.listVoices().catch(() => []);
      if (live.length > 0) {
        local = live.map((v) => ({
          provider: "kokoro",
          voiceId: v.id,
          label: v.label,
          attributes: v.attributes,
          local: true,
          canClone: false, // local means presets, cloud means cloning (D4)
        }));
      }
    }
    const cloud: VoiceCandidate[] = [];
    for (const source of this.deps.cloudSources) {
      const key = await this.deps.getKey(source.provider);
      if (key === null) continue; // unkeyed providers simply contribute nothing
      cloud.push(...(await source.list(key).catch(() => [])));
    }
    return [...cloud, ...local];
  }

  /** Rank the catalogue against the sheet's written voice (R-7): emits voice.candidates. */
  async candidates(worldId: string, bundle: WorldBundle, sheet: Sheet, manifest: ModelManifest | null): Promise<void> {
    const written = sheet.sections.find((s) => s.heading === "Voice · written")?.body ?? "";
    const extracted = extractVoiceAttributes(written);
    const ranked = rankVoices(extracted, await this.catalogue());
    const line = previewLineFor(sheet, bundle.productions);
    const voiceModel = manifest?.models.find((m) => m.provider === "elevenlabs" && m.capability === "voice-tts") ?? null;
    this.deps.emit({
      at: this.now(),
      type: "voice.candidates",
      worldId,
      sheetId: sheet.id,
      extracted,
      ranked,
      previewLine: line,
      // Stated before any preview that will incur a charge (R-10): per-line cloud cost.
      cloudPreviewMicroUsd: voiceModel ? estimateMicroUsd(voiceModel, { characters: line.text.length }) : null,
    });
  }

  /**
   * A local preview (R-2): sidecar synthesis into the world's preview cache — no queue, no
   * ledger. Returns the cache path; a hit never re-synthesises (R-10).
   */
  async localPreview(store: WorldStore, sheet: Sheet, voiceId: string, line: PreviewLine): Promise<string> {
    const rel = previewCacheFile("kokoro", voiceId, line.text, "wav");
    const abs = join(store.dir, rel);
    try {
      await readFile(toExtendedLength(abs));
      return rel; // cached: replays without a provider call — or any call at all
    } catch {
      /* miss → synthesise */
    }
    if (!this.deps.sidecar) throw new Error("Voxa is not running — local voice is off; cloud voice still works");
    const audio = await this.deps.sidecar.synthesize({ voiceId, text: line.text });
    await store.gateOp(async () => {
      await atomicWriteFile(abs, audio);
    });
    return rel;
  }

  /** The cloud-preview dispatch (R-2): through the queue, idempotency-protected, ledgered. */
  cloudPreviewRequest(
    worldId: string,
    sheet: Sheet,
    provider: string,
    voiceId: string,
    line: PreviewLine,
    model: ManifestModel,
  ): { input: EnqueueInput; cacheFile: string } {
    const cacheFile = previewCacheFile(provider, voiceId, line.text, "mp3");
    const name = cacheFile.slice(PREVIEW_CACHE_DIR.length + 1);
    return {
      cacheFile,
      input: {
        worldId,
        target: { kind: "voice-preview", id: `${sheet.id}/${provider}/${voiceId}` },
        capability: "voice-tts",
        provider,
        model: model.id,
        params: { voiceId, text: line.text },
        estimatedMicroUsd: estimateMicroUsd(model, { characters: line.text.length }),
        // Landed under its cache key, so reopening the picker replays without a call (R-10).
        landing: { dir: PREVIEW_CACHE_DIR, name },
      },
    };
  }

  /** Local dictation (R-17, R-18): loopback transcription; the text lands as editable input. */
  async dictate(requestId: string, audio: Uint8Array, contentType: string): Promise<void> {
    if (!this.deps.sidecar) {
      this.deps.emit({
        at: this.now(),
        type: "dictation.result",
        requestId,
        text: null,
        error: "Voxa is not running — dictation is off; typing still works",
      });
      return;
    }
    try {
      const text = await this.deps.sidecar.transcribe(audio, contentType);
      this.deps.emit({ at: this.now(), type: "dictation.result", requestId, text, error: null });
    } catch (err) {
      this.deps.emit({
        at: this.now(),
        type: "dictation.result",
        requestId,
        text: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * A dialogue-line dispatch (R-14, R-15): the voice is the sheet's — a retake keeps it by
 * construction, only the delivery params change. An inexpressible delivery is stated, and the
 * notice travels with the job rather than being silently dropped.
 */
export function voiceLineRequest(input: {
  worldId: string;
  productionId: string;
  shotId: string;
  sheet: Sheet;
  text: string;
  deliveryParams: Record<string, number> | null;
  deliveryNotice: string | null;
  model: ManifestModel;
}): EnqueueInput {
  const voice = input.sheet.voice;
  if (!voice) throw new Error(`${input.sheet.name} has no assigned voice — assign one on the sheet first`);
  return {
    worldId: input.worldId,
    productionId: input.productionId,
    target: { kind: "voice-line", id: input.shotId },
    capability: "voice-tts",
    provider: voice.provider,
    model: input.model.id,
    params: {
      voiceId: voice.voiceId,
      text: input.text,
      ...(input.deliveryParams !== null ? { voiceSettings: input.deliveryParams } : {}),
      ...(input.deliveryNotice !== null ? { deliveryNotice: input.deliveryNotice } : {}),
    },
    estimatedMicroUsd: estimateMicroUsd(input.model, { characters: input.text.length }),
    landing: { dir: `productions/${input.productionId}/audio` },
  };
}
