import { effectAnalysisCanonicalJson as canonical } from "./editor-effect-analysis.js";
import type { EffectClip } from "./editor-effects.js";
import type { ProductionTimeline } from "./timeline.js";
import { EFFECT_PROPOSAL_BOUNDS, EffectIdentityLedgerSchema, EffectCreativeCommandSchema,
  type EffectCreativeCommand, type EffectIdentityAllocation, type EffectIdentityLedger, type EffectHumanDecision, type ModelEffectProposal } from "./editor-effect-proposal.js";

export class EffectProposalIdentityRefused extends Error {}
function refused(reason: string): never { throw new EffectProposalIdentityRefused(reason); }
export const proposalEffects = (timeline: Pick<ProductionTimeline, "tracks">): EffectClip[] => timeline.tracks.flatMap(track => track.effects ?? []);

export function seedEffectIdentityLedger(base: ProductionTimeline): EffectIdentityLedger {
  const ledger: EffectIdentityLedger = { origins: [], segments: [], points: [], slots: [] };
  for (const effect of proposalEffects(base)) {
    const originId = `origin:${effect.lineageId}`;
    if (!ledger.origins.some(row => row.originId === originId)) ledger.origins.push({ originId, kind: "current", lineageId: effect.lineageId,
      currentLineageId: effect.lineageId, seed: effect.seed, createdByStepId: "base", tombstoned: false });
    ledger.segments.push({ segmentId: `segment:${effect.id}`, clipId: effect.id, originId, createdByStepId: "base", tombstoned: false });
    for (const [kind, points] of [["intensity-point", effect.intensityCurve.points], ["reaction-point", effect.reactionCurve.points], ["cue", effect.cueOverrides]] as const) {
      for (const point of points) if (!ledger.points.some(row => row.originId === originId && row.kind === kind && row.authoredId === point.id))
        ledger.points.push({ entityId: `${originId}:${kind}:${point.id}`, authoredId: point.id, originId, kind, createdByStepId: "base", tombstoned: false });
    }
  }
  return validateEffectIdentityLedger(ledger);
}

export function validateEffectIdentityLedger(ledger: EffectIdentityLedger): EffectIdentityLedger {
  const parsed = EffectIdentityLedgerSchema.parse(ledger);
  const all = [...parsed.origins.map(row => row.originId), ...parsed.segments.map(row => row.segmentId), ...parsed.points.map(row => row.entityId), ...parsed.slots.map(row => row.id)];
  if (all.length > EFFECT_PROPOSAL_BOUNDS.identitiesPerFamily) refused("The proposal identity ledger exceeds 8000 identities.");
  if (new Set(all).size !== all.length) refused("Proposal identity IDs must be unique, including tombstones.");
  const origins = new Set(parsed.origins.map(row => row.originId)), segments = new Set(parsed.segments.map(row => row.segmentId));
  if (new Set(parsed.origins.map(row => row.lineageId)).size !== parsed.origins.length || new Set(parsed.segments.map(row => row.clipId)).size !== parsed.segments.length) refused("Authored lineage and clip identities cannot be reused.");
  for (const row of parsed.origins) if (row.derivedFromOriginId && !origins.has(row.derivedFromOriginId)) refused("A duplicate's source origin is missing.");
  for (const row of parsed.segments) if (!origins.has(row.originId) || row.parentSegmentId && !segments.has(row.parentSegmentId)) refused("Segment ancestry is missing.");
  for (const row of parsed.points) if (!origins.has(row.originId)) refused("Point ancestry is missing.");
  const points = new Set(parsed.points.map(row => row.entityId));
  if (new Set(parsed.points.map(row => `${row.originId}:${row.kind}:${row.authoredId}`)).size !== parsed.points.length) refused("Authored point identities cannot be duplicated within an origin.");
  for (const row of parsed.points) if (row.parentEntityId && !points.has(row.parentEntityId)) refused("A copied point's parent identity is missing.");
  for (const row of parsed.slots) if (row.originId && !origins.has(row.originId)) refused("Slot origin is missing.");
  for (const row of parsed.origins) {
    const seen = new Set<string>(); let current: typeof row | undefined = row;
    while (current) { if (seen.has(current.originId)) refused("Origin ancestry cannot cycle."); seen.add(current.originId); current = parsed.origins.find(item => item.originId === current!.derivedFromOriginId); }
  }
  for (const row of parsed.segments) {
    const seen = new Set<string>(); let current: typeof row | undefined = row;
    while (current) { if (seen.has(current.segmentId)) refused("Segment ancestry cannot cycle."); seen.add(current.segmentId); current = parsed.segments.find(item => item.segmentId === current!.parentSegmentId); }
  }
  return parsed;
}

/** Host calls its own mint/seed ports once; retries reuse the persisted allocation list. */
export function allocateEffectProposalIdentities(model: ModelEffectProposal, mint: (kind: "clip" | "lineage" | "entity" | "point" | "cue") => string,
  seed: () => number): EffectIdentityAllocation[] {
  return model.identities.flatMap<EffectIdentityAllocation>(claim => {
    if (claim.kind === "new-effect" || claim.kind === "duplicate") return [{ kind: "effect" as const, alias: claim.alias, entityId: mint("entity"), clipId: mint("clip"), lineageId: mint("lineage"), seed: seed(), slotId: claim.slotId }];
    if (claim.kind === "split") return [{ kind: "segment" as const, alias: claim.alias, entityId: mint("entity"), clipId: mint("clip") }];
    if (claim.kind === "new-point" || claim.kind === "new-cue") return [{ kind: claim.kind === "new-point" ? "point" as const : "cue" as const, alias: claim.alias, entityId: mint("entity"), authoredId: mint(claim.kind === "new-point" ? "point" : "cue") }];
    return [];
  });
}

export function effectOriginDescendsFrom(ledger: EffectIdentityLedger, originId: string, ancestorId: string): boolean {
  const seen = new Set<string>(); let current: string | undefined = originId;
  while (current && !seen.has(current)) { if (current === ancestorId) return true; seen.add(current); current = ledger.origins.find(row => row.originId === current)?.derivedFromOriginId; }
  return false;
}
export function effectSegmentDescendsFrom(ledger: EffectIdentityLedger, segmentId: string, ancestorId: string): boolean {
  const seen = new Set<string>(); let current: string | undefined = segmentId;
  while (current && !seen.has(current)) { if (current === ancestorId) return true; seen.add(current); current = ledger.segments.find(row => row.segmentId === current)?.parentSegmentId; }
  return false;
}

/** Resolves model aliases; no model-supplied ancestry or seed becomes authority. */
export function admitEffectModelIdentity(input: { ledger: EffectIdentityLedger; model: ModelEffectProposal; allocations: EffectIdentityAllocation[];
  decisions: readonly EffectHumanDecision[]; stepId: string; initial?: boolean }): { ledger: EffectIdentityLedger; commands: EffectCreativeCommand[] } {
  const ledger = structuredClone(input.ledger), aliases = new Map<string, string>();
  const claims = new Map(input.model.identities.map(claim => [claim.alias, claim]));
  if (claims.size !== input.model.identities.length || new Set(input.allocations.map(row => row.alias)).size !== input.allocations.length) refused("Identity aliases and allocations must be unique.");
  const authored = (entityId: string): string | undefined => ledger.segments.find(row => row.segmentId === entityId)?.clipId ?? ledger.points.find(row => row.entityId === entityId)?.authoredId;
  const origin = (entityId: string) => ledger.origins.find(row => row.originId === entityId) ?? ledger.origins.find(row => row.originId === ledger.segments.find(segment => segment.segmentId === entityId || segment.clipId === (aliases.get(entityId) ?? entityId))?.originId);
  for (const claim of input.model.identities) if (claim.kind === "existing" || claim.kind === "replacement") {
    const entityId = claim.kind === "existing" ? claim.entityId : claim.replacesEntityId, value = authored(entityId);
    if (!value) refused(`Unknown identity ${entityId}. Choose an explicit identity mapping.`);
    aliases.set(claim.alias, value);
  }
  for (const allocation of [...input.allocations].sort((a, b) => Number(b.kind === "effect") - Number(a.kind === "effect"))) {
    const claim = claims.get(allocation.alias);
    if (!claim) refused(`Allocation ${allocation.alias} has no explicit identity intent.`);
    if (ledger.origins.some(row => row.originId === allocation.entityId) || ledger.segments.some(row => row.segmentId === allocation.entityId) || ledger.points.some(row => row.entityId === allocation.entityId)) refused("An identity allocation cannot reuse a prior ID.");
    if (allocation.kind === "effect") {
      if ((claim.kind !== "new-effect" && claim.kind !== "duplicate") || claim.slotId !== allocation.slotId) refused("New effects need an exact granted slot mapping.");
      let slot = ledger.slots.find(row => row.id === allocation.slotId);
      if (!slot && input.initial) { slot = { id: allocation.slotId, grantDecisionId: "initial-request" }; ledger.slots.push(slot); }
      if (!slot || slot.originId) refused(`Slot ${allocation.slotId} is not an unused authorized addition slot. Request a new slot or reuse the existing effect.`);
      const source = claim.kind === "duplicate" ? origin(claim.sourceOriginId) : undefined;
      if (claim.kind === "duplicate" && !source) refused("The duplicate source identity is missing.");
      if (source?.seed === allocation.seed) refused("A duplicate needs a distinct seed.");
      if (source && input.decisions.some(decision => decision.kind === "exclude" && effectOriginDescendsFrom(ledger, source.originId, decision.originId))) refused("An excluded effect cannot return through a duplicate slot.");
      ledger.origins.push({ originId: allocation.entityId, kind: "addition", lineageId: allocation.lineageId, seed: allocation.seed, slotId: slot.id,
        ...(source ? { derivedFromOriginId: source.originId } : {}), createdByStepId: input.stepId, tombstoned: false });
      ledger.segments.push({ segmentId: `segment:${allocation.clipId}`, clipId: allocation.clipId, originId: allocation.entityId, createdByStepId: input.stepId, tombstoned: false });
      slot.originId = allocation.entityId; aliases.set(allocation.alias, allocation.clipId);
    } else if (allocation.kind === "segment") {
      if (claim.kind !== "split") refused("A split allocation needs an exact parent segment.");
      const parent = ledger.segments.find(row => row.segmentId === claim.parentSegmentId || row.clipId === (aliases.get(claim.parentSegmentId) ?? claim.parentSegmentId));
      if (!parent || parent.tombstoned) refused("A split cannot recreate an absent segment.");
      ledger.segments.push({ segmentId: allocation.entityId, clipId: allocation.clipId, originId: parent.originId, parentSegmentId: parent.segmentId, createdByStepId: input.stepId, tombstoned: false });
      aliases.set(allocation.alias, allocation.clipId);
    } else {
      if (claim.kind !== "new-point" && claim.kind !== "new-cue") refused("A point allocation needs explicit point identity intent.");
      const owner = origin(claim.originId);
      if (!owner) refused("A new point needs an existing effect origin.");
      const deleted = input.decisions.some(decision => (decision.kind === "adjust" || decision.kind === "keep-current") && decision.changes.some(change => change.originId === owner.originId && change.scopes.some(scope => {
        if ((scope.kind !== "point" && scope.kind !== "cue") || !scope.fields.includes("presence")) return false;
        const id = ledger.points.find(row => row.entityId === scope.entityId)?.authoredId;
        return !change.after || !(scope.kind === "point" ? change.after[scope.curve].points : change.after.cueOverrides).some(point => point.id === id);
      })));
      if (deleted && (!claim.grantDecisionId || !input.decisions.some(decision => decision.id === claim.grantDecisionId && decision.kind === "identity"))) refused("A new point or cue could replace a retained manual deletion. Choose its identity explicitly.");
      const inCurve = input.model.commands.some(command => command.kind === "effect-create" ? command.effect.reactionCurve.points.some(point => point.id === allocation.alias)
        : command.kind === "effect-patch" && command.patch.reactionCurve?.points.some(point => point.id === allocation.alias));
      ledger.points.push({ entityId: allocation.entityId, authoredId: allocation.authoredId, originId: owner.originId,
        kind: allocation.kind === "cue" ? "cue" : inCurve ? "reaction-point" : "intensity-point", createdByStepId: input.stepId, tombstoned: false });
      aliases.set(allocation.alias, allocation.authoredId);
    }
  }
  const remap = (value: string) => aliases.get(value) ?? value;
  const remapPoints = (effect: EffectClip): EffectClip => ({ ...effect,
    intensityCurve: { points: effect.intensityCurve.points.map(point => ({ ...point, id: remap(point.id) })) },
    reactionCurve: { points: effect.reactionCurve.points.map(point => ({ ...point, id: remap(point.id) })) }, cueOverrides: effect.cueOverrides.map(cue => ({ ...cue, id: remap(cue.id) })),
  });
  const commands = input.model.commands.map(command => {
    if (command.kind === "effect-create") {
      const allocation = input.allocations.find(row => row.alias === command.effect.id);
      if (!allocation || allocation.kind !== "effect") refused("Creating an effect requires an unused authorized identity allocation.");
      return EffectCreativeCommandSchema.parse({ ...command, effect: remapPoints({ ...command.effect, id: allocation.clipId, lineageId: allocation.lineageId, seed: allocation.seed }) });
    }
    if (command.kind === "effect-split") {
      const allocated = input.allocations.find(row => row.alias === command.newClipId);
      if (!allocated || allocated.kind !== "segment") refused("A split needs a fresh allocated segment with an explicit parent.");
      const parent = ledger.segments.find(row => row.clipId === remap(command.clipId));
      if (ledger.segments.find(row => row.clipId === allocated.clipId)?.parentSegmentId !== parent?.segmentId) refused("A split cannot substitute another segment's ancestry.");
      return { ...command, clipId: remap(command.clipId), newClipId: allocated.clipId };
    }
    if (command.kind === "effect-duplicate") {
      const allocation = input.allocations.find(row => row.alias === command.newClipId);
      if (!allocation || allocation.kind !== "effect") refused("Duplicating an effect requires a distinct authorized slot.");
      const child = ledger.origins.find(row => row.originId === allocation.entityId), source = ledger.segments.find(row => row.clipId === remap(command.clipId));
      if (!source || child?.derivedFromOriginId !== source.originId) refused("Duplicate ancestry must name the actual source effect.");
      return { ...command, clipId: remap(command.clipId), newClipId: allocation.clipId, newLineageId: allocation.lineageId, seed: allocation.seed };
    }
    if (command.kind === "effect-patch") return { ...command, clipId: remap(command.clipId), patch: { ...command.patch,
      ...(command.patch.intensityCurve ? { intensityCurve: { points: command.patch.intensityCurve.points.map(point => ({ ...point, id: remap(point.id) })) } } : {}),
      ...(command.patch.reactionCurve ? { reactionCurve: { points: command.patch.reactionCurve.points.map(point => ({ ...point, id: remap(point.id) })) } } : {}),
      ...(command.patch.cueOverrides ? { cueOverrides: command.patch.cueOverrides.map(cue => ({ ...cue, id: remap(cue.id) })) } : {}),
    } };
    return "clipId" in command ? { ...command, clipId: remap(command.clipId) } : command;
  });
  for (const command of commands) {
    for (const field of ["clipId", "newClipId"] as const) if (field in command && !ledger.segments.some(row => row.clipId === (command as unknown as Record<string, unknown>)[field])) refused(`Unknown effect identity in ${command.kind}.`);
  }
  return { ledger: validateEffectIdentityLedger(ledger), commands };
}

/** Creation seeds are allocated by the host; Pattern is subsequently an authored protected setting. */
export function reconcileEffectIdentityLedger(ledger: EffectIdentityLedger, effects: readonly EffectClip[]): EffectIdentityLedger {
  const next = structuredClone(ledger);
  for (const effect of effects) {
    const segment = next.segments.find(row => row.clipId === effect.id), origin = next.origins.find(row => row.originId === segment?.originId);
    if (!segment || !origin || origin.lineageId !== effect.lineageId) refused("Effect identity or lineage differs from its admitted origin.");
    for (const [kind, points] of [["intensity-point", effect.intensityCurve.points], ["reaction-point", effect.reactionCurve.points], ["cue", effect.cueOverrides]] as const) for (const point of points) {
      if (!next.points.some(row => row.originId === origin.originId && row.kind === kind && row.authoredId === point.id)) refused(`Unmapped ${kind} ${point.id}. Provide a stable point identity.`);
    }
  }
  for (const segment of next.segments) segment.tombstoned = !effects.some(effect => effect.id === segment.clipId);
  for (const origin of next.origins) origin.tombstoned = !next.segments.some(segment => segment.originId === origin.originId && !segment.tombstoned);
  for (const point of next.points) point.tombstoned = !effects.some(effect => next.origins.find(origin => origin.originId === point.originId)?.lineageId === effect.lineageId &&
    (point.kind === "cue" ? effect.cueOverrides : effect[point.kind === "intensity-point" ? "intensityCurve" : "reactionCurve"].points).some(value => value.id === point.authoredId));
  return validateEffectIdentityLedger(next);
}

export function sameEffectIdentityLedger(a: EffectIdentityLedger, b: EffectIdentityLedger): boolean { return canonical(a) === canonical(b); }

/** Register only IDs introduced by authenticated creative commands, never by model output. */
export function registerEffectHumanIdentities(ledger: EffectIdentityLedger, before: ProductionTimeline, after: ProductionTimeline,
  commands: readonly EffectCreativeCommand[], stepId: string, restoredIds: readonly string[] = []): EffectIdentityLedger {
  const next = structuredClone(ledger), old = proposalEffects(before);
  for (const effect of proposalEffects(after)) {
    let segment = next.segments.find(row => row.clipId === effect.id);
    if (!segment) {
      const creator = commands.find(command => command.kind === "effect-create" ? command.effect.id === effect.id
        : (command.kind === "effect-split" || command.kind === "effect-duplicate") && command.newClipId === effect.id);
      if (!creator) refused("An authenticated edit introduced an effect without a creation command.");
      const source = "clipId" in creator ? next.segments.find(row => row.clipId === creator.clipId) : undefined;
      if (creator.kind === "effect-split") {
        if (!source) refused("The split source identity is missing.");
        segment = { segmentId: `segment:${effect.id}`, clipId: effect.id, originId: source.originId,
          parentSegmentId: source.segmentId, createdByStepId: stepId, tombstoned: false };
      } else {
        if (next.origins.some(row => row.lineageId === effect.lineageId)) refused("A human-created effect cannot reuse a prior lineage.");
        const originId = `origin:${effect.lineageId}`, slotId = `slot:${effect.lineageId}`;
        next.origins.push({ originId, kind: "addition", lineageId: effect.lineageId, seed: effect.seed, slotId,
          ...(source ? { derivedFromOriginId: source.originId } : {}), createdByStepId: stepId, tombstoned: false });
        next.slots.push({ id: slotId, originId, grantDecisionId: stepId });
        segment = { segmentId: `segment:${effect.id}`, clipId: effect.id, originId, createdByStepId: stepId, tombstoned: false };
      }
      next.segments.push(segment);
    } else if (segment.tombstoned && !old.some(row => row.id === effect.id) && !restoredIds.includes(effect.id)) refused("An edit cannot silently recycle a tombstoned segment identity.");
    for (const [kind, points] of [["intensity-point", effect.intensityCurve.points], ["reaction-point", effect.reactionCurve.points], ["cue", effect.cueOverrides]] as const)
      for (const point of points) if (!next.points.some(row => row.originId === segment.originId && row.kind === kind && row.authoredId === point.id))
        next.points.push({ entityId: `${segment.originId}:${kind}:${point.id}`, authoredId: point.id, originId: segment.originId, kind, createdByStepId: stepId, tombstoned: false });
  }
  return reconcileEffectIdentityLedger(next, proposalEffects(after));
}

/** Duplicating through the canonical command deterministically derives every child point ID. */
export function registerEffectDuplicatePoints(ledger: EffectIdentityLedger, before: ProductionTimeline, after: ProductionTimeline,
  commands: readonly EffectCreativeCommand[], stepId: string): EffectIdentityLedger {
  const next = structuredClone(ledger);
  for (const command of commands) if (command.kind === "effect-duplicate") {
    const source = proposalEffects(before).find(row => row.id === command.clipId), copy = proposalEffects(after).find(row => row.id === command.newClipId);
    const sourceSegment = next.segments.find(row => row.clipId === command.clipId), target = next.segments.find(row => row.clipId === command.newClipId);
    if (!source || !copy || !sourceSegment || !target) continue;
    for (const [kind, original, points] of [["intensity-point", source.intensityCurve.points, copy.intensityCurve.points],
      ["reaction-point", source.reactionCurve.points, copy.reactionCurve.points], ["cue", source.cueOverrides, copy.cueOverrides]] as const)
      for (const [index, point] of points.entries()) {
        const parent = next.points.find(row => row.originId === sourceSegment.originId && row.kind === kind && row.authoredId === original[index]?.id);
        if (!parent) refused("Duplicated point ancestry is missing.");
        next.points.push({ entityId: `${target.originId}:${kind}:${point.id}`, authoredId: point.id, originId: target.originId, kind,
          parentEntityId: parent.entityId, createdByStepId: stepId, tombstoned: false });
      }
  }
  return next;
}
