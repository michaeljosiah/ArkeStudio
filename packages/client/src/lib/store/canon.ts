import { type AskResult, ProviderIdSchema, type ProviderId, ulid } from "@arke-studio/contracts";
import { send, useStoreSelector } from "./core.js";
import type { CanonSearchState, CanonRefsState } from "./state.js";
import type { SingleActResult } from "./events.js";

// ---- canon (SPEC-006) ------------------------------------------------------

export function askCanon(worldId: string, askId: string, question: string): void {
  send({ kind: "canon-ask", worldId, askId, question });
}

export function searchCanonList(worldId: string, searchId: string, query: string): void {
  send({ kind: "canon-search", worldId, searchId, query });
}

export function requestCanonRefs(worldId: string, entryId: string): void {
  send({ kind: "canon-refs", worldId, entryId });
}

export function stageCanonEntry(
  worldId: string,
  entryType: "rule" | "lore" | "location" | "faction" | "timeline" | "tone",
  title: string,
  statement: string,
): string | null {
  const requestId = ulid();
  return send({ kind: "stage-canon-entry", worldId, requestId, entryType, title, statement }) ? requestId : null;
}

export function stageCanonAmendment(worldId: string, entryId: string, statement: string): string | null {
  const requestId = ulid();
  return send({ kind: "stage-canon-amendment", worldId, requestId, entryId, statement }) ? requestId : null;
}

export function openThread(worldId: string, title: string, question: string, candidates: string[]): void {
  send({ kind: "open-thread", worldId, title, question, candidates });
}

export function settleThread(
  worldId: string,
  entryId: string,
  resolvedType: "rule" | "lore" | "location" | "faction" | "timeline" | "tone",
  statement: string,
): string | null {
  const requestId = ulid();
  return send({ kind: "settle-thread", worldId, requestId, entryId, resolvedType, statement }) ? requestId : null;
}

export function requestCanonContradictions(
  worldId: string,
  title: string,
  statement: string,
  excludeEntryId?: string,
): string | null {
  const requestId = ulid();
  return send({
    kind: "canon-contradictions",
    worldId,
    requestId,
    title,
    statement,
    ...(excludeEntryId !== undefined ? { excludeEntryId } : {}),
  }) ? requestId : null;
}

export function undoSingleAct(result: SingleActResult): string | null {
  if (!result.undo) return null;
  const requestId = ulid();
  return send({
    kind: "undo-single-act",
    worldId: result.worldId,
    requestId,
    operation: result.operation,
    path: result.path,
    undo: result.undo,
  }) ? requestId : null;
}

/**
 * Rename the world — the label, not the folder. The directory is the address every path and
 * artifact resolves through, so this changes the word on the screen and nothing else.
 */
export function renameWorld(worldId: string, name: string): void {
  send({ kind: "rename-world", worldId, name });
}

export function retireEntity(worldId: string, path: string): void {
  send({ kind: "retire-entity", worldId, path });
}

export function useAskResults(): Record<string, AskResult> {
  return useStoreSelector(store => store.askResults);
}

export function useCanonSearches(): Record<string, CanonSearchState> {
  return useStoreSelector(store => store.canonSearches);
}

export function useCanonRefs(): Record<string, CanonRefsState> {
  return useStoreSelector(store => store.canonRefs);
}

// ---- sheets (SPEC-007) -----------------------------------------------------

export interface SheetRefsState {
  tiles: number;
  productions: string[];
  artifacts: string[];
  scenes: string[];
  takesByVersion: Record<string, number>;
  incomingLinks: string[];
}

export function createSheetFromSentence(
  worldId: string,
  sheetType: "character" | "location" | "faction",
  name: string,
  sentence: string,
  /** Settle it as drafted, without asking — see the frame. Beginning a world sets this. */
  settle = false,
  /** Creating from inside a production files a guest of it rather than world cast (SPEC-020). */
  production?: string,
): void {
  send({
    kind: "create-sheet-from-sentence",
    worldId,
    sheetType,
    name,
    sentence,
    ...(settle ? { settle } : {}),
    ...(production !== undefined ? { production } : {}),
  });
}

/** SPEC-020 R-14: clear the guest's owner. No file moves and no citation breaks. */
export function promoteGuest(worldId: string, path: string): string | null {
  const requestId = ulid();
  return send({ kind: "promote-guest", worldId, requestId, path }) ? requestId : null;
}

export function duplicateSheet(worldId: string, path: string, newName: string): string | null {
  const requestId = ulid();
  return send({ kind: "duplicate-sheet", worldId, requestId, path, newName }) ? requestId : null;
}

export function setSheetStatus(worldId: string, path: string, status: "sketch" | "locked"): string | null {
  const requestId = ulid();
  return send({ kind: "set-sheet-status", worldId, requestId, path, status }) ? requestId : null;
}

/** Rename a sheet, and for a character set its short name too (null or empty puts the default back; absent leaves it). */
export function renameSheet(worldId: string, path: string, name: string, shortName?: string | null, aliases?: string[]): string | null {
  const requestId = ulid();
  return send({ kind: "rename-sheet", worldId, requestId, path, name, ...(shortName !== undefined ? { shortName } : {}), ...(aliases !== undefined ? { aliases } : {}) }) ? requestId : null;
}

/**
 * A character's narration (design turn 200, SPEC-047 R-165): how a narrator plays them under
 * `performed`, written straight to the sheet. Null or empty clears it. False when disconnected.
 */
export function setSheetNarration(worldId: string, path: string, narration: string | null): boolean {
  const trimmed = narration?.trim() ?? "";
  return send({ kind: "set-sheet-narration", worldId, path, narration: trimmed === "" ? null : trimmed });
}

export function assignVoice(
  worldId: string,
  path: string,
  // Any provider the catalogue can offer, which since SPEC-022 includes a cloned voice on
  // `comfyui`. The wire takes a plain string; this stays a provider id so a typo cannot reach it.
  voice: { provider: ProviderId; model: string; voiceId: string; label?: string } | null,
): string | null {
  const requestId = ulid();
  return send({ kind: "assign-voice", requestId, worldId, path, voice }) ? requestId : null;
}

/**
 * A catalogue provider as an id this build can actually spell.
 *
 * `VoiceCandidate.provider` is an open string on purpose — it is a read path, and a coordinator
 * that learns a new provider should not have its events dropped by an older renderer. That makes
 * narrowing the caller's job, and a candidate naming a provider this build has never heard of is
 * a row that cannot be previewed or assigned rather than a crash.
 */
export function providerIdOf(provider: string): ProviderId | null {
  const parsed = ProviderIdSchema.safeParse(provider);
  return parsed.success ? parsed.data : null;
}

export function requestSheetRefs(worldId: string, sheetId: string): void {
  send({ kind: "sheet-refs", worldId, sheetId });
}

export function useSheetRefs(): Record<string, SheetRefsState> {
  return useStoreSelector(store => store.sheetRefs);
}
