import { effectAnalysisCanonicalJson, resolveEffectAudioSource, type ArtifactSidecar, type EffectAnalysisState, type EffectClip,
  type EffectFeatureManifest, type EffectProposalDependencies, type EffectVersionRef, type ProductionBundle,
  type ProductionTimeline, type RenderPlan } from "@arke-studio/contracts";

export interface FrozenEffectAnalysisContext {
  ref: EffectVersionRef;
  dependencies: EffectProposalDependencies;
  frameRate: number;
  startFrame: number;
  endFrame: number;
  /** Current can change while an older candidate remains open for inspection. */
  staleReason?: string;
}
export interface EffectAnalysisContext {
  worldId: string;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  timeline: ProductionTimeline;
  frozen?: FrozenEffectAnalysisContext;
}
export interface EffectAnalysisRow {
  effect: EffectClip;
  source: ReturnType<typeof resolveEffectAudioSource> | null;
  canRequest: boolean;
  requestFingerprint: string | null;
  state: EffectAnalysisState;
}

/** A late Ready row cannot react to sound from before a Current source/routing edit. */
export function effectPreviewAnalysisState(effect: EffectClip, requestFingerprint: string | null,
  state: EffectAnalysisState | undefined, missingReason?: string): EffectAnalysisState {
  if (!effect.reaction.enabled) return { status: "off" };
  if (!effect.audioInput) return { status: "no-source", reason: "Choose an audio source." };
  if (missingReason) return { status: "missing-source", reason: missingReason };
  if (!state || state.status === "off" || state.requestFingerprint !== requestFingerprint) return { status: "source-changed", reason: "The audio source needs analysis." };
  return state;
}

/** Frozen candidates name immutable analysis; Current's mutable preparation channel has no part in it. */
export function effectAnalysisRow(effect: EffectClip, context: EffectAnalysisContext | undefined, plan: RenderPlan,
  currentState?: EffectAnalysisState): EffectAnalysisRow {
  const frozen = context?.frozen;
  if (frozen) {
    const row = frozen.dependencies.reactions.find(value => value.effectId === effect.id);
    let state: EffectAnalysisState;
    if (!effect.reaction.enabled) state = { status: "off" };
    else if (!effect.audioInput) state = { status: "no-source", reason: "Choose an audio source." };
    else if (frozen.staleReason) state = { status: "source-changed", reason: frozen.staleReason };
    else if (!row || row.status === "off" || effectAnalysisCanonicalJson(row.binding ?? null) !== effectAnalysisCanonicalJson(effect.audioInput)) {
      state = { status: "source-changed", reason: "This binding needs analysis in a new proposal version." };
    } else if (row.status === "ready") state = { status: "ready", requestFingerprint: row.requestFingerprint,
      sourceFingerprint: row.sourceFingerprint, manifestKey: row.manifestKey, silent: false, cueConflicts: [] };
    else if (row.status === "analysing") state = { status: "analysing", ...(row.requestFingerprint ? { requestFingerprint: row.requestFingerprint } : {}) };
    else state = { status: row.status === "unavailable" ? "missing-source" : row.status === "failed" ? "failed" : "source-changed",
      reason: row.reason, ...(row.requestFingerprint ? { requestFingerprint: row.requestFingerprint } : {}) };
    return { effect, source: null, canRequest: false, requestFingerprint: state.requestFingerprint ?? null, state };
  }
  const source = context && effect.audioInput ? resolveEffectAudioSource({ ...context, plan, input: effect.audioInput }) : null;
  const saved = context?.timeline.tracks.flatMap(track => track.effects ?? []).find(row => row.id === effect.id);
  const canRequest = saved?.reaction.enabled === true && effectAnalysisCanonicalJson(saved.audioInput ?? null) === effectAnalysisCanonicalJson(effect.audioInput ?? null);
  return { effect, source, canRequest, requestFingerprint: source?.requestFingerprint ?? null,
    state: effectPreviewAnalysisState(effect, source?.requestFingerprint ?? null, currentState, source?.ok === false ? source.reason : undefined) };
}

/** Shared by the monitor's bounded cache and the independently selected cue inspector. */
export function effectManifestContextProblem(manifest: EffectFeatureManifest, effect: EffectClip,
  context: EffectAnalysisContext | undefined, plan: RenderPlan): string | null {
  const frozen = context?.frozen;
  const frameRate = frozen?.frameRate ?? context?.timeline.frameRate ?? plan.frameRate;
  if (manifest.descriptor.frameRate !== frameRate || effectAnalysisCanonicalJson(manifest.descriptor.binding) !== effectAnalysisCanonicalJson(effect.audioInput))
    return "The reaction manifest belongs to another binding or frame rate.";
  const startFrame = frozen?.startFrame ?? Math.round(plan.range.startSec * frameRate);
  const endFrame = frozen?.endFrame ?? Math.round(plan.range.endSec * frameRate);
  if (manifest.features.startFrame !== startFrame || manifest.features.endFrame !== endFrame)
    return "The reaction manifest belongs to another delivery range.";
  if (frozen) {
    const expected = frozen.dependencies.reactions.find(row => row.effectId === effect.id);
    if (expected?.status !== "ready" || expected.manifestKey !== manifest.manifestKey || expected.sourceFingerprint !== manifest.sourceFingerprint)
      return "The reaction manifest does not belong to this frozen proposal.";
    if (effectAnalysisCanonicalJson(expected.decoder) !== effectAnalysisCanonicalJson(manifest.descriptor.native.decoder))
      return "The reaction manifest was prepared by another decoder.";
  }
  return null;
}
