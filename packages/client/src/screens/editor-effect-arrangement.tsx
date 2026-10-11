import { useId, useState } from "react";
import { EFFECT_PRESET_CATALOGUE, EffectArrangementScopeSchema, formatFrames,
  type EffectArrangementScope, type EffectAudioInput, type EffectTarget, type RenderPlan } from "@arke-studio/contracts";
import { effectAudioOptions } from "../lib/editor-effect-audio-options.js";
import { effectArrangementDeliveryRange, effectArrangementPlacedRange, effectArrangementRequest,
  type EffectArrangementRange, type EffectArrangementRequest } from "../lib/editor-effect-arrangement.js";
import type { EffectAnalysisContext } from "./editor-effect-analysis.js";
import { effectTimeFrames } from "./editor-effect-fields.js";
import { EFFECT_PROTECTION_LABELS, effectProtectionValue } from "./editor-effect-protection.js";
import { EffectTargetSelect } from "./editor-effect-target.js";
import { CutDialog } from "./editor-responsive.js";

export interface EffectArrangementDialogProps {
  context: EffectAnalysisContext;
  plan: RenderPlan | null;
  selectedPictureId?: string | null;
  selectedRange?: EffectArrangementRange | null;
  disabledReason?: string;
  onPrepare: (request: EffectArrangementRequest) => void;
  onClose: () => void;
}

/** Request preparation only: this component has no transport, analysis or timeline-write port (SPEC-053 R-28–30). */
export function EffectArrangementDialog({ context, plan, selectedPictureId, selectedRange, disabledReason, onPrepare, onClose }: EffectArrangementDialogProps) {
  const { timeline } = context, frameRate = timeline.frameRate, id = useId();
  const delivery = effectArrangementDeliveryRange(plan, frameRate), disabled = disabledReason !== undefined;
  const [target, setTarget] = useState<EffectTarget>({ kind: "composition" });
  const [startText, setStartText] = useState(() => formatFrames(delivery?.startFrame ?? 0, frameRate));
  const [endText, setEndText] = useState(() => delivery ? formatFrames(delivery.endFrame, frameRate) : "");
  const [audioKey, setAudioKey] = useState("off"), [songKey, setSongKey] = useState("");
  const [songOpen, setSongOpen] = useState(false), [copied, setCopied] = useState<string | null>(null);
  const [direction, setDirection] = useState("Subtle and atmospheric.");
  const [palette, setPalette] = useState<EffectArrangementScope["palette"]>([{ id: "dust", version: 1 }]);
  const [error, setError] = useState<string | null>(null), [protectionPage, setProtectionPage] = useState(0);
  const audioOptions = effectAudioOptions(context, plan), keyOf = (input: EffectAudioInput) => JSON.stringify(input);
  const audio = audioOptions.find(row => keyOf(row.input) === audioKey), song = audioOptions.find(row => keyOf(row.input) === songKey);
  const startFrame = effectTimeFrames(startText, frameRate), endFrame = effectTimeFrames(endText, frameRate);
  const pictureTracks = timeline.tracks.filter(track => track.kind === "picture");
  const selectedPicture = pictureTracks.flatMap(track => track.clips).find(clip => clip.id === selectedPictureId);
  const targetExists = target.kind === "composition" || (target.kind === "picture-track"
    ? pictureTracks.some(track => track.id === target.trackId) : pictureTracks.some(track => track.clips.some(clip => clip.id === target.clipId)));
  const rangeProblem = !delivery ? "The video needs a resolved delivery range before preparing an arrangement."
    : startFrame === null || endFrame === null || endFrame <= startFrame ? "Enter a valid Start and an End at least one frame later."
    : startFrame < delivery.startFrame || endFrame > delivery.endFrame ? `Keep the request within ${formatFrames(delivery.startFrame, frameRate)}–${formatFrames(delivery.endFrame, frameRate)}.` : null;
  const bindingProblem = audioKey !== "off" ? audio?.reason ?? (!audio ? "The chosen audio source is missing. Choose another source or Off." : null) : null;
  const problem = disabledReason ?? rangeProblem ?? (!targetExists ? "The visual target is missing. Choose another target explicitly." : null)
    ?? bindingProblem ?? (!direction.trim() ? "Describe the creative direction." : direction.trim().length > 2000 ? "Keep the creative direction to 2,000 characters." : null)
    ?? (!palette.length ? "Choose at least one effect for the palette." : null);
  const showRange = (range: EffectArrangementRange) => `${formatFrames(range.startFrame, frameRate)}–${formatFrames(range.endFrame, frameRate)}`;
  const copyRange = (range: EffectArrangementRange, description: string) => {
    if (!delivery) return;
    const bounded = { startFrame: Math.max(delivery.startFrame, range.startFrame), endFrame: Math.min(delivery.endFrame, range.endFrame) };
    if (bounded.endFrame <= bounded.startFrame) { setError("This interval is outside the video delivery range."); return; }
    setStartText(formatFrames(bounded.startFrame, frameRate)); setEndText(formatFrames(bounded.endFrame, frameRate));
    setCopied(`${description}: ${showRange(bounded)}${bounded.startFrame !== range.startFrame || bounded.endFrame !== range.endFrame ? " · clipped to video delivery" : ""}.`); setError(null);
  };
  const songRange = song && !song.reason ? effectArrangementPlacedRange(timeline, song.input, delivery) : null;
  const copySong = () => {
    if (disabled || !song || !songRange?.ok) return;
    copyRange(songRange.original, `Copied ${song.label}${songRange.hasGaps ? " · track span includes gaps" : ""}`);
  };
  const prepare = () => {
    if (problem || startFrame === null || endFrame === null) { setError(problem ?? "Choose a valid request range."); return; }
    const parsed = EffectArrangementScopeSchema.safeParse({ kind: "effects-only", target, range: { startFrame, endFrame },
      audio: audioKey === "off" ? { kind: "off" } : { kind: "source", input: audio?.input }, direction, palette });
    if (!parsed.success) { setError("Check the request's target, range, sound, direction and palette."); return; }
    onPrepare(effectArrangementRequest(parsed.data));
  };
  const rules = timeline.effectProtection ?? [], effects = timeline.tracks.flatMap(track => track.effects ?? []);
  const page = Math.min(protectionPage, Math.max(0, Math.ceil(rules.length / 8) - 1));
  return <CutDialog open title="Suggest effect arrangement" subtitle="Choose the picture, time and optional sound independently." width={560} panelClassName="fx-arrangement-dialog" onClose={onClose}>
    <form className="fx-arrangement" onChange={() => setError(null)} onSubmit={event => { event.preventDefault(); prepare(); }}>
      <EffectTargetSelect value={target} timeline={timeline} disabled={disabled} onChange={setTarget} />
      <fieldset disabled={disabled}><legend>Time range</legend>
        <div className="fx-arrangement__actions">
          <button type="button" disabled={!delivery} onClick={() => delivery && copyRange(delivery, "Whole video")}>Whole video</button>
          <button type="button" disabled={!selectedPicture || !delivery} onClick={() => selectedPicture && copyRange({ startFrame: selectedPicture.startFrame, endFrame: selectedPicture.startFrame + selectedPicture.durationFrames }, "Selected picture")}>Selected picture</button>
          <button type="button" disabled={!selectedRange || !delivery} onClick={() => selectedRange && copyRange(selectedRange, "Selected range")}>Selected range</button>
          <button type="button" aria-expanded={songOpen} aria-controls={`${id}-song`} onClick={() => setSongOpen(!songOpen)}>Whole song…</button>
        </div>
        {songOpen && <div className="fx-arrangement__song" id={`${id}-song`}>
          <label>Copy interval from placed audio<select aria-label="Copy interval from placed audio" value={songKey} onChange={event => setSongKey(event.currentTarget.value)}>
            <option value="">Choose a placed track or clip…</option>
            {songKey && !song && <option value={songKey} disabled>Missing placed audio</option>}
            {audioOptions.filter(row => row.input.kind !== "composition-mix").map(row => <option key={keyOf(row.input)} value={keyOf(row.input)} disabled={!!row.reason}>{row.label}{row.reason ? ` · ${row.reason}` : ""}</option>)}
          </select></label>
          {songRange?.ok && <p>Resolved interval: {showRange(songRange.range)}{songRange.clipped ? " · clipped to video delivery" : ""}{songRange.hasGaps ? " · track span includes gaps" : ""}.</p>}
          {(song?.reason || (songRange && !songRange.ok)) && <p role="status">{song?.reason ?? (songRange && !songRange.ok ? songRange.reason : "")}</p>}
          <button type="button" disabled={!songRange?.ok} onClick={copySong}>Use this interval</button>
          <p>This copies time only. Your visual target and audio reaction stay as chosen.</p>
        </div>}
        <div className="fx-arrangement__times">
          <label>Start<input aria-label="Arrangement Start" value={startText} onChange={event => { setStartText(event.currentTarget.value); setCopied(null); }} spellCheck={false} /></label>
          <label>End<input aria-label="Arrangement End" value={endText} onChange={event => { setEndText(event.currentTarget.value); setCopied(null); }} spellCheck={false} /></label>
        </div>
        <p>HH:MM:SS:FF or seconds · {frameRate} fps. The copied range stays fixed when sound moves.</p>
        <output aria-live="polite">{rangeProblem ?? (startFrame !== null && endFrame !== null ? `Request range: ${showRange({ startFrame, endFrame })} · ${endFrame - startFrame} frames` : "")}</output>
        {copied && <p role="status">{copied}</p>}
      </fieldset>
      <label>Audio reaction<select aria-label="Arrangement audio reaction" disabled={disabled} value={audioKey} onChange={event => setAudioKey(event.currentTarget.value)}>
        <option value="off">Off · no audio source</option>
        {audioKey !== "off" && !audio && <option value={audioKey} disabled>Missing audio source</option>}
        {audioOptions.map(row => <option key={keyOf(row.input)} value={keyOf(row.input)} disabled={!!row.reason}>{row.label}{row.reason ? ` · ${row.reason}` : ""}</option>)}
      </select></label>
      {bindingProblem && <p role="status">{bindingProblem}</p>}
      <label>Creative direction<textarea aria-label="Creative direction" value={direction} disabled={disabled} maxLength={2000} rows={3} onChange={event => setDirection(event.currentTarget.value)} /></label>
      <fieldset disabled={disabled} className="fx-arrangement__palette"><legend>Effect palette</legend>
        {EFFECT_PRESET_CATALOGUE.map(preset => <label key={preset.id}><input type="checkbox" checked={palette.some(value => value.id === preset.id)}
          onChange={event => { const checked = event.currentTarget.checked; setPalette(values => checked ? [...values, { id: preset.id, version: preset.version }] : values.filter(value => value.id !== preset.id)); }} />{preset.label}</label>)}
      </fieldset>
      <details className="fx-arrangement__protection"><summary>Protected settings · {rules.length}</summary>
        <p>Arke must preserve these rules. They stay in place when you make a new request.</p>
        {rules.length === 0 && <p>No settings are protected from suggestions.</p>}
        {rules.slice(page * 8, (page + 1) * 8).map(rule => {
          const segments = effects.filter(value => value.lineageId === rule.lineageId), effect = segments[0];
          const label = rule.kind === "property" ? EFFECT_PROTECTION_LABELS[rule.property] : rule.kind === "boundary" ? `Exact ${rule.boundary === "start" ? "Start" : "End"}` : "Passage coverage";
          const passage = rule.kind === "passage-coverage" ? rule : rule.kind === "property" && rule.scope.kind === "passage" ? rule.scope : null;
          const values = rule.kind === "property" ? [...new Set(segments.map(segment => effectProtectionValue(segment, rule.property, timeline)))] : [];
          const value = rule.kind === "boundary" && segments.length ? formatFrames(rule.boundary === "start" ? Math.min(...segments.map(segment => segment.startFrame)) : Math.max(...segments.map(segment => segment.startFrame + segment.durationFrames)), frameRate)
            : values.length === 1 ? values[0] : values.length > 1 ? `Varies across ${segments.length} segments` : null;
          const name = EFFECT_PRESET_CATALOGUE.find(preset => preset.id === effect?.preset.id)?.label ?? rule.lineageId;
          return <p key={rule.id}>{name} · {label}{value ? ` · ${value}` : ""} · {passage ? showRange(passage) : rule.kind === "boundary" ? "logical outer boundary" : "whole effect"}</p>;
        })}
        {rules.length > 8 && <nav className="fx-arrangement__actions" aria-label="Protected setting pages"><button type="button" disabled={page === 0} onClick={() => setProtectionPage(page - 1)}>Previous</button><span>{page + 1} / {Math.ceil(rules.length / 8)}</span><button type="button" disabled={(page + 1) * 8 >= rules.length} onClick={() => setProtectionPage(page + 1)}>Next</button></nav>}
      </details>
      <p>Arke will prepare an effects-only proposal in chat. Choose Review in timeline on its card to open Suggested.</p>
      {(error || disabledReason) && <p role="alert">{disabledReason ?? error}</p>}
      <div className="fx-arrangement__footer"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={!!problem}>Prepare suggestion</button></div>
      {problem && !rangeProblem && !bindingProblem && !disabledReason && <p role="status">{problem}</p>}
    </form>
  </CutDialog>;
}
