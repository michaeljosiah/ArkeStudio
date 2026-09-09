/**
 * Where a filed artifact's picture lives (issue 1037), stated once for both sides of the wire.
 *
 * The coordinator draws a video artifact's poster and the client asks for it by path. Two
 * spellings in two packages compile apart, and a rename on one side is a shelf of blank tiles on
 * the other, so the path is shared vocabulary here. Artifacts share one directory, so the poster
 * lives apart from the media under the derived `.index/` the coordinator regenerates on open,
 * and the artifact id is the name because the file's own name is not unique across re-imports.
 */

/** World-relative directory holding one picture per video artifact, named by artifact id. */
export const ARTIFACT_POSTER_DIR = ".index/posters";

/** The world-relative path of a video artifact's poster. */
export function artifactPosterPath(artifactId: string): string {
  return `${ARTIFACT_POSTER_DIR}/${artifactId}.png`;
}

/**
 * The world-relative picture that stands for an artifact, or null for one with no picture: a
 * still is its own, a video has its poster (drawn or not — the asker finds out), and sound and
 * documents have none.
 */
export function artifactPicturePath(artifact: { id: string; kind: string; file: string }): string | null {
  if (artifact.kind === "image" || artifact.kind === "board") return `artifacts/${artifact.file}`;
  if (artifact.kind === "video") return artifactPosterPath(artifact.id);
  return null;
}
