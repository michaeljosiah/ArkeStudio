import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { estimateMicroUsd, type Job, type ManifestModel } from "@arke-studio/contracts";
import { fileGeneratedArtifact } from "../artifacts/filing.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";

/**
 * A sound for an audio drama's cue (SPEC-057 R-39..R-42, design turn 230x/y): priced before it is
 * sent, made by ElevenLabs, and saved as a production artifact every cue that wants it can place.
 * A sound is one request of up to 30 seconds; an ambience is two seamless loops of different
 * lengths, so a long scene never audibly repeats; music is Eleven Music.
 */
export const SOUND_MODEL = "eleven_text_to_sound_v2";
export const MUSIC_MODEL = "music_v1";
/** An ambience's two loops (R-42): 30 s and 23 s, which line up again only after 690 s. */
export const AMBIENCE_LOOPS = [30, 23] as const;
/** What an automatic length is priced at: a sound's typical length, said in What's sent. */
export const AUTOMATIC_SOUND_SECONDS = 10;
const AUTOMATIC_MUSIC_SECONDS = 30;

export interface DramaSoundInput {
  cue: "sound" | "ambience" | "music";
  heard: string;
  prompt: string;
  durationSec: number | null;
  loop?: boolean;
  name: string;
  quoteOnly?: boolean;
  quoteToken?: string;
}
export interface DramaSoundDeps {
  worldId: string;
  models: readonly ManifestModel[];
  enqueue: (input: EnqueueInput) => Promise<string>;
  waitForJob: (jobId: string) => Promise<Job>;
}
type Request = { model: ManifestModel; durationSec: number | null; loop: boolean; estimatedMicroUsd: number };

export type DramaSoundResult =
  | { disposition: "quoted"; quote: { token: string; estimatedMicroUsd: number;
      requests: Array<{ engine: string; prompt: string; durationSec?: number; loop?: boolean; estimatedMicroUsd: number }> } }
  | { disposition: "made"; artifactIds: string[] };

function plan(input: DramaSoundInput, models: readonly ManifestModel[]): Request[] {
  const find = (id: string) => {
    const model = models.find((candidate) => candidate.provider === "elevenlabs" && candidate.id === id);
    if (!model) throw new Error(`${id} is not available on this host`);
    return model;
  };
  if (input.cue === "music") {
    const model = find(MUSIC_MODEL);
    if (input.durationSec !== null && (input.durationSec < 3 || input.durationSec > 300)) throw new Error("music is 3 seconds to 5 minutes here");
    return [{ model, durationSec: input.durationSec, loop: false, estimatedMicroUsd: estimateMicroUsd(model, { durationSec: input.durationSec ?? AUTOMATIC_MUSIC_SECONDS }) }];
  }
  const model = find(SOUND_MODEL);
  if (input.cue === "ambience") {
    return AMBIENCE_LOOPS.map((seconds) => ({ model, durationSec: seconds, loop: true, estimatedMicroUsd: estimateMicroUsd(model, { durationSec: seconds }) }));
  }
  // No request is ever more than 30 seconds (R-39): a longer one is refused, never cut short.
  if (input.durationSec !== null && (input.durationSec < 0.5 || input.durationSec > 30)) throw new Error("a sound is 0.5 to 30 seconds");
  return [{ model, durationSec: input.durationSec, loop: input.loop === true,
    estimatedMicroUsd: estimateMicroUsd(model, { durationSec: input.durationSec ?? AUTOMATIC_SOUND_SECONDS }) }];
}

export async function generateDramaSound(store: WorldStore, productionId: string, input: DramaSoundInput, deps: DramaSoundDeps): Promise<DramaSoundResult> {
  if (!store.getBundle().productions.some((production) => production.meta.id === productionId)) throw new Error("that production is no longer in this world");
  const requests = plan(input, deps.models);
  const shown = requests.map((request) => ({
    engine: request.model.displayName, prompt: input.prompt,
    ...(request.durationSec !== null ? { durationSec: request.durationSec } : {}),
    ...(request.loop ? { loop: true } : {}), estimatedMicroUsd: request.estimatedMicroUsd,
  }));
  const token = createHash("sha256").update(JSON.stringify([deps.worldId, productionId, input.cue, input.name, shown])).digest("hex");
  const estimatedMicroUsd = requests.reduce((sum, request) => sum + request.estimatedMicroUsd, 0);
  if (input.quoteOnly || input.quoteToken !== token) return { disposition: "quoted", quote: { token, estimatedMicroUsd, requests: shown } };

  const artifactIds: string[] = [];
  for (const [index, request] of requests.entries()) {
    const music = request.model.capability === "music";
    const jobId = await deps.enqueue({
      worldId: deps.worldId,
      productionId,
      target: { kind: "drama-sound", id: `${input.cue}/${input.name}` },
      capability: music ? "music" : "sound-effect",
      provider: "elevenlabs",
      model: request.model.id,
      params: music
        ? { prompt: input.prompt, ...(request.durationSec !== null ? { durationSeconds: request.durationSec } : {}) }
        : { text: input.prompt, ...(request.durationSec !== null ? { durationSeconds: request.durationSec } : {}), ...(request.loop ? { loop: true } : {}) },
      estimatedMicroUsd: request.estimatedMicroUsd,
      landing: { dir: `.staging/drama-sound/${productionId}`, name: `${Date.now()}-${index}.mp3` },
    });
    const job = await deps.waitForJob(jobId);
    if (job.status !== "succeeded" || job.landedFiles?.[0] === undefined) throw new Error(job.status === "cancelled" ? "stopped" : "the sound job failed · open Activity for details");
    const landed = join(store.dir, fromPortable(job.landedFiles[0]));
    const artifact = await fileGeneratedArtifact(store, {
      sourcePath: landed,
      production: productionId,
      generation: {
        source: "sound", jobId: job.id as never, productionId, name: requests.length > 1 ? `${input.name} ${request.durationSec} s` : input.name,
        cue: input.cue, heard: input.heard, prompt: input.prompt, provider: "elevenlabs", model: request.model.id,
        ...(request.durationSec !== null ? { durationSec: request.durationSec } : {}), ...(request.loop ? { loop: true } : {}),
        outputFormat: "mp3_44100_128", estimatedMicroUsd: request.estimatedMicroUsd, costMicroUsd: null,
        // The ambience's second loop names the first: the cue places the first, and the mix finds both.
        ...(index > 0 && artifactIds[0] !== undefined ? { pair: artifactIds[0] as never } : {}),
      },
    });
    await unlink(toExtendedLength(landed)).catch(() => {});
    artifactIds.push(artifact.id);
  }
  return { disposition: "made", artifactIds };
}
