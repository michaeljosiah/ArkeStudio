import { useEffect, useRef, useState, type CSSProperties } from "react";
import { applyTimelineCommands, effectPresetDefinition, formatFrames, ulid, type EffectClip, type FrameRate,
  type ProductionTimeline, type TimelineCommand, type TimelineClipCommand, type TimelineTrack } from "@arke-studio/contracts";
import { timecodeFrames, type PictureGesture } from "../lib/picture-edit.js";
import { ClipMenu as ClipMenuShell } from "./editor-clip-menu.js";
import { CutDialog, useCutLayout } from "./editor-responsive.js";
import { pointerIsTouch, startClipGesture } from "./editor-gesture.js";
import type { EditorTool } from "./editor-timeline.js";
import { effectTargetLabel } from "./editor-effect-target.js";
import { Eye, EyeOff, Sparkle } from "../components/icons.js";
import { IconButton } from "../components/ui.js";

export interface EffectTrackRowsProps {
  timeline: ProductionTimeline; totalFrames: number; frameRate: FrameRate; selectedEffectId: string | null;
  /** Saved/reviewed base identity, distinct from the transient timeline painted during a drag. */
  authoringRevision?: ProductionTimeline["revision"];
  playheadFrame: number; disabled: boolean; onSelect: (id: string) => void;
  onCommands: (commands: TimelineCommand[], label?: string) => void;
  onPreview: (commands: TimelineCommand[] | null) => void;
  onScrub: (frame: number) => void;
  snapFrames?: ((except: string) => readonly number[]) | null;
  tool?: EditorTool;
  onCreated?: (id: string) => void;
}

/** Effects overlap freely: each stable stack member gets its own selectable subrow. */
const ordered = (track: TimelineTrack) => [...(track.effects ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
export function effectGestureCommand(effect: EffectClip, gesture: PictureGesture, delta: number): TimelineClipCommand | null {
  const change = gesture === "move" ? Math.max(-effect.startFrame, delta) : gesture === "trim-start"
    ? Math.max(-effect.startFrame, Math.min(effect.durationFrames - 1, delta)) : Math.max(1 - effect.durationFrames, delta);
  if (!change) return null;
  return gesture === "move" ? { kind: "effect-move", clipId: effect.id, startFrame: effect.startFrame + change }
    : { kind: "effect-trim", clipId: effect.id, edge: gesture === "trim-start" ? "head" : "tail", deltaFrames: change };
}

export function EffectTrackRows(props: EffectTrackRowsProps) {
  const { timeline, totalFrames, frameRate, selectedEffectId, playheadFrame, disabled, onSelect, onCommands, onPreview, onScrub, snapFrames = null, tool = "select", onCreated } = props;
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [timing, setTiming] = useState<string | null>(null), [laneMenu, setLaneMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; start: number; duration: number; snappedTo: number | null } | null>(null);
  const active = useRef<{ controller: AbortController; id: string } | null>(null);
  const panCleanup = useRef<(() => void) | null>(null);
  const alive = useRef(true), live = useRef(props); live.current = props;
  const { phone } = useCutLayout();
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.controller.abort(); panCleanup.current?.(); }; }, []);
  useEffect(() => { if (disabled || (active.current && active.current.id !== selectedEffectId)) active.current?.controller.abort(); }, [disabled, selectedEffectId]);
  useEffect(() => () => { active.current?.controller.abort(); }, [props.authoringRevision]);
  const tracks = timeline.tracks.filter(track => track.kind === "effect").sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const effects = tracks.flatMap(track => track.effects ?? []);
  const menuEffect = effects.find(effect => effect.id === menu?.id), timingEffect = effects.find(effect => effect.id === timing);
  const menuTrack = tracks.find(track => track.id === laneMenu);
  const span = Math.max(1, totalFrames);
  const labelOf = (effect: EffectClip) => effectPresetDefinition(effect.preset).label;
  const verify = (commands: TimelineClipCommand[]) => {
    try { applyTimelineCommands(timeline, commands, { effectAuthority: "human" }); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : "This edit is unavailable."); return false; }
  };
  const send = (commands: TimelineClipCommand[], label: string) => {
    if (live.current.disabled || !commands.length || !verify(commands)) return false;
    setError(null); onPreview(null); onCommands(commands, label); return true;
  };
  const split = (effect: EffectClip, atFrame = playheadFrame) => {
    if (atFrame <= effect.startFrame || atFrame >= effect.startFrame + effect.durationFrames) return;
    send([{ kind: "effect-split", clipId: effect.id, atFrame, newClipId: `cl_${ulid()}` }], "Split effect");
  };
  const duplicate = (effect: EffectClip) => {
    const newClipId = `cl_${ulid()}`;
    let seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    if (seed === effect.seed) seed = (seed + 1) >>> 0;
    if (send([{ kind: "effect-duplicate", clipId: effect.id, newClipId, newLineageId: `ef_${ulid()}`, startFrame: effect.startFrame + effect.durationFrames, seed }], "Duplicate effect")) onCreated?.(newClipId);
  };
  const reorder = (effect: EffectClip, direction: -1 | 1) => {
    const track = tracks.find(value => value.effects?.some(row => row.id === effect.id));
    if (!track) return;
    const rows = ordered(track), from = rows.findIndex(row => row.id === effect.id), to = from + direction;
    if (to < 0 || to >= rows.length) return;
    [rows[from], rows[to]] = [rows[to]!, rows[from]!];
    send(rows.flatMap((row, order) => row.order === order ? [] : [{ kind: "effect-reorder" as const, clipId: row.id, order }]), "Reorder effects");
  };
  const reorderTrack = (track: TimelineTrack, direction: -1 | 1) => {
    const other = tracks[tracks.findIndex(row => row.id === track.id) + direction];
    if (!other) return;
    // The compiler checks each intermediate order; reserve a free slot, then swap in one Undo batch.
    const temporary = Math.max(...timeline.tracks.map(row => row.order)) + 1;
    send([{ kind: "set-track", trackId: track.id, order: temporary },
      { kind: "set-track", trackId: other.id, order: track.order },
      { kind: "set-track", trackId: track.id, order: other.order }], "Reorder effects tracks");
  };
  const pan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tool !== "hand" || event.button !== 0 || pointerIsTouch(event)) return;
    const canvas = event.currentTarget.closest<HTMLElement>(".fy-timeline__canvas");
    if (!canvas) return;
    event.preventDefault(); event.stopPropagation(); panCleanup.current?.();
    const element = event.currentTarget, start = event.clientX, scroll = canvas.scrollLeft;
    try { element.setPointerCapture?.(event.pointerId); } catch { /* Synthetic presses have no capture. */ }
    const move = (pointer: PointerEvent) => { if (pointer.pointerId === event.pointerId) canvas.scrollLeft = scroll - (pointer.clientX - start); };
    const clean = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
      try { element.releasePointerCapture?.(event.pointerId); } catch { /* Capture can already have ended. */ }
      panCleanup.current = null;
    };
    const end = (pointer: PointerEvent) => { if (pointer.pointerId === event.pointerId) clean(); };
    panCleanup.current = clean;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
  };
  const begin = (effect: EffectClip, gesture: PictureGesture) => (event: React.PointerEvent) => {
    if (event.button !== 0 || disabled || tool !== "select") return;
    const lane = (event.currentTarget as HTMLElement).closest<HTMLElement>(".fy-track__lane");
    if (!lane) return;
    if (!pointerIsTouch(event)) onSelect(effect.id);
    active.current?.controller.abort();
    const controller = new AbortController(); active.current = { controller, id: effect.id };
    const accepted = startClipGesture({ event, lane, canvas: lane.closest<HTMLElement>(".fy-timeline__canvas"), totalFrames: span, clip: effect, gesture,
      selected: effect.id === selectedEffectId, signal: controller.signal,
      onLongPress: () => { onSelect(effect.id); setMenu({ id: effect.id, x: event.clientX, y: event.clientY }); },
      snapFrames: snapFrames?.(effect.id) ?? null,
      onUpdate: update => {
        const command = effectGestureCommand(effect, gesture, update.deltaFrames);
        if (!command || !verify([command])) { onPreview(null); setDrag(null); return; }
        const start = command.kind === "effect-move" ? command.startFrame : command.kind === "effect-trim" && command.edge === "head" ? effect.startFrame + command.deltaFrames : effect.startFrame;
        const duration = command.kind !== "effect-trim" ? effect.durationFrames : effect.durationFrames + (command.edge === "head" ? -command.deltaFrames : command.deltaFrames);
        setError(null); setDrag({ id: effect.id, start, duration, snappedTo: update.snappedTo }); onPreview([command]);
        if (gesture !== "move") onScrub(gesture === "trim-start" ? start : start + duration - 1);
      },
      onEnd: final => {
        active.current = null;
        onPreview(null);
        if (!alive.current) return;
        setDrag(null);
        if (!final || live.current.disabled) return;
        const command = effectGestureCommand(effect, gesture, final.deltaFrames);
        if (command) send([command], gesture === "move" ? "Move effect" : "Trim effect");
      },
    });
    if (!accepted) active.current = null;
  };
  const openMenu = (effect: EffectClip, x: number, y: number) => { onSelect(effect.id); setMenu({ id: effect.id, x, y }); };
  const keyboard = (effect: EffectClip) => (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) {
      const box = event.currentTarget.getBoundingClientRect(); openMenu(effect, box.left, box.bottom);
    } else if (disabled) return;
    else if (["Delete", "Backspace"].includes(event.key)) send([{ kind: "effect-remove", clipId: effect.id }], "Remove effect");
    else if (event.key.toLowerCase() === "d") duplicate(effect);
    else if (event.key.toLowerCase() === "s") split(effect);
    else if (event.key === "[" || event.key === "]") reorder(effect, event.key === "[" ? -1 : 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const command = effectGestureCommand(effect, "move", (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1));
      if (command) send([command], "Move effect");
    } else return;
    event.preventDefault(); event.stopPropagation();
  };
  return <>
    {tracks.map(track => <div key={track.id} className="fy-track fy-effect-track" data-track="effect" data-track-id={track.id} data-hidden={track.muted || undefined}>
      <div className="fy-track__label fy-track__label--typed">
        <IconButton type="button" className="fy-effect-track__settings fy-cut-lane-open" label={`${track.name} effects track settings`} onClick={() => setLaneMenu(track.id)}><Sparkle size={16} /></IconButton>
        {!phone && <><span className="fy-track__name">{track.name}</span><IconButton type="button" className="fy-effect-track__visibility" disabled={disabled} aria-pressed={track.muted === true}
          label={`${track.muted ? "Show" : "Hide"} ${track.name}`} onClick={() => send([{ kind: "set-track", trackId: track.id, muted: !track.muted }], track.muted ? "Show effects track" : "Hide effects track")}>{track.muted ? <EyeOff size={16} /> : <Eye size={16} />}</IconButton></>}
      </div>
      <div className={`fy-track__lane fy-effect-track__lane${tool === "hand" ? " fy-pictlane--hand" : tool === "blade" ? " fy-pictlane--blade" : ""}`} onPointerDown={pan} style={{ "--effect-row-count": Math.max(1, track.effects?.length ?? 0) } as CSSProperties}>
        {!track.effects?.length && <span className="fy-track__empty">Add an effect from the Library</span>}
        {ordered(track).map((effect, index) => {
          const position = drag?.id === effect.id ? drag : { start: effect.startFrame, duration: effect.durationFrames };
          const protectedEffect = timeline.effectProtection?.some(rule => rule.lineageId === effect.lineageId);
          const name = labelOf(effect), description = `${name} · ${effectTargetLabel(effect.target, timeline)} · ${formatFrames(position.start, frameRate)} to ${formatFrames(position.start + position.duration, frameRate)}${protectedEffect ? " · Protected from suggestions" : ""}${track.muted ? " · Hidden" : ""}`;
          return <button type="button" key={effect.id} data-clip={effect.id} data-effect={effect.id} className="fy-effect-clip"
            aria-label={description} title={description} aria-pressed={effect.id === selectedEffectId}
            style={{ left: `${position.start / span * 100}%`, width: `${position.duration / span * 100}%`, top: `calc(${index} * var(--effect-row-height) + 4px)` }}
            onPointerDown={begin(effect, "move")} onKeyDown={keyboard(effect)} onContextMenu={event => { event.preventDefault(); openMenu(effect, event.clientX, event.clientY); }}
            onClick={event => {
              if (tool === "hand") return;
              onSelect(effect.id);
              if (tool === "blade" && !disabled) { const lane = event.currentTarget.closest<HTMLElement>(".fy-track__lane")!, box = lane.getBoundingClientRect(); split(effect, Math.round((event.clientX - box.left) / Math.max(1, box.width) * span)); }
            }}>
            <span className="fy-effect-clip__grip fy-pictclip__grip fy-pictclip__grip--start" aria-hidden="true" onPointerDown={begin(effect, "trim-start")}><i /></span>
            <span className="fy-effect-clip__name">✦ {name}</span><span className="fy-effect-clip__detail">{protectedEffect ? "Protected · " : ""}{track.muted ? "Hidden" : effect.reaction.enabled ? "Reaction On" : "Reaction Off"}</span>
            <span className="fy-effect-clip__grip fy-pictclip__grip fy-pictclip__grip--end" aria-hidden="true" onPointerDown={begin(effect, "trim-end")}><i /></span>
          </button>;
        })}
        {drag && track.effects?.some(effect => effect.id === drag.id) && <span className="fy-effect-track__time" role="status">{formatFrames(drag.start, frameRate)} – {formatFrames(drag.start + drag.duration, frameRate)}{drag.snappedTo !== null ? " · Snapped" : ""}</span>}
      </div>
    </div>)}
    {error && <p className="fy-effect-track__error" role="alert">{error}</p>}
    {menu && menuEffect && <ClipMenuShell at={menu} label={`Actions for ${labelOf(menuEffect)}`} onClose={() => setMenu(null)}>
      <button type="button" role="menuitem" onClick={() => { setTiming(menuEffect.id); setMenu(null); }}>Edit timing…</button>
      <button type="button" role="menuitem" disabled={disabled || playheadFrame <= menuEffect.startFrame || playheadFrame >= menuEffect.startFrame + menuEffect.durationFrames} onClick={() => { split(menuEffect); setMenu(null); }}>Split at playhead <kbd>S</kbd></button>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => { duplicate(menuEffect); setMenu(null); }}>Duplicate effect <kbd>D</kbd></button>
      {([-1, 1] as const).map(direction => { const rows = ordered(tracks.find(track => track.effects?.some(effect => effect.id === menuEffect.id))!); const position = rows.findIndex(effect => effect.id === menuEffect.id);
        return <button type="button" role="menuitem" key={direction} disabled={disabled || (direction === -1 ? position === 0 : position === rows.length - 1)} onClick={() => { reorder(menuEffect, direction); setMenu(null); }}>{direction === -1 ? "Earlier" : "Later"} in effect stack</button>; })}
      <button type="button" role="menuitem" disabled={disabled} onClick={() => { send([{ kind: "effect-remove", clipId: menuEffect.id }], "Remove effect"); setMenu(null); }}>Remove effect</button>
    </ClipMenuShell>}
    {timingEffect && <EffectTimingDialog effect={timingEffect} frameRate={frameRate} playheadFrame={playheadFrame} disabled={disabled} externalError={error}
      onClose={() => setTiming(null)} onCommand={command => { if (send([command], "Edit effect timing")) setTiming(null); }} />}
    {menuTrack && <CutDialog open title={`${menuTrack.name} · Effects track`} onClose={() => setLaneMenu(null)}><div className="fy-effect-lane-settings">
      <label>Name<input aria-label="Effects track name" defaultValue={menuTrack.name} disabled={disabled} onBlur={event => { const name = event.currentTarget.value.trim(); if (name && name !== menuTrack.name) send([{ kind: "set-track", trackId: menuTrack.id, name }], "Rename effects track"); }} /></label>
      <button type="button" disabled={disabled} aria-pressed={menuTrack.muted === true} onClick={() => send([{ kind: "set-track", trackId: menuTrack.id, muted: !menuTrack.muted }], "Change effects visibility")}>{menuTrack.muted ? "Show" : "Hide"} effects</button>
      {([-1, 1] as const).map(direction => <button type="button" key={direction} disabled={disabled || (direction === -1 ? tracks[0]?.id === menuTrack.id : tracks.at(-1)?.id === menuTrack.id)} onClick={() => reorderTrack(menuTrack, direction)}>{direction === -1 ? "Earlier" : "Later"} effects track</button>)}
      <button type="button" disabled={disabled || !!menuTrack.effects?.length} onClick={() => { if (send([{ kind: "remove-track", trackId: menuTrack.id }], "Remove effects track")) setLaneMenu(null); }}>Remove empty track</button>
      <button type="button" onClick={() => setLaneMenu(null)}>Done</button>
    </div></CutDialog>}
  </>;
}

function EffectTimingDialog({ effect, frameRate, playheadFrame, disabled, externalError, onClose, onCommand }: {
  effect: EffectClip; frameRate: FrameRate; playheadFrame: number; disabled: boolean; externalError: string | null; onClose: () => void; onCommand: (command: TimelineClipCommand) => void;
}) {
  const [mode, setMode] = useState("move"), [text, setText] = useState(formatFrames(effect.startFrame, frameRate)), [error, setError] = useState<string | null>(null);
  const at = timecodeFrames(text, frameRate), end = effect.startFrame + effect.durationFrames;
  const submit = () => {
    if (disabled) return;
    if (at === null || mode === "head" && at >= end || mode === "tail" && at <= effect.startFrame || mode === "split" && (at <= effect.startFrame || at >= end)) { setError("Enter a valid frame that leaves at least one frame in the effect."); return; }
    const command: TimelineClipCommand = mode === "move" ? { kind: "effect-move", clipId: effect.id, startFrame: at } : mode === "split"
      ? { kind: "effect-split", clipId: effect.id, atFrame: at, newClipId: `cl_${ulid()}` }
      : { kind: "effect-trim", clipId: effect.id, edge: mode === "head" ? "head" : "tail", deltaFrames: at - (mode === "head" ? effect.startFrame : end) };
    if (command.kind === "effect-move" && at === effect.startFrame || command.kind === "effect-trim" && command.deltaFrames === 0) { onClose(); return; }
    onCommand(command);
  };
  return <CutDialog open title="Effect timing" onClose={onClose}><form className="fy-effect-timing" onSubmit={event => { event.preventDefault(); submit(); }}>
    <label>Action<select aria-label="Effect timing action" value={mode} disabled={disabled} onChange={event => { const value = event.currentTarget.value; setMode(value); setText(formatFrames(value === "tail" ? end : value === "split" ? playheadFrame : effect.startFrame, frameRate)); setError(null); }}>
      <option value="move">Move effect</option><option value="head">Trim start</option><option value="tail">Trim end</option><option value="split">Split at time</option>
    </select></label>
    <label>{mode === "tail" ? "End" : mode === "split" ? "Split at" : "Start"}<input aria-label="Effect timing value" value={text} disabled={disabled} onChange={event => setText(event.currentTarget.value)} /></label>
    <span>HH:MM:SS:FF · {frameRate} fps{at !== null ? ` · ${at} frames` : ""}</span>
    {(error || externalError) && <p role="alert">{error ?? externalError}</p>}
    <div><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={disabled || at === null}>Apply timing</button></div>
  </form></CutDialog>;
}
