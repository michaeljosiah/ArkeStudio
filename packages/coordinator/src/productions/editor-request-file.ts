import { createReadStream } from "node:fs";
import { join } from "node:path";
import { EFFECT_PROPOSAL_BOUNDS, EditorRequestFileSchema, SlugSchema, type EditorRequestFile, type ProductionTimeline } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { CommitFileInput } from "../world/commit.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";

/**
 * `productions/<id>/editor-requests.json` as a file (SPEC-039 §2.2): read whole, written whole,
 * fenced by the hash of what was read. Shared by the request boundary and by the timeline write,
 * which marks a request undone in the same commit that undoes it (R-36).
 */

export const requestsPath = (productionId: string): string => `productions/${productionId}/editor-requests.json`;

const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

export class EditorRequestFileInvalid extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "EditorRequestFileInvalid";
  }
}

export async function readRequestFile(store: WorldStore, productionId: string): Promise<{ raw: string | null; file: EditorRequestFile }> {
  return readEditorRequestFileAt(store.dir, productionId);
}

/** Scanner-safe bounded IO; the slug can only name a production inside this world. */
export async function readEditorRequestFileAt(dir: string, productionId: string): Promise<{ raw: string | null; file: EditorRequestFile }> {
  SlugSchema.parse(productionId);
  let raw: string | null;
  try {
    // Bound bytes before parsing, including files that grow after a stat. This operational
    // authority must never be truncated or silently rewritten after an oversized read.
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of createReadStream(toExtendedLength(join(dir, fromPortable(requestsPath(productionId)))))) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > EFFECT_PROPOSAL_BOUNDS.requestFileBytes) throw new EditorRequestFileInvalid(
        `editor-requests.json exceeds ${EFFECT_PROPOSAL_BOUNDS.requestFileBytes} bytes (read at least ${bytes}); retained work was not changed`,
      );
      chunks.push(buffer);
    }
    raw = Buffer.concat(chunks, bytes).toString("utf8");
  } catch (error) {
    if (!missing(error)) throw error;
    raw = null;
  }
  if (raw === null) return { raw, file: { schemaVersion: 1, requests: [] } };
  try {
    return { raw, file: EditorRequestFileSchema.parse(JSON.parse(raw)) };
  } catch (error) {
    throw new EditorRequestFileInvalid(`editor-requests.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function serialiseRequestFile(file: EditorRequestFile): string {
  EditorRequestFileSchema.parse(file);
  const content = `${JSON.stringify(file, null, 2)}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > EFFECT_PROPOSAL_BOUNDS.requestFileBytes) throw new EditorRequestFileInvalid(
    `editor-requests.json needs ${bytes} bytes; the limit is ${EFFECT_PROPOSAL_BOUNDS.requestFileBytes}. Resolve pending work before preparing more`,
  );
  return content;
}

export function requestFileInput(productionId: string, raw: string | null, file: EditorRequestFile): CommitFileInput {
  const content = serialiseRequestFile(file);
  return { path: requestsPath(productionId), action: raw === null ? "create" : "replace", content, baseHash: raw === null ? null : sha256(raw) };
}

/** Ordinary Undo/Redo still needs these operational receipts, even after another proposal arrives. */
export function editorRequestHistoryPins(timeline: ProductionTimeline | undefined): string[] {
  return [...new Set([...(timeline?.history.undo ?? []), ...(timeline?.history.redo ?? [])]
    .flatMap(entry => entry.kind === "change" && entry.requestId ? [entry.requestId] : []))];
}

/** Ordinary timeline history owns ordering; this only records its exact receipt's visibility. */
export function markEditorRequestHistory(file: EditorRequestFile, requestId: string, historyEntryDigest: string,
  direction: "undo" | "redo", at: string): EditorRequestFile {
  let changed = false;
  const requests = file.requests.map(request => {
    if (request.id !== requestId) return request;
    changed = true;
    if (direction === "undo") return { ...request, undoneAt: at };
    const { undoneAt: _undone, ...rest } = request;
    return rest;
  });
  if (file.schemaVersion === 1) return changed ? { ...file, requests } : file;
  const effectFamilies = file.effectFamilies.map(family => {
    if (family.id !== requestId || !family.receipt) return family;
    if (family.receipt.historyEntryDigest !== historyEntryDigest) throw new EditorRequestFileInvalid(
      "The effect receipt does not match this timeline history entry; no history or receipt was changed",
    );
    changed = true;
    if (direction === "undo") return { ...family, receipt: { ...family.receipt, undoneAt: at } };
    const { undoneAt: _undone, ...receipt } = family.receipt;
    return { ...family, receipt };
  });
  const transitionFamilies = file.transitionFamilies?.map(family => {
    if (family.id !== requestId || !family.receipt) return family;
    if (family.receipt.historyEntryDigest !== historyEntryDigest) throw new EditorRequestFileInvalid("Transition receipt does not match timeline history");
    changed = true;
    if (direction === "undo") return { ...family, receipt: { ...family.receipt, undoneAt: at } };
    const { undoneAt: _undone, ...receipt } = family.receipt;
    return { ...family, receipt };
  });
  return changed ? { ...file, requests, effectFamilies, ...(transitionFamilies ? { transitionFamilies } : {}) } : file;
}
