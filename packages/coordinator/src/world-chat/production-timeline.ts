import { applyTimelineCommands, assembleSceneCommands, detachAudioCommands, sourceLengthFramesFor, ModelEditorRequestSchema,
  ulid, AUDIO_TRACK_KINDS, type ModelWorldChatAction, type ModelEditorRequest, type WorldChatPreparedAction,
  type ConversationActionCard, type ArkeGenerationBody, type ArkeCommandBodySchema } from "@arke-studio/contracts";
import { z } from "zod";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../world/atomic.js";
import { ConversationActionIdSchema } from "@arke-studio/contracts";
import { conversationActionDigest } from "../arke-actions/digest.js";
import type { ConversationActionExecutionOutcome } from "../arke-actions/lifecycle.js";
import { WorldStateStaleError, type WorldStore } from "../world/store.js";
import { requestBase } from "../productions/editor-requests.js";
import { applyTimelineCommand } from "../productions/timeline.js";
import { validateDialogueTranscription, draftDialogueSubtitles, type TranscriptionPorts } from "../productions/transcription.js";
import { hashAudioFile } from "../audio/media-tools.js";
import { audioWorldPath } from "../audio/storage.js";

type Action = Extract<ModelWorldChatAction, { kind: "production-timeline-operation" }>;
type Prepared = Extract<WorldChatPreparedAction, { kind: "world-chat-production-timeline-operation" | "world-chat-production-timeline-transcribe" }>;
const SourceQuoteSchema = z.object({ frozenHash: z.string().min(1), sources: z.array(z.object({ path: z.string().min(1), hash: z.string().min(1) }).strict()).max(500) }).strict();
const sourceQuotePath = (store: WorldStore, actionId: string) => join(store.dir, ".history", "timeline-transcription", "prepared", `${ConversationActionIdSchema.parse(actionId)}.json`);
export async function discardProductionTranscriptionQuote(store: WorldStore, actionId: string): Promise<void> {
  await rm(sourceQuotePath(store, actionId), { force: true });
}
export const historyDigestFromCommitSource = (source: string | undefined): string | undefined => source?.match(/^(?:undo|redo):(sha256:[0-9a-f]{64})$/)?.[1];
function productionFor(store: WorldStore, id: string) {
  const production = store.getBundle().productions.find(p => p.meta.id === id);
  if (!production) throw new Error("This production is unavailable.");
  return production;
}
/** The whole semantic input, including selected sources and history, rather than revision alone. */
export function freezeProductionTimeline(store: WorldStore, id: string): string {
  return conversationActionDigest({ production: productionFor(store, id), artifacts: store.getBundle().artifacts });
}
export function productionHistoryDigest(store: WorldStore, action: Action): string | undefined {
  const request = action.request;
  if (request.operation !== "undo" && request.operation !== "redo") return undefined;
  const state = productionFor(store, action.productionId).timeline;
  const entry = state?.status === "ready" ? state.timeline.history[request.operation].at(-1) : undefined;
  if (!entry) throw new Error(`There is nothing to ${request.operation}.`);
  return conversationActionDigest(entry);
}

/** SPEC-051 R-32/R-34: compile conveniences into the ordinary, atomically approved editor request. */
export function compileProductionTimelineRequest(store: WorldStore, action: Action, actionId = ulid()): ModelEditorRequest {
  const production = productionFor(store, action.productionId);
  const base = requestBase(store, production);
  const request = action.request;
  const suffix = actionId.replace(/^act_/, "");
  const commands: ModelEditorRequest["commands"] = [];
  let summary: string;
  if (request.operation === "assemble") {
    if (production.spine) throw new Error("Scene assembly is for a story timeline; this production follows a master song.");
    if (new Set(request.sceneIds).size !== request.sceneIds.length) throw new Error("Name each scene once, in the desired order.");
    let timeline = base.timeline;
    const titles: string[] = [];
    for (const sceneId of request.sceneIds) {
      const result = assembleSceneCommands({ production, timeline, sceneId, artifacts: store.getBundle().artifacts });
      if ("refused" in result) throw new Error(result.refused);
      commands.push(...result.commands);
      if (commands.length > 50) throw new Error("This assembly exceeds 50 editor commands. Ask for fewer scenes per card.");
      timeline = applyTimelineCommands(timeline, result.commands);
      titles.push(production.scenes.find(s => s.id === sceneId)!.title);
    }
    summary = `Assemble scenes in order: ${titles.join(" → ")}`;
  } else if (request.operation === "overlay-place") {
    const track = base.timeline.tracks.find(t => t.id === request.trackId);
    if (track?.kind !== "picture") throw new Error("Place a picture overlay on a named picture track.");
    const artifact = store.getBundle().artifacts.find(a => a.id === request.artifactId && !a.retiredAt && (!a.production || a.production === action.productionId));
    if (!artifact || !["image", "video", "board"].includes(artifact.kind)) throw new Error("Choose an available picture artifact in this production.");
    const clip = { id: `cl_overlay_${suffix}` as const, source: { kind: "artifact" as const, artifactId: artifact.id, label: artifact.file },
      startFrame: request.startFrame, durationFrames: request.durationFrames, sourceInFrames: request.sourceInFrames, gainDb: 0, audio: "keep" as const };
    const available = artifact.kind === "video" ? sourceLengthFramesFor(production, store.getBundle().artifacts)(clip) : undefined;
    if (available !== undefined && clip.sourceInFrames + clip.durationFrames > available) throw new Error("The overlay window extends beyond the measured video. Choose a shorter window or earlier source in.");
    commands.push({ kind: "place", trackId: request.trackId, clip });
    summary = `Place ${artifact.file} at frame ${request.startFrame}`;
  } else if ("clipId" in request) {
    const track = base.timeline.tracks.find(t => t.clips.some(c => c.id === request.clipId));
    const clip = track?.clips.find(c => c.id === request.clipId);
    if (track?.kind !== "picture" || clip?.source.kind !== "artifact") throw new Error("Choose a picture overlay artifact clip.");
    summary = `${request.operation.replaceAll("-", " ")}: ${clip.source.label ?? clip.id}`;
    if (request.operation === "overlay-move") commands.push({ kind: "move-to-frame", clipId: clip.id, startFrame: request.startFrame });
    else if (request.operation === "overlay-remove") commands.push({ kind: "delete", clipId: clip.id });
    else if (request.operation === "overlay-split-audio") {
      // A new neutral audio track preserves the overlay sound's role instead of adopting an
      // unrelated music/dialogue track's default; rejoin can then verify the unchanged twin.
      const split = detachAudioCommands(production, base.timeline, store.getBundle().artifacts, clip.id, `cl_overlay_audio_${suffix}`, true);
      if (split.some(c => c.kind === "detach-audio")) throw new Error("Audio split must resolve to ordinary editor commands.");
      commands.push(...split as ModelEditorRequest["commands"]);
    } else if (request.operation === "overlay-rejoin-audio") {
      const audioTrack = base.timeline.tracks.find(t => t.clips.some(c => c.id === request.audioClipId));
      const audio = audioTrack?.clips.find(c => c.id === request.audioClipId);
      if (!audioTrack || !AUDIO_TRACK_KINDS.has(audioTrack.kind) || audioTrack.muted || audioTrack.solo || audio?.source.kind !== "artifact" || audio.source.artifactId !== clip.source.artifactId ||
        audio.startFrame !== clip.startFrame || audio.durationFrames !== clip.durationFrames || audio.sourceInFrames !== clip.sourceInFrames ||
        (audio.gainDb ?? 0) !== (clip.gainDb ?? 0) || (audio.role ?? "unspecified") !== (clip.role ?? "unspecified") || audio.audio === "mute" || clip.audio !== "mute") throw new Error("Rejoin requires the unchanged audio twin of this muted overlay. Independently edited audio must be kept.");
      commands.push({ kind: "set-clip-audio", clipId: clip.id, audio: "keep" }, { kind: "delete", clipId: audio.id });
      if (audioTrack.clips.length === 1 && !(audioTrack.cues?.length)) commands.push({ kind: "remove-track", trackId: audioTrack.id });
    }
  } else throw new Error("Transcription and history use their own approval card.");
  return ModelEditorRequestSchema.parse({ summary: summary.slice(0, 500), commands });
}

export async function productionTimelineBody(store: WorldStore, prepared: Prepared, ports: TranscriptionPorts, actionId: string): Promise<ArkeGenerationBody | z.infer<typeof ArkeCommandBodySchema>> {
  if (freezeProductionTimeline(store, prepared.action.productionId) !== prepared.frozenHash) throw new Error("The timeline, sources or history changed. Prepare a fresh card.");
  const production = productionFor(store, prepared.action.productionId);
  if (production.timeline?.status !== "ready") throw new Error("This operation needs a saved timeline.");
  const request = prepared.action.request;
  if (request.operation === "transcribe") {
    if (!ports.transcribe) throw new Error("Local Voxa speech-to-text is unavailable in this host.");
    const { dialogue, plan } = validateDialogueTranscription(store, production.meta.id, request.trackId, request.language, ports);
    const paths = [...new Set(dialogue.map(clip => plan.audio.find(item => item.clipId === clip.id)!.path))];
    if (paths.length > 500) throw new Error("This transcription exceeds 500 source files. Prepare a smaller dialogue cut first.");
    const sources = await Promise.all(paths.map(async path => ({ path, hash: (await hashAudioFile(await audioWorldPath(store.dir, path), store.closingSignal)).hash })));
    const quote = SourceQuoteSchema.parse({ frozenHash: prepared.frozenHash, sources });
    const quotePath = sourceQuotePath(store, actionId);
    const raw = await readFile(quotePath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (raw !== null && conversationActionDigest(SourceQuoteSchema.parse(JSON.parse(raw))) !== conversationActionDigest(quote)) throw new Error("The approved dialogue source bytes changed.");
    if (raw === null) await store.ownedWrite(() => atomicWriteFile(quotePath, `${JSON.stringify(quote, null, 2)}\n`));
    return { family: "generation", medium: "document", purpose: "Draft subtitles from dialogue", prompt: "Transcribe only the audible dialogue windows in this cut.",
      provider: "Local Voxa", model: "Voxa speech-to-text", references: dialogue.map(c => ({ id: c.id, role: `Audible dialogue · frames ${c.startFrame}–${c.startFrame + c.durationFrames} · source in ${plan.audio.find(item => item.clipId === c.id)!.sourceInSec}s` })), quantity: dialogue.length,
      options: [{ label: "Subtitle track", value: request.trackId }, { label: "Language", value: request.language }],
      output: "Editable subtitle cues, cited to their dialogue clips, in one undoable timeline revision.", privacy: ["Audio is processed by the local Voxa sidecar. No provider upload or network transcription request."],
      cost: "$0 provider charge · local compute", estimatedMicroUsd: 0, currency: "USD", enforceableCapMicroUsd: 0, estimateMayVary: false,
      quoteDigest: conversationActionDigest(quote),
      cancellationSupported: false, deterministicInputs: [`Timeline r${production.timeline.timeline.revision}`, `${sources.length} immutable source files`] };
  }
  if (request.operation !== "undo" && request.operation !== "redo") throw new Error("Use an editor request for assembly and overlays.");
  const entry = production.timeline.timeline.history[request.operation].at(-1);
  if (!entry) throw new Error(`There is nothing to ${request.operation}.`);
  const label = entry.kind === "change" ? entry.label : `Move ${entry.clipId} ${entry.direction}`;
  return { family: "command", commands: [{ label: `${request.operation === "undo" ? "Undo" : "Redo"} ${label}`.slice(0,200), detail: `Exactly this history entry at timeline r${production.timeline.timeline.revision}` }],
    expectedResult: `${request.operation === "undo" ? "Restore the state before" : "Reapply"} “${label}” as one native history operation.`, undoAvailable: true };
}

export async function executeProductionTimeline(store: WorldStore, prepared: Prepared, card: ConversationActionCard, ports: TranscriptionPorts): Promise<ConversationActionExecutionOutcome> {
  const body = await productionTimelineBody(store, prepared, ports, card.actionId);
  if (conversationActionDigest(body) !== conversationActionDigest(card.shown.body)) return { status: "stale", detail: "The approved timeline operation or dialogue quote changed. Prepare a fresh card." };
  const production = productionFor(store, prepared.action.productionId);
  if (production.timeline?.status !== "ready") throw new Error("The saved timeline is unavailable.");
  const request = prepared.action.request;
  const quote = request.operation === "transcribe" ? SourceQuoteSchema.parse(JSON.parse(await readFile(sourceQuotePath(store, card.actionId), "utf8"))) : null;
  const validate = async () => {
    if (freezeProductionTimeline(store, production.meta.id) !== prepared.frozenHash) throw new WorldStateStaleError("The approved timeline changed before it could be written.");
    for (const source of quote?.sources ?? []) if ((await hashAudioFile(await audioWorldPath(store.dir, source.path), store.closingSignal)).hash !== source.hash) throw new WorldStateStaleError("The approved dialogue bytes changed before they could be written.");
  };
  if (request.operation === "transcribe") {
    const commands = await draftDialogueSubtitles(store, production.meta.id, request.trackId, request.language, ports);
    await applyTimelineCommand(store, production.meta.id, { kind: "commands", commands, baseRevision: production.timeline.timeline.revision,
      sourceFingerprint: requestBase(store, production).sourceFingerprint, requestId: card.actionId, label: "Draft subtitles from dialogue" }, validate);
  } else if (request.operation === "undo" || request.operation === "redo") {
    await applyTimelineCommand(store, production.meta.id, { kind: request.operation, baseRevision: production.timeline.timeline.revision, requestId: card.actionId,
      expectedEntryDigest: prepared.historyEntryDigest }, validate);
  } else throw new Error("This operation needs the editor request authority.");
  return { status: "completed", receipt: { kind: request.operation === "transcribe" ? "timeline-command" : "timeline-history", id: card.actionId,
    ...(prepared.historyEntryDigest ? { digest: prepared.historyEntryDigest } : {}),
    summary: request.operation === "transcribe" ? "Editable local subtitle drafts were added to the timeline." : `The named ${request.operation} completed.` } };
}
