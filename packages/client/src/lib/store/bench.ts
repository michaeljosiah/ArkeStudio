import {
  type BenchParams, type ClientMessage, type ClientState, type BenchMode, ulid,
} from "@arke-studio/contracts";
import { send } from "./core.js";
import { useStoreSelector } from "./hooks.js";
import { queueRequest } from "./events.js";

// ---------------------------------------------------------------------------
// The bench (issue 305)
// ---------------------------------------------------------------------------

export function useBench(): ClientState["bench"] {
  return useStoreSelector(store => store.state?.bench ?? null);
}

export function sendBenchOpen(worldId: string, sessionId?: string): void {
  send({ kind: "bench-open", worldId, ...(sessionId !== undefined ? { sessionId } : {}) } as ClientMessage);
}

export function sendBenchOpenSubject(input: Omit<Extract<ClientMessage, { kind: "bench-open-subject" }>, "kind" | "requestId">): string | null {
  const requestId = ulid();
  return send({ kind: "bench-open-subject", requestId, ...input } as ClientMessage) ? requestId : null;
}

export function sendBenchRebuildSubject(worldId: string, sessionId: string): string | null {
  const requestId = ulid();
  return send({ kind: "bench-rebuild-subject", worldId, sessionId, requestId } as ClientMessage)
    ? requestId
    : null;
}

export function sendBenchNewSession(worldId: string, picture?: Extract<ClientMessage, { kind: "bench-new-session" }>["picture"], image?: Extract<ClientMessage, { kind: "bench-new-session" }>["image"]): void {
  send({ kind: "bench-new-session", worldId, ...(picture !== undefined ? { picture } : {}), ...(image !== undefined ? { image } : {}) });
}

export function sendBenchClose(worldId: string): void {
  send({ kind: "bench-close", worldId });
}

export function sendBenchTitle(worldId: string, sessionId: string, title: string | null): void {
  send({ kind: "bench-set-title", worldId, sessionId, requestId: ulid(), title } as ClientMessage);
}

export function sendBenchCompose(
  worldId: string,
  sessionId: string,
  composer: {
    mode: BenchMode;
    provider: string;
    model: string;
    params: Extract<ClientMessage, { kind: "bench-compose" }>["params"];
    brief: string;
  },
): void {
  send({ kind: "bench-compose", worldId, sessionId, requestId: ulid(), ...composer } as ClientMessage);
}

export function sendBenchAddReference(
  worldId: string,
  sessionId: string,
  picks: ReadonlyArray<{
    pick:
      | { source: "artifact"; artifactId: string }
      | { source: "take"; takeId: string }
      | { source: "world-file"; path: string };
    replace?: string;
  }>,
  lane?: "reference" | "keyframe",
): void {
  if (picks.length === 0) return;
  send({
    kind: "bench-add-reference",
    worldId,
    sessionId,
    requestId: ulid(),
    picks: picks.map((p) => ({ source: p.pick, ...(p.replace !== undefined ? { replace: p.replace } : {}) })),
    ...(lane !== undefined ? { lane } : {}),
  } as ClientMessage);
}

export function sendBenchEnhanceBrief(input: {
  worldId: string;
  sessionId: string;
  brief: string;
  provider: string;
  model: string;
}): string | null {
  const requestId = ulid();
  const sent = send({ kind: "bench-enhance-brief", requestId, ...input } as ClientMessage);
  return sent ? requestId : null;
}

/**
 * "Write for me" (design turn 73). The answer arrives as an event and opens a dialog; nothing
 * here writes into the composer, which is the whole point of the control.
 */
export function sendBenchDraftLyrics(input: {
  worldId: string;
  sessionId: string;
  description: string;
  style?: string;
  provider: string;
  model: string;
}): string | null {
  const requestId = ulid();
  const sent = send({ kind: "bench-draft-lyrics", requestId, ...input } as ClientMessage);
  return sent ? requestId : null;
}

export function sendBenchPresetSave(input: {
  name: string;
  mode: BenchMode;
  provider: string;
  model: string;
  params: BenchParams;
  brief?: string;
}): void {
  send({
    kind: "bench-preset-save",
    requestId: ulid(),
    name: input.name,
    mode: input.mode,
    provider: input.provider,
    model: input.model,
    params: input.params,
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
  } as ClientMessage);
}

export function sendBenchPresetDelete(presetId: string): void {
  send({ kind: "bench-preset-delete", requestId: ulid(), presetId } as ClientMessage);
}

export function sendBenchRemoveReference(
  worldId: string,
  sessionId: string,
  token: string,
  lane?: "reference" | "keyframe",
): void {
  send({
    kind: "bench-remove-reference",
    worldId,
    sessionId,
    requestId: ulid(),
    token,
    ...(lane !== undefined ? { lane } : {}),
  } as ClientMessage);
}

/** Returns the requestId the artifact.filed-batch answer will carry. */
export function sendBenchUploadReferences(
  worldId: string,
  sessionId: string,
  lane?: "reference" | "keyframe",
): string | null {
  const requestId = ulid();
  const sent = send({
    kind: "bench-upload-references",
    worldId,
    sessionId,
    requestId,
    ...(lane !== undefined ? { lane } : {}),
  } as ClientMessage);
  return sent ? requestId : null;
}

/** Returns the requestId so the screen can correlate the queue.enqueue-result. */
export function sendBenchDispatch(
  worldId: string,
  sessionId: string,
  composer: Extract<ClientMessage, { kind: "bench-dispatch" }>["composer"],
  voiceUploadConfirmedFor?: string,
  confirmedSpeechMicroUsd?: number,
): string {
  const requestId = queueRequest("bench-dispatch");
  send({
    kind: "bench-dispatch",
    ...(confirmedSpeechMicroUsd !== undefined ? { confirmedSpeechMicroUsd } : {}),
    worldId,
    sessionId,
    requestId,
    composer,
    ...(voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor } : {}),
  } as ClientMessage);
  return requestId;
}

export function sendBenchRerun(
  worldId: string,
  sessionId: string,
  takeId: string,
  voiceUploadConfirmedFor?: string,
): string {
  const requestId = queueRequest("bench-rerun");
  send({
    kind: "bench-rerun",
    worldId,
    sessionId,
    requestId,
    takeId,
    ...(voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor } : {}),
  } as ClientMessage);
  return requestId;
}

/** Upscale a finished video take to 1080p (design turn 178); answered like a dispatch. */
export function sendBenchUpscale(worldId: string, sessionId: string, takeId: string): string {
  const requestId = queueRequest("bench-upscale");
  send({ kind: "bench-upscale", worldId, sessionId, requestId, takeId } as ClientMessage);
  return requestId;
}

export function sendBenchKeep(worldId: string, sessionId: string, takeId: string): void {
  send({ kind: "bench-keep", worldId, sessionId, requestId: ulid(), takeId } as ClientMessage);
}

export function sendBenchUseReference(worldId: string, sessionId: string, takeId: string, sheetId: string, image: "main-photo" | "character-sheet"): string | null {
  const requestId = ulid();
  return send({ kind: "bench-use-reference", worldId, sessionId, takeId, sheetId, image, requestId } as ClientMessage) ? requestId : null;
}

export function sendBenchAccept(worldId: string, sessionId: string, takeId: string): string | null {
  const requestId = ulid();
  return send({ kind: "bench-accept", worldId, sessionId, requestId, takeId } as ClientMessage)
    ? requestId
    : null;
}

export function sendBenchDiscard(worldId: string, sessionId: string, takeId: string): void {
  send({ kind: "bench-discard", worldId, sessionId, requestId: ulid(), takeId } as ClientMessage);
}

/** Ask what Delete would remove; null when the message could not be sent. */
export function sendBenchTakeFiles(worldId: string, sessionId: string, takeId: string): string | null {
  const requestId = ulid();
  return send({ kind: "bench-take-files", worldId, sessionId, requestId, takeId } as ClientMessage) ? requestId : null;
}

export function sendBenchDelete(worldId: string, sessionId: string, takeId: string): string | null {
  const requestId = ulid();
  return send({ kind: "bench-delete", worldId, sessionId, requestId, takeId } as ClientMessage) ? requestId : null;
}

export function sendBenchClearView(worldId: string, sessionId: string, takeId: string): void {
  send({ kind: "bench-clear-view", worldId, sessionId, requestId: ulid(), takeId } as ClientMessage);
}

export function sendBenchSelectTake(worldId: string, sessionId: string, takeId: string): void {
  send({ kind: "bench-select-take", worldId, sessionId, requestId: ulid(), takeId } as ClientMessage);
}

export function sendStageArtifactReference(worldId: string, key: string, artifactId: string): void {
  send({ kind: "stage-artifact-reference", worldId, key, artifactId } as ClientMessage);
}

/** Returns the requestId the artifact.filed-batch answer will carry. */
export function sendAttachFilesCorrelated(worldId: string, links?: string[]): string | null {
  const requestId = ulid();
  const sent = send({
    kind: "attach-files-correlated",
    worldId,
    requestId,
    ...(links !== undefined ? { links } : {}),
  } as ClientMessage);
  return sent ? requestId : null;
}
