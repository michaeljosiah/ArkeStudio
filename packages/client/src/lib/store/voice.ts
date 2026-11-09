import {
  type ClientMessage, type DomainEvent, type Delivery, voiceTargetKey, type ProseReadSource,
  type ProviderId, ulid,
} from "@arke-studio/contracts";
import { current, emitChange, send, type FrameSlices, type Folded } from "./core.js";
import { useStoreSelector } from "./hooks.js";
import type { VoiceCandidatesState } from "./state.js";
import { queueRequest } from "./events.js";

// ---- SPEC-011: voice -------------------------------------------------------

/** One row of the reading catalogue: a voice, and whom the world already gives it to. */
export type ReadingVoice = Extract<DomainEvent, { type: "voice.catalogue" }>["voices"][number];

/**
 * The plain catalogue for the bench. Not `requestVoiceCandidates`, which ranks the same voices
 * against a character's written voice — the wrong question for one that is only reading.
 */
/** Choose who narrates; null returns to the shipped local voice, which costs nothing. */
export function setNarrator(
  voice: { provider: string; model: string; voiceId: string; label?: string } | null,
): void {
  send({ kind: "set-narrator", voice });
}

/** The author's statement of a free-tier provider's plan (design turn 182). */
export function setProviderPlan(provider: "google", plan: "paid" | "free"): void;
export function setProviderPlan(provider: "mistral", plan: "paid" | "free-credit"): void;
export function setProviderPlan(provider: "google" | "mistral", plan: "paid" | "free" | "free-credit"): void {
  send({ kind: "set-provider-plan", provider, plan });
}

export function requestVoiceCatalogue(worldId?: string, refresh = false): void {
  emitChange({ ...current, voiceCatalogue: null, voiceCatalogueErrors: [] });
  send({ kind: "voice-catalogue", ...(worldId ? { worldId } : {}), ...(refresh ? { refresh: true } : {}) });
}

export function requestCataloguePreview(voice: ReadingVoice): string {
  const requestId = ulid();
  send({ kind: "catalogue-voice-preview", requestId, provider: voice.provider, model: voice.model,
    voiceId: voice.voiceId, maxMicroUsd: voice.preview?.microUsd ?? 0 });
  return requestId;
}
export function stopCataloguePreview(requestId: string): void {
  send({ kind: "stop-catalogue-voice-preview", requestId });
}
export function designVoice(worldId: string, draft: import("@arke-studio/contracts").VoiceDesignDraft, confirmedEstimateMicroUsd: number): string {
  const requestId = queueRequest("design-voice");
  send({ kind: "design-voice", requestId, worldId, draft, confirmedEstimateMicroUsd });
  return requestId;
}
export function saveVoiceDesign(worldId: string, source: { jobId: string } | { remoteId: string }): string {
  const requestId = ulid();
  send({ kind: "save-designed-voice", requestId, worldId, ...source });
  return requestId;
}
export function listProjectVoices(worldId: string): string {
  const requestId = ulid();
  send({ kind: "list-designed-voices", requestId, worldId });
  return requestId;
}
export function hearDesignedVoice(worldId: string, model: string, voiceId: string, text: string, confirmedSpeechMicroUsd: number): string {
  const requestId = queueRequest("hear-designed-voice");
  send({ kind: "hear-designed-voice", requestId, worldId, model, voiceId, text, confirmedSpeechMicroUsd });
  return requestId;
}

/**
 * Speak a shot's line (SPEC-011 R-14). No voice argument: it is the speaker's own, read from
 * their sheet at dispatch, so a retake keeps it by construction.
 */
export function requestVoiceLine(input: {
  confirmedSpeechMicroUsd?: number;
  worldId: string;
  productionId: string;
  shotId: string;
  modelId?: string;
  delivery?: Delivery;
  voiceUploadConfirmedFor?: string;
}): string {
  const requestId = queueRequest("voice-line");
  send({
    kind: "voice-line",
    ...(input.confirmedSpeechMicroUsd !== undefined ? { confirmedSpeechMicroUsd: input.confirmedSpeechMicroUsd } : {}),
    requestId,
    worldId: input.worldId,
    productionId: input.productionId,
    shotId: input.shotId,
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
    ...(input.voiceUploadConfirmedFor !== undefined
      ? { voiceUploadConfirmedFor: input.voiceUploadConfirmedFor }
      : {}),
  });
  return requestId;
}

export function requestVoiceCandidates(worldId: string, sheetId: string): void {
  send({ kind: "voice-candidates", worldId, sheetId });
}

/** The client shows the stated cloud cost before this is sent (R-10). */
export function requestVoicePreview(
  worldId: string,
  sheetId: string,
  /** A provider id. The closed pair here outlived the wire's, and hid cloned voices (SPEC-022). */
  provider: ProviderId,
  model: string,
  voiceId: string,
  voiceUploadConfirmedFor?: string,
  /** The character's narration, played as the narrator would play it (design turn 200, R-168). */
  note?: string,
): string {
  const requestId = queueRequest("voice-preview");
  const quoteToken = current.voiceCandidates[sheetId]?.previewQuoteByVoice?.[voiceTargetKey({ provider, model, voiceId })];
  send({
    kind: "voice-preview",
    ...(quoteToken !== undefined ? { quoteToken } : {}),
    worldId,
    sheetId,
    provider,
    model,
    voiceId,
    ...(voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor } : {}),
    ...(note !== undefined && note.trim() !== "" ? { note: note.trim() } : {}),
    requestId,
  });
  return requestId;
}

/**
 * Every read of the app's prose carries the same two answers back (issue 1215): the price's
 * token, and — for a cloned narrator — the vendor its recording may go to, which the coordinator
 * asks about first and remembers per voice and vendor.
 */
export function readSheetSection(
  worldId: string,
  sheetId: string,
  sectionHeading: string,
  requestId = queueRequest("read-sheet-section"),
  confirmationToken?: string,
  voiceUploadConfirmedFor?: string,
  /** This read only, in the shipped narrator: what a free plan's limit offers (design turn 182). */
  defaultNarrator?: boolean,
): string {
  send({
    kind: "read-sheet-section",
    worldId,
    sheetId,
    sectionHeading,
    requestId,
    ...(confirmationToken ? { confirmationToken } : {}),
    ...(voiceUploadConfirmedFor ? { voiceUploadConfirmedFor } : {}),
    ...(defaultNarrator ? { defaultNarrator: true as const } : {}),
  });
  return requestId;
}

/**
 * The whole sheet, read in order (issue 859).
 *
 * The ordered list travels in one frame rather than one frame per block: handlers run
 * concurrently, so a loop of sends would put several local syntheses on the one small
 * on-device model at once — and the page's cost could only be stated a block at a time.
 */
export function readSheetPage(
  worldId: string,
  sheetId: string,
  sections: readonly string[],
  requestId = queueRequest("read-sheet-page"),
  confirmationToken?: string,
  voiceUploadConfirmedFor?: string,
  /** This read only, in the shipped narrator: what a free plan's limit offers (design turn 182). */
  defaultNarrator?: boolean,
): string {
  send({
    kind: "read-sheet-page",
    worldId,
    sheetId,
    sections: [...sections],
    requestId,
    ...(confirmationToken ? { confirmationToken } : {}),
    ...(voiceUploadConfirmedFor ? { voiceUploadConfirmedFor } : {}),
    ...(defaultNarrator ? { defaultNarrator: true as const } : {}),
  });
  return requestId;
}

/**
 * The same for a section of the bible, whose headings are the author's own and so cannot be an
 * enum here the way a sheet's two readable sections can (2026-08-24).
 */
export function readBibleSection(
  worldId: string,
  sectionHeading: string,
  requestId = queueRequest("read-bible-section"),
  confirmationToken?: string,
  voiceUploadConfirmedFor?: string,
  /** This read only, in the shipped narrator: what a free plan's limit offers (design turn 182). */
  defaultNarrator?: boolean,
): string {
  send({
    kind: "read-bible-section",
    worldId,
    sectionHeading,
    requestId,
    ...(confirmationToken ? { confirmationToken } : {}),
    ...(voiceUploadConfirmedFor ? { voiceUploadConfirmedFor } : {}),
    ...(defaultNarrator ? { defaultNarrator: true as const } : {}),
  });
  return requestId;
}

/**
 * The same for the world's other authored prose — a canon entry, a scene, a shot's script, the
 * production overview, the season, the Series, one of Arke's replies (issue 857).
 *
 * One sender rather than seven, because the source is a named address and the frame carries it
 * whole; every screen's call is the same two lines the bible's was.
 */
export function readProse(
  worldId: string,
  source: ProseReadSource,
  requestId = queueRequest("read-prose"),
  confirmationToken?: string,
  voiceUploadConfirmedFor?: string,
  /** This read only, in the shipped narrator: what a free plan's limit offers (design turn 182). */
  defaultNarrator?: boolean,
): string {
  send({
    kind: "read-prose",
    worldId,
    source,
    requestId,
    ...(confirmationToken ? { confirmationToken } : {}),
    ...(voiceUploadConfirmedFor ? { voiceUploadConfirmedFor } : {}),
    ...(defaultNarrator ? { defaultNarrator: true as const } : {}),
  });
  return requestId;
}

/**
 * The same prose, read as a page (issue 859) — the screen's ordered list in one frame.
 *
 * One frame rather than one per block: handlers run concurrently, so a loop of sends would start
 * several local syntheses at once, and the page's price could only be stated a block at a time.
 */
export function readProsePage(
  worldId: string,
  sources: readonly ProseReadSource[],
  requestId = queueRequest("read-prose-page"),
  confirmationToken?: string,
  voiceUploadConfirmedFor?: string,
  /** This read only, in the shipped narrator: what a free plan's limit offers (design turn 182). */
  defaultNarrator?: boolean,
): string {
  send({
    kind: "read-prose-page",
    worldId,
    sources: [...sources],
    requestId,
    ...(confirmationToken ? { confirmationToken } : {}),
    ...(voiceUploadConfirmedFor ? { voiceUploadConfirmedFor } : {}),
    ...(defaultNarrator ? { defaultNarrator: true as const } : {}),
  });
  return requestId;
}

export function transcribeDictation(requestId: string, audioBase64: string, contentType: string): boolean {
  return send({ kind: "transcribe-dictation", requestId, audioBase64, contentType });
}

/** A clip staged for a clone: what 74c can draw about it, and nothing about where it lives. */
export interface StagedClip {
  /** Null when the clip was refused, or when the host's picker was simply cancelled. */
  clipId: string | null;
  fileName: string | null;
  seconds: number | null;
  reason: string | null;
}

/**
 * Ask for a clip to clone from (SPEC-022 T-10).
 *
 * Passing no recording means the host opens its own file picker; the renderer never learns what
 * was chosen beyond its name. A recording is sent as bytes because the renderer genuinely holds
 * those — and as WAV, because that is what the library accepts and it refuses the rest by magic
 * number rather than by extension.
 */
export function stageVoiceClip(
  worldId: string,
  recording?: { audioBase64: string; contentType: string },
): string | null {
  const requestId = `clip-${crypto.randomUUID()}`;
  const sent = send({
    kind: "stage-voice-clip",
    worldId,
    requestId,
    source: recording ? { from: "recorded", ...recording } : { from: "chosen" },
  });
  return sent ? requestId : null;
}

/** Cancelling the dialog: the temp file should not outlive the screen that made it. */
export function discardVoiceClip(clipId: string): void {
  send({ kind: "discard-voice-clip", clipId });
}

/**
 * Make the voice (SPEC-022 T-10). `consent` is not a parameter: the frame is `z.literal(true)`,
 * so there is no shape of this call that carries an unconsented clone, and the tick on 74c gates
 * the button rather than being passed along as data that could be forgotten.
 */
export function cloneVoice(input: {
  transcript?: string;
  worldId: string;
  clipId: string;
  name: string;
  description: string;
  /** The recording's language (ISO 639-1); the coordinator takes English when it is not said. */
  language?: string;
  sheetId?: string;
}): void {
  send({
    kind: "clone-voice",
    ...(input.transcript?.trim() ? { transcript: input.transcript.trim() } : {}),
    worldId: input.worldId,
    clipId: input.clipId,
    name: input.name,
    description: input.description,
    consent: true,
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.sheetId !== undefined ? { sheetId: input.sheetId } : {}),
  });
}

/**
 * Delete a cloned voice (SPEC-046 R-15): the clip, the entry, and every vendor copy after. The
 * answer comes back on `voice.deleted` under this id; null when the studio is disconnected.
 */
export function deleteVoice(worldId: string, voiceId: string): string | null {
  const requestId = ulid();
  return send({ kind: "delete-voice", requestId, worldId, voiceId }) ? requestId : null;
}

export function useVoiceClips(): Record<string, StagedClip> {
  return useStoreSelector(store => store.voiceClips);
}

export function useVoiceCloned(): {
  voiceId: string | null;
  label: string | null;
  reason: string | null;
} | null {
  return useStoreSelector(store => store.voiceCloned);
}

export function useVoiceCandidates(): Record<string, VoiceCandidatesState> {
  return useStoreSelector(store => store.voiceCandidates);
}

export function useVoicePreviews(): Record<string, { file: string | null; error: string | null }> {
  return useStoreSelector(store => store.voicePreviews);
}

export function useVoiceAudio(): Record<string, Extract<DomainEvent, { type: "voice.audio" }>> {
  return useStoreSelector(store => store.voiceAudio);
}

/** The pieces of a long read, in order, per request. Empty for anything that arrived whole. */
export function useVoiceParts(): Record<string, string[]> {
  return useStoreSelector(store => store.voiceParts);
}

export function useDictation(): Record<string, { text: string | null; error: string | null }> {
  return useStoreSelector(store => store.dictation);
}

/** Generate a line (SPEC-044 R-14): a queue request, so the enqueue result reaches the sheet that asked. */
export function generatePerformance(input: Omit<Extract<ClientMessage, { kind: "generate-performance" }>, "kind" | "requestId">): string | null {
  const requestId = queueRequest("generate-performance");
  return send({ kind: "generate-performance", requestId, ...input }) ? requestId : null;
}

/** handleFrame's arms for voice.candidates … dictation.result, in their order (issue 2800). */
export function foldVoiceEvent(slices: FrameSlices, event: DomainEvent): Folded {
  if (event.type === "voice.candidates") {
    slices.voiceCandidates = {
      ...slices.voiceCandidates,
      [event.sheetId]: {
        extracted: event.extracted,
        ranked: event.ranked,
        previewLine: event.previewLine,
        cloudPreviewMicroUsd: event.cloudPreviewMicroUsd,
        previewMicroUsdByVoice: event.previewMicroUsdByVoice,
        previewQuoteByVoice: event.previewQuoteByVoice,
        notices: event.notices,
      },
    };
  } else if (event.type === "voice.preview") {
    slices.voicePreviews = {
      ...slices.voicePreviews,
      [voiceTargetKey(event)]: { file: event.file, error: event.error },
    };
  } else if (event.type === "voice.audio") {
    /*
     * A long read arrives as several of these under one requestId (2026-08-24). Keyed by
     * request, each would overwrite the last and a screen would only ever see the final piece —
     * so the pieces are collected alongside, in the order the coordinator made them.
     *
     * The keyed entry still holds the newest event, because that is what every existing caller
     * reads for status, cost and errors, and none of them know about parts.
     */
    slices.voiceAudio = { ...slices.voiceAudio, [event.requestId]: event };
    if (event.part !== undefined && event.file) {
      const already = slices.voiceParts[event.requestId] ?? [];
      const next = already.slice();
      next[event.part] = event.file;
      slices.voiceParts = { ...slices.voiceParts, [event.requestId]: next };
    }
  } else if (event.type === "dictation.result") {
    slices.dictation = { ...slices.dictation, [event.requestId]: { text: event.text, error: event.error } };
  } else return "none";
  return "done";
}

/** handleFrame's arms for voice.sidecar … voice.runtime-test, in their order (issue 2800). */
export function foldVoiceRuntimeEvent(slices: FrameSlices, event: DomainEvent): Folded {
  if (event.type === "voice.sidecar") {
    slices.voiceSidecar = { state: event.state, detail: event.detail };
  } else if (event.type === "voice.runtime-test") {
    slices.voiceRuntimeTest = {
      requestId: event.requestId,
      status: event.status,
      detail: event.detail,
      audioBase64: event.audioBase64,
    };
  } else return "none";
  return "done";
}

/** handleFrame's blocks for voice.catalogue … voice.cloned, in their order (issue 2800). */
export function foldVoiceCatalogueEvent(slices: FrameSlices, event: DomainEvent): void {
  if (event.type === "voice.catalogue") {
    slices.voiceCatalogue = event.voices;
    slices.voiceCatalogueHeld = event.voices;
    slices.voiceCatalogueErrors = event.errors ?? [];
  }
  if (event.type === "voice.catalogue-preview") slices.cataloguePreview = event;
  if (event.type === "voice.clip-staged") {
    slices.voiceClips = {
      ...slices.voiceClips,
      [event.requestId]: {
        clipId: event.clipId,
        fileName: event.fileName,
        seconds: event.seconds,
        reason: event.reason,
      },
    };
  }
  if (event.type === "voice.cloned") {
    slices.voiceCloned = { voiceId: event.voiceId, label: event.label, reason: event.reason };
  }
}
