/**
 * Putting a picture on the system clipboard.
 *
 * Saving a picture out already existed; copying one did not, and a picture you can only save to
 * disk before you can put it in a message is a picture nobody sends. The bytes are read back
 * through the very same URL the `<img>` was given, so nothing new is reachable by copying that
 * was not already on screen — no filesystem path is involved on either side (SPEC-001 R-9).
 *
 * Everything is repainted to PNG before it goes anywhere. The clipboard takes one image format
 * and the world holds several, so a WebP frame that went across untouched would arrive somewhere
 * else as bytes nothing could open.
 *
 * The desktop host does the write itself: Chromium's async clipboard asks the permission layer
 * for `clipboard-sanitized-write`, and this app's handler answers no to everything but the
 * microphone. The browser build has no host and its permission is granted, so it writes directly.
 */
export type CopyImageOutcome = { ok: true } | { ok: false; reason: string };

/**
 * The URL whose bytes this page can actually read back, or null.
 *
 * The packaged app is a `file://` page, and `fetch` of a `file://` asset is refused there — so
 * the decorative plates that ship with the build have no copy to offer. Everything a world holds
 * comes over the coordinator's HTTP side and is fine.
 */
export function copyableImageSource(image: HTMLImageElement): string | null {
  const src = image.currentSrc || image.getAttribute("src") || "";
  if (src === "") return null;
  try {
    // `|| undefined`, not the bare value: a document with no base URL hands back an empty
    // string, and an empty base is a `TypeError` rather than "no base".
    const url = new URL(src, document.baseURI || undefined);
    return ["http:", "https:", "blob:", "data:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Repaint to PNG. Decoded from a blob URL rather than reusing the on-screen element: the picture
 * came from the coordinator's origin and the page is on another, so drawing the live `<img>`
 * would taint the canvas and `toBlob` would throw. A blob URL is this document's own.
 */
async function pngFrom(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    if (canvas.width === 0 || canvas.height === 0) throw new Error("that image has no pixels");
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no drawing surface");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((out) => (out === null ? reject(new Error("no bytes")) : resolve(out)), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Copy the picture at `src` — the same URL the `<img>` displayed — onto the system clipboard. */
export async function copyImage(src: string): Promise<CopyImageOutcome> {
  let blob: Blob;
  try {
    const response = await fetch(src);
    if (!response.ok) return { ok: false, reason: `the image could not be read (${response.status})` };
    blob = await response.blob();
  } catch {
    return { ok: false, reason: "the image could not be read" };
  }
  if (blob.size === 0) return { ok: false, reason: "that image is empty" };
  let png: Blob;
  try {
    png = await pngFrom(blob);
  } catch {
    return { ok: false, reason: "that image could not be prepared for the clipboard" };
  }
  const host = typeof window === "undefined" ? undefined : window.arke?.copyImage;
  if (host) {
    try {
      return await host(new Uint8Array(await png.arrayBuffer()));
    } catch {
      return { ok: false, reason: "the app could not copy that image" };
    }
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch {
    return { ok: false, reason: "the clipboard would not take that image" };
  }
  return { ok: true };
}
