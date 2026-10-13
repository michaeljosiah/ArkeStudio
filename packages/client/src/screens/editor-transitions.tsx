import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { crossfadeWindow, formatFrames, maxCrossfadeFrames, pictureJoins, planCrossfadeBatch, sameTransitionPair, transitionInactiveReason,
  transitionKey, transitionStill, type ArtifactSidecar, type Crossfade, type PictureJoin, type ProductionTimeline, type TimelineClipCommand, type TransitionPair } from "@arke-studio/contracts";
import type { CutTransport } from "./editor-transport.js";

const DRAG = "application/x-arke-transition";
type Context = { timeline: ProductionTimeline | null; artifacts: readonly ArtifactSidecar[]; disabled: boolean;
  selected: TransitionPair | null; select: (pair: TransitionPair | null) => void; send: (commands: TimelineClipCommand[], label?: string) => void;
  open: (join: PictureJoin, anchor: HTMLElement, replace?: boolean) => void; batch: () => void; dragging: boolean; setDragging: (dragging: boolean) => void;
  preview: (join: PictureJoin, value: Crossfade) => void; previewing: boolean; pending?: boolean; adjustedKeys?: readonly string[] };
const Transitions = createContext<Context | null>(null);
const pairOf = (join: TransitionPair): TransitionPair => ({ trackId: join.trackId, leftClipId: join.leftClipId, rightClipId: join.rightClipId });
const seconds = (frames: number, fps: number) => `${(frames / fps).toFixed(2)}s`;
const name = (join: PictureJoin) => `${join.left.source.label} → ${join.right.source.label}`;

export function TransitionProvider({ children, transport, onInspect, onBatchChange, ...input }: Omit<Context, "open" | "batch" | "dragging" | "setDragging" | "preview" | "previewing"> & {
  children: ReactNode; transport: CutTransport; onInspect: (openingPicker?: boolean) => void; onBatchChange?: (open: boolean) => void;
}) {
  const [picker, setPicker] = useState<{ join: PictureJoin; anchor: HTMLElement; replace: boolean } | null>(null);
  const [batch, setBatch] = useState(false), [dragging, setDragging] = useState(false);
  const batchAnchor = useRef<HTMLElement | null>(null);
  const [loop, setLoop] = useState<{ start: number; end: number } | null>(null);
  const live = useRef(transport); live.current = transport;
  useEffect(() => { if (!transport.playing) setLoop(null); }, [transport.playing]);
  useEffect(() => {
    if (!loop || !transport.playing) return;
    let frame = 0;
    const tick = () => { if (live.current.timeRef.current >= loop.end || live.current.timeRef.current < loop.start) live.current.seek(loop.start); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [loop, transport.playing]);
  const dismiss = () => { const anchor = picker?.anchor; setPicker(null); requestAnimationFrame(() => anchor?.isConnected && anchor.focus()); };
  const context: Context = { ...input, select: pair => { input.select(pair); if (pair) onInspect(); },
    open: (join, anchor, replace = false) => { if (!input.disabled) { input.select(pairOf(join)); onInspect(true); setPicker({ join, anchor, replace }); } },
    batch: () => { batchAnchor.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; onBatchChange?.(true); onInspect(); setBatch(true); }, dragging, setDragging,
    previewing: !!loop && transport.playing,
    preview: (join, value) => { const window = crossfadeWindow(join.cutFrame, value.durationFrames), fps = input.timeline!.frameRate;
      if (loop && transport.playing) { setLoop(null); transport.setPlaying(false); return; }
      const end = Math.max(...input.timeline!.tracks.filter(track => track.kind === "picture").flatMap(track => track.clips.map(clip => clip.startFrame + clip.durationFrames)));
      const range = { start: Math.max(0, window.startFrame / fps - 0.5), end: Math.min(end / fps, window.endFrame / fps + 0.5) };
      setLoop(range); transport.seek(range.start); transport.setPlaying(true);
    } };
  return <Transitions.Provider value={context}>{children}{picker && input.timeline && <TransitionPicker picker={picker} close={dismiss} />}
    {batch && input.timeline && <TransitionBatch close={() => { setBatch(false); onBatchChange?.(false); requestAnimationFrame(() => batchAnchor.current?.isConnected && batchAnchor.current.focus()); }} />}</Transitions.Provider>;
}

function Tile({ onClick, draggable = false }: { onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; draggable?: boolean }) {
  const context = useContext(Transitions)!;
  return <button type="button" className="xf-transition-tile" draggable={draggable && !context.disabled} disabled={context.disabled} onClick={onClick}
    onDragStart={event => { event.dataTransfer.setData(DRAG, "crossfade"); event.dataTransfer.effectAllowed = "copy"; context.setDragging(true); }} onDragEnd={() => context.setDragging(false)}>
    <span className="xf-transition-art" aria-hidden="true"><i /><i /><b>⋈</b></span><span><b>Crossfade</b><small>Blend two images · 1.00s default</small></span></button>;
}
export function TransitionLibrary() {
  const context = useContext(Transitions);
  const [choosing, setChoosing] = useState(false);
  if (!context?.timeline) return <p className="xf-meta">Place two still images on Picture to add transitions.</p>;
  const joins = pictureJoins(context.timeline.tracks, clip => transitionStill(clip, context.artifacts));
  const inactive = (context.timeline.transitions ?? []).flatMap(value => { const reason = transitionInactiveReason(context.timeline!.tracks, context.timeline!.transitions ?? [], value, clip => transitionStill(clip, context.artifacts)); return reason ? [{ value, reason }] : []; });
  return <div className="xf-transition-library"><h3>Transitions</h3><p className="xf-meta">Choose at a cut, or drag onto its boundary.</p>
    <Tile draggable onClick={event => { const join = joins.find(join => context.selected && sameTransitionPair(join, context.selected));
      if (join && !join.reason) context.open(join, event.currentTarget, context.timeline!.transitions?.some(value => sameTransitionPair(value, join))); else setChoosing(value => !value); }} />
    {choosing && <div className="xf-join-choices" aria-label="Choose a join">{joins.map(join => <button type="button" key={transitionKey(join)} disabled={!!join.reason}
      onClick={event => context.open(join, event.currentTarget, context.timeline!.transitions?.some(value => sameTransitionPair(value, join)))}>{name(join)}<small>{join.reason ?? formatFrames(join.cutFrame, context.timeline!.frameRate)}</small></button>)}</div>}
    <p className="xf-meta">Drop between touching stills. Existing transitions ask before replacement.</p>
    {inactive.length > 0 && <div className="xf-join-choices"><h4>Joins needing attention</h4>{inactive.map(({ value, reason }) => <button type="button" key={transitionKey(value)} onClick={() => context.select(pairOf(value))}>{value.leftClipId} → {value.rightClipId}<small>{reason}</small></button>)}</div>}
    <button type="button" className="ui-btn" onClick={context.batch} disabled={context.disabled}>Apply across images…</button></div>;
}

export function TransitionJoins({ trackId, totalFrames }: { trackId: string; totalFrames: number }) {
  const context = useContext(Transitions), [hover, setHover] = useState<string | null>(null);
  const [handle, setHandle] = useState<{ key: string; frames: number } | null>(null);
  if (!context?.timeline) return null;
  const { timeline } = context, fps = timeline.frameRate;
  const joins = pictureJoins(timeline.tracks, clip => transitionStill(clip, context.artifacts)).filter(join => join.trackId === trackId);
  return <div className="xf-joins" data-dragging={context.dragging || undefined}>{joins.filter(join => !join.reason).map(join => {
    const key = transitionKey(join), value = timeline.transitions?.find(value => sameTransitionPair(value, join));
    const selected = !!context.selected && sameTransitionPair(context.selected, join), duration = handle?.key === key ? handle.frames : value?.durationFrames ?? fps;
    const window = crossfadeWindow(join.cutFrame, duration);
    const resize = (side: "left" | "right") => (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!value || context.disabled) return;
      event.preventDefault(); event.stopPropagation(); const button = event.currentTarget, lane = button.closest(".fy-track__lane")!.getBoundingClientRect();
      const max = maxCrossfadeFrames(timeline.tracks, timeline.transitions ?? [], join); let frames = duration;
      button.setPointerCapture(event.pointerId);
      const move = (pointer: PointerEvent) => { const at = (pointer.clientX - lane.left) / lane.width * totalFrames;
        frames = Math.max(2, Math.min(max, Math.round((side === "left" ? join.cutFrame - at : at - join.cutFrame) * 2))); setHandle({ key, frames }); };
      const finish = (pointer: PointerEvent) => { button.removeEventListener("pointermove", move); button.removeEventListener("pointerup", finish); button.removeEventListener("pointercancel", finish);
        setHandle(null); if (pointer.type !== "pointercancel" && frames !== value.durationFrames) context.send([{ kind: "transition-set", ...pairOf(join), durationFrames: frames }], "Adjust crossfade"); };
      button.addEventListener("pointermove", move); button.addEventListener("pointerup", finish); button.addEventListener("pointercancel", finish);
    };
    return <div className="xf-join-position" key={key} style={{ left: `${join.cutFrame / totalFrames * 100}%` }}>
      <button type="button" className={`xf-join-trigger ${value ? "has" : "empty"}`} data-selected={selected || undefined} disabled={context.disabled}
        aria-label={`${value ? "Inspect crossfade" : "Add transition"} between ${name(join)}`} aria-haspopup={value ? undefined : "dialog"}
        onClick={event => value ? context.select(pairOf(join)) : context.open(join, event.currentTarget)}
        onDragOver={event => { if (!event.dataTransfer.types.includes(DRAG) || context.disabled) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; setHover(key); }}
        onDragLeave={() => setHover(null)} onDrop={event => { if (event.dataTransfer.getData(DRAG) !== "crossfade") return;
          event.preventDefault(); event.stopPropagation(); context.setDragging(false); setHover(null);
          if (value || maxCrossfadeFrames(timeline.tracks, timeline.transitions ?? [], join) < fps) context.open(join, event.currentTarget, !!value);
          else { context.send([{ kind: "transition-set", ...pairOf(join), durationFrames: fps }], "Add crossfade"); context.select(pairOf(join)); } }}><span>{value ? "⋈" : "＋"}</span></button>
      {hover === key && <span className="xf-drop-ghost">Crossfade · 1.00s</span>}
      {selected && value && <><span className="xf-blend-band" style={{ left: `${-(join.cutFrame - window.startFrame) / totalFrames * 100}cqw`, width: `${duration / totalFrames * 100}cqw` }} />
        {(["left", "right"] as const).map(side => <button key={side} type="button" className="xf-duration-handle" aria-label={`Crossfade ${side} duration handle`} role="slider"
          aria-valuemin={2} aria-valuemax={maxCrossfadeFrames(timeline.tracks, timeline.transitions ?? [], join)} aria-valuenow={duration}
          style={{ left: `${((side === "left" ? window.startFrame : window.endFrame) - join.cutFrame) / totalFrames * 100}cqw` }}
          onPointerDown={resize(side)} onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); event.stopPropagation();
            const frames = duration + (event.key === "ArrowRight" ? 1 : -1); if (frames >= 2 && frames <= maxCrossfadeFrames(timeline.tracks, timeline.transitions ?? [], join)) context.send([{ kind: "transition-set", ...pairOf(join), durationFrames: frames }], "Adjust crossfade"); }} />)}</>}
    </div>;
  })}</div>;
}

function TransitionPicker({ picker, close }: { picker: { join: PictureJoin; anchor: HTMLElement; replace: boolean }; close: () => void }) {
  const context = useContext(Transitions)!, panel = useRef<HTMLDivElement>(null), modal = useRef<HTMLDialogElement>(null), timeline = context.timeline!;
  const current = timeline.transitions?.find(value => sameTransitionPair(value, picker.join));
  const max = maxCrossfadeFrames(timeline.tracks, timeline.transitions ?? [], picker.join), [frames, setFrames] = useState<number>(timeline.frameRate);
  const box = picker.anchor.getBoundingClientRect();
  useEffect(() => { const dialog = modal.current; dialog?.showModal(); panel.current?.querySelector<HTMLButtonElement>("button")?.focus(); return () => dialog?.close(); }, []);
  const insert = () => { if (frames < 2 || frames > max) return;
    if (!current || current.durationFrames !== frames) context.send([{ kind: "transition-set", ...pairOf(picker.join), durationFrames: frames }], current ? "Replace crossfade" : "Add crossfade");
    context.select(pairOf(picker.join)); close(); };
  return createPortal(<dialog ref={modal} className="xf-picker-scrim" aria-label={picker.replace ? "Replace transition" : "Add transition"} onCancel={event => { event.preventDefault(); close(); }} onPointerDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={panel} className="xf-transition-picker"
      style={{ left: Math.max(12, Math.min(window.innerWidth - 324, box.left - 128)), top: Math.max(12, Math.min(window.innerHeight - 390, box.top - 340)) }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === "Tab") { const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button:not(:disabled),input:not(:disabled)")];
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); } } }}>
      <div className="xf-row"><h3>{picker.replace ? "Replace transition?" : "Add transition"}</h3><button type="button" onClick={close}>Close</button></div>
      <p className="xf-meta">{name(picker.join)} · cut at {formatFrames(picker.join.cutFrame, timeline.frameRate)}</p>
      {picker.replace ? <><p>Current <b>Crossfade · {seconds(current?.durationFrames ?? 0, timeline.frameRate)}</b></p><p>New <b>Crossfade · {seconds(frames, timeline.frameRate)}</b></p>
        {(current?.protectJoin || current?.protectDuration) && <p className="xf-meta">Protection stays on. This direct edit updates the protected duration.</p>}</> : <Tile onClick={insert} />}
      {max < timeline.frameRate && <label>Maximum here: {seconds(max, timeline.frameRate)}<input type="number" aria-label="Crossfade frames" min={2} max={max} value={frames} onChange={event => setFrames(Number(event.target.value))} /></label>}
      {frames > max && <p role="alert">Choose at most {max} frames. Nearby cuts limit the blend.</p>}
      {(picker.replace || max < timeline.frameRate) && <div className="xf-row"><button type="button" onClick={close}>Keep existing</button><button type="button" className="xf-primary" disabled={frames < 2 || frames > max} onClick={insert}>{picker.replace ? "Replace transition" : "Add crossfade"}</button></div>}
      {!picker.replace && <p className="xf-meta">Choose to add immediately. Adjust duration afterwards.</p>}
      <p className="xf-picker-foot">Cut stays at {seconds(picker.join.cutFrame, timeline.frameRate)} · film duration unchanged</p>
    </div></dialog>, document.body);
}

export function TransitionInspector() {
  const context = useContext(Transitions)!, timeline = context.timeline!;
  const value = timeline.transitions?.find(value => context.selected && sameTransitionPair(value, context.selected));
  const join = pictureJoins(timeline.tracks, clip => transitionStill(clip, context.artifacts)).find(join => context.selected && sameTransitionPair(join, context.selected));
  const [panel, setPanel] = useState<"inspect" | "protect" | "release">("inspect"), [release, setRelease] = useState<"join" | "duration">("duration");
  const [typed, setTyped] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => { setTyped(null); setError(null); setPanel("inspect"); }, [context.selected && transitionKey(context.selected), value?.durationFrames]);
  if (!value) return <div className="xf-inspector"><header><h3>Picture cut</h3><p>{join ? name(join) : "Selected join"}{join && ` · ${formatFrames(join.cutFrame, timeline.frameRate)}`}</p></header>
    <div className="xf-note"><b>Add at the boundary</b><p>Use + to choose a transition, or drag Crossfade from the Library onto this join.</p></div>
    <section><p className="xf-meta">Duration controls appear here after a transition is added. Opening the picker changes nothing.</p></section></div>;
  const fps = timeline.frameRate, max = maxCrossfadeFrames(timeline.tracks, timeline.transitions ?? [], value);
  const inactive = transitionInactiveReason(timeline.tracks, timeline.transitions ?? [], value, clip => transitionStill(clip, context.artifacts));
  const sendDuration = (frames: number) => { if (!Number.isInteger(frames) || frames < 2 || frames > max) { setError(`Choose 2–${max} frames. Cut positions stay fixed.`); return; }
    setError(null); setTyped(null); if (frames !== value.durationFrames) context.send([{ kind: "transition-set", ...pairOf(value), durationFrames: frames }], "Adjust crossfade"); };
  const releaseRule = (setting: "join" | "duration") => { setRelease(setting); setPanel("release"); };
  return <div className="xf-inspector">
    <header><div className="xf-row"><h3>{panel === "inspect" ? "Crossfade" : panel === "protect" ? "Protect from Arke" : `Release ${release === "join" ? "join protection" : "duration"}?`}</h3>{panel === "inspect" && (value.protectJoin || value.protectDuration) && <span className="xf-tag">Protected</span>}</div>
      <p>{join ? name(join) : `${value.leftClipId} → ${value.rightClipId}`}</p><p className="xf-meta">Picture{join ? ` · cut at ${formatFrames(join.cutFrame, fps)}` : " · original pair"}</p></header>
    {inactive && <div className="xf-note" role="status"><b>Join needs attention</b><p>{inactive}. Restore adjacency or remove this transition.</p></div>}
    {panel === "release" ? <section><div className="xf-note"><b>Only {release === "join" ? "Join protection" : "Duration"} will be released</b><p>{release === "join" ? "Duration protection" : "Join protection"} is unchanged.</p></div>
      <p>{context.pending ? "Release stays pending until Apply. Review the new version again." : "This is an undoable edit to Current."}</p><div className="xf-row"><button type="button" onClick={() => setPanel("protect")}>Cancel</button>
        <button type="button" className="xf-primary" onClick={() => { context.send([{ kind: "transition-release", ...pairOf(value), setting: release }], `Release transition ${release}`); setPanel("protect"); }}>{context.pending ? "Release on Apply" : "Release named setting"}</button></div></section>
      : panel === "protect" ? <><section>{(["join", "duration"] as const).map(setting => { const protectedValue = setting === "join" ? value.protectJoin : value.protectDuration;
        return <div key={setting}><label className="xf-check"><input type="checkbox" checked={protectedValue} disabled={context.disabled} onChange={() => protectedValue ? releaseRule(setting) : context.send([{ kind: "transition-protect", ...pairOf(value), setting }], `Protect transition ${setting}`)} />{setting === "join" ? "Keep a crossfade at this join" : "Keep this duration"}</label>
          <p className="xf-meta">{setting === "join" ? "Arke cannot remove or replace this transition." : `${seconds(value.durationFrames, fps)} · Other settings stay open.`}</p></div>; })}</section>
        <div className="xf-note"><b>Your edits stay available</b><p>Changing a protected value yourself updates what is protected. A broad request to Arke does not release it.</p></div><section><button type="button" className="xf-primary" onClick={() => setPanel("inspect")}>Done</button></section></>
      : <><section><label>Duration<div className="xf-duration"><input aria-label="Crossfade duration in seconds" type="number" min={2 / fps} max={max / fps} step={1 / fps} value={typed ?? (value.durationFrames / fps).toFixed(3)} disabled={context.disabled || !!inactive}
        onChange={event => setTyped(event.target.value)} onBlur={() => { if (typed !== null) sendDuration(Math.round(Number(typed) * fps)); }} onKeyDown={event => { if (event.key === "Enter") { event.currentTarget.blur(); } }} /><span>seconds</span>
        <input aria-label="Crossfade duration in frames" type="number" min={2} max={max} value={value.durationFrames} disabled={context.disabled || !!inactive} onChange={event => sendDuration(Number(event.target.value))} /><span>frames</span></div></label>
        <p className="xf-meta">{value.durationFrames} frames · centred on the cut</p>
        {context.adjustedKeys?.some(key => key.startsWith(`${transitionKey(value)}/`)) && <span className="xf-tag">Adjusted by you · retained</span>}
        <p className="xf-meta">Maximum here: {seconds(max, fps)} · {max} frames</p>{error && <p role="alert">{error}</p>}
        {join && <div className="xf-blend-window"><span>{seconds(crossfadeWindow(join.cutFrame, value.durationFrames).startFrame, fps)}</span><b>{seconds(join.cutFrame, fps)} cut</b><span>{seconds(crossfadeWindow(join.cutFrame, value.durationFrames).endFrame, fps)}</span></div>}
        <button type="button" className="xf-wide" disabled={!join || !!inactive} onClick={() => join && context.preview(join, value)}>{context.previewing ? "Stop preview" : "▶ Preview transition"}</button>
        <button type="button" className="xf-wide" disabled={!join || context.disabled || !!inactive} onClick={event => join && context.open(join, event.currentTarget, true)}>Change transition…</button></section>
      <section><h4>Protection</h4><p className="xf-meta">Join {value.protectJoin ? "protected" : "open"} · Duration {value.protectDuration ? "protected" : "open"}</p><button type="button" className="xf-wide" onClick={() => setPanel("protect")}>Protect settings…</button>
        {value.protectDuration && <button type="button" onClick={() => releaseRule("duration")}>Release duration…</button>}</section>
      <section><button type="button" className="xf-wide" disabled={context.disabled} onClick={() => { context.send([{ kind: "transition-remove", ...pairOf(value) }], "Remove crossfade"); context.select(null); }}>Remove crossfade</button><p className="xf-meta">Restores a hard cut. Clip positions stay fixed.</p></section></>}
    <div className="xf-note"><b>{context.pending ? "Editing Suggested" : "Fixed picture timing"}</b><p>Cut positions · total duration · soundtrack unchanged</p></div>
  </div>;
}

function TransitionBatch({ close }: { close: () => void }) {
  const context = useContext(Transitions)!, timeline = context.timeline!;
  const [scope, setScope] = useState<"all" | "selected" | "range">("all"), [duration, setDuration] = useState(1), [replace, setReplace] = useState(false);
  const [short, setShort] = useState<"review" | "accept" | "skip">("review"), [selection, setSelection] = useState<string[]>([]);
  const [from, setFrom] = useState(0), [to, setTo] = useState(Math.max(0, ...timeline.tracks.flatMap(track => track.clips.map(clip => clip.startFrame + clip.durationFrames))) / timeline.frameRate);
  const rows = planCrossfadeBatch(timeline, { durationFrames: Math.round(duration * timeline.frameRate), scope, selectedClipIds: selection, from: Math.round(from * timeline.frameRate), to: Math.round(to * timeline.frameRate), replace, short,
    isStill: clip => transitionStill(clip, context.artifacts) });
  const commands = rows.flatMap(row => row.command ? [row.command] : []), unresolved = rows.some(row => row.status === "shorten" && !row.command);
  const valid = Number.isFinite(duration) && Math.round(duration * timeline.frameRate) >= 2 && Math.round(duration * timeline.frameRate) <= 108000 && (scope !== "range" || from >= 0 && to > from);
  const host = document.getElementById("cut-inspector-panel");
  return createPortal(<div className="xf-inspector xf-batch" role="region" aria-label="Apply across images" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <header><div className="xf-row"><h3>Apply across images</h3><button type="button" autoFocus onClick={close}>Close</button></div><p>Crossfades at existing picture cuts</p></header>
    <section><label>Scope<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="all">All still images</option><option value="selected">Selected images</option><option value="range">Time range</option></select></label>
      {scope === "selected" && <><p className="xf-meta">Both sides must be selected</p><div className="xf-clip-selection">{timeline.tracks.filter(track => track.kind === "picture").flatMap(track => track.clips).map(clip => <label className="xf-check" key={clip.id}><input type="checkbox" checked={selection.includes(clip.id)} onChange={event => setSelection(event.target.checked ? [...selection, clip.id] : selection.filter(id => id !== clip.id))} />{clip.source.label}</label>)}</div></>}
      {scope === "range" && <div className="xf-row"><label>From (seconds)<input type="number" value={from} onChange={event => setFrom(Number(event.target.value))} /></label><label>To (seconds)<input type="number" value={to} onChange={event => setTo(Number(event.target.value))} /></label></div>}
      <label>Duration (seconds)<input type="number" step={1 / timeline.frameRate} min={2 / timeline.frameRate} value={duration} onChange={event => { setDuration(Number(event.target.value)); setShort("review"); }} /></label>
      <label>Existing transitions<select value={String(replace)} onChange={event => { setReplace(event.target.value === "true"); setShort("review"); }}><option value="false">Keep existing</option><option value="true">Replace unprotected</option></select></label>
      <p className="xf-meta">Protected durations stay fixed. Join protection keeps the crossfade; its unprotected duration can change.</p></section>
    <section><h4>Check the joins · {rows.length}</h4>{rows.map(row => <div className="xf-join-result" key={transitionKey(row.join)}><span><b>{name(row.join)}</b><small>{formatFrames(row.join.cutFrame, timeline.frameRate)}</small></span><span>{row.status === "add" || row.status === "replace" || row.status === "shorten" ? `${seconds(row.durationFrames, timeline.frameRate)} · ${row.status}` : row.reason}</span></div>)}</section>
    {rows.some(row => row.status === "shorten" || row.reason === "Short join skipped") && <section><p className="xf-note">Nearby cuts need shorter fades. Review the exact durations above.</p><label className="xf-check"><input type="checkbox" checked={short === "accept"} onChange={event => setShort(event.target.checked ? "accept" : "review")} />Use the shown shorter durations</label><button type="button" onClick={() => setShort("skip")}>Skip short joins</button></section>}
    <section className="xf-batch-footer"><button type="button" className="xf-primary xf-wide" disabled={context.disabled || !valid || unresolved || !commands.length || commands.length > 50}
      onClick={() => { context.send(commands, `Apply ${commands.length} crossfades`); close(); }}>{unresolved ? "Review shorter durations first" : commands.length ? `Apply ${commands.length} crossfades` : "No changes to apply"}</button>
      <p className="xf-meta">{commands.length} changes · {rows.filter(row => row.status === "keep").length} kept · {rows.filter(row => row.status === "skip").length} skipped · one Undo step</p>
      {commands.length > 50 && <p role="alert">Choose a smaller range: up to 50 joins per arrangement.</p>}</section>
  </div>, host ?? document.body);
}

export function TransitionTouchJoins() {
  const context = useContext(Transitions);
  if (!context?.timeline) return null;
  const joins = pictureJoins(context.timeline.tracks, clip => transitionStill(clip, context.artifacts)).filter(join => !join.reason);
  return <div className="xf-touch-joins">{joins.map(join => { const value = context.timeline!.transitions?.find(value => sameTransitionPair(value, join));
    return <div key={transitionKey(join)} className="xf-row"><span><b>{name(join)}</b><small>Join at {formatFrames(join.cutFrame, context.timeline!.frameRate)}</small></span><button type="button" disabled={context.disabled}
      aria-label={value ? `Inspect ${name(join)} crossfade` : `Add transition at ${formatFrames(join.cutFrame, context.timeline!.frameRate)}`}
      onClick={event => value ? context.select(pairOf(join)) : context.open(join, event.currentTarget)}>{value ? "⋈ Crossfade" : "＋"}</button></div>; })}</div>;
}

/** The approved phone flow keeps the picture visible above the inline transition controls. */
export function TransitionPhoneNavigation({ onJoin, onArke, onDone }: { onJoin: () => void; onArke: () => void; onDone: () => void }) {
  const context = useContext(Transitions)!;
  const join = context.timeline && pictureJoins(context.timeline.tracks, clip => transitionStill(clip, context.artifacts)).find(row => context.selected && sameTransitionPair(row, context.selected));
  return <div className="xf-phone-navigation">
    {join && <div className="xf-phone-selected"><span><b>{name(join)}</b><small>Join at {formatFrames(join.cutFrame, context.timeline!.frameRate)}</small></span><button type="button" onClick={() => context.select(pairOf(join))}>⋈ Crossfade</button></div>}
    <nav aria-label="Transition actions"><button type="button" onClick={onJoin}>Join</button><button type="button" disabled={context.disabled} onClick={context.batch}>Apply across</button><button type="button" onClick={onArke}>Arke</button></nav>
    <nav aria-label="Transition panel"><button type="button" aria-pressed="true">Inspector</button><button type="button" onClick={onArke}>Arke</button><button type="button" onClick={onDone}>Done</button></nav>
  </div>;
}
