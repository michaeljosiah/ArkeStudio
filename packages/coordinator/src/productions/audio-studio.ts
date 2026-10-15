import { createHash } from "node:crypto";
import {
  AudioArrangementRefusal, audiobookTextHash, DEFAULT_NARRATOR, editAudioArrangement,
  initialAudioArrangement, migrateAudioArrangement, resolveAudioArrangement, validateAudioArrangement,
  type AudioArrangement, type AudioArrangementEdit, type AudioArrangementState, type AudioScript,
  AudioStudioProposalInputSchema, type AudioStudioProposalInput, type AudioStudioProposal,
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
  // Staging or declining a suggestion cannot invalidate its own reviewed audio base.
  const record = plan.record && plan.record !== "unreadable" ? { ...plan.record, audioStudioProposals: undefined } : plan.record;
  return digest({ chapter: plan.chapter.hash, record, book: plan.book, blocks: plan.blocks.map(({ block }) => block) });
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
/** Current catalogue scope and recorded-performance clearance remain live after placement. */
export async function audioStudioSourceProblems(store: WorldStore, productionId: string, state: { clips: readonly { source: AudioSource | null; label: string }[] }, verifyBytes = false): Promise<Map<string, string>> {
  const problems = new Map<string, string>(), library = audioStudioLibrary(store, productionId);
  const checked = new Set<string>();
  const rights = await readAudioRights(store);
  for (const clip of state.clips) if (clip.source) {
    const source = clip.source, artifact = library.find(entry => `artifacts/${entry.file}` === source.file);
    if (!artifact || source.artifactId && artifact.id !== source.artifactId || !source.hash.startsWith(artifact.hash)) { problems.set(source.file, `${clip.label}: the reviewed source is no longer available in this production`); continue; }
    const generation = artifact.generation;
    if (generation?.source === "audiobook" && generation.recording && !effectiveAudioRights(rights, generation.recording.preparedHash, "recorded-take").some(event => event.id === generation.recording!.acknowledgementId)) problems.set(source.file, `${clip.label}: recording clearance needs review`);
    if (verifyBytes && !checked.has(source.file)) {
      checked.add(source.file);
      try {
        const bytes = await readContainedMediaBytes(store.dir, source.file, store.closingSignal, AUDIO_STUDIO_SOURCE_BYTES);
        if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== source.hash) problems.set(source.file, `${clip.label}: the source changed; review a replacement`);
      } catch { store.closingSignal.throwIfAborted(); problems.set(source.file, `${clip.label}: the audio file is unavailable on this machine`); }
    }
  }
  return problems;
}
export async function audioStudioMedia(store: WorldStore, productionId: string, file: string, options: Options & { expectedHash?: string } = {}) {
  options = { ...options, ...scopedOptions(store, options) };
  const artifact = audioStudioLibrary(store, productionId).find(entry => `artifacts/${entry.file}` === file);
  if (!artifact) throw new AudioArrangementRefusal("Choose an available audio asset from this production's library");
  const generation = artifact.generation;
  if (generation?.source === "audiobook" && generation.recording) {
    const recording = generation.recording;
    if (!effectiveAudioRights(await readAudioRights(store), recording.preparedHash, "recorded-take").some(event => event.id === recording.acknowledgementId)) throw new AudioArrangementRefusal("This recorded performance needs its clearance reviewed before placement");
  }
  const { source, pcm } = await readAudioStudioSource(store.dir, file, options);
  if (!source.hash.startsWith(artifact.hash)) throw new AudioArrangementRefusal("The library file changed since it was filed; import the replacement as a new asset");
  return { source: { ...source, artifactId: artifact.id }, pcm };
}
export async function audioStudioSource(store: WorldStore, productionId: string, file: string, options: Options & { expectedHash?: string } = {}): Promise<AudioSource> {
  return (await audioStudioMedia(store, productionId, file, options)).source;
}
async function derivedState(store: WorldStore, productionId: string, plan: AudiobookPlan, options: Options): Promise<AudioArrangementState> {
  const timing = chapterTiming(store, plan, "skip");
  const files = new Set([...timing.bars.flatMap(bar => bar.segments.map(segment => segment.file)), ...timing.beds.map(bed => bed.source.file), ...timing.sounds.map(sound => sound.source.file)]);
  const sources = new Map<string, AudioSource>();
  // Decode sequentially so a long chapter cannot allocate every source at once.
  for (const file of files) sources.set(file, await audioStudioSource(store, productionId, file, options));
  return migrateAudioArrangement(audioStudioScript(plan), timing, sources);
}
export async function openAudioStudio(store: WorldStore, productionId: string, chapterId: string, options: Options = {}) {
  options = scopedOptions(store, options);
  const plan = await currentPlan(store, productionId, chapterId);
  const saved = plan.record === null || plan.record === "unreadable" ? undefined : plan.record.arrangement;
  const state = saved ? validateAudioArrangement(saved.current) : await derivedState(store, productionId, plan, options);
  const script = audioStudioScript(plan);
  return { base: baseOf(plan), saved: saved ?? null, state, script,
    proposals: plan.record && plan.record !== "unreadable" ? plan.record.audioStudioProposals ?? [] : [],
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
    redo: opened.saved?.redo.at(-1)?.label ?? null, state: opened.state, script: { hash: opened.script.hash, passages: [...opened.script.passages] }, passages: opened.passages, library, proposals: opened.proposals,
    unavailable: [...await audioStudioSourceProblems(store, productionId, opened.state, true)].map(([file, message]) => ({ file, message })) };
}

async function validateEditSources(store: WorldStore, productionId: string, script: AudioScript, edit: AudioArrangementEdit, options: Options): Promise<Map<string, AudioSource>> {
  const sources = new Map<string, AudioSource>();
  if (edit.kind === "commands") for (const command of edit.commands) {
    if (command.kind === "bind-passage" && (command.scriptHash !== script.hash || !script.passages.some(passage => passage.key === command.key && passage.textHash === command.textHash))) throw new AudioArrangementRefusal("The passage changed; choose it again");
    if (command.kind === "add-passage" && !script.passages.some(passage => passage.key === command.passage.key && passage.textHash === command.passage.textHash)) throw new AudioArrangementRefusal("That passage is no longer in this chapter");
    const source = command.kind === "add-clip" ? command.clip.source : command.kind === "replace-source" ? command.source : null;
    if (source) {
      const measured = await audioStudioSource(store, productionId, source.file, { ...options, expectedHash: source.hash });
      if (measured.samples !== source.samples || measured.rate !== source.rate || measured.channels !== source.channels || (source.artifactId !== undefined && measured.artifactId !== source.artifactId)) throw new AudioArrangementRefusal("The audio source changed; choose it again");
      sources.set(source.file, source);
    }
  }
  return sources;
}
export async function prepareAudioStudioPreview(store: WorldStore, productionId: string, chapterId: string, base: string, edit: AudioArrangementEdit | undefined, options: Options = {}) {
  options = scopedOptions(store, options);
  const opened = await openAudioStudio(store, productionId, chapterId, options);
  if (opened.base !== base) throw new AudioArrangementRefusal("The chapter changed since this review; refresh Audio Studio");
  const current = opened.saved ?? initialAudioArrangement(opened.state, "{}");
  const next = edit ? editAudioArrangement(current, edit) : current;
  if (edit) await validateEditSources(store, productionId, opened.script, edit, options);
  const unavailable = await audioStudioSourceProblems(store, productionId, next.current);
  return { state: next.current, script: opened.script, unavailable,
    verify: async () => {
      if (baseOf(await currentPlan(store, productionId, chapterId)) !== base) throw new AudioArrangementRefusal("The chapter changed during audition; refresh and listen again");
      const current = await audioStudioSourceProblems(store, productionId, next.current);
      if (JSON.stringify([...current]) !== JSON.stringify([...unavailable])) throw new AudioArrangementRefusal("Source availability changed during audition; listen again");
    } };
}

/** A client/Arke edit is one transaction through the same chapter lane as generated takes. */
export async function editAudioStudio(store: WorldStore, productionId: string, chapterId: string, base: string, edit: AudioArrangementEdit, options: Options & { proposal?: { id: string; version: number } } = {}): Promise<ChapterAudiobook> {
  options = scopedOptions(store, options);
  const opened = await currentPlan(store, productionId, chapterId);
  if (baseOf(opened) !== base) throw new AudioArrangementRefusal("The chapter changed since this review; refresh Audio Studio and review the edit again");
  let expected: string | undefined;
  let changedSources = new Map<string, AudioSource>();
  const verify = async () => {
    options.signal?.throwIfAborted();
    const fresh = await currentPlan(store, productionId, chapterId);
    if (baseOf(fresh) !== expected) throw new AudioArrangementRefusal("The chapter changed while saving; review the edit again");
    for (const source of changedSources.values()) {
      const bytes = await readContainedMediaBytes(store.dir, source.file, options.signal, AUDIO_STUDIO_SOURCE_BYTES);
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== source.hash) throw new AudioArrangementRefusal("The audio source changed while saving; review it again");
      if (!audioStudioLibrary(store, productionId).some(artifact => `artifacts/${artifact.file}` === source.file)) throw new AudioArrangementRefusal("The audio source is no longer available in this production");
    }
    const issues = await audioStudioSourceProblems(store, productionId, { clips: [...changedSources.values()].map(source => ({ source, label: source.label })) });
    if (issues.size) throw new AudioArrangementRefusal([...issues.values()].join("; "));
  };
  return updateAudiobook(store, productionId, opened.chapter, async current => {
    const plan = await currentPlan(store, productionId, chapterId);
    if (baseOf(plan) !== base) throw new AudioArrangementRefusal("The chapter changed since this review; refresh Audio Studio and review the edit again");
    expected = baseOf(plan);
    const held: AudioArrangement = current.arrangement ?? initialAudioArrangement(await derivedState(store, productionId, plan, options), JSON.stringify(current));
    const proposal = options.proposal ? current.audioStudioProposals?.find(entry => entry.id === options.proposal!.id) : undefined;
    if (options.proposal) {
      const offered = proposal?.versions.at(-1);
      if (!proposal || proposal.status !== "pending" || offered?.number !== options.proposal.version || offered.base !== base ||
        edit.kind !== "commands" || JSON.stringify(edit.commands) !== JSON.stringify(offered.commands) || edit.label !== offered.summary) {
        throw new AudioArrangementRefusal("This proposal changed or was already decided; refresh its review");
      }
    }
    const next = editAudioArrangement(held, edit);
    if (next === held) return null;
    changedSources = await validateEditSources(store, productionId, audioStudioScript(plan), edit, options);
    return { ...current, arrangement: next, updatedAt: store.now(), ...(proposal ? {
      audioStudioProposals: current.audioStudioProposals!.map(entry => entry.id === proposal.id ? { ...entry, status: "applied" as const, resultRevision: next.revision } : entry),
    } : {}) };
  }, { requireReadable: true, beforeWrite: verify });
}

export async function stageAudioStudioProposal(store: WorldStore, productionId: string, chapterId: string, actionId: string, input: AudioStudioProposalInput, options: Options = {}): Promise<AudioStudioProposal> {
  const proposal = AudioStudioProposalInputSchema.parse(input), plan = await currentPlan(store, productionId, chapterId);
  let staged: AudioStudioProposal | undefined;
  // Release of protection and deliberate omission are human decisions, never model claims.
  if (proposal.commands.some(command => command.kind === "protect-clip" || command.kind === "acknowledge-omission" || command.kind === "clear-omission" || command.kind === "omit-passage" && command.acknowledged)) throw new AudioArrangementRefusal("Arke cannot release protection or acknowledge omitted speech");
  await updateAudiobook(store, productionId, plan.chapter, async current => {
    const families = current.audioStudioProposals ?? [];
    const existing = families.find(entry => entry.versions.some(version => version.actionId === actionId));
    if (existing) { staged = existing; return null; }
    const fresh = await openAudioStudio(store, productionId, chapterId, options);
    if (fresh.base !== proposal.base) throw new AudioArrangementRefusal("The arrangement changed; read Audio Studio again before proposing");
    const family = proposal.family ? families.find(entry => entry.id === proposal.family!.id) : undefined;
    if (proposal.family && (!family || family.status !== "pending" || family.versions.at(-1)?.number !== proposal.family.version)) throw new AudioArrangementRefusal("This proposal was revised or decided. Keep Current remains in force");
    if (family && family.versions.length >= 20 || !family && families.length >= 100) throw new AudioArrangementRefusal("This chapter has reached its proposal history limit");
    const edit: AudioArrangementEdit = { kind: "commands", label: proposal.summary, commands: proposal.commands };
    editAudioArrangement(fresh.saved ?? initialAudioArrangement(fresh.state, "{}"), edit);
    await validateEditSources(store, productionId, fresh.script, edit, scopedOptions(store, options));
    const version = { actionId, number: (family?.versions.at(-1)?.number ?? 0) + 1, base: baseOf({ ...plan, record: current }), summary: proposal.summary, commands: proposal.commands };
    staged = { id: family?.id ?? actionId, status: "pending", versions: [...(family?.versions ?? []), version] };
    return { ...current, audioStudioProposals: family ? families.map(entry => entry.id === family.id ? staged! : entry) : [...families, staged] };
  }, { requireReadable: true, beforeWrite: async () => {
    if (baseOf(await currentPlan(store, productionId, chapterId)) !== proposal.base) throw new AudioArrangementRefusal("The arrangement changed while preparing the proposal");
  } });
  return staged!;
}

export async function decideAudioStudioProposal(store: WorldStore, productionId: string, chapterId: string, id: string, version: number, decision: "keep" | "apply", options: Options = {}): Promise<ChapterAudiobook> {
  const plan = await currentPlan(store, productionId, chapterId);
  const record = plan.record && plan.record !== "unreadable" ? plan.record : null;
  const family = record?.audioStudioProposals?.find(entry => entry.id === id), offered = family?.versions.at(-1);
  if (!family || family.status !== "pending" || !offered || offered.number !== version) throw new AudioArrangementRefusal("This proposal changed or was already decided; refresh its review");
  if (decision === "apply") return editAudioStudio(store, productionId, chapterId, offered.base, { kind: "commands", label: offered.summary, commands: offered.commands }, { ...options, proposal: { id, version } });
  return updateAudiobook(store, productionId, plan.chapter, current => {
    const latest = current.audioStudioProposals?.find(entry => entry.id === id);
    if (latest?.status !== "pending" || latest.versions.at(-1)?.number !== version) throw new AudioArrangementRefusal("This proposal changed; refresh its review");
    return { ...current, audioStudioProposals: current.audioStudioProposals!.map(entry => entry.id === id ? { ...entry, status: "kept" as const } : entry) };
  }, { requireReadable: true });
}

/** Used by export/publication captures to prove which authored arrangement they consumed. */
export async function audioStudioRevision(store: WorldStore, productionId: string, chapterFile: string): Promise<string | null> {
  const record = await readAudiobook(store, productionId, chapterFile);
  if (record === "unreadable") throw new AudioArrangementRefusal("The chapter's audio record is unreadable");
  return record?.arrangement ? digest(record.arrangement) : null;
}
