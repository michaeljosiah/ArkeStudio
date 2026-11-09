/**
 * A take's picture. The rule itself — `frame.png` beside a video, a still named directly — is
 * contracts' `posterNameFor`, shared with the coordinator that writes the poster (issue 2815).
 */
import { posterNameFor } from "@arke-studio/contracts";

export { POSTER_NAME, isVideoMedia, posterNameFor } from "@arke-studio/contracts";

/** The same convention for a path that arrives already assembled (the derived cut). */
export function posterize(path: string): string {
  return path.replace(/[^/\\]+$/, (name) => posterNameFor(name));
}
