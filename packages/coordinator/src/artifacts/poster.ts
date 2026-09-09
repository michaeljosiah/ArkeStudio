import { lstat, mkdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { ARTIFACT_POSTER_DIR, artifactPosterPath, type ArtifactSidecar } from "@arke-studio/contracts";
import { writePosterFor, type TakePosterMaker, type TakePosterUnavailableReason } from "../takes/poster.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { containedArtifactFile, ownDirectory } from "./contained.js";

/**
 * A video artifact's picture (issue 1037).
 *
 * A take's poster sits beside its clip as `frame.png` because a take owns a directory. An
 * artifact does not: every file in the world shares `artifacts/`, and a poster written there
 * would be one more file the shelf has no sidecar for. So the picture goes under `.index/`,
 * which is derived and deletable by construction — the scan does not read it, the watcher
 * ignores it, and a copy of the world that leaves it behind loses nothing that cannot be drawn
 * again on the next open. The media route serves it like any other world file.
 *
 * Same posture as `takes/poster.ts`: best-effort, never a failed import. The maker is the take
 * poster maker itself; both write one frame to one file with the same bounded runner.
 */

// The path is what the client asks for, so it is stated once, in contracts; re-exported here for
// the coordinator's own callers.
export { ARTIFACT_POSTER_DIR, artifactPosterPath };

/** Whether this artifact is one that gets a picture drawn for it. */
export function wantsArtifactPoster(artifact: Pick<ArtifactSidecar, "kind" | "file">): boolean {
  // The kind, and only the kind: filing names a video by what it measured — an `.mp4` with
  // sound alone is audio and has no frame to draw (PR 944) — and an `.mkv` is a video whatever
  // the take path's shorter extension list says; gating on that list left every MKV on its mark.
  return artifact.kind === "video";
}

/**
 * Draw the poster for one artifact, if it is a video and there is anything to draw with.
 * Reports whether a picture now exists; never throws.
 */
export async function writeArtifactPoster(
  store: Pick<WorldStore, "dir">,
  artifact: Pick<ArtifactSidecar, "id" | "kind" | "file">,
  maker: TakePosterMaker | undefined,
  onUnavailable?: (reason: TakePosterUnavailableReason) => void,
  /** How long the caller can wait, when that is less than the maker's own limit. */
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!wantsArtifactPoster(artifact) || maker === undefined) return false;
  /*
   * Both ends are the world's own once links are followed. A world copied in from elsewhere can
   * carry a sidecar naming a link to a host file, or an `.index/` that is a link out, and this
   * pass runs on open — nobody asked for the read or the write. The input check is filing's own
   * (`containedArtifactFile`); the output is checked one directory at a time, so that nothing
   * is created behind a link either.
   */
  if (basename(artifact.id) !== artifact.id || artifact.id === "..") return false;
  const input = await containedArtifactFile(store.dir, artifact.file);
  if (input === null) return false;
  const segments = ARTIFACT_POSTER_DIR.split("/");
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const partial = segments.slice(0, depth);
    try {
      await mkdir(toExtendedLength(join(store.dir, ...partial)), { recursive: true });
    } catch {
      return false;
    }
    if ((await ownDirectory(store.dir, ...partial)) === null) return false;
  }
  const output = join(store.dir, ...segments, `${artifact.id}.png`);
  // An entry already there that is not a plain file — a link, say — is not written through.
  const existing = await lstat(toExtendedLength(output)).catch(() => null);
  if (existing !== null && !existing.isFile()) return false;
  if (existing !== null && existing.size > 0) return true;
  return await writeMediaPoster(toExtendedLength(input), toExtendedLength(output), maker, onUnavailable, options);
}

/** A poster is a file with bytes in it; a zero-byte leftover is drawn again. */
async function posterExists(path: string): Promise<boolean> {
  const info = await stat(toExtendedLength(path)).catch(() => null);
  return info !== null && info.size > 0;
}

/**
 * `writePosterFor` names the output itself (`frame.png` beside the input); an artifact's poster
 * lives elsewhere, so the write goes to the maker directly with the same error handling. The
 * caller has already said the input is a video; the maker's runner says whether it can read it.
 */
async function writeMediaPoster(
  input: string,
  output: string,
  maker: TakePosterMaker,
  onUnavailable: ((reason: TakePosterUnavailableReason) => void) | undefined,
  options: { timeoutMs?: number },
): Promise<boolean> {
  // A run that is killed or exits badly can leave a partial file where the poster should be, and
  // every later pass would take it for a finished picture; a failure leaves nothing behind.
  const discard = async (): Promise<void> => {
    await rm(output, { force: true }).catch(() => undefined);
  };
  let outcome;
  try {
    outcome = await maker.write(input, output, options);
  } catch {
    await discard();
    try { onUnavailable?.("process-failed"); } catch { /* a diagnostic that fails is still only a diagnostic */ }
    return false;
  }
  if (!outcome.ok) {
    await discard();
    try { onUnavailable?.(outcome.reason); } catch { /* as above */ }
    return false;
  }
  if (!(await posterExists(output))) {
    await discard();
    try { onUnavailable?.("process-failed"); } catch { /* as above */ }
    return false;
  }
  return true;
}

/** How long past its own deadline the backfill waits for a maker that does not honour one. */
const BACKSTOP_MS = 1_000;

/**
 * Draw the pictures video artifacts filed before posters existed, oldest first, until the budget
 * runs out. Bounded by wall clock for the reason the bench pass is: a world with forty clips
 * draws what it can and the rest next time, and once drawn every later open costs one stat each.
 */
export async function backfillArtifactPosters(
  store: WorldStore,
  maker: TakePosterMaker | undefined,
  options: {
    budgetMs: number;
    now?: () => number;
    stillOpen?: () => boolean;
    onUnavailable?: (artifactId: string, reason: TakePosterUnavailableReason) => void;
  },
): Promise<number> {
  if (maker === undefined) return 0;
  const now = options.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  let drawn = 0;
  for (const artifact of store.getBundle().artifacts) {
    // Retired ones included: retirement keeps the bytes for the cuts that cite them (#957), and a
    // clip that still does asks for the picture like any other.
    if (!wantsArtifactPoster(artifact)) continue;
    const remaining = deadline - now();
    if (remaining <= 0 || options.stillOpen?.() === false || store.isClosed()) break;
    const output = join(store.dir, ...ARTIFACT_POSTER_DIR.split("/"), `${artifact.id}.png`);
    if (await posterExists(output)) continue;
    /*
     * The budget binds the wait, not only the start. A maker stuck on a corrupt file has its own
     * timeout, fifteen seconds, and the open this pass sits in front of would otherwise wait it
     * out. So the maker is given what is left and stops its process at that — drained, not
     * abandoned to draw into a world that may have closed — and a maker that ignores the figure
     * is left behind at a backstop a second later. The backstop timer stays referenced on
     * purpose: against a maker that never settles it is the only thing keeping the loop alive,
     * and Node 22 resolves an empty loop out from under the await.
     */
    const outcome = await Promise.race([
      writeArtifactPoster(store, artifact, maker, (reason) => options.onUnavailable?.(artifact.id, reason), { timeoutMs: remaining }),
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), remaining + BACKSTOP_MS); }),
    ]);
    if (outcome === null) break;
    if (outcome) drawn += 1;
  }
  return drawn;
}

// `writePosterFor` is the take path's entry point; re-exported so a host can see the two are one seam.
export { writePosterFor };
