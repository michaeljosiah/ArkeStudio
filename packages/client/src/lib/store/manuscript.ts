import {
  type ArkePlayerPartRequest, type ArkePlayerPictureSize, ulid, type DomainEvent,
} from "@arke-studio/contracts";
import { isRemoteSession } from "../remote-session.js";
import { current, emitChange, send, type FrameSlices, type Folded } from "./core.js";
import { useStoreSelector } from "./hooks.js";
import type { StoreState } from "./state.js";

// ---- turn 131: a manuscript out and in ------------------------------------

export function exportManuscript(worldId: string, productionId: string, format: "docx" | "epub", language?: string): boolean {
  return send({ kind: "export-manuscript", worldId, productionId, format, ...(language !== undefined && format === "epub" ? { language } : {}) });
}

export function openExportsFolder(worldId: string, dir?: string, file?: string): void {
  send({ kind: "open-exports-folder", worldId, ...(dir !== undefined ? { dir } : {}), ...(dir !== undefined && file !== undefined ? { file } : {}) });
}

/** The audiobook as a video (design turn 197): answered as `audiobook.video-exported` under the id returned, followed in Activity. */
export function exportAudiobookVideo(worldId: string, productionId: string, exportId: string, options: import("@arke-studio/contracts").AudiobookVideoOptions): string | null {
  const requestId = ulid();
  return send({ kind: "export-audiobook-video", worldId, productionId, requestId, exportId, options }) ? requestId : null;
}

/** What a video render with these options would make (197a): answered as `audiobook.video-state` under the id returned. */
export function readAudiobookVideo(worldId: string, productionId: string, options: import("@arke-studio/contracts").AudiobookVideoOptions): string | null {
  const requestId = ulid();
  return send({ kind: "read-audiobook-video", worldId, productionId, requestId, options }) ? requestId : null;
}

/** A picture moved along the words to another sentence's start (design turn 237, R-205), by picture keys: answered as `audiobook.record`. */
export function moveAudiobookPicture(worldId: string, productionId: string, chapterFile: string, from: string, to: string): string | null {
  const requestId = ulid();
  return send({ kind: "move-audiobook-picture", worldId, productionId, chapterFile, from, to, requestId }) ? requestId : null;
}

/** Where a block's picture's subject stands (197b), or null for the centre: answered as `audiobook.record`. */
export function setAudiobookPictureFocus(worldId: string, productionId: string, chapterFile: string, block: string, focus: { x: number; y: number } | null): string | null {
  const requestId = ulid();
  return send({ kind: "set-audiobook-picture-focus", worldId, productionId, chapterFile, block, focus, requestId }) ? requestId : null;
}

/** The audiobook as the player (design turn 186e): answered as `audiobook.exported` under the id returned. */
export function exportAudiobookPlayer(worldId: string, productionId: string, exportId?: string, scope?: import("@arke-studio/contracts").AudiobookScope): string | null {
  const requestId = ulid();
  return send({ kind: "export-audiobook-player", worldId, productionId, requestId, ...(exportId !== undefined ? { exportId } : {}), ...(scope !== undefined ? { scope } : {}) }) ? requestId : null;
}

export function exportAudiobookChapters(worldId: string, productionId: string, exportId: string, scope: import("@arke-studio/contracts").AudiobookScope): string | null {
  const requestId = ulid();
  return send({ kind: "export-audiobook-chapters", worldId, productionId, requestId, exportId, scope }) ? requestId : null;
}

/** What Export → Arke Player would make of a story (design turn 245a – 245c): answered as `story.export-state` under the id returned. */
export function readStoryExport(worldId: string, productionId: string, size?: ArkePlayerPictureSize): string | null {
  const requestId = ulid();
  return send({ kind: "read-story-export", worldId, productionId, requestId, ...(size !== undefined ? { size } : {}) }) ? requestId : null;
}

/** The world package for Arke Player (design turn 233): answered as `arke-player.exported` for the export id given. */
export function exportArkePlayer(worldId: string, productionId: string, exportId: string, options: { book: boolean; motion: boolean; size?: ArkePlayerPictureSize; part?: ArkePlayerPartRequest }): string | null {
  const requestId = ulid();
  return send({ kind: "export-arke-player", worldId, productionId, requestId, exportId, options }) ? requestId : null;
}

/** The world's web packages (design turn 186e): answered as `web-packages.listed` under the id returned. */
export function listWebPackages(worldId: string): string | null {
  const requestId = ulid();
  return send({ kind: "list-web-packages", worldId, requestId }) ? requestId : null;
}

/** Ask the host for a `.docx` and read it; the answer arrives by this request id, and nothing is written until the import press. */
export function pickManuscript(worldId: string, productionId: string): string {
  const requestId = ulid();
  const sent = send({ kind: "pick-manuscript", worldId, productionId, requestId });
  emitChange({ ...current, manuscripts: { ...current.manuscripts, [requestId]: sent ? { state: "reading" } : {
    state: "refused", reason: isRemoteSession() ? "Choose a manuscript on your PC." : "Studio is not connected. Try again after it reconnects.",
  } } });
  return requestId;
}

export function importManuscript(worldId: string, productionId: string, requestId: string): void {
  const held = current.manuscripts[requestId];
  if (held !== undefined) emitChange({ ...current, manuscripts: { ...current.manuscripts, [requestId]: { ...held, state: "importing" } } });
  send({ kind: "import-manuscript", worldId, productionId, requestId });
}

/** The same file again at the level the person chose; the rows are read again, nothing is written. */
export function rereadManuscript(worldId: string, productionId: string, requestId: string, headingLevel: "title" | "subtitle" | "heading1" | "heading2" | "document"): void {
  const held = current.manuscripts[requestId];
  if (held !== undefined) emitChange({ ...current, manuscripts: { ...current.manuscripts, [requestId]: { ...held, state: "reading" } } });
  send({ kind: "reread-manuscript", worldId, productionId, requestId, headingLevel });
}

export function cancelManuscript(worldId: string, requestId: string): void {
  const { [requestId]: _dropped, ...rest } = current.manuscripts;
  emitChange({ ...current, manuscripts: rest });
  send({ kind: "cancel-manuscript", worldId, requestId });
}

export function useManuscripts(): StoreState["manuscripts"] {
  return useStoreSelector(store => store.manuscripts);
}

/** How each chapter's casting is going, keyed by `worldId/productionId/chapterId` — the Voices panel reads this. */
export function useCasting(): StoreState["casting"] {
  return useStoreSelector(store => store.casting);
}

export function extractArtifact(worldId: string, artifactId: string): void {
  send({ kind: "extract-artifact", worldId, artifactId });
}

export function stopExtraction(worldId: string, artifactId: string): void {
  send({ kind: "stop-extraction", worldId, artifactId });
}

/** How the reading of each document is going — the offer under the composer reads this. */
export function useReading(): StoreState["reading"] {
  return useStoreSelector(store => store.reading);
}

export function resolveExtraction(
  worldId: string,
  artifactId: string,
  candidateHash: string,
  decision: "accept" | "reject",
): void {
  send({ kind: "resolve-extraction", worldId, artifactId, candidateHash, decision });
}

export interface ImportReportState {
  filed: Array<{ name: string; kind: string }>;
  deduplicated: string[];
  excluded: Array<{ name: string; reason: string }>;
  needsConsent: Array<{ name: string; sizeBytes: number }>;
}

export function useImportReport(): ImportReportState | null {
  return useStoreSelector(store => store.importReport);
}

export function useArtifactNotices(): Array<{
  sourcePath: string;
  outcome: string;
  reason: string;
  sizeBytes: number | null;
  production?: string | null;
}> {
  return useStoreSelector(store => store.artifactNotices);
}

/** handleFrame's arms for extraction.started … voices.finished, in their order (issue 2800). */
export function foldManuscriptEvent(slices: FrameSlices, event: DomainEvent): Folded {
  if (event.type === "extraction.started") {
    slices.reading = {
      ...slices.reading,
      [event.artifactId]: { file: event.file, state: "reading", found: 0, dropped: 0 },
    };
  } else if (event.type === "extraction.finished") {
    slices.reading = {
      ...slices.reading,
      [event.artifactId]: {
        file: event.file,
        state: event.outcome === "found" ? "found" : event.outcome,
        found: event.found,
        dropped: event.dropped,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      },
    };
  } else if (event.type === "continuity.started") {
    slices.deriving = {
      ...slices.deriving,
      [`${event.worldId}/${event.productionId}/${event.chapterId}`]: { state: "deriving", placed: 0, dropped: 0, omitted: 0, cut: 0 },
    };
  } else if (event.type === "continuity.finished") {
    slices.deriving = {
      ...slices.deriving,
      [`${event.worldId}/${event.productionId}/${event.chapterId}`]: {
        state: event.outcome,
        placed: event.placed,
        dropped: event.dropped,
        omitted: event.omitted,
        cut: event.cut,
        ...(event.record !== undefined ? { record: event.record } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      },
    };
  } else if (event.type === "manuscript.read-result") {
    slices.manuscripts = {
      ...slices.manuscripts,
      [event.requestId]:
        event.cancelled === true
          ? { state: "cancelled" }
          : event.reason !== undefined
          ? { state: "refused", ...(event.fileName !== undefined ? { fileName: event.fileName } : {}), reason: event.reason }
          : {
              state: "read",
              fileName: event.fileName ?? "",
              words: event.words ?? 0,
              chapters: event.chapters ?? [],
              ...(event.headingLevel !== undefined ? { headingLevel: event.headingLevel } : {}),
              leftOut: event.leftOut ?? 0,
              levels: event.levels ?? [],
              notes: event.notes ?? 0,
              links: event.links ?? 0,
              after: event.after ?? 0,
            },
    };
  } else if (event.type === "manuscript.import-result") {
    const held = slices.manuscripts[event.requestId] ?? { state: "read" as const };
    slices.manuscripts = {
      ...slices.manuscripts,
      [event.requestId]:
        event.reason !== undefined
          ? { ...held, state: "failed", reason: event.reason }
          : { ...held, state: "imported", created: event.created ?? 0, ...(event.after !== undefined ? { after: event.after } : {}) },
    };
  } else if (event.type === "voices.started") {
    slices.casting = {
      ...slices.casting,
      [`${event.worldId}/${event.productionId}/${event.chapterId}`]: { state: "casting", lines: 0, dropped: 0, omitted: 0 },
    };
  } else if (event.type === "voices.record") {
    // A pin written or refused (turn 155): the record as it stands now, which the chapter takes
    // as it takes a finished cast's, or the refusal beside whatever the cast was.
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    const held = slices.casting[key];
    slices.casting = {
      ...slices.casting,
      [key]:
        event.record !== undefined
          ? { state: "cast", lines: event.record.lines.length, dropped: event.record.dropped, omitted: event.record.omitted, record: event.record }
          : { ...(held ?? { state: "cast" as const, lines: 0, dropped: 0, omitted: 0 }), pinRefused: event.refused ?? "refused" },
    };
  } else if (event.type === "voices.finished") {
    slices.casting = {
      ...slices.casting,
      [`${event.worldId}/${event.productionId}/${event.chapterId}`]: {
        state: event.outcome,
        lines: event.lines,
        dropped: event.dropped,
        omitted: event.omitted,
        ...(event.record !== undefined ? { record: event.record } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      },
    };
  } else return "none";
  return "done";
}

/** handleFrame's blocks for import.report … artifact.notice, in their order (issue 2800). */
export function foldImportEvent(slices: FrameSlices, event: DomainEvent): void {
  if (event.type === "import.report") {
    slices.importReport = {
      filed: event.filed,
      deduplicated: event.deduplicated,
      excluded: event.excluded,
      needsConsent: event.needsConsent,
    };
  } else if (event.type === "artifact.attached") {
    // Filing the same bytes twice is one artifact — so is its chip.
    slices.attached = [
      ...slices.attached.filter((a) => a.artifactId !== event.artifactId),
      { worldId: event.worldId, artifactId: event.artifactId, file: event.file, kind: event.kind },
    ];
  } else if (event.type === "artifact.notice") {
    slices.artifactNotices = [
      ...slices.artifactNotices.slice(-9),
      {
        sourcePath: event.sourcePath,
        outcome: event.outcome,
        reason: event.reason,
        sizeBytes: event.sizeBytes,
        ...(event.production !== undefined ? { production: event.production } : {}),
      },
    ];
  }
}
