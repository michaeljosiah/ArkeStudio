import { migrateLegacyCut, resolveProductionArtifact, seedSpinePictureTimeline,
  type ArtifactSidecar, type ProductionBundle, type ProductionTimeline } from "@arke-studio/contracts";
import { editorTimeline } from "./editor-timeline.js";

export interface EffectReviewBase { timeline: ProductionTimeline | null; reason?: string }

/**
 * The read-only base used by coordinator requestBase, including a measured, unopened spine.
 * This projection does not open or persist the timeline; the human's exact Apply remains the
 * materialisation boundary. Keep ordinary editorTimeline's explicit-open behaviour unchanged.
 */
export function effectReviewBase(production: ProductionBundle, artifacts: readonly ArtifactSidecar[]): EffectReviewBase {
  const state = production.timeline ?? { status: "absent" as const };
  if (state.status === "invalid") return { timeline: null, reason: `The timeline is invalid and cannot be reviewed: ${state.message}` };
  try {
    if (state.status === "ready" || production.spine === null) return { timeline: editorTimeline(production, state, artifacts).timeline };
    const spine = production.spine, master = resolveProductionArtifact(artifacts, spine.trackArtifactId, production.meta.id);
    if (!master.ok) return { timeline: null, reason: `Master track cites ${master.reason}` };
    const measured = master.artifact.mediaInfo?.durationSec ?? null;
    if (measured === null) return { timeline: null, reason: "Measure the master track or open this song on the timeline before reviewing its arrangement." };
    return { timeline: migrateLegacyCut(seedSpinePictureTimeline(production, spine, measured), production, artifacts).timeline };
  } catch (error) {
    return { timeline: null, reason: error instanceof Error ? error.message : "The arrangement's current timeline could not be resolved." };
  }
}
