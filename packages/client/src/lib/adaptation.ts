import {
  estimateScriptSeconds,
  type DramaChapterDecision, type DramaVerdict, type EpisodeScriptBlock, type ProductionBundle, type ScriptHeading, type WorldBundle,
} from "@arke-studio/contracts";

/**
 * The adaptation map (design turn 230m, SPEC-057 R-61..R-64): the source's chapters at left, the
 * episodes' scenes at right, and one ribbon per decision between them. It is read from what the
 * scripts already say — each scene's source pin — and the author's verdicts; nothing else is kept.
 */
export interface MapChapter {
  id: string; order: number; title: string; words: number; version: number; hash: string | undefined; file: string;
  /** The author's verdict, else Keep for a chapter scenes are made from, else none: not planned. */
  verdict: DramaVerdict | null;
  decision: DramaChapterDecision | undefined;
  /** Scenes made from it, by key. */
  scenes: string[];
  /** Its scenes come before an earlier chapter's: its material moved. */
  moved: boolean;
  /** A scene made from it was made from an older version (R-64). */
  changed: boolean;
}
export interface MapScene {
  key: string; episode: number; n: number; heading: ScriptHeading; blocks: EpisodeScriptBlock[];
  seconds: number; chapter: string | undefined; changed: boolean;
}
export interface MapEpisode { episode: number; title: string; planned: boolean; seconds: number; scenes: MapScene[] }
export interface AdaptationMap {
  story: ProductionBundle | null;
  chapters: MapChapter[];
  episodes: MapEpisode[];
  ribbons: Array<{ chapter: string; to: string }>;
  counts: { read: number; planned: number; notPlanned: number; changed: number };
  cutWords: number;
}

export const CUT = "cut";

export function adaptationMap(world: WorldBundle, production: ProductionBundle): AdaptationMap {
  const record = production.audioDrama;
  const story = record?.source ? world.productions.find((candidate) => candidate.meta.id === record.source!.productionId) ?? null : null;
  const sourceChapters = [...(story?.chapters ?? [])].filter((chapter) => !chapter.retired).sort((a, b) => a.order - b.order);
  const byId = new Map(sourceChapters.map((chapter) => [chapter.id, chapter]));

  const planned = Math.max(record?.plan.episodes ?? 0, ...(production.episodeScripts ?? []).map((entry) => entry.script.episode));
  const episodes: MapEpisode[] = [];
  for (let episode = 1; episode <= planned; episode++) {
    const script = production.episodeScripts?.find((entry) => entry.script.episode === episode)?.script;
    const blocks = script?.blocks ?? [];
    const scenes: MapScene[] = [];
    let current: { heading: ScriptHeading; blocks: EpisodeScriptBlock[] } | null = null;
    const close = () => {
      if (!current) return;
      const pin = current.heading.source;
      const now = pin && story && pin.story === story.meta.id ? byId.get(pin.chapter) : undefined;
      const changed = !!pin && !!now && ((now.version ?? 1) > pin.version || (pin.hash !== undefined && now.hash !== undefined && now.hash !== pin.hash));
      scenes.push({ key: `${episode}:${current.heading.id}`, episode, n: scenes.length + 1, heading: current.heading, blocks: current.blocks,
        seconds: Math.max(1, estimateScriptSeconds(current.blocks)), chapter: now ? now.id : undefined, changed });
    };
    for (const block of blocks) {
      if (block.kind === "heading") { close(); current = { heading: block, blocks: [] }; }
      else current?.blocks.push(block);
    }
    close();
    episodes.push({ episode, title: script?.title ?? "", planned: blocks.length > 0, seconds: scenes.reduce((sum, scene) => sum + scene.seconds, 0), scenes });
  }

  const allScenes = episodes.flatMap((episode) => episode.scenes);
  const sceneIndex = new Map(allScenes.map((scene, i) => [scene.key, i]));
  let furthest = -1;
  const chapters: MapChapter[] = sourceChapters.map((chapter) => {
    const scenes = allScenes.filter((scene) => scene.chapter === chapter.id).map((scene) => scene.key);
    const decision = record?.verdicts?.[chapter.id];
    const first = scenes.length > 0 ? Math.min(...scenes.map((key) => sceneIndex.get(key)!)) : null;
    const moved = first !== null && first < furthest;
    if (first !== null) furthest = Math.max(furthest, ...scenes.map((key) => sceneIndex.get(key)!));
    return {
      id: chapter.id, order: chapter.order, title: chapter.title, words: chapter.words ?? 0, version: chapter.version ?? 1, hash: chapter.hash, file: chapter.file,
      verdict: decision?.verdict ?? (scenes.length > 0 ? "keep" : null), decision, scenes, moved,
      changed: allScenes.some((scene) => scene.chapter === chapter.id && scene.changed),
    };
  });
  const ribbons = [
    ...allScenes.flatMap((scene) => scene.chapter ? [{ chapter: scene.chapter, to: scene.key }] : []),
    ...chapters.filter((chapter) => chapter.verdict === "cut").map((chapter) => ({ chapter: chapter.id, to: CUT })),
  ];
  const plannedCount = chapters.filter((chapter) => chapter.verdict !== null).length;
  return {
    story, chapters, episodes, ribbons,
    counts: { read: chapters.length, planned: plannedCount, notPlanned: chapters.length - plannedCount, changed: chapters.filter((chapter) => chapter.changed).length },
    cutWords: chapters.filter((chapter) => chapter.verdict === "cut").reduce((sum, chapter) => sum + chapter.words, 0),
  };
}

export interface MapLayout {
  height: number;
  chapters: Map<string, { y: number; h: number }>;
  scenes: Map<string, { y: number; h: number }>;
  episodes: Map<number, { y: number; h: number }>;
  cut: { y: number; h: number };
  ribbons: Array<{ chapter: string; to: string; d: string }>;
}

/**
 * Where everything sits (R-61): chapters by words and scenes by listening time, each column filling
 * the same height; a ribbon leaves its chapter in its own slice and arrives filling its scene.
 */
export function layoutMap(map: AdaptationMap, opts: { height: number; left: number; right: number; gap?: number; unplanned?: number }): MapLayout {
  const gap = opts.gap ?? 6, unplanned = opts.unplanned ?? 26, label = 30, min = 10;
  const chapterRows = map.chapters.map((chapter) => chapter.verdict === null ? 0 : Math.max(chapter.words, 1));
  const plannedWords = chapterRows.reduce((sum, words) => sum + words, 0);
  const leftFixed = map.chapters.length * gap + chapterRows.filter((words) => words === 0).length * unplanned;
  const leftScale = plannedWords > 0 ? Math.max(0, opts.height - leftFixed) / plannedWords : 0;
  const chapters = new Map<string, { y: number; h: number }>();
  let y = 0;
  map.chapters.forEach((chapter, i) => {
    const h = chapterRows[i] === 0 ? unplanned : Math.max(min, chapterRows[i]! * leftScale);
    chapters.set(chapter.id, { y, h });
    y += h + gap;
  });
  const leftHeight = y;

  const seconds = map.episodes.reduce((sum, episode) => sum + episode.seconds, 0);
  const rightFixed = map.episodes.reduce((sum, episode) => sum + (episode.planned ? label + episode.scenes.length * 2 : unplanned + gap), 0) + unplanned + gap;
  const rightScale = seconds > 0 ? Math.max(0, opts.height - rightFixed) / seconds : 0;
  const scenes = new Map<string, { y: number; h: number }>();
  const episodes = new Map<number, { y: number; h: number }>();
  y = 0;
  for (const episode of map.episodes) {
    const top = y;
    if (!episode.planned) { episodes.set(episode.episode, { y: top, h: unplanned }); y += unplanned + gap; continue; }
    y += label;
    for (const scene of episode.scenes) {
      const h = Math.max(min, scene.seconds * rightScale);
      scenes.set(scene.key, { y, h });
      y += h + 2;
    }
    episodes.set(episode.episode, { y: top, h: y - top });
    y += gap;
  }
  const cut = { y, h: Math.max(unplanned, map.cutWords * leftScale) };
  const height = Math.max(leftHeight, y + cut.h);

  // Each chapter's height is shared among its ribbons in the order they arrive.
  const ribbons: MapLayout["ribbons"] = [];
  const used = new Map<string, number>();
  const arriving = new Map<string, number>();
  for (const ribbon of map.ribbons) arriving.set(ribbon.to, (arriving.get(ribbon.to) ?? 0) + 1);
  const arrived = new Map<string, number>();
  for (const ribbon of map.ribbons) {
    const from = chapters.get(ribbon.chapter);
    const to = ribbon.to === CUT ? cut : scenes.get(ribbon.to);
    if (!from || !to) continue;
    const share = map.ribbons.filter((other) => other.chapter === ribbon.chapter).length;
    const slice = from.h / share;
    const y0 = from.y + (used.get(ribbon.chapter) ?? 0) * slice;
    used.set(ribbon.chapter, (used.get(ribbon.chapter) ?? 0) + 1);
    const inSlice = to.h / (arriving.get(ribbon.to) ?? 1);
    const y1 = to.y + (arrived.get(ribbon.to) ?? 0) * inSlice;
    arrived.set(ribbon.to, (arrived.get(ribbon.to) ?? 0) + 1);
    const mid = (opts.left + opts.right) / 2;
    const d = `M${opts.left},${y0.toFixed(1)} C${mid},${y0.toFixed(1)} ${mid},${y1.toFixed(1)} ${opts.right},${y1.toFixed(1)} `
      + `L${opts.right},${(y1 + inSlice).toFixed(1)} C${mid},${(y1 + inSlice).toFixed(1)} ${mid},${(y0 + slice).toFixed(1)} ${opts.left},${(y0 + slice).toFixed(1)} Z`;
    ribbons.push({ chapter: ribbon.chapter, to: ribbon.to, d });
  }
  return { height, chapters, scenes, episodes, cut, ribbons };
}
