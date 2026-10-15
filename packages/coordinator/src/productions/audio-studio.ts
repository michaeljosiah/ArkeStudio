import { createHash } from "node:crypto";
import {
  AudioArrangementRefusal, audiobookTextHash, DEFAULT_NARRATOR, editAudioArrangement,
  initialAudioArrangement, migrateAudioArrangement, resolveAudioArrangement, validateAudioArrangement,
  type AudioArrangement, type AudioArrangementEdit, type AudioArrangementState, type AudioScript,
  type AudioSource, type AudioStudioSnapshot, type ChapterAudiobook,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { FfmpegRunner } from "../takes/export.js";
import { planAudiobook, readAudiobook, updateAudiobook, type AudiobookPlan } from "./audiobook.js";
import { chapterTiming } from "./audiobook-timing.js";
import { readAudioStudioSource } from "./audio-studio-source.js";
import { AUDIO_STUDIO_SOURCE_BYTES } from "./audio-studio-source.js";
import { readContainedMediaBytes } from "../world/reference-files.js";
import { effectiveAudioRights, readAudioRights } from "../audio/rights.js";

type Options = { ffmpeg?: FfmpegRunner; signal?: AbortSignal };
const scopedOptions = (store: WorldStore, options: Options): Options => ({ ...options, signal: options.signal ? AbortSignal.any([store.closingSignal, options.signal]) : store.closingSignal });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function audioStudioScript(plan: AudiobookPlan): AudioScript {
  return { hash: plan.chapter.hash, passages: plan.blocks.map(({ block }) => ({ key: block.key, textHash: audiobookTextHash(block.text) })) };
}
/** Includes the record and the cast/book-derived passage structure, not merely a revision number. */
function baseOf(plan: AudiobookPlan): string {
  return digest({ chapter: plan.chapter.hash, record: plan.record, book: plan.book, blocks: plan.blocks.map(({ block }) => block) });
}
async function currentPlan(store: WorldStore, productionId: string, chapterId: string): Promise<AudiobookPlan> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: DEFAULT_NARRATOR });
  if (plan.record === "unreadable") throw new AudioArrangementRefusal("The chapter's audio record is unreadable; restore it before opening Audio Studio");
  return plan;
}

/** Catalogue scope is checked before decoding; an arbitrary world path is not an audio asset. */
export function audioStudioLibrary(store: WorldStore, productionId: string) {
  return store.getBundle().artifacts.filter(artifact => artifact.kind === "audio" && artifact.retiredAt === undefined &&
    (artifact.production === undefined || artifact.production === productionId) &&
    (artifact.generation?.source !== "audiobook" || artifact.generation.productionId === productionId));
}
export async function audioStudioSource(store: WorldStore, productionId: string, file: string, options: Options & { expectedHash?: string } = {}): Promise<AudioSource> {
  options = { ...options, ...scopedOptions(store, options) };
  const artifact = audioStudioLibrary(store, productionId).find(entry => `artifacts/${entry.file}` === file);
  if (!artifact) throw new AudioArrangementRefusal("Choose an available audio asset from this production's library");
  const generation = artifact.generation;
  if (generation?.source === "audiobook" && generation.recording) {
    const recording = generation.recording;
    if (!effectiveAudioRights(await readAudioRights(store), recording.preparedHash, "recorded-take").some(event => event.id === recording.acknowledgementId)) throw new AudioArrangementRefusal("This recorded performance needs its clearance reviewed before placement");
  }
  const { source } = await readAudioStudioSource(store.dir, file, options);
  if (!source.hash.startsWith(artifact.hash)) throw new AudioArrangementRefusal("The library file changed since it was filed; import the replacement as a new asset");
  return { ...source, artifactId: artifact.id };
}
async function derivedState(store: WorldStore, plan: AudiobookPlan, options: Options): Promise<AudioArrangementState> {
  const timing = chapterTiming(store, plan, "skip");
  const files = new Set([...timing.bars.flatMap(bar => bar.segments.map(segment => segment.file)), ...timing.beds.map(bed => bed.source.file), ...timing.sounds.map(sound => sound.source.file)]);
  const sources = new Map<string, AudioSource>();
  // Decode sequentially so a long chapter cannot allocate every source at once.
  for (const file of files) sources.set(file, (await readAudioStudioSource(store.dir, file, options)).source);
  return migrateAudioArrangement(audioStudioScript(plan), timing, sources);
}
export async function openAudioStudio(store: WorldStore, productionId: string, chapterId: string, options: Options = {}) {
  options = scopedOptions(store, options);
  const plan = await currentPlan(store, productionId, chapterId);
  const saved = plan.record === null || plan.record === "unreadable" ? undefined : plan.record.arrangement;
  const state = saved ? validateAudioArrangement(saved.current) : await derivedState(store, plan, options);
  const script = audioStudioScript(plan);
  return { base: baseOf(plan), saved: saved ?? null, state, script,
    passages: plan.blocks.map(({ block }) => ({ key: block.key, text: block.text })),
    resolved: resolveAudioArrangement(state, script) };
}
export async function audioStudioSnapshot(store: WorldStore, productionId: string, chapterId: string, options: Options = {}): Promise<AudioStudioSnapshot> {
  const opened = await openAudioStudio(store, productionId, chapterId, options);
  const library = audioStudioLibrary(store, productionId).map(artifact => ({
    file: `artifacts/${artifact.file}`, artifactId: artifact.id,
    label: artifact.file.split("/").pop() ?? "Audio",
    ...(artifact.generation?.source === "audiobook" ? { block: artifact.generation.block, textHash: artifact.generation.textHash } : {}),
  }));
  return { base: opened.base, revision: opened.saved?.revision ?? 0, undo: opened.saved?.undo.at(-1)?.label ?? null,
    redo: opened.saved?.redo.at(-1)?.label ?? null, state: opened.state, script: { hash: opened.script.hash, passages: [...opened.script.passages] }, passages: opened.passages, library };
}

/** A client/Arke edit is one transaction through the same chapter lane as generated takes. */
export async function editAudioStudio(store: WorldStore, productionId: string, chapterId: string, base: string, edit: AudioArrangementEdit, options: Options = {}): Promise<ChapterAudiobook> {
  options = scopedOptions(store, options);
  const opened = await currentPlan(store, productionId, chapterId);
  if (baseOf(opened) !== base) throw new AudioArrangementRefusal("The chapter changed since this review; refresh Audio Studio and review the edit again");
  let expected: string | undefined;
  const changedSources = new Map<string, AudioSource>();
  const verify = async () => {
    options.signal?.throwIfAborted();
    const fresh = await currentPlan(store, productionId, chapterId);
    if (baseOf(fresh) !== expected) throw new AudioArrangementRefusal("The chapter changed while saving; review the edit again");
    for (const source of changedSources.values()) {
      const bytes = await readContainedMediaBytes(store.dir, source.file, options.signal, AUDIO_STUDIO_SOURCE_BYTES);
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== source.hash) throw new AudioArrangementRefusal("The audio source changed while saving; review it again");
      if (!audioStudioLibrary(store, productionId).some(artifact => `artifacts/${artifact.file}` === source.file)) throw new AudioArrangementRefusal("The audio source is no longer available in this production");
    }
  };
  return updateAudiobook(store, productionId, opened.chapter, async current => {
    const plan = await currentPlan(store, productionId, chapterId);
    if (baseOf(plan) !== base) throw new AudioArrangementRefusal("The chapter changed since this review; refresh Audio Studio and review the edit again");
    expected = baseOf(plan);
    const held: AudioArrangement = current.arrangement ?? initialAudioArrangement(await derivedState(store, plan, options), JSON.stringify(current));
    const next = editAudioArrangement(held, edit);
    if (next === held) return null;
    const script = audioStudioScript(plan);
    if (edit.kind === "commands") for (const command of edit.commands) {
      if (command.kind === "bind-passage" && (command.scriptHash !== script.hash || !script.passages.some(passage => passage.key === command.key && passage.textHash === command.textHash))) throw new AudioArrangementRefusal("The passage changed; choose it again");
      if (command.kind === "add-passage" && !script.passages.some(passage => passage.key === command.passage.key && passage.textHash === command.passage.textHash)) throw new AudioArrangementRefusal("That passage is no longer in this chapter");
      const source = command.kind === "add-clip" ? command.clip.source : command.kind === "replace-source" ? command.source : null;
      if (source) {
        const measured = await audioStudioSource(store, productionId, source.file, { ...options, expectedHash: source.hash });
        if (measured.samples !== source.samples || measured.rate !== source.rate || measured.channels !== source.channels || (source.artifactId !== undefined && measured.artifactId !== source.artifactId)) throw new AudioArrangementRefusal("The audio source changed; choose it again");
        changedSources.set(source.file, source);
      }
    }
    return { ...current, arrangement: next, updatedAt: store.now() };
  }, { requireReadable: true, beforeWrite: verify });
}

/** Used by export/publication captures to prove which authored arrangement they consumed. */
export async function audioStudioRevision(store: WorldStore, productionId: string, chapterFile: string): Promise<string | null> {
  const record = await readAudiobook(store, productionId, chapterFile);
  if (record === "unreadable") throw new AudioArrangementRefusal("The chapter's audio record is unreadable");
  return record?.arrangement ? digest(record.arrangement) : null;
}
