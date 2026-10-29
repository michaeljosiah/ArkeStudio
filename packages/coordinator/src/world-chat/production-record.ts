import type { ProductionBundle, WorldBundle } from "@arke-studio/contracts";
import { comicBook, orderedShots, productionShape } from "@arke-studio/contracts";
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
        outOfDate: entry.outOfDate, cleared: entry.cleared, findings: entry.take?.verification?.status === "compared" ? entry.take.verification.findings.map((finding) => ({ kind: finding.kind, expected: finding.expected, found: finding.found })) : null })),
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
