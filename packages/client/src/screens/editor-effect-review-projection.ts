import { useMemo } from "react";
import { buildRenderPlan, defaultExportPreset, secondsToFrames, type ArtifactSidecar, type FrameRate, type ProductionBundle,
  type ProductionTimeline, type RenderPlan } from "@arke-studio/contracts";
import { effectDraftPlan } from "../lib/editor-effect-authoring.js";
import { effectReviewTimeline } from "../lib/editor-effect-review-authoring.js";
import { effectReviewBase } from "../lib/editor-effect-review-base.js";
import type { EffectAnalysisContext } from "./editor-effect-analysis.js";
import type { useEffectProposalReview } from "./editor-effect-review.js";

type ActiveReview = ReturnType<typeof useEffectProposalReview>["active"];

/** Pending effects have their own view and frozen reaction inputs; picture and sound retain one plan. */
export function useEffectReviewProjection(input: {
  worldId?: string; production?: ProductionBundle | null; artifacts?: readonly ArtifactSidecar[];
  current: ProductionTimeline | null; canonical: RenderPlan | null; frameRate: FrameRate; active: ActiveReview;
  staleReason?: string | null;
}) {
  const { worldId, production, artifacts, current, canonical, frameRate, active, staleReason } = input;
  const base = useMemo(() => current ?? (active && production ? effectReviewBase(production, artifacts ?? []).timeline : null),
    [current, !!active, production, artifacts]);
  const candidate = useMemo(() => base && active ? effectReviewTimeline(base, active.version) : null, [base, active?.version]);
  const timeline = active?.comparison === "suggested" ? candidate : base;
  const canonicalPlan = useMemo(() => {
    if (canonical || !active || !base || !production) return canonical;
    const built = buildRenderPlan({ production, artifacts: artifacts ?? [], timeline: { status: "ready", timeline: base },
      scope: { kind: "production" }, preset: defaultExportPreset(production.meta) });
    return built.ok ? built.plan : null;
  }, [canonical, !!active, base, production, artifacts]);
  const projected = useMemo(() => {
    if (!canonicalPlan) return { plan: null, problem: active ? "Current picture cannot be prepared. Restore its sources before reviewing effects." : null };
    if (!active || active.comparison === "current" || !candidate || !production) return { plan: canonicalPlan, problem: null };
    const result = effectDraftPlan(canonicalPlan, candidate, { production, artifacts: artifacts ?? [] });
    return result.ok ? { plan: result.plan, problem: null } : { plan: canonicalPlan, problem: result.reason };
  }, [canonicalPlan, candidate, active?.comparison, production, artifacts]);
  const context = useMemo((): EffectAnalysisContext | undefined => {
    if (!worldId || !production || !timeline) return undefined;
    const frozen = active?.comparison === "suggested" ? active : null;
    return { worldId, production, artifacts: artifacts ?? [], timeline,
      ...(frozen ? { frozen: { ref: frozen.ref, dependencies: frozen.version.dependencies, frameRate,
        startFrame: projected.plan?.effectRender?.startFrame ?? 0,
        endFrame: projected.plan?.effectRender?.endFrame ?? secondsToFrames(projected.plan?.totalSec ?? 0, frameRate),
        ...(staleReason ? { staleReason } : frozen.version.dependencies.base.revision !== base?.revision ? { staleReason: "Current changed. Update this proposal to prepare its reaction again." } : {}),
      } } : {}),
    };
  }, [worldId, production, artifacts, timeline, active?.version, active?.comparison, projected.plan, frameRate, base?.revision, staleReason]);
  return { timeline, candidate, context, canonicalPlan, ...projected };
}
