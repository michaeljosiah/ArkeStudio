import { access, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  DRAMA_NARRATOR, EpisodeTakesSchema, dramaLineHash, episodeScriptFile, episodeTakesFile, legacyVoiceModel, narrationQuotes, performanceNote,
  productionShape, quoteSpeech, sheetSound, textDigest, voiceFormatForModel, voiceSourceFor,
  type AudiobookReader, type ClonedVoice, type DramaRequest, type DramaTake, type EpisodeScriptBlock, type EpisodeTakes, type Job, type ManifestModel,
  type MissingVoiceChoice, type SpeechQuote,
} from "@arke-studio/contracts";
import { fileGeneratedArtifact } from "../artifacts/filing.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { speechConsentToken } from "../voice/quote.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { compareAudioTranscript } from "../audio/transcript-comparison.js";
import { oneAtATime } from "./audio-drama.js";

/**
 * Hear an audio drama's lines (SPEC-057 R-25..R-31, design turn 230g–i): each spoken line in its
 * speaker's voice, priced before anything is sent, and kept as a take. Nothing substitutes on its
 * own: a speaker with no voice is named back, and only the author's choice — the narrator stands
 * in, or the line is left out — lets the line be made. A line already performed for these words in
 * this voice is played, not sent again.
 */
export interface DramaHearDeps {
  worldId: string;
  narrator: AudiobookReader;
  models: readonly ManifestModel[];
  enqueue: (input: EnqueueInput) => Promise<string>;
  waitForJob: (jobId: string) => Promise<Job>;
  /** Local speech-to-text, when this machine has it: a take that says other words waits (R-30). */
  transcribe?: (bytes: Uint8Array, contentType: string) => Promise<string>;
  /** The settled charge for a job, where the ledger has one. */
  actualCost?: (jobId: string) => Promise<number | null>;
  /** The queue's jobs that match, in any state: a line still being made, or paid and not yet recorded. */
  jobs?: (match: (job: Job) => boolean) => Job[];
}

type Spoken = Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>;
type Planned = { block: Spoken; voice: AudiobookReader; model: ManifestModel; text: string; instructions?: string;
  request: DramaRequest; quote: SpeechQuote | null; standIn: boolean; cloned?: ClonedVoice };

export type DramaHearResult =
  | { disposition: "quoted"; quote: { token: string; estimatedMicroUsd: number; requests: DramaRequest[] }; missing: Array<{ speaker: string; name: string; blocks: string[] }> }
  | { disposition: "made"; made: string[]; reason?: string };

/** The most a narrator's combined note may be: within What's sent's own bound. */
const NARRATOR_NOTE_MAX = 1_500;

/** Lines being made in this process, by world, production, episode and block. */
const making = new Set<string>();

/** A job made for exactly this line: the same world, provider, model, voice, words and instructions. */
function lineJob(entry: Planned, productionId: string, deps: DramaHearDeps): (job: Job) => boolean {
  return (job) => job.target.kind === "voice-preview" && job.worldId === deps.worldId && job.productionId === productionId &&
    job.provider === entry.model.provider && job.model === entry.model.id && job.params["block"] === entry.block.id &&
    job.params["text"] === entry.text && job.params["voiceId"] === entry.voice.voiceId && (job.params["instructions"] ?? undefined) === entry.instructions;
}

function readerModel(models: readonly ManifestModel[], voice: { provider: string; model?: string | undefined; voiceId: string }): ManifestModel | null {
  const id = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId);
  return models.find((model) => model.provider === voice.provider && model.id === id && model.capability === "voice-tts") ?? null;
}

export async function hearDramaLines(
  store: WorldStore,
  productionId: string,
  input: { episode: number; blocks: readonly string[]; quoteOnly?: boolean; quoteToken?: string; decisions?: Record<string, MissingVoiceChoice>; retake?: boolean;
    /** The saved script the press was priced from: a line edited since is never performed in its old words. */
    scriptHash?: string },
  deps: DramaHearDeps,
): Promise<DramaHearResult> {
  const bundle = store.getBundle();
  const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
  if (!production) throw new Error("that production is no longer in this world");
  // Only an audio drama speaks its scripts (codex on PR 1871): stray script files on another kind are never spent on.
  if (!productionShape(production.meta).isAudioDrama) throw new Error(`${production.meta.title} is not an audio drama.`);
  const entry = production.episodeScripts?.find((candidate) => candidate.script.episode === input.episode);
  const script = entry?.script;
  if (!script) throw new Error("this episode has no script yet");
  // Fenced on the saved script (codex on PR 1871): the words heard are the words the author sees.
  if (input.scriptHash !== undefined && input.scriptHash !== entry!.hash) throw new Error("The script changed since this was priced. Hear it again once it is saved.");
  const wanted = new Set(input.blocks);
  const lines = script.blocks.filter((block): block is Spoken => wanted.has(block.id) && (block.kind === "dialogue" || block.kind === "narration"));
  if (lines.length === 0) throw new Error("no spoken lines are selected");
  const takes = production.episodeTakes?.find((entry) => entry.episode === input.episode);
  // The production's cast (R-55..R-58): a voice here wins over the character's, and each role's
  // note goes to its own request only — the narrator's version never reaches the actor's.
  const cast = production.audioDrama?.cast ?? {};
  const narrator = cast[DRAMA_NARRATOR]?.voice ?? deps.narrator;
  const roleNames: Record<string, string> = {};
  // A retired character the scripts still give lines keeps its narrator's version (codex on PR 1873).
  const scripted = new Set((production.episodeScripts ?? []).flatMap((entry) => entry.script.blocks.flatMap((block) => block.kind === "dialogue" ? [block.speaker] : [])));
  for (const sheet of bundle.sheets) if (sheet.type === "character" && (!sheet.retired || scripted.has(sheet.id))) roleNames[sheet.id] = sheet.name;
  for (const key of Object.keys(cast)) if (key !== DRAMA_NARRATOR) roleNames[key] ??= key;
  const missing = new Map<string, { speaker: string; name: string; blocks: string[] }>();
  const planned: Planned[] = [];
  for (const block of lines) {
    let voice: AudiobookReader | null = narrator;
    let standIn = false;
    let speakerName = "Narrator";
    let note: string | undefined;
    if (block.kind === "narration") {
      const quoted = narrationQuotes(block.words, roleNames).flatMap((key) => {
        const version = cast[key]?.narration ?? bundle.sheets.find((sheet) => sheet.id === key)?.narration?.trim();
        return version ? [`When quoting ${roleNames[key]}: ${version}`] : [];
      });
      // Bounded to what a request carries (codex on PR 1873): the narrator's own note first, then
      // each quoted role's version while it fits.
      let combined = cast[DRAMA_NARRATOR]?.sound ?? "";
      for (const part of quoted) if (`${combined}\n${part}`.length <= NARRATOR_NOTE_MAX) combined = combined ? `${combined}\n${part}` : part;
      note = combined || undefined;
    }
    if (block.kind === "dialogue") {
      const sheet = bundle.sheets.find((candidate) => candidate.id === block.speaker);
      speakerName = sheet?.name ?? block.speaker;
      note = cast[block.speaker]?.sound ?? sheetSound(sheet);
      const assigned = cast[block.speaker]?.voice ?? sheet?.voice;
      const model = assigned ? readerModel(deps.models, assigned) : null;
      voice = assigned && model ? { provider: assigned.provider, model: model.id, voiceId: assigned.voiceId, ...(assigned.label ? { label: assigned.label } : {}) } : null;
      if (voice === null) {
        const choice = input.decisions?.[block.speaker];
        if (choice === "leave-out") continue;
        if (choice === "narrator") { voice = narrator; standIn = true; note = undefined; }
        else {
          const entry = missing.get(block.speaker) ?? { speaker: block.speaker, name: speakerName, blocks: [] };
          entry.blocks.push(block.id);
          missing.set(block.speaker, entry);
          continue;
        }
      }
    }
    const model = readerModel(deps.models, voice);
    if (!model) throw new Error(`${speakerName}'s voice (${voice.provider} ${voice.model}) is not available on this host`);
    // A library clone is read with its recording (codex on PR 1871): the dispatcher supplies it
    // only to a job that says it carries a voice reference.
    const source = voiceSourceFor(bundle.clonedVoices ?? [], model.provider, model.id, voice.voiceId);
    if (source.kind === "missing-clone") throw new Error(`${speakerName}'s cloned voice has lost its recording. Choose another voice.`);
    const kept = takes?.lines[block.id]?.kept;
    // Direction is how, never what (R-13): a tag ahead of the words where the reader writes tags,
    // an instruction beside them where it takes one, and otherwise not sent — said so, by name.
    let text = block.words;
    let instructions: string | undefined;
    let direction: DramaRequest["direction"];
    if (block.direction) {
      const played = performanceNote(block.direction, model);
      if (played.mode === "tag") { text = `${played.tag} ${block.words}`; direction = { sent: "tag", text: played.tag }; }
      else if (played.mode === "instruction") { instructions = block.direction; direction = { sent: "instruction", text: block.direction }; }
      else direction = { sent: "not sent", reason: played.reason };
    }
    // The role's note rides as an instruction, ahead of the line's own, where the reader takes
    // one; a reader that takes tags keeps them for the line's direction, and says so.
    let noteSent: DramaRequest["note"];
    if (note) {
      if (performanceNote(note.slice(0, 300), model).mode === "instruction") {
        instructions = instructions === undefined ? note : `${note}\n${instructions}`;
        noteSent = { sent: "instruction", text: note };
      } else noteSent = { sent: "not sent", text: note, reason: "This reader takes no instruction." };
    }
    // A take is the line's only for the instruction it was read with (codex on PR 1873): a changed
    // How they sound or narrator's version is sent again. A take from before any note was read with
    // the direction alone. A stand-in is the line's only while it still stands in (codex on PR 1871).
    const keptWith = kept?.instructionsHash ?? textDigest(direction?.sent === "instruction" ? direction.text ?? "" : "");
    const cached = !input.retake && kept !== undefined && kept.textHash === dramaLineHash(block) && !!kept.standIn === standIn &&
      kept.voice.provider === voice.provider && kept.voice.model === voice.model && kept.voice.voiceId === voice.voiceId &&
      keptWith === textDigest(instructions ?? "");
    const quote = cached ? null : quoteSpeech(model, text, { ...(instructions !== undefined ? { instructions } : {}), at: store.now() });
    planned.push({
      block, voice, model, text, ...(instructions !== undefined ? { instructions } : {}), quote, standIn,
      ...(source.kind === "cloned" ? { cloned: source.voice } : {}),
      request: {
        block: block.id, speaker: speakerName, voice: voice.label ?? voice.voiceId, model: model.displayName, text,
        ...(direction ? { direction } : {}), ...(noteSent ? { note: noteSent } : {}), ...(standIn ? { standIn: true } : {}),
        estimatedMicroUsd: quote?.expectedMicroUsd ?? 0, cached,
      },
    });
  }
  const quotes = planned.flatMap((entry) => entry.quote ? [entry.quote] : []);
  const token = speechConsentToken(JSON.stringify([deps.worldId, productionId, input.episode, planned.map((entry) => [entry.block.id, entry.request])]), quotes);
  const estimatedMicroUsd = quotes.reduce((sum, quote) => sum + quote.expectedMicroUsd, 0);
  const priced = quotes.some((quote) => quote.unit === "token" && quote.authorisedMicroUsd > 0) || estimatedMicroUsd > 0;
  if (input.quoteOnly || missing.size > 0 || (priced && input.quoteToken !== token)) {
    return { disposition: "quoted", quote: { token, estimatedMicroUsd, requests: planned.map((entry) => entry.request) }, missing: [...missing.values()] };
  }
  // One making per line (codex on PR 1871): a second press, another window or a job still running
  // from before a restart is refused rather than paid for twice.
  const toMake = planned.filter((entry) => !entry.request.cached);
  const keys = toMake.map((entry) => `${deps.worldId}/${productionId}/${input.episode}/${entry.block.id}`);
  const busy = toMake.find((entry, i) => making.has(keys[i]!) ||
    (deps.jobs?.(lineJob(entry, productionId, deps)) ?? []).some((job) => !["succeeded", "failed", "cancelled"].includes(job.status)));
  if (busy) throw new Error(`${busy.request.speaker}'s line is already being made.`);
  for (const key of keys) making.add(key);
  const made: string[] = [];
  try {
    for (const entry of toMake) {
      try {
        // A paid retake is recovered too (codex on PR 1871): it waits beside the kept take, as made.
        const take = await recoverLine(store, productionId, input.episode, script.version, entry, deps)
          ?? await performLine(store, productionId, input.episode, script.version, entry, deps);
        await recordTake(store, productionId, input.episode, entry.block.id, take, input.retake === true);
        made.push(entry.block.id);
      } catch (err) {
        // Lines already made are kept and said (codex on PR 1871): paid for, and played.
        if (made.length === 0) throw err;
        return { disposition: "made", made, reason: `${made.length} of ${toMake.length} made; ${entry.request.speaker}'s line was not: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  } finally {
    for (const key of keys) making.delete(key);
  }
  return { disposition: "made", made };
}

/**
 * A line already paid for (codex on PR 1871): a job for these exact words in this voice that
 * succeeded before its take was recorded — the process stopped between the two. Its filed
 * artifact is taken up, or its landed file filed now, rather than sending the line again.
 */
async function recoverLine(store: WorldStore, productionId: string, episode: number, scriptVersion: number, entry: Planned, deps: DramaHearDeps): Promise<DramaTake | null> {
  // Matched by world and provider too (codex on PR 1871): a copied world's job is never this one's.
  const jobs = (deps.jobs?.(lineJob(entry, productionId, deps)) ?? []).filter((job) => job.status === "succeeded");
  if (jobs.length === 0) return null;
  const bundle = store.getBundle();
  const taken = new Set((bundle.productions.find((p) => p.meta.id === productionId)?.episodeTakes ?? [])
    .flatMap((takes) => Object.values(takes.lines).flatMap((line) => [line.kept?.artifactId, line.waiting?.artifactId])));
  for (const job of [...jobs].reverse()) {
    const filed = bundle.artifacts.find((artifact) => artifact.generation?.source === "audiobook" && artifact.generation.jobId === job.id);
    if (filed) {
      if (taken.has(filed.id)) continue;
      // Heard again for its words (codex on PR 1871): a filed misread still waits for the author.
      const bytes = await readFile(toExtendedLength(join(store.dir, "artifacts", filed.file))).then((data) => new Uint8Array(data), () => null);
      const misread = bytes ? await heardOtherWords(bytes, voiceFormatForModel(entry.model), entry, deps) : undefined;
      return {
        artifactId: filed.id, file: `artifacts/${filed.file}`, textHash: dramaLineHash(entry.block), instructionsHash: textDigest(entry.instructions ?? ""), voice: entry.voice,
        ...(entry.standIn ? { standIn: true } : {}), ...(misread !== undefined ? { misread } : {}),
        estimatedMicroUsd: entry.quote?.expectedMicroUsd ?? 0, madeAt: store.now(),
      };
    }
    const landed = job.landedFiles?.[0];
    if (landed && await access(toExtendedLength(join(store.dir, fromPortable(landed)))).then(() => true, () => false)) {
      return fileTake(store, productionId, episode, scriptVersion, entry, job, deps);
    }
  }
  return null;
}

/** One line spoken, landed, checked against its words and filed as a production artifact. */
async function performLine(store: WorldStore, productionId: string, episode: number, scriptVersion: number, entry: Planned, deps: DramaHearDeps): Promise<DramaTake> {
  const format = voiceFormatForModel(entry.model);
  const stem = episodeScriptFile(episode).replace(/\.json$/, "");
  const jobId = await deps.enqueue({
    worldId: deps.worldId,
    productionId,
    target: { kind: "voice-preview", id: `drama/${entry.model.provider}/${entry.model.id}/${entry.voice.voiceId}` },
    capability: "voice-tts",
    provider: entry.model.provider,
    model: entry.model.id,
    // Settled for the press waiting on it, as a heard audiobook block is (`purpose`, `hear`).
    params: { voiceId: entry.voice.voiceId, text: entry.text, audioFormat: format, purpose: "audiobook", hear: true, productionId,
      block: entry.block.id, characterCount: entry.text.length, ...(entry.instructions !== undefined ? { instructions: entry.instructions } : {}),
      ...(entry.cloned?.language !== undefined ? { language: entry.cloned.language } : {}) },
    ...(entry.cloned ? { voiceReference: true } : {}),
    estimatedMicroUsd: entry.quote?.expectedMicroUsd ?? 0,
    landing: { dir: `.staging/drama/${productionId}/${stem}`, name: `${entry.block.id}-${Date.now()}.${format}` },
  });
  const job = await deps.waitForJob(jobId);
  if (job.status !== "succeeded" || job.landedFiles?.[0] === undefined) throw new Error(job.status === "cancelled" ? "stopped" : "the voice job failed · open Activity for details");
  return fileTake(store, productionId, episode, scriptVersion, entry, job, deps);
}

/** A succeeded job's landed line: checked against its words, filed, and returned as a take. */
async function fileTake(store: WorldStore, productionId: string, episode: number, scriptVersion: number, entry: Planned, job: Job, deps: DramaHearDeps): Promise<DramaTake> {
  const format = voiceFormatForModel(entry.model);
  const stem = episodeScriptFile(episode).replace(/\.json$/, "");
  const landed = join(store.dir, fromPortable(job.landedFiles![0]!));
  const bytes = new Uint8Array(await readFile(toExtendedLength(landed)));
  const misread = await heardOtherWords(bytes, format, entry, deps);
  const textHash = dramaLineHash(entry.block);
  const artifact = await fileGeneratedArtifact(store, {
    sourcePath: landed,
    production: productionId,
    generation: {
      source: "audiobook", jobId: job.id as never, productionId, chapterId: stem, chapterVersion: scriptVersion, block: entry.block.id,
      paragraph: -1, textHash, provider: entry.model.provider, model: entry.model.id, voiceId: entry.voice.voiceId,
      ...(entry.voice.label ? { voiceLabel: entry.voice.label } : {}),
      ...(entry.block.kind === "dialogue" && !entry.standIn ? { sheetId: entry.block.speaker } : {}),
      // The settled charge where the ledger has one (codex on PR 1871); null only where it has none.
      parts: 1, characters: entry.text.length, estimatedMicroUsd: entry.quote?.expectedMicroUsd ?? 0,
      costMicroUsd: await deps.actualCost?.(job.id).catch(() => null) ?? null, episode,
    },
  });
  await unlink(toExtendedLength(landed)).catch(() => {});
  return {
    artifactId: artifact.id, file: `artifacts/${artifact.file}`, textHash, instructionsHash: textDigest(entry.instructions ?? ""), voice: entry.voice,
    ...(entry.standIn ? { standIn: true } : {}), ...(misread !== undefined ? { misread } : {}),
    estimatedMicroUsd: entry.quote?.expectedMicroUsd ?? 0, madeAt: store.now(),
  };
}

/**
 * What a take was heard to say, when it was not its line (R-30); without a transcriber on this
 * machine the check is not made, and the take is kept as made.
 */
async function heardOtherWords(bytes: Uint8Array, format: string, entry: Planned, deps: DramaHearDeps): Promise<string | undefined> {
  if (!deps.transcribe) return undefined;
  try {
    const heard = await deps.transcribe(bytes, format === "wav" ? "audio/wav" : format === "flac" ? "audio/flac" : "audio/mpeg");
    const compared = compareAudioTranscript({ audioHash: `sha256:${sha256(Buffer.from(bytes)).replace(/^sha256:/, "")}`, authoredText: entry.block.words,
      transcriber: { id: "voxa-whisper", version: "runtime-unreported" }, observedText: heard });
    return compared.status === "compared" && compared.result === "mismatch" ? heard.slice(0, 2_000) : undefined;
  } catch { return undefined; /* an unavailable check is no verdict */ }
}

/**
 * Where a new take goes (R-29, R-30). The first take of a line keeps itself; so does one made
 * because the kept take no longer matches the line. A retake of a current line, or a take heard
 * to say other words, waits for the author beside what is kept.
 */
export function placeTake(line: EpisodeTakes["lines"][string] | undefined, take: DramaTake, retake: boolean): EpisodeTakes["lines"][string] {
  const kept = line?.kept;
  const current = kept !== undefined && kept.textHash === take.textHash;
  if (take.misread !== undefined || (retake && current)) return { ...(kept ? { kept } : {}), waiting: take };
  return { kept: take };
}

async function writeTakes(store: WorldStore, productionId: string, episode: number, change: (takes: EpisodeTakes) => EpisodeTakes): Promise<void> {
  const path = `productions/${productionId}/drama-takes/${episodeTakesFile(episode)}`;
  return oneAtATime(`${store.dir}/${path}`, () => writeTakesNow(store, path, episode, change));
}
async function writeTakesNow(store: WorldStore, path: string, episode: number, change: (takes: EpisodeTakes) => EpisodeTakes): Promise<void> {
  const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8").catch(() => null);
  const current = live === null ? { version: 1 as const, episode, lines: {} } : EpisodeTakesSchema.parse(JSON.parse(live));
  const next = EpisodeTakesSchema.parse(change(current));
  await store.commit({ kind: "drama-takes", source: "audio-drama", files: [{
    path, action: live === null ? "create" : "replace", content: `${JSON.stringify(next, null, 2)}\n`, baseHash: live === null ? null : sha256(live),
  }] });
}

async function recordTake(store: WorldStore, productionId: string, episode: number, block: string, take: DramaTake, retake: boolean): Promise<void> {
  await writeTakes(store, productionId, episode, (takes) => ({ ...takes, lines: { ...takes.lines, [block]: placeTake(takes.lines[block], take, retake) } }));
}

/** The author's answer to a waiting take (R-30): the new one is kept, or the kept one stays. */
export async function decideDramaTake(store: WorldStore, productionId: string, episode: number, block: string, keep: "new" | "kept", waiting?: string): Promise<void> {
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
  if (!production || !productionShape(production.meta).isAudioDrama) throw new Error("that production is not an audio drama");
  await writeTakes(store, productionId, episode, (takes) => {
    const line = takes.lines[block];
    if (!line?.waiting) throw new Error("no take is waiting on that line");
    // Bound to the take the author heard (codex on PR 1871): a newer one waiting is not decided unheard.
    if (waiting !== undefined && line.waiting.artifactId !== waiting) throw new Error("no take is waiting on that line");
    const next = keep === "new" ? { kept: line.waiting } : line.kept ? { kept: line.kept } : {};
    return { ...takes, lines: { ...takes.lines, [block]: next } };
  });
}
