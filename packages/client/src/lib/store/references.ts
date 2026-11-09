import { type SizeTier, ulid, type DomainEvent } from "@arke-studio/contracts";
import { current, emitChange, send, useStoreSelector, type FrameSlices, type Folded } from "./core.js";
import { pendingQueueRequests, queueRequest } from "./events.js";

// ---- SPEC-010/017: reference kits ------------------------------------------

export function chooseAnchor(
  worldId: string,
  sheetId: string,
  selection: { source: "take"; takeId: string } | { source: "candidate"; file: string } | { source: "legacy-portrait" },
): void {
  if (current.mainPhotoAcceptance[sheetId]?.status === null) return;
  emitChange({
    ...current,
    mainPhotoAcceptance: {
      ...current.mainPhotoAcceptance,
      [sheetId]: { status: null, candidateRetained: true },
    },
  });
  if (!send({ kind: "choose-anchor", worldId, sheetId, selection })) clearMainPhotoAcceptance(sheetId);
}

export function useMainPhotoAcceptance() {
  return useStoreSelector(store => store.mainPhotoAcceptance);
}

export function clearMainPhotoAcceptance(sheetId: string): void {
  const mainPhotoAcceptance = { ...current.mainPhotoAcceptance };
  delete mainPhotoAcceptance[sheetId];
  emitChange({ ...current, mainPhotoAcceptance });
}

export function importMainPhotoCandidate(worldId: string, sheetId: string): void {
  send({ kind: "import-main-photo-candidate", worldId, sheetId });
}

/**
 * Bring the whole main photo in from a file, no generation involved.
 *
 * In flight from the press until the coordinator answers. The dialog is modal while it is open,
 * but it closes long before the work is done — up to 50 MB still to read, copy and commit — and
 * the window is live again for all of it. A second press in that gap opens a competing import of
 * the same sheet, and the two accepts race (PR review). This is only safe to set because a
 * cancelled dialog now reports "cancelled": without that ending, the button would have had no way
 * back from a dialog somebody simply closed.
 */
export function importMainPhoto(worldId: string, sheetId: string): void {
  if (current.mainPhotoAcceptance[sheetId]?.status === null) return;
  emitChange({
    ...current,
    mainPhotoAcceptance: {
      ...current.mainPhotoAcceptance,
      [sheetId]: { status: null, candidateRetained: false },
    },
  });
  if (!send({ kind: "import-main-photo", worldId, sheetId })) clearMainPhotoAcceptance(sheetId);
}

export function importCharacterSheet(worldId: string, sheetId: string): void {
  if (current.characterSheetAcceptance[sheetId]?.status === null) return;
  emitChange({
    ...current,
    characterSheetAcceptance: { ...current.characterSheetAcceptance, [sheetId]: { status: null } },
  });
  if (!send({ kind: "import-character-sheet", worldId, sheetId })) clearCharacterSheetAcceptance(sheetId);
}

export function useCharacterSheetAcceptance() {
  return useStoreSelector(store => store.characterSheetAcceptance);
}

export function clearCharacterSheetAcceptance(sheetId: string): void {
  const characterSheetAcceptance = { ...current.characterSheetAcceptance };
  delete characterSheetAcceptance[sheetId];
  emitChange({ ...current, characterSheetAcceptance });
}

export function generateMainPhoto(
  worldId: string,
  sheetId: string,
  prompt: string,
  count: number,
  identityReferences: string[],
  choice: { modelId?: string; tier?: SizeTier } = {},
): void {
  send({
    kind: "generate-main-photo",
    ...(choice.modelId !== undefined ? { modelId: choice.modelId } : {}),
    ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    worldId,
    sheetId,
    prompt,
    count,
    identityReferences,
    requestId: queueRequest("generate-main-photo"),
  });
}

export function generateCharacterSheet(
  worldId: string,
  sheetId: string,
  styleOverride?: string,
  characterName?: string,
  choice: { modelId?: string; tier?: SizeTier } = {},
): string | null {
  const requestId = queueRequest("generate-character-sheet", characterName);
  const sent = send({
    kind: "generate-character-sheet",
    ...(choice.modelId !== undefined ? { modelId: choice.modelId } : {}),
    ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    worldId,
    sheetId,
    requestId,
    ...(styleOverride ? { styleOverride } : {}),
  });
  if (!sent) {
    pendingQueueRequests.delete(requestId);
    return null;
  }
  return requestId;
}

export function acceptCharacterSheet(worldId: string, sheetId: string, takeId: string): void {
  send({ kind: "accept-character-sheet", worldId, sheetId, takeId });
}

// ---- Location views (issue 243) -------------------------------------------------

export function generateLocationView(
  worldId: string,
  sheetId: string,
  input: { name: string; prompt?: string; count: number; establishing?: boolean },
  choice: { modelId?: string; tier?: SizeTier } = {},
): string | null {
  const requestId = queueRequest("generate-location-view", input.name);
  const sent = send({
    kind: "generate-location-view",
    ...(choice.modelId !== undefined ? { modelId: choice.modelId } : {}),
    ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    worldId,
    sheetId,
    name: input.name,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    count: input.count,
    ...(input.establishing !== undefined ? { establishing: input.establishing } : {}),
    requestId,
  });
  if (!sent) {
    pendingQueueRequests.delete(requestId);
    return null;
  }
  return requestId;
}

/**
 * `replaceExistingName` is the confirmation, not a convenience: without it a colliding name
 * refuses, because superseding an angle somebody still wants is a loss they would only notice
 * later, in a shot.
 */
export function acceptLocationView(
  worldId: string,
  sheetId: string,
  selection: { source: "take"; takeId: string } | { source: "candidate"; file: string },
  input: { name: string; establishing?: boolean; replaceExistingName?: boolean },
): void {
  send({
    kind: "accept-location-view",
    worldId,
    sheetId,
    selection,
    name: input.name,
    ...(input.establishing !== undefined ? { establishing: input.establishing } : {}),
    ...(input.replaceExistingName !== undefined ? { replaceExistingName: input.replaceExistingName } : {}),
  });
}

/** Opens the host picker. Lands an unreviewed candidate; naming it is the separate accept. */
export function importLocationViewCandidate(worldId: string, sheetId: string): void {
  if (current.locationViewUpload[sheetId]?.status === null) return;
  emitChange({
    ...current,
    locationViewUpload: { ...current.locationViewUpload, [sheetId]: { status: null } },
  });
  if (!send({ kind: "import-location-view-candidate", worldId, sheetId })) {
    clearLocationViewUpload(sheetId);
  }
}

export function useLocationViewUpload() {
  return useStoreSelector(store => store.locationViewUpload);
}

export function clearLocationViewUpload(sheetId: string): void {
  const locationViewUpload = { ...current.locationViewUpload };
  delete locationViewUpload[sheetId];
  emitChange({ ...current, locationViewUpload });
}

export function generateCharacterLooks(
  worldId: string,
  sheetId: string,
  lookKind: "costume" | "pose-expression" | "condition-age",
  mode: "stay-close" | "push-it",
  prompt: string,
  count: number,
  choice: { modelId?: string; tier?: SizeTier } = {},
): void {
  send({
    kind: "generate-character-looks",
    ...(choice.modelId !== undefined ? { modelId: choice.modelId } : {}),
    ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    worldId,
    sheetId,
    lookKind,
    mode,
    prompt,
    count,
    requestId: queueRequest("generate-character-looks"),
  });
}

export function acceptCharacterLook(worldId: string, sheetId: string, takeId: string): void {
  send({ kind: "accept-character-look", worldId, sheetId, takeId });
}

/**
 * Candidates of a look for a chapter's pictures (design turn 193, SPEC-047 R-112): `full-body`
 * makes `count` full-length pictures from the main photo and the clothing line; `close` makes the
 * head-and-shoulders view of one candidate or one accepted look. Returns the request's id — the
 * pictures that arrive carry it as their batch — or null when the coordinator is away.
 */
export function makeChapterLook(
  worldId: string,
  sheetId: string,
  input: { framing: "full-body" | "close"; prompt: string; count: number; closeOf?: { takeId?: string; lookId?: string }; modelId?: string },
): string | null {
  const requestId = queueRequest("generate-character-looks");
  return send({
    kind: "generate-character-looks",
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    worldId,
    sheetId,
    lookKind: "costume",
    mode: "stay-close",
    prompt: input.prompt,
    count: input.count,
    framing: input.framing,
    ...(input.closeOf !== undefined ? { closeOf: input.closeOf } : {}),
    requestId,
  })
    ? requestId
    : null;
}

/** A candidate accepted as the character's look, with its close view, and chosen for the chapter that asked (R-112, R-118). */
export function acceptChapterLook(
  worldId: string,
  sheetId: string,
  takeId: string,
  options: { name?: string; closeTakeId?: string; closeFor?: string; choose?: { productionId: string; chapterFile: string; key: string; name?: string; sheet?: string } } = {},
): boolean {
  return send({ kind: "accept-character-look", worldId, sheetId, takeId, ...options });
}

/** Which chapters of the book chose each kit look (R-114), answered under the id returned and held in `audiobookAsks`. */
export function readAudiobookLooks(worldId: string, productionId: string, coverage = false): string | null {
  const requestId = ulid();
  if (!send({ kind: "read-audiobook-looks", worldId, productionId, requestId, ...(coverage ? { coverage: true } : {}) })) return null;
  emitChange({ ...current, audiobookAsks: { ...current.audiobookAsks, [requestId]: { state: "working" } } });
  return requestId;
}

/**
 * A kit look chosen for a character in this chapter, or the choice taken away with null (R-112). Answered as `audiobook.record`.
 * From a block's look menu (design turn 193d, R-146) it names the block: with `only`, for that block's picture alone (null: the
 * main photo), held on the block until made; without, the chapter's choice, which that block's picture then follows.
 */
export function chooseAudiobookLook(worldId: string, productionId: string, chapterFile: string, who: { key: string; name?: string; sheet?: string }, lookId: string | null, picture?: { block: string; only?: boolean }): string | null {
  const requestId = ulid();
  return send({ kind: "choose-audiobook-look", worldId, productionId, chapterFile, ...who, lookId, ...(picture !== undefined ? { block: picture.block, ...(picture.only === true ? { only: true as const } : {}) } : {}), requestId }) ? requestId : null;
}

export function rejectReferenceTake(worldId: string, takeId: string, field: string, note?: string): boolean {
  return send({
    kind: "reject-reference-take",
    worldId,
    takeId,
    field,
    ...(note ? { note } : {}),
  });
}

export function promoteCharacterLook(worldId: string, sheetId: string, lookId: string): void {
  send({ kind: "promote-character-look", worldId, sheetId, lookId });
}

export function attachCharacterLook(
  worldId: string,
  sheetId: string,
  lookId: string,
  scope:
    | { kind: "production"; productionId: string }
    | { kind: "scene"; productionId: string; sceneId: string }
    | null,
): void {
  send({ kind: "attach-character-look", worldId, sheetId, lookId, scope });
}

export function setStyleOverride(worldId: string, sheetId: string, style: string | null): void {
  send({ kind: "set-style-override", worldId, sheetId, style });
}

// ---- props (design turn 105; issues 535, 537) --------------------------------------------

export function createProp(worldId: string, name: string): void {
  send({ kind: "create-prop", worldId, name });
}

export function addPropState(worldId: string, propId: string, name: string): void {
  send({ kind: "add-prop-state", worldId, propId, name });
}

/** The host picker lands one image as a pending take under the prop; accepting is a second, asked step. */
export function importPropStateCandidate(worldId: string, propId: string, stateId: string): void {
  send({ kind: "import-prop-state-candidate", worldId, propId, stateId });
}

export function acceptPropState(
  worldId: string,
  propId: string,
  stateId: string,
  selection: import("@arke-studio/contracts").PropStateSelection,
  replace = false,
): void {
  send({ kind: "accept-prop-state", worldId, propId, stateId, selection, ...(replace ? { replace: true } : {}) });
}

/** handleFrame's arms for main-photo.acceptance … location-view.upload, in their order (issue 2800). */
export function foldReferenceEvent(slices: FrameSlices, event: DomainEvent): Folded {
  if (event.type === "main-photo.acceptance") {
    // A cancelled dialog leaves no trace: it releases the button and says nothing, because
    // there is nothing to say about a choice the user declined to make.
    slices.mainPhotoAcceptance = { ...slices.mainPhotoAcceptance };
    if (event.status === "cancelled") delete slices.mainPhotoAcceptance[event.sheetId];
    else {
      slices.mainPhotoAcceptance[event.sheetId] = {
        status: event.status,
        ...(event.reason ? { reason: event.reason } : {}),
        candidateRetained: event.candidateRetained,
      };
    }
  } else if (event.type === "character-sheet.acceptance") {
    slices.characterSheetAcceptance = { ...slices.characterSheetAcceptance };
    if (event.status === "cancelled") delete slices.characterSheetAcceptance[event.sheetId];
    else {
      slices.characterSheetAcceptance[event.sheetId] = {
        status: event.status,
        ...(event.reason ? { reason: event.reason } : {}),
      };
    }
  } else if (event.type === "location-view.upload") {
    slices.locationViewUpload = { ...slices.locationViewUpload };
    if (event.status === "cancelled") delete slices.locationViewUpload[event.sheetId];
    else {
      slices.locationViewUpload[event.sheetId] = {
        status: event.status,
        ...(event.reason ? { reason: event.reason } : {}),
      };
    }
  } else return "none";
  return "done";
}
