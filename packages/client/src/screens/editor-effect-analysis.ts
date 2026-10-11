import { useEffect, useMemo, useRef, useState } from "react";
import { resolveEffectAudioSource, TimelineClipIdSchema, ulid, type ArtifactSidecar, type EffectAnalysisState, type EffectClip,
  type EffectFeatureManifest, type ProductionBundle, type ProductionTimeline, type RenderPlan } from "@arke-studio/contracts";
import { EffectManifestCache } from "../lib/editor-effect-analysis.js";
import { mediaUrl } from "../lib/media.js";
import { send, useStore } from "../lib/store.js";
import type { PreviewReactionSources } from "../lib/editor-preview-frame.js";

export interface EffectAnalysisContext {
  worldId: string;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  timeline: ProductionTimeline;
}
export interface EffectPreviewReadiness {
  effectId: string;
  state: EffectAnalysisState;
  preview: "base" | "loading" | "ready" | "failed";
  reason?: string;
  retry: (() => void) | null;
  cancel: (() => void) | null;
}
const EMPTY_SOURCES: PreviewReactionSources = { manifestsByKey: {}, manifestKeyByEffectId: {} };

/** A late Ready row cannot react to the sound from before a current mute/move/source edit. */
export function effectPreviewAnalysisState(effect: EffectClip, requestFingerprint: string | null,
  state: EffectAnalysisState | undefined, missingReason?: string): EffectAnalysisState {
  if (!effect.reaction.enabled) return { status: "off" };
  if (!effect.audioInput) return { status: "no-source", reason: "Choose an audio source." };
  if (missingReason) return { status: "missing-source", reason: missingReason };
  if (!state || state.status === "off" || state.requestFingerprint !== requestFingerprint) return { status: "source-changed", reason: "The audio source needs analysis." };
  return state;
}

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
  const canPrepare = connection === "open" && projection?.canPrepare === true;
  const effects = plan.effectRender?.effectLayers;
  const sources = useMemo(() => (effects ?? []).map(({ effect }) => {
    const source = context && effect.audioInput ? resolveEffectAudioSource({ ...context, plan, input: effect.audioInput }) : null;
    return { effect, source, requestFingerprint: source?.requestFingerprint ?? null };
  }), [effects, context?.production, context?.artifacts, context?.timeline, plan]);
  const current = useMemo(() => sources.map(row => ({ ...row,
    state: effectPreviewAnalysisState(row.effect, row.requestFingerprint, projection?.byEffectId[row.effect.id], row.source?.ok === false ? row.source.reason : undefined),
  })), [sources, projection]);

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
    if (!row) return;
    const sent = send({ kind: "editor-effect-analysis", worldId, productionId, effectId: TimelineClipIdSchema.parse(row.effect.id), action, requestId: ulid(),
      ...(row.state.sourceFingerprint ? { expectedSourceFingerprint: row.state.sourceFingerprint } : {}) });
    if (sent && action !== "cancel" && row.requestFingerprint) requested.current.set(effectId, row.requestFingerprint);
  };
  useEffect(() => {
    for (const row of current) {
      if (row.state.status !== "source-changed") { requested.current.delete(row.effect.id); continue; }
      if (!canPrepare || !row.source?.ok || !row.requestFingerprint || row.state.status !== "source-changed") continue;
      if (requested.current.get(row.effect.id) === row.requestFingerprint) continue;
      command(row.effect.id, "prepare");
    }
  }, [current, canPrepare, worldId, productionId]);

  const visible = current.filter(({ effect }) => absoluteFrame >= effect.startFrame && absoluteFrame < effect.startFrame + effect.durationFrames);
  const visibleIds = new Set(visible.map(row => row.effect.id));
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
      if (!manifest || manifest.sourceFingerprint !== row.state.sourceFingerprint) continue;
      manifestsByKey[manifest.manifestKey] = manifest; manifestKeyByEffectId[row.effect.id] = manifest.manifestKey;
    }
    const key = JSON.stringify(manifestKeyByEffectId);
    if (retainedSources.current.key !== key) retainedSources.current = { key,
      sources: Object.keys(manifestsByKey).length ? { manifestsByKey, manifestKeyByEffectId } : EMPTY_SOURCES };
    return retainedSources.current.sources;
  }, [current, loaded, visibleKey]);
  const readiness: EffectPreviewReadiness[] = visible.map(row => {
    const local = row.state.status === "ready" ? loaded[row.state.manifestKey] : undefined;
    return { effectId: row.effect.id, state: row.state,
      preview: row.state.status === "off" || local?.manifest ? "ready" : local?.error ? "failed" : row.state.status === "ready" ? "loading" : "base",
      ...(local?.error ? { reason: local.error } : {}),
      retry: local?.error ? () => { if (row.state.status === "ready") cache.current?.retry(row.state.manifestKey); setAttempt(value => value + 1); }
        : canPrepare && (["failed", "source-changed"].includes(row.state.status) || (row.state.status === "missing-source" && row.source?.ok)) ? () => command(row.effect.id, "retry") : null,
      cancel: canPrepare && row.state.status === "analysing" ? () => command(row.effect.id, "cancel") : null };
  });
  return { sources: readySources, readiness };
}
