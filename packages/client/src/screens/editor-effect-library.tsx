import { useEffect, useRef, useState } from "react";
import { applyTimelineCommands, defaultEffectClip, EFFECT_PRESET_CATALOGUE, formatFrames, renderEffectLayersRgba, ulid,
  type EffectClip, type EffectTarget, type FrameRate, type ProductionTimeline, type TimelineCommand, type TimelineClipCommand } from "@arke-studio/contracts";
import { timecodeFrames } from "../lib/picture-edit.js";
import { CutDialog } from "./editor-responsive.js";
import { EffectTargetSelect } from "./editor-effect-target.js";

export interface EffectLibraryProps {
  timeline: ProductionTimeline | null;
  frameRate: FrameRate;
  pictureDurationFrames: number;
  selectedPictureId: string | null;
  playheadFrame: number;
  disabled: boolean;
  onCommands: (commands: TimelineCommand[], label?: string) => void;
  onCreated: (id: string) => void;
  onSuggest?: () => void;
}

const descriptions: Record<EffectClip["preset"]["id"], string> = {
  "air-particles": "Textured, dispersed floating particles",
  dust: "Soft particles drifting through the picture", embers: "Warm sparks rising through the air", snow: "Gentle falling flakes",
  lights: "Slow, softly glowing lights", rain: "Fine streaks falling across the picture", smoke: "Soft clouds moving through the scene",
};

function PresetThumbnail({ preset }: { preset: EffectClip["preset"]["id"] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext?.("2d");
    if (!context) return;
    const effect = defaultEffectClip({ id: "cl_thumbnail", lineageId: "ef_thumbnail", startFrame: 0, durationFrames: 240, seed: 42, preset });
    effect.appearance = { ...effect.appearance, amount: .7, size: .7, opacity: .9 };
    const image = context.createImageData(144, 80);
    image.data.set(renderEffectLayersRgba([effect], 96, 24, 144, 80)); context.putImageData(image, 0, 0);
  }, [preset]);
  return <canvas ref={canvas} width={144} height={80} aria-hidden="true" className="fy-effect-library__thumbnail" />;
}

export function EffectLibrary(props: EffectLibraryProps) {
  const [preset, setPreset] = useState<EffectClip["preset"]["id"]>("dust"), [adding, setAdding] = useState(false);
  const definition = EFFECT_PRESET_CATALOGUE.find(value => value.id === preset)!;
  return <section className="fy-effect-library" aria-label="Effects library">
    <p>Atmosphere over any picture. Audio reaction is optional.</p>
    {props.onSuggest && <button type="button" disabled={props.disabled} onClick={props.onSuggest}>Suggest arrangement</button>}
    <div className="fy-effect-library__presets" role="group" aria-label="Effect presets">
      {EFFECT_PRESET_CATALOGUE.map(choice => <button type="button" key={choice.id} aria-pressed={preset === choice.id}
        aria-label={choice.label} onClick={() => setPreset(choice.id)}>
        <PresetThumbnail preset={choice.id} /><strong>{choice.label}</strong><span>{descriptions[choice.id]}</span>
      </button>)}
    </div>
    <button type="button" className="fy-effect-library__add" disabled={props.disabled || !props.timeline} onClick={() => setAdding(true)}>Add effect</button>
    {!props.timeline && <p role="status">Open the timeline to add an effect.</p>}
    {adding && props.timeline && <AddEffectDialog {...props} timeline={props.timeline} preset={preset} label={definition.label} onClose={() => setAdding(false)} />}
  </section>;
}

function AddEffectDialog({ timeline, frameRate, pictureDurationFrames, selectedPictureId, playheadFrame, disabled, onCommands, onCreated, preset, label, onClose }: EffectLibraryProps & {
  timeline: ProductionTimeline; preset: EffectClip["preset"]["id"]; label: string; onClose: () => void;
}) {
  const picture = timeline.tracks.filter(track => track.kind === "picture").flatMap(track => track.clips).find(clip => clip.id === selectedPictureId);
  const [target, setTarget] = useState<EffectTarget>({ kind: "composition" });
  const [start, setStart] = useState(() => formatFrames(Math.max(0, playheadFrame), frameRate));
  const [end, setEnd] = useState(() => formatFrames(pictureDurationFrames > playheadFrame ? pictureDurationFrames : playheadFrame + frameRate * 5, frameRate));
  const [error, setError] = useState<string | null>(null);
  const [trackId, setTrackId] = useState(() => timeline.tracks.find(track => track.kind === "effect")?.id ?? "new");
  const startFrame = timecodeFrames(start, frameRate), endFrame = timecodeFrames(end, frameRate);
  const validRange = startFrame !== null && endFrame !== null && endFrame > startFrame;
  const copyRange = (from: number, to: number) => { setStart(formatFrames(from, frameRate)); setEnd(formatFrames(to, frameRate)); setError(null); };
  const add = () => {
    if (disabled || !validRange) return;
    const id = `cl_${ulid()}`, lineageId = `ef_${ulid()}`;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const existing = timeline.tracks.find(track => track.id === trackId && track.kind === "effect");
    if (trackId !== "new" && !existing) { setError("The effects track changed. Choose a track again."); return; }
    const destination = existing?.id ?? `tr_${ulid()}`;
    const effect = defaultEffectClip({ id, lineageId, seed, preset, target, startFrame, durationFrames: endFrame - startFrame,
      order: existing ? Math.max(-1, ...(existing.effects ?? []).map(value => value.order)) + 1 : 0 });
    const commands: TimelineClipCommand[] = [
      ...(existing ? [] : [{ kind: "add-track" as const, trackId: destination, trackKind: "effect" as const, name: "Effects", order: Math.max(-1, ...timeline.tracks.map(track => track.order)) + 1 }]),
      { kind: "effect-create", trackId: destination, effect },
    ];
    try { applyTimelineCommands(timeline, commands, { effectAuthority: "human" }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "This effect could not be added."); return; }
    onCommands(commands, `Add ${label}`); onCreated(id); onClose();
  };
  return <CutDialog open title={`Add ${label}`} subtitle="Choose where it appears and when it runs." onClose={onClose}>
    <form className="fy-effect-add" onSubmit={event => { event.preventDefault(); add(); }}>
      <EffectTargetSelect value={target} timeline={timeline} disabled={disabled} onChange={setTarget} />
      <fieldset disabled={disabled}><legend>Time range</legend>
        <div className="fy-effect-add__ranges">
          <button type="button" disabled={pictureDurationFrames < 1} onClick={() => copyRange(0, pictureDurationFrames)}>Whole video</button>
          <button type="button" disabled={!picture} onClick={() => picture && copyRange(picture.startFrame, picture.startFrame + picture.durationFrames)}>Selected picture</button>
          <button type="button" disabled aria-describedby="effect-range-unavailable">Selected range</button>
        </div>
        <span id="effect-range-unavailable" className="fy-effect-add__hint">Selected range is unavailable until a timeline range is selected.</span>
        <div className="fy-effect-add__times"><label>Start<input aria-label="Effect start" value={start} onChange={event => setStart(event.currentTarget.value)} /></label>
          <label>End<input aria-label="Effect end" value={end} onChange={event => setEnd(event.currentTarget.value)} /></label></div>
        <span className="fy-effect-add__hint">HH:MM:SS:FF · {frameRate} fps. These bounds are copied, not linked to sound.</span>
        <output aria-live="polite">{validRange ? `${formatFrames(startFrame, frameRate)} – ${formatFrames(endFrame, frameRate)} · ${endFrame - startFrame} frames`
          : "Enter a valid start and an end at least one frame later."}</output>
      </fieldset>
      <label>Effects track<select aria-label="Effects track" value={trackId} disabled={disabled} onChange={event => setTrackId(event.currentTarget.value)}>
        {timeline.tracks.filter(track => track.kind === "effect").map(track => <option key={track.id} value={track.id}>{track.name}{track.muted ? " · hidden" : ""}</option>)}
        <option value="new">New effects track</option>
      </select></label>
      <p>Audio reaction · Off. Choose sound later in Inspector.</p>
      {error && <p role="alert">{error}</p>}
      <div className="fy-effect-add__actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={disabled || !validRange}>Add effect</button></div>
    </form>
  </CutDialog>;
}
