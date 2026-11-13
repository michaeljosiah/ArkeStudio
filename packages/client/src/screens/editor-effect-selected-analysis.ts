import { useEffect, useMemo, useRef, useState } from "react";
import { TimelineClipIdSchema, ulid, type EffectAnalysisState, type EffectClip, type EffectFeatureManifest, type RenderPlan } from "@arke-studio/contracts";
import { readEffectManifest } from "../lib/editor-effect-analysis.js";
import { effectAnalysisRow, effectManifestContextProblem, type EffectAnalysisContext } from "../lib/editor-effect-analysis-context.js";
import { mediaUrl } from "../lib/media.js";
import { send, useStore } from "../lib/store.js";

/** One selected manifest, independent of the eight visible preview manifests and the playhead. */
export function useSelectedEffectAnalysis(effect: EffectClip, context: EffectAnalysisContext, plan: RenderPlan | null) {
  const { state: studio, connection } = useStore();
  const productionId = context.production.meta.id, worldId = context.worldId, slug = studio?.world?.meta.slug;
  const projection = studio?.effectAnalyses?.find(value => value.worldId === worldId && value.productionId === productionId);
  const row = useMemo(() => plan ? effectAnalysisRow(effect, context, plan, projection?.byEffectId[effect.id]) : null,
    [context.production, context.artifacts, context.timeline, context.frozen, plan, effect, projection]);
  const source = row?.source ?? null;
  const state: EffectAnalysisState = row?.state ?? (effect.reaction.enabled ? { status: "source-changed", reason: "The picture plan is unavailable." } : { status: "off" });
  const canPrepare = !context.frozen && projection?.canPrepare === true && connection === "open";
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ identity: string; manifest?: EffectFeatureManifest; error?: string } | null>(null);
  const requested = useRef("");
  const frozenRow = context.frozen?.dependencies.reactions.find(value => value.effectId === effect.id);
  const frozenIdentity = context.frozen ? `${context.frozen.frameRate}/${context.frozen.startFrame}/${context.frozen.endFrame}/${frozenRow?.status === "ready" ? frozenRow.decoder.executableHash + frozenRow.decoder.versionConfigHash : "unready"}` : "current";
  const identity = state.status === "ready" && slug && plan ? `${worldId}/${productionId}/${effect.id}/${state.manifestKey}/${state.sourceFingerprint}/${row?.requestFingerprint}/${frozenIdentity}` : "";
  const isSavedBinding = row?.canRequest === true;
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
      const problem = effectManifestContextProblem(manifest, effect, context, plan);
      if (problem) throw new Error(problem);
      setLoaded({ identity, manifest });
    }).catch(error => { if (!controller.signal.aborted) setLoaded({ identity, error: error instanceof Error ? error.message : "The selected reaction cues could not load." }); });
    return () => controller.abort();
  }, [identity, attempt]);
  const current = loaded?.identity === identity ? loaded : null;
  return { state: state.status === "ready" && current?.manifest ? { ...state, silent: current.manifest.silent } : state,
    source, manifest: current?.manifest ?? null, loading: !!identity && current === null, error: current?.error,
    retry: current?.error ? () => setAttempt(value => value + 1)
      : canPrepare && isSavedBinding && source?.ok && ["source-changed", "failed", "missing-source"].includes(state.status) ? () => action("retry") : null,
    cancel: canPrepare && isSavedBinding && state.status === "analysing" ? () => action("cancel") : null };
}
