import { realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import {
  artifactDisplayName,
  linkNameResolver,
  pickableArtifacts,
  type BorrowableArtifact,
  type WorldBundle,
} from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { ARTIFACT_POSTER_DIR, artifactPosterPath } from "./poster.js";

/**
 * What another world offers the Cut's Library (issue 1033): its placeable, world-owned files,
 * named as its own Artifacts page names them, newest first. A production-scoped file stays off
 * its world's shelf (SPEC-020 R-13) and so stays home. The picture is the still itself or the
 * poster the world has drawn; a video with no poster yet shows its kind's mark, as it does at home.
 */

const PLACEABLE = new Set<BorrowableArtifact["kind"]>(["audio", "video", "image", "board"]);

/**
 * The absolute path of one of a shelf's files, or null. The media route's resolver would also
 * answer, but it answers for a renderer and refuses anything its MIME table does not name — a
 * `.mov` or an `.m4a` the shelf legitimately holds. A borrow copies bytes, so what it needs is
 * containment: a plain filename, inside `artifacts/` once links are followed, and a file.
 */
export async function resolveBorrowedFile(dir: string, file: string): Promise<string | null> {
  if (basename(file) !== file || file === "..") return null;
  const root = join(dir, "artifacts");
  try {
    const [rootReal, target] = await Promise.all([
      realpath(toExtendedLength(root)),
      realpath(toExtendedLength(join(root, file))),
    ]);
    if (target !== join(rootReal, basename(target)) || !target.startsWith(rootReal + sep)) return null;
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

export async function listBorrowableArtifacts(
  bundle: Pick<WorldBundle, "artifacts" | "sheets" | "canon" | "productions">,
  /** The source world's directory, for the poster check. */
  dir: string,
): Promise<BorrowableArtifact[]> {
  const linkName = linkNameResolver(bundle);
  const rows: BorrowableArtifact[] = [];
  const shelf = pickableArtifacts(bundle.artifacts)
    .filter((artifact) => PLACEABLE.has(artifact.kind) && artifact.production === undefined)
    .sort((a, b) => b.created.localeCompare(a.created));
  for (const artifact of shelf) {
    let picture: string | null = null;
    if (artifact.kind === "image" || artifact.kind === "board") picture = `artifacts/${artifact.file}`;
    else if (artifact.kind === "video") {
      const poster = join(dir, ...ARTIFACT_POSTER_DIR.split("/"), `${artifact.id}.png`);
      if ((await stat(toExtendedLength(poster)).catch(() => null)) !== null) picture = artifactPosterPath(artifact.id);
    }
    rows.push({
      id: artifact.id,
      kind: artifact.kind,
      file: artifact.file,
      name: artifactDisplayName(artifact, linkName),
      ...(artifact.mediaInfo?.durationSec !== undefined ? { durationSec: artifact.mediaInfo.durationSec } : {}),
      picture,
    });
  }
  return rows;
}
