import {
  migrateLegacyCut,
  seedFirstPictureTimeline,
  type MigrationArtifact,
  type ProductionBundle,
  type ProductionTimeline,
  type TimelineState,
} from "@arke-studio/contracts";

/**
 * The record the editor edits, the preview draws and the rail measures (issue 1159).
 *
 * Legacy `cut.json` placements fold into typed tracks with the first timeline write, and never
 * on read (SPEC-037 R-2, R-30; A-1): opening a legacy world changes no bytes. Until that write
 * the editor shows the fold the write will make — `migrateLegacyCut` over the same seed, against
 * the same catalog, yielding the track and clip ids the coordinator will persist — so a legacy
 * placement is a typed clip from the moment the production opens: dragged, trimmed, inspected and
 * previewed as one, with every command landing on the id the fold reserves for it. There is no
 * second writer, and nothing is left for the old numbered lanes to draw.
 *
 * A record that has absorbed its placements comes back as it is: `migrateLegacyCut` returns the
 * same object for one already marked migrated, so a saved timeline keeps its identity and the
 * memos keyed on it hold.
 *
 * Null while there is nothing to edit: an invalid record (SPEC-037 R-5), or a song not yet opened
 * on the timeline (A-12) — its anchors are the spine's until the explicit open materialises them,
 * and a fold projected over a track nobody can edit would edit clips nobody can see. Placements
 * such a song still holds in `cut.json` fold in with that opening.
 */
export function editorTimeline(
  production: ProductionBundle,
  timelineState: TimelineState,
  artifacts: readonly MigrationArtifact[],
): ProductionTimeline | null {
  if (timelineState.status === "invalid") return null;
  if (timelineState.status === "ready") return migrateLegacyCut(timelineState.timeline, production, artifacts).timeline;
  if (production.spine !== null) return null;
  return migrateLegacyCut(seedFirstPictureTimeline(production), production, artifacts).timeline;
}
