import { applyTimelineCommands, buildRenderPlan, defaultExportPreset, effectRenderCapabilityProblem, projectEffectLayers,
  type EffectClip, type FrameRate, type ProductionTimeline, type RenderPlan, type RenderPlanInput, type TimelineCommand } from "@arke-studio/contracts";

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
export function effectDraftPlan(canonical: RenderPlan, draft: ProductionTimeline,
  firstEffects?: Pick<RenderPlanInput, "production" | "artifacts">):
  { ok: true; plan: RenderPlan } | { ok: false; reason: string } {
  let projection = canonical.effectRender;
  if (!projection) {
    if (!draft.tracks.some(track => track.effects?.length)) return { ok: true, plan: canonical };
    if (!firstEffects) return { ok: false, reason: "The picture sources are required to preview the first effect." };
    const resolved = buildRenderPlan({ ...firstEffects, timeline: { status: "ready", timeline: draft }, scope: canonical.scope,
      preset: defaultExportPreset(firstEffects.production.meta) });
    if (!resolved.ok) return resolved;
    projection = resolved.plan.effectRender;
    if (!projection) return { ok: false, reason: "The effect picture projection is unavailable." };
  }
  const effectRender = { ...projection, ...projectEffectLayers(draft) };
  const reason = effectRenderCapabilityProblem(effectRender);
  return reason ? { ok: false, reason } : { ok: true, plan: { ...canonical, effectRender } };
}
