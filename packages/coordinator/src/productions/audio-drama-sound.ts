import { createHash } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import { join } from "node:path";
import { estimateMicroUsd, ulid, type Job, type ManifestModel } from "@arke-studio/contracts";
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
/**
 * What an automatic length is: priced at, and sent as (codex on PR 1872) — a length left to the
 * model could run three times what the quote said, with the ledger still holding the quote.
 */
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
  /** The queue's jobs that match, in any state: a sound paid for and landed but never filed. */
  jobs?: (match: (job: Job) => boolean) => Job[];
}
type Request = { model: ManifestModel; durationSec: number; loop: boolean; estimatedMicroUsd: number };

export type DramaSoundResult =
  | { disposition: "quoted"; quote: { token: string; estimatedMicroUsd: number;
      requests: Array<{ engine: string; prompt: string; durationSec?: number; loop?: boolean; estimatedMicroUsd: number }> } }
  | { disposition: "made"; artifactIds: string[]; reason?: string };

function plan(input: DramaSoundInput, models: readonly ManifestModel[]): Request[] {
  const find = (id: string) => {
    const model = models.find((candidate) => candidate.provider === "elevenlabs" && candidate.id === id);
    if (!model) throw new Error(`${id} is not available on this host`);
    // The row's own limit on what is sent (codex on PR 1872): refused here, never sent to fail there.
    const most = model.limits.maxPromptChars;
    if (most !== undefined && input.prompt.length > most) throw new Error(`What's sent is ${input.prompt.length} characters; ${model.displayName} takes ${most}.`);
    return model;
  };
  if (input.cue === "music") {
    const model = find(MUSIC_MODEL);
    if (input.durationSec !== null && (input.durationSec < 3 || input.durationSec > 300)) throw new Error("music is 3 seconds to 5 minutes here");
    const durationSec = input.durationSec ?? AUTOMATIC_MUSIC_SECONDS;
    return [{ model, durationSec, loop: false, estimatedMicroUsd: estimateMicroUsd(model, { durationSec }) }];
  }
  const model = find(SOUND_MODEL);
  if (input.cue === "ambience") {
    return AMBIENCE_LOOPS.map((seconds) => ({ model, durationSec: seconds, loop: true, estimatedMicroUsd: estimateMicroUsd(model, { durationSec: seconds }) }));
  }
  // No request is ever more than 30 seconds (R-39): a longer one is refused, never cut short.
  if (input.durationSec !== null && (input.durationSec < 0.5 || input.durationSec > 30)) throw new Error("a sound is 0.5 to 30 seconds");
  const durationSec = input.durationSec ?? AUTOMATIC_SOUND_SECONDS;
  return [{ model, durationSec, loop: input.loop === true, estimatedMicroUsd: estimateMicroUsd(model, { durationSec }) }];
}

export async function generateDramaSound(store: WorldStore, productionId: string, input: DramaSoundInput, deps: DramaSoundDeps): Promise<DramaSoundResult> {
  if (!store.getBundle().productions.some((production) => production.meta.id === productionId)) throw new Error("that production is no longer in this world");
  const requests = plan(input, deps.models);
  const shown = requests.map((request) => ({
    engine: request.model.displayName, prompt: input.prompt,
    durationSec: request.durationSec,
    ...(request.loop ? { loop: true } : {}), estimatedMicroUsd: request.estimatedMicroUsd,
  }));
  const token = createHash("sha256").update(JSON.stringify([deps.worldId, productionId, input.cue, input.name, shown])).digest("hex");
  const estimatedMicroUsd = requests.reduce((sum, request) => sum + request.estimatedMicroUsd, 0);
  if (input.quoteOnly || input.quoteToken !== token) return { disposition: "quoted", quote: { token, estimatedMicroUsd, requests: shown } };

  const artifactIds: string[] = [];
  for (const [index, request] of requests.entries()) {
    const music = request.model.capability === "music";
    const params = music
      ? { prompt: input.prompt, durationSec: request.durationSec }
      : { text: input.prompt, durationSec: request.durationSec, ...(request.loop ? { loop: true } : {}) };
    // A sound paid for and landed but never filed — the process stopped between — is filed now
    // rather than bought again (codex on PR 1872).
    const recovered = await landedUnfiled(store, productionId, request, params, deps);
    const jobId = recovered?.id ?? await deps.enqueue({
      worldId: deps.worldId,
      productionId,
      target: { kind: "drama-sound", id: `${input.cue}/${input.name}` },
      capability: music ? "music" : "sound-effect",
      provider: "elevenlabs",
      model: request.model.id,
      params,
      estimatedMicroUsd: request.estimatedMicroUsd,
      // Unique per request (codex on PR 1872): two presses in one millisecond never share a file.
      landing: { dir: `.staging/drama-sound/${productionId}`, name: `${ulid()}-${index}.mp3` },
    });
    const job = recovered ?? await deps.waitForJob(jobId);
    if (job.status !== "succeeded" || job.landedFiles?.[0] === undefined) {
      const why = job.status === "cancelled" ? "stopped" : "the sound job failed · open Activity for details";
      // A loop already made is paid for and kept (codex on PR 1872): placed, and the rest said.
      if (artifactIds.length > 0) return { disposition: "made", artifactIds, reason: `The second loop was not made (${why}). The first is kept.` };
      throw new Error(why);
    }
    const landed = join(store.dir, fromPortable(job.landedFiles[0]));
    const artifact = await fileGeneratedArtifact(store, {
      sourcePath: landed,
      production: productionId,
      generation: {
        source: "sound", jobId: job.id as never, productionId, name: requests.length > 1 ? `${input.name} ${request.durationSec} s` : input.name,
        cue: input.cue, heard: input.heard, prompt: input.prompt, provider: "elevenlabs", model: request.model.id,
        durationSec: request.durationSec, ...(request.loop ? { loop: true } : {}),
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

/** A succeeded job for exactly this request whose landed file is still there and filed by no artifact. */
async function landedUnfiled(store: WorldStore, productionId: string, request: Request, params: Record<string, unknown>, deps: DramaSoundDeps): Promise<Job | null> {
  const filed = new Set(store.getBundle().artifacts.flatMap((artifact) => artifact.generation?.source === "sound" && artifact.generation.jobId ? [artifact.generation.jobId] : []));
  const same = (job: Job) => job.status === "succeeded" && job.target.kind === "drama-sound" && job.worldId === deps.worldId &&
    job.productionId === productionId && job.provider === "elevenlabs" && job.model === request.model.id && !filed.has(job.id) &&
    JSON.stringify(Object.keys(params).sort().map((key) => [key, job.params[key]])) === JSON.stringify(Object.keys(params).sort().map((key) => [key, params[key]]));
  for (const job of [...(deps.jobs?.(same) ?? [])].reverse()) {
    const landed = job.landedFiles?.[0];
    if (landed && await access(toExtendedLength(join(store.dir, fromPortable(landed)))).then(() => true, () => false)) return job;
  }
  return null;
}
