/**
 * The last models picked in any composer on this device (design turn 195), so the two or three in
 * use are never a scroll away among ninety. Per device, not per world or chat: it is a habit of
 * the person at this machine, not a fact about a production, so it lives in the browser's own
 * storage and travels nowhere. Storage can be absent or refuse (a private window, blocked site
 * data), and the picker is whole without it: every read and write is guarded.
 */
const KEY = "arke.recent-models";
/** How many it keeps. */
export const RECENT_LIMIT = 3;

export function readRecentModels(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry !== "").slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Puts a model first, once, and lets the oldest go. */
export function rememberRecentModel(reference: string): void {
  if (reference === "") return;
  try {
    const next = [reference, ...readRecentModels().filter((entry) => entry !== reference)].slice(0, RECENT_LIMIT);
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // The list is a convenience: a refused write only means it is not kept.
  }
}
