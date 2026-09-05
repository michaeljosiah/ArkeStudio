/** Permission and request handlers share this exact top-level origin decision. */
export function microphoneAllowed(input: { permission: string; sameWebContents: boolean; isMainFrame: boolean;
  requestingUrl: string; rendererUrl: string; mediaTypes: readonly string[] }): boolean {
  if (input.permission !== "media" || !input.sameWebContents || !input.isMainFrame ||
    input.mediaTypes.length !== 1 || input.mediaTypes[0] !== "audio") return false;
  try {
    const requested = new URL(input.requestingUrl), expected = new URL(input.rendererUrl);
    if (expected.protocol === "file:") return requested.protocol === "file:" && requested.pathname === expected.pathname;
    return ["http:", "https:"].includes(expected.protocol) && requested.origin === expected.origin;
  } catch { return false; }
}
