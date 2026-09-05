import { devMediaUrl } from "./dev-session.js";
/**
 * Renderer media URLs (design-fidelity pass): world-relative files served read-only by the
 * coordinator's HTTP side at `/media/<world-slug>/<path>`. The Electron preload exposes the
 * exact base; the dev browser derives it from the same source the WebSocket uses.
 */

function httpBase(): string {
  const fromBridge = typeof window === "undefined" ? undefined : window.arke?.coordinatorHttpBase?.();
  if (fromBridge) return fromBridge;
  const devUrl = (import.meta.env?.VITE_ARKE_WS as string | undefined) ?? "ws://127.0.0.1:8791";
  return devUrl.replace(/^ws/, "http");
}

function authorize(url: string): string {
  return typeof window !== "undefined" && window.arke ? url : devMediaUrl(url);
}

/** URL for a world-relative media file, with retry parameters before any dev capability. */
export function mediaUrl(worldSlug: string, relPath: string, query?: Record<string, string>): string {
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return authorize(`${httpBase()}/media/${encodeURIComponent(worldSlug)}/${clean.split("/").map(encodeURIComponent).join("/")}${query ? `?${new URLSearchParams(query)}` : ""}`);
}

/** The look preview lives in a genesis sandbox, before any world exists (SPEC-031 R-50). */
export function genesisMediaUrl(genesisId: string, relPath: string): string {
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return authorize(`${httpBase()}/genesis-media/${encodeURIComponent(genesisId)}/${clean.split("/").map(encodeURIComponent).join("/")}`);
}
