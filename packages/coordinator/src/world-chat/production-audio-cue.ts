import { AUDIO_TRACK_KINDS, framesToSeconds, type ArkeCommandBodySchema, type ConversationActionCard, type ModelEditorRequest,
  type TimelineClipSource, type WorldChatPreparedAction } from "@arke-studio/contracts";
import { readBenchSession } from "../bench/chat-reads.js";
import type { BenchChatControls } from "../bench/chat-controls.js";
import { audioWorldPath } from "../audio/storage.js";
import { hashAudioFile } from "../audio/media-tools.js";
import { readContainedAudioReferences } from "../world/reference-files.js";
import type { WorldStatePrecondition, WorldStore } from "../world/store.js";
import { stageEditorRequests, readEditorRequestByAction } from "../productions/editor-requests.js";
import type { ConversationActionExecutionOutcome } from "../arke-actions/lifecycle.js";
import { WorldChatStore, conversationDir } from "./store.js";
import { foldConversation } from "./fold.js";
import { sessionMediaDir } from "../bench/store.js";
import type { z } from "zod";
import type { MediaProbe } from "../media/probe.js";

type Prepared = Extract<WorldChatPreparedAction, { kind: "world-chat-production-audio-cue" }>;
export function freezeProductionAudioCue(store: WorldStore, productionId: string) {
  const timeline = store.getBundle().productions.find(p => p.meta.id === productionId)?.timeline;
  if (timeline?.status !== "ready" || !timeline.hash) throw new Error("Assemble the production timeline before placing a cue.");
  return { timelineRevision: timeline.timeline.revision, timelineHash: timeline.hash };
}
export function productionAudioCueBody(store: WorldStore, prepared: Prepared): z.infer<typeof ArkeCommandBodySchema> {
  const action = prepared.action;
  if (JSON.stringify(freezeProductionAudioCue(store, action.productionId)) !== JSON.stringify({ timelineRevision: prepared.timelineRevision, timelineHash: prepared.timelineHash })) throw new Error("The cue's timeline changed. Prepare a fresh placement.");
  const timeline = store.getBundle().productions.find(p => p.meta.id === action.productionId)!.timeline!;
  if (timeline.status !== "ready") throw new Error("The timeline is unavailable.");
  const track = timeline.timeline.tracks.find(t => t.id === action.trackId);
  if (!track || !AUDIO_TRACK_KINDS.has(track.kind)) throw new Error("Choose an existing audio track for this cue.");
  if (track.clips.some(clip => clip.startFrame < action.startFrame + action.durationFrames && clip.startFrame + clip.durationFrames > action.startFrame)) throw new Error("The cue overlaps another clip on this track. Choose a free range or edit that clip first.");
  return { family: "command", commands: [{ label: `Place ${action.role} cue`, detail: `${action.trackId} · frame ${action.startFrame} · ${action.durationFrames} frames · source in ${action.sourceInFrames} · ${action.gainDb} dB` },
    { label: "Source", detail: action.source.kind === "generation" ? `Result ${action.source.outputIndex + 1} from ${action.source.actionRef} (${prepared.sourceActionId})` : JSON.stringify(action.source) }],
    expectedResult: "File the chosen Bench result if needed and stage this exact placement as a human editor request. The timeline changes only when that request is accepted.", undoAvailable: true };
}
export async function executeProductionAudioCue(store: WorldStore, prepared: Prepared, card: ConversationActionCard,
  controls: BenchChatControls | undefined, precondition: WorldStatePrecondition, probe?: MediaProbe): Promise<ConversationActionExecutionOutcome> {
  const prior = await readEditorRequestByAction(store, prepared.action.productionId, card.actionId);
  if (prior) return { status: "completed", receipt: { kind: "editor-request", id: prior.id, summary: "Cue placement was staged for human review." } };
  productionAudioCueBody(store, prepared);
  const action = prepared.action;
  let source = action.source;
  if (source.kind === "generation") {
    if (!prepared.sourceActionId || !card.dependencies.includes(prepared.sourceActionId)) throw new Error("This cue has no approved generation dependency.");
    const log = new WorldChatStore(conversationDir(store.dir, card.conversationId));
    const meta = await log.readMeta(), read = await log.read();
    if (!meta || read.problems.length) throw new Error("The source conversation needs recovery.");
    const parent = foldConversation(meta.id, meta.createdAt, read.events).view.actions.find(a => a.actionId === prepared.sourceActionId);
    if (!parent || parent.worldId !== store.worldId || parent.productionId !== action.productionId || parent.status !== "completed") throw new Error("Complete the owning generation before placing this cue.");
    const result = parent.receipt?.generation?.results[source.outputIndex];
    if (!result || result.status !== "completed" || result.medium !== "audio") throw new Error("The chosen generation output has no completed audio.");
    if (parent.actionKind === "world-chat-bench-generation") source = { kind: "bench-take", sessionId: parent.authority.id, takeId: result.id };
    else if (parent.actionKind === "world-chat-production-audio-generation") source = { kind: "take", takeId: result.id };
    else throw new Error("This generation cannot supply a cue.");
  }
  let clipSource: TimelineClipSource;
  let file: string, expectedHash: string, durationSec: number;
  const production = store.getBundle().productions.find(p => p.meta.id === action.productionId)!;
  const timeline = production.timeline;
  if (timeline?.status !== "ready") throw new Error("The timeline is unavailable.");
  if (source.kind === "bench-take") {
    const bench = readBenchSession(store.dir, source.sessionId);
    const take = bench?.takes.find(t => t.id === source.takeId);
    if (!bench || bench.subject?.kind !== "production" || bench.subject.productionId !== action.productionId || !take?.media || take.request.mode !== "music" || take.status !== "succeeded" || take.disposition === "discarded") throw new Error("Choose a completed music take from this production's audio Bench.");
    file = `${sessionMediaDir(source.sessionId, take.id)}/${take.media.file}`;
    expectedHash = take.media.hash;
    durationSec = take.media.info?.durationSec ?? 0;
    // The shared contained reader independently checks the immutable Bench bytes.
    const [bytes] = await readContainedAudioReferences(store.dir, [file]);
    const { createHash } = await import("node:crypto");
    if (!`sha256:${createHash("sha256").update(bytes!.data).digest("hex")}`.startsWith(expectedHash)) throw new Error("The Bench cue bytes changed.");
    if (framesToSeconds(action.sourceInFrames + action.durationFrames, timeline.timeline.frameRate) > durationSec) throw new Error("The chosen cue is shorter than the approved source range.");
    if (!controls) throw new Error("Bench filing is unavailable.");
    const kept = await controls.execute({ kind: "bench-keep", sessionId: source.sessionId, takeId: source.takeId, checkReceiptIds: action.checkReceiptIds }, `${card.actionId}:cue-keep`, precondition);
    clipSource = { kind: "artifact", artifactId: kept.receipt.id, label: `Music Take ${take.n}` };
  } else if (source.kind === "artifact") {
    const artifact = store.getBundle().artifacts.find(a => a.id === source.artifactId && !a.retiredAt);
    if (!artifact || artifact.kind !== "audio" || (artifact.production && artifact.production !== action.productionId)) throw new Error("This artifact is not an available audio cue for this production.");
    file = `artifacts/${artifact.file}`; expectedHash = artifact.hash; durationSec = artifact.mediaInfo?.durationSec ?? 0;
    clipSource = { kind: "artifact", artifactId: artifact.id, label: artifact.file };
  } else {
    const take = production.takes.find(t => t.id === source.takeId && t.kind === "voice");
    if (!take?.media) throw new Error("The production voice take is unavailable.");
    file = `productions/${action.productionId}/takes/${take.id}/${take.media}`;
    if (!take.mediaHash) throw new Error("This voice take has no immutable media hash; regenerate it before placement.");
    expectedHash = take.mediaHash;
    durationSec = await probe?.durationSec(await audioWorldPath(store.dir, file), { signal: store.closingSignal }) ?? 0;
    clipSource = { kind: "take", takeId: take.id, label: `Voice ${take.id}` };
  }
  if (source.kind !== "bench-take") {
    if (!(await hashAudioFile(await audioWorldPath(store.dir, file), store.closingSignal)).hash.startsWith(expectedHash)) throw new Error("The cue source bytes changed.");
    if (framesToSeconds(action.sourceInFrames + action.durationFrames, timeline.timeline.frameRate) > durationSec) throw new Error("The cue is shorter than the approved source range.");
  }
  const request: ModelEditorRequest = { summary: `Place ${action.role} cue on ${action.trackId} at frame ${action.startFrame}`,
    commands: [{ kind: "place", trackId: action.trackId, clip: { id: action.clipId ?? `cl_cue_${card.actionId.slice(4)}`,
      startFrame: action.startFrame, durationFrames: action.durationFrames, sourceInFrames: action.sourceInFrames,
      gainDb: action.gainDb, role: action.role, source: clipSource } }] };
  const [staged] = await stageEditorRequests(store, { conversationId: card.conversationId, actionId: card.actionId,
    entryContext: { kind: "production", productionId: action.productionId }, requests: [request], now: store.now(),
    expectedTimeline: { revision: prepared.timelineRevision, hash: prepared.timelineHash } });
  if (!staged) throw new Error("The cue request could not be retained.");
  return { status: "completed", receipt: { kind: "editor-request", id: staged.id, summary: "Cue placement staged for human review." } };
}
