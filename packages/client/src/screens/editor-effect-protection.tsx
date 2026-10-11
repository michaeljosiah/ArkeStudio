import { useEffect, useState } from "react";
import { EffectProtectedPropertySchema, EffectProtectionInputSchema, uncoveredEffectPassages, ulid,
  type EffectClip, type EffectProtectedProperty, type EffectProtectionInput, type EffectProtectionRule, type ProductionTimeline } from "@arke-studio/contracts";
import type { EffectAuthoringProps } from "../lib/editor-effect-authoring.js";
import { formatTimecode } from "../lib/timeline-drag.js";
import { EffectTimeField } from "./editor-effect-fields.js";

export const EFFECT_PROTECTION_LABELS: Record<EffectProtectedProperty, string> = {
  target: "Visual target", preset: "Atmosphere preset", "appearance.amount": "Amount", "appearance.size": "Particle Size", "appearance.opacity": "Opacity", "appearance.colour": "Colour",
  "motion.direction": "Direction", "motion.speed": "Speed", "motion.area": "Emitting area", "fades.inFrames": "Fade in", "fades.outFrames": "Fade out", intensityCurve: "Intensity curve",
  audioInput: "Audio source", "reaction.enabled": "Reaction On/Off", "reaction.preset": "Response preset", "reaction.strength": "Reaction Strength", "reaction.beat": "Beat weight", "reaction.bass": "Bass weight",
  "reaction.energy": "Energy weight", "reaction.property": "Affected property", "reaction.limit": "Response limit", "reaction.smoothingFrames": "Smoothing", reactionCurve: "Reaction curve", cueOverrides: "Beat corrections and accents",
};
const percent = new Set<EffectProtectedProperty>(["appearance.amount", "appearance.size", "appearance.opacity", "motion.speed", "reaction.strength", "reaction.beat", "reaction.bass", "reaction.energy", "reaction.limit"]);
export function effectProtectionValue(effect: EffectClip, property: EffectProtectedProperty, timeline?: ProductionTimeline): string {
  let value: unknown = effect;
  for (const key of property.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  if (typeof value === "number") return percent.has(property) ? `${Math.round(value * 100)}%` : `${value}${property === "motion.direction" ? "°" : " frames"}`;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value === undefined) return "No source";
  if (typeof value === "string") return value.replaceAll("-", " ");
  if (property === "preset") return `${effect.preset.id} v${effect.preset.version}`;
  if (property === "intensityCurve" || property === "reactionCurve") return `${effect[property].points.length} points${effect[property].points.length ? "" : " · constant 100%"}`;
  if (property === "cueOverrides") return `${effect.cueOverrides.length} authored corrections`;
  if (property === "motion.area") return `x ${Math.round(effect.motion.area.x * 100)}%, y ${Math.round(effect.motion.area.y * 100)}%, ${Math.round(effect.motion.area.width * 100)}% × ${Math.round(effect.motion.area.height * 100)}%`;
  const binding = value as { kind: string; clipId?: string; trackId?: string };
  const name = binding.clipId ? timeline?.tracks.flatMap(track => track.clips).find(clip => clip.id === binding.clipId)?.source.label ?? binding.clipId
    : binding.trackId ? timeline?.tracks.find(track => track.id === binding.trackId)?.name ?? binding.trackId : "";
  const labels: Record<string, string> = { composition: "Composition", "composition-mix": "Composition mix", "picture-track": "Picture track", "visual-clip": "Visual clip", "audio-track": "Audio track", "audio-clip": "Audio clip", "video-sound": "Video sound" };
  return `${labels[binding.kind] ?? binding.kind}${name ? ` · ${name}` : ""}`;
}

export function EffectProtectionInspector({ effect, timeline, frameRate, authoringRevision, disabled, onCommands, onRelease, scopeLabel = "Current" }: EffectAuthoringProps & {
  onRelease?: (rule: EffectProtectionRule) => void; scopeLabel?: string;
}) {
  const [property, setProperty] = useState<EffectProtectedProperty>("appearance.amount");
  const [scope, setScope] = useState<"whole" | "passage">("whole");
  const [start, setStart] = useState(effect.startFrame), [end, setEnd] = useState(effect.startFrame + effect.durationFrames);
  const [message, setMessage] = useState(""), [page, setPage] = useState(0);
  const effects = timeline.tracks.flatMap(track => track.effects ?? []), segments = effects.filter(value => value.lineageId === effect.lineageId);
  const rules = (timeline.effectProtection ?? []).filter(rule => rule.lineageId === effect.lineageId);
  const time = (frame: number) => formatTimecode(frame / frameRate, frameRate);
  const outerStart = Math.min(...segments.map(value => value.startFrame)), outerEnd = Math.max(...segments.map(value => value.startFrame + value.durationFrames));
  useEffect(() => { setStart(effect.startFrame); setEnd(effect.startFrame + effect.durationFrames); setPage(0); setMessage(""); }, [effect.id]);
  const add = (input: Omit<Extract<EffectProtectionInput, { kind: "property" }>, "id" | "lineageId"> | Omit<Extract<EffectProtectionInput, { kind: "boundary" }>, "id" | "lineageId"> | Omit<Extract<EffectProtectionInput, { kind: "passage-coverage" }>, "id" | "lineageId">) => {
    const candidate = { ...input, id: `pr_${ulid()}`, lineageId: effect.lineageId };
    const result = EffectProtectionInputSchema.safeParse(candidate);
    if (!result.success) { setMessage("Choose a fixed passage with an End at least one frame after Start."); return; }
    const shape = (rule: EffectProtectionInput) => JSON.stringify(rule.kind === "property" ? { kind: rule.kind, property: rule.property, scope: rule.scope }
      : rule.kind === "boundary" ? { kind: rule.kind, boundary: rule.boundary } : { kind: rule.kind, startFrame: rule.startFrame, endFrame: rule.endFrame });
    if (rules.some(rule => shape(rule) === shape(result.data))) { setMessage("That exact protection is already in place."); return; }
    onCommands([{ kind: "effect-protect", rule: result.data }], `Protect ${input.kind === "property" ? EFFECT_PROTECTION_LABELS[input.property] : input.kind === "boundary" ? input.boundary : "passage coverage"}`);
    setMessage("Protection added. You can still edit the setting yourself.");
  };
  const shownPage = Math.min(page, Math.max(0, Math.ceil(rules.length / 8) - 1));
  return <section className="fx-protection" aria-label="Protection from AI suggestions">
    <h3>Protection from AI suggestions</h3>
    <p className="fx-audio__note">Protect individual settings, exact boundaries or passage coverage. You can always edit them yourself; your edit updates the protected baseline and keeps the rule.</p>
    <div className="fx-protection__boundaries">
      <button type="button" disabled={disabled || rules.some(rule => rule.kind === "boundary" && rule.boundary === "start")} onClick={() => add({ kind: "boundary", boundary: "start" })}>Protect exact Start · {time(outerStart)}</button>
      <button type="button" disabled={disabled || rules.some(rule => rule.kind === "boundary" && rule.boundary === "end")} onClick={() => add({ kind: "boundary", boundary: "end" })}>Protect exact End · {time(outerEnd)}</button>
    </div>
    <p className="fx-audio__note">Start and End apply to this effect's outer bounds across split segments. Passage coverage is a separate rule.</p>
    <details><summary>Add setting or passage protection</summary>
      <label className="fx-audio__select">Setting<select value={property} disabled={disabled} onChange={event => setProperty(event.target.value as EffectProtectedProperty)}>
        {EffectProtectedPropertySchema.options.map(path => <option key={path} value={path}>{EFFECT_PROTECTION_LABELS[path]}</option>)}
      </select></label>
      <label className="fx-audio__select">Setting scope<select value={scope} disabled={disabled} onChange={event => setScope(event.target.value as "whole" | "passage")}>
        <option value="whole">Whole effect</option><option value="passage">Fixed passage</option>
      </select></label>
      <p className="fx-audio__note">Selected value: {effectProtectionValue(effect, property, timeline)}</p>
      <div className="fx-protection__passage">
        <EffectTimeField resetToken={authoringRevision} label="Passage Start" value={start} frameRate={frameRate} disabled={disabled} onCommit={setStart} />
        <EffectTimeField resetToken={authoringRevision} label="Passage End" value={end} frameRate={frameRate} disabled={disabled} onCommit={setEnd} />
      </div>
      <p className="fx-audio__note">Passages stay at these production times when you move the effect. End is exclusive.</p>
      <div className="fx-audio__actions">
        <button type="button" disabled={disabled} onClick={() => add({ kind: "property", property, scope: scope === "whole" ? { kind: "whole" } : { kind: "passage", startFrame: start, endFrame: end } })}>Protect {EFFECT_PROTECTION_LABELS[property]}</button>
        <button type="button" disabled={disabled} onClick={() => add({ kind: "passage-coverage", startFrame: start, endFrame: end })}>Protect passage coverage</button>
      </div>
    </details>
    {message && <p role="status">{message}</p>}
    <h4>Protected rules ({rules.length})</h4>
    {rules.length === 0 && <p className="fx-audio__note">No settings protected from suggestions.</p>}
    {rules.slice(shownPage * 8, (shownPage + 1) * 8).map(rule => {
      const label = rule.kind === "property" ? EFFECT_PROTECTION_LABELS[rule.property] : rule.kind === "boundary" ? `Exact ${rule.boundary === "start" ? "Start" : "End"}` : "Passage coverage";
      const passage = rule.kind === "passage-coverage" ? rule : rule.kind === "property" && rule.scope.kind === "passage" ? rule.scope : null;
      const scopeName = passage ? `${time(passage.startFrame)}–${time(passage.endFrame)}` : rule.kind === "boundary" ? "Logical outer boundary" : "Whole effect";
      const values = rule.kind === "property" ? [...new Set(segments.map(segment => effectProtectionValue(segment, rule.property, timeline)))] : [];
      const value = rule.kind === "boundary" ? time(rule.boundary === "start" ? outerStart : outerEnd) : rule.kind === "property" ? values.length === 1 ? values[0] : `Varies across ${segments.length} segments` : "Retain existing covered frames";
      const holes = passage ? uncoveredEffectPassages(effects, effect.lineageId, passage.startFrame, passage.endFrame) : [];
      return <div className="fx-protection__rule" key={rule.id}>
        <strong>{label} · {value}</strong><span>{scopeName} · {scopeLabel}</span>
        {holes.length > 0 && <p role="status">Uncovered passage: {holes.map(hole => `${time(hole.startFrame)}–${time(hole.endFrame)}`).join(", ")}. Protection stays in place.</p>}
        <button type="button" disabled={disabled} aria-label={`Release ${label} protection for ${effect.preset.id} · ${scopeName} · ${scopeLabel}`} onClick={() => {
          if (onRelease) onRelease(rule); else onCommands([{ kind: "effect-release", ruleId: rule.id }], `Release ${label} protection`);
          setMessage(`Release requested for ${label} · ${scopeName} · ${scopeLabel}.`);
        }}>Release {label}</button>
      </div>;
    })}
    {rules.length > 8 && <nav className="fx-audio__actions" aria-label="Protection pages"><button type="button" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>Previous</button><span>{shownPage + 1} / {Math.ceil(rules.length / 8)}</span><button type="button" disabled={(shownPage + 1) * 8 >= rules.length} onClick={() => setPage(shownPage + 1)}>Next</button></nav>}
  </section>;
}
