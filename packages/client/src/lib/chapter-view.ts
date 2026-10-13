import type { ChapterView } from "./chapter-dock.js";

// Turn 209: chapter-list entry returns to the last view in this app session. An explicit
// address still wins. This navigation preference never writes to a world or starts work.
const views = new Map<string, ChapterView>();
const key = (worldId: string, productionId: string, chapterId: string) => JSON.stringify([worldId, productionId, chapterId]);

export function chapterView(worldId: string, productionId: string, chapterId: string, requested: string | null): ChapterView {
  if (requested !== null) return requested === "audiobook" || requested === "timing" ? requested : "manuscript";
  return views.get(key(worldId, productionId, chapterId)) ?? "manuscript";
}

export function rememberChapterView(worldId: string, productionId: string, chapterId: string, view: ChapterView): void {
  views.set(key(worldId, productionId, chapterId), view);
}

export function __clearChapterViewsForTest(): void { views.clear(); }
