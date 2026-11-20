import type { ProductionBundle, WorldBundle } from "@arke-studio/contracts";
import { DEFAULT_COMIC_SETTINGS, chapterLooksOf, comicBook, comicPanelStates, orderedShots, panelTakeClears, productionShape, resolveCast, unplacedLines, type ComicBookPage, type ComicSettings } from "@arke-studio/contracts";
import { musicRecordFence } from "../productions/music.js";

/**
 * One production, read whole (round 3, 2026-08-22).
 *
 * Found by driving: an episode thread asked for its season and got nothing back — the query
 * surface served canon and sheets and nothing production-shaped, so the model was briefed on
 * the season's numbers and blind to its direction, and said so out loud. This is the read both
 * query surfaces serve now: the story, the whole season including the direction the wrap-up
 * wrote, the episodes with their promises and memberships, and the scene index.
 *
 * Context, not evidence: production records carry no observation a citation could be verified
 * against (evidence.ts refuses them by design), so nothing here mints quotable text — it is
 * the thing the thread is about, handed over instead of narrated.
 */
/**
 * A Panel by panel page as Arke reads it (turn 270): each panel made, accepted or at fault, with the
 * review's words, and its lines placed. Without this Arke told the author a page "hasn't been checked"
 * with three panels flagged on it (round 95).
 */
function comicPanelRecord(entry: ComicBookPage, production: ProductionBundle, settings: ComicSettings) {
  const record = production.comicPages?.find((held) => held.page === entry.id)?.record;
  const states = comicPanelStates(entry.page, record, settings);
  const lines = entry.page.panels.reduce((sum, panel) => sum + panel.lettering.length, 0);
  return {
    linesPlaced: lines - unplacedLines(entry.page, record).length, linesTotal: lines,
    panels: states.map((state) => {
      const review = state.shown?.review;
      return {
        panel: state.panel.id, number: state.index + 1,
        state: state.making ? "making" : state.failed !== undefined && state.shown === undefined ? "not-made" : state.shown === undefined ? "to-make"
          : state.accepted !== undefined ? (panelTakeClears(state.accepted) ? "accepted" : "accepted-with-fault")
          : review === undefined ? "checking" : panelTakeClears(state.shown) ? "clear" : "at-fault",
        ...(state.failed !== undefined ? { failed: state.failed } : {}),
        findings: review?.status === "compared" ? review.findings.map((finding) => ({ kind: finding.kind, note: finding.note })) : [],
        ...(review?.status === "unavailable" ? { reviewUnavailable: review.detail ?? review.reason } : {}),
      };
    }),
  };
}

export function productionRecord(bundle: WorldBundle, productionId: string): Record<string, unknown> | null {
  const production: ProductionBundle | undefined = bundle.productions.find((p) => p.meta.id === productionId);
  if (!production) return null;
  const shape = productionShape(production.meta);
  return {
    id: production.meta.id,
    title: production.meta.title,
    medium: shape.medium,
    kind: shape.kind,
    ...(production.meta.aspect !== undefined ? { aspect: production.meta.aspect } : {}),
    story: production.story,
    narrative: production.narrative ?? null,
    season: production.season,
    // An audio drama's plan, source and secrets (SPEC-057 R-7): its episodes are not scene records.
    ...(production.audioDrama ? { audioDrama: production.audioDrama } : {}),
    // A music production's album (SPEC-060 R-4): its tracks in order, each with its takes, trim,
    // fades, sections and the join to the next, and the session its takes are made in.
    // `baseHash` is what a music card names, so it is stale once the album moves (codex on PR 2191).
    ...(production.music ? { music: { ...production.music, baseHash: musicRecordFence(production.music) } } : {}),
    // Its episode scripts, by episode (SPEC-057 R-83): blocks carry the ids an edit names.
    // With the hash a whole-script proposal is fenced on (codex on PR 1874).
    ...(production.episodeScripts?.length ? { episodeScripts: production.episodeScripts.map((entry) => ({ ...entry.script, baseHash: entry.hash })) } : {}),
    // A graphic novel (SPEC-064 R-56): how it reads, each chapter's comic script with the ids an
    // edit names, and each page's takes as data — which is accepted, and what its lettering check
    // found. Reading only: making, accepting and overriding stay the author's.
    ...(shape.hasPages ? {
      comic: production.comic ?? null,
      comicScripts: (production.comicScripts ?? []).map((entry) => ({ chapter: entry.chapter, ...entry.script, baseHash: entry.hash })),
      comicPages: comicBook(production).map((entry) => ({ page: entry.id, number: entry.number, chapter: entry.chapter, accepted: entry.take?.id ?? null,
        outOfDate: entry.outOfDate, cleared: entry.cleared, findings: entry.take?.verification?.status === "compared" ? entry.take.verification.findings.map((finding) => ({ kind: finding.kind, expected: finding.expected, found: finding.found })) : null,
        // A page made Whole page before the book changed mode has its words in its picture: it has no panels or lines waiting.
        ...((production.comic ?? DEFAULT_COMIC_SETTINGS).mode !== "overlay" ? {} : entry.take?.mode === "baked" ? { madeAs: "whole-page" } : comicPanelRecord(entry, production, production.comic ?? DEFAULT_COMIC_SETTINGS)) })),
      // The chapters with no pages yet (turn 249c), as unwrittenEpisodes names a drama's, so Arke is
      // never told by an empty list that there is nothing to draft.
      unpagedChapters: unpaged(production),
    } : {}),
    // The planned episodes with no script yet (issue 1883): read as an empty `episodes` list, a
    // new drama told Arke it had no saved episodes to write, and Plan with Arke stalled there.
    ...(shape.isAudioDrama ? { unwrittenEpisodes: unwritten(production) } : {}),
    // A drama's episodes are its scripts, never scene episodes: an empty list here read as none.
    ...(shape.isAudioDrama ? {} : { episodes: production.episodes.map((e) => ({
      id: e.id,
      order: e.order,
      title: e.title,
      ...(e.promise !== undefined ? { promise: e.promise } : {}),
      scenes: e.scenes,
    })),
    scenes: production.scenes.map((s) => ({
      id: s.id,
      number: s.number,
      title: s.title,
      ...(s.synopsis !== undefined ? { synopsis: s.synopsis } : {}),
      shots: orderedShots(s).length,
    })) }),
    ...(shape.hasScenes ? { cast: castLooks(bundle, production) } : {}),
  };
}

/**
 * Who the film's shots cite, with the costume looks each can wear (issue 3178). A shot names the
 * look a person wears by id, and Arke can only choose one by name if the read lists them: the
 * look's id, its name (the author's label, else the start of the words it was made from), and
 * where it is attached already, since a scene's or the production's look is what a shot that
 * names none wears.
 */
function castLooks(bundle: WorldBundle, production: ProductionBundle) {
  const ids: string[] = [];
  for (const scene of production.scenes) {
    let shots: ReturnType<typeof orderedShots> = [];
    try { shots = orderedShots(scene); } catch { /* another scene's broken flow is its own refusal */ }
    for (const shot of shots) for (const entry of resolveCast(shot.description, bundle.sheets).cast) {
      if (entry.sheet.type === "character" && !ids.includes(entry.sheet.id)) ids.push(entry.sheet.id);
    }
    for (const id of Object.keys(scene.cast ?? {})) if (!ids.includes(id)) ids.push(id);
  }
  return ids.flatMap((id) => {
    const sheet = bundle.sheets.find((candidate) => candidate.id === id && candidate.type === "character");
    if (sheet === undefined) return [];
    const kit = bundle.referenceKits.find((candidate) => candidate.sheetId === id);
    return [{
      sheetId: id,
      name: sheet.name,
      looks: chapterLooksOf(kit).map((look) => ({
        id: look.id,
        name: look.name ?? clipped(look.prompt),
        kind: look.kind,
        ...(look.attachedTo?.productionId === production.meta.id ? { attachedTo: look.attachedTo.kind === "scene" ? `scene ${look.attachedTo.sceneId}` : "production" } : {}),
      })),
    }];
  });
}

function clipped(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat;
}

function unpaged(production: ProductionBundle): { chapters: Array<{ chapter: string; baseHash: string | null; planKept: boolean }>; howToWrite: string } {
  // A chapter whose pages were all removed has a saved, empty script: its base is that file's hash,
  // not null, or the draft would be refused as a guess (codex on PR 2246).
  const scripts = new Map((production.comicScripts ?? []).map((entry) => [entry.chapter, entry]));
  return {
    chapters: production.chapters
      .filter((chapter) => chapter.retired !== true && (scripts.get(chapter.id)?.script.pages.length ?? 0) === 0)
      // Whether its plan is kept (SPEC-064 R-60): pages are written only from a kept plan.
      .map((chapter) => ({ chapter: chapter.id, baseHash: scripts.get(chapter.id)?.hash ?? null, planKept: scripts.get(chapter.id)?.script.plan !== undefined })),
    howToWrite: "Each of these has no pages yet. Read the chapter's prose with get_chapter (or the chapter it adapts). With no kept plan, send its plan first with production-comic-script, alone, with no pages. With a kept plan, write its pages from it, citing each panel's source paragraphs. Name the baseHash given here and your get_production_metadata receipt either way.",
  };
}

function unwritten(production: ProductionBundle): { episodes: number[]; baseHash: null; howToWrite: string } {
  const written = new Set((production.episodeScripts ?? []).map((entry) => entry.script.episode));
  const planned = production.audioDrama?.plan.episodes ?? 0;
  return {
    episodes: Array.from({ length: planned }, (_, i) => i + 1).filter((n) => !written.has(n)),
    baseHash: null,
    howToWrite: "Each of these has no script yet. Write one with production-episode-script, its baseHash null, citing your get_production_metadata receipt. Draft a scene at a time.",
  };
}
