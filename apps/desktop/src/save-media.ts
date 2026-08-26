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

/** Whoever is holding the world provider: the only thing wanted of it here is the media lookup. */
export interface MediaSource {
  serveMedia?(worldSlug: string, path: string): Promise<{ path: string } | null>;
}

/**
 * The confined lookup a save resolves through right now, or null while there is nothing to save
 * from.
 *
 * The world provider changes hands during startup: the host builds it, and the coordinator takes
 * ownership the moment it is constructed, which is well before the window has loaded the client.
 * A handler that reads only the pre-handover reference therefore finds nothing at every moment
 * anyone could click — which is exactly how saving a picture came to refuse every time it was
 * asked (issue 503). So the owner is asked, not the reference that was dropped.
 */
function mediaLookup(sources: {
  starting: MediaSource | null;
  live: MediaSource | null;
}): SaveMediaDeps["resolve"] | null {
  const source = sources.live ?? sources.starting;
  if (!source?.serveMedia) return null;
  return (worldSlug, path) => source.serveMedia!(worldSlug, path);
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

/**
 * Everything the IPC handler reads at the moment it is asked — nothing captured at registration.
 *
 * The handler is registered before the app has started, so every one of these is a question and
 * not a value: the window does not exist yet, and neither does the provider that will answer.
 */
export interface SaveMediaHost extends Pick<SaveMediaDeps, "ask" | "copy"> {
  /** The one sender allowed to ask — the window's own contents. Null until there is a window. */
  allowedSender(): unknown;
  /** Both places the world provider can be: the host's own hand, and the coordinator that took it. */
  providers(): { starting: MediaSource | null; live: MediaSource | null };
}

/**
 * The `arke:save-media` handler, assembled where it can be exercised (issue 503).
 *
 * The defect this exists to keep out was never in `saveMedia`: it was one line of wiring above
 * it, reading a provider reference that is always null by the time a window can ask. Registering
 * the handler needs Electron and so cannot be tested, but choosing the sender and the provider
 * does not — so that choosing lives here, and `main.ts` supplies the Electron.
 */
export function saveMediaHandler(
  host: SaveMediaHost,
): (
  sender: unknown,
  input: { worldSlug?: unknown; path?: unknown; name?: unknown },
) => Promise<SaveMediaResult> {
  return async (sender, input) => {
    const allowed = host.allowedSender();
    if (!allowed || sender !== allowed) return { ok: false, reason: "that window cannot save" };
    const resolve = mediaLookup(host.providers());
    if (!resolve) return { ok: false, reason: "the library is not open yet" };
    return await saveMedia({ resolve, ask: host.ask, copy: host.copy }, input);
  };
}
