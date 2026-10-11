import { effectAnalysisCanonicalJson, type EffectClip, type EffectProposalFamilyView } from "@arke-studio/contracts";
import { sha256 } from "../world/text-files.js";
import type { ProductionReadRow } from "./production-reads.js";

/** A single retained decision can name thousands of identities; pagination must reach all of it. */
export function boundedEffectReadRows(rows: ProductionReadRow[]): ProductionReadRow[] {
  return rows.flatMap(row => {
    const json = JSON.stringify(row.value), width = 2048;
    if (json.length <= width) return [row];
    const count = Math.ceil(json.length / width);
    return Array.from({ length: count }, (_, index) => ({ key: `${row.key}:fragment:${index}`,
      value: { kind: "effect-record-fragment", recordKey: row.key, index, count, jsonText: json.slice(index * width, (index + 1) * width) } }));
  });
}

/** Large curves are separate paged rows so a complete read never silently truncates an effect. */
export function effectReadRows(prefix: string, effect: EffectClip): ProductionReadRow[] {
  const { intensityCurve: _intensity, reactionCurve: _reaction, cueOverrides, ...settings } = effect;
  return boundedEffectReadRows([{ key: `${prefix}:settings`, value: { kind: "effect", effect: settings } },
    ...(["intensityCurve", "reactionCurve"] as const).flatMap(curve => [
      { key: `${prefix}:${curve}`, value: { kind: "effect-curve", effectId: effect.id, curve, pointCount: effect[curve].points.length } },
      ...effect[curve].points.map(point => ({ key: `${prefix}:${curve}:${point.id}`, value: { kind: "effect-point", effectId: effect.id, curve, point } })),
    ]), ...cueOverrides.map(cue => ({ key: `${prefix}:cue:${cue.id}`, value: { kind: "effect-cue", effectId: effect.id, cue } }))]);
}

export function effectProposalReadRows(family: EffectProposalFamilyView): ProductionReadRow[] {
  const prefix = `effects:${family.id}`, rows: ProductionReadRow[] = [{ key: prefix, value: { kind: "effect-family", id: family.id,
    productionId: family.productionId, conversationId: family.conversationId, scope: family.scope, status: family.status,
    decisionRevision: family.decisionRevision, activeDecisionIds: family.activeDecisionIds, branches: family.branches,
    receipt: family.receipt ?? null } }];
  for (const version of family.versions) {
    const { state, delta, dependencies, ...metadata } = version;
    rows.push({ key: `${prefix}:version:${version.id}`, value: { kind: "effect-version", ...metadata,
      changes: delta.map(change => ({ kind: change.kind, ...( "trackId" in change ? { trackId: change.trackId } : {}),
        ...( "ruleId" in change ? { ruleId: change.ruleId } : {}) })), readiness: dependencies.reactions,
      dependencyIssues: dependencies.issues, profiles: dependencies.profiles } });
    for (const track of state.tracks) {
      const { effects, ...header } = track;
      rows.push({ key: `${prefix}:${version.id}:track:${track.id}`, value: { kind: "effect-track", track: header } });
      for (const effect of effects) rows.push(...effectReadRows(`${prefix}:${version.id}:${effect.id}`, effect));
    }
    for (const rule of state.protection) {
      const { baselineFingerprint, ...scope } = rule;
      rows.push({ key: `${prefix}:${version.id}:protection:${rule.id}`, value: { kind: "effect-protection", rule: scope,
        baselineHash: sha256(baselineFingerprint) } });
    }
  }
  for (const decision of family.decisions) {
    if ("changes" in decision) {
      const { changes, ...header } = decision;
      rows.push({ key: `${prefix}:decision:${decision.id}`, value: { kind: "effect-human-decision", decision: header } });
      changes.forEach((change, index) => {
        rows.push({ key: `${prefix}:decision:${decision.id}:${index}`, value: { kind: "effect-adjustment", originId: change.originId,
          segmentId: change.segmentId, beforeHash: sha256(effectAnalysisCanonicalJson(change.before)), afterHash: sha256(effectAnalysisCanonicalJson(change.after)) } });
        change.scopes.forEach((scope, scopeIndex) => rows.push({ key: `${prefix}:decision:${decision.id}:${index}:scope:${scopeIndex}`,
          value: { kind: "effect-adjustment-scope", decisionId: decision.id, originId: change.originId, segmentId: change.segmentId, scope } }));
      });
    } else rows.push({ key: `${prefix}:decision:${decision.id}`, value: { kind: "effect-human-decision", decision } });
  }
  for (const kind of ["origins", "segments", "points", "slots"] as const) family.identities[kind].forEach((identity, index) =>
    rows.push({ key: `${prefix}:identity:${kind}:${index}`, value: { kind: `effect-identity-${kind}`, identity } }));
  return boundedEffectReadRows(rows);
}
