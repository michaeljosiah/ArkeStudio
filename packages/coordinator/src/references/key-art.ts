import { copyFile, readdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
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
export async function adoptKeyArtCandidate(store: WorldStore, file?: string): Promise<boolean> {
  const incoming = join(store.dir, WORLD_IMAGE_DIR);
  const names = (await readdir(toExtendedLength(incoming)).catch(() => [] as string[]))
    .filter((name) => (KEY_ART_EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase()))
    .sort();
  const waiting = names.map((name) => `${WORLD_IMAGE_DIR}/${name}`);
  const candidate = file === undefined ? waiting[0] : waiting.find((path) => path === file);
  if (candidate === undefined) return false;
  const extension = extname(candidate).toLowerCase() || ".png";
  await store.gateOp(async () => {
    await copyFile(
      toExtendedLength(join(store.dir, fromPortable(candidate))),
      toExtendedLength(join(store.dir, `${WORLD_IMAGE_STEM}${extension}`)),
    );
    for (const stale of KEY_ART_EXTENSIONS.filter((other) => other !== extension)) {
      await rm(toExtendedLength(join(store.dir, `${WORLD_IMAGE_STEM}${stale}`)), { force: true });
    }
    await rm(toExtendedLength(incoming), { recursive: true, force: true });
  });
  return true;
}
