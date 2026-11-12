// A graphic novel's commands: its script, pages, panels, lettering and export (SPEC-064; issue 2800).
import {
  type ComicPage, ulid, type ComicMode, type LetteringPlacement, type ClientMessage,
} from "@arke-studio/contracts";
import { send } from "./core.js";

/**
 * Save a graphic novel chapter's comic script whole (SPEC-064 R-10). `baseHash` is the file the
 * editor read, null for a chapter with no script yet; the answer, by requestId, carries the next base.
 */
export function saveComicScript(worldId: string, productionId: string, chapter: string, pages: ComicPage[], baseHash: string | null): string | null {
  const requestId = ulid();
  return send({ kind: "save-comic-script", requestId, worldId, productionId, chapter, pages, baseHash }) ? requestId : null;
}

/** Ask what a page would cost and send; also files a page that landed while the app was closed (SPEC-064 R-25). */
export function quoteComicPage(worldId: string, productionId: string, page: string, mode?: ComicMode, panel?: string): string | null {
  const requestId = ulid();
  return send({ kind: "quote-comic-page", requestId, worldId, productionId, page, ...(mode !== undefined ? { mode } : {}), ...(panel !== undefined ? { panel } : {}) }) ? requestId : null;
}

/** Panel by panel: every panel not yet made, or this one, on the price its press showed (SPEC-064 R-37a). */
export function makeComicPanels(worldId: string, productionId: string, page: string, confirmedMicroUsd: number, panel?: string): string | null {
  const requestId = ulid();
  return send({ kind: "make-comic-page", requestId, worldId, productionId, page, confirmedMicroUsd, ...(panel !== undefined ? { panel } : {}) }) ? requestId : null;
}

/** Where a page's words stand (SPEC-064 R-38a); `undoesPlacing` lets go of what Arke's placing kept. */
export function setComicLettering(worldId: string, productionId: string, page: string, placements: LetteringPlacement[], undoesPlacing = false): string | null {
  const requestId = ulid();
  return send({ kind: "set-comic-lettering", requestId, worldId, productionId, page, placements, ...(undoesPlacing ? { undoesPlacing: true as const } : {}) }) ? requestId : null;
}

/** Place with Arke, a page or a chapter's ready pages (SPEC-064 R-39a). */
export function placeComicLettering(worldId: string, productionId: string, target: { kind: "page"; page: string } | { kind: "chapter"; chapter: string }): string | null {
  const requestId = ulid();
  return send({ kind: "place-comic-lettering", requestId, worldId, productionId, target }) ? requestId : null;
}

/** Accept page: the image flattened here, filed as the page (SPEC-064 R-48a). */
export function finishComicPage(worldId: string, productionId: string, page: string, hash: string, jpegBase64: string): string | null {
  const requestId = ulid();
  return send({ kind: "finish-comic-page", requestId, worldId, productionId, page, hash, jpegBase64 }) ? requestId : null;
}

/** Make a page on the price its press showed (SPEC-064 R-27). */
export function makeComicPage(worldId: string, productionId: string, page: string, confirmedMicroUsd: number, mode?: ComicMode, untilPasses?: boolean): string | null {
  const requestId = ulid();
  return send({ kind: "make-comic-page", requestId, worldId, productionId, page, confirmedMicroUsd, ...(mode !== undefined ? { mode } : {}), ...(untilPasses ? { untilPasses: true as const } : {}) }) ? requestId : null;
}

/** The book as CBZ and/or PDF from its accepted pages (SPEC-064 R-47). */
export function exportComic(worldId: string, productionId: string, formats: Array<"cbz" | "pdf" | "epub">): string | null {
  const requestId = ulid();
  return send({ kind: "export-comic", requestId, worldId, productionId, formats }) ? requestId : null;
}

/** Read a take back and check its lettering again (SPEC-064 R-29). */
export function checkComicTake(worldId: string, productionId: string, page: string, take: string): string | null {
  const requestId = ulid();
  return send({ kind: "check-comic-take", requestId, worldId, productionId, page, take }) ? requestId : null;
}

/** Keep a take as the page; past findings or an unchecked take only with an override (SPEC-064 R-33). */
export function acceptComicTake(worldId: string, productionId: string, page: string, take: string, override?: { findings: string[]; reason?: string }): string | null {
  const requestId = ulid();
  return send({ kind: "accept-comic-take", requestId, worldId, productionId, page, take, ...(override ? { override } : {}) }) ? requestId : null;
}

/** A picture review's warning on a take marked Seen (SPEC-064 R-69, turn 253c). */
/** Stop a Make card's run: a panel already started finishes, and nothing new starts (turn 270b). */
export function stopComicMake(worldId: string, run: string): void {
  send({ kind: "stop-comic-make", worldId, run });
}

export function seeComicWarning(worldId: string, productionId: string, page: string, take: string, warning: "layout" | "continuity" | "likeness"): string | null {
  const requestId = ulid();
  return send({ kind: "see-comic-warning", requestId, worldId, productionId, page, take, warning }) ? requestId : null;
}

/** How a graphic novel reads and how its pages are checked (SPEC-064 R-12). */
export function setComicSettings(worldId: string, productionId: string, settings: Extract<ClientMessage, { kind: "set-comic-settings" }>["settings"]): boolean {
  return send({ kind: "set-comic-settings", worldId, productionId, settings });
}
