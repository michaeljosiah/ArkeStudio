/** Permission and request handlers share this exact top-level origin decision. */
type PermissionAsk = { permission: string; sameWebContents: boolean; isMainFrame: boolean;
  requestingUrl: string; rendererUrl: string; mediaTypes: readonly string[] };

export function microphoneAllowed(input: PermissionAsk): boolean {
  if (input.permission !== "media" || input.mediaTypes.length !== 1 || input.mediaTypes[0] !== "audio") return false;
  return studioPage(input);
}

/**
 * The chapter's Focus takes the window full screen (SPEC-056 R-12). Every other permission was
 * answered "no" here, so the page's `requestFullscreen()` was refused and Focus stayed a window
 * (issue 1827). Only the studio's own page may ask; a frame or another origin may not.
 */
export function fullscreenAllowed(input: PermissionAsk): boolean {
  return input.permission === "fullscreen" && studioPage(input);
}

function studioPage(input: PermissionAsk): boolean {
  if (!input.sameWebContents || !input.isMainFrame) return false;
  try {
    const requested = new URL(input.requestingUrl), expected = new URL(input.rendererUrl);
    if (expected.protocol === "file:") return requested.protocol === "file:" && requested.pathname === expected.pathname;
    return ["http:", "https:"].includes(expected.protocol) && requested.origin === expected.origin;
  } catch { return false; }
}
