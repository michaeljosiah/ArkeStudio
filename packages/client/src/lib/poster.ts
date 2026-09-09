/**
 * A take's picture.
 *
 * A video take is shown as its first frame, written beside the clip as `frame.png` when the
 * take lands (coordinator `takes/poster.ts`). A still is its own picture and is named directly.
 *
 * This lived twice inside the production screen, and the bench's strip — the one place with
 * nothing but generated video in it — had neither copy. It pointed an `<img>` straight at an
 * `.mp4`, which cannot decode, so every video take there was a grey box with a label. One
 * convention, named once, is what stops that happening again in the next screen.
 *
 * The extensions must stay in step with `isVideoMedia` on the coordinator side; a test pins
 * them against each other.
 */

const VIDEO = /\.(mp4|webm|mov|m4v)$/i;

/** The poster's filename. The coordinator writes this name; every reader asks for it. */
export const POSTER_NAME = "frame.png";

export function isVideoMedia(file: string): boolean {
  return VIDEO.test(file);
}

/** A media filename, replaced by its poster when it is a video. */
export function posterNameFor(file: string): string {
  return isVideoMedia(file) ? POSTER_NAME : file;
}

/** The same convention for a path that arrives already assembled (the derived cut). */
export function posterize(path: string): string {
  return path.replace(/[^/\\]+$/, (name) => posterNameFor(name));
}

/**
 * A video artifact's picture (issue 1037). Artifacts share one directory, so their posters
 * live apart from the media, under the derived `.index/` the coordinator regenerates on open
 * (coordinator `artifacts/poster.ts`); the id is the name because the file's own name is not
 * unique across re-imports. Pinned against the coordinator by a test.
 */
export const ARTIFACT_POSTER_DIR = ".index/posters";

export function artifactPosterPath(artifactId: string): string {
  return `${ARTIFACT_POSTER_DIR}/${artifactId}.png`;
}

/**
 * The world-relative picture that stands for an artifact, or null for one with no picture: a
 * still is its own, a video has its poster, and sound and documents have none.
 */
export function artifactPicturePath(artifact: { id: string; kind: string; file: string }): string | null {
  if (artifact.kind === "image" || artifact.kind === "board") return `artifacts/${artifact.file}`;
  if (artifact.kind === "video") return artifactPosterPath(artifact.id);
  return null;
}
