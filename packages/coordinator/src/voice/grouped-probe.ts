import { groupedText, packTurns, quoteGroupedSpeech, type AudiobookReader, type BlockTurns, type GroupPacking, type Job, type ManifestModel, type SpeechTurn } from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { wavSeconds } from "./library.js";

/**
 * The grouped-read probe (design turn 185): before any reader is marked groupable, the same few
 * consecutive blocks of a chapter read as one request three ways, so a person can choose by ear.
 *
 * Google's speech page shows several turns, each with its own `speech_metadata.style`, in one
 * request; it does not say a designed voice (`voice_…`) keeps each turn's style there, and it
 * rules designed voices out of multi-speaker. And heard back, blocks read one a request did not
 * run on from each other. So the probe sends (A) every turn with its whole style, as solo reads
 * would; (B) the notes once and each later turn only its own direction; (C) B with a run under
 * one direction merged into one turn. A transcript cannot hear a delivery, so each answers with
 * its length and the words this machine heard, and the files are kept for listening.
 */

export const PROBE_VARIANTS: ReadonlyArray<{ id: "A" | "B" | "C"; packing: GroupPacking }> = [
  { id: "A", packing: "full" },
  { id: "B", packing: "deltas" },
  { id: "C", packing: "merged" },
];

/** A block the probe reads: its key, who speaks it, its words, and its parts as a grouped request takes them. */
export interface ProbeBlock {
  key: string;
  who: string;
  text: string;
  turns: Pick<BlockTurns, "shared" | "parts">;
}

/**
 * Which blocks to read: from the one named, or else the first run of `count` after the title
 * that holds both a spoken line and narration — the case grouping must keep straight.
 */
export function probeWindow(blocks: ReadonlyArray<{ key: string; speaker?: string }>, count: number, from?: string): string[] {
  const body = blocks.filter((block) => block.key !== "title");
  if (from !== undefined) {
    const at = body.findIndex((block) => block.key === from);
    return at < 0 ? [] : body.slice(at, at + count).map((block) => block.key);
  }
  for (let at = 0; at + count <= body.length; at++) {
    const run = body.slice(at, at + count);
    if (run.some((block) => block.speaker !== undefined) && run.some((block) => block.speaker === undefined)) return run.map((block) => block.key);
  }
  return body.slice(0, count).map((block) => block.key);
}

export interface GroupedProbeDeps {
  worldId: string;
  productionId?: string;
  reader: AudiobookReader;
  model: ManifestModel | null;
  blocks: readonly ProbeBlock[];
  at: string;
  enqueue: (input: EnqueueInput) => Promise<string>;
  waitForJob: (jobId: string) => Promise<Job>;
  readLanded: (file: string) => Promise<Uint8Array>;
  /** The local transcriber, or null when none runs on this machine. */
  transcribe: ((bytes: Uint8Array, contentType: string) => Promise<string>) | null;
  actualCost: (jobId: string) => Promise<number | null>;
}

export interface ProbeVariant {
  id: "A" | "B" | "C";
  packing: GroupPacking;
  outcome: "succeeded" | "failed" | "not sent";
  turns: SpeechTurn[];
  jobId?: string;
  httpStatus?: number;
  reason?: string;
  seconds?: number;
  file?: string;
  transcript?: string;
  transcriptUnavailable?: string;
  costMicroUsd?: number | null;
}

export type GroupedProbeResult =
  | { outcome: "refused"; reason: string }
  | { outcome: "succeeded" | "failed"; blocks: Array<{ key: string; who: string; text: string }>; variants: ProbeVariant[] };

/** The status a failure names (`… (HTTP 400)`), or none when it names none. */
export function failureStatus(error: string | null | undefined): number | undefined {
  const status = typeof error === "string" ? /\bHTTP (\d{3})\b/.exec(error)?.[1] : undefined;
  return status === undefined ? undefined : Number(status);
}

export async function probeGroupedRead(deps: GroupedProbeDeps): Promise<GroupedProbeResult> {
  const { model, reader } = deps;
  if (model === null || model.provider !== "google" || model.capability !== "voice-tts" || model.pricing.kind !== "perToken") {
    return { outcome: "refused", reason: "the narrator is not a Gemini reader · choose one first" };
  }
  if (deps.blocks.length < 2) return { outcome: "refused", reason: "fewer than two blocks to read" };
  const stamp = deps.at.replace(/[^0-9]/g, "").slice(0, 14);
  const variants: ProbeVariant[] = [];
  let stopped: string | null = null;
  for (const variant of PROBE_VARIANTS) {
    const turns = packTurns(deps.blocks.map((block) => ({ key: block.key, reader: "probe", ...block.turns })), variant.packing).map(({ keys: _keys, ...turn }) => turn);
    // One refusal for the day or of the request answers for the rest: they are not sent.
    if (stopped !== null) {
      variants.push({ ...variant, outcome: "not sent", turns, reason: stopped });
      continue;
    }
    const text = groupedText(turns);
    const jobId = await deps.enqueue({
      worldId: deps.worldId,
      ...(deps.productionId !== undefined ? { productionId: deps.productionId } : {}),
      target: { kind: "voice-preview", id: `probe/${model.provider}/${model.id}/${reader.voiceId}` },
      capability: "voice-tts",
      provider: model.provider,
      model: model.id,
      params: {
        voiceId: reader.voiceId,
        text,
        turns,
        audioFormat: "wav",
        // Waited for as a heard block is, and kept out of a run's search for parts already paid for.
        purpose: "audiobook",
        hear: true,
        probe: `grouped-read/${variant.packing}`,
        ...(deps.productionId !== undefined ? { productionId: deps.productionId } : {}),
        characterCount: text.length,
      },
      estimatedMicroUsd: quoteGroupedSpeech(model, turns, { at: deps.at }).expectedMicroUsd,
      landing: { dir: `.staging/probes/${stamp}`, name: `${variant.id}-${variant.packing}.wav` },
    });
    const job = await deps.waitForJob(jobId);
    const costMicroUsd = await deps.actualCost(jobId).catch(() => null);
    const landed = job.landedFiles?.[0];
    if (job.status !== "succeeded" || landed === undefined) {
      const httpStatus = failureStatus(job.error);
      stopped = job.error ?? job.status;
      variants.push({ ...variant, outcome: "failed", turns, jobId, ...(httpStatus !== undefined ? { httpStatus } : {}), reason: stopped, costMicroUsd });
      continue;
    }
    const bytes = await deps.readLanded(landed);
    const seconds = wavSeconds(bytes);
    let transcript: string | undefined;
    let transcriptUnavailable: string | undefined;
    if (deps.transcribe === null) transcriptUnavailable = "no local transcriber";
    else {
      try {
        transcript = (await deps.transcribe(bytes, "audio/wav")).trim();
      } catch (error) {
        transcriptUnavailable = `transcription failed · ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    variants.push({
      ...variant,
      outcome: "succeeded",
      turns,
      jobId,
      // A completed interaction is the service's 200: anything else is a failure above.
      httpStatus: 200,
      ...(seconds !== null ? { seconds } : {}),
      file: landed,
      ...(transcript !== undefined ? { transcript } : {}),
      ...(transcriptUnavailable !== undefined ? { transcriptUnavailable } : {}),
      costMicroUsd,
    });
  }
  return {
    outcome: variants.every((variant) => variant.outcome === "succeeded") ? "succeeded" : "failed",
    blocks: deps.blocks.map((block) => ({ key: block.key, who: block.who, text: block.text })),
    variants,
  };
}
