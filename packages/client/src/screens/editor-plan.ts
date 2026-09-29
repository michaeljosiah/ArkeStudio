import { useMemo } from "react";
import {
  buildRenderPlan,
  legacyArtifactScopeRefusal,
  type ArtifactSidecar,
  type ProductionBundle,
  type ProductionTimeline,
  type RenderPlanResult,
  type TimelineState,
  type TimelineTrackId,
} from "@arke-studio/contracts";

/**
 * The one record a production without `timeline.json` reads as, so a snapshot that carries none
 * is the same state from one render to the next rather than a fresh object each time.
 */
export const ABSENT_TIMELINE: TimelineState = { status: "absent" };

/** What the plan is made of: each of these is a snapshot the store replaces or a value the screen chooses. */
export interface RenderPlanInputs {
  production: ProductionBundle | null;
  /** The world's whole catalog: the plan resolves scope itself, and a scoped-out file is a named refusal. */
  artifacts: readonly ArtifactSidecar[] | undefined;
  timelineState: TimelineState;
  /** The record the editor edits (`lib/editor-timeline.ts`); null while there is none to edit. */
  timeline: ProductionTimeline | null;
  /** Why the timeline could not be resolved, which blocks the plan by name (SPEC-039 R-39). */
  timelineError: string | null;
  /** The subtitle track viewed, or none (SPEC-038 R-26). */
  subtitleView: TimelineTrackId | null;
  /** The viewed track is muted: not asked for, or the plan would refuse and take the preview with it. */
  subtitleHidden: boolean;
}

export interface EditorRenderPlan {
  /** The record the preview draws: the one the editor edits, or the timeline's own state while there is none. */
  previewState: TimelineState;
  /** Null while there is no production, or the song has not been opened on the timeline, or the record is blocked. */
  renderPlan: RenderPlanResult | null;
}

/**
 * One render plan for the preview and the export (SPEC-038 R-1, issue 680). The viewer asks the
 * plan what is visible; the coordinator hands the same plan to FFmpeg. A production the plan
 * refuses is a production the export refuses, so the refusal blocks the editor by name.
 *
 * The preview draws the record the editor edits (decided 2026-09-02): an unsaved story
 * production previews its empty first state, not the film the story would derive, and a
 * production still holding legacy placements previews them folded onto typed tracks, exactly as
 * the first write will save them (issue 1159). A song not yet opened on the timeline has no
 * record to draw and no plan; the spine's own spans carry its preview.
 *
 * The fold drops a placement it cannot resolve — a file the world has lost, or another
 * production's — and the projected record no longer names it, so planning from the projection
 * alone would preview a film the export sheet and the coordinator still refuse by that name
 * (Codex review of PR 1203). The saved state is asked first, with the same question they ask, so
 * the preview refuses as they do (SPEC-039 R-39) until the reference is mended or the first write
 * folds it away; the screen's footer says which placements that write will leave behind.
 *
 * Memoised here, in a hook the editor owns, and the identity matters as much as the cost. The
 * transport reports four times a second, so derived in a screen body this ran four times a
 * second for the whole length of every film — resolving the picture timeline, building every
 * overlay and merging the speech regions, none of which had changed. Worse than the work was the
 * churn: the plan is what the monitor mix, the preview's spans and the cue lookup are keyed on,
 * and a fresh object each render restarted all three; the sound heard that as four pause/play
 * cycles a second. The inputs are the only things the plan is made of, and nothing else can reach
 * in — which is the point of the hook: the next hand that touches the screen cannot reintroduce
 * the rebuild by adding a dependency it did not notice (issue 1158).
 */
export function useRenderPlan({
  production,
  artifacts,
  timelineState,
  timeline,
  timelineError,
  subtitleView,
  subtitleHidden,
}: RenderPlanInputs): EditorRenderPlan {
  const previewState: TimelineState = useMemo(
    () => (timeline !== null ? { status: "ready", timeline } : timelineState),
    [timeline, timelineState],
  );
  const renderPlan = useMemo((): RenderPlanResult | null => {
    if (!production || (production.spine && timelineState.status !== "ready") || timelineError !== null) return null;
    const legacyRefusal = legacyArtifactScopeRefusal(production, artifacts ?? [], timelineState);
    if (legacyRefusal !== null) return { ok: false, reason: legacyRefusal };
    return buildRenderPlan({
      production,
      artifacts: artifacts ?? [],
      timeline: previewState,
      scope: { kind: "production" },
      preset: "review-cut",
      // A hidden (muted) track is not asked for: the plan would refuse it and take the whole
      // preview with it (round nine). Hiding captions leaves the film.
      ...(subtitleView !== null && !subtitleHidden ? { subtitles: { trackId: subtitleView, mode: "none" as const } } : {}),
    });
  }, [production, artifacts, previewState, timelineState, timelineError, subtitleView, subtitleHidden]);
  return { previewState, renderPlan };
}
