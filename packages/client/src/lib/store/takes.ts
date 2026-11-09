import type { ClientMessage, TimelineCommand, DomainEvent } from "@arke-studio/contracts";
import { pickBrowserMedia, readBrowserMedia } from "../browser-media-import.js";
import { isRemoteSession } from "../remote-session.js";
import type { AttachTarget } from "../../arke-bridge.js";
import { current, bridge, onWorldChange, send, type FrameSlices } from "./core.js";
import { useStoreSelector } from "./hooks.js";
import type { StoreState } from "./state.js";
import {
  type QueueEnqueueResult, pendingQueueRequests, queueResultListeners, queueRequest,
} from "./events.js";

/** Exact authenticated editor operations; review state and request retries belong to their domain controller. */
export function sendEffectProposalCommand(worldId: string, productionId: string, requestId: string,
  operation: import("@arke-studio/contracts").EffectReviewOperation): boolean {
  return send({ kind: "editor-effect-proposal", worldId, productionId, requestId, operation });
}


// ---- SPEC-013: takes, the cut, exports -------------------------------------

export function acceptTake(worldId: string, productionId: string, takeId: string, shotId: string): void {
  send({ kind: "accept-take", worldId, productionId, takeId, shotId });
}

/**
 * File a Stage export. The host encodes its fixed RGBA frames, then sends that MP4 and the
 * opening PNG in one frame; a browser session has no encoder and refuses before rendering.
 */
export async function beginStageExport(spec: { width: number; height: number; frameRate: number; frameCount: number }): Promise<string> {
  const host = bridge;
  if (!host?.startStageExport) throw new Error("deterministic playblast export needs the desktop app");
  const result = await host.startStageExport(spec);
  if (!result.ok) throw new Error(result.reason);
  return result.jobId;
}

export async function writeStageExportFrame(jobId: string, index: number, bytes: Uint8Array): Promise<void> {
  const host = bridge;
  if (!host?.writeStageExportFrame) throw new Error("deterministic playblast export needs the desktop app");
  const result = await host.writeStageExportFrame(jobId, index, bytes);
  if (!result.ok) throw new Error(result.reason);
}

export async function cancelStageExport(jobId: string): Promise<void> {
  await bridge?.cancelStageExport?.(jobId);
}

export async function stagePlayblast(
  target: Extract<AttachTarget, { kind: "stage-playblast" | "stage-animatic" | "conversation-action-stage-playblast-complete" }>,
  jobId: string,
  openingFrame: Uint8Array,
  referenceFrames: Array<import("@arke-studio/contracts").StageReferenceFrame & { bytes: Uint8Array }>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const host = bridge;
  if (!host?.finishStageExport) return { ok: false, reason: "deterministic playblast export needs the desktop app" };
  try {
    return await host.finishStageExport(target, jobId, openingFrame, referenceFrames);
  } catch {
    await cancelStageExport(jobId).catch(() => {});
    return { ok: false, reason: "the Stage export could not be handed to the app" };
  }
}

export function failStagePlayblastAction(
  worldId: string,
  conversationId: string,
  actionId: string,
  detail: string,
): void {
  send({
    kind: "conversation-action-stage-playblast-complete",
    worldId,
    conversationId,
    actionId,
    status: "failed",
    detail: detail.slice(0, 1_000) || "The Stage recording failed.",
  });
}

export function importShotFrame(worldId: string, productionId: string, shotId: string): void {
  send({
    kind: "import-shot-frame",
    worldId,
    productionId,
    shotId,
    requestId: queueRequest("import-shot-frame"),
  });
}

/** Drop the still a shot opens on, so its own references travel again (issue 851). */
export function clearShotFrame(worldId: string, productionId: string, shotId: string): void {
  send({
    kind: "clear-shot-frame",
    worldId,
    productionId,
    shotId,
    requestId: queueRequest("clear-shot-frame"),
  });
}

/**
 * Where a shot starts inside its selected media (R-8, issue 253) — the only authored edit the cut
 * offers, and trim-from-the-in-point only. The coordinator refuses a shot with no accepted take
 * and a trim that would leave nothing; the refusal lands in the app log, not on the wire.
 */
export function setShotTrim(worldId: string, productionId: string, shotId: string, trimInSec: number): void {
  send({ kind: "set-trim", worldId, productionId, shotId, trimInSec });
}

export function moveTimelinePictureClip(
  worldId: string,
  productionId: string,
  clipId: `cl_${string}`,
  direction: "earlier" | "later",
  baseRevision: number | null,
  sourceFingerprint: string,
): void {
  send({
    kind: "timeline-move-picture",
    worldId,
    productionId,
    clipId,
    direction,
    baseRevision,
    sourceFingerprint,
  });
}

/**
 * One completed editor action as one batch (SPEC-037 R-24, issue 679). A drag, a menu item, a
 * keyboard command and an accepted request all arrive here, and every one of them is one
 * revision and one Undo step on the other side or nothing at all.
 */
export function sendTimelineCommands(
  worldId: string,
  productionId: string,
  commands: TimelineCommand[],
  baseRevision: number | null,
  sourceFingerprint: string,
  label?: string,
): void {
  send({
    kind: "timeline-command",
    worldId,
    productionId,
    commands,
    baseRevision,
    sourceFingerprint,
    ...(label !== undefined ? { label } : {}),
  });
}

export function moveTimelineHistory(
  worldId: string,
  productionId: string,
  action: "undo" | "redo",
  baseRevision: number,
): void {
  send({ kind: "timeline-history", worldId, productionId, action, baseRevision });
}

/**
 * File new artifacts: the host picks, the renderer never sees the bytes (82a).
 *
 * The world's shelf unless `production` names one. A production's own artifacts page is the only
 * surface that scopes what it takes (SPEC-020 R-13, design 134); everywhere else the omission is
 * the world saying so.
 */
export function uploadArtifacts(
  worldId: string,
  files?: readonly File[],
  production?: string,
): { requestId: string | null; reason?: string } {
  return importEditorMedia(worldId, undefined, files, production);
}

export function restoreArtifact(worldId: string, artifactId: string): void {
  send({ kind: "restore-artifact", worldId, artifactId });
}

export function retireArtifact(worldId: string, artifactId: string): void {
  send({ kind: "retire-artifact", worldId, artifactId });
}

export function importEditorMedia(
  worldId: string, editor: Extract<ClientMessage, { kind: "upload-artifacts" }>["editor"],
  files?: readonly File[], production?: string,
  audioStudio?: Extract<ClientMessage, { kind: "upload-artifacts" }>["audioStudio"],
  music?: Extract<ClientMessage, { kind: "upload-artifacts" }>["music"],
): { requestId: string | null; reason?: string } {
  if (isRemoteSession()) return { requestId: null, reason: "Import media on the desktop app." };
  if (files && files.length > 16) return { requestId: null, reason: "Import up to 16 files at a time." };
  if (!bridge || current.connection !== "open") return { requestId: null, reason: "The studio is disconnected. Reconnect before importing files." };
  const browserImport = typeof window !== "undefined" && !window.arke;
  if (browserImport && [...pendingQueueRequests.values()].some(request => request.command === "upload-artifacts"))
    return { requestId: null, reason: "Another import is running. Wait for it to finish." };
  const requestId = queueRequest("upload-artifacts");
  // Omitted rather than sent as undefined: the frame is `.strict()`, and the picker and the drop
  // have to carry the same scope or one entrance on a page would file somewhere the other did not.
  const scope = { ...(production !== undefined ? { production } : {}), ...(audioStudio ? { audioStudio } : {}), ...(music ? { music } : {}) };
  if (browserImport) {
    const currentBridge = bridge;
    let worldChanged = false;
    const unsubscribe = onWorldChange(id => { if (id !== worldId) worldChanged = true; });
    const stillCurrent = () => !worldChanged && bridge === currentBridge && current.connection === "open" && current.state?.world?.meta.worldId === worldId && pendingQueueRequests.has(requestId);
    // Picker/read failures are local refusals, delivered to the same requesting controls.
    const finish = (reason?: string) => {
      pendingQueueRequests.delete(requestId);
      const result: QueueEnqueueResult = { type: "queue.enqueue-result", at: new Date().toISOString(), requestId,
        command: "upload-artifacts", disposition: reason ? "rejected" : "not-queued", requestedCount: reason ? 1 : 0,
        acceptedJobIds: [], failures: reason ? [{ index: 0, reason }] : [] };
      for (const listener of queueResultListeners) listener(result);
    };
    // Start the input synchronously while the click still has browser user activation.
    const selection = files === undefined ? pickBrowserMedia() : Promise.resolve([...files]);
    void selection.then(async selected => {
      if (selected.length === 0) { finish(); return; }
      const browserFiles = await readBrowserMedia(selected, stillCurrent);
      if (!send({ kind: "upload-artifacts", worldId, requestId, editor, ...scope, browserFiles }))
        throw new Error("The files could not be imported. Check the connection and use Import media.");
    }).catch(error => finish(error instanceof Error ? error.message : "The files could not be read.")).finally(unsubscribe);
    return { requestId };
  }
  if (files && !bridge.importDroppedMedia) {
    pendingQueueRequests.delete(requestId);
    return { requestId: null, reason: "File drops are unavailable. Use Import media instead." };
  }
  const submitted = files
    ? bridge!.importDroppedMedia!({ worldId, requestId, editor, ...scope }, files).submitted
    : send({ kind: "upload-artifacts", worldId, requestId, editor, ...scope });
  if (!submitted) {
    pendingQueueRequests.delete(requestId);
    return { requestId: null, reason: "The files could not be imported. Check the connection and use Import media." };
  }
  return { requestId };
}

/** A rejection requires the cited sheet and field (R-10). */
export function rejectTake(
  worldId: string,
  productionId: string,
  takeId: string,
  citation: { sheet: string; field: string; note?: string },
  shotId?: string,
): void {
  send({
    kind: "reject-take",
    worldId,
    productionId,
    takeId,
    citation,
    ...(shotId !== undefined ? { shotId } : {}),
  });
}

export function exportCut(
  worldId: string,
  productionId: string,
  preset: import("@arke-studio/contracts").ExportPreset,
  timelineRevision: number | null,
  episodeId?: string,
  subtitles?: { trackId: `tr_${string}`; mode: "none" | "burn-in" | "sidecar" | "burn-in+sidecar"; sidecar?: "srt" | "vtt" },
): void {
  send({
    kind: "export-cut",
    worldId,
    productionId,
    preset,
    timelineRevision,
    ...(episodeId !== undefined ? { episodeId } : {}),
    ...(subtitles !== undefined && subtitles.mode !== "none" ? { subtitles } : {}),
  });
}

/** Draft a subtitle track from the Dialogue clips (SPEC-038 R-25): explicit, and one fenced batch. */
export function sendTimelineTranscribe(
  worldId: string,
  productionId: string,
  baseRevision: number,
  trackId: `tr_${string}`,
  language: string,
): void {
  send({ kind: "timeline-transcribe", worldId, productionId, baseRevision, trackId, language });
}

/** Arke assembles one scene onto the timeline (SPEC-039 R-44): one fenced batch, applied directly. */
export function sendTimelineAssemble(
  worldId: string,
  productionId: string,
  sceneId: string,
  baseRevision: number | null,
  sourceFingerprint: string,
): void {
  send({ kind: "timeline-assemble", worldId, productionId, sceneId, baseRevision, sourceFingerprint });
}

export function cancelExport(worldId: string, exportId: string): void {
  send({ kind: "cancel-export", worldId, exportId });
}

export function exportWorld(worldId: string): void {
  send({ kind: "export-world", worldId });
}

export interface ExportState {
  /** The world the export belongs to (codex on PR 924): a production slug recurs across worlds. */
  worldId?: string;
  productionId: string;
  /** Set when the export is one episode's deliverable (issue 396). */
  episodeId?: string;
  status: "running" | "done" | "cancelled" | "failed";
  percent: number;
  output: string | null;
  /** The subtitle sidecar delivered beside the video, when one was (SPEC-038 R-27). */
  sidecar?: string;
  deliveryKind?: "video" | "manuscript" | "interactive" | "audiobook-video";
  /** An audiobook video's place while it renders (design turn 197d). */
  video?: import("@arke-studio/contracts").AudiobookVideoProgress;
  /** What Activity calls the export and its step in hand (233b). */
  label?: string;
  step?: string;
  /** What an audiobook video made, once it has (197e): its folder and files. */
  made?: { dir: string; files: import("@arke-studio/contracts").AudiobookVideoFile[]; scope?: import("@arke-studio/contracts").AudiobookScope; chapterIds?: string[] };
  error: string | null;
}

export function useExports(): Record<string, ExportState> {
  return useStoreSelector(store => store.exportsState);
}

// ---- SPEC-015: artifacts ---------------------------------------------------

export function fileArtifactMsg(
  worldId: string,
  sourcePath: string,
  /**
   * `production` carries SPEC-020 ownership: a slug files it to that production, `null` says the
   * world explicitly — which is what re-homes an already-scoped artifact when filing dedups —
   * and omitting it leaves whatever ownership the artifact had.
   */
  opts: { links?: string[]; allowLarge?: boolean; supersedes?: string; production?: string | null } = {},
): void {
  send({ kind: "file-artifact", worldId, sourcePath, ...opts });
}

/** Derive continuity for one chapter (turn 129): a press, never a save. */
export function deriveContinuity(worldId: string, productionId: string, chapterFile: string): void {
  send({ kind: "derive-continuity", worldId, productionId, chapterFile });
}

export function stopContinuity(worldId: string, productionId: string, chapterFile: string): void {
  send({ kind: "stop-continuity", worldId, productionId, chapterFile });
}

/** How each chapter's derivation is going, keyed by `worldId/productionId/chapterId` — the panel reads this. */
export function useDeriving(): StoreState["deriving"] {
  return useStoreSelector(store => store.deriving);
}

/** Cast a chapter's lines (turn 130): a press, never a save; `changed` casts only the paragraphs edited since (design turn 198). */
export function castVoices(worldId: string, productionId: string, chapterFile: string, scope?: "changed"): boolean {
  return send({ kind: "cast-voices", worldId, productionId, chapterFile, ...(scope !== undefined ? { scope } : {}) });
}

/** A correction to the cast (design turn 155, SPEC-012 R-62): the span given a speaker, narration, or cleared. */
export function setVoicePin(
  worldId: string,
  productionId: string,
  chapterFile: string,
  pin: { paragraph: number; occurrence: number; quote: string } & ({ speaker: string; sheet?: string } | { narration: true } | { clear: true }),
): boolean {
  return send({ kind: "set-voice-pin", worldId, productionId, chapterFile, ...pin });
}

export function stopVoices(worldId: string, productionId: string, chapterFile: string): void {
  send({ kind: "stop-voices", worldId, productionId, chapterFile });
}

/** handleFrame's blocks for export.progress … audiobook.video-exported, in their order (issue 2800). */
export function foldExportEvent(slices: FrameSlices, event: DomainEvent): void {
  if (event.type === "export.progress") {
    slices.exportsState = {
      ...slices.exportsState,
      [event.exportId]: {
        worldId: event.worldId,
        productionId: event.productionId,
        ...(event.episodeId !== undefined ? { episodeId: event.episodeId } : {}),
        status: event.status,
        percent: event.percent,
        output: event.output,
        ...(event.sidecar !== undefined ? { sidecar: event.sidecar } : {}),
        ...(event.deliveryKind !== undefined ? { deliveryKind: event.deliveryKind } : {}),
        ...(event.video !== undefined ? { video: event.video } : {}),
        ...(event.label !== undefined ? { label: event.label } : {}),
        ...(event.step !== undefined ? { step: event.step } : {}),
        ...(slices.exportsState[event.exportId]?.made !== undefined ? { made: slices.exportsState[event.exportId]!.made! } : {}),
        error: event.error,
      },
    };
  } else if (event.type === "audiobook.video-exported" && event.result.ok) {
    // The files an audiobook video made (design turn 197e), for its finished row in Activity.
    const held = slices.exportsState[event.exportId];
    slices.exportsState = {
      ...slices.exportsState,
      [event.exportId]: { ...(held ?? { worldId: event.worldId, productionId: event.productionId, status: "done" as const, percent: 100, output: null, error: null }), deliveryKind: "audiobook-video", made: { dir: event.result.dir, files: event.result.files, ...(event.result.scope !== undefined ? { scope: event.result.scope } : {}), ...(event.result.chapterIds !== undefined ? { chapterIds: event.result.chapterIds } : {}) } },
    };
  }
}
