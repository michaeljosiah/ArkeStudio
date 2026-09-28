import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { TimelineCommand, TimelineTrack, TimelineTrackId } from "@arke-studio/contracts";
import { PageSheet } from "../components/page-sheet.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { useMediaQuery } from "../lib/media-query.js";
import type { Transport } from "./editor-transport.js";

export const CUT_PHONE_QUERY = "(max-width: 599px), (max-width: 1099px) and (max-height: 599px) and (orientation: landscape)";
export const CutTouchContext = createContext({ snap: true, toggleSnap: () => {}, openLane: (_id: TimelineTrackId) => {} });
export const useCutTouch = () => useContext(CutTouchContext);
export const coarsePointer = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
export function cutTime(frames: number, rate: number): string {
  const seconds = Math.floor(frames / rate);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(frames % rate).padStart(2, "0")}`;
}

const subscribe = () => () => {};
/** A draft stays in one React subtree when its pane becomes a sheet or is put away. */
export function EditorSheetSlot({ sheet, open, title, onClose, children, className = "", footer }: {
  sheet: boolean; open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string; footer?: ReactNode;
}) {
  const client = useSyncExternalStore(subscribe, () => true, () => false);
  const host = useMemo(() => client ? document.createElement("div") : null, [client]);
  const inline = useRef<HTMLDivElement>(null), modal = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = sheet ? modal.current : inline.current;
    if (host && target) { host.style.display = "contents"; target.appendChild(host); }
  }, [host, sheet]);
  return <>
    <div ref={inline} className="fy-editor-slot" hidden={sheet} />
    <PageSheet open={sheet && open} title={title} onClose={onClose} keepMounted className={`fy-cut-sheet ${className}`} footer={footer}><div ref={node => { modal.current = node; if (node && host && sheet) { host.style.display = "contents"; node.appendChild(host); } }} className="fy-editor-sheet-content" /></PageSheet>
    {host ? createPortal(children, host) : children}
  </>;
}

export function LaneSheet({ track, baseTrackId, disabled, onCommands, onClose }: {
  track: TimelineTrack | null; baseTrackId: TimelineTrackId | undefined; disabled: boolean; onCommands: (commands: TimelineCommand[], label?: string) => void; onClose: () => void;
}) {
  return <PageSheet open={track !== null} title={track?.name ?? "Lane"} onClose={onClose} className="fy-cut-sheet fy-cut-lane-sheet">
    {track && <>
      <label>Name<input aria-label="Lane name" key={`${track.id}:${track.name}`} defaultValue={track.name} disabled={disabled} onBlur={event => {
        const name = event.currentTarget.value.trim();
        if (name && name !== track.name) onCommands([{ kind: "set-track", trackId: track.id, name }], "Rename lane");
      }} /></label>
      <button type="button" disabled={disabled} aria-pressed={track.muted === true} onClick={() => onCommands([{ kind: "set-track", trackId: track.id, muted: !track.muted }], "Mute lane")}>Mute</button>
      {track.kind !== "picture" && track.kind !== "subtitle" && <>
        <button type="button" disabled={disabled} aria-pressed={track.solo === true} onClick={() => onCommands([{ kind: "set-track", trackId: track.id, solo: !track.solo }], "Solo lane")}>Solo</button>
        <label>Gain · all clips (dB)<input type="number" inputMode="decimal" min={-60} max={12} step={1} disabled={disabled || !track.clips.length}
          key={`${track.id}:${track.clips.map(clip => clip.gainDb).join()}`} defaultValue={track.clips[0]?.gainDb ?? 0} onBlur={event => {
            const gainDb = Number(event.currentTarget.value);
            if (!Number.isFinite(gainDb) || gainDb < -60 || gainDb > 12) return;
            const commands = track.clips.filter(clip => (clip.gainDb ?? 0) !== gainDb).map(clip => ({ kind: "set-clip-gain" as const, clipId: clip.id, gainDb }));
            if (commands.length) onCommands(commands, "Set lane clip gain");
          }} /></label>
      </>}
      <button type="button" disabled={disabled || track.id === baseTrackId || track.clips.length > 0 || !!track.cues?.length} onClick={() => { onCommands([{ kind: "remove-track", trackId: track.id }], "Remove lane"); onClose(); }}>Remove lane</button>
      {track.id === baseTrackId ? <span>The base Picture lane stays in the cut.</span> : (track.clips.length > 0 || !!track.cues?.length) && <span>Remove its clips and subtitles before removing the lane.</span>}
    </>}
  </PageSheet>;
}

/** The phone's fixed line and the Fold's two-finger scrub both use the production clock. */
export function useTouchLanes({ phone, transport, totalSec, zoom, setZoom }: {
  phone: boolean; transport: Transport; totalSec: number; zoom: number; setZoom: (value: number) => void;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const live = useRef({ phone, transport, totalSec, zoom, setZoom });
  live.current = { phone, transport, totalSec, zoom, setZoom };
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const resize = () => setWidth(element.clientWidth);
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const pointers = new Map<number, { x: number; y: number; picked: boolean }>();
    let startX = 0, startY = 0, startTime = 0, startZoom = 1, startDistance = 0, moved = false;
    const reset = () => {
      const points = [...pointers.values()];
      startX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
      startY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
      startTime = live.current.transport.timeRef.current; startZoom = live.current.zoom;
      startDistance = points.length > 1 ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) : 0;
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || (!live.current.phone && event.pointerType !== "touch")) return;
      const target = event.target as HTMLElement;
      if (target.closest(".fy-track__label, .fy-track--new, input, select, .fy-pictclip__grip")) return;
      if (pointers.size === 0) moved = false;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, picked: !!target.closest('[data-clip][aria-pressed="true"]') }); reset();
    };
    const move = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { ...pointers.get(event.pointerId)!, x: event.clientX, y: event.clientY });
      const state = live.current, points = [...pointers.values()];
      if (points.length === 1 && points[0]!.picked) return;
      const x = points.reduce((sum, p) => sum + p.x, 0) / points.length;
      const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
      if (points.length === 1 && Math.abs(x - startX) < 8 && Math.abs(y - startY) < 8) return;
      if (!state.phone && points.length < 2) return;
      moved = true; event.preventDefault(); state.transport.setPlaying(false);
      if (points.length > 1 && startDistance > 0) {
        const distance = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
        state.setZoom(Math.max(1, Math.min(32, startZoom * distance / startDistance)));
      }
      const lane = Math.max(1, (element.clientWidth || element.getBoundingClientRect().width) - (state.phone ? 44 : 146));
      state.transport.seek(startTime - (x - startX) * state.totalSec / (lane * startZoom));
    };
    const up = (event: PointerEvent) => { pointers.delete(event.pointerId); if (pointers.size) reset(); };
    const click = (event: MouseEvent) => { if (moved) { event.preventDefault(); event.stopPropagation(); moved = false; } };
    const wheel = (event: WheelEvent) => {
      const state = live.current;
      if (!state.phone) return;
      event.preventDefault();
      state.setZoom(Math.max(1, Math.min(32, state.zoom * Math.exp(-event.deltaY * .002))));
    };
    element.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
    element.addEventListener("click", click, true); element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("pointerdown", down, true); window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      element.removeEventListener("click", click, true); element.removeEventListener("wheel", wheel);
    };
  }, []);
  useEffect(() => {
    if (!phone || !transport.playing) return;
    let frame = 0;
    const paint = () => {
      canvas.current?.style.setProperty("--cut-pan", `${(width - 44) * (.5 - transport.timeRef.current / Math.max(totalSec, 1) * zoom)}px`);
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint); return () => cancelAnimationFrame(frame);
  }, [phone, transport.playing, transport.timeRef, totalSec, width, zoom]);
  return { canvas, pan: (width - 44) * (.5 - transport.time / Math.max(totalSec, 1) * zoom) };
}

export function useCutLayout() {
  return { phone: useMediaQuery(CUT_PHONE_QUERY), compact: useMediaQuery("(max-width: 1099px)") };
}

export function CutDialog(props: React.ComponentProps<typeof EditorDialog>) {
  const { phone } = useCutLayout();
  if (!phone) return <EditorDialog {...props} />;
  return <PageSheet open={props.open} onClose={props.onClose} title={props.title ?? "Cut"} className="fy-cut-sheet fy-cut-full-sheet">{props.children}</PageSheet>;
}
