import { useEffect, useMemo, useRef, useState } from "react";
import { effectAnalysisCanonicalJson, resolveEffectAudioSource, TimelineClipIdSchema, ulid, type EffectClip, type EffectFeatureManifest, type RenderPlan } from "@arke-studio/contracts";
import { readEffectManifest } from "../lib/editor-effect-analysis.js";
import { mediaUrl } from "../lib/media.js";
import { send, useStore } from "../lib/store.js";
import { effectPreviewAnalysisState, type EffectAnalysisContext } from "./editor-effect-analysis.js";

/** One selected manifest, independent of the eight visible preview manifests and the playhead. */
export function useSelectedEffectAnalysis(effect: EffectClip, context: EffectAnalysisContext, plan: RenderPlan | null) {
  const { state: studio, connection } = useStore();
  const productionId = context.production.meta.id, worldId = context.worldId, slug = studio?.world?.meta.slug;
  const projection = studio?.effectAnalyses?.find(value => value.worldId === worldId && value.productionId === productionId);
  const source = useMemo(() => effect.audioInput && plan ? resolveEffectAudioSource({ ...context, plan, input: effect.audioInput }) : null,
    [context.production, context.artifacts, context.timeline, plan, effect.audioInput]);
  const state = effectPreviewAnalysisState(effect, source?.requestFingerprint ?? null, projection?.byEffectId[effect.id], source?.ok === false ? source.reason : undefined);
  const canPrepare = projection?.canPrepare === true && connection === "open";
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ identity: string; manifest?: EffectFeatureManifest; error?: string } | null>(null);
  const requested = useRef("");
  const identity = state.status === "ready" && slug && plan ? `${worldId}/${productionId}/${effect.id}/${state.manifestKey}/${state.sourceFingerprint}/${source?.requestFingerprint}` : "";
  const savedEffect = context.timeline.tracks.flatMap(track => track.effects ?? []).find(value => value.id === effect.id);
  const isSavedBinding = savedEffect?.reaction.enabled === effect.reaction.enabled && effectAnalysisCanonicalJson(savedEffect?.audioInput ?? null) === effectAnalysisCanonicalJson(effect.audioInput ?? null);
  const action = (kind: "prepare" | "retry" | "cancel") => {
    if (!canPrepare || !isSavedBinding || !plan) return;
    const sent = send({ kind: "editor-effect-analysis", worldId, productionId, effectId: TimelineClipIdSchema.parse(effect.id), action: kind, requestId: ulid(),
      ...(state.sourceFingerprint ? { expectedSourceFingerprint: state.sourceFingerprint } : {}) });
    if (sent && kind !== "cancel") requested.current = `${worldId}/${productionId}/${effect.id}/${source?.requestFingerprint}`;
  };
  useEffect(() => {
    const key = `${worldId}/${productionId}/${effect.id}/${source?.requestFingerprint}`;
    if (state.status !== "source-changed") { requested.current = ""; return; }
    if (!canPrepare || !isSavedBinding || !source?.ok || !plan) return;
    if (requested.current !== key) action("prepare");
  }, [worldId, productionId, effect.id, source?.requestFingerprint, state.status, canPrepare, isSavedBinding, plan]);
  useEffect(() => { if (connection !== "open") requested.current = ""; }, [connection]);
  useEffect(() => {
    setLoaded(null);
    if (!identity || state.status !== "ready" || !slug || !plan) return;
    const controller = new AbortController();
    void readEffectManifest(mediaUrl(slug, `.cache/editor-effects/analysis/${state.manifestKey}.json`), state.manifestKey, state.sourceFingerprint, controller.signal).then(manifest => {
      if (controller.signal.aborted) return;
      if (manifest.descriptor.frameRate !== context.timeline.frameRate || effectAnalysisCanonicalJson(manifest.descriptor.binding) !== effectAnalysisCanonicalJson(effect.audioInput)) throw new Error("The reaction manifest belongs to another binding or frame rate.");
      if (manifest.features.startFrame !== Math.round(plan.range.startSec * context.timeline.frameRate) || manifest.features.endFrame !== Math.round(plan.range.endSec * context.timeline.frameRate)) throw new Error("The reaction manifest belongs to an earlier delivery range.");
      setLoaded({ identity, manifest });
    }).catch(error => { if (!controller.signal.aborted) setLoaded({ identity, error: error instanceof Error ? error.message : "The selected reaction cues could not load." }); });
    return () => controller.abort();
  }, [identity, attempt]);
  const current = loaded?.identity === identity ? loaded : null;
  return { state, source, manifest: current?.manifest ?? null, loading: !!identity && current === null, error: current?.error,
    retry: current?.error ? () => setAttempt(value => value + 1)
      : canPrepare && isSavedBinding && source?.ok && ["source-changed", "failed", "missing-source"].includes(state.status) ? () => action("retry") : null,
    cancel: canPrepare && isSavedBinding && state.status === "analysing" ? () => action("cancel") : null };
}
