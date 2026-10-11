import { createHash } from "node:crypto";
import { buildRenderPlan, defaultExportPreset, deliveredEffectLayers, effectAnalysisCanonicalJson,
  effectRenderCapabilityProblem, EDITOR_EFFECT_RENDERER_VERSION, EFFECT_PRESET_CATALOGUE, EFFECT_RENDER_PROFILE,
  EFFECT_ANALYSIS_PROFILE, type ProductionTimeline, type ProductionBundle, type RenderPlan,
  type EffectProposalDependencies, type WorldBundle } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import { hashMediaFile } from "../media/media-file-hash.js";
import type { EditorEffectAnalysisService } from "./editor-effect-analysis.js";
import { requestBase } from "./editor-requests.js";
import { scanWorld } from "../world/scan.js";
import { sha256 } from "../world/text-files.js";

const hash = (value: unknown) => createHash("sha256").update(effectAnalysisCanonicalJson(value)).digest("hex");
const profiles = () => ({ rendererVersion: EDITOR_EFFECT_RENDERER_VERSION,
  catalogueHash: hash({ catalogue: EFFECT_PRESET_CATALOGUE, renderer: EFFECT_RENDER_PROFILE, analysis: EFFECT_ANALYSIS_PROFILE }),
  analysisProfileId: EFFECT_ANALYSIS_PROFILE.id });
const protection = (timeline: ProductionTimeline): EffectProposalDependencies["protection"] => (timeline.effectProtection ?? []).map(rule => {
  const { baselineFingerprint, baselineRevision, ...scope } = rule;
  return { ruleId: rule.id, scopeFingerprint: hash(scope), baselineFingerprint, baselineRevision };
});
type Context = { production: ProductionBundle; plan?: RenderPlan; resolutionHash: string; issues: EffectProposalDependencies["issues"]; paths: string[] };

function context(bundle: WorldBundle, productionId: string, timeline: ProductionTimeline): Context {
  const production = bundle.productions.find(value => value.meta.id === productionId);
  if (!production) throw new Error("Production is unavailable");
  const planned = buildRenderPlan({ production, artifacts: bundle.artifacts, timeline: { status: "ready", timeline },
    scope: { kind: "production" }, preset: defaultExportPreset(production.meta) });
  if (!planned.ok) return { production, resolutionHash: hash({ reason: planned.reason, timeline, meta: production.meta }),
    issues: [{ kind: "profile", reason: planned.reason }], paths: [] };
  const plan = planned.plan, issues: Context["issues"] = [];
  if (plan.effectRender) {
    const problem = effectRenderCapabilityProblem(plan.effectRender);
    if (problem) issues.push({ kind: "profile", reason: problem });
    for (const issue of plan.effectRender.issues) if (issue.kind === "missing-target") issues.push({ kind: "missing-media", reason: issue.reason });
  }
  const paths = [...new Set([...plan.audio.map(item => item.path), ...(plan.effectRender?.pictureLayers.flatMap(item => item.path ? [item.path] : []) ?? [])])].sort();
  return { production, plan, resolutionHash: hash(plan), issues, paths };
}

export interface EffectDependencyCapture {
  store: WorldStore; productionId: string; baseTimelineHash: string; candidate: ProductionTimeline;
  candidateBasisHash: string; signal?: AbortSignal;
}
export interface EffectDependencyValidation {
  store: WorldStore; productionId: string; current: ProductionTimeline; candidate: ProductionTimeline;
  candidateHash: string; expectedFence: EffectProposalDependencies; phase: "gate" | "precommit";
  signal?: AbortSignal; requireReady?: boolean;
}

/** Frozen read sets are proposal authority. Preparation and Apply intentionally have separate ports. */
export class EditorEffectDependencies {
  constructor(private readonly analysis: EditorEffectAnalysisService) {}

  async captureDependencies(input: EffectDependencyCapture): Promise<EffectProposalDependencies> {
    const { store, productionId, candidate } = input, signal = input.signal ?? store.closingSignal;
    signal.throwIfAborted(); await store.assertOwnership();
    const resolved = context(store.getBundle(), productionId, candidate), issues = [...resolved.issues];
    const sources: EffectProposalDependencies["sources"] = [];
    for (const path of resolved.paths) {
      try { sources.push({ path, sha256: await hashMediaFile(await containedWorldFilePath(store.dir, path), signal) }); }
      catch { signal.throwIfAborted(); issues.push({ kind: "missing-media", reason: `Media unavailable: ${path}` }); }
    }
    const reactions: EffectProposalDependencies["reactions"] = [];
    const delivered = resolved.plan?.effectRender ? deliveredEffectLayers(resolved.plan.effectRender) : [];
    let prepared: Awaited<ReturnType<EditorEffectAnalysisService["prepareCandidate"]>> = new Map();
    if (resolved.plan && delivered.some(({ effect }) => effect.reaction.enabled)) {
      try { prepared = await this.analysis.prepareCandidate(store, { production: resolved.production, timeline: candidate,
        plan: resolved.plan, basisHash: input.candidateBasisHash }, signal); }
      catch (error) { signal.throwIfAborted(); issues.push({ kind: "analysis", reason: error instanceof Error ? error.message : "Audio analysis failed" }); }
    }
    for (const { effect } of delivered) {
      if (!effect.reaction.enabled) { reactions.push({ effectId: effect.id, status: "off" }); continue; }
      const result = prepared.get(effect.id);
      if (result && "manifest" in result && effect.audioInput) {
        const manifest = result.manifest;
        reactions.push({ effectId: effect.id, status: "ready", binding: effect.audioInput,
          requestFingerprint: result.requestFingerprint, manifestKey: manifest.manifestKey,
          sourceFingerprint: manifest.sourceFingerprint, decoder: manifest.descriptor.native.decoder });
        for (const file of manifest.descriptor.sources) {
          const found = sources.find(source => source.path === file.path);
          if (found && found.sha256 !== file.sha256) issues.push({ kind: "source-changed", reason: `Media changed during preparation: ${file.path}` });
          else if (!found) sources.push(file);
        }
      } else reactions.push({ effectId: effect.id, status: "unavailable", ...(effect.audioInput ? { binding: effect.audioInput } : {}),
        reason: result && "reason" in result ? result.reason : "Prepare audio reaction" });
    }
    const currentProduction = store.getBundle().productions.find(value => value.meta.id === productionId);
    if (!currentProduction) throw new Error("Current production is unavailable");
    const current = requestBase(store, currentProduction).timeline;
    await store.assertOwnership(); signal.throwIfAborted();
    return { schemaVersion: 1, base: { revision: current.revision, timelineHash: input.baseTimelineHash },
      resolutionHash: resolved.resolutionHash, profiles: profiles(), sources: sources.sort((a, b) => a.path.localeCompare(b.path)),
      protection: protection(current), reactions, issues };
  }

  async validateDependencies(input: EffectDependencyValidation): Promise<void> {
    const { store, productionId, current, candidate, expectedFence: expected } = input, signal = input.signal ?? store.closingSignal;
    signal.throwIfAborted(); await store.assertOwnership();
    if (current.revision !== expected.base.revision || hash(profiles()) !== hash(expected.profiles) || hash(protection(current)) !== hash(expected.protection)) {
      throw new Error("Current, protection or effect profile changed; update the proposal");
    }
    // Watcher work is queued behind the gate. Read resolution inputs from disk again before
    // the committing marker so outside edits to selections/metadata cannot hide in that queue.
    const fresh = input.phase === "precommit" ? await scanWorld(store.dir, { signal, includeOperationalState: false }) : undefined;
    const bundle = fresh?.bundle ?? store.getBundle();
    if (fresh && (fresh.manifest[`productions/${productionId}/timeline.json`] ?? sha256("null")) !== expected.base.timelineHash) {
      throw new Error("Current changed during staging; update the proposal");
    }
    const resolved = context(bundle, productionId, candidate);
    if (resolved.resolutionHash !== expected.resolutionHash) throw new Error("Visual target or media resolution changed; update the proposal");
    for (const file of expected.sources) {
      if (await hashMediaFile(await containedWorldFilePath(store.dir, file.path), signal) !== file.sha256) throw new Error(`Media changed: ${file.path}. Update the proposal`);
    }
    if (input.requireReady !== false && (expected.issues.length || expected.reactions.some(row => row.status !== "off" && row.status !== "ready"))) {
      throw new Error(expected.issues[0]?.reason ?? "Audio reaction is not ready; prepare a new proposal version");
    }
    const delivered = resolved.plan?.effectRender ? deliveredEffectLayers(resolved.plan.effectRender) : [];
    if (hash(delivered.map(({ effect }) => effect.id).sort()) !== hash(expected.reactions.map(row => row.effectId).sort())) throw new Error("Delivered effect scope changed; update the proposal");
    let bytes = 0;
    const checked = new Set<string>();
    for (const row of expected.reactions) {
      const effect = delivered.find(value => value.effect.id === row.effectId)?.effect;
      if (!effect || (row.status === "off" && effect.reaction.enabled)) throw new Error("Effect reaction changed; update the proposal");
      if (row.status !== "ready") continue;
      if (!effect.reaction.enabled || hash(effect.audioInput) !== hash(row.binding) || !resolved.plan) throw new Error("Effect audio binding changed; update the proposal");
      const manifest = await this.analysis.validateCandidateManifest(store, { production: resolved.production, timeline: candidate,
        plan: resolved.plan, effect, manifestKey: row.manifestKey, requestFingerprint: row.requestFingerprint,
        sourceFingerprint: row.sourceFingerprint, artifacts: bundle.artifacts }, signal);
      if (hash(manifest.descriptor.native.decoder) !== hash(row.decoder)) throw new Error("Audio decoder changed; update the proposal");
      if (!checked.has(manifest.manifestKey)) { checked.add(manifest.manifestKey); bytes += Buffer.byteLength(JSON.stringify(manifest)); }
    }
    if (bytes > EFFECT_ANALYSIS_PROFILE.maxFrozenManifestBytes) throw new Error("Prepared audio exceeds the 32 MiB feature budget");
    signal.throwIfAborted(); await store.assertOwnership();
  }
}
