import { effectAnalysisCanonicalJson as canonical } from "./editor-effect-analysis.js";
import { EffectClipSchema, type EffectClip, type EffectPatch } from "./editor-effects.js";
import { effectAuthoredValue } from "./editor-effect-setting.js";
import { EffectProtectedPropertySchema } from "./editor-effect-protection.js";
import type { ProductionTimeline } from "./timeline.js";
import { effectOriginDescendsFrom, effectSegmentDescendsFrom, proposalEffects } from "./editor-effect-proposal-identity.js";
import type { EffectCreativeCommand, EffectHumanDecision, EffectIdentityLedger, EffectStickyChange, EffectStickyScope } from "./editor-effect-proposal.js";

const equal = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
export function effectValueAt(effect: EffectClip, path: string): unknown {
  return effectAuthoredValue(effect, path);
}
function put(value: object, path: string, next: unknown): void {
  const keys = path.split("."); let owner = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) { owner[key] ??= {}; owner = owner[key] as Record<string, unknown>; }
  const key = keys.at(-1)!; if (next === undefined) delete owner[key]; else owner[key] = structuredClone(next);
}
const has = (value: object, path: string): boolean => {
  const keys = path.split("."); let owner: unknown = value;
  for (const key of keys) { if (!owner || typeof owner !== "object" || !(key in owner)) return false; owner = (owner as Record<string, unknown>)[key]; }
  return true;
};

/** Capture actual field/point changes, including implicit response-preset changes. */
export function captureEffectStickyChanges(before: ProductionTimeline, after: ProductionTimeline, ledger: EffectIdentityLedger): EffectStickyChange[] {
  const old = proposalEffects(before), next = proposalEffects(after), result: EffectStickyChange[] = [];
  for (const clipId of new Set([...old, ...next].map(effect => effect.id))) {
    const previous = old.find(effect => effect.id === clipId) ?? null, current = next.find(effect => effect.id === clipId) ?? null;
    if (equal(previous, current)) continue;
    const segment = ledger.segments.find(row => row.clipId === clipId); if (!segment) throw new Error("A human adjustment has no stable effect identity.");
    const scopes: EffectStickyScope[] = [];
    if (!previous || !current) scopes.push({ kind: "whole-effect" });
    else {
      for (const property of EffectProtectedPropertySchema.options) if (!["intensityCurve", "reactionCurve", "cueOverrides"].includes(property) && !equal(effectValueAt(previous, property), effectValueAt(current, property))) scopes.push({ kind: "property", property });
      const placement: Extract<EffectStickyScope, { kind: "placement" }>["fields"] = [];
      if (previous.startFrame !== current.startFrame) placement.push("outer-start");
      if (previous.startFrame + previous.durationFrames !== current.startFrame + current.durationFrames) placement.push("outer-end");
      if (previous.simulationOriginFrame !== current.simulationOriginFrame) placement.push("simulation-origin");
      if (previous.fades.startFrame !== current.fades.startFrame) placement.push("fade-start");
      if (previous.fades.endFrame !== current.fades.endFrame) placement.push("fade-end");
      if (previous.order !== current.order) placement.push("order");
      if (placement.length) scopes.push({ kind: "placement", fields: placement });
      for (const curve of ["intensityCurve", "reactionCurve"] as const) {
        for (const pointId of new Set([...previous[curve].points, ...current[curve].points].map(point => point.id))) {
          const left = previous[curve].points.find(point => point.id === pointId), right = current[curve].points.find(point => point.id === pointId);
          if (equal(left, right)) continue;
          const entity = ledger.points.find(row => row.originId === segment.originId && row.authoredId === pointId && row.kind === (curve === "intensityCurve" ? "intensity-point" : "reaction-point"));
          if (!entity) throw new Error("A changed curve point has no stable identity.");
          const fields: Extract<EffectStickyScope, { kind: "point" }>["fields"] = !left || !right ? ["presence"] : (["offsetFrames", "value", "interpolation"] as const).filter(field => left[field] !== right[field]);
          scopes.push({ kind: "point", curve, entityId: entity.entityId, fields });
        }
      }
      for (const cueId of new Set([...previous.cueOverrides, ...current.cueOverrides].map(cue => cue.id))) {
        const left = previous.cueOverrides.find(cue => cue.id === cueId), right = current.cueOverrides.find(cue => cue.id === cueId);
        if (equal(left, right)) continue;
        const entity = ledger.points.find(row => row.originId === segment.originId && row.authoredId === cueId && row.kind === "cue");
        if (!entity) throw new Error("A changed cue has no stable identity.");
        const fields: Extract<EffectStickyScope, { kind: "cue" }>["fields"] = !left || !right ? ["presence"] : (["frame", "strength", "durationFrames", "kind"] as const).filter(field => left[field] !== right[field]);
        scopes.push({ kind: "cue", entityId: entity.entityId, fields });
      }
    }
    result.push({ originId: segment.originId, segmentId: segment.segmentId, scopes, before: previous, after: current });
  }
  return result;
}

/** Revision permission deactivates only exact named scopes; it never changes protection. */
export function activeEffectStickyChanges(decisions: readonly EffectHumanDecision[]): Array<EffectStickyChange & { decisionId: string }> {
  const result: Array<EffectStickyChange & { decisionId: string }> = [];
  for (const decision of decisions) {
    if (decision.kind === "adjust" || decision.kind === "keep-current") for (const change of decision.changes) {
      for (const previous of result) if (previous.originId === change.originId && previous.segmentId === change.segmentId)
        previous.scopes = previous.scopes.filter(scope => !change.scopes.some(next => next.kind === "whole-effect" || equal(next, scope)));
      result.push({ ...change, decisionId: decision.id });
    }
    if (decision.kind === "permit-revision") for (const change of result) if (decision.adjustmentIds.includes(change.decisionId)) change.scopes = change.scopes.flatMap(scope => {
      if (decision.scopes.some(allowed => equal(allowed, scope))) return [];
      if (scope.kind === "point" || scope.kind === "cue" || scope.kind === "placement") {
        const released = decision.scopes.filter(allowed => allowed.kind === scope.kind && (scope.kind === "placement" ||
          "entityId" in allowed && allowed.entityId === scope.entityId && (scope.kind !== "point" || "curve" in allowed && allowed.curve === scope.curve)))
          .flatMap(allowed => "fields" in allowed ? allowed.fields : []);
        const fields = scope.fields.filter(field => !released.includes(field));
        return fields.length ? [{ ...scope, fields } as EffectStickyScope] : [];
      }
      return [scope];
    });
  }
  return result.filter(change => change.scopes.length > 0);
}

/** Restore retained point fields inside an incoming whole-curve/cue patch, not the other points. */
function keepPoint(patch: EffectPatch, change: EffectStickyChange, scope: Extract<EffectStickyScope, { kind: "point" | "cue" }>, ledger: EffectIdentityLedger): void {
  const entity = ledger.points.find(row => row.entityId === scope.entityId); if (!entity || !change.after) throw new Error("The adjusted point identity is missing. Resolve it explicitly.");
  if (scope.kind === "point") {
    const target = patch[scope.curve]; if (!target) return;
    const retained = change.after[scope.curve].points.find(point => point.id === entity.authoredId);
    const incoming = target.points.find(point => point.id === entity.authoredId);
    if (scope.fields.includes("presence")) target.points = [...target.points.filter(point => point.id !== entity.authoredId), ...(retained ? [structuredClone(retained)] : [])];
    else {
      if (!retained || !incoming) throw new Error("The suggestion removes a manually adjusted point. Keep its identity or explicitly permit revision.");
      for (const field of scope.fields) if (field !== "presence") Object.assign(incoming, { [field]: retained[field] });
    }
    target.points.sort((a, b) => a.offsetFrames - b.offsetFrames);
  } else if (patch.cueOverrides) {
    const retained = change.after.cueOverrides.find(cue => cue.id === entity.authoredId), incoming = patch.cueOverrides.find(cue => cue.id === entity.authoredId);
    if (scope.fields.includes("presence")) patch.cueOverrides = [...patch.cueOverrides.filter(cue => cue.id !== entity.authoredId), ...(retained ? [structuredClone(retained)] : [])];
    else {
      if (!retained || !incoming) throw new Error("The suggestion removes a manually adjusted cue. Resolve it explicitly.");
      for (const field of scope.fields) if (field !== "presence") Object.assign(incoming, { [field]: retained[field] });
    }
  }
}

/** Constraints modify a suggestion segment before its normal suggestion-authority checks. */
export function preserveEffectStickyCommands(timeline: ProductionTimeline, commands: readonly EffectCreativeCommand[], ledger: EffectIdentityLedger,
  decisions: readonly EffectHumanDecision[]): EffectCreativeCommand[] {
  const sticky = activeEffectStickyChanges(decisions), effects = proposalEffects(timeline), result: EffectCreativeCommand[] = [];
  for (const original of commands) {
    const command = structuredClone(original);
    if (command.kind === "set-track" || command.kind === "remove-track") {
      const affected = timeline.tracks.find(track => track.id === command.trackId)?.effects ?? [];
      if (affected.some(effect => sticky.some(change => ledger.origins.find(origin => origin.originId === change.originId)?.lineageId === effect.lineageId)) &&
        (command.kind === "remove-track" || command.muted !== undefined || command.order !== undefined)) throw new Error("A structural track change would bypass retained manual adjustments.");
    }
    if (!("clipId" in command)) { result.push(command); continue; }
    const segment = ledger.segments.find(row => row.clipId === command.clipId);
    if (!segment) throw new Error("The suggestion refers to an unmapped effect.");
    if (decisions.some(decision => decision.kind === "exclude" && effectOriginDescendsFrom(ledger, segment.originId, decision.originId))) throw new Error("This effect or a derived replacement was excluded by you.");
    const changes = sticky.filter(change => change.originId === segment.originId && effectSegmentDescendsFrom(ledger, segment.segmentId, change.segmentId));
    for (const change of changes) {
      if (!change.after) throw new Error("A removed manual effect cannot be recreated by this revision.");
      if (command.kind === "effect-remove" || command.kind === "effect-duplicate") throw new Error("This structural edit would bypass a retained manual adjustment.");
      if (command.kind === "effect-split" && change.scopes.some(scope => scope.kind === "whole-effect" || scope.kind === "presence" || scope.kind === "placement")) throw new Error("Splitting this adjusted placement needs an explicit identity decision.");
      if (command.kind === "effect-patch") for (const scope of change.scopes) {
        if (scope.kind === "whole-effect") {
          const held = change.after; command.patch = { preset: held.preset, target: held.target, appearance: held.appearance, motion: held.motion,
            fades: held.fades, intensityCurve: held.intensityCurve, reactionCurve: held.reactionCurve, audioInput: held.audioInput ?? null, reaction: held.reaction, cueOverrides: held.cueOverrides };
        } else if (scope.kind === "property" && has(command.patch, scope.property)) put(command.patch, scope.property, effectValueAt(change.after, scope.property) ?? (scope.property === "audioInput" ? null : undefined));
        else if (scope.kind === "point" || scope.kind === "cue") keepPoint(command.patch, change, scope, ledger);
        else if (scope.kind === "placement" && command.patch.fades) {
          if (scope.fields.includes("fade-start")) command.patch.fades.startFrame = change.after.fades.startFrame;
          if (scope.fields.includes("fade-end")) command.patch.fades.endFrame = change.after.fades.endFrame;
        }
      }
      if (command.kind === "effect-move" || command.kind === "effect-trim" || command.kind === "effect-reorder") {
        const placement = change.scopes.filter(scope => scope.kind === "placement").flatMap(scope => scope.fields), whole = change.scopes.some(scope => scope.kind === "whole-effect" || scope.kind === "presence");
        const touches = command.kind === "effect-move" ? placement.length > 0 : command.kind === "effect-trim" ? placement.includes(command.edge === "head" ? "outer-start" : "outer-end") : placement.includes("order");
        if (whole || touches) {
          if (command.kind === "effect-move") command.startFrame = effects.find(effect => effect.id === command.clipId)?.startFrame ?? change.after.startFrame;
          else if (command.kind === "effect-trim") command.deltaFrames = 0;
          else command.order = change.after.order;
        }
      }
    }
    result.push(command);
  }
  return result;
}

/** Human Keep current restores exact phase via move then trims, retaining ordinary semantics. */
export function restoreEffectCommands(current: EffectClip, desired: EffectClip): EffectCreativeCommand[] {
  if (current.id !== desired.id || current.lineageId !== desired.lineageId) throw new Error("Keep current cannot substitute another effect identity.");
  const commands: EffectCreativeCommand[] = [], delta = desired.simulationOriginFrame - current.simulationOriginFrame;
  const movedStart = current.startFrame + delta;
  if (movedStart < 0) throw new Error("Restoring this placement needs an explicit structural decision.");
  if (delta) commands.push({ kind: "effect-move", clipId: current.id, startFrame: movedStart });
  const head = desired.startFrame - movedStart;
  if (head) commands.push({ kind: "effect-trim", clipId: current.id, edge: "head", deltaFrames: head });
  const duration = current.durationFrames - head;
  if (duration !== desired.durationFrames) commands.push({ kind: "effect-trim", clipId: current.id, edge: "tail", deltaFrames: desired.durationFrames - duration });
  if (desired.order !== current.order) commands.push({ kind: "effect-reorder", clipId: current.id, order: desired.order });
  const parsed = EffectClipSchema.parse(desired);
  commands.push({ kind: "effect-patch", clipId: current.id, patch: { seed: parsed.seed, preset: parsed.preset, target: parsed.target, appearance: parsed.appearance, motion: parsed.motion,
    fades: parsed.fades, intensityCurve: parsed.intensityCurve, reactionCurve: parsed.reactionCurve, audioInput: parsed.audioInput ?? null, reaction: parsed.reaction, cueOverrides: parsed.cueOverrides } });
  return commands;
}
