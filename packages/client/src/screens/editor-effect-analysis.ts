import { useEffect, useMemo, useRef, useState } from "react";
import { activeEffectLayersAtFrame, TimelineClipIdSchema, ulid, type EffectAnalysisState,
  type EffectFeatureManifest, type RenderPlan } from "@arke-studio/contracts";
import { EffectManifestCache } from "../lib/editor-effect-analysis.js";
import { effectAnalysisRow, effectManifestContextProblem, type EffectAnalysisContext } from "../lib/editor-effect-analysis-context.js";
export { effectPreviewAnalysisState, type EffectAnalysisContext } from "../lib/editor-effect-analysis-context.js";
import { mediaUrl } from "../lib/media.js";
import { send, useStore } from "../lib/store.js";
import type { PreviewReactionSources } from "../lib/editor-preview-frame.js";

export interface EffectPreviewReadiness {
  effectId: string;
  state: EffectAnalysisState;
  preview: "base" | "loading" | "ready" | "failed";
  reason?: string;
  retry: (() => void) | null;
  cancel: (() => void) | null;
}
const EMPTY_SOURCES: PreviewReactionSources = { manifestsByKey: {}, manifestKeyByEffectId: {} };

/** Derived work has its own channel; this hook never sends a timeline command or plays sound. */
export function useEffectAnalyses(context: EffectAnalysisContext | undefined, plan: RenderPlan, absoluteFrame: number): {
  sources: PreviewReactionSources; readiness: EffectPreviewReadiness[];
} {
  const { state: studio, connection } = useStore();
  const projection = studio?.effectAnalyses?.find(row => row.worldId === context?.worldId && row.productionId === context?.production.meta.id);
  const requested = useRef(new Map<string, string>());
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Record<string, { manifest?: EffectFeatureManifest; error?: string }>>({});
  const cache = useRef<EffectManifestCache | null>(null);
  const retainedSources = useRef({ key: "", sources: EMPTY_SOURCES });
  const worldId = context?.worldId, productionId = context?.production.meta.id, slug = studio?.world?.meta.slug;
  const canPrepare = !context?.frozen && connection === "open" && projection?.canPrepare === true;
  const effects = plan.effectRender?.effectLayers;
  const current = useMemo(() => (effects ?? []).map(({ effect }) => effectAnalysisRow(effect, context, plan, projection?.byEffectId[effect.id])),
    [effects, context?.production, context?.artifacts, context?.timeline, context?.frozen, plan, projection]);

  useEffect(() => {
    requested.current.clear();
    setLoaded({});
    if (!slug) return;
    const next = new EffectManifestCache(key => mediaUrl(slug, `.cache/editor-effects/analysis/${key}.json`));
    cache.current = next;
    return () => { next.destroy(); if (cache.current === next) cache.current = null; };
  }, [worldId, productionId, slug]);
  useEffect(() => { if (connection !== "open") requested.current.clear(); }, [connection]);

  const command = (effectId: string, action: "prepare" | "retry" | "cancel") => {
    if (!worldId || !productionId || !canPrepare) return;
    const row = current.find(value => value.effect.id === effectId);
    if (!row?.canRequest) return;
    const sent = send({ kind: "editor-effect-analysis", worldId, productionId, effectId: TimelineClipIdSchema.parse(row.effect.id), action, requestId: ulid(),
      ...(row.state.sourceFingerprint ? { expectedSourceFingerprint: row.state.sourceFingerprint } : {}) });
    if (sent && action !== "cancel" && row.requestFingerprint) requested.current.set(effectId, row.requestFingerprint);
  };
  useEffect(() => {
    for (const row of current) {
      if (row.state.status !== "source-changed") { requested.current.delete(row.effect.id); continue; }
      if (!canPrepare || !row.canRequest || !row.source?.ok || !row.requestFingerprint || row.state.status !== "source-changed") continue;
      if (requested.current.get(row.effect.id) === row.requestFingerprint) continue;
      command(row.effect.id, "prepare");
    }
  }, [current, canPrepare, worldId, productionId]);

  const visibleIds = new Set(plan.effectRender ? activeEffectLayersAtFrame(plan.effectRender, absoluteFrame).map(row => row.effect.id) : []);
  const visible = current.filter(row => visibleIds.has(row.effect.id));
  const visibleKey = JSON.stringify([...visibleIds]);
  const wanted = [...new Map(visible.flatMap(row => row.state.status === "ready" ? [[row.state.manifestKey,
    { key: row.state.manifestKey, source: row.state.sourceFingerprint }] as const] : [])).values()];
  const wantedKey = JSON.stringify(wanted);
  useEffect(() => {
    const owner = cache.current;
    if (!owner) return;
    let abandoned = false;
    const keys = new Set(wanted.map(row => row.key));
    owner.retain(keys);
    setLoaded({});
    for (const row of wanted) {
      void owner.get(row.key, row.source).then(manifest => {
        if (!abandoned) setLoaded(previous => ({ ...previous, [row.key]: { manifest } }));
      }, error => {
        if (!abandoned) setLoaded(previous => ({ ...previous, [row.key]: { error: error instanceof Error ? error.message : "The reaction preview could not load." } }));
      });
    }
    return () => { abandoned = true; };
  }, [wantedKey, attempt, worldId, productionId, slug]);

  const readySources = useMemo((): PreviewReactionSources => {
    const manifestsByKey: Record<string, EffectFeatureManifest> = {}, manifestKeyByEffectId: Record<string, string> = {};
    for (const row of current) {
      if (row.state.status !== "ready" || !visibleIds.has(row.effect.id)) continue;
      const manifest = loaded[row.state.manifestKey]?.manifest;
      if (!manifest || manifest.sourceFingerprint !== row.state.sourceFingerprint ||
        (context?.frozen && effectManifestContextProblem(manifest, row.effect, context, plan))) continue;
      manifestsByKey[manifest.manifestKey] = manifest; manifestKeyByEffectId[row.effect.id] = manifest.manifestKey;
    }
    const key = JSON.stringify(manifestKeyByEffectId);
    if (retainedSources.current.key !== key) retainedSources.current = { key,
      sources: Object.keys(manifestsByKey).length ? { manifestsByKey, manifestKeyByEffectId } : EMPTY_SOURCES };
    return retainedSources.current.sources;
  }, [current, loaded, visibleKey, context?.frozen, plan]);
  const readiness: EffectPreviewReadiness[] = visible.map(row => {
    const local = row.state.status === "ready" ? loaded[row.state.manifestKey] : undefined;
    const invalid = local?.manifest && context?.frozen ? effectManifestContextProblem(local.manifest, row.effect, context, plan) : null;
    return { effectId: row.effect.id, state: row.state.status === "ready" && local?.manifest && !invalid ? { ...row.state, silent: local.manifest.silent } : row.state,
      preview: invalid ? "failed" : row.state.status === "off" || local?.manifest ? "ready" : local?.error ? "failed" : row.state.status === "ready" ? "loading" : "base",
      ...(invalid || local?.error ? { reason: invalid ?? local!.error } : {}),
      retry: local?.error ? () => { if (row.state.status === "ready") cache.current?.retry(row.state.manifestKey); setAttempt(value => value + 1); }
        : canPrepare && row.canRequest && (["failed", "source-changed"].includes(row.state.status) || (row.state.status === "missing-source" && row.source?.ok)) ? () => command(row.effect.id, "retry") : null,
      cancel: canPrepare && row.canRequest && row.state.status === "analysing" ? () => command(row.effect.id, "cancel") : null };
  });
  return { sources: readySources, readiness };
}
