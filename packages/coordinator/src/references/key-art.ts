import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { CommitFileInput } from "../world/commit.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStatePrecondition, WorldStore } from "../world/store.js";
import { KEY_ART_EXTENSIONS, WORLD_IMAGE_DIR, WORLD_IMAGE_STEM } from "./world-image.js";

/**
 * Adopt a waiting key-art candidate as the world's key art. The one landing rule both paths
 * share: `use-world-image` when a person presses it, and the founding build when the run
 * lands it under the press's aggregate authorization (SPEC-031 R-28).
 *
 * The waiting set is read from the directory itself, not the scanned bundle: the build lands
 * a candidate and adopts it in the same breath, before any rescan has seen the file — and a
 * bundle that lags by one scan must never turn a landed image into "nothing to adopt". The
 * name guard holds either way: only files actually inside `incoming/world-image` are
 * adoptable, so a caller can still never copy an arbitrary path onto the world's key art.
 *
 * The accepted file keeps the format its bytes carry, a previous key art in another format
 * goes with it (two would leave the scan choosing by sort order), and the candidate
 * directory is swept whole. Idempotent: no candidate waiting means nothing to do.
 */
export async function adoptKeyArtCandidate(
  store: WorldStore,
  file?: string,
  precondition?: WorldStatePrecondition,
  mutation?: { source: string; requestId: string },
): Promise<boolean> {
  return store.gateOp(async () => {
    const incoming = join(store.dir, WORLD_IMAGE_DIR);
    const names = (await readdir(toExtendedLength(incoming)).catch(() => [] as string[]))
      .filter((name) => (KEY_ART_EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase()))
      .sort();
    const waiting = names.map((name) => `${WORLD_IMAGE_DIR}/${name}`);
    const candidate = file === undefined ? waiting[0] : waiting.find((path) => path === file);
    if (candidate === undefined) return false;
    const extension = extname(candidate).toLowerCase() || ".png";
    const bytes = await readFile(toExtendedLength(join(store.dir, fromPortable(candidate))));
    const files: CommitFileInput[] = [];
    for (const format of KEY_ART_EXTENSIONS) {
      const path = `${WORLD_IMAGE_STEM}${format}`;
      const live = await readFile(toExtendedLength(join(store.dir, path))).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (format === extension) {
        files.push({ path, action: live === null ? "create" : "replace", content: bytes.toString("base64"), encoding: "base64", baseHash: live === null ? null : sha256(live) });
      } else if (live !== null) {
        files.push({ path, action: "delete", encoding: "base64", baseHash: sha256(live) });
      }
    }
    for (const entry of await readdir(toExtendedLength(incoming), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolute = join(entry.parentPath, entry.name);
      const path = relative(toExtendedLength(store.dir), absolute).replaceAll("\\", "/");
      files.push({ path, action: "delete", encoding: "base64", baseHash: sha256(await readFile(absolute)) });
    }
    // Selection, removal of alternatives and the action receipt recover together after a crash.
    await store.commitUnserialised({
      kind: "world-chat-reference-world-image-result-use",
      source: mutation?.source ?? "form",
      files,
      ...(mutation ? { requestId: mutation.requestId } : {}),
    });
    return true;
  }, precondition);
}
