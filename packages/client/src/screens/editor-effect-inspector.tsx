import { EFFECT_PRESET_CATALOGUE, effectPresetDefinition, formatFrames, type EffectPatch, type EffectClip } from "@arke-studio/contracts";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { EffectAuthoringProps } from "../lib/editor-effect-authoring.js";
import { EffectAreaEditor } from "./editor-effect-area.js";
import { EffectCurves } from "./editor-effect-curves.js";
import { EffectNumberField, EffectTimeField } from "./editor-effect-fields.js";
import { EffectTargetSelect } from "./editor-effect-target.js";

function EffectColour({ effect, disabled, onCommands, onPreview, authoringRevision }: EffectAuthoringProps) {
  const [colour, setColour] = useState(effect.appearance.colour), dirty = useRef(false);
  const callbacks = useRef(onPreview); callbacks.current = onPreview;
  useEffect(() => { if (!dirty.current) setColour(effect.appearance.colour); }, [effect.appearance.colour]);
  useEffect(() => () => { if (dirty.current) callbacks.current(null); }, []);
  useLayoutEffect(() => {
    if (dirty.current) callbacks.current(null);
    dirty.current = false; setColour(effect.appearance.colour);
  }, [authoringRevision]);
  const valid = /^#[0-9a-fA-F]{6}$/.test(colour);
  const cancel = () => { dirty.current = false; setColour(effect.appearance.colour); onPreview(null); };
  const edit = (value: string) => {
    dirty.current = true; setColour(value);
    onPreview(/^#[0-9a-fA-F]{6}$/.test(value) ? [{ kind: "effect-patch", clipId: effect.id, patch: { appearance: { colour: value } } }] : null);
  };
  return <div className="fx-colour">
    <label className="fx-inspector__select">Colour<input aria-label="Colour hex" value={colour} maxLength={7} spellCheck={false} disabled={disabled} aria-invalid={!valid || undefined}
      onInput={event => edit(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } }} /></label>
    <input type="color" aria-label="Choose colour" value={valid ? colour : effect.appearance.colour} disabled={disabled} onInput={event => edit(event.currentTarget.value)} />
    {!valid && <p className="fx-field__error" role="alert">Enter # followed by six hexadecimal digits.</p>}
    {dirty.current && <div className="fx-inspector__actions"><button type="button" disabled={disabled || !valid} onClick={() => {
      dirty.current = false; onPreview(null); onCommands([{ kind: "effect-patch", clipId: effect.id, patch: { appearance: { colour } } }], "Change effect colour");
    }}>Apply colour</button><button type="button" onClick={cancel}>Cancel colour</button></div>}
  </div>;
}

/** The command sink is intentionally supplied by Current or, later, a reviewed candidate. */
export function EffectInspector(props: EffectAuthoringProps & { children?: ReactNode }) {
  const { effect, timeline, frameRate, disabled, onCommands, onPreview, onScrub, children, authoringRevision } = props;
  const [preset, setPreset] = useState<EffectClip["preset"]["id"] | null>(null);
  useEffect(() => { setPreset(null); }, [effect.id, authoringRevision]);
  const name = effectPresetDefinition(effect.preset).label, end = effect.startFrame + effect.durationFrames;
  const patch = (value: EffectPatch, label: string) => onCommands([{ kind: "effect-patch", clipId: effect.id, patch: value }], label);
  const preview = (value: EffectPatch | null) => onPreview(value ? [{ kind: "effect-patch", clipId: effect.id, patch: value }] : null);
  const fadeChangedByTrim = effect.fades.startFrame !== effect.startFrame || effect.fades.endFrame !== end;
  return <div className="fx-inspector" key={effect.id} aria-label={`${name} effect Inspector`}>
    <header><span className="fx-inspector__eyebrow">EFFECT</span><h2>{name}</h2><p className="fx-inspector__hint">Manual edits remain available when protected from suggestions.</p></header>
    <section aria-label="Effect placement">
      <h3>Placement</h3>
      <EffectTargetSelect value={effect.target} timeline={timeline} disabled={disabled} onChange={target => patch({ target }, "Change effect target")} />
      <div className="fx-inspector__fields">
        <EffectTimeField label="Start" value={effect.startFrame} frameRate={frameRate} max={end - 1} disabled={disabled} resetToken={authoringRevision} onCommit={frame => { onCommands([{ kind: "effect-trim", clipId: effect.id, edge: "head", deltaFrames: frame - effect.startFrame }], "Trim effect start"); onScrub(frame); }} />
        <EffectTimeField label="End" value={end} frameRate={frameRate} min={effect.startFrame + 1} disabled={disabled} resetToken={authoringRevision} onCommit={frame => { onCommands([{ kind: "effect-trim", clipId: effect.id, edge: "tail", deltaFrames: frame - end }], "Trim effect end"); onScrub(frame - 1); }} />
        <EffectTimeField label="Move to" value={effect.startFrame} frameRate={frameRate} disabled={disabled} resetToken={authoringRevision} onCommit={frame => { onCommands([{ kind: "effect-move", clipId: effect.id, startFrame: frame }], "Move effect"); onScrub(frame); }} />
      </div>
      <p className="fx-inspector__hint">{formatFrames(effect.durationFrames, frameRate)} duration · {frameRate} fps. Start / End trim; Move to shifts the interval and animation together. Sound stays independent.</p>
    </section>
    <section aria-label="Effect preset">
      <h3>Preset</h3><label className="fx-inspector__select">Atmosphere<select aria-label="Atmosphere preset" disabled={disabled} value={preset ?? effect.preset.id} onChange={event => setPreset(event.currentTarget.value === effect.preset.id ? null : event.currentTarget.value as EffectClip["preset"]["id"])}>
        {EFFECT_PRESET_CATALOGUE.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
      </select></label>
      {preset && <div className="fx-inspector__conversion" role="status"><p>Retains appearance, blend, Pattern, Direction, Speed, emitting area, fades, curves, target, interval, sound and protection. Texture, depth and particle physics are used by Air Particles; their settings are retained when another preset is chosen.</p>
        <p>The particle shape and preset motion character will change.</p>
        <div className="fx-inspector__actions"><button type="button" disabled={disabled} onClick={() => { patch({ preset: { id: preset, version: 1 } }, "Change atmosphere preset"); setPreset(null); }}>Use {EFFECT_PRESET_CATALOGUE.find(value => value.id === preset)!.label}</button><button type="button" onClick={() => setPreset(null)}>Cancel preset change</button></div>
      </div>}
    </section>
    <section aria-label="Effect appearance"><h3>Appearance</h3><div className="fx-inspector__fields">
      {(["amount", "size", "opacity"] as const).map(key => <EffectNumberField key={key} label={key === "amount" ? "Amount" : key === "size" ? "Particle size" : "Opacity"}
        value={effect.appearance[key] * 100} min={0} max={100} step={1} suffix="%" disabled={disabled} slider resetToken={authoringRevision}
        onCommit={value => patch({ appearance: { [key]: value / 100 } }, `Change effect ${key}`)} onPreview={value => preview(value === null ? null : { appearance: { [key]: value / 100 } })} />)}
      <EffectColour key={effect.id} {...props} />
      {effect.preset.id === "air-particles" && (["texture", "softness", "depth"] as const).map(key => <EffectNumberField key={key}
        label={key === "depth" ? "Depth variation" : key === "texture" ? "Texture" : "Softness"} value={(effect.appearance[key] ?? (key === "texture" ? .75 : key === "softness" ? .55 : .6)) * 100}
        min={0} max={100} step={1} suffix="%" disabled={disabled} slider resetToken={authoringRevision}
        onCommit={value => patch({ appearance: { [key]: value / 100 } }, `Change effect ${key}`)} onPreview={value => preview(value === null ? null : { appearance: { [key]: value / 100 } })} />)}
      <label className="fx-inspector__select">Blend mode<select aria-label="Effect blend mode" disabled={disabled} value={effect.appearance.blendMode ?? "normal"}
        onChange={event => patch({ appearance: { blendMode: event.currentTarget.value as "normal" | "screen" | "add" } }, "Change effect blend mode")}>
        <option value="normal">Normal</option><option value="screen">Screen</option><option value="add">Add</option>
      </select></label>
    </div></section>
    <section aria-label="Effect motion"><h3>Motion</h3><div className="fx-inspector__fields">
      <EffectNumberField label="Direction" value={effect.motion.direction} min={-360} max={360} step={1} suffix="°" disabled={disabled} slider resetToken={authoringRevision}
        onCommit={direction => patch({ motion: { direction } }, "Change effect direction")} onPreview={direction => preview(direction === null ? null : { motion: { direction } })} />
      <EffectNumberField label="Speed" value={effect.motion.speed * 100} min={0} max={100} step={1} suffix="%" disabled={disabled} slider resetToken={authoringRevision}
        onCommit={value => patch({ motion: { speed: value / 100 } }, "Change effect speed")} onPreview={value => preview(value === null ? null : { motion: { speed: value / 100 } })} />
      <div className="fx-inspector__pattern"><div>Pattern<strong>{effect.seed}</strong></div><button type="button" disabled={disabled} onClick={() => {
        const random = crypto.getRandomValues(new Uint32Array(1))[0]!;
        patch({ seed: random === effect.seed ? (random + 1) >>> 0 : random }, "New effect pattern");
      }}>New pattern</button></div><p className="fx-inspector__hint">Playback and seeking keep this pattern. New pattern updates all split segments together and is undoable.</p>
      {effect.preset.id === "air-particles" && <details className="fx-inspector__physics"><summary>Particle physics</summary>
        <EffectNumberField label="Airflow variation" value={(effect.motion.airflow ?? .5) * 100} min={0} max={100} step={1} suffix="%" disabled={disabled} slider resetToken={authoringRevision}
          onCommit={value => patch({ motion: { airflow: value / 100 } }, "Change airflow variation")} onPreview={value => preview(value === null ? null : { motion: { airflow: value / 100 } })} />
        <label className="fx-inspector__contacts"><input type="checkbox" disabled={disabled} checked={effect.motion.particleDeflections ?? true}
          onChange={event => patch({ motion: { particleDeflections: event.currentTarget.checked } }, "Change particle deflections")} />Gentle particle deflections</label>
        <label className="fx-inspector__select">Picture boundary<select aria-label="Picture boundary" disabled={disabled} value={effect.motion.boundary ?? "soft-bounce"}
          onChange={event => patch({ motion: { boundary: event.currentTarget.value as "soft-bounce" | "open-flow" } }, "Change picture boundary")}>
          <option value="soft-bounce">Soft bounce</option><option value="open-flow">Open flow</option>
        </select></label><p className="fx-inspector__hint">Uses picture edges. Walls inside the image are not detected.</p>
      </details>}
    </div></section>
    <EffectAreaEditor {...props} />
    <section aria-label="Effect fades"><h3>Fades</h3><div className="fx-inspector__fields">
      <EffectTimeField label="Fade in" value={effect.fades.inFrames} frameRate={frameRate} max={Math.min(effect.durationFrames, effect.fades.endFrame - effect.fades.startFrame)} disabled={disabled} resetToken={authoringRevision} onCommit={inFrames => patch({ fades: { ...effect.fades, inFrames } }, "Change effect fade in")} />
      <EffectTimeField label="Fade out" value={effect.fades.outFrames} frameRate={frameRate} max={Math.min(effect.durationFrames, effect.fades.endFrame - effect.fades.startFrame)} disabled={disabled} resetToken={authoringRevision} onCommit={outFrames => patch({ fades: { ...effect.fades, outFrames } }, "Change effect fade out")} />
    </div><p className="fx-inspector__hint">Fades multiply visibility, including when they overlap.</p>
      {fadeChangedByTrim && <div className="fx-inspector__conversion"><p>Fades retain their original timing after a trim or split. Fitting them to this interval will move their anchors and shorten any fade longer than this interval.</p>
        <button type="button" disabled={disabled} onClick={() => patch({ fades: { startFrame: effect.startFrame, endFrame: end, inFrames: Math.min(effect.fades.inFrames, effect.durationFrames), outFrames: Math.min(effect.fades.outFrames, effect.durationFrames) } }, "Fit fades to effect interval")}>Fit fades to this interval</button></div>}
    </section>
    <EffectCurves {...props} />
    {children}
  </div>;
}
