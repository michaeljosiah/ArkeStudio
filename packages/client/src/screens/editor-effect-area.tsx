import { EffectAreaSchema, type EffectClip, type TimelineCommand } from "@arke-studio/contracts";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { EffectAuthoringProps } from "../lib/editor-effect-authoring.js";
import { EffectNumberField } from "./editor-effect-fields.js";

type Area = EffectClip["motion"]["area"];
type Handle = "move" | "nw" | "ne" | "sw" | "se";
const bounded = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const rounded = (value: number) => Math.round(value * 1e6) / 1e6;
const same = (a: Area, b: Area) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Pointer deltas are measured against the target rectangle, never the viewer letterbox. */
export function effectAreaGesture(area: Area, handle: Handle, dx: number, dy: number): Area {
  if (handle === "move") return { ...area, x: rounded(bounded(area.x + dx, 0, 1 - area.width)), y: rounded(bounded(area.y + dy, 0, 1 - area.height)) };
  const left = handle.includes("w") ? bounded(area.x + dx, 0, area.x + area.width - 0.001) : area.x;
  const top = handle.includes("n") ? bounded(area.y + dy, 0, area.y + area.height - 0.001) : area.y;
  const right = handle.includes("e") ? bounded(area.x + area.width + dx, left + 0.001, 1) : area.x + area.width;
  const bottom = handle.includes("s") ? bounded(area.y + area.height + dy, top + 0.001, 1) : area.y + area.height;
  const x = rounded(left), y = rounded(top);
  return { x, y, width: rounded(right) - x, height: rounded(bottom) - y };
}

/** Mount over the selected target's actual contain rectangle; the local Inspector uses the same controls. */
export function EffectAreaOverlay({ effect, disabled, onCommands, onPreview, authoringRevision, className = "" }: EffectAuthoringProps & { className?: string }) {
  const root = useRef<HTMLDivElement>(null), [draft, setDraft] = useState<Area | null>(null);
  const latest = useRef({ effect, disabled, onCommands, onPreview }); latest.current = { effect, disabled, onCommands, onPreview };
  const drag = useRef<{ pointerId: number; x: number; y: number; width: number; height: number; handle: Handle; area: Area; next: Area } | null>(null);
  const command = (area: Area): TimelineCommand[] => [{ kind: "effect-patch", clipId: latest.current.effect.id, patch: { motion: { area } } }];
  const cancel = () => { if (drag.current) { drag.current = null; latest.current.onPreview(null); } setDraft(null); };
  useEffect(() => { cancel(); return () => { if (drag.current) { drag.current = null; latest.current.onPreview(null); } }; }, [effect.id]);
  useLayoutEffect(() => { cancel(); }, [authoringRevision, disabled]);
  const begin = (event: ReactPointerEvent<HTMLButtonElement>, handle: Handle) => {
    if (disabled || event.button !== 0) return;
    const rect = root.current?.getBoundingClientRect(); if (!rect?.width || !rect.height) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Test and released pointers may have no capture. */ }
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, handle, area: effect.motion.area, next: effect.motion.area };
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    const next = effectAreaGesture(active.area, active.handle, (event.clientX - active.x) / active.width, (event.clientY - active.y) / active.height);
    active.next = next; setDraft(next); latest.current.onPreview(command(next)); event.stopPropagation();
  };
  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null; setDraft(null); latest.current.onPreview(null); event.stopPropagation();
    if (!latest.current.disabled && !same(active.area, active.next)) latest.current.onCommands(command(active.next), "Change emitting area");
  };
  const area = draft ?? effect.motion.area;
  const labels: Record<Handle, string> = { move: "Move emitting area", nw: "Resize emitting area top left", ne: "Resize emitting area top right", sw: "Resize emitting area bottom left", se: "Resize emitting area bottom right" };
  return <div className={`fx-area-overlay ${className}`} ref={root}>
    <div className="fx-area-overlay__region" style={{ left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.width * 100}%`, height: `${area.height * 100}%` }}>
      {(["move", "nw", "ne", "sw", "se"] as const).map(handle => <button key={handle} type="button" className={`fx-area-overlay__handle fx-area-overlay__handle--${handle}`}
        aria-label={labels[handle]} title={`${labels[handle]} · arrow keys 1%, Shift 10%`} disabled={disabled}
        onPointerDown={event => begin(event, handle)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel}
        onLostPointerCapture={() => { if (drag.current) cancel(); }}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); return; }
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || disabled) return;
          event.preventDefault(); event.stopPropagation();
          const step = event.shiftKey ? 0.1 : 0.01;
          const next = effectAreaGesture(effect.motion.area, handle, event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0);
          if (!same(next, effect.motion.area)) onCommands(command(next), "Change emitting area");
        }}>{handle === "move" ? "↔" : ""}</button>)}
    </div>
  </div>;
}

export function EffectAreaEditor(props: EffectAuthoringProps) {
  const { effect, disabled, onCommands, authoringRevision } = props, [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => { setError(null); }, [authoringRevision]);
  const apply = (area: Area) => {
    if (!EffectAreaSchema.safeParse(area).success) { setError("Keep the area inside the target, with positive width and height. Reduce Width or Height before moving an edge beyond it."); return; }
    setError(null); if (!same(area, effect.motion.area)) onCommands([{ kind: "effect-patch", clipId: effect.id, patch: { motion: { area } } }], "Change emitting area");
  };
  return <section className="fx-area" aria-label="Emitting area">
    <div className="fx-inspector__section-heading"><h3>Emitting area</h3><button type="button" disabled={disabled} onClick={() => apply({ x: 0, y: 0, width: 1, height: 1 })}>Full frame</button></div>
    <p className="fx-inspector__hint">Particle birth area, in target coordinates.</p>
    <div className="fx-area__diagram"><EffectAreaOverlay {...props} /></div>
    <div className="fx-area__fields">{(["x", "y", "width", "height"] as const).map((key, index) => <EffectNumberField key={key}
      label={["Left", "Top", "Width", "Height"][index]!} value={effect.motion.area[key] * 100} min={key === "width" || key === "height" ? 0.1 : 0} max={100} step={0.1} suffix="%" disabled={disabled}
      resetToken={authoringRevision}
      validate={value => EffectAreaSchema.safeParse({ ...effect.motion.area, [key]: rounded(value / 100) }).success ? null : "Keep the area inside the target, with positive width and height."}
      onCommit={value => apply({ ...effect.motion.area, [key]: rounded(value / 100) })} />)}</div>
    {error && <p className="fx-field__error" role="alert">{error}</p>}
  </section>;
}
