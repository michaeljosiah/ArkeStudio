/**
 * Renderer media URLs (design-fidelity pass): world-relative files served read-only by the
 * coordinator's HTTP side at `/media/<world-slug>/<path>`. The Electron preload exposes the
 * exact base; the dev browser derives it from the same source the WebSocket uses.
 */

function httpBase(): string {
  const fromBridge =
    typeof window === "undefined"
      ? undefined
      : (window.arke as { httpBase?: string | null } | undefined)?.httpBase;
  if (fromBridge) return fromBridge;
  const devUrl = (import.meta.env?.VITE_ARKE_WS as string | undefined) ?? "ws://127.0.0.1:8791";
  return devUrl.replace(/^ws/, "http");
}

/** URL for a world-relative media file, e.g. mediaUrl("the-undersong", "references/maren-kest/head-front.png"). */
export function mediaUrl(worldSlug: string, relPath: string): string {
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${httpBase()}/media/${encodeURIComponent(worldSlug)}/${clean.split("/").map(encodeURIComponent).join("/")}`;
}
