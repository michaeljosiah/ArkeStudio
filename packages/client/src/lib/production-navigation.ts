

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

/** Turn 166's page strip; scene and episode trees live on their owning pages. */
export function productionPages(shape: { hasChapters: boolean; isEpisodic: boolean; isBranching: boolean; playsAsBeats?: boolean } | null) {
  if (shape?.isEpisodic) return [
    ["", "Overview"], ["season", "Episodes"], ["story-structure", "Story structure"],
    ["cast", "Cast"], ["artifacts", "Artifacts"], ["generate", "Generate"], ["cut", "Cut"],
  ] as const;
  if (shape?.hasChapters) return [
    ["", "Dashboard"], ["cast", "Cast"], ["story", "Develop"], ["overview", "Overview"],
    ["story/chapters", "Chapters"], ["story/audiobook", "Audiobook"], ["artifacts", "Artifacts"],
  ] as const;
  return [
    ["", "Dashboard"], ["cast", "Cast"], ["story", "Develop"], ["narrative", "Overview"],
    ["scenes", "Scenes"], ...(shape?.isBranching ? [["branch-map", "Branch map"] as const] : []),
    ["artifacts", "Artifacts"], ["generate", "Generate"], ...(shape?.playsAsBeats ? [] : [["cut", "Cut"] as const]),
  ] as const;
}
