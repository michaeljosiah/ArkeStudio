import type { FetchLike } from "../types.js";

type EngineReadiness = { ready?: unknown; reason?: unknown };
type SidecarReadiness = { engineStatus?: { kokoro?: EngineReadiness; whisper?: EngineReadiness } };
/** The host owns authentication; a failed private probe must never fall back to public fetch. */
export type SidecarHealthProbe = (signal: AbortSignal) => Promise<SidecarReadiness | null>;

export async function probeSidecarHealth(fetch: FetchLike, base: string, signal: AbortSignal, health?: SidecarHealthProbe): Promise<SidecarReadiness | null> {
  if (health) return health(signal);
  const response = await fetch(`${base}/health`, { method: "GET", signal });
  if (response.status >= 400) throw new Error(`the Voxa sidecar answered HTTP ${response.status}`);
  return await response.json().catch(() => null) as SidecarReadiness | null;
}
