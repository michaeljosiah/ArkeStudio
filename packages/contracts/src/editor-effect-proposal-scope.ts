import { effectAnalysisCanonicalJson as canonical } from "./editor-effect-analysis.js";
import type { EffectClip } from "./editor-effects.js";
import type { ProductionTimeline } from "./timeline.js";
import type { EffectArrangementScope, EffectHumanDecision, EffectIdentityLedger } from "./editor-effect-proposal.js";
import { effectSegmentDescendsFrom } from "./editor-effect-proposal-identity.js";

const equal = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
function outsideSignature(timeline: ProductionTimeline, frame: number, admitted: ReadonlySet<string>): string {
  return canonical(timeline.tracks.filter(track => track.kind === "effect" && !track.muted).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).flatMap(track =>
    [...(track.effects ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).filter(effect => !admitted.has(effect.id) && effect.startFrame <= frame && effect.startFrame + effect.durationFrames > frame).map(effect => {
      const { id: _id, startFrame: _start, durationFrames: _duration, order: _order, ...settings } = effect;
      return { trackId: track.id, settings };
    })));
}
/** Scope is structured authority, never inferred from direction/summary or visual similarity. */
export function effectProposalScopeProblem(base: ProductionTimeline, candidate: ProductionTimeline, scope: EffectArrangementScope,
  human: { decisions: readonly EffectHumanDecision[]; ledger: EffectIdentityLedger } = { decisions: [], ledger: { origins: [], segments: [], points: [], slots: [] } }): string | null {
  const stable = (timeline: ProductionTimeline) => ({ frameRate: timeline.frameRate, mix: timeline.mix, library: timeline.library,
    tracks: timeline.tracks.filter(track => track.kind !== "effect"), migratedCut: timeline.migratedCut });
  if (!equal(stable(base), stable(candidate))) return "This effects-only request cannot change picture, sound, subtitles, mix or library state.";
  const before = base.tracks.flatMap(track => track.effects ?? []), after = candidate.tracks.flatMap(track => track.effects ?? []);
  // Only changed scope controls grant an exception. Amount alone never expands a passage.
  type Override = { target?: EffectClip["target"]; range?: EffectArrangementScope["range"]; preset?: EffectClip["preset"]; audio?: EffectArrangementScope["audio"] };
  const admitted = new Map<string, Override>();
  for (const decision of human.decisions) if (decision.kind === "adjust" || decision.kind === "keep-current") for (const change of decision.changes)
    for (const segment of human.ledger.segments) if (segment.originId === change.originId && effectSegmentDescendsFrom(human.ledger, segment.segmentId, change.segmentId)) {
      const value = change.after ?? change.before; if (!value) continue;
      const entry = admitted.get(segment.clipId) ?? {}, whole = change.scopes.some(value => value.kind === "whole-effect");
      const property = (name: string) => whole || change.scopes.some(value => value.kind === "property" && value.property === name);
      if (property("target")) entry.target = value.target;
      if (property("preset")) entry.preset = value.preset;
      if (whole || change.scopes.some(value => value.kind === "placement" && value.fields.some(field => field === "outer-start" || field === "outer-end")))
        entry.range = { startFrame: value.startFrame, endFrame: value.startFrame + value.durationFrames };
      if (property("audioInput") || property("reaction.enabled")) entry.audio = value.reaction.enabled && value.audioInput ? { kind: "source", input: value.audioInput } : { kind: "off" };
      admitted.set(segment.clipId, entry);
    }
  const outside = (effect: EffectClip) => { const range = admitted.get(effect.id)?.range ?? scope.range;
    return effect.startFrame >= range.endFrame || effect.startFrame + effect.durationFrames <= range.startFrame; };
  for (const effect of before) {
    const next = after.find(value => value.id === effect.id);
    if (equal(effect, next)) continue;
    if (outside(effect)) return `Effect ${effect.id} is outside the requested passage and must remain unchanged.`;
    if (!equal(effect.target, admitted.get(effect.id)?.target ?? scope.target)) return `Effect ${effect.id} belongs to another visual target. Expand the request explicitly to change it.`;
  }
  for (const effect of after) {
    if (equal(effect, before.find(value => value.id === effect.id))) continue;
    const authored = admitted.get(effect.id), target = authored?.target ?? scope.target;
    if (!equal(effect.target, target)) return "The visual target must match the request or this identity's explicit human choice.";
    if (authored?.range && (effect.startFrame < authored.range.startFrame || effect.startFrame + effect.durationFrames > authored.range.endFrame)) return "The model cannot expand beyond this identity's explicitly authored passage.";
    if (!scope.palette.some(preset => equal(preset, effect.preset)) && (!authored || !equal(authored.preset, effect.preset))) return "This preset is outside the chosen arrangement palette.";
    const audio = authored?.audio ?? scope.audio;
    if (audio.kind === "off" && effect.reaction.enabled) return "Audio reaction is Off for this arrangement.";
    if (audio.kind === "source") {
      const prior = before.find(value => value.id === effect.id);
      if ((effect.reaction.enabled || !equal(prior?.audioInput, effect.audioInput)) && effect.audioInput && !equal(effect.audioInput, audio.input)) return "The effect must use the arrangement's explicitly chosen audio source.";
    }
  }
  const edges = [...new Set([0, scope.range.startFrame, scope.range.endFrame, ...[...before, ...after].flatMap(effect => [effect.startFrame, effect.startFrame + effect.durationFrames])])].sort((a, b) => a - b);
  for (const edge of edges) if (edge < scope.range.startFrame || edge >= scope.range.endFrame) {
    const admittedIds = new Set([...admitted].filter(([, value]) => value.range && edge >= value.range.startFrame && edge < value.range.endFrame).map(([id]) => id));
    if (outsideSignature(base, edge, admittedIds) !== outsideSignature(candidate, edge, admittedIds)) return "The edit changes effect coverage, settings or stacking outside the requested passage. Split and retain the outside settings, or expand the scope.";
  }
  return null;
}
