

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
