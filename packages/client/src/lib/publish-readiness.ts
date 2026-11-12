import {
  buildRenderPlan,
  buildVideoPublicationPlan,
  comicBook,
  dramaRoleVoice,
  dramaSpeakerLabel,
  episodeReadiness,
  type AudiobookListening,
  type ListeningChapter,
  type MediaMeasurementSource,
  type ProductionBundle,
  type StoryExportState,
  type WorldBundle,
} from "@arke-studio/contracts";
import { editorTimeline } from "./editor-timeline.js";

/**
 * Where a card's Go to leads (design turn 276b): the place that clears its first blocker, as the
 * sheets' own Go to does.
 */
export type PublishGo = { page: string; chapter: string } | { scene: string } | { path: "story/chapters" | "story/audiobook" | "story/pages" | "cut" | "branch-map" | "" };

/** A card's line (turn 276 rule 6): Ready and one fact, or Blocked · n with the first blocker. */
export type PublishReadiness =
  | { ready: true; fact: string }
  | { ready: false; count: number; first: string; go?: PublishGo; measure?: MediaMeasurementSource[] };

/** What the page asked the coordinator for, as the sheets ask: still `undefined` while it is asked. */
export interface PublishReads {
  listening?: AudiobookListening | null;
  story?: StoryExportState | null;
}

/** The outputs a card can stand for, by the plate it opens on and the kind it is made from. */
export type PublishOutputKey = "edition" | "audiobook" | "book-player" | "manuscript" | "comic" | "comic-player" | "music-player" | "story-player" | "web" | "film" | "playable" | "drama";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const blocked = (first: string, go?: PublishGo, count = 1): PublishReadiness => ({ ready: false, count, first, ...(go !== undefined ? { go } : {}) });

/** Read whole, as Export → Arke Player counts it (SPEC-058 R-3, arke-player-export.tsx). */
export const readWhole = (chapter: ListeningChapter) => chapter.state === "read" && (chapter.blocks.length > 0 || (chapter.audioStudio !== undefined && chapter.mix !== undefined));

/** `Pages 12–14`, as the comic's export sheet names a run of pages. */
function pageRange(numbers: readonly number[]): string {
  const runs: [number, number][] = [];
  for (const number of numbers) {
    const last = runs.at(-1);
    if (last && last[1] === number - 1) last[1] = number; else runs.push([number, number]);
  }
  return (numbers.length === 1 ? "Page " : "Pages ") + runs.map(([from, to]) => (from === to ? String(from) : `${from}–${to}`)).join(", ");
}

/**
 * What the playable edition's own planner refuses, as its form asks it (publication-export.tsx): a
 * missing picture or unmeasured audio holds it however many clips the cut holds (codex on PR 2981).
 * Its first sentence alone, as a card says its blocker in one clause.
 */
function playableRefusal(world: WorldBundle, production: ProductionBundle): string | null {
  const timeline = production.timeline ?? { status: "absent" as const };
  try {
    const plan = buildVideoPublicationPlan({ production, artifacts: world.artifacts, timeline }, {
      productionId: production.meta.id, id: "urn:uuid:00000000-0000-4000-8000-000000000000", edition: "First edition", title: production.meta.title, language: "en",
      preset: "master", scope: { kind: "production" }, timelineRevision: timeline.status === "ready" ? timeline.timeline.revision : null, textTracks: [],
    });
    return plan.ok ? null : firstClause(plan.reason);
  } catch {
    return "the timeline is not ready";
  }
}

/** A refusal's first sentence alone, as a card says its blocker in one clause. */
function firstClause(reason: string): string {
  const clause = reason.split(/\.\s|;\s/)[0]!.replace(/\.$/, "");
  return clause.charAt(0).toLowerCase() + clause.slice(1);
}

/**
 * What the Cut's own Export film refuses: the render plan, as its sheet reads it. A missing picture
 * is no refusal there (a slate stands in), but a clip on a file it cannot use is (issue 3026).
 */
function filmRefusal(world: WorldBundle, production: ProductionBundle): string | null {
  try {
    const plan = buildRenderPlan({ production, artifacts: world.artifacts, timeline: production.timeline ?? { status: "absent" }, scope: { kind: "production" }, preset: "master" });
    return plan.ok ? null : firstClause(plan.reason);
  } catch {
    return "the timeline is not ready";
  }
}

/**
 * The sources a cut's sound waits on measuring, each once, and the clips they hold: measuring is
 * local and free, so the card does it rather than sending someone to the Cut to do it clip by clip.
 */
function unmeasured(world: WorldBundle, production: ProductionBundle): { clips: number; sources: MediaMeasurementSource[] } {
  try {
    const plan = buildRenderPlan({ production, artifacts: world.artifacts, timeline: production.timeline ?? { status: "absent" }, scope: { kind: "production" }, preset: "master" });
    const entries = plan.ok ? plan.plan.unmeasuredAudio ?? [] : [];
    const sources = new Map(entries.flatMap((entry) => (entry.source === undefined ? [] : [[JSON.stringify(entry.source), entry.source] as const])));
    return { clips: new Set(entries.map((entry) => entry.clipId)).size, sources: [...sources.values()] };
  } catch {
    return { clips: 0, sources: [] };
  }
}

/**
 * Whether a card's output can be made now, and the one fact or the first thing in the way (turn
 * 276 rule 6). Each kind is read the way its own sheet reads it, from what the coordinator sent:
 * the production's chapters, pages, tracks, episodes and cut; a book's listening plan; a story's
 * export state. `null` while what it needs is still being asked for.
 */
export function publishReadiness(key: PublishOutputKey, world: WorldBundle, production: ProductionBundle, reads: PublishReads): PublishReadiness | null {
  const chapters = production.chapters.filter((chapter) => !chapter.retired);
  const prose = chapters.filter((chapter) => (chapter.words ?? 0) > 0);
  switch (key) {
    case "edition":
      return prose.length > 0 ? { ready: true, fact: plural(prose.length, "chapter") } : blocked("no chapter has prose", { path: "story/chapters" });
    case "manuscript": {
      const words = prose.reduce((sum, chapter) => sum + (chapter.words ?? 0), 0);
      return words > 0 ? { ready: true, fact: plural(words, "word") } : blocked("no chapter has prose", { path: "story/chapters" });
    }
    case "audiobook":
    case "book-player": {
      if (reads.listening === undefined) return null;
      const read = (reads.listening?.chapters ?? []).filter(readWhole).length;
      // The package carries the book without narration (R-2); the audiobook's files need a reading.
      if (key === "book-player") return read > 0 || prose.length > 0 ? { ready: true, fact: `${plural(prose.length, "chapter")} · ${read} read whole` } : blocked("no chapter has prose", { path: "story/chapters" });
      return read > 0 ? { ready: true, fact: `${read} of ${prose.length} read whole` } : blocked("no chapter read whole", { path: "story/audiobook" });
    }
    case "comic":
    case "comic-player": {
      const book = comicBook(production);
      if (book.length === 0) return blocked("no pages yet", { path: "story/pages" });
      const held = book.filter((entry) => entry.take === undefined || entry.outOfDate || !entry.cleared);
      if (held.length === 0) return { ready: true, fact: `${book.length} of ${book.length} accepted` };
      const reason = (entry: (typeof held)[number]) => (entry.take === undefined ? "not accepted" : entry.outOfDate ? "out of date" : "lettering not cleared");
      const first = held[0]!;
      const alike = held.filter((entry) => reason(entry) === reason(first));
      return blocked(`${pageRange(alike.map((entry) => entry.number))} · ${reason(first)}`, { page: first.id, chapter: first.chapter }, held.length);
    }
    case "music-player": {
      const tracks = production.music?.tracks.length ?? 0;
      return tracks > 0 ? { ready: true, fact: plural(tracks, "track") } : blocked("no tracks yet", { path: "" });
    }
    case "story-player":
    case "web": {
      if (reads.story === undefined) return null;
      const state = reads.story;
      if (state === null) return blocked("nothing to export yet", { path: "" });
      // The web package ships the accepted footage too (interactive.ts resolveMovieScenes), so both read every blocker.
      const blockers = state.blockers;
      if (blockers.length > 0) {
        const first = blockers[0]!;
        // A story with no routing yet is cleared on its Branch map, where the first choice is drawn.
        const go: PublishGo | undefined = first.sceneId !== undefined ? { scene: first.sceneId } : (production.routing?.choices.length ?? 0) === 0 ? { path: "branch-map" } : undefined;
        return blocked(first.detail, go, blockers.length);
      }
      return { ready: true, fact: `${plural(state.scenes, "scene")} · ${plural(state.endings, "ending")}` };
    }
    case "film":
    case "playable": {
      // The record the Cut edits and exports, built from the scenes while none is saved, as the rail measures it.
      const timeline = editorTimeline(production, production.timeline ?? { status: "absent" }, world.artifacts).timeline;
      const clips = timeline === null ? 0 : timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0);
      if (clips === 0) return blocked("nothing in the cut", { path: "cut" });
      const refused = key === "playable" ? playableRefusal(world, production) : filmRefusal(world, production);
      if (refused === null) return { ready: true, fact: `${plural(clips, "clip")} in the cut` };
      // A missing picture comes first in the planner and keeps its Go to; measuring clears only sound.
      const waiting = refused.startsWith("unmeasured audio") ? unmeasured(world, production) : { clips: 0, sources: [] };
      return waiting.sources.length > 0
        ? { ready: false, count: 1, first: `${plural(waiting.clips, "clip")} to measure`, measure: waiting.sources }
        : blocked(refused, { path: "cut" });
    }
    case "drama": {
      const name = (slug: string) => world.sheets.find((sheet) => sheet.id === slug)?.name ?? dramaSpeakerLabel(slug);
      const planned = (production.episodeScripts ?? []).filter((entry) => entry.script.blocks.length > 0);
      if (planned.length === 0) return blocked("no episode written yet", { path: "" });
      // The edition's own checks (R-72), less the saved mixes, which its dialog reads when it opens.
      const ready = planned.filter((entry) => episodeReadiness(entry.script.blocks, production.episodeTakes?.find((takes) => takes.episode === entry.script.episode), name,
        (line) => dramaRoleVoice(production.audioDrama?.cast, world.sheets, line)).ready).length;
      return ready > 0 ? { ready: true, fact: `${ready} of ${plural(planned.length, "episode")} ready` } : blocked("no episode ready", { path: "" }, planned.length);
    }
  }
}
