import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { audioSamples, audioSeconds, formatTimingSeconds, ulid, type AudioArrangementCommand, type AudioArrangementState, type ResolvedAudioArrangement, type ResolvedAudioClip } from "@arke-studio/contracts";
import { AudioPlus, Copy, Hand, Minus, Plus, Pointer, RotateCcw, RotateCw, Scissors, Snap, SplitMark, Trash, Waveform } from "../components/icons.js";
import { cx } from "../components/ui.js";
import { startClipGesture, type GestureUpdate } from "./editor-gesture.js";
import type { EditorTool } from "./editor-timeline.js";
import type { PictureGesture } from "../lib/picture-edit.js";
import { audioGestureCommand } from "../lib/audio-studio-gesture.js";
import { ARTIFACT_DRAG_TYPE, LANE_DRAG_SOUND } from "./editor-audio.js";

export function AudioStudioTimeline({ state, plan, selected, selectedTrack, onSelect, onTrack, at, onSeek, disabled,
  undo, redo, onHistory, onEdit, solo, onSolo, onDrop, onFiles,
}: {
  state: AudioArrangementState; plan: ResolvedAudioArrangement; selected: string | null; selectedTrack: string | null;
  onSelect: (id: string) => void; onTrack: (id: string) => void; at: number; onSeek: (samples: number) => void; disabled: boolean;
  undo: string | null; redo: string | null; onHistory: (kind: "undo" | "redo") => void;
  onEdit: (label: string, commands: AudioArrangementCommand[]) => void; solo: readonly string[]; onSolo: (id: string) => void;
  onDrop: (artifactId: string, trackId: string, samples: number) => void; onFiles: (files: File[], trackId: string, samples: number) => void;
}) {
  const [tool, setTool] = useState<EditorTool>("select"), [snap, setSnap] = useState(true), [zoom, setZoom] = useState(1);
  const [gesture, setGesture] = useState<GestureUpdate<string> | null>(null);
  const canvas = useRef<HTMLDivElement>(null), controller = useRef<AbortController | null>(null);
  useEffect(() => { controller.current?.abort(); setGesture(null); return () => controller.current?.abort(); }, [state, disabled]);
  const span = Math.max(audioSamples(10), plan.samples + audioSamples(2)), percent = (samples: number) => `${samples / span * 100}%`;
  const picked = plan.clips.find(entry => entry.clip.id === selected);
  const canEdit = !disabled && picked !== undefined && !picked.clip.protected;
  const canSplit = canEdit && !picked.clip.loop && picked.clip.placement.kind !== "range" && at > picked.at && at < picked.at + picked.samples;
  const split = (entry: ResolvedAudioClip, point: number) => {
    if (disabled || entry.clip.protected || entry.clip.loop || entry.clip.placement.kind === "range" || point <= entry.at || point >= entry.at + entry.samples) return;
    onEdit("Split clip", [{ kind: "split-clip", id: entry.clip.id, nextId: ulid(), at: point - entry.at }]);
  };
  const editSelected = (kind: "split" | "duplicate" | "remove") => {
    if (!picked || !canEdit) return;
    if (kind === "split") split(picked, at);
    else onEdit(kind === "remove" ? "Remove clip" : "Duplicate clip", [kind === "remove" ? { kind: "remove-clip", id: picked.clip.id } : { kind: "duplicate-clip", id: picked.clip.id, nextId: ulid(), at: picked.at + picked.samples }]);
  };
  const point = (element: HTMLElement, clientX: number) => {
    const box = element.getBoundingClientRect(); return Math.max(0, Math.min(span, Math.round((clientX - box.left) / Math.max(1, box.width) * span)));
  };
  const begin = (entry: ResolvedAudioClip, kind: PictureGesture) => (event: ReactPointerEvent) => {
    if (disabled || entry.clip.protected || tool !== "select") return;
    const lane = (event.currentTarget as HTMLElement).closest<HTMLElement>(".fy-track__lane"); if (!lane) return;
    controller.current?.abort(); controller.current = new AbortController();
    const wasSelected = selected === entry.clip.id;
    onSelect(entry.clip.id);
    startClipGesture({ event, lane, canvas: canvas.current, totalFrames: span, clip: { id: entry.clip.id, startFrame: entry.at, durationFrames: entry.samples }, selected: wasSelected,
      gesture: kind, signal: controller.current.signal, snapFrames: snap ? [0, at, ...plan.clips.filter(other => other.clip.id !== entry.clip.id).flatMap(other => [other.at, other.at + other.samples])] : null,
      onUpdate: setGesture, onEnd: update => { setGesture(null); if (update) { const command = audioGestureCommand(entry, kind, update.deltaFrames); if (command) onEdit(kind === "move" ? "Move clip" : "Trim clip", [command]); } } });
  };
  const pan = (event: ReactPointerEvent) => {
    if (tool !== "hand" || event.button !== 0 || !canvas.current) return;
    event.preventDefault(); controller.current?.abort(); controller.current = new AbortController();
    const element = event.currentTarget as HTMLElement, signal = controller.current.signal; let x = event.clientX;
    element.setPointerCapture?.(event.pointerId);
    element.addEventListener("pointermove", next => { if (canvas.current) canvas.current.scrollLeft -= next.clientX - x; x = next.clientX; }, { signal });
    const stop = () => { if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId); controller.current?.abort(); };
    element.addEventListener("pointerup", stop, { signal }); element.addEventListener("pointercancel", stop, { signal });
  };
  return <section className="fy-timeline fy-audio-timeline" aria-label="Audio timeline" tabIndex={0} onKeyDown={event => {
    if ((event.target as HTMLElement).matches("input,select,textarea,[contenteditable=true]")) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") { event.preventDefault(); if (!disabled && (event.shiftKey ? redo : undo)) onHistory(event.shiftKey ? "redo" : "undo"); }
    else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      if (key === "v" || key === "b" || key === "h") setTool(key === "v" ? "select" : key === "b" ? "blade" : "hand");
      else if (["s", "d", "delete", "backspace"].includes(key)) { event.preventDefault(); editSelected(key === "s" ? "split" : key === "d" ? "duplicate" : "remove"); }
    }
  }}>
    <div className="fy-timeline__toolbar"><strong>TIMELINE</strong><span className="fy-timeline__meta">{state.tracks.length} tracks · {state.clips.length} clips</span>
      <span className="fy-timeline__tools" role="group" aria-label="Tools">{([ ["select", "Select", Pointer], ["blade", "Blade", Scissors], ["hand", "Hand", Hand] ] as const).map(([value, label, Icon]) => <button type="button" key={value} className="fy-tlbtn fy-tip" aria-label={label} data-tip={label} aria-pressed={tool === value} onClick={() => setTool(value)}><Icon size={12} /></button>)}</span>
      <span className="fy-h1row__push" />
      <span className="fy-timeline__group" role="group" aria-label="History"><button type="button" className="fy-tlbtn fy-tip" aria-label="Undo" data-tip={undo ? `Undo ${undo}` : "Undo"} disabled={disabled || !undo} onClick={() => onHistory("undo")}><RotateCcw size={12} /></button><button type="button" className="fy-tlbtn fy-tip" aria-label="Redo" data-tip={redo ? `Redo ${redo}` : "Redo"} disabled={disabled || !redo} onClick={() => onHistory("redo")}><RotateCw size={12} /></button></span>
      <button type="button" className="fy-tlbtn fy-tip" aria-label="Add audio track" data-tip="Add audio track" disabled={disabled} onClick={() => onEdit("Add audio track", [{ kind: "add-track", track: { id: ulid(), name: `Audio ${state.tracks.length + 1}`, gainDb: 0, muted: false } }])}><AudioPlus size={12} /></button>
      <span className="fy-timeline__group" role="group" aria-label="Edit"><button type="button" className="fy-tlbtn fy-tip" aria-label="Split" data-tip="Split at playhead · S" disabled={!canSplit} onClick={() => editSelected("split")}><SplitMark size={12} /></button><button type="button" className="fy-tlbtn fy-tip" aria-label="Duplicate" data-tip="Duplicate · D" disabled={!canEdit} onClick={() => editSelected("duplicate")}><Copy size={12} /></button><button type="button" className="fy-tlbtn fy-tip" aria-label="Delete" data-tip="Delete clip" disabled={!canEdit} onClick={() => editSelected("remove")}><Trash size={12} /></button></span>
      <button type="button" className="fy-tlbtn fy-tip" aria-label="Snap" data-tip="Snap to clip boundaries" aria-pressed={snap} onClick={() => setSnap(value => !value)}><Snap size={12} /></button>
      <button type="button" className="fy-tlbtn fy-tip" aria-label="Zoom out" data-tip="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value / 1.5))}><Minus size={12} /></button><button type="button" className="fy-tlbtn fy-tip" aria-label="Zoom in" data-tip="Zoom in" disabled={zoom >= 32} onClick={() => setZoom(value => Math.min(32, value * 1.5))}><Plus size={12} /></button>
    </div>
    <div className="fy-audio-timeline__position"><label>Playhead <input aria-label="Playhead seconds" type="number" min={0} step={0.001} value={Number(audioSeconds(at).toFixed(5))} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) onSeek(Math.max(0, audioSamples(value))); }} /> s</label><span>{formatTimingSeconds(audioSeconds(plan.samples))} · 48 kHz stereo</span></div>
    <div className="fy-timeline__canvas" ref={canvas}><div className="fy-audio-timeline__tracks" style={{ width: `${zoom * 100}%`, minWidth: "100%" }}>
      <div className="fy-track fy-audio-timeline__ruler"><span className="fy-track__label">Seconds</span><div className="fy-track__lane" onClick={event => onSeek(point(event.currentTarget, event.clientX))}>{Array.from({ length: 11 }, (_, i) => <span key={i} style={{ left: `${i * 10}%` }}>{formatTimingSeconds(audioSeconds(span * i / 10))}</span>)}</div></div>
      {state.tracks.map(track => <div className={cx("fy-track", track.muted && "fy-track--silent")} data-track="music" data-track-id={track.id} key={track.id}>
        <div className="fy-track__label fy-track__label--typed"><Waveform size={12} /><button type="button" className="fy-track__name" aria-pressed={selectedTrack === track.id} onClick={() => onTrack(track.id)}>{track.name}</button><span className="fy-trackbtns"><button type="button" aria-label={`Mute ${track.name} in mix`} aria-pressed={track.muted} disabled={disabled} onClick={() => onEdit("Set track mute", [{ kind: "set-track", id: track.id, changes: { muted: !track.muted } }])}>M</button><button type="button" aria-label={`Solo ${track.name} for audition`} aria-pressed={solo.includes(track.id)} onClick={() => onSolo(track.id)}>S</button></span></div>
        <div className={cx("fy-track__lane", "fy-typedlane", tool === "hand" && "fy-pictlane--hand", tool === "blade" && "fy-pictlane--blade")} onPointerDown={pan}
          onDragOver={event => { if (!disabled && (event.dataTransfer.types.includes(LANE_DRAG_SOUND) || event.dataTransfer.types.includes("Files"))) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
          onDrop={event => { event.preventDefault(); if (disabled) return; const position = point(event.currentTarget, event.clientX); if (event.dataTransfer.files.length) onFiles([...event.dataTransfer.files], track.id, position); else { const id = event.dataTransfer.getData(ARTIFACT_DRAG_TYPE); if (id) onDrop(id, track.id, position); } }}>
          {!state.clips.some(clip => clip.trackId === track.id) && <span className="fy-track__empty">Drop sound here</span>}
          <i className="fy-audio-timeline__head" style={{ left: percent(at) }} />
          {plan.clips.filter(entry => entry.clip.trackId === track.id).map(entry => {
            const delta = gesture?.clipId === entry.clip.id ? gesture.deltaFrames : 0;
            const start = entry.at + (gesture?.gesture !== "trim-end" ? delta : 0), length = entry.samples + (gesture?.gesture === "trim-end" ? delta : gesture?.gesture === "trim-start" ? -delta : 0);
            return <button type="button" key={entry.clip.id} data-clip={entry.clip.id} className={cx("fy-typedclip", "fy-typedclip--audio", selected === entry.clip.id && "fy-typedclip--selected")} aria-pressed={selected === entry.clip.id} aria-label={`${entry.clip.label}, ${formatTimingSeconds(audioSeconds(entry.at))}, ${entry.clip.role}`} style={{ left: percent(start), width: `${Math.max(length / span * 100, 0.6)}%` }} onPointerDown={begin(entry, "move")} onClick={event => { onSelect(entry.clip.id); if (tool === "blade") split(entry, point(event.currentTarget.parentElement!, event.clientX)); }}>
              <span className="fy-pictclip__grip fy-pictclip__grip--start" onPointerDown={begin(entry, "trim-start")} aria-hidden="true"><i /></span><span className="fy-typedclip__name">{entry.clip.label}</span><span className="fy-typedclip__gain">{entry.clip.protected ? "Protected · " : ""}{entry.clip.role}{entry.clip.gainDb ? ` · ${entry.clip.gainDb} dB` : ""}</span><span className="fy-pictclip__grip fy-pictclip__grip--end" onPointerDown={begin(entry, "trim-end")} aria-hidden="true"><i /></span>
            </button>;
          })}
        </div>
      </div>)}
    </div></div>
  </section>;
}
