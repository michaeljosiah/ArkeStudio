import {
  illustrationRowGoes, illustrationTotal, type AudiobookReader, type PictureShot, type DomainEvent,
  ulid,
} from "@arke-studio/contracts";
import { current, emitChange, send, useStoreSelector } from "./core.js";
import type { StoreState } from "./state.js";

// ---- turn 146: the audiobook ------------------------------------------------

/** Read a chapter into kept takes (SPEC-047 R-16); the token answers a price the run asked. */
export function readAudiobookChapter(
  worldId: string,
  productionId: string,
  chapterFile: string,
  options: { confirmationToken?: string; voiceUploadConfirmedFor?: string; castFirst?: boolean } = {},
): boolean {
  return send({
    kind: "read-audiobook-chapter",
    worldId,
    productionId,
    chapterFile,
    ...(options.confirmationToken !== undefined ? { confirmationToken: options.confirmationToken } : {}),
    ...(options.voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor: options.voiceUploadConfirmedFor } : {}),
    // Cast the paragraphs left to cast first (design turn 198): the confirm's ticked press.
    ...(options.castFirst === true ? { castFirst: true as const } : {}),
  });
}

export function stopAudiobook(worldId: string, productionId: string, chapterFile: string): void {
  send({ kind: "stop-audiobook", worldId, productionId, chapterFile });
}

/** The book's reading (SPEC-047 R-11): every block the narrator's, or each line its speaker's. */
export function setAudiobookReading(worldId: string, productionId: string, reading: "narrator" | "performed" | "cast"): boolean {
  return send({ kind: "set-audiobook-reading", worldId, productionId, reading });
}

/** The book's requests for a groupable reader (design turn 185d): several blocks a request, or one. */
export function setAudiobookRequests(worldId: string, productionId: string, requests: "grouped" | "per-paragraph"): boolean {
  return send({ kind: "set-audiobook-requests", worldId, productionId, requests });
}

/** A grouped read's cut whose words did not match, kept as the block's take (design turn 185c). */
export function keepAudiobookSplit(worldId: string, productionId: string, chapterFile: string, block: string): boolean {
  return send({ kind: "keep-audiobook-split", worldId, productionId, chapterFile, block });
}

/** How the narrator plays a character under `performed` (SPEC-047 R-44); null takes the note away. */
export function setAudiobookNote(worldId: string, productionId: string, speaker: string, note: string | null): boolean {
  return send({ kind: "set-audiobook-note", worldId, productionId, speaker, note });
}

/**
 * The book's own narrator, or null for the app's (R-46). From a chapter (R-195), that chapter's
 * own narrator goes in the same write, so it reads in the book's again.
 */
export function setAudiobookNarrator(worldId: string, productionId: string, voice: AudiobookReader | null, chapterId?: string): boolean {
  return send({ kind: "set-audiobook-narrator", worldId, productionId, voice, ...(chapterId !== undefined ? { chapterId } : {}) });
}

/** A chapter's own narrator, or null to read it in the book's (R-195). */
export function setAudiobookChapterNarrator(worldId: string, productionId: string, chapterId: string, voice: AudiobookReader | null): boolean {
  return send({ kind: "set-audiobook-chapter-narrator", worldId, productionId, chapterId, voice });
}

/**
 * What a narrator switch would do, before it is made (R-46); answered under the returned id. With
 * a chapter it is that chapter's switch (R-195), and null is the book's narrator. `clears` is a
 * book's switch that also lets that chapter's own narrator go, as the write will.
 */
export function quoteAudiobookNarrator(worldId: string, productionId: string, voice: AudiobookReader | null, chapterId?: string, clears?: string): string | null {
  const requestId = ulid();
  if (!send({ kind: "quote-audiobook-narrator", worldId, productionId, requestId, voice, ...(chapterId !== undefined ? { chapterId } : {}), ...(clears !== undefined ? { clears } : {}) })) return null;
  emitChange({ ...current, narratorQuotes: { ...current.narratorQuotes, [requestId]: { state: "working" } } });
  return requestId;
}

/**
 * A block heard as it would be read, in the narrator's voice or the one given (R-45, R-46) — or,
 * with `proposed`, as the chapter's held proposal would send it (design turn 184b, R-55).
 */
export function hearAudiobookLine(worldId: string, productionId: string, chapterFile: string, block: string, voice?: AudiobookReader, quoteToken?: string, proposed?: boolean): string | null {
  const requestId = ulid();
  if (!send({ kind: "hear-audiobook-line", worldId, productionId, requestId, chapterFile, block, ...(voice !== undefined ? { voice } : {}), ...(quoteToken !== undefined ? { quoteToken } : {}), ...(proposed === true ? { proposed: true as const } : {}) })) return null;
  emitChange({ ...current, heardLines: { ...current.heardLines, [requestId]: { state: "working" } } });
  // A press never sits on `reading…` for good (2026-10-03: an answer the coordinator never sent
  // held the button for as long as the window was open). Past the bound it says so; an answer
  // that still comes replaces the line, so a late file plays.
  const bound = setTimeout(() => {
    if (current.heardLines[requestId]?.state !== "working") return;
    emitChange({ ...current, heardLines: { ...current.heardLines, [requestId]: { state: "refused", refused: HEAR_NO_ANSWER } } });
  }, HEAR_ANSWER_MS);
  // Never what keeps a process alive (Node's timers have `unref`, a browser's do not).
  (bound as unknown as { unref?: () => void }).unref?.();
  return requestId;
}

/** How long a heard block waits for the coordinator before the press gives up: several parts behind a busy lane. */
export const HEAR_ANSWER_MS = 180_000;
export const HEAR_NO_ANSWER = "no answer · open Activity";

export function useNarratorQuotes(): StoreState["narratorQuotes"] {
  return useStoreSelector(store => store.narratorQuotes);
}

export function useHeardLines(): StoreState["heardLines"] {
  return useStoreSelector(store => store.heardLines);
}

/** A speaker recorded by a person, or given back to their voice (SPEC-047 R-37): `narrator`, a sheet id, or a name. */
export function setAudiobookRecorded(worldId: string, productionId: string, speaker: string, recorded: boolean): boolean {
  return send({ kind: "set-audiobook-recorded", worldId, productionId, speaker, recorded });
}

/**
 * A price declined, or an upload consent declined: the run is over on the coordinator's side
 * either way — it returned without a finished event when it asked — so only this window's word
 * goes, and a finished run is never cleared (codex on PR 1180).
 */
export function dismissAudiobookRun(worldId: string, productionId: string, chapterId: string): void {
  const key = `${worldId}/${productionId}/${chapterId}`;
  const held = current.audiobook[key];
  if (held === undefined || (held.state !== "priced" && held.state !== "reading")) return;
  const { [key]: _dropped, ...rest } = current.audiobook;
  emitChange({ ...current, audiobook: rest });
}

/** How each chapter's audiobook run is going, keyed by `worldId/productionId/chapterId`. */
export function useAudiobookRuns(): StoreState["audiobook"] {
  return useStoreSelector(store => store.audiobook);
}

/** Read a chapter into kept takes, these blocks alone (SPEC-047 R-30): the panel's `Make again`. */
export function readAudiobookBlocks(
  worldId: string,
  productionId: string,
  chapterFile: string,
  blocks: readonly string[],
  options: { confirmationToken?: string; voiceUploadConfirmedFor?: string } = {},
): boolean {
  return send({
    kind: "read-audiobook-chapter",
    worldId,
    productionId,
    chapterFile,
    blocks: [...blocks],
    ...(options.confirmationToken !== undefined ? { confirmationToken: options.confirmationToken } : {}),
    ...(options.voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor: options.voiceUploadConfirmedFor } : {}),
  });
}

/** A recording chosen for a block (turn 155c, SPEC-047 R-35): the host's picker opens, and the checks come back under the returned id. */
export function stageAudiobookTake(worldId: string, productionId: string, chapterFile: string, block: string): string | null {
  const requestId = ulid();
  if (!send({ kind: "stage-audiobook-take", worldId, productionId, chapterFile, block, requestId })) return null;
  emitChange({ ...current, stagedTakes: { ...current.stagedTakes, [requestId]: { worldId, productionId, block, state: "choosing" } } });
  return requestId;
}

/** Keep the staged recording as the block's take, under the rights given (R-36). */
export function keepAudiobookTake(worldId: string, requestId: string, basis: "self" | "authorized" | "licensed", performer?: string): boolean {
  const held = current.stagedTakes[requestId];
  if (held === undefined) return false;
  const trimmed = performer?.trim();
  if (!send({ kind: "keep-audiobook-take", worldId, requestId, basis, ...(trimmed ? { performer: trimmed } : {}) })) return false;
  const { refused: _refused, ...rest } = held;
  emitChange({ ...current, stagedTakes: { ...current.stagedTakes, [requestId]: { ...rest, state: "keeping" } } });
  return true;
}

/** Current counts for the Lines sheet, without writing an export or script manifest (SPEC-047 R-39). */
export function previewAudiobookScript(worldId: string, productionId: string, speaker: string): string | null {
  const requestId = ulid();
  if (!send({ kind: "preview-audiobook-script", worldId, productionId, speaker, requestId })) return null;
  emitChange({ ...current, speakerLines: { ...current.speakerLines, [requestId]: { kind: "summary", state: "working" } } });
  return requestId;
}

/** A recorded speaker's script as a PDF under exports/ (SPEC-047 R-39); answered under the returned id. */
export function exportAudiobookScript(worldId: string, productionId: string, speaker: string, label: string, scope: "awaiting" | "all"): string | null {
  const requestId = ulid();
  if (!send({ kind: "export-audiobook-script", worldId, productionId, speaker, label, scope, requestId })) return null;
  emitChange({ ...current, speakerLines: { ...current.speakerLines, [requestId]: { kind: "script", state: "working" } } });
  return requestId;
}

/** The files a performer sent back, chosen together on this machine and matched by the id in each name (R-39). */
export function stageAudiobookLines(worldId: string, productionId: string, speaker: string): string | null {
  const requestId = ulid();
  if (!send({ kind: "stage-audiobook-lines", worldId, productionId, speaker, requestId })) return null;
  emitChange({ ...current, speakerLines: { ...current.speakerLines, [requestId]: { kind: "files", state: "working" } } });
  return requestId;
}

/** Keep the ticked files as takes, under the rights given once (R-36, R-39). */
export function keepAudiobookLines(worldId: string, requestId: string, basis: "self" | "authorized" | "licensed", files: readonly string[], performer?: string): boolean {
  const held = current.speakerLines[requestId];
  if (held === undefined) return false;
  const trimmed = performer?.trim();
  if (!send({ kind: "keep-audiobook-lines", worldId, requestId, basis, files: [...files], ...(trimmed ? { performer: trimmed } : {}) })) return false;
  emitChange({ ...current, speakerLines: { ...current.speakerLines, [requestId]: { ...held, state: "keeping" } } });
  return true;
}

/** Let the matched files go: their staged copies are deleted, nothing was written. */
export function discardAudiobookLines(worldId: string, requestId: string): void {
  const { [requestId]: _gone, ...rest } = current.speakerLines;
  emitChange({ ...current, speakerLines: rest });
  send({ kind: "discard-audiobook-lines", worldId, requestId });
}

export function useSpeakerLines(): StoreState["speakerLines"] {
  return useStoreSelector(store => store.speakerLines);
}

/** Let the staged recording go: its copies are deleted on the machine that made them. */
export function discardAudiobookTake(worldId: string, requestId: string): void {
  const { [requestId]: _gone, ...rest } = current.stagedTakes;
  emitChange({ ...current, stagedTakes: rest });
  send({ kind: "discard-audiobook-take", worldId, requestId });
}

export function useStagedTakes(): StoreState["stagedTakes"] {
  return useStoreSelector(store => store.stagedTakes);
}

/** One block's direction, set or cleared (SPEC-047 R-6): the coordinator answers with the record, or why not. */
export function setAudiobookBlock(worldId: string, productionId: string, chapterFile: string, block: string, direction: import("@arke-studio/contracts").AudiobookDirectionInput | null): string | null {
  const requestId = ulid();
  return send({ kind: "set-audiobook-block", worldId, productionId, chapterFile, block, direction, requestId }) ? requestId : null;
}

/** Join or Split pressed on a gap between two lines (design turn 198): answered with the record, or why not. */
export function setAudiobookSeam(worldId: string, productionId: string, chapterFile: string, press: "join" | "split", anchor: import("@arke-studio/contracts").AudiobookSeamAnchor): boolean {
  return send({ kind: "set-audiobook-seam", worldId, productionId, chapterFile, press, anchor });
}

/** Reset (design turn 198): every seam of the chapter back to the automatic split. */
export function resetAudiobookSeams(worldId: string, productionId: string, chapterFile: string): boolean {
  return send({ kind: "reset-audiobook-seams", worldId, productionId, chapterFile });
}

/** Group by beats (SPEC-047 R-172): the director joins each beat's blocks, answered as `audiobook.beats` under the id returned. */
export function groupChapterBeats(worldId: string, productionId: string, chapterFile: string): string | null {
  const requestId = ulid();
  return send({ kind: "group-chapter-beats", worldId, productionId, chapterFile, requestId }) ? requestId : null;
}

/** The book as a listener hears it (design turn 186): answered as `audiobook.listening` under the id returned. */
export function openAudiobookListening(worldId: string, productionId: string, scope?: import("@arke-studio/contracts").AudiobookScope): string | null {
  const requestId = ulid();
  return send({ kind: "open-audiobook-listening", worldId, productionId, requestId, ...(scope !== undefined ? { scope } : {}) }) ? requestId : null;
}

/** A picture set on a block, or taken off with null (design turn 186c): answered as `audiobook.record` under the id returned. */
export function setAudiobookPicture(worldId: string, productionId: string, chapterFile: string, block: string, picture: { file: string; source: import("@arke-studio/contracts").AudiobookPictureSource; tallFrom?: string } | null): string | null {
  const requestId = ulid();
  return send({ kind: "set-audiobook-picture", worldId, productionId, chapterFile, block, picture, requestId }) ? requestId : null;
}

/** The chapter read for its look (design turn 191c, R-98): answered as `audiobook.record` under the id returned, or refused there. Nothing is spent. */
export function deriveAudiobookLook(worldId: string, productionId: string, chapterFile: string): string | null {
  const requestId = ulid();
  return send({ kind: "derive-audiobook-look", worldId, productionId, chapterFile, requestId }) ? requestId : null;
}

/** The author's explicit identity choice for one existing unresolved chapter line. */
export function linkAudiobookCharacter(worldId: string, productionId: string, chapterFile: string, input: { key: string; expectedName: string; expectedHash: string; sheetId: string }): string | null {
  const requestId = ulid();
  return send({ kind: "link-audiobook-character", worldId, productionId, chapterFile, ...input, requestId }) ? requestId : null;
}

/** One line of the look written (R-98): the place's or one character's; null takes it away. Answered as `audiobook.record`. */
export function setAudiobookLook(worldId: string, productionId: string, chapterFile: string, target: import("@arke-studio/contracts").LookTarget, text: string | null): string | null {
  const requestId = ulid();
  return send({ kind: "set-audiobook-look", worldId, productionId, chapterFile, target, text, requestId }) ? requestId : null;
}

/** One block's timing (design turn 187, R-81): answered as `audiobook.record` under the id returned, or refused there. */
export function setAudiobookTiming(worldId: string, productionId: string, chapterFile: string, block: string, timing: import("@arke-studio/contracts").BlockTimingInput): string | null {
  const requestId = ulid();
  return send({ kind: "set-audiobook-timing", worldId, productionId, chapterFile, block, timing, requestId }) ? requestId : null;
}
export function readAudioStudio(worldId: string, productionId: string, chapterFile: string): string | null {
  const requestId = ulid();
  return send({ kind: "read-audio-studio", worldId, productionId, chapterFile, requestId }) ? requestId : null;
}
/** Spans of an episode's saved mix that just played whole, on the base heard (design turn 230o, issue 1882). */
export function recordAudioHeard(worldId: string, productionId: string, chapterFile: string, base: string, spans: Array<[number, number]>): boolean {
  return send({ kind: "record-audio-heard", worldId, productionId, chapterFile, base, spans });
}
export const audioHeardListeners = new Set<(event: Extract<DomainEvent, { type: "audio-studio.heard" }>) => void>();
/** What of an episode's mix has been heard, for the script's Review (issue 1882). */
export function readAudioHeard(worldId: string, productionId: string, chapterFile: string): string | null {
  const requestId = ulid();
  return send({ kind: "read-audio-heard", worldId, productionId, chapterFile, requestId }) ? requestId : null;
}
export function subscribeAudioHeard(listener: (event: Extract<DomainEvent, { type: "audio-studio.heard" }>) => void): () => void {
  audioHeardListeners.add(listener);
  return () => audioHeardListeners.delete(listener);
}
export function editAudioStudio(worldId: string, productionId: string, chapterFile: string, base: string, edit: import("@arke-studio/contracts").AudioArrangementEdit): string | null {
  const requestId = ulid();
  return send({ kind: "edit-audio-studio", worldId, productionId, chapterFile, base, edit, requestId }) ? requestId : null;
}
export function decideAudioStudioProposal(worldId: string, productionId: string, chapterFile: string, id: string, version: number, decision: "keep" | "apply"): string | null {
  const requestId = ulid();
  return send({ kind: "decide-audio-studio-proposal", worldId, productionId, chapterFile, id, version, decision, requestId }) ? requestId : null;
}
export function readAudioStudioSource(worldId: string, productionId: string, chapterFile: string, file: string, waveform?: boolean, expectedHash?: string): string | null {
  const requestId = ulid();
  return send({ kind: "read-audio-studio-source", worldId, productionId, chapterFile, file, requestId, ...(waveform !== undefined ? { waveform } : {}), ...(expectedHash ? { expectedHash } : {}) }) ? requestId : null;
}
export function previewAudioStudio(worldId: string, productionId: string, chapterFile: string, base: string, options: { edit?: import("@arke-studio/contracts").AudioArrangementEdit; solo?: string[]; window?: { from: number; to: number } } = {}): string | null {
  const requestId = ulid();
  return send({ kind: "preview-audio-studio", worldId, productionId, chapterFile, base, ...options, requestId }) ? requestId : null;
}
export function stopAudioStudioPreview(worldId: string, requestId: string): void { send({ kind: "stop-audio-studio-preview", worldId, requestId }); }

/** A reaction under a block set, changed by its key, or taken away with null (design turn 187, R-83). */
export function setAudiobookReaction(worldId: string, productionId: string, chapterFile: string, key: string | null, reaction: import("@arke-studio/contracts").ReactionInput | null): string | null {
  const requestId = ulid();
  return send({ kind: "set-audiobook-reaction", worldId, productionId, chapterFile, key, reaction, requestId }) ? requestId : null;
}

/** A bed from one block to another set, changed or taken away (R-84). */
export function setAudiobookBed(worldId: string, productionId: string, chapterFile: string, key: string | null, bed: import("@arke-studio/contracts").BedInput | null): string | null {
  const requestId = ulid();
  return send({ kind: "set-audiobook-bed", worldId, productionId, chapterFile, key, bed, requestId }) ? requestId : null;
}

/** A sound at a block's start set, changed or taken away (R-84). */
export function setAudiobookSound(worldId: string, productionId: string, chapterFile: string, key: string | null, sound: import("@arke-studio/contracts").BlockSoundInput | null): string | null {
  const requestId = ulid();
  return send({ kind: "set-audiobook-sound", worldId, productionId, chapterFile, key, sound, requestId }) ? requestId : null;
}

/** Propose timing (design turn 187b, R-86): answered as `audiobook.timing-proposal` under the id returned. */
export function proposeAudiobookTiming(worldId: string, productionId: string, chapterFile: string): string | null {
  const requestId = ulid();
  return send({ kind: "propose-audiobook-timing", worldId, productionId, chapterFile, requestId }) ? requestId : null;
}

/** A proposal accepted whole (R-86): answered as `audiobook.record` under the id returned. */
export function acceptAudiobookTiming(worldId: string, productionId: string, chapterFile: string, proposal: import("@arke-studio/contracts").TimingProposal): string | null {
  const requestId = ulid();
  return send({ kind: "accept-audiobook-timing", worldId, productionId, chapterFile, proposal, requestId }) ? requestId : null;
}

/** The chapter as it sounds with its timing, or a window of it (R-85): answered as `audiobook.mix` under the id returned. */
export function renderAudiobookMix(worldId: string, productionId: string, chapterFile: string, window?: { from: number; to: number }): string | null {
  const requestId = ulid();
  return send({ kind: "render-audiobook-mix", worldId, productionId, chapterFile, requestId, ...(window !== undefined ? { window } : {}) }) ? requestId : null;
}

/** `Direct this chapter` (SPEC-047 R-10): the model asked for a direction per block; the card comes back as a run's result. */
export function directChapter(worldId: string, productionId: string, chapterFile: string, also: { cast?: boolean; speakerNotes?: boolean } = {}): boolean {
  return send({
    kind: "direct-chapter",
    worldId,
    productionId,
    chapterFile,
    ...(also.cast === true ? { cast: true as const } : {}),
    ...(also.speakerNotes === true ? { speakerNotes: true as const } : {}),
  });
}

/** What `Direct this chapter` would read (design turn 184a, R-51), answered under the returned id. */
export function previewDirection(worldId: string, productionId: string, chapterFile: string): string | null {
  const requestId = ulid();
  if (!send({ kind: "preview-direction", worldId, productionId, chapterFile, requestId })) return null;
  emitChange({ ...current, audiobookAsks: { ...current.audiobookAsks, [requestId]: { state: "working" } } });
  return requestId;
}

/** The book note, or with `chapterFile` that chapter's note (design turn 184, R-53); null takes it away. */
export function setAudiobookReadingNote(worldId: string, productionId: string, note: string | null, chapterFile?: string): boolean {
  return send({ kind: "set-audiobook-reading-note", worldId, productionId, note, ...(chapterFile !== undefined ? { chapterFile } : {}) });
}

/** The missing speaker notes drafted from the sheets (design turn 184c, R-54), answered under the returned id. */
export function draftAudiobookSpeakerNotes(worldId: string, productionId: string): string | null {
  const requestId = ulid();
  if (!send({ kind: "draft-audiobook-speaker-notes", worldId, productionId, requestId })) return null;
  emitChange({ ...current, audiobookAsks: { ...current.audiobookAsks, [requestId]: { state: "working" } } });
  return requestId;
}

/** A picture suggested for a block (design turn 191a): answered under the id returned, held in `audiobookAsks`. Nothing is made or spent. */
export function suggestAudiobookPicture(worldId: string, productionId: string, chapterFile: string, block: string): string | null {
  const requestId = ulid();
  if (!send({ kind: "suggest-audiobook-picture", worldId, productionId, chapterFile, block, requestId })) return null;
  emitChange({ ...current, audiobookAsks: { ...current.audiobookAsks, [requestId]: { state: "working" } } });
  return requestId;
}

/** A suggestion made (R-99): the prompt as the author left it and the price the press showed; made through the Bench and filed on the block. */
export function makeAudiobookPicture(worldId: string, productionId: string, chapterFile: string, block: string, input: { prompt: string; who: readonly string[]; reuse?: import("@arke-studio/contracts").PictureReuse; frame?: string; shot?: PictureShot; looks?: Readonly<Record<string, string>>; confirmedMicroUsd: number; tall?: { requestId: string; confirmedMicroUsd: number } }): string | null {
  const requestId = ulid();
  // The looks chosen for this picture alone ride with it (design turn 193d, R-146), each in place of the chapter's for that person.
  // Its Tall rides with the request too (design turn 235): the coordinator makes it once the picture lands, under its own id.
  if (!send({ kind: "make-audiobook-picture", worldId, productionId, chapterFile, block, prompt: input.prompt, who: [...input.who], ...(input.reuse !== undefined ? { reuse: input.reuse } : {}), ...(input.frame !== undefined ? { frame: input.frame } : {}), ...(input.shot !== undefined ? { shot: input.shot } : {}), ...(input.looks !== undefined ? { looks: { ...input.looks } } : {}), confirmedMicroUsd: input.confirmedMicroUsd, requestId, ...(input.tall !== undefined ? { tall: { ...input.tall } } : {}) })) return null;
  emitChange({ ...current, audiobookAsks: { ...current.audiobookAsks, [requestId]: { state: "working" }, ...(input.tall !== undefined ? { [input.tall.requestId]: { state: "working" as const } } : {}) } });
  return requestId;
}

/**
 * Update prompt (design turn 193d, R-146): the writing service rewrites these people's clothing words from the look the prompt
 * was written for to the look now chosen, every other word left as it is. Answered under the id returned, held in `audiobookAsks`.
 */
export function rewriteAudiobookPicturePrompt(worldId: string, productionId: string, chapterFile: string, block: string, prompt: string, changes: ReadonlyArray<{ key: string; from: string; to: string }>): string | null {
  const requestId = ulid();
  if (!send({ kind: "rewrite-audiobook-picture-prompt", worldId, productionId, chapterFile, block, prompt, changes: changes.map((change) => ({ ...change })), requestId })) return null;
  emitChange({ ...current, audiobookAsks: { ...current.audiobookAsks, [requestId]: { state: "working" } } });
  return requestId;
}

/** The book's picture shapes (design turn 235a, SPEC-047 R-195): Wide, Tall or both; nothing is made or removed. */
export function setAudiobookPictureShapes(worldId: string, productionId: string, shapes: readonly ("wide" | "tall")[]): boolean {
  return send({ kind: "set-audiobook-picture-shapes", worldId, productionId, shapes: [...shapes] });
}

/** A block's picture made Tall from the picture it has (design turn 235, R-196); answered under the id returned, held in `audiobookAsks`. */
export function makeAudiobookTallPicture(worldId: string, productionId: string, chapterFile: string, block: string, confirmedMicroUsd: number): string | null {
  const requestId = ulid();
  if (!send({ kind: "make-audiobook-tall-picture", worldId, productionId, chapterFile, block, confirmedMicroUsd, requestId })) return null;
  emitChange({ ...current, audiobookAsks: { ...current.audiobookAsks, [requestId]: { state: "working" } } });
  return requestId;
}

/** `Make 290 tall` (235a, R-199): the book's missing Talls, one at a time, followed through `subscribeAudiobookTallProgress`. */
export function makeAudiobookTallPictures(worldId: string, productionId: string, confirmedMicroUsd: number): boolean {
  return send({ kind: "make-audiobook-tall-pictures", worldId, productionId, confirmedMicroUsd, requestId: ulid() });
}

export function stopAudiobookTallPictures(worldId: string, productionId: string): boolean {
  return send({ kind: "stop-audiobook-tall-pictures", worldId, productionId });
}

export function useAudiobookAsks(): StoreState["audiobookAsks"] {
  return useStoreSelector(store => store.audiobookAsks);
}

/** `Illustrate this chapter` (design turn 191b): the proposal comes back as `illustration.finished`; nothing is made or spent. */
export function illustrateChapter(worldId: string, productionId: string, chapterFile: string): boolean {
  return send({ kind: "illustrate-chapter", worldId, productionId, chapterFile });
}

/** A row taken out of the proposal, or put back (191b). */
export function skipIllustrationRow(worldId: string, productionId: string, chapterId: string, block: string): void {
  const key = `${worldId}/${productionId}/${chapterId}`;
  const run = current.illustration[key];
  if (run === undefined || run.state !== "proposed") return;
  const skipped = run.skipped.includes(block) ? run.skipped.filter((held) => held !== block) : [...run.skipped, block];
  emitChange({ ...current, illustration: { ...current.illustration, [key]: { ...run, skipped } } });
}

/** A row held for a missing reference, sent without it (R-100) — only because the author said so — or held again. */
export function sendIllustrationWithout(worldId: string, productionId: string, chapterId: string, block: string): void {
  const key = `${worldId}/${productionId}/${chapterId}`;
  const run = current.illustration[key];
  if (run === undefined || run.state !== "proposed") return;
  const without = run.without.includes(block) ? run.without.filter((held) => held !== block) : [...run.without, block];
  emitChange({ ...current, illustration: { ...current.illustration, [key]: { ...run, without } } });
}

/** Reread references on the held proposal without asking a provider or changing its words. */
export function refreshIllustrationReferences(worldId: string, productionId: string, chapterId: string, chapterFile: string): boolean {
  const key = `${worldId}/${productionId}/${chapterId}`;
  const run = current.illustration[key];
  if (run?.state !== "proposed" || run.proposal === undefined || run.refreshing) return false;
  if (!send({ kind: "refresh-illustration-references", worldId, productionId, chapterFile, proposalId: run.proposal.proposalId })) return false;
  emitChange({ ...current, illustration: { ...current.illustration, [key]: { ...run, refreshing: true } } });
  return true;
}

/** The proposal accepted (191d): the rows left, one confirm of the total Accept showed; made one at a time. */
export function acceptIllustration(worldId: string, productionId: string, chapterId: string, chapterFile: string): boolean {
  const key = `${worldId}/${productionId}/${chapterId}`;
  const run = current.illustration[key];
  if (run === undefined || run.state !== "proposed" || run.proposal === undefined || run.refreshing) return false;
  const total = illustrationTotal(run.proposal.rows, new Set(run.skipped), new Set(run.without));
  if (total.count === 0) return false;
  // A row held for a reference, or one a run's picture was refused for, goes only once the author named it (2026-10-04).
  const blocks = run.proposal.rows.filter((row) => illustrationRowGoes(row, new Set(run.skipped), new Set(run.without))).map((row) => row.block);
  const sent = send({ kind: "accept-illustration", worldId, productionId, chapterFile, proposalId: run.proposal.proposalId, blocks, ...(run.without.length > 0 ? { without: run.without } : {}), confirmedMicroUsd: total.microUsd });
  if (sent) {
    const { reason: _reason, ...rest } = run;
    emitChange({ ...current, illustration: { ...current.illustration, [key]: { ...rest, state: "making", progress: { proposalId: run.proposal.proposalId, state: "making", total: total.count, made: [], failed: [], spentMicroUsd: 0, confirmedMicroUsd: total.microUsd } } } });
  }
  return sent;
}

/** Stop keeps what is made and costs nothing more (191d). */
export function stopIllustration(worldId: string, productionId: string, chapterFile: string): void {
  send({ kind: "stop-illustration", worldId, productionId, chapterFile });
}

/** The proposal discarded, or an ended run put away: nothing is spent, and the coordinator stops holding it. */
export function dismissIllustration(worldId: string, productionId: string, chapterId: string, chapterFile: string): void {
  const key = `${worldId}/${productionId}/${chapterId}`;
  const held = current.illustration[key];
  if (held === undefined || held.state === "making" || held.state === "reading") return;
  if (held.state === "proposed") send({ kind: "discard-illustration", worldId, productionId, chapterFile });
  const { [key]: _gone, ...rest } = current.illustration;
  emitChange({ ...current, illustration: rest });
}

export function useIllustrationRuns(): StoreState["illustration"] {
  return useStoreSelector(store => store.illustration);
}

/** The card accepted whole: the coordinator checks every direction once more and writes the record. */
export function acceptDirection(worldId: string, productionId: string, chapterId: string, chapterFile: string): boolean {
  const key = `${worldId}/${productionId}/${chapterId}`;
  const card = current.direction[key];
  if (card === undefined || card.state !== "directed" || card.proposed === undefined || card.hash === undefined) return false;
  const requestId = ulid();
  const sent = send({ kind: "accept-direction", worldId, productionId, chapterFile, requestId, hash: card.hash, directions: card.proposed, ...(card.proposalId !== undefined ? { proposalId: card.proposalId } : {}) });
  if (sent) emitChange({ ...current, direction: { ...current.direction, [key]: { ...card, state: "accepting", requestId } } });
  return sent;
}

/**
 * The card discarded, or an ended derivation put away: nothing was written, and the coordinator
 * is told to stop holding a proposal for a window that reconnects. `chapterFile` names the
 * chapter to the coordinator as every audiobook frame does.
 */
export function dismissDirection(worldId: string, productionId: string, chapterId: string, chapterFile: string): void {
  const key = `${worldId}/${productionId}/${chapterId}`;
  const held = current.direction[key];
  if (held === undefined || held.state === "directing") return;
  if (held.state === "directed") send({ kind: "discard-direction", worldId, productionId, chapterFile });
  const { [key]: _dropped, ...rest } = current.direction;
  emitChange({ ...current, direction: rest });
}

export function useDirectionRuns(): StoreState["direction"] {
  return useStoreSelector(store => store.direction);
}

/** Group by beats as it runs and ends (design turn 201), by `world/production/chapter`. */
export function useBeatRuns(): StoreState["beats"] {
  return useStoreSelector(store => store.beats);
}

export function useAudiobookRecords(): StoreState["audiobookRecords"] {
  return useStoreSelector(store => store.audiobookRecords);
}
