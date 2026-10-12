import { buildRenderPlan, defaultExportPreset, effectAnalysisCanonicalJson, EDITOR_EFFECT_RENDERER_VERSION, EFFECT_ANALYSIS_PROFILE,
  EFFECT_PRESET_CATALOGUE, EFFECT_RENDER_PROFILE, type ArtifactSidecar, type EffectProposalVersion, type ProductionBundle,
  type ProductionTimeline, type TransitionProposalVersion } from "@arke-studio/contracts";
import { effectAnalysisDigest } from "./editor-effect-analysis.js";
import { effectReviewTimeline } from "./editor-effect-review-authoring.js";

const PROFILE_MATERIAL = effectAnalysisCanonicalJson({ catalogue: EFFECT_PRESET_CATALOGUE, renderer: EFFECT_RENDER_PROFILE, analysis: EFFECT_ANALYSIS_PROFILE });
const MAX_CACHED_MATERIAL_CHARACTERS = 8 * 1024 * 1024;
export interface EffectReviewFreshnessInput {
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  base: ProductionTimeline;
  version: EffectProposalVersion | TransitionProposalVersion;
}
export interface PreparedEffectReviewFreshness {
  candidateHash: string;
  material: string;
  expectedResolutionHash: string;
  expectedCatalogueHash: string;
  immediateReason: string | null;
}

/** Sidecar digests are observable hints; the coordinator re-hashes actual source bytes at Apply. */
function observableSourceProblem(input: EffectReviewFreshnessInput): string | null {
  const hashes = new Map<string, string>();
  const paths = new Set<string>();
  for (const artifact of input.artifacts) hashes.set(`artifacts/${artifact.file}`, artifact.hash);
  for (const path of hashes.keys()) paths.add(path);
  for (const take of input.production.takes) if (take.media) {
    const path = `productions/${input.production.meta.id}/takes/${take.id}/${take.media}`;
    paths.add(path); if (take.mediaHash) hashes.set(path, take.mediaHash);
  }
  for (const performance of input.production.performances) paths.add(`productions/${input.production.meta.id}/performances/${performance.id}/${performance.file}`);
  for (const source of input.version.dependencies.sources) {
    const knownDirectory = source.path.startsWith("artifacts/") || source.path.startsWith(`productions/${input.production.meta.id}/takes/`) ||
      source.path.startsWith(`productions/${input.production.meta.id}/performances/`);
    if (knownDirectory && !paths.has(source.path)) return `Media unavailable: ${source.path}. Update the proposal.`;
    const observed = hashes.get(source.path)?.match(/^sha256:([a-f0-9]{8,64})$/)?.[1];
    // Older sidecars retain a prefix. A matching prefix is not substituted for the host's byte check.
    if (observed && !source.sha256.startsWith(observed)) return `Media changed: ${source.path}. Update the proposal.`;
  }
  return null;
}

/** Mirrors coordinator/editor-effect-dependencies context() for the observable resolved candidate. */
export function prepareEffectReviewFreshness(input: EffectReviewFreshnessInput): PreparedEffectReviewFreshness {
  const { production, artifacts, base, version } = input, expected = version.dependencies;
  const prepared: PreparedEffectReviewFreshness = { candidateHash: version.candidateHash, material: "",
    expectedResolutionHash: expected.resolutionHash, expectedCatalogueHash: expected.profiles.catalogueHash, immediateReason: null };
  const currentHash = production.timeline?.status === "ready" ? production.timeline.hash : undefined;
  if (base.revision !== expected.base.revision || (currentHash !== undefined && currentHash !== expected.base.timelineHash)) {
    prepared.immediateReason = "Current changed. Update the proposal and review the new version."; return prepared;
  }
  if (expected.profiles.rendererVersion !== EDITOR_EFFECT_RENDERER_VERSION || expected.profiles.analysisProfileId !== EFFECT_ANALYSIS_PROFILE.id) {
    prepared.immediateReason = "The effects renderer or audio analysis profile changed. Update the proposal."; return prepared;
  }
  prepared.immediateReason = observableSourceProblem(input);
  if (prepared.immediateReason) return prepared;
  const candidate = "transitions" in version ? { ...base, transitions: version.transitions, history: { undo: [], redo: [] } } : effectReviewTimeline(base, version);
  const resolved = buildRenderPlan({ production, artifacts, timeline: { status: "ready", timeline: candidate },
    scope: { kind: "production" }, preset: defaultExportPreset(production.meta) });
  if (!resolved.ok) {
    prepared.immediateReason = `The candidate cannot be resolved: ${resolved.reason}`; return prepared;
  }
  prepared.material = effectAnalysisCanonicalJson(resolved.plan);
  return prepared;
}

/** No filesystem access or writes. Immutable digest work is shared by the active card and Cut. */
const hashes = new Map<string, Promise<string>>();
let cachedHashCharacters = 0;
function boundedDigest(material: string): Promise<string> {
  const existing = hashes.get(material);
  if (existing) { hashes.delete(material); hashes.set(material, existing); return existing; }
  const pending = effectAnalysisDigest(material);
  if (material.length > MAX_CACHED_MATERIAL_CHARACTERS) return pending;
  hashes.set(material, pending); cachedHashCharacters += material.length;
  while (hashes.size > 8 || cachedHashCharacters > MAX_CACHED_MATERIAL_CHARACTERS) {
    const key = hashes.keys().next().value!; hashes.delete(key); cachedHashCharacters -= key.length;
  }
  void pending.catch(() => { if (hashes.get(material) === pending) { hashes.delete(material); cachedHashCharacters -= material.length; } });
  return pending;
}
export async function checkEffectReviewFreshness(prepared: PreparedEffectReviewFreshness,
  digest: (material: string) => Promise<string> = boundedDigest): Promise<string | null> {
  if (prepared.immediateReason) return prepared.immediateReason;
  const [resolutionHash, catalogueHash] = await Promise.all([digest(prepared.material), digest(PROFILE_MATERIAL)]);
  if (catalogueHash !== prepared.expectedCatalogueHash) return "The effects catalogue or supported profile changed. Update the proposal.";
  if (resolutionHash !== prepared.expectedResolutionHash) return "Visual target or media resolution changed. Update the proposal.";
  return null;
}

const preparations: Array<{ input: EffectReviewFreshnessInput; prepared: PreparedEffectReviewFreshness }> = [];
/** Eight inspected candidates bound retained plans; collapsed cards do not request this work. */
export function cachedEffectReviewFreshness(input: EffectReviewFreshnessInput): PreparedEffectReviewFreshness {
  const index = preparations.findIndex(row => row.input.production === input.production && row.input.artifacts === input.artifacts &&
    row.input.base === input.base && row.input.version === input.version);
  if (index >= 0) { const [row] = preparations.splice(index, 1); preparations.push(row!); return row!.prepared; }
  const prepared = prepareEffectReviewFreshness(input);
  if (prepared.material.length > MAX_CACHED_MATERIAL_CHARACTERS) return prepared;
  preparations.push({ input, prepared });
  while (preparations.length > 8 || preparations.reduce((total, row) => total + row.prepared.material.length, 0) > MAX_CACHED_MATERIAL_CHARACTERS) preparations.shift();
  return prepared;
}
