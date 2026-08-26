import { downloadFileName } from "@arke-studio/contracts";
import { mediaUrl } from "./media.js";

/**
 * Saving a world image out of the app (issue 478).
 *
 * The files are already on this machine, which is exactly why this was easy to leave out — and
 * exactly why it reads as broken when a picture cannot be sent to somebody. Both builds go
 * through the same confined `/media/<world-slug>/<file>` identity the `<img>` used: the renderer
 * never holds a filesystem path, and the desktop host resolves the same pair itself rather than
 * being handed one (SPEC-001 R-9).
 *
 * Desktop gets a native save dialog, so the destination — and the platform's own answer to a name
 * already in use — belong to the person. The browser build asks the download manager, which
 * suffixes a collision rather than overwriting. Neither ever writes over a file silently.
 */
export type DownloadOutcome =
  | { ok: true }
  /** The person closed the save dialog. Nothing to say — they already know. */
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; reason: string };

/** The name this picture would land under, for the control's label as well as the save itself. */
export function downloadNameFor(path: string, offered?: string | null): string {
  return downloadFileName(path, offered);
}

async function saveInBrowser(worldSlug: string, path: string, name: string): Promise<DownloadOutcome> {
  /*
   * Fetched to a Blob rather than pointed at with `<a download>`.
   *
   * The coordinator serves media from its own loopback origin, which is not the origin the page
   * is on in a dev browser — and `download` is ignored cross-origin, so the anchor would navigate
   * to the picture instead of saving it. Reading the bytes first also means a 404 or an empty
   * body is caught here rather than landing as a zero-byte file.
   */
  let blob: Blob;
  try {
    const response = await fetch(mediaUrl(worldSlug, path));
    if (!response.ok) return { ok: false, reason: `the image could not be read (${response.status})` };
    blob = await response.blob();
  } catch {
    return { ok: false, reason: "the image could not be read" };
  }
  if (blob.size === 0) return { ok: false, reason: "that image is empty" };
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Not in the same tick: revoking before the click has been acted on can cancel the very
    // download it started, with nothing on screen to say why. A second is long past that and
    // short enough that a page full of saves does not hold the bytes twice over.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { ok: true };
}

/**
 * Save the bytes behind a world-relative media path. `offered` is a human name for the picture
 * — the extension always comes from the file itself, so a JPEG cannot be saved as a `.png`.
 */
export async function downloadMedia(
  worldSlug: string | undefined,
  path: string,
  offered?: string | null,
): Promise<DownloadOutcome> {
  if (!worldSlug || !path) return { ok: false, reason: "there is no image here to save" };
  const name = downloadNameFor(path, offered);
  const host = typeof window === "undefined" ? undefined : window.arke?.saveMedia;
  if (host) {
    try {
      return await host(worldSlug, path, name);
    } catch {
      return { ok: false, reason: "the app could not save that image" };
    }
  }
  return await saveInBrowser(worldSlug, path, name);
}
