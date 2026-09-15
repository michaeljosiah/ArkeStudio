import { useMemo } from "react";
import {
  buildRenderPlan,
  seedFirstPictureTimeline,
  type ArtifactSidecar,
  type ProductionBundle,
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
  /** A production with no story keeps its legacy preview until the first write folds the placements. */
  mediaOnly: boolean;
  /** Why the timeline could not be resolved, which blocks the plan by name (SPEC-039 R-39). */
  timelineError: string | null;
  /** The subtitle track viewed, or none (SPEC-038 R-26). */
  subtitleView: TimelineTrackId | null;
  /** The viewed track is muted: not asked for, or the plan would refuse and take the preview with it. */
  subtitleHidden: boolean;
}

export interface EditorRenderPlan {
  /** The record the preview draws: the saved one, or the first state an unsaved production would save. */
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
 * production previews its empty first state, not the film the story would derive. A production
 * with no story and legacy placements keeps its legacy preview until the first write folds them.
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
  mediaOnly,
  timelineError,
  subtitleView,
  subtitleHidden,
}: RenderPlanInputs): EditorRenderPlan {
  const previewState: TimelineState = useMemo(
    () =>
      production && timelineState.status === "absent" && production.spine === null && !mediaOnly
        ? { status: "ready", timeline: seedFirstPictureTimeline(production) }
        : timelineState,
    // The saved record travels inside the production snapshot, so the snapshot is the dependency
    // and the status says which way the branch goes.
    [production, timelineState.status, mediaOnly],
  );
  const renderPlan = useMemo(
    () =>
      production && (!production.spine || timelineState.status === "ready") && timelineError === null
        ? buildRenderPlan({
            production,
            artifacts: artifacts ?? [],
            timeline: previewState,
            scope: { kind: "production" },
            preset: "review-cut",
            // A hidden (muted) track is not asked for: the plan would refuse it and take the whole
            // preview with it (round nine). Hiding captions leaves the film.
            ...(subtitleView !== null && !subtitleHidden ? { subtitles: { trackId: subtitleView, mode: "none" as const } } : {}),
          })
        : null,
    [production, artifacts, previewState, timelineState.status, timelineError, subtitleView, subtitleHidden],
  );
  return { previewState, renderPlan };
}
