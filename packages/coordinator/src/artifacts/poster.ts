import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ArtifactSidecar } from "@arke-studio/contracts";
import { isVideoMedia, writePosterFor, type TakePosterMaker, type TakePosterUnavailableReason } from "../takes/poster.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";

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

/** World-relative directory holding one picture per video artifact, named by artifact id. */
export const ARTIFACT_POSTER_DIR = ".index/posters";

/** The client asks for exactly this path; a test pins both sides to it. */
export function artifactPosterPath(artifactId: string): string {
  return `${ARTIFACT_POSTER_DIR}/${artifactId}.png`;
}

/** Whether this artifact is one that gets a picture drawn for it. */
export function wantsArtifactPoster(artifact: Pick<ArtifactSidecar, "kind" | "file">): boolean {
  // The kind, not only the extension: an `.mp4` measured as sound alone is filed as audio and
  // has no frame to draw (PR 944), and asking ffmpeg for one would only cost a timeout.
  return artifact.kind === "video" && isVideoMedia(artifact.file);
}

/**
 * Draw the poster for one artifact, if it is a video and there is anything to draw with.
 * Reports whether a picture now exists; never throws.
 */
export async function writeArtifactPoster(
  store: WorldStore,
  artifact: Pick<ArtifactSidecar, "id" | "kind" | "file">,
  maker: TakePosterMaker | undefined,
  onUnavailable?: (reason: TakePosterUnavailableReason) => void,
): Promise<boolean> {
  if (!wantsArtifactPoster(artifact) || maker === undefined) return false;
  // A sidecar names a file inside artifacts/ and nothing else; anything stranger is the scan's
  // to report, not this pass's to read.
  if (basename(artifact.file) !== artifact.file || artifact.file === "..") return false;
  const output = join(store.dir, ...ARTIFACT_POSTER_DIR.split("/"), `${artifact.id}.png`);
  try {
    await mkdir(toExtendedLength(join(store.dir, ...ARTIFACT_POSTER_DIR.split("/"))), { recursive: true });
  } catch {
    return false;
  }
  if ((await stat(toExtendedLength(output)).catch(() => null)) !== null) return true;
  return await writeMediaPoster(toExtendedLength(join(store.dir, "artifacts", artifact.file)), toExtendedLength(output), maker, onUnavailable);
}

/**
 * `writePosterFor` names the output itself (`frame.png` beside the input); an artifact's poster
 * lives elsewhere, so the write goes to the maker directly with the same error handling.
 */
async function writeMediaPoster(
  input: string,
  output: string,
  maker: TakePosterMaker,
  onUnavailable?: (reason: TakePosterUnavailableReason) => void,
): Promise<boolean> {
  if (!isVideoMedia(input)) return false;
  let outcome;
  try {
    outcome = await maker.write(input, output);
  } catch {
    try { onUnavailable?.("process-failed"); } catch { /* a diagnostic that fails is still only a diagnostic */ }
    return false;
  }
  if (!outcome.ok) {
    try { onUnavailable?.(outcome.reason); } catch { /* as above */ }
    return false;
  }
  return true;
}

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
    if (!wantsArtifactPoster(artifact) || artifact.retiredAt !== undefined) continue;
    if (now() > deadline || options.stillOpen?.() === false || store.isClosed()) break;
    const output = join(store.dir, ...ARTIFACT_POSTER_DIR.split("/"), `${artifact.id}.png`);
    if ((await stat(toExtendedLength(output)).catch(() => null)) !== null) continue;
    if (await writeArtifactPoster(store, artifact, maker, (reason) => options.onUnavailable?.(artifact.id, reason))) drawn += 1;
  }
  return drawn;
}

// `writePosterFor` is the take path's entry point; re-exported so a host can see the two are one seam.
export { writePosterFor };
