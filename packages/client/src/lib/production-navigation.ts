

/**
 * Where a scene pressed outside any episode goes: the episode in view, else the last one, else
 * nowhere — a film has no episodes and its scenes belong to none.
 */
export function defaultEpisodeFor(
  production: { episodes: readonly { id: string; order: number }[] } | null | undefined,
  currentEpisodeId?: string,
): string | undefined {
  if (!production) return undefined;
  if (currentEpisodeId !== undefined && production.episodes.some((episode) => episode.id === currentEpisodeId)) {
    return currentEpisodeId;
  }
  return [...production.episodes].sort((a, b) => a.order - b.order).at(-1)?.id;
}

/** Shared static destinations; the rail adds its existing Takes lens and child trees (turns 166/281). */
export function productionPages(shape: { hasChapters: boolean; isEpisodic: boolean; isBranching: boolean; playsAsBeats?: boolean; isAudioDrama?: boolean; isMusic?: boolean; hasPages?: boolean } | null, options: { surface?: "phone" | "rail"; hasAdaptation?: boolean } = {}) {
  // A music production (design turn 238c): its tracks, and what they are made of.
  if (shape?.isMusic) return [["", "Tracks"], ["artifacts", "Artifacts"], ["publish", "Publish"]] as const;
  // An audio drama (design turn 230 revision 3): its episodes, who plays them, what they are made
  // of. A sourced drama also has Adaptation; Dashboard and Overview only repeated Episodes.
  if (shape?.isAudioDrama) return [["", "Episodes"], ...(options.hasAdaptation ? [["adaptation", "Adaptation"] as const] : []), ["cast", "Cast"], ["artifacts", "Artifacts"], ["publish", "Publish"]] as const;
  if (shape?.isEpisodic) return [
    ["", "Overview"], ["season", "Episodes"], ["story-structure", "Story structure"],
    ["cast", "Cast"], ...(options.surface === "rail" ? [["takes", "Takes"] as const] : []), ["artifacts", "Artifacts"], ["generate", "Generate"], ["cut", "Cut"], ["publish", "Publish"],
  ] as const;
  // A graphic novel (SPEC-064 R-43): its pictures are its pages, so it has no audiobook to read.
  if (shape?.hasPages) return [
    ["", "Dashboard"], ["cast", "Cast"], ["story", "Develop"], ["overview", "Overview"],
    ["story/chapters", "Chapters"], ["story/pages", "Pages"], ["artifacts", "Artifacts"], ["publish", "Publish"],
  ] as const;
  if (shape?.hasChapters) return [
    ["", "Dashboard"], ["cast", "Cast"], ["story", "Develop"], ["overview", "Overview"],
    ["story/chapters", "Chapters"], ["story/audiobook", "Audiobook"], ["artifacts", "Artifacts"], ["publish", "Publish"],
  ] as const;
  return [
    ["", "Dashboard"], ["cast", "Cast"], ["story", "Develop"], ["narrative", "Overview"],
    ["scenes", "Scenes"], ...(shape?.isBranching ? [["branch-map", "Branch map"] as const] : []),
    ["artifacts", "Artifacts"], ["generate", "Generate"], ...(shape?.playsAsBeats ? [] : [["cut", "Cut"] as const]), ["publish", "Publish"],
  ] as const;
}
