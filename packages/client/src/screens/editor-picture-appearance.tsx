import { useEffect, useState } from "react";
import { ulid, formatFrames, type FrameRate, type TimelineClip, type TimelineCommand, type PictureBlendMode } from "@arke-studio/contracts";
import { EffectNumberField, EffectTimeField } from "./editor-effect-fields.js";

/** The same Inspector edits Current or an explicitly reviewed candidate through its command sink. */
export function PictureAppearanceInspector({ clip, frameRate, disabled, onCommands, resetToken, scopeLabel = "Current" }: {
  clip: TimelineClip; frameRate: FrameRate; disabled: boolean; onCommands: (commands: TimelineCommand[], label?: string) => void; resetToken?: number | string; scopeLabel?: string;
}) {
  const [property, setProperty] = useState<"blendMode" | "opacity">("blendMode"), [scope, setScope] = useState<"whole" | "passage">("whole");
  const [start, setStart] = useState(clip.startFrame), [end, setEnd] = useState(clip.startFrame + clip.durationFrames);
  useEffect(() => {
    setStart(clip.startFrame); setEnd(clip.startFrame + clip.durationFrames);
  }, [clip.id, clip.startFrame, clip.durationFrames, resetToken]);
  const passageReset = `${clip.id}/${clip.startFrame}/${clip.durationFrames}/${resetToken ?? ""}`;
  const label = property === "blendMode" ? "Blend mode" : "Opacity";
  return <section className="fx-inspector picture-appearance" aria-label="Picture appearance">
    <h3>Appearance</h3>
    <label className="fx-inspector__select">Blend mode<select aria-label="Picture blend mode" value={clip.visual?.blendMode ?? "normal"} disabled={disabled}
      onChange={event => onCommands([{ kind: "picture-appearance", clipId: clip.id, patch: { blendMode: event.currentTarget.value as PictureBlendMode } }], "Change picture blend mode")}>
      <option value="normal">Normal</option><option value="screen">Screen</option><option value="add">Add</option>
    </select></label>
    <EffectNumberField label="Picture opacity" value={(clip.visual?.opacity ?? 1) * 100} min={0} max={100} step={1} suffix="%" slider disabled={disabled} resetToken={resetToken}
      onCommit={value => onCommands([{ kind: "picture-appearance", clipId: clip.id, patch: { opacity: value / 100 } }], "Change picture opacity")} />
    <p className="fx-inspector__hint">Screen lightens over lower picture tracks. Add gives a brighter glow. Clip timing and sound remain independent.</p>
    <section className="fx-protection" aria-label="Picture protection from AI suggestions"><h3>Protection from AI suggestions</h3>
      <p className="fx-audio__note">You can still edit protected settings yourself. Whole clip protection follows its split segments. Release removes only the named rule.</p>
      <details><summary>Add setting protection</summary>
        <label className="fx-audio__select">Setting<select value={property} disabled={disabled} onChange={event => setProperty(event.currentTarget.value as typeof property)}><option value="blendMode">Blend mode</option><option value="opacity">Opacity</option></select></label>
        <label className="fx-audio__select">Setting scope<select value={scope} disabled={disabled} onChange={event => setScope(event.currentTarget.value as typeof scope)}><option value="whole">Whole clip</option><option value="passage">Fixed passage</option></select></label>
        {scope === "passage" && <div className="fx-protection__passage"><EffectTimeField label="Passage Start" value={start} frameRate={frameRate} disabled={disabled} resetToken={passageReset} onCommit={setStart} /><EffectTimeField label="Passage End" value={end} frameRate={frameRate} disabled={disabled} resetToken={passageReset} onCommit={setEnd} /></div>}
        <button type="button" disabled={disabled || scope === "passage" && end <= start} onClick={() => onCommands([{ kind: "picture-protect", clipId: clip.id,
          rule: { id: `vp_${ulid()}`, property, scope: scope === "whole" ? { kind: "whole" } : { kind: "passage", startFrame: start, endFrame: end } } }], `Protect ${label}`)}>Protect {label}</button>
      </details>
      {(clip.visual?.protection ?? []).map(rule => <div className="fx-protection__rule" key={rule.id}><strong>{rule.property === "blendMode" ? `Blend mode · ${clip.visual?.blendMode ?? "normal"}` : `Opacity · ${Math.round((clip.visual?.opacity ?? 1) * 100)}%`}</strong>
        <span>{rule.scope.kind === "whole" ? "Whole clip" : `${formatFrames(rule.scope.startFrame, frameRate)}–${formatFrames(rule.scope.endFrame, frameRate)} · Fixed passage`} · {scopeLabel}</span>
        <button type="button" disabled={disabled} aria-label={`Release ${rule.property === "blendMode" ? "Blend mode" : "Opacity"} protection for ${clip.source.label} · ${rule.scope.kind === "whole" ? "Whole clip" : `${formatFrames(rule.scope.startFrame, frameRate)}–${formatFrames(rule.scope.endFrame, frameRate)}`} · ${scopeLabel}`} onClick={() => onCommands([{ kind: "picture-release", ruleId: rule.id }], `Release picture ${rule.property}`)}>Release {rule.property === "blendMode" ? "Blend mode" : "Opacity"}</button></div>)}
      {!clip.visual?.protection?.length && <p className="fx-audio__note">No picture settings protected.</p>}
    </section>
  </section>;
}
