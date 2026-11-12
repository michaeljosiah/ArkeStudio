/**
 * A take's picture (issue 2815): a video take is shown as its first frame, written beside the clip
 * as `frame.png` when the take lands; a still is its own picture. The coordinator writes the
 * poster and the client asks for it, so the rule lives here, once. It was written on both sides,
 * pinned by a test, and a rename on one side would have left the client asking for files that
 * do not exist. `frame.png` is on disk in every world: the name does not change.
 */

/** The poster's filename, beside the clip. */
export const POSTER_NAME = "frame.png";

/** Whether a file is the kind of media shown by its poster. */
export function isVideoMedia(file: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(file);
}

/** A media filename, replaced by its poster when it is a video. */
export function posterNameFor(file: string): string {
  return isVideoMedia(file) ? POSTER_NAME : file;
}
