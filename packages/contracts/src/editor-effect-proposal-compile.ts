import { effectAnalysisCanonicalJson as canonical } from "./editor-effect-analysis.js";
import { EffectProtectionRefused, checkEffectProtection, type EffectProtectionRule } from "./editor-effect-protection.js";
import type { EffectClip } from "./editor-effects.js";
import { compileTrustedTimelineSteps, finishTrustedTimelineSteps, type ProductionTimeline, type TrustedTimelineStep,
  type TrustedTimelineReduction, type TrustedTimelineFinishOptions } from "./timeline.js";
import { AuthenticatedEffectHumanActionSchema, ModelEffectProposalSchema, EffectAuthoredStateSchema,
  type AuthenticatedEffectHumanAction, type EffectIdentityAllocation, type EffectIdentityLedger, type EffectProposalFamily,
  type EffectProposalVersion, type EffectProposalStep, type EffectHumanDecision, type EffectCreativeCommand,
  type EffectProposalConflict, type EffectFinalDelta, type EffectProposalDependencies, type EffectStickyChange,
  type EffectStickyScope, type ModelEffectProposal, type EffectAuthoredState, type EffectRequestedHumanAction } from "./editor-effect-proposal.js";
import { admitEffectModelIdentity, EffectProposalIdentityRefused, seedEffectIdentityLedger, proposalEffects,
  reconcileEffectIdentityLedger, registerEffectHumanIdentities, registerEffectDuplicatePoints, validateEffectIdentityLedger,
  effectOriginDescendsFrom } from "./editor-effect-proposal-identity.js";
import { activeEffectStickyChanges, captureEffectStickyChanges, effectValueAt, preserveEffectStickyCommands, restoreEffectCommands } from "./editor-effect-proposal-sticky.js";
import { effectProposalScopeProblem } from "./editor-effect-proposal-scope.js";

type CandidateFields = Pick<EffectProposalVersion, "state" | "delta" | "stepIds" | "decisionIds" | "decisionRevision" | "conflicts" | "requestedActions">;
export interface EffectCandidateDraft extends CandidateFields {}
declare const compiledBrand: unique symbol;
export interface CompiledEffectCandidate extends EffectCandidateDraft { readonly [compiledBrand]: true }
interface Evidence { base: string; familyId: string; scope: EffectProposalFamily["scope"]; steps: EffectProposalStep[];
  decisions: EffectHumanDecision[]; reduction?: TrustedTimelineReduction; timeline: ProductionTimeline }
const evidence = new WeakMap<object, Evidence>();
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export type EffectProposalCompilation = { draft: EffectCandidateDraft; ledger: EffectIdentityLedger; decisions: EffectHumanDecision[];
  step: EffectProposalStep; requestedActions: EffectRequestedHumanAction[] } &
  ({ ok: true; compiled: CompiledEffectCandidate; conflicts: [] } | { ok: false; conflicts: EffectProposalConflict[] });
interface Stamp { stepId: string; versionId: string; branchId: string; at: string }
const equal = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
const authored = ({ history: _history, ...rest }: ProductionTimeline) => rest;
const ruleScope = ({ baselineFingerprint: _fingerprint, baselineRevision: _revision, ...scope }: EffectProtectionRule) => canonical(scope);
const ruleBaseline = (rule: EffectProtectionRule | undefined) => rule ? { fingerprint: rule.baselineFingerprint, revision: rule.baselineRevision } : null;
const snapshot = (timeline: ProductionTimeline): EffectAuthoredState => EffectAuthoredStateSchema.parse({ tracks: timeline.tracks.filter(track => track.kind === "effect")
  .map(track => ({ id: track.id, name: track.name, order: track.order, muted: track.muted, effects: track.effects ?? [] })), protection: timeline.effectProtection ?? [] });

function failure(error: unknown, stepId?: string): EffectProposalConflict {
  const message = error instanceof Error ? error.message : String(error);
  const kind: EffectProposalConflict["kind"] = error instanceof EffectProtectionRefused || /protect|release/i.test(message) ? "protection" : error instanceof EffectProposalIdentityRefused ? "identity"
    : /scope|outside|passage|target|palette|audio source|effects-only|Reaction is Off/i.test(message) ? "scope"
      : /manual|retained|adjusted|sticky|excluded/i.test(message) ? "sticky" : /limit|budget|50|8000/i.test(message) ? "bounds" : /Current changed|baseline|stale/i.test(message) ? "stale" : "invalid";
  return { id: `conflict:${stepId ?? "candidate"}`, kind, reason: message.slice(0, 1000), ...(stepId ? { stepId } : {}),
    remedies: kind === "protection" ? ["Keep current", "Adjust proposal", "Release the named protection explicitly"]
      : kind === "identity" || kind === "sticky" ? ["Keep current", "Choose an explicit identity or revision permission"] : ["Adjust the proposal", "Update from Current"] };
}
function requireBase(base: ProductionTimeline, family: EffectProposalFamily, baseId: string): void {
  const frozen = family.bases.find(row => row.id === baseId);
  if (!frozen || frozen.revision !== base.revision || !equal(frozen.authored, authored(base))) throw new Error("Current changed. Update the proposal before continuing.");
}
function selected(family: EffectProposalFamily, id: string): EffectProposalVersion {
  const version = family.versions.find(row => row.id === id); if (!version) throw new Error("The retained candidate version is missing."); return version;
}
function ancestry(family: EffectProposalFamily, id?: string): Set<string> {
  const result = new Set<string>();
  while (id) { if (result.has(id)) throw new Error("Candidate ancestry cannot cycle."); result.add(id); id = selected(family, id).parentVersionId; }
  return result;
}
function stepsFor(family: EffectProposalFamily, ids: readonly string[]): EffectProposalStep[] {
  return ids.map(id => { const step = family.steps.find(row => row.id === id); if (!step) throw new Error("Candidate replay step is missing."); return structuredClone(step); });
}
function decisionsFor(family: EffectProposalFamily, ids: readonly string[]): EffectHumanDecision[] {
  return ids.map(id => { const decision = family.decisions.find(row => row.id === id); if (!decision) throw new Error("Candidate human decision is missing."); return structuredClone(decision); });
}
function inheritDecisions(family: EffectProposalFamily, parent: EffectProposalVersion | undefined): { steps: EffectProposalStep[]; decisions: EffectHumanDecision[] } {
  const steps = stepsFor(family, parent?.stepIds ?? []), ancestors = ancestry(family, parent?.id);
  const decisions = decisionsFor(family, family.activeDecisionIds).filter(decision => decision.kind !== "release" || ancestors.has(decision.versionId));
  for (const decision of decisions) if (!steps.some(step => step.kind === "human" && step.decisionIds.includes(decision.id))) {
    const step = family.steps.find(row => row.kind === "human" && row.decisionIds.includes(decision.id));
    if (!step) throw new Error("The retained human decision has no authenticated replay step.");
    if (!steps.some(row => row.id === step.id)) steps.push(structuredClone(step));
  }
  return { steps, decisions };
}
function mergeLedger(retained: EffectIdentityLedger, active: EffectIdentityLedger): EffectIdentityLedger {
  const next = structuredClone(active);
  for (const field of ["origins", "segments", "points", "slots"] as const) {
    const key = field === "origins" ? "originId" : field === "segments" ? "segmentId" : field === "points" ? "entityId" : "id";
    const rows = next[field] as unknown as Array<Record<string, unknown>>;
    for (const row of retained[field]) if (!rows.some(item => item[key] === (row as unknown as Record<string, unknown>)[key]))
      rows.push({ ...structuredClone(row), ...(field === "slots" ? {} : { tombstoned: true }) });
  }
  return validateEffectIdentityLedger(next);
}
function grantSlots(ledger: EffectIdentityLedger, decisions: readonly EffectHumanDecision[]): EffectIdentityLedger {
  const next = structuredClone(ledger);
  for (const decision of decisions) if (decision.kind === "identity" && decision.intent.kind === "grant-new-slot")
    for (let index = 0; index < decision.intent.count; index++) {
      const id = `slot:${decision.id}:${index}`;
      if (!next.slots.some(slot => slot.id === id)) next.slots.push({ id, grantDecisionId: decision.id });
    }
  return validateEffectIdentityLedger(next);
}

/** The normalized final result is display/count material, never an executable human patch. */
function finalDelta(base: ProductionTimeline, timeline: ProductionTimeline, trace: readonly TrustedTimelineStep[], decisions: readonly EffectHumanDecision[]): EffectFinalDelta[] {
  const before = snapshot(base), after = snapshot(timeline), result: EffectFinalDelta[] = [];
  const provenance = (clipId?: string, trackId?: string) => trace.filter(step => step.commands.some(command =>
    "clipId" in command && command.clipId === clipId || "newClipId" in command && command.newClipId === clipId ||
    command.kind === "effect-create" && command.effect.id === clipId || "trackId" in command && command.trackId === trackId))
    .map(step => ({ stepId: step.id, authority: step.authority, paths: step.commands.flatMap(command => command.kind === "effect-patch"
      ? Object.keys(command.patch) : [command.kind]) }));
  for (const trackId of new Set([...before.tracks, ...after.tracks].map(track => track.id))) {
    const left = before.tracks.find(track => track.id === trackId), right = after.tracks.find(track => track.id === trackId);
    const header = (track: typeof left) => track ? { id: track.id, name: track.name, order: track.order, muted: track.muted } : null;
    if (!equal(header(left), header(right))) result.push({ kind: "effect-track-result", trackId, before: header(left), after: header(right), provenance: provenance(undefined, trackId) });
    for (const clipId of new Set([...(left?.effects ?? []), ...(right?.effects ?? [])].map(effect => effect.id))) {
      const old = left?.effects.find(effect => effect.id === clipId) ?? null, next = right?.effects.find(effect => effect.id === clipId) ?? null;
      if (!equal(old, next)) result.push({ kind: "effect-result", trackId, before: old, after: next, provenance: provenance(clipId, trackId) });
    }
  }
  for (const rule of after.protection) if (!before.protection.some(row => row.id === rule.id)) {
    const decision = [...decisions].reverse().find(row => row.kind === "protect" && row.rule.id === rule.id);
    const copiedByHuman = trace.some(step => step.authority === "human" && step.commands.some(command => command.kind === "effect-duplicate" && command.newLineageId === rule.lineageId));
    if (!decision && !copiedByHuman) throw new Error("A new protection rule has no authenticated decision.");
    if (decision) result.push({ kind: "protect-result", ruleId: rule.id, after: rule, decisionId: decision.id });
  }
  for (const rule of before.protection) if (!after.protection.some(row => row.id === rule.id)) {
    const decision = [...decisions].reverse().find(row => row.kind === "release" && row.release.ruleId === rule.id);
    // Explicit human removal retires its lineage rules through the ordinary compiler.
    if (!decision && proposalEffects(timeline).some(effect => effect.lineageId === rule.lineageId)) throw new Error("A protection disappeared without an authenticated Release.");
    if (decision) result.push({ kind: "release-result", ruleId: rule.id, before: rule, decisionId: decision.id });
  }
  if (result.length > 50) throw new Error(`The complete arrangement contains ${result.length} final changes; the limit is 50. No prefix can be applied.`);
  return result;
}

function assertEffectTrackCommands(timeline: ProductionTimeline, commands: readonly EffectCreativeCommand[]): void {
  const known = new Set(timeline.tracks.filter(track => track.kind === "effect").map(track => track.id as string));
  for (const command of commands) {
    if (command.kind === "add-track") known.add(command.trackId);
    else if ((command.kind === "set-track" || command.kind === "remove-track" || command.kind === "effect-create") && !known.has(command.trackId))
      throw new Error("An effects-only command cannot address a picture, sound or subtitle track.");
  }
}
function verifyRelease(decision: Extract<EffectHumanDecision, { kind: "release" }>, base: ProductionTimeline, current: ProductionTimeline,
  family: EffectProposalFamily, allowedAncestors: Set<string>, decisions: readonly EffectHumanDecision[]): void {
  const release = decision.release, rule = current.effectProtection?.find(row => row.id === release.ruleId);
  if (release.familyId !== family.id || !allowedAncestors.has(release.authorizingVersionId)) throw new Error("This Release was authorized on another candidate ancestry.");
  if (!equal(ruleBaseline(base.effectProtection?.find(row => row.id === release.ruleId)), release.currentRule)) throw new Error("The Current protection baseline changed. Authorize a new scoped Release.");
  if (!rule || ruleScope(rule) !== release.scopeFingerprint || !equal(ruleBaseline(rule), release.authorizingRule)) throw new Error("The candidate's protected scope or baseline changed. Authorize Release again.");
  for (const later of decisions.slice(decisions.findIndex(row => row.id === decision.id) + 1)) if (later.kind === "adjust" || later.kind === "keep-current")
    for (const change of later.changes) if ((change.before?.lineageId ?? change.after?.lineageId) === rule.lineageId &&
      checkEffectProtection(change.before ? [change.before] : [], change.after ? [change.after] : [], [rule]).length)
      throw new Error("A later manual edit changed the released scope. Authorize a new Release even if the value was subsequently restored.");
}

interface ReplayInput { base: ProductionTimeline; family: EffectProposalFamily; steps: EffectProposalStep[]; decisions: EffectHumanDecision[];
  decisionRevision: number; ancestorIds: Set<string>; lastStep: EffectProposalStep; checkAdmissions?: boolean }
function rebaseConflict(input: ReplayInput): EffectProposalConflict | null {
  const step = [...input.steps].reverse().find(row => row.kind === "rebase"); if (!step) return null;
  const ancestor = selected(input.family, step.ancestorVersionId), old = input.family.bases.find(row => row.id === ancestor.baseId);
  if (!old) return failure(new Error("The previous immutable Current base is missing."), step.id);
  const oldEffects = old.authored.tracks.flatMap(track => track.effects ?? []), currentEffects = proposalEffects(input.base);
  for (const change of activeEffectStickyChanges(input.decisions)) {
    // A fresh explicit adjustment after Update is a new human decision against this Current.
    if (!ancestor.decisionIds.includes(change.decisionId)) continue;
    const segment = input.family.identities.segments.find(row => row.segmentId === change.segmentId); if (!segment) continue;
    const previous = oldEffects.find(row => row.id === segment.clipId), current = currentEffects.find(row => row.id === segment.clipId);
    if (!previous && !current) continue;
    const touched = !previous || !current || change.scopes.some(scope => !equal(desiredScope(current, previous, scope, input.family.identities), current));
    if (touched) return failure(new Error("Current changed a retained manual scope. Choose Keep current or adjust the pending proposal explicitly."), step.id);
  }
  return null;
}
function replay(input: ReplayInput): EffectProposalCompilation {
  let ledger = grantSlots(seedEffectIdentityLedger(input.base), input.decisions);
  let current: ProductionTimeline = { ...structuredClone(input.base), history: { undo: [], redo: [] } };
  let reduction: TrustedTimelineReduction | undefined;
  const trace: TrustedTimelineStep[] = [], conflicts: EffectProposalConflict[] = [], completed: EffectHumanDecision[] = [];
  const stale = rebaseConflict(input); if (stale) conflicts.push(stale);
  for (const step of input.steps) {
    if (conflicts.length) break;
    try {
      if (step.kind === "rebase" || step.kind === "dependency") continue;
      let commands: TrustedTimelineStep["commands"], nextLedger = ledger;
      if (step.kind === "model") {
        for (const claim of step.model.identities) if (claim.kind === "duplicate") {
          const source = ledger.origins.find(row => row.originId === claim.sourceOriginId);
          if (source && activeEffectStickyChanges(completed).some(change => effectOriginDescendsFrom(ledger, source.originId, change.originId)))
            throw new EffectProposalIdentityRefused("A new duplicate cannot bypass retained manual adjustments. Explicitly permit the named scope first.");
        }
        const admitted = admitEffectModelIdentity({ ledger, model: step.model, allocations: step.allocations, decisions: input.decisions,
          stepId: step.id, initial: !input.steps.slice(0, input.steps.indexOf(step)).some(row => row.kind === "model") });
        commands = preserveEffectStickyCommands(current, admitted.commands, admitted.ledger, completed);
        nextLedger = admitted.ledger;
        // A stored creative payload is not authority: always derive it from the model DTO and host allocations.
        if (input.checkAdmissions && !equal(commands, step.admittedCommands)) throw new Error("The immutable model admission changed; prepare a fresh candidate.");
        step.admittedCommands = structuredClone(commands) as EffectCreativeCommand[];
      } else {
        const owned = input.decisions.filter(decision => step.decisionIds.includes(decision.id));
        if (owned.length !== step.decisionIds.length || owned.some(decision => decision.actionId !== step.action.id)) throw new Error("An authenticated step is missing its exact human decisions.");
        commands = step.admittedCommands;
        if (step.action.intent.kind === "adjust" && !equal(commands, step.action.intent.commands)) throw new Error("A human adjustment cannot authorize additional model commands.");
        if (step.action.intent.kind === "protect" && !equal(commands, [{ kind: "effect-protect", rule: step.action.intent.rule }])) throw new Error("Protection intent differs from its authenticated command.");
        if (step.action.intent.kind === "release") {
          const decision = owned.find(row => row.kind === "release");
          if (!decision || decision.kind !== "release" || !equal(commands, [{ kind: "effect-release", ruleId: step.action.intent.ruleId }])) throw new Error("Release intent differs from its authenticated command.");
          verifyRelease(decision, input.base, current, input.family, input.ancestorIds, input.decisions);
        }
        if (step.action.intent.kind === "adjust" || step.action.intent.kind === "keep-current") {
          const changes = owned.flatMap(decision => decision.kind === "adjust" || decision.kind === "keep-current" ? decision.changes : []);
          if (!changes.length) throw new Error("An adjustment needs exact retained value scopes.");
          const effects = proposalEffects(current);
          // Absolute captured intent survives a compatible fork; replaying a relative trim twice would not.
          if (changes.some(change => !equal(change.before, effects.find(effect => ledger.segments.find(segment => segment.segmentId === change.segmentId)?.clipId === effect.id) ?? null))) {
            const restored: EffectCreativeCommand[] = [];
            for (const change of changes) {
              const segment = ledger.segments.find(row => row.segmentId === change.segmentId), effect = effects.find(row => row.id === segment?.clipId);
              if (!effect || !change.after || !change.before) throw new EffectProposalIdentityRefused("This structural manual adjustment needs an explicit identity decision on the new branch.");
              let desired = effect;
              for (const scope of change.scopes) desired = desiredScope(desired, change.after, scope, ledger);
              restored.push(...restoreEffectCommands(effect, desired));
            }
            commands = restored;
          }
        }
        if (step.action.intent.kind === "exclude") {
          const originId = step.action.intent.originId;
          commands = proposalEffects(current).filter(effect => {
            const segment = ledger.segments.find(row => row.clipId === effect.id); return segment && effectOriginDescendsFrom(ledger, segment.originId, originId);
          }).map(effect => ({ kind: "effect-remove" as const, clipId: effect.id }));
          const removed = new Set(commands.flatMap(command => "clipId" in command ? [command.clipId] : []));
          commands = [...commands, ...current.tracks.filter(track => track.kind === "effect" && !input.base.tracks.some(row => row.id === track.id) &&
            (track.effects ?? []).every(effect => removed.has(effect.id))).map(track => ({ kind: "remove-track" as const, trackId: track.id }))];
        }
      }
      assertEffectTrackCommands(current, commands.filter((command): command is EffectCreativeCommand => command.kind !== "effect-protect" && command.kind !== "effect-release") as EffectCreativeCommand[]);
      const nextTrace = [...trace, { id: step.id, authority: step.kind === "model" ? "suggestion" as const : "human" as const, commands }];
      const nextReduction = compileTrustedTimelineSteps(input.base, nextTrace), next = nextReduction.timeline;
      if (step.kind === "model") nextLedger = reconcileEffectIdentityLedger(registerEffectDuplicatePoints(nextLedger, current, next, commands as EffectCreativeCommand[], step.id), proposalEffects(next));
      else {
        const restored = step.action.intent.kind === "keep-current" ? input.decisions.filter(decision => step.decisionIds.includes(decision.id))
          .flatMap(decision => decision.kind === "keep-current" ? decision.changes.flatMap(change => change.after ? [change.after.id] : []) : []) : [];
        nextLedger = registerEffectHumanIdentities(nextLedger, current, next, commands.filter(command => command.kind !== "effect-protect" && command.kind !== "effect-release") as EffectCreativeCommand[], step.id, restored);
        completed.push(...input.decisions.filter(decision => step.decisionIds.includes(decision.id)));
      }
      if (step.kind === "model") {
        const scopeProblem = effectProposalScopeProblem(current, next, input.family.scope, { decisions: completed, ledger: nextLedger }); if (scopeProblem) throw new Error(scopeProblem);
      }
      trace.push(nextTrace.at(-1)!); ledger = nextLedger; current = next; reduction = nextReduction;
    } catch (error) { conflicts.push(failure(error, step.id)); break; }
  }
  // Decisions from another branch never silently grant human authority to this model lineage.
  const missing = input.decisions.filter(decision => !completed.some(row => row.id === decision.id));
  if (!conflicts.length && missing.length) conflicts.push(failure(new Error("Retained human decisions belong to another pending branch. Update from that adjusted version or resolve the identity explicitly.")));
  let delta: EffectFinalDelta[] = [];
  try { delta = finalDelta(input.base, current, trace, completed); } catch (error) { conflicts.push(failure(error)); }
  const requestedActions = [...input.steps].reverse().find(step => step.kind === "model")?.model.requestedActions ?? [];
  const draft: EffectCandidateDraft = { state: snapshot(current), delta, requestedActions, stepIds: input.steps.map(step => step.id), decisionIds: input.decisions.map(decision => decision.id),
    decisionRevision: input.decisionRevision, conflicts };
  const material: Evidence = { base: canonical(authored(input.base)), familyId: input.family.id, scope: structuredClone(input.family.scope),
    steps: structuredClone(input.steps), decisions: structuredClone(input.decisions), timeline: current, ...(reduction && !conflicts.length ? { reduction } : {}) };
  evidence.set(freeze(draft), material);
  const result = { draft, ledger: mergeLedger(input.family.identities, ledger), decisions: input.decisions,
    step: input.steps.find(step => step.id === input.lastStep.id) ?? input.lastStep,
    requestedActions };
  return conflicts.length ? { ...result, ok: false, conflicts } : { ...result, ok: true, compiled: draft as CompiledEffectCandidate, conflicts: [] };
}

export function effectCandidateTimeline(base: ProductionTimeline, candidate: EffectCandidateDraft | CompiledEffectCandidate): ProductionTimeline {
  const proof = evidence.get(candidate);
  if (!proof || proof.base !== canonical(authored(base))) throw new Error("The candidate has no matching compiler evidence.");
  return structuredClone(proof.timeline);
}
export function effectCandidateContentMaterial(candidate: EffectCandidateDraft | CompiledEffectCandidate): string {
  const proof = evidence.get(candidate); if (!proof) throw new Error("Compile this exact candidate before hashing it.");
  return canonical({ familyId: proof.familyId, scope: proof.scope, base: proof.base, steps: proof.steps, decisions: proof.decisions, candidate });
}
export function effectCandidateFingerprintMaterial(candidate: EffectCandidateDraft | CompiledEffectCandidate, dependencies: EffectProposalDependencies): string {
  return canonical({ content: effectCandidateContentMaterial(candidate), dependencies });
}
export function finalizeEffectProposal(base: ProductionTimeline, candidate: CompiledEffectCandidate, options: TrustedTimelineFinishOptions) {
  const proof = evidence.get(candidate);
  if (!proof?.reduction || candidate.conflicts.length || proof.base !== canonical(authored(base))) throw new Error("Only a successfully replayed exact candidate can be finalized.");
  if (options.requestId !== proof.familyId) throw new Error("Effect history must retain its stable family receipt identity.");
  return finishTrustedTimelineSteps(base, proof.reduction, options);
}

export function compileEffectModelRevision(input: { base: ProductionTimeline; family: EffectProposalFamily; parentVersionId?: string;
  model: ModelEffectProposal; allocations: EffectIdentityAllocation[]; stamp: Stamp }): EffectProposalCompilation {
  const model = ModelEffectProposalSchema.parse(input.model), parent = input.parentVersionId ? selected(input.family, input.parentVersionId) : undefined;
  requireBase(input.base, input.family, parent?.baseId ?? input.family.bases[0]!.id);
  if (input.family.status !== "pending") throw new Error("This proposal family is no longer pending.");
  if (parent ? !model.family || model.family.id !== input.family.id || model.family.parentVersionId !== parent.id || model.family.candidateHash !== parent.candidateHash : model.family !== undefined)
    throw new Error("The model revision does not name its exact retained parent.");
  const step: EffectProposalStep = { id: input.stamp.stepId, kind: "model", ...(parent ? { parentVersionId: parent.id } : {}), model, allocations: input.allocations, admittedCommands: [] };
  const inherited = inheritDecisions(input.family, parent);
  if (parent?.conflicts.length) {
    const blocked = inherited.steps.findIndex(row => row.kind === "model" && parent.conflicts.some(conflict => conflict.stepId === row.id));
    // A revised model segment replaces failed creative intent; the old immutable card still retains it.
    // Authenticated decisions are never discarded as a way to repair model output.
    if (blocked >= 0) inherited.steps = inherited.steps.filter((row, index) => index < blocked || row.kind !== "model");
  }
  return replay({ ...input, steps: [...inherited.steps, step], decisions: inherited.decisions,
    decisionRevision: input.family.decisionRevision, ancestorIds: ancestry(input.family, parent?.id), lastStep: step });
}

export function replayEffectProposal(input: { base: ProductionTimeline; family: EffectProposalFamily; versionId: string }): EffectProposalCompilation {
  const version = selected(input.family, input.versionId); requireBase(input.base, input.family, version.baseId);
  const steps = stepsFor(input.family, version.stepIds);
  if (!steps.length) throw new Error("A candidate needs a retained replay step.");
  return replay({ ...input, steps, decisions: decisionsFor(input.family, version.decisionIds), decisionRevision: version.decisionRevision,
    ancestorIds: ancestry(input.family, version.id), lastStep: steps.at(-1)!, checkAdmissions: true });
}

function put(object: object, path: string, value: unknown): void {
  const keys = path.split("."); let owner = object as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) { owner[key] ??= {}; owner = owner[key] as Record<string, unknown>; }
  if (value === undefined) delete owner[keys.at(-1)!]; else owner[keys.at(-1)!] = structuredClone(value);
}
function desiredScope(current: EffectClip, baseline: EffectClip, scope: EffectStickyScope, ledger: EffectIdentityLedger): EffectClip {
  if (scope.kind === "whole-effect" || scope.kind === "presence") return structuredClone(baseline);
  const next = structuredClone(current);
  if (scope.kind === "property") put(next, scope.property, effectValueAt(baseline, scope.property));
  else if (scope.kind === "placement") for (const field of scope.fields) {
    if (field === "outer-start") { const end = next.startFrame + next.durationFrames; next.startFrame = baseline.startFrame; next.durationFrames = end - next.startFrame; }
    if (field === "outer-end") next.durationFrames = baseline.startFrame + baseline.durationFrames - next.startFrame;
    if (field === "simulation-origin") next.simulationOriginFrame = baseline.simulationOriginFrame;
    if (field === "fade-start") next.fades.startFrame = baseline.fades.startFrame;
    if (field === "fade-end") next.fades.endFrame = baseline.fades.endFrame;
    if (field === "order") next.order = baseline.order;
  } else {
    const point = ledger.points.find(row => row.entityId === scope.entityId); if (!point) throw new EffectProposalIdentityRefused("The selected point identity is missing.");
    const values = scope.kind === "point" ? next[scope.curve].points : next.cueOverrides;
    const oldValues = scope.kind === "point" ? baseline[scope.curve].points : baseline.cueOverrides;
    const old = oldValues.find(row => row.id === point.authoredId), value = values.find(row => row.id === point.authoredId);
    if (scope.fields.includes("presence")) {
      const rows = [...values.filter(row => row.id !== point.authoredId), ...(old ? [structuredClone(old)] : [])];
      if (scope.kind === "point") next[scope.curve].points = (rows as EffectClip["intensityCurve"]["points"]).sort((a, b) => a.offsetFrames - b.offsetFrames);
      else next.cueOverrides = rows as EffectClip["cueOverrides"];
    } else {
      if (!old || !value) throw new EffectProposalIdentityRefused("Keep current needs the same retained point identity.");
      for (const field of scope.fields) if (field !== "presence") put(value, field, (old as unknown as Record<string, unknown>)[field]);
    }
  }
  return next;
}

export function compileEffectHumanAdjustment(input: { base: ProductionTimeline; family: EffectProposalFamily; fromVersionId: string;
  action: AuthenticatedEffectHumanAction; allocations?: EffectIdentityAllocation[]; stamp: Stamp }): EffectProposalCompilation {
  const action = AuthenticatedEffectHumanActionSchema.parse(input.action), parent = selected(input.family, input.fromVersionId);
  if (action.ref.familyId !== input.family.id || action.ref.versionId !== parent.id || action.ref.candidateHash !== parent.candidateHash || action.ref.decisionRevision !== input.family.decisionRevision)
    throw new Error("The authenticated action does not name the exact current review decision revision.");
  const previous = replayEffectProposal({ ...input, versionId: parent.id }), current = effectCandidateTimeline(input.base, previous.draft), intent = action.intent;
  const decisionBase = { id: `decision:${action.id}`, actionId: action.id, at: action.at, branchId: input.stamp.branchId, versionId: input.stamp.versionId };
  let commands: Extract<EffectProposalStep, { kind: "human" }>["admittedCommands"] = [], decision: EffectHumanDecision;
  let ledger = previous.ledger;
  if (intent.kind === "adjust") {
    commands = intent.commands;
    assertEffectTrackCommands(current, intent.commands);
    const reduction = compileTrustedTimelineSteps(current, [{ id: input.stamp.stepId, authority: "human", commands }]);
    ledger = registerEffectHumanIdentities(ledger, current, reduction.timeline, intent.commands, input.stamp.stepId);
    const changes = captureEffectStickyChanges(current, reduction.timeline, ledger);
    if (!changes.length) throw new Error("This adjustment changes no effect values.");
    decision = { ...decisionBase, kind: "adjust", changes };
  } else if (intent.kind === "protect") {
    commands = [{ kind: "effect-protect", rule: intent.rule }]; decision = { ...decisionBase, kind: "protect", rule: intent.rule };
  } else if (intent.kind === "release") {
    const rule = current.effectProtection?.find(row => row.id === intent.ruleId); if (!rule) throw new Error("This exact candidate has no such protection to Release.");
    decision = { ...decisionBase, kind: "release", release: { id: `release:${action.id}`, actionId: action.id, at: action.at, familyId: input.family.id,
      branchId: input.stamp.branchId, authorizingVersionId: parent.id, ruleId: rule.id, scopeFingerprint: ruleScope(rule),
      currentRule: ruleBaseline(input.base.effectProtection?.find(row => row.id === rule.id)), authorizingRule: ruleBaseline(rule)! } };
    commands = [{ kind: "effect-release", ruleId: rule.id }];
  } else if (intent.kind === "exclude") {
    const origin = ledger.origins.find(row => row.originId === intent.originId);
    if (!origin || origin.kind !== "addition") throw new Error("Exclude applies only to this family's proposed additions; use Keep current for Current effects.");
    commands = proposalEffects(current).filter(effect => {
      const segment = ledger.segments.find(row => row.clipId === effect.id); return segment && effectOriginDescendsFrom(ledger, segment.originId, origin.originId);
    }).map(effect => ({ kind: "effect-remove", clipId: effect.id }));
    decision = { ...decisionBase, kind: "exclude", originId: origin.originId };
  } else if (intent.kind === "keep-current") {
    const segment = ledger.segments.find(row => row.segmentId === intent.entityId || row.clipId === intent.entityId), origin = ledger.origins.find(row => row.originId === segment?.originId);
    if (!segment || !origin || origin.kind !== "current") throw new EffectProposalIdentityRefused("Keep current requires an existing Current effect identity.");
    const baseline = proposalEffects(input.base).find(row => row.id === segment.clipId), effect = proposalEffects(current).find(row => row.id === segment.clipId);
    if (!baseline) throw new EffectProposalIdentityRefused("The selected Current segment is split or absent. Choose its identity explicitly.");
    if (!effect && intent.scope.kind !== "whole-effect" && intent.scope.kind !== "presence") throw new EffectProposalIdentityRefused("Restore the absent Current effect before choosing a property.");
    const desired = effect ? desiredScope(effect, baseline, intent.scope, ledger) : structuredClone(baseline);
    if (effect) commands = restoreEffectCommands(effect, desired);
    else {
      const track = input.base.tracks.find(row => row.effects?.some(value => value.id === baseline.id))!;
      if (!current.tracks.some(row => row.id === track.id)) commands.push({ kind: "add-track", trackId: track.id, trackKind: "effect", name: track.name, order: track.order });
      commands.push({ kind: "effect-create", trackId: track.id, effect: desired });
    }
    const change: EffectStickyChange = { originId: origin.originId, segmentId: segment.segmentId, scopes: [intent.scope], before: effect ?? null, after: desired };
    decision = { ...decisionBase, kind: "keep-current", changes: [change], baseValueFingerprint: canonical({ scope: intent.scope, baseline }) };
  } else if (intent.kind === "permit-revision") {
    if (intent.adjustmentIds.some(id => !input.family.activeDecisionIds.includes(id))) throw new Error("Revision permission must name active retained adjustments.");
    decision = { ...decisionBase, kind: "permit-revision", adjustmentIds: intent.adjustmentIds, scopes: intent.scopes };
  } else {
    if (intent.kind === "grant-new-slot" && (!equal(intent.target, input.family.scope.target) || !equal(intent.range, input.family.scope.range))) throw new Error("New slots must use this family's exact target and passage.");
    if (intent.kind === "resolve-identity" && !parent.conflicts.some(conflict => conflict.id === intent.conflictId && (conflict.kind === "identity" || conflict.kind === "sticky"))) throw new Error("Resolve the exact retained identity conflict.");
    decision = { ...decisionBase, kind: "identity", intent };
  }
  const step: EffectProposalStep = { id: input.stamp.stepId, kind: "human", action, admittedCommands: commands, decisionIds: [decision.id], allocations: input.allocations ?? [] };
  const inherited = inheritDecisions(input.family, parent);
  let steps = inherited.steps, decisions = inherited.decisions;
  const failedIndex = steps.findIndex(row => parent.conflicts.some(conflict => conflict.stepId === row.id));
  if (intent.kind === "release") {
    const superseded = new Set(decisions.filter(row => row.kind === "release" && row.release.ruleId === intent.ruleId).map(row => row.id));
    decisions = decisions.filter(row => !superseded.has(row.id));
    steps = steps.filter(row => row.kind !== "human" || !row.decisionIds.some(id => superseded.has(id)));
  }
  // A scoped Release must precede the blocked suggestion it authorizes, never grant that suggestion human authority.
  if (failedIndex >= 0 && intent.kind === "release") steps.splice(failedIndex, 0, step); else steps.push(step);
  decisions = [...decisions, decision];
  return replay({ ...input, family: { ...input.family, identities: ledger }, steps, decisions, decisionRevision: input.family.decisionRevision + 1,
    ancestorIds: ancestry(input.family, parent.id), lastStep: step });
}

export function compileEffectPendingHistory(input: { base: ProductionTimeline; family: EffectProposalFamily; fromVersionId: string; direction: "undo" | "redo";
  stamp: { versionId: string; stepId: string; at: string } }): EffectProposalCompilation {
  const parent = selected(input.family, input.fromVersionId), branch = input.family.branches.find(row => row.id === parent.branchId);
  if (!branch || branch.headVersionId !== parent.id) throw new Error("Pending Undo and Redo operate on the exact inspected branch head.");
  const targetId = (input.direction === "undo" ? branch.undoVersionIds : branch.redoVersionIds).at(-1);
  if (!targetId) throw new Error(`There is no pending ${input.direction} step.`);
  const target = selected(input.family, targetId); requireBase(input.base, input.family, target.baseId);
  const step: EffectProposalStep = { id: input.stamp.stepId, kind: "dependency", basisVersionId: target.id };
  return replay({ ...input, steps: [...stepsFor(input.family, target.stepIds), step], decisions: decisionsFor(input.family, target.decisionIds),
    decisionRevision: input.family.decisionRevision + 1, ancestorIds: ancestry(input.family, target.id), lastStep: step });
}
export function compileEffectDependencyRevision(input: { base: ProductionTimeline; family: EffectProposalFamily; fromVersionId: string;
  stamp: { versionId: string; stepId: string; at: string } }): EffectProposalCompilation {
  const parent = selected(input.family, input.fromVersionId); requireBase(input.base, input.family, parent.baseId);
  const step: EffectProposalStep = { id: input.stamp.stepId, kind: "dependency", basisVersionId: parent.id };
  return replay({ ...input, steps: [...stepsFor(input.family, parent.stepIds), step], decisions: decisionsFor(input.family, input.family.activeDecisionIds),
    decisionRevision: input.family.decisionRevision, ancestorIds: ancestry(input.family, parent.id), lastStep: step });
}

/** Update replays proven provenance onto Current, refusing changed touched identities/scopes. */
export function rebaseEffectProposal(input: { base: ProductionTimeline; family: EffectProposalFamily; fromVersionId: string; newBaseId: string;
  stamp: { versionId: string; stepId: string; at: string } }): EffectProposalCompilation {
  const parent = selected(input.family, input.fromVersionId); requireBase(input.base, input.family, input.newBaseId);
  const old = input.family.bases.find(row => row.id === parent.baseId); if (!old) throw new Error("The previous immutable Current base is missing.");
  const step: EffectProposalStep = { id: input.stamp.stepId, kind: "rebase", ancestorVersionId: parent.id, newBaseId: input.newBaseId };
  const decisions = decisionsFor(input.family, input.family.activeDecisionIds), steps = [...stepsFor(input.family, parent.stepIds), step];
  const result = replay({ ...input, steps, decisions, decisionRevision: input.family.decisionRevision, ancestorIds: ancestry(input.family, parent.id), lastStep: step });
  return result;
}
