import { useEffect, useMemo, useState } from "react";
import type { ProductionTimeline, RenderPlan, TimelineCommand } from "@arke-studio/contracts";
import { effectDraftPlan, previewHumanEffects } from "../lib/editor-effect-authoring.js";

/** A gesture belongs to one saved snapshot and selection. Reconnect/Undo cannot replay it. */
export function useHumanEffectDraft(timeline: ProductionTimeline | null, selectionId: string | null, canonical: RenderPlan | null,
  onError: (reason: string | null) => void) {
  const [pending, setPending] = useState<{ base: ProductionTimeline; selectionId: string | null; value: ProductionTimeline } | null>(null);
  const draft = pending?.base === timeline && pending.selectionId === selectionId ? pending.value : null;
  useEffect(() => {
    setPending(value => value && (value.base !== timeline || value.selectionId !== selectionId) ? null : value);
  }, [timeline, selectionId]);
  const preview = (commands: TimelineCommand[] | null) => {
    if (!commands || !timeline) { setPending(null); return; }
    const result = previewHumanEffects(timeline, commands);
    if (!result.ok) { setPending(null); onError(result.reason); return; }
    if (canonical) {
      const plan = effectDraftPlan(canonical, result.timeline);
      if (!plan.ok) { setPending(null); onError(plan.reason); return; }
    }
    onError(null);
    setPending({ base: timeline, selectionId, value: result.timeline });
  };
  const plan = useMemo(() => {
    if (!draft || !canonical) return canonical;
    const result = effectDraftPlan(canonical, draft);
    return result.ok ? result.plan : canonical;
  }, [canonical, draft]);
  return { draft, plan, preview };
}
