import { ONE_IMAGE_ONLY, type PlacePlanChange, type PlacePlanSource, type SizeTier, ulid, type DomainEvent } from "@arke-studio/contracts";
import type { AttachTarget } from "../../arke-bridge.js";
import { current, emitChange, send, type FrameSlices, type Folded } from "./core.js";
import { useStoreSelector } from "./hooks.js";
import { pendingQueueRequests, queueRequest } from "./events.js";
import { attachHostFiles, hostCanAttach } from "./world.js";

/** A picture the reference picker offers: a world's slug and the image's path in it (issue 972). */
export type StudioPicture = { slug: string; path: string };

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

/**
 * One more picture to choose the main photo from: the host's picker, or — named — a picture
 * already in this world or another, used as the photo itself rather than as a reference for a
 * generated one (issue 3146). The coordinator copies it in and keeps where it came from.
 */
export function importMainPhotoCandidate(worldId: string, sheetId: string, picture?: StudioPicture): void {
  send({ kind: "import-main-photo-candidate", worldId, sheetId, ...(picture ? { image: picture } : {}) });
}

/**
 * Why a drop cannot be sent at all, or null when it can (issue 3146).
 *
 * Counted here because the drop is where the count is known: sent one frame per file, two
 * pictures dropped on one slot would race to be the main photo, and the later would win without
 * a word. The Upload button's dialog refuses the same thing in the same words.
 */
function dropRefusal(files: readonly File[]): string | null {
  if (!hostCanAttach()) return "Upload is available in the desktop app";
  if (current.connection !== "open") return "The studio is disconnected. Reconnect and try again.";
  return files.length === 1 ? null : ONE_IMAGE_ONLY;
}

/**
 * Hand a dropped file to the host, which resolves where it lives and sends the import with that
 * path, exactly as it does for a file dropped on a conversation. Resolves with a reason when the
 * file could not be handed over, so the slot that took the drop can say so.
 */
async function sendDropped(target: AttachTarget, files: readonly File[]): Promise<string | null> {
  const trouble = await attachHostFiles(target, files);
  return trouble.length === 0 ? null : "That file could not be read. Try choosing it again.";
}

/**
 * A file dropped on the main photo's slot (issue 3146): the Upload button's import, with the
 * choosing already done by the drop. In flight from the drop until the coordinator answers, for
 * the reason `importMainPhoto` gives, and refused into the same slot its refusals land in.
 */
export async function dropMainPhoto(worldId: string, sheetId: string, files: readonly File[]): Promise<void> {
  if (current.mainPhotoAcceptance[sheetId]?.status === null) return;
  const refused = dropRefusal(files);
  const mark = (status: { status: "failed"; reason: string } | { status: null }) =>
    emitChange({
      ...current,
      mainPhotoAcceptance: { ...current.mainPhotoAcceptance, [sheetId]: { ...status, candidateRetained: false } },
    });
  if (refused !== null) return mark({ status: "failed", reason: refused });
  mark({ status: null });
  const trouble = await sendDropped({ kind: "import-main-photo", worldId, sheetId }, files);
  if (trouble !== null) mark({ status: "failed", reason: trouble });
}

/** A file dropped in the main photo dialog: one more candidate, as its Upload adds. */
export async function dropMainPhotoCandidate(worldId: string, sheetId: string, files: readonly File[]): Promise<void> {
  const refused = dropRefusal(files) ?? (await sendDropped({ kind: "import-main-photo-candidate", worldId, sheetId }, files));
  if (refused === null) return;
  emitChange({
    ...current,
    mainPhotoAcceptance: {
      ...current.mainPhotoAcceptance,
      [sheetId]: { status: "failed", reason: refused, candidateRetained: false },
    },
  });
}

/** A file dropped on the character sheet's slot: the sheet's Upload, by drop (issue 3146). */
export async function dropCharacterSheet(worldId: string, sheetId: string, files: readonly File[]): Promise<void> {
  if (current.characterSheetAcceptance[sheetId]?.status === null) return;
  const refused = dropRefusal(files);
  const mark = (status: { status: "failed"; reason: string } | { status: null }) =>
    emitChange({ ...current, characterSheetAcceptance: { ...current.characterSheetAcceptance, [sheetId]: status } });
  if (refused !== null) return mark({ status: "failed", reason: refused });
  mark({ status: null });
  const trouble = await sendDropped({ kind: "import-character-sheet", worldId, sheetId }, files);
  if (trouble !== null) mark({ status: "failed", reason: trouble });
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

/**
 * The character sheet brought in by hand: from the host's picker, or a picture already in this
 * world or another (issue 3146), designated in the same motion either way.
 */
export function importCharacterSheet(worldId: string, sheetId: string, picture?: StudioPicture): void {
  if (current.characterSheetAcceptance[sheetId]?.status === null) return;
  emitChange({
    ...current,
    characterSheetAcceptance: { ...current.characterSheetAcceptance, [sheetId]: { status: null } },
  });
  if (!send({ kind: "import-character-sheet", worldId, sheetId, ...(picture ? { image: picture } : {}) })) {
    clearCharacterSheetAcceptance(sheetId);
  }
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

// ---- The Plan (design turn 285, issue 2302) -------------------------------------

/**
 * One change to a place's camera positions. `from` names the scene whose set becomes the place's
 * when the place has no plan yet: the scene page always names it, and the location's own page,
 * which has no scene to name, never does. Nothing is kept here while it is in flight: the plan on
 * screen is the snapshot's, and a refusal arrives as any failed command does.
 */
export function changePlacePlan(worldId: string, sheetId: string, change: PlacePlanChange, from?: PlacePlanSource): boolean {
  return send({ kind: "place-plan", worldId, sheetId, ...(from === undefined ? {} : { from }), change });
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
