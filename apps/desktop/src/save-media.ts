import { downloadFileName, mediaExtension } from "@arke-studio/contracts";

/**
 * Saving a world image to a place of the person's choosing (issue 478).
 *
 * The renderer asks by the identity it displayed the picture with — world slug and world-relative
 * path — and nothing else. Resolving that pair is the host's job and goes through the very same
 * confined lookup the media server uses, so a renderer-supplied string can no more become an
 * arbitrary disk read here than it could over HTTP (SPEC-001 R-9).
 *
 * Lifted out of `main.ts` because that file cannot be imported without Electron: the decisions
 * worth testing are which inputs are refused, that the bytes copied are the ones resolved rather
 * than any path that was asked for, and that nothing anywhere hands an absolute path back.
 */
export interface SaveMediaDeps {
  /** The confined lookup — the world provider's own, in the app. Null for anything it refuses. */
  resolve(worldSlug: string, path: string): Promise<{ path: string } | null>;
  /**
   * Ask where it should go. Null is the person closing the dialog, which is an answer, not a
   * failure. Overwrite confirmation belongs to the platform's own dialog, not to this.
   */
  ask(input: { defaultName: string; extension: string }): Promise<string | null>;
  copy(from: string, to: string): Promise<void>;
}

export type SaveMediaResult =
  | { ok: true }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; reason: string };

export async function saveMedia(
  deps: SaveMediaDeps,
  input: { worldSlug?: unknown; path?: unknown; name?: unknown },
): Promise<SaveMediaResult> {
  const worldSlug = typeof input?.worldSlug === "string" ? input.worldSlug : "";
  const path = typeof input?.path === "string" ? input.path : "";
  if (worldSlug === "" || path === "") return { ok: false, reason: "there is no image here to save" };
  const hit = await deps.resolve(worldSlug, path).catch(() => null);
  // The same answer for a traversal attempt, a world that is not there, and a file that has been
  // deleted: what the renderer learns is that this picture is not available, never why.
  if (!hit) return { ok: false, reason: "that image is no longer there" };
  // Sanitised here as well as in the renderer. The offered name is a suggestion from the other
  // side of the bridge, and the extension comes off the real file either way.
  const defaultName = downloadFileName(path, typeof input?.name === "string" ? input.name : null);
  const destination = await deps.ask({ defaultName, extension: mediaExtension(path).slice(1) });
  if (destination === null || destination === "") return { ok: false, cancelled: true };
  try {
    await deps.copy(hit.path, destination);
  } catch {
    // Deliberately without the path. A failure message is not the place to hand the renderer the
    // absolute location it is not allowed to know.
    return { ok: false, reason: "that image could not be written there" };
  }
  return { ok: true };
}
