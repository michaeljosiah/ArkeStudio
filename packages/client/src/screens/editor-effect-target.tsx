import { useId } from "react";
import type { EffectTarget, ProductionTimeline } from "@arke-studio/contracts";

const keyOf = (target: EffectTarget) => target.kind === "composition" ? "composition" : target.kind === "picture-track" ? `track:${target.trackId}` : `clip:${target.clipId}`;
export function effectTargetLabel(target: EffectTarget, timeline: ProductionTimeline): string {
  if (target.kind === "composition") return "Whole composition";
  const pictures = timeline.tracks.filter(track => track.kind === "picture");
  if (target.kind === "picture-track") return pictures.find(track => track.id === target.trackId)?.name ?? `Missing picture track · ${target.trackId}`;
  return pictures.flatMap(track => track.clips).find(clip => clip.id === target.clipId)?.source.label ?? `Missing visual clip · ${target.clipId}`;
}

/** Visual scope is independent of effect timing and optional sound (SPEC-053 R-2). */
export function EffectTargetSelect({ value, timeline, disabled, onChange, label = "Visual target" }: {
  value: EffectTarget; timeline: ProductionTimeline; disabled: boolean; onChange: (target: EffectTarget) => void; label?: string;
}) {
  const id = useId();
  const pictures = [...timeline.tracks].filter(track => track.kind === "picture").sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const choices: Array<{ value: EffectTarget; label: string }> = [{ value: { kind: "composition" }, label: "Whole composition" },
    ...pictures.map(track => ({ value: { kind: "picture-track" as const, trackId: track.id }, label: `${track.name} · picture track${track.muted ? " · hidden" : ""}` })),
    ...pictures.flatMap(track => track.clips.map(clip => ({ value: { kind: "visual-clip" as const, clipId: clip.id }, label: `${clip.source.label} · ${track.name} · ${clip.id}` })))];
  const key = keyOf(value), missing = !choices.some(choice => keyOf(choice.value) === key);
  return <label className="fy-effect-target" htmlFor={id}>{label}
    <select id={id} aria-label={label} value={key} disabled={disabled} onChange={event => {
      const choice = choices.find(candidate => keyOf(candidate.value) === event.currentTarget.value);
      if (choice) onChange(choice.value);
    }}>
      {missing && <option value={key} disabled>{effectTargetLabel(value, timeline)}</option>}
      {choices.map(choice => <option key={keyOf(choice.value)} value={keyOf(choice.value)}>{choice.label}</option>)}
    </select>
    {missing && <span role="status">This target is missing. Choose a replacement explicitly.</span>}
  </label>;
}
