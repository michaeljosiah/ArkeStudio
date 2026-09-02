import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EditorRequestFileSchema, type EditorRequestFile } from "@arke-studio/contracts";
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
  let raw: string | null;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, fromPortable(requestsPath(productionId)))), "utf8");
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

export const serialiseRequestFile = (file: EditorRequestFile): string => `${JSON.stringify(file, null, 2)}\n`;

export function requestFileInput(productionId: string, raw: string | null, file: EditorRequestFile): CommitFileInput {
  const content = serialiseRequestFile(file);
  return { path: requestsPath(productionId), action: raw === null ? "create" : "replace", content, baseHash: raw === null ? null : sha256(raw) };
}
