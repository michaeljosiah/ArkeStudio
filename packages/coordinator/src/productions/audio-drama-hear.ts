import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  DRAMA_NARRATOR, EpisodeTakesSchema, dramaLineHash, episodeScriptFile, episodeTakesFile, legacyVoiceModel, narrationQuotes, performanceNote, quoteSpeech,
  sheetSound, voiceFormatForModel,
  type AudiobookReader, type DramaRequest, type DramaTake, type EpisodeScriptBlock, type EpisodeTakes, type Job, type ManifestModel,
  type MissingVoiceChoice, type SpeechQuote,
} from "@arke-studio/contracts";
import { fileGeneratedArtifact } from "../artifacts/filing.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { speechConsentToken } from "../voice/quote.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { compareAudioTranscript } from "../audio/transcript-comparison.js";

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
}

type Spoken = Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>;
type Planned = { block: Spoken; voice: AudiobookReader; model: ManifestModel; text: string; instructions?: string;
  request: DramaRequest; quote: SpeechQuote | null; standIn: boolean };

export type DramaHearResult =
  | { disposition: "quoted"; quote: { token: string; estimatedMicroUsd: number; requests: DramaRequest[] }; missing: Array<{ speaker: string; name: string; blocks: string[] }> }
  | { disposition: "made"; made: string[] };

function readerModel(models: readonly ManifestModel[], voice: { provider: string; model?: string | undefined; voiceId: string }): ManifestModel | null {
  const id = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId);
  return models.find((model) => model.provider === voice.provider && model.id === id && model.capability === "voice-tts") ?? null;
}

export async function hearDramaLines(
  store: WorldStore,
  productionId: string,
  input: { episode: number; blocks: readonly string[]; quoteOnly?: boolean; quoteToken?: string; decisions?: Record<string, MissingVoiceChoice>; retake?: boolean },
  deps: DramaHearDeps,
): Promise<DramaHearResult> {
  const bundle = store.getBundle();
  const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
  if (!production) throw new Error("that production is no longer in this world");
  const script = production.episodeScripts?.find((entry) => entry.script.episode === input.episode)?.script;
  if (!script) throw new Error("this episode has no script yet");
  const wanted = new Set(input.blocks);
  const lines = script.blocks.filter((block): block is Spoken => wanted.has(block.id) && (block.kind === "dialogue" || block.kind === "narration"));
  if (lines.length === 0) throw new Error("no spoken lines are selected");
  const takes = production.episodeTakes?.find((entry) => entry.episode === input.episode);
  // The production's cast (R-55..R-58): a voice here wins over the character's, and each role's
  // note goes to its own request only — the narrator's version never reaches the actor's.
  const cast = production.audioDrama?.cast ?? {};
  const narrator = cast[DRAMA_NARRATOR]?.voice ?? deps.narrator;
  const roleNames: Record<string, string> = {};
  for (const sheet of bundle.sheets) if (sheet.type === "character" && !sheet.retired) roleNames[sheet.id] = sheet.name;
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
      note = [cast[DRAMA_NARRATOR]?.sound, ...quoted].filter(Boolean).join("\n") || undefined;
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
    const kept = takes?.lines[block.id]?.kept;
    const cached = !input.retake && kept !== undefined && kept.textHash === dramaLineHash(block) &&
      kept.voice.provider === voice.provider && kept.voice.model === voice.model && kept.voice.voiceId === voice.voiceId;
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
    const quote = cached ? null : quoteSpeech(model, text, { ...(instructions !== undefined ? { instructions } : {}), at: store.now() });
    planned.push({
      block, voice, model, text, ...(instructions !== undefined ? { instructions } : {}), quote, standIn,
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
  const made: string[] = [];
  for (const entry of planned) {
    if (entry.request.cached) continue;
    const take = await performLine(store, productionId, input.episode, script.version, entry, deps);
    await recordTake(store, productionId, input.episode, entry.block.id, take, input.retake === true);
    made.push(entry.block.id);
  }
  return { disposition: "made", made };
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
      block: entry.block.id, characterCount: entry.text.length, ...(entry.instructions !== undefined ? { instructions: entry.instructions } : {}) },
    estimatedMicroUsd: entry.quote?.expectedMicroUsd ?? 0,
    landing: { dir: `.staging/drama/${productionId}/${stem}`, name: `${entry.block.id}-${Date.now()}.${format}` },
  });
  const job = await deps.waitForJob(jobId);
  if (job.status !== "succeeded" || job.landedFiles?.[0] === undefined) throw new Error(job.status === "cancelled" ? "stopped" : "the voice job failed · open Activity for details");
  const landed = join(store.dir, fromPortable(job.landedFiles[0]));
  const bytes = new Uint8Array(await readFile(toExtendedLength(landed)));
  // A take that says other words waits for the author with what was heard (R-30); without a
  // transcriber on this machine the check is not made, and the take is kept as made.
  let misread: string | undefined;
  if (deps.transcribe) {
    try {
      const heard = await deps.transcribe(bytes, format === "wav" ? "audio/wav" : "audio/mpeg");
      const compared = compareAudioTranscript({ audioHash: `sha256:${sha256(Buffer.from(bytes)).replace(/^sha256:/, "")}`, authoredText: entry.block.words,
        transcriber: { id: "voxa-whisper", version: "runtime-unreported" }, observedText: heard });
      if (compared.status === "compared" && compared.result === "mismatch") misread = heard.slice(0, 2_000);
    } catch { /* an unavailable check is no verdict */ }
  }
  const textHash = dramaLineHash(entry.block);
  const artifact = await fileGeneratedArtifact(store, {
    sourcePath: landed,
    production: productionId,
    generation: {
      source: "audiobook", jobId: job.id as never, productionId, chapterId: stem, chapterVersion: scriptVersion, block: entry.block.id,
      paragraph: -1, textHash, provider: entry.model.provider, model: entry.model.id, voiceId: entry.voice.voiceId,
      ...(entry.voice.label ? { voiceLabel: entry.voice.label } : {}),
      ...(entry.block.kind === "dialogue" && !entry.standIn ? { sheetId: entry.block.speaker } : {}),
      parts: 1, characters: entry.text.length, estimatedMicroUsd: entry.quote?.expectedMicroUsd ?? 0, costMicroUsd: null, episode,
    },
  });
  await unlink(toExtendedLength(landed)).catch(() => {});
  return {
    artifactId: artifact.id, file: `artifacts/${artifact.file}`, textHash, voice: entry.voice,
    ...(entry.standIn ? { standIn: true } : {}), ...(misread !== undefined ? { misread } : {}),
    estimatedMicroUsd: entry.quote?.expectedMicroUsd ?? 0, madeAt: store.now(),
  };
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
export async function decideDramaTake(store: WorldStore, productionId: string, episode: number, block: string, keep: "new" | "kept"): Promise<void> {
  await writeTakes(store, productionId, episode, (takes) => {
    const line = takes.lines[block];
    if (!line?.waiting) throw new Error("no take is waiting on that line");
    const next = keep === "new" ? { kept: line.waiting } : line.kept ? { kept: line.kept } : {};
    return { ...takes, lines: { ...takes.lines, [block]: next } };
  });
}
