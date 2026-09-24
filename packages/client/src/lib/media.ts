import { devMediaUrl } from "./dev-session.js";
import { hasAdultAdapter, type ClientState } from "@arke-studio/contracts";

let readState: () => ClientState | null = () => null;
/** Read the existing store lazily; media helpers keep no second copy of content authority. */
export function setMediaStateSource(source: () => ClientState | null): void { readState = source; }

export function adapterPreviewHidden(state: ClientState | null, slug: string, path: string): boolean {
  if (!state || state.app.adapters?.adultContent.enabled) return false;
  const world = state.world;
  if (world?.meta.slug !== slug) return false;
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts[0] === "productions" && parts[2] === "takes") {
    return hasAdultAdapter(world.productions.find(row => row.meta.id === parts[1])?.takes.find(row => row.id === parts[3])?.params);
  }
  if (parts[0] === "artifacts") {
    const generation = world.artifacts.find(row => row.file === parts.slice(1).join("/"))?.generation;
    return !!generation && "params" in generation && hasAdultAdapter(generation.params);
  }
  const bench = state.bench;
  if (parts[0] === ".sessions" && parts[2] === "media" && bench && bench.session.id === parts[1]) {
    return hasAdultAdapter(bench.session.takes.find(row => row.id === parts[3])?.request.params);
  }
  return false;
}
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
  if (adapterPreviewHidden(readState(), worldSlug, clean)) return "about:blank";
  return authorize(`${httpBase()}/media/${encodeURIComponent(worldSlug)}/${clean.split("/").map(encodeURIComponent).join("/")}${query ? `?${new URLSearchParams(query)}` : ""}`);
}

/** The look preview lives in a genesis sandbox, before any world exists (SPEC-031 R-50). */
export function genesisMediaUrl(genesisId: string, relPath: string): string {
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return authorize(`${httpBase()}/genesis-media/${encodeURIComponent(genesisId)}/${clean.split("/").map(encodeURIComponent).join("/")}`);
}
