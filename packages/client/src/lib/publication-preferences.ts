export type PublicationPreference = { time: number; caption: string };
/** Playback position and track id only. No credentials, world state or host paths. */
export function readPublicationPreference(key: string, fallback: string): PublicationPreference {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as PublicationPreference | null;
    if (value && Number.isFinite(value.time) && value.time >= 0 && typeof value.caption === "string") return value;
  } catch { /* Storage can be disabled; playback remains available. */ }
  return { time: 0, caption: fallback };
}
export function savePublicationPreference(key: string, value: PublicationPreference): void {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* Resume is optional when storage is unavailable. */ }
}
