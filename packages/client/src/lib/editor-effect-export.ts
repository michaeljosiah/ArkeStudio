import { deliveredEffectLayers, effectPresetDefinition, resolveEffectAudioSource, type ArtifactSidecar,
  type EffectAnalysisState, type ProductionBundle, type ProductionTimeline, type RenderPlan } from "@arke-studio/contracts";

/** Episode readiness uses full-production sound identity and only its delivered visual effects. */
export function effectExportRefusal({ production, timeline, artifacts, canonical, delivery, states }: {
  production: ProductionBundle; timeline: ProductionTimeline; artifacts: readonly ArtifactSidecar[];
  canonical: RenderPlan; delivery: RenderPlan; states: Readonly<Record<string, EffectAnalysisState>>;
}): string | null {
  if (!delivery.effectRender) return null;
  for (const { effect } of deliveredEffectLayers(delivery.effectRender)) {
    if (!effect.reaction.enabled) continue;
    const label = effectPresetDefinition(effect.preset).label;
    if (!effect.audioInput) return `${label} · Choose an audio source or turn reaction Off.`;
    const source = resolveEffectAudioSource({ production, timeline, artifacts, plan: canonical, input: effect.audioInput });
    if (!source.ok) return `${label} · ${source.reason}`;
    const state = states[effect.id];
    if (!state || state.status === "off" || state.requestFingerprint !== source.requestFingerprint) return `${label} · Source changed. Analyse audio before export.`;
    if (state.status === "ready") continue;
    return state.status === "analysing" ? `${label} · Analysing audio. Export available when ready.`
      : `${label} · ${"reason" in state ? state.reason : "Audio analysis required."}`;
  }
  return null;
}
