/**
 * This device's place in an audiobook (design turn 199, R-71): the player writes it under this
 * key as it plays, and the show page reads it back so Listen resumes where the listener stopped.
 * A chapter and a time in the browser's storage are the whole of it, which is why the client
 * policy (scripts/check-client-policy.mjs) allows this one file its `localStorage` while every
 * credential-shaped word stays forbidden.
 */
export const audiobookPlaceKey = (worldId: string, productionId: string): string => `arke-ab-${worldId}-${productionId}`;

/** Where the player keeps this device's place in the book, as the player wrote it. */
export function keptPlace(worldId: string, productionId: string): { chapterId: string; at: number } | null {
  try {
    const kept = JSON.parse(window.localStorage.getItem(audiobookPlaceKey(worldId, productionId)) ?? "null") as { place?: { chapterId?: unknown; at?: unknown } } | null;
    const place = kept?.place;
    if (place === undefined || typeof place.chapterId !== "string") return null;
    return { chapterId: place.chapterId, at: typeof place.at === "number" && Number.isFinite(place.at) ? Math.max(0, place.at) : 0 };
  } catch {
    // No storage here, or a place nobody can read: Listen, as on a first visit.
    return null;
  }
}
