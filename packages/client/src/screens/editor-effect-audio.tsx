import { useEffect, useMemo, useState } from "react";
import { correctEffectLikelyBeat, effectCueConflicts, effectPresetDefinition, effectReactionPresetPatch, effectResponsePresetConflicts,
  EffectCueOverridesSchema, remainingEffectLikelyBeats, ulid, type EffectClip, type EffectCue, type EffectFeatureManifest, type EffectPatch, type RenderPlan } from "@arke-studio/contracts";
import type { EffectAuthoringProps } from "../lib/editor-effect-authoring.js";
import { effectAudioOptions } from "../lib/editor-effect-audio-options.js";
import { formatTimecode } from "../lib/timeline-drag.js";
import type { EffectAnalysisContext } from "./editor-effect-analysis.js";
import { EffectNumberField, EffectTimeField } from "./editor-effect-fields.js";
import { useSelectedEffectAnalysis } from "./editor-effect-selected-analysis.js";

const responses = { "gentle-shimmer": "Gentle shimmer", "beat-pulse": "Beat pulse", "build-with-energy": "Build with energy" } as const;
const statuses = { off: "Off", "no-source": "No source", analysing: "Analysing", ready: "Ready", "source-changed": "Source changed", "missing-source": "Missing source", failed: "Failed" } as const;
const properties = { brightness: "Brightness", emission: "Emission", size: "Size", speed: "Speed" } as const;

export function EffectAudioInspector(props: EffectAuthoringProps & { context: EffectAnalysisContext; plan: RenderPlan | null }) {
  const { effect, timeline, disabled, onCommands, onPreview, context, plan } = props;
  const [message, setMessage] = useState("");
  const choices = useMemo(() => effectAudioOptions(context, plan), [context.production, context.artifacts, context.timeline, plan]);
  const analysis = useSelectedEffectAnalysis(effect, context, plan);
  const selected = effect.audioInput ? JSON.stringify(effect.audioInput) : "";
  const selectedChoice = choices.find(row => JSON.stringify(row.input) === selected);
  const supported = effectPresetDefinition(effect.preset).supportedReactionProperties;
  const patch = (value: EffectPatch, label: string) => { onPreview(null); setMessage(label); onCommands([{ kind: "effect-patch", clipId: effect.id, patch: value }], label); };
  const reaction = (value: Partial<EffectClip["reaction"]>, label: string) => patch({ reaction: value }, label);
  const previewReaction = (value: Partial<EffectClip["reaction"]> | null) => onPreview(value === null ? null : [{ kind: "effect-patch", clipId: effect.id, patch: { reaction: value } }]);
  const simple = (preset: keyof typeof responses) => {
    const conflicts = effectResponsePresetConflicts(effect, timeline.effectProtection ?? [], preset);
    if (conflicts.length) { setMessage(`${responses[preset]} would change protected settings: ${conflicts.map(value => value.replace("reaction.", "")).join(", ")}. Use the individual controls to edit those settings yourself; protection stays in place.`); return; }
    reaction(effectReactionPresetPatch(preset), `Set ${responses[preset]} response`);
  };
  useEffect(() => { setMessage(""); }, [effect.id]);
  return <section className="fx-audio" aria-label="Audio reaction">
    <h3>Audio reaction</h3>
    <label className="fx-audio__select">Audio source
      <select value={selected} disabled={disabled} onChange={event => {
        const choice = choices.find(row => JSON.stringify(row.input) === event.target.value);
        if (choice && !choice.reason) patch({ audioInput: choice.input }, "Change reaction audio source");
        else if (event.target.value === "") patch({ audioInput: null, reaction: { enabled: false } }, "Clear reaction audio source");
      }}>
        <option value="">No audio source</option>
        {selected && !selectedChoice && <option value={selected} disabled>Missing source · {effect.audioInput!.kind === "composition-mix" ? "composition mix" : "clipId" in effect.audioInput! ? effect.audioInput!.clipId : effect.audioInput!.trackId}</option>}
        {choices.map(row => <option key={JSON.stringify(row.input)} value={JSON.stringify(row.input)} disabled={!!row.reason}>{row.label}{row.reason ? ` · unavailable: ${row.reason}` : ""}</option>)}
      </select>
    </label>
    {selectedChoice?.reason && <p role="status">{selectedChoice.reason}</p>}
    <p className="fx-audio__note">Reaction follows audible sound. Volume, mute, solo and ducking affect it. Silence leaves your base atmosphere.</p>
    <label className="fx-audio__toggle"><input type="checkbox" checked={effect.reaction.enabled} disabled={disabled || !effect.audioInput}
      onChange={event => reaction({ enabled: event.target.checked }, event.target.checked ? "Enable audio reaction" : "Turn audio reaction Off")} /> React to audio</label>
    {!effect.audioInput && <p className="fx-audio__note">Choose a placed source to enable reaction.</p>}
    <p className="fx-audio__status" role="status"><strong>{statuses[analysis.state.status]}</strong>
      {analysis.state.status === "ready" && (analysis.state.silent || (analysis.source?.ok && analysis.source.currentlySilent)) ? " · currently silent" : ""}
      {analysis.state.status === "analysing" && analysis.state.progress !== undefined ? ` · ${Math.round(analysis.state.progress * 100)}%` : ""}
      {"reason" in analysis.state ? ` · ${analysis.state.reason}` : ""}
      {analysis.loading ? " · loading likely beats" : ""}
      {analysis.error ? ` · ${analysis.error}` : ""}
    </p>
    {effect.reaction.enabled && analysis.state.status !== "ready" && <p className="fx-audio__note">Preview shows base atmosphere while reaction is unavailable. Export needs Ready analysis or an explicit Off.</p>}
    <div className="fx-audio__actions">
      {analysis.retry && <button type="button" disabled={disabled} onClick={analysis.retry}>Retry analysis</button>}
      {analysis.cancel && <button type="button" disabled={disabled} onClick={analysis.cancel}>Cancel analysis</button>}
    </div>
    <label className="fx-audio__select">Response
      <select value={effect.reaction.preset} disabled={disabled} onChange={event => { if (event.target.value in responses) simple(event.target.value as keyof typeof responses); }}>
        {Object.entries(responses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        <option value="custom" disabled>Custom</option>
      </select>
    </label>
    <EffectNumberField resetToken={props.authoringRevision} label="Reaction Strength" value={effect.reaction.strength * 100} min={0} max={100} step={1} suffix="%" slider disabled={disabled}
      onCommit={value => reaction({ strength: value / 100 }, "Change reaction Strength")}
      onPreview={value => previewReaction(value === null ? null : { strength: value / 100 })} />
    <details className="fx-audio__advanced"><summary>Advanced response</summary>
      <p className="fx-audio__note">Changing a mapping makes this response Custom. All three weights at zero have the same result as Off.</p>
      {(["beat", "bass", "energy"] as const).map(key => <EffectNumberField resetToken={props.authoringRevision} key={key} label={`${key[0]!.toUpperCase()}${key.slice(1)} weight`} value={effect.reaction[key] * 100} min={0} max={100} step={1} suffix="%" slider disabled={disabled}
        onCommit={value => reaction({ [key]: value / 100, preset: "custom" }, `Change ${key} response weight`)}
        onPreview={value => previewReaction(value === null ? null : { [key]: value / 100, preset: "custom" })} />)}
      <label className="fx-audio__select">Affected property<select value={effect.reaction.property} disabled={disabled} onChange={event => reaction({ property: event.target.value as EffectClip["reaction"]["property"], preset: "custom" }, "Change affected reaction property")}>
        {Object.entries(properties).map(([value, label]) => <option key={value} value={value} disabled={!supported.includes(value as keyof typeof properties)}>{label}{supported.includes(value as keyof typeof properties) ? "" : " · unsupported by this effect"}</option>)}
      </select></label>
      <EffectNumberField resetToken={props.authoringRevision} label="Response limit" value={effect.reaction.limit * 100} min={0} max={100} step={1} suffix="%" disabled={disabled}
        onCommit={value => reaction({ limit: value / 100, preset: "custom" }, "Change response limit")} />
      <EffectNumberField resetToken={props.authoringRevision} label="Smoothing" value={effect.reaction.smoothingFrames} min={0} max={300} step={1} suffix="frames" disabled={disabled}
        onCommit={value => reaction({ smoothingFrames: value, preset: "custom" }, "Change reaction smoothing")} />
    </details>
    {message && <p role="status">{message}</p>}
    <EffectCueEditor {...props} manifest={analysis.manifest} />
  </section>;
}

const PAGE_SIZE = 8;
export function EffectCueEditor(props: EffectAuthoringProps & { manifest: EffectFeatureManifest | null }) {
  const { effect, frameRate, playheadFrame, disabled, onCommands, onPreview, manifest } = props;
  const [error, setError] = useState(""), [page, setPage] = useState(0), [beatPage, setBeatPage] = useState(0);
  const beats = useMemo(() => manifest ? remainingEffectLikelyBeats(effect, manifest) : [], [effect.cueOverrides, manifest]);
  const conflicts = useMemo(() => manifest ? effectCueConflicts(effect, manifest) : [], [effect.cueOverrides, manifest]);
  useEffect(() => { setPage(0); setBeatPage(0); setError(""); }, [effect.id]);
  const change = (cues: EffectCue[], label: string) => {
    try { const cueOverrides = EffectCueOverridesSchema.parse(cues); onPreview(null); setError(""); onCommands([{ kind: "effect-patch", clipId: effect.id, patch: { cueOverrides } }], label); }
    catch { setError("Cues need unique IDs, nonnegative production frames, Strength from 0–100%, and a pulse of 1–300 frames. At most 2,000 corrections are supported."); }
  };
  const update = (cue: EffectCue, patch: Partial<EffectCue>) => change(effect.cueOverrides.map(value => value.id === cue.id ? { ...value, ...patch } : value), "Edit authored audio cue");
  const correction = (beat: EffectFeatureManifest["likelyBeats"][number], frame: number | null) => {
    try { change(correctEffectLikelyBeat(effect, beat, frameRate, frame, () => `ec_${ulid()}`), frame === null ? "Remove likely beat" : "Move likely beat"); }
    catch { setError("This correction would exceed the 2,000-cue limit or frame bounds. Remove a correction before adding another."); }
  };
  const shownPage = Math.min(page, Math.max(0, Math.ceil(effect.cueOverrides.length / PAGE_SIZE) - 1));
  const shownBeatPage = Math.min(beatPage, Math.max(0, Math.ceil(beats.length / PAGE_SIZE) - 1));
  return <details className="fx-cues"><summary>Beats and accents</summary>
    <p className="fx-audio__note">Likely beats are inferred. Your corrections stay on the production clock when analysis refreshes. Pulse strength falls linearly to zero; bass and energy keep their own values.</p>
    <button type="button" disabled={disabled} onClick={() => change([...effect.cueOverrides, { id: `ec_${ulid()}`, kind: "accent", frame: playheadFrame, strength: 1, durationFrames: Math.max(1, Math.ceil(frameRate * .12)) }], "Add audio accent")}>Add accent at playhead</button>
    {error && <p role="alert">{error}</p>}
    <h4>Your corrections ({effect.cueOverrides.length})</h4>
    {effect.cueOverrides.slice(shownPage * PAGE_SIZE, (shownPage + 1) * PAGE_SIZE).map(cue => <div className="fx-cues__row" key={cue.id}>
      <strong>{cue.kind === "accent" ? "Authored accent" : "Suppressed likely beat"}</strong>
      <EffectTimeField resetToken={props.authoringRevision} label="Cue position" value={cue.frame} frameRate={frameRate} disabled={disabled} onCommit={frame => update(cue, { frame })} />
      {cue.kind === "accent" && <EffectNumberField resetToken={props.authoringRevision} label="Cue Strength" value={cue.strength * 100} min={0} max={100} suffix="%" disabled={disabled} onCommit={value => update(cue, { strength: value / 100 })} />}
      <EffectNumberField resetToken={props.authoringRevision} label="Pulse duration" value={cue.durationFrames} min={1} max={300} step={1} suffix="frames" disabled={disabled} onCommit={durationFrames => update(cue, { durationFrames })} />
      {conflicts.filter(value => value.cueId === cue.id).map(value => <p key={value.cueId} role="status">{value.reason}</p>)}
      <button type="button" disabled={disabled} onClick={() => change(effect.cueOverrides.filter(value => value.id !== cue.id), "Remove authored audio cue")}>{cue.kind === "accent" ? "Remove accent" : "Restore likely beat"}</button>
    </div>)}
    <CuePages page={shownPage} count={effect.cueOverrides.length} onPage={setPage} label="corrections" />
    <h4>Likely beats ({beats.length})</h4>
    {!manifest && <p className="fx-audio__note">Ready analysis is needed to inspect likely beats. Authored accents remain editable.</p>}
    {beats.slice(shownBeatPage * PAGE_SIZE, (shownBeatPage + 1) * PAGE_SIZE).map(beat => <div className="fx-cues__row" key={beat.frame}>
      <strong>Likely beat · {formatTimecode(beat.frame / frameRate, frameRate)}</strong>
      <small>Confidence {Math.round(beat.confidence * 100)}%</small>
      <EffectTimeField resetToken={props.authoringRevision} label="Move likely beat to" value={beat.frame} frameRate={frameRate} disabled={disabled} onCommit={frame => correction(beat, frame)} />
      <button type="button" disabled={disabled} onClick={() => correction(beat, null)}>Remove likely beat</button>
    </div>)}
    <CuePages page={shownBeatPage} count={beats.length} onPage={setBeatPage} label="likely beats" />
  </details>;
}

function CuePages({ page, count, onPage, label }: { page: number; count: number; onPage: (page: number) => void; label: string }) {
  if (count <= PAGE_SIZE) return null;
  return <nav className="fx-audio__actions" aria-label={`${label} pages`}><button type="button" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
    <span>{page + 1} / {Math.ceil(count / PAGE_SIZE)}</span><button type="button" disabled={(page + 1) * PAGE_SIZE >= count} onClick={() => onPage(page + 1)}>Next</button></nav>;
}
