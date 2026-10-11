import { applyTimelineCommands, effectRenderCapabilityProblem, projectEffectLayers,
  type EffectClip, type FrameRate, type ProductionTimeline, type RenderPlan, type TimelineCommand } from "@arke-studio/contracts";

/** Effect controls describe edits; Current and reviewed candidates provide their own command sink. */
export interface EffectAuthoringProps {
  effect: EffectClip;
  timeline: ProductionTimeline;
  frameRate: FrameRate;
  playheadFrame: number;
  /** Saved authority revision, excluding transient gesture projections. */
  authoringRevision?: number;
  disabled: boolean;
  onCommands: (commands: TimelineCommand[], label?: string) => void;
  /** A transient human gesture, cleared on commit, cancellation or selection change. */
  onPreview: (commands: TimelineCommand[] | null) => void;
  onScrub: (frame: number) => void;
}

/** Direct gestures retain protection and refresh its baseline exactly like the human route. */
export function previewHumanEffects(timeline: ProductionTimeline, commands: readonly TimelineCommand[]):
  { ok: true; timeline: ProductionTimeline } | { ok: false; reason: string } {
  if (commands.some(command => command.kind === "switch-take")) return { ok: false, reason: "Effect preview cannot switch a picture take." };
  try { return { ok: true, timeline: applyTimelineCommands(timeline, commands.filter(command => command.kind !== "switch-take"), { effectAuthority: "human" }) }; }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "Effect edit unavailable" }; }
}

/** Only procedural layers change during a gesture; the canonical monitor mix keeps its identity. */
export function effectDraftPlan(canonical: RenderPlan, draft: ProductionTimeline):
  { ok: true; plan: RenderPlan } | { ok: false; reason: string } {
  if (!canonical.effectRender) return { ok: false, reason: "Save an effect before previewing its controls." };
  const effectRender = { ...canonical.effectRender, ...projectEffectLayers(draft) };
  const reason = effectRenderCapabilityProblem(effectRender);
  return reason ? { ok: false, reason } : { ok: true, plan: { ...canonical, effectRender } };
}
