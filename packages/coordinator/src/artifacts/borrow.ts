import { stat } from "node:fs/promises";
import { join } from "node:path";
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
