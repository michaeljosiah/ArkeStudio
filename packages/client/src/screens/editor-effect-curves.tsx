import { EFFECT_POINT_LIMIT, effectCurveAt, formatFrames, type EffectCurve, type TimelineCommand } from "@arke-studio/contracts";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { EffectAuthoringProps } from "../lib/editor-effect-authoring.js";
import { EffectNumberField, EffectTimeField } from "./editor-effect-fields.js";

type CurveKind = "intensityCurve" | "reactionCurve";
type Point = EffectCurve["points"][number];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const labels: Record<CurveKind, string> = { intensityCurve: "Intensity", reactionCurve: "Audio reaction" };

/** Replacing another point is an explicit UI decision; a normal move cannot overwrite it. */
export function editEffectCurve(curve: EffectCurve, point: Point, movingId?: string, replaceId?: string): EffectCurve {
  const kept = curve.points.filter(value => value.id !== movingId && value.id !== replaceId);
  if (kept.some(value => value.offsetFrames === point.offsetFrames)) throw new Error("A point already exists at this frame. Choose Replace point to continue.");
  return { points: [...kept, point].sort((a, b) => a.offsetFrames - b.offsetFrames) };
}

export function EffectCurves(props: EffectAuthoringProps) {
  const { effect, frameRate, playheadFrame, disabled, onCommands, onPreview, onScrub, authoringRevision } = props;
  const [kind, setKind] = useState<CurveKind>("intensityCurve"), [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ point: Point; movingId?: string; existingId: string; curve: EffectCurve } | null>(null);
  const graph = useRef<HTMLDivElement>(null), drag = useRef<{ pointerId: number; curve: EffectCurve; original: Point; point: Point; left: number; top: number; width: number; height: number; start: number; last: number; origin: number } | null>(null);
  const ignoreClick = useRef(false), replaceButton = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onCommands, onPreview, disabled }); callbacks.current = { onCommands, onPreview, disabled };
  const [draftPoint, setDraftPoint] = useState<Point | null>(null);
  const curve = effect[kind], selected = curve.points.find(point => point.id === selectedId) ?? null;
  const start = effect.startFrame, last = start + effect.durationFrames - 1, origin = effect.simulationOriginFrame;
  useEffect(() => { if (pending) replaceButton.current?.focus(); }, [pending]);
  const command = (value: EffectCurve): TimelineCommand[] => [{ kind: "effect-patch", clipId: effect.id, patch: { [kind]: value } }];
  const cancelDrag = () => { if (drag.current) { drag.current = null; callbacks.current.onPreview(null); } setDraftPoint(null); };
  useEffect(() => { setSelectedId(null); setPending(null); cancelDrag(); return () => { if (drag.current) { drag.current = null; callbacks.current.onPreview(null); } }; }, [effect.id]);
  useLayoutEffect(() => { cancelDrag(); setPending(null); ignoreClick.current = false; }, [authoringRevision, disabled]);
  const send = (value: EffectCurve, pointId: string | null) => { onCommands(command(value), `Edit ${labels[kind].toLowerCase()} curve`); setSelectedId(pointId); setPending(null); };
  const propose = (point: Point, movingId?: string, base = curve) => {
    const collision = base.points.find(value => value.id !== movingId && value.offsetFrames === point.offsetFrames);
    if (collision) { setPending({ point, movingId, existingId: collision.id, curve: base }); return; }
    send(editEffectCurve(base, point, movingId), point.id);
  };
  const atFrame = (point: Point) => origin + point.offsetFrames;
  const begin = (event: ReactPointerEvent<HTMLButtonElement>, point: Point) => {
    if (disabled || event.button !== 0) return;
    const bounds = graph.current?.getBoundingClientRect(); if (!bounds?.width || !bounds.height) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); setSelectedId(point.id); setPending(null); ignoreClick.current = false;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* A synthetic pointer may have no browser capture. */ }
    drag.current = { pointerId: event.pointerId, curve, original: point, point, left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, start, last, origin };
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    const frame = Math.round(active.start + clamp((event.clientX - active.left) / active.width, 0, 1) * (active.last - active.start));
    const point = { ...active.original, offsetFrames: frame - active.origin, value: Math.round(clamp(1 - (event.clientY - active.top) / active.height, 0, 1) * 1000) / 1000 };
    active.point = point; setDraftPoint(point); event.stopPropagation();
    if (!active.curve.points.some(value => value.id !== point.id && value.offsetFrames === point.offsetFrames)) onPreview(command(editEffectCurve(active.curve, point, point.id)));
    else onPreview(null);
  };
  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null; setDraftPoint(null); onPreview(null); event.stopPropagation();
    if (!callbacks.current.disabled && (active.point.offsetFrames !== active.original.offsetFrames || active.point.value !== active.original.value)) {
      ignoreClick.current = true;
      propose(active.point, active.original.id, active.curve); onScrub(active.origin + active.point.offsetFrames);
    }
  };
  const samples = Array.from({ length: 101 }, (_, index) => `${index},${100 - effectCurveAt(curve, start + (last - start) * index / 100 - origin) * 100}`).join(" ");
  return <section className="fx-curves" aria-label="Effect curves">
    <h3>Curves</h3>
    <div className="fx-curves__tabs" role="tablist" aria-label="Curve type">{(["intensityCurve", "reactionCurve"] as const).map(value => <button type="button" role="tab" key={value}
      aria-selected={value === kind} tabIndex={value === kind ? 0 : -1}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); cancelDrag();
        const next = event.key === "Home" ? "intensityCurve" : event.key === "End" ? "reactionCurve" : kind === "intensityCurve" ? "reactionCurve" : "intensityCurve";
        setKind(next); setSelectedId(null); setPending(null);
        (event.currentTarget.parentElement?.children[next === "intensityCurve" ? 0 : 1] as HTMLButtonElement | undefined)?.focus();
      }} onClick={() => { cancelDrag(); setKind(value); setSelectedId(null); setPending(null); }}>{labels[value]}</button>)}</div>
    <p className="fx-inspector__hint">{kind === "intensityCurve" ? "Overall visibility. Fades and opacity still apply." : "Audio modulation only. Base atmosphere stays unchanged."} No points means 100%.</p>
    <div className="fx-curves__graph" ref={graph} aria-label={`${labels[kind]} curve graph`}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M0 50H100 M50 0V100" className="fx-curves__grid" /><polyline points={samples} /></svg>
      {curve.points.filter(point => atFrame(point) >= start && atFrame(point) <= last).map(stored => {
        const point = draftPoint?.id === stored.id ? draftPoint : stored;
        return <button type="button" key={point.id} className="fx-curves__point" aria-label={`${labels[kind]} point at ${formatFrames(atFrame(point), frameRate)}`} aria-pressed={selectedId === point.id}
          disabled={disabled} style={{ left: `${(atFrame(point) - start) / Math.max(1, last - start) * 100}%`, top: `${100 - point.value * 100}%` }}
          onClick={() => { if (ignoreClick.current) { ignoreClick.current = false; return; } setSelectedId(point.id); setPending(null); }} onPointerDown={event => begin(event, point)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelDrag}
          onLostPointerCapture={() => { if (drag.current) cancelDrag(); }} onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDrag(); setPending(null); return; }
            if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); event.stopPropagation(); send({ points: curve.points.filter(value => value.id !== point.id) }, null); return; }
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            const amount = event.shiftKey ? 10 : 1;
            const offsetFrames = clamp(atFrame(point) + (event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0), start, last) - origin;
            const value = clamp(point.value + (event.key === "ArrowUp" ? amount / 100 : event.key === "ArrowDown" ? -amount / 100 : 0), 0, 1);
            propose({ ...point, offsetFrames, value }, point.id);
          }} />;
      })}
    </div>
    <div className="fx-curves__bounds"><span>{formatFrames(start, frameRate)}</span><span>{formatFrames(last, frameRate)}</span></div>
    <div className="fx-curves__actions"><button type="button" disabled={disabled || curve.points.length >= EFFECT_POINT_LIMIT} onClick={() => {
      const frame = clamp(playheadFrame, start, last), offsetFrames = frame - origin;
      propose({ id: `ep_${crypto.randomUUID()}`, offsetFrames, value: effectCurveAt(curve, offsetFrames), interpolation: "linear" });
    }}>Add point at playhead</button></div>
    {curve.points.length > 0 && <label className="fx-inspector__select">Selected point<select aria-label="Selected curve point" value={selected?.id ?? ""} onChange={event => { setSelectedId(event.currentTarget.value || null); setPending(null); }}>
      <option value="">Choose point</option>{curve.points.map(point => <option key={point.id} value={point.id}>{formatFrames(atFrame(point), frameRate)} · {Math.round(point.value * 100)}%{atFrame(point) < start || atFrame(point) > last ? " · outside interval" : ""}</option>)}
    </select></label>}
    {selected && <div className="fx-curves__fields">
      <EffectTimeField key={`${kind}-${selected.id}-time`} label="Point time" value={atFrame(selected)} frameRate={frameRate} min={start} max={last} disabled={disabled} resetToken={authoringRevision} onCommit={frame => { propose({ ...selected, offsetFrames: frame - origin }, selected.id); onScrub(frame); }} />
      <EffectNumberField key={`${kind}-${selected.id}-value`} label="Point value" value={selected.value * 100} min={0} max={100} suffix="%" disabled={disabled} resetToken={authoringRevision} onCommit={value => propose({ ...selected, value: value / 100 }, selected.id)} />
      <label className="fx-inspector__select">Interpolation<select aria-label="Point interpolation" disabled={disabled} value={selected.interpolation} onChange={event => propose({ ...selected, interpolation: event.currentTarget.value as Point["interpolation"] }, selected.id)}>
        <option value="hold">Hold</option><option value="linear">Linear</option><option value="smooth">Smooth</option>
      </select></label>
      <button type="button" disabled={disabled} onClick={() => send({ points: curve.points.filter(point => point.id !== selected.id) }, null)}>Delete point</button>
    </div>}
    {pending && <div className="fx-curves__replace" role="alert"><p>A point already exists at {formatFrames(origin + pending.point.offsetFrames, frameRate)}. Replace it with this point?</p>
      <button type="button" ref={replaceButton} disabled={disabled} onClick={() => send(editEffectCurve(pending.curve, pending.point, pending.movingId, pending.existingId), pending.point.id)}>Replace point</button>
      <button type="button" onClick={() => setPending(null)}>Cancel replacement</button>
    </div>}
  </section>;
}
