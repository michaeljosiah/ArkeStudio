import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  MAX_PLACE_POSITIONS,
  PLACE_POSITION_NAME_MAX,
  STAGE_FRAME_ANGLE_LABELS,
  STAGE_FRAME_SIDE_LABELS,
  STAGE_FRAME_SIZE_LABELS,
  characterLabels,
  orderedShots,
  placePlanAfter,
  placePositionCamera,
  placePositionNameLength,
  placePositionShots,
  planBounds,
  planCast,
  planFrame,
  planSides,
  planSpot,
  scenePlacePlan,
  type PlacePlanChange,
  type PlacePosition,
  type PlacePositionWords,
  type PlanFrame,
  type PlanSide,
  type ProductionBundle,
  type SceneRecord,
  type StagingFigure,
  type StagingSet,
  type WorldBundle,
} from "@arke-studio/contracts";
import { PageSheet } from "../../components/page-sheet.js";
import { Plus } from "../../components/icons.js";
import { Button, cx } from "../../components/ui.js";
import { usePhone } from "../../lib/media-query.js";
import { changePlacePlan, subscribeCommandFailures } from "../../lib/store.js";
import { drawPlan, renderGreyView, type PlanPictureFigure } from "./plan-picture.js";
import { Eyebrow, Link, Row, Stepper, fieldEscape } from "./stage-inspector.js";
import { figureColour } from "./stage-viewport.js";

/**
 * The Plan (design turn 285, issue 2302): the place a scene is set in, seen from straight above,
 * with the scene's cast on their marks, the place's numbered camera positions, and each pair's
 * cameras held to one side of the line between them.
 *
 * Nothing here is a second copy of anything. The set and the positions are the place's plan as the
 * snapshot carries it, the marks and the sides are read from the scene by contracts, and a change
 * is one `place-plan` command whose answer is the next snapshot. So a position moved on another
 * scene's Plan has moved here, and what the screen holds while a change is in flight is only the
 * text being typed and the body being dragged.
 */

const NO_SETS: readonly StagingSet[] = [];
const NO_CAST: readonly StagingFigure[] = [];
const NO_POSITIONS: readonly PlacePosition[] = [];
const NO_SIDES: readonly PlanSide[] = [];
const NO_FIGURES: ReadonlyArray<PlanPictureFigure & { name: string }> = [];
const NO_WARN: readonly number[] = [];
/** The room is fitted to the view with this much round it, in metres. */
const MARGIN = 0.3;
/** The ground the picture is rendered on, before the canvas has drawn and where it cannot. */
const GROUND = 0xe6e3dd;
/** A new position's lens, until its own is chosen. */
const NEW_LENS_MM = 35;

const colourOf = (colour: number): string => `#${colour.toString(16).padStart(6, "0")}`;
const shotsWord = (count: number): string => `${count} ${count === 1 ? "shot" : "shots"}`;
const centimetres = (value: number): number => Math.round(value * 100) / 100;

type PositionEdit = Omit<Extract<PlacePlanChange, { op: "edit-position" }>, "op" | "n">;

export interface PlanPiece {
  name: string;
  x: number;
  z: number;
  /** Half of the floor it covers, east to west and north to south, as it is turned. */
  hx: number;
  hz: number;
  room: boolean;
}

/**
 * The set's pieces by name, each once, where the first of that name stands: three booths are
 * labelled once. A kit room is the floor everything else stands on; it can be framed, and it is
 * never labelled.
 */
export function planPieces(sets: readonly StagingSet[]): PlanPiece[] {
  const pieces: PlanPiece[] = [];
  for (const set of sets) {
    if (pieces.some((piece) => piece.name === set.name)) continue;
    const turn = ((set.rotation?.[1] ?? 0) * Math.PI) / 180;
    pieces.push({
      name: set.name, x: set.x, z: set.z, room: set.kit?.kind === "room",
      hx: Math.abs((set.w / 2) * Math.cos(turn)) + Math.abs((set.d / 2) * Math.sin(turn)),
      hz: Math.abs((set.w / 2) * Math.sin(turn)) + Math.abs((set.d / 2) * Math.cos(turn)),
    });
  }
  return pieces;
}

interface PlanLabel { key: string; text: string; left: number; top: number; colour?: number }
/** A box in the picture, by its centre and its size, in pixels. */
type Box = readonly [x: number, y: number, w: number, h: number];
const overlaps = (a: Box, b: Box): boolean => Math.abs(a[0] - b[0]) * 2 < a[2] + b[2] && Math.abs(a[1] - b[1]) * 2 < a[3] + b[3];

/**
 * Where each name is written on the plan. The Stage floats a label over its thing and a lens
 * rarely puts two in one place; from straight above a table's name lands on the camera that looks
 * down at it and a booth's on whoever sits there. So a name takes the first of a few places that
 * is clear of every mark, every position's body and every name already written: a person's above
 * their mark, then below it and beside it; a piece's on it, then off each of its edges and
 * corners. With no place clear it takes the first, and the bodies are drawn over the names so a
 * number always reads.
 * A label's size is reckoned from its letters, which is near enough to keep names off each other.
 */
function planLabels(frame: PlanFrame, size: readonly [number, number], pieces: readonly PlanPiece[], cast: ReadonlyArray<PlanPictureFigure & { name: string }>, positions: readonly PlacePosition[], body: number): PlanLabel[] {
  const at = (x: number, z: number) => planSpot(frame, x, z);
  const taken: Box[] = [];
  for (const position of positions) taken.push([...at(position.p[0], position.p[2]), body + 4, body + 4]);
  for (const member of cast) {
    taken.push([...at(member.x, member.z), 0.72 * frame.scale, 0.72 * frame.scale]);
    for (const mark of member.later) taken.push([...at(mark[0], mark[1]), 0.6 * frame.scale, 0.6 * frame.scale]);
  }
  const labels: PlanLabel[] = [];
  const write = (key: string, text: string, w: number, places: ReadonlyArray<readonly [number, number]>, colour?: number) => {
    const h = 20;
    const clear = places.find(([x, y]) => x - w / 2 >= 2 && x + w / 2 <= size[0] - 2 && y - h / 2 >= 2 && y + h / 2 <= size[1] - 2 && !taken.some((box) => overlaps(box, [x, y, w, h])));
    const [x, y] = clear ?? places[0]!;
    taken.push([x, y, w, h]);
    labels.push({ key, text, left: x, top: y, ...(colour === undefined ? {} : { colour }) });
  };
  for (const member of cast) {
    const [x, y] = at(member.x, member.z);
    const w = member.name.length * 6.5 + 20, ring = 0.36 * frame.scale;
    write(`cast:${member.sheetId}`, member.name, w, [[x, y - ring - 13], [x, y + ring + 13], [x + ring + w / 2 + 3, y], [x - ring - w / 2 - 3, y]], member.colour);
  }
  for (const piece of pieces) {
    const [x, y] = at(piece.x, piece.z);
    const w = piece.name.length * 6.5 + 16;
    const north = y - piece.hz * frame.scale - 13, south = y + piece.hz * frame.scale + 13;
    const east = x + piece.hx * frame.scale + w / 2 + 3, west = x - piece.hx * frame.scale - w / 2 - 3;
    write(`set:${piece.name}`, piece.name, w, [[x, y], [x, north], [x, south], [east, y], [west, y], [east, south], [west, south], [east, north], [west, north]]);
  }
  return labels;
}

/**
 * Where a new position stands: its default words solved through its lens, or, with nobody and
 * nothing to frame, two metres south of the set's centre at standing height, looking at the centre.
 */
export function newPlanPosition(stage: { cast: readonly StagingFigure[]; sets: readonly StagingSet[] }, aspect: string): Extract<PlacePlanChange, { op: "add-position" }> {
  const person = stage.cast[0];
  const piece = planPieces(stage.sets).find((candidate) => !candidate.room);
  const subject: PlacePositionWords["subject"] | null = person !== undefined ? { kind: "cast", sheetId: person.sheetId } : piece !== undefined ? { kind: "set", name: piece.name } : null;
  if (subject !== null) {
    const words: PlacePositionWords = { subject, size: "medium", angle: "eye", side: "front" };
    const camera = placePositionCamera(words, NEW_LENS_MM, stage, aspect);
    if (camera !== null) return { op: "add-position", p: camera.p, l: camera.l, focalMm: NEW_LENS_MM, words };
  }
  const bounds = planBounds(stage.sets, stage.cast.map((figure) => [figure.x, figure.z] as const));
  const cx = (bounds.x0 + bounds.x1) / 2, cz = (bounds.z0 + bounds.z1) / 2;
  return { op: "add-position", p: [cx, 1.5, cz + 2], l: [cx, 1, cz], focalMm: NEW_LENS_MM };
}

/** How many `place-plan` commands have been refused, so what was held for an answer is let go. */
export function usePlanRefusals(): number {
  const [count, setCount] = useState(0);
  useEffect(() => subscribeCommandFailures((failure) => { if (failure.command === "place-plan") setCount((before) => before + 1); }), []);
  return count;
}

/** The picture's own size, re-read as it changes; `fallback` until it has one. */
function useBox(host: RefObject<HTMLElement | null>, fallback: readonly [number, number]): readonly [number, number] {
  const [box, setBox] = useState(fallback);
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null) return;
    const measure = () => {
      const width = element.clientWidth, height = element.clientHeight;
      if (width > 0 && height > 0) setBox((before) => (before[0] === width && before[1] === height ? before : [width, height]));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [host]);
  return box;
}

/**
 * The plan picture: the canvas plan-picture.ts draws, and over it what is written on the plan.
 * Both are placed through one frame from contracts, so a number sits on the body the canvas drew.
 *
 * Three looks. On a scene at the desk it carries the Stage's labels, the scale and the crossing's
 * clause; on a phone numbers only, on heavier lines and larger bodies; on a location's sheet the
 * set's names as small tags and no cast.
 */
export function PlanView({ look, className, sets, cast = NO_FIGURES, sides = NO_SIDES, positions, selected, warn = NO_WARN, aspect, fallback, clause, settled = 0, onSelect, onMove }: {
  look: "desk" | "phone" | "place";
  className?: string;
  sets: readonly StagingSet[];
  cast?: ReadonlyArray<PlanPictureFigure & { name: string }>;
  sides?: readonly PlanSide[];
  positions: readonly PlacePosition[];
  selected: number | null;
  warn?: readonly number[];
  aspect: string;
  /** The size drawn at before the picture has been measured, and where nothing can measure it. */
  fallback: readonly [number, number];
  clause?: string | null;
  /** Changes when a change in flight was refused: a body held where it was dropped goes back. */
  settled?: number;
  onSelect: (n: number | null) => void;
  /** Present where a position may be moved by hand: the desk's Plan on a scene. Answers whether the move was sent. */
  onMove?: (n: number, p: [number, number, number]) => boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, height] = useBox(host, fallback);
  const [drag, setDrag] = useState<{ n: number; x: number; z: number } | null>(null);
  // Where a body was dropped, until the snapshot says the same: without it the body would jump
  // back to where the place still keeps it for the length of the round trip.
  const [held, setHeld] = useState<{ n: number; x: number; z: number; was: string } | null>(null);
  const weight = look === "phone" ? 1.8 : 1;
  const body = look === "phone" ? 0.38 : 0.21;

  useEffect(() => {
    if (held === null) return;
    const stored = positions.find((position) => position.n === held.n);
    if (stored === undefined || JSON.stringify(stored.p) !== held.was) setHeld(null);
  }, [held, positions]);
  useEffect(() => { setHeld(null); }, [settled]);

  // The view is fitted to where the place keeps things, never to a body in mid-drag: a frame that
  // followed the pointer would move the floor under it.
  const frame = useMemo(() => {
    const points: Array<readonly [number, number]> = [];
    for (const member of cast) points.push([member.x, member.z], ...member.later, ...member.walks.flat());
    for (const position of positions) points.push(held?.n === position.n ? [held.x, held.z] : [position.p[0], position.p[2]]);
    return planFrame(planBounds(sets, points), width, height, MARGIN);
  }, [sets, cast, positions, held, width, height]);
  const placed = useMemo(() => positions.map((position): PlacePosition => {
    const moved = drag?.n === position.n ? drag : held?.n === position.n ? held : null;
    return moved === null ? position : { ...position, p: [moved.x, position.p[1], moved.z] };
  }), [positions, drag, held]);
  const size = Math.max(16, 2 * body * frame.scale);
  // A phone's picture is numbers only: no set labels and no names (285f).
  const labels = useMemo(
    // Around where the place keeps each position, not a body in mid-drag: names that hopped out
    // of the pointer's way would be the picture moving under the hand.
    () => (look === "phone" ? [] : planLabels(frame, [width, height], planPieces(sets).filter((piece) => !piece.room), look === "desk" ? cast : NO_FIGURES, positions, size)),
    [look, frame, width, height, sets, cast, positions, size],
  );

  const signature = JSON.stringify([sets, cast, sides, placed.map((position) => [position.n, position.p, position.l, position.focalMm]), selected, warn, aspect, frame, weight, body]);
  useEffect(() => {
    const target = canvas.current;
    if (target === null) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    target.width = Math.round(width * ratio);
    target.height = Math.round(height * ratio);
    drawPlan(target, { sets, cast, sides, positions: placed, selected, warn, aspect, frame }, { weight, body });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const spot = (x: number, z: number): CSSProperties => {
    const [left, top] = planSpot(frame, x, z);
    return { left: `${left.toFixed(1)}px`, top: `${top.toFixed(1)}px` };
  };
  const beginMove = (event: ReactPointerEvent<HTMLButtonElement>, position: PlacePosition) => {
    if (onMove === undefined || event.button !== 0 || host.current === null) return;
    const target = event.currentTarget;
    // The floor starts inside the picture's border, where what is written on it is placed from.
    const box = host.current.getBoundingClientRect();
    const left = box.left + (host.current.clientLeft || 0), top = box.top + (host.current.clientTop || 0);
    const from = [event.clientX, event.clientY] as const;
    const pointer = event.pointerId;
    let at: { x: number; z: number } | null = null;
    target.setPointerCapture?.(pointer);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      // A press that barely moves is a press: the body is selected already and stays where it is.
      if (at === null && Math.hypot(next.clientX - from[0], next.clientY - from[1]) < 3) return;
      at = { x: centimetres(frame.x0 + (next.clientX - left) / frame.scale), z: centimetres(frame.z0 + (next.clientY - top) / frame.scale) };
      setDrag({ n: position.n, ...at });
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      setDrag(null);
      if (at === null || next.type === "pointercancel") return;
      // Held only for a change that went: one that was not sent has no answer to wait for.
      if (onMove(position.n, [at.x, position.p[1], at.z])) setHeld({ n: position.n, ...at, was: JSON.stringify(position.p) });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  return (
    <div
      ref={host}
      className={cx("pl-plan__picture", className)}
      style={{ background: colourOf(GROUND) }}
      // A press on the floor selects nothing. The labels take no presses, so the floor is the
      // picture itself or the canvas over it.
      onClick={(event) => { if (event.target === event.currentTarget || event.target === canvas.current) onSelect(null); }}
    >
      <canvas ref={canvas} aria-hidden="true" />
      {labels.map((label) => (
        <div
          key={label.key}
          className={look === "place" ? "pl-place__tag" : "fy-swstage__label"}
          data-cast={label.colour === undefined ? undefined : "true"}
          style={{ left: `${label.left.toFixed(1)}px`, top: `${label.top.toFixed(1)}px`, ...(label.colour === undefined ? {} : { "--fy-cast": colourOf(label.colour) }) } as CSSProperties}
        >
          {label.text}
        </div>
      ))}
      {placed.map((position) => (
        <button
          key={position.n}
          type="button"
          className="pl-plan__n"
          aria-label={position.name}
          aria-pressed={selected === position.n}
          data-selected={selected === position.n ? "true" : undefined}
          data-warn={warn.includes(position.n) ? "true" : undefined}
          data-movable={onMove === undefined ? undefined : "true"}
          style={{ ...spot(position.p[0], position.p[2]), width: size, height: size }}
          onPointerDown={onMove !== undefined && selected === position.n ? (event) => beginMove(event, position) : undefined}
          onClick={(event) => { event.stopPropagation(); onSelect(position.n); }}
        >
          {position.n}
        </button>
      ))}
      {look === "phone" ? null : <span className="pl-plan__scale"><i style={{ width: `${(2 * frame.scale).toFixed(1)}px` }} />2 m</span>}
      {clause ? <div className="pl-plan__find"><i />{clause}</div> : null}
    </div>
  );
}

/**
 * A position's name. The box holds what is being typed and the place holds the name: a name that
 * is empty, too long or another position's is not sent, and the stored one comes back.
 *
 * The length is counted as a person reads it, by contracts. A Yoruba letter with a dot below and
 * a tone mark is one letter and three code points, so the DOM's own maxlength, which counts code
 * units, would cut such a name short; a keystroke past the count is refused here instead.
 */
function NameField({ name, settled, onCommit }: { name: string; settled: number; onCommit: (name: string) => boolean }) {
  const [text, setText] = useState(name);
  const editing = useRef(false);
  // Escape puts the name back and leaves the box, and the blur that follows must not commit what
  // was typed: the revert has not rendered when blur() runs.
  const escaped = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(name);
  }, [name, settled]);
  const leave = () => {
    editing.current = false;
    if (escaped.current) { escaped.current = false; return; }
    const next = text.trim();
    if (next === "" || next === name || placePositionNameLength(next) > PLACE_POSITION_NAME_MAX || !onCommit(next)) setText(name);
    else setText(next);
  };
  return (
    <input
      className="fy-swstage__field"
      aria-label="Position name"
      value={text}
      onFocus={() => { editing.current = true; escaped.current = false; }}
      onChange={(event) => { if (placePositionNameLength(event.target.value) <= PLACE_POSITION_NAME_MAX) setText(event.target.value); }}
      onBlur={leave}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        else if (event.key === "Escape") { fieldEscape(event); escaped.current = true; setText(name); event.currentTarget.blur(); }
      }}
    />
  );
}

const subjectValue = (subject: PlacePositionWords["subject"]): string => (subject.kind === "cast" ? `cast:${subject.sheetId}` : `set:${subject.name}`);
function subjectOf(value: string): PlacePositionWords["subject"] | null {
  if (value.startsWith("cast:")) return { kind: "cast", sheetId: value.slice(5) };
  if (value.startsWith("set:")) return { kind: "set", name: value.slice(4) };
  return null;
}

/**
 * A position's form: its name, then the camera in the words the Stage writes one in (turn 229),
 * in the Stage inspector's own rows. Choosing any word writes all of them, solved through the
 * position's lens, in one change with where they put the camera; a lens is one of the words, so a
 * new lens solves them again. Words that cannot be solved here are left as they are.
 *
 * It is not the Stage's camera form: a position's subject may be a piece of the set, and its lens
 * is its own rather than a shot's.
 */
function PositionForm({ position, ordinal, count, people, pieces, nameOf, stage, aspect, settled, onEdit, onRemove }: {
  position: PlacePosition;
  ordinal: number;
  count: number;
  people: ReadonlyArray<{ sheetId: string; name: string }>;
  pieces: readonly string[];
  nameOf: (sheetId: string) => string;
  stage: { cast: readonly StagingFigure[]; sets: readonly StagingSet[] };
  aspect: string;
  settled: number;
  onEdit: (change: PositionEdit) => boolean;
  onRemove: () => void;
}) {
  const words = position.words;
  const first: PlacePositionWords["subject"] | null = people[0] !== undefined ? { kind: "cast", sheetId: people[0].sheetId } : pieces[0] !== undefined ? { kind: "set", name: pieces[0] } : null;
  const base: PlacePositionWords | null = words ?? (first === null ? null : { subject: first, size: "medium", angle: "eye", side: "front" });
  const person = words?.subject.kind === "cast" ? words.subject.sheetId : null;
  const choose = (change: Partial<PlacePositionWords>, focalMm = position.focalMm) => {
    if (base === null) return;
    const next: PlacePositionWords = { ...base, ...change };
    const who = next.subject.kind === "cast" ? next.subject.sheetId : null;
    if (next.side === "over") {
      const others = people.filter((figure) => figure.sheetId !== who);
      // Over a shoulder needs a person framed and another to stand behind.
      if (who === null || others.length === 0) next.side = "front";
      else if (!others.some((figure) => figure.sheetId === next.over)) next.over = others[0]!.sheetId;
    }
    if (next.side !== "over") delete next.over;
    const camera = placePositionCamera(next, focalMm, stage, aspect);
    if (camera === null) return;
    onEdit({ words: next, p: camera.p, l: camera.l, ...(focalMm === position.focalMm ? {} : { focalMm }) });
  };
  // Words written in another scene may name someone who is not in this one; they are still shown.
  const strangers = words === undefined ? [] : words.subject.kind === "cast"
    ? (people.some((figure) => figure.sheetId === person) ? [] : [{ value: subjectValue(words.subject), name: nameOf(words.subject.sheetId) }])
    : (pieces.includes(words.subject.name) ? [] : [{ value: subjectValue(words.subject), name: words.subject.name }]);
  return (
    <div className="fy-swstage__block" data-testid="plan-position">
      <Eyebrow title="Position" meta={`${ordinal} of ${count}`} />
      <div>
        <Row label="name"><NameField name={position.name} settled={settled} onCommit={(name) => onEdit({ name })} /></Row>
        <Row label="subject">
          <select className="fy-swstage__select" aria-label="Position subject" value={words === undefined ? "" : subjectValue(words.subject)} disabled={base === null}
            onChange={(event) => { const subject = subjectOf(event.target.value); if (subject !== null) choose({ subject }); }}>
            {words === undefined ? <option value="">—</option> : null}
            {strangers.map((stranger) => <option key={stranger.value} value={stranger.value}>{stranger.name}</option>)}
            {people.map((figure) => <option key={figure.sheetId} value={`cast:${figure.sheetId}`}>{figure.name}</option>)}
            {pieces.map((piece) => <option key={piece} value={`set:${piece}`}>{piece}</option>)}
          </select>
        </Row>
        <Row label="size">
          <span className="fy-swstage__chips" role="radiogroup" aria-label="Shot size">
            {STAGE_FRAME_SIZE_LABELS.map(([size, label]) => (
              <button key={size} type="button" role="radio" aria-checked={words?.size === size} data-on={words?.size === size ? "true" : undefined} disabled={base === null}
                onClick={() => choose({ size })}>{label}</button>
            ))}
          </span>
        </Row>
        <Row label="angle">
          <span className="fy-swstage__chips" role="radiogroup" aria-label="Camera angle">
            {STAGE_FRAME_ANGLE_LABELS.map(([angle, label]) => (
              <button key={angle} type="button" role="radio" aria-checked={words?.angle === angle} data-on={words?.angle === angle ? "true" : undefined} disabled={base === null}
                onClick={() => choose({ angle })}>{label}</button>
            ))}
          </span>
        </Row>
        <Row label="side">
          <select className="fy-swstage__select" aria-label="Camera side" value={words?.side ?? ""} disabled={base === null}
            onChange={(event) => { if (event.target.value) choose({ side: event.target.value as PlacePositionWords["side"] }); }}>
            {words === undefined ? <option value="">—</option> : null}
            {STAGE_FRAME_SIDE_LABELS.filter(([side]) => side !== "over" || words?.side === "over" || (people.length > 1 && person !== null)).map(([side, label]) => <option key={side} value={side}>{label}</option>)}
          </select>
        </Row>
        {words?.side === "over" ? (
          <Row label="over">
            <select className="fy-swstage__select" aria-label="Over whose shoulder" value={words.over ?? ""} onChange={(event) => { if (event.target.value) choose({ over: event.target.value }); }}>
              {people.filter((figure) => figure.sheetId !== person).map((figure) => <option key={figure.sheetId} value={figure.sheetId}>{figure.name}</option>)}
            </select>
          </Row>
        ) : null}
        <Row label="lens">
          <Stepper label="lens" value={position.focalMm} unit="mm" step={1} min={8} max={400} decimals={0}
            onCommit={(focalMm) => {
              if (focalMm === undefined || focalMm === position.focalMm) return;
              if (words === undefined) onEdit({ focalMm });
              else choose({}, focalMm);
            }} />
        </Row>
        <Row label=""><Link onClick={onRemove}>Remove position</Link></Row>
      </div>
    </div>
  );
}

/** A position's grey view, as one of the Stage's picture-in-picture; nothing where it cannot be rendered. */
function GreyView({ sets, position, aspect }: { sets: readonly StagingSet[]; position: PlacePosition; aspect: string }) {
  const [picture, setPicture] = useState<string | null>(null);
  const signature = JSON.stringify([sets, position.p, position.l, position.focalMm, aspect]);
  useEffect(() => {
    // The picture is half the inspector wide, or a phone's sheet wide; this is sharp at either.
    setPicture(renderGreyView(sets, position, aspect, 640));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  if (picture === null) return null;
  return (
    <div className="fy-swstage__block">
      <Eyebrow title="View" meta={aspect} />
      {/* Half the panel's width, as 285b draws it: the picture drawn from this view stands beside it. */}
      <div className="pl-plan__views">
        <div className="fy-swstage__pip pl-plan__view" style={{ "--pl-aspect": aspect.replace(":", " / ") } as CSSProperties}>
          <img src={picture} alt="" />
          <span>grey view</span>
        </div>
      </div>
    </div>
  );
}

export function ScenePlan({ world, production, scene, onOpenStage }: {
  world: WorldBundle;
  production: ProductionBundle;
  scene: SceneRecord;
  onOpenStage: (shotId: string) => void;
}) {
  const phone = usePhone();
  const refusals = usePlanRefusals();
  const aspect = production.meta.aspect ?? "16:9";
  const place = scene.inherits?.location;
  const plan = scenePlacePlan(world.placePlans, scene);
  // The place's set once it has a plan; until then the scene's own, which the first position makes the place's.
  const sets = plan?.sets ?? scene.blocking?.sets ?? NO_SETS;
  const positions = plan?.positions ?? NO_POSITIONS;
  const figures = scene.blocking?.cast ?? NO_CAST;
  const sheets = world.sheets;
  // What each person goes by in a row (design turn 194): a pair is written `Tunde · Ade`, and a
  // full name in each half would not fit the line it is written on, or the clause on the plan.
  const called = useMemo(() => characterLabels(sheets), [sheets]);
  const nameOf = (sheetId: string) => called.get(sheetId)?.label ?? sheets.find((sheet) => sheet.id === sheetId)?.name ?? sheetId;
  const shots = useMemo(() => orderedShots(scene), [scene]);
  const cast = useMemo(
    () => planCast(scene).map((figure, index) => ({ ...figure, colour: figureColour(index), name: called.get(figure.sheetId)?.label ?? sheets.find((sheet) => sheet.id === figure.sheetId)?.name ?? figure.sheetId })),
    [scene, sheets, called],
  );
  const sides = useMemo(() => planSides(scene, aspect), [scene, aspect]);
  const uses = useMemo(() => (plan === undefined ? new Map<number, number[]>() : placePositionShots(plan, scene)), [plan, scene]);
  const [selectedN, setSelected] = useState<number | null>(null);
  const current = positions.find((position) => position.n === selectedN) ?? null;
  // The number a position just added will take, so it is selected when the snapshot brings it.
  const awaited = useRef<number | null>(null);
  useEffect(() => {
    if (awaited.current === null || !positions.some((position) => position.n === awaited.current)) return;
    setSelected(awaited.current);
    awaited.current = null;
  }, [positions]);
  useEffect(() => { awaited.current = null; }, [refusals]);

  const first = shots[0];
  if (place === undefined) return null;
  if (plan === undefined && sets.length === 0) {
    // Nothing to draw yet: the set is built on the Stage, so that is the one way on from here.
    return (
      <section className="pl-plan pl-plan--empty" aria-label="Plan" data-testid="workspace-plan">
        <Button variant="outline" disabled={first === undefined} onClick={() => { if (first !== undefined) onOpenStage(first.id); }}>Open the Stage</Button>
      </section>
    );
  }

  const sceneFile = production.sceneFiles[scene.id];
  const from = sceneFile === undefined ? undefined : { productionId: production.meta.id, sceneFile, sceneId: scene.id };
  const send = (change: PlacePlanChange): boolean => changePlacePlan(world.meta.worldId, place, change, from);
  const edit = (n: number, change: PositionEdit): boolean => {
    const full: PlacePlanChange = { op: "edit-position", n, ...change };
    // The contract's own rule, asked before the send: a change the place would refuse (a name
    // another position holds) is not sent, and the screen keeps what the place keeps.
    if (plan !== undefined) {
      try { placePlanAfter(plan, full); } catch { return false; }
    }
    return send(full);
  };
  const stage = { cast: figures, sets };
  const add = () => {
    awaited.current = plan?.next ?? 1;
    if (!send(newPlanPosition(stage, aspect))) awaited.current = null;
  };
  const remove = (n: number) => { if (send({ op: "remove-position", n })) setSelected(null); };

  const crossing = new Set(sides.flatMap((side) => side.crossings));
  const crossed = shots.filter((shot) => crossing.has(shot.id));
  const warn = positions.filter((position) => crossed.some((shot) => shot.staging?.position === position.n)).map((position) => position.n);
  const pair = (side: PlanSide) => `${nameOf(side.left)} · ${nameOf(side.right)}`;
  const crossedPair = crossed.length === 1 ? sides.find((side) => side.crossings.includes(crossed[0]!.id)) : undefined;
  const clause = crossed.length === 0 ? null
    : crossedPair !== undefined ? `Shot ${crossed[0]!.number} crosses ${pair(crossedPair)}`
    : crossed.length <= 3 ? `Shots ${crossed.map((shot) => shot.number).join(", ")} cross`
    : `${crossed.length} shots cross`;
  const placedShots = [...uses.values()].reduce((total, numbers) => total + numbers.length, 0);
  const counts = `${positions.length} · ${placedShots} of ${shotsWord(shots.length)}`;
  const tone = (sheetId: string) => colourOf(cast.find((member) => member.sheetId === sheetId)?.colour ?? figureColour(0));
  const sideLine = (side: PlanSide, row: boolean) => (
    <div key={`${side.left}\n${side.right}`} className={row ? "pl-plan__row" : "fy-swstage__item pl-plan__side"} data-testid="plan-side">
      <span className="pl-plan__pair" aria-hidden="true"><i style={{ background: tone(side.left) }} /><i style={{ background: tone(side.right) }} /></span>
      <span>{pair(side)}</span>
      <span>
        {shotsWord(side.shotIds.length)} · {side.crossings.length === 0
          ? <em className="pl-plan__ok">clear</em>
          : <em className="pl-plan__warn">{side.crossings.length} {side.crossings.length === 1 ? "crossing" : "crossings"}</em>}
      </span>
    </div>
  );
  const form = current === null ? null : (
    <>
      <PositionForm
        key={current.n}
        position={current}
        ordinal={positions.indexOf(current) + 1}
        count={positions.length}
        people={figures.map((figure) => ({ sheetId: figure.sheetId, name: nameOf(figure.sheetId) }))}
        pieces={planPieces(sets).map((piece) => piece.name)}
        nameOf={nameOf}
        stage={stage}
        aspect={aspect}
        settled={refusals}
        onEdit={(change) => edit(current.n, change)}
        onRemove={() => remove(current.n)}
      />
      <GreyView sets={sets} position={current} aspect={aspect} />
    </>
  );

  if (phone) {
    // 285f: the picture at the page's width, then one list. A press opens the position's form as a
    // sheet; adding and moving a position are the desk's.
    return (
      <section className="pl-plan pl-plan--phone" aria-label="Plan" data-testid="workspace-plan">
        <PlanView look="phone" className="pl-plan__picture--phone" sets={sets} cast={cast} sides={sides} positions={positions} selected={current?.n ?? null} warn={warn} aspect={aspect} fallback={[350, 200]} onSelect={setSelected} />
        <div className="pl-plan__head"><span>Positions</span><span>{counts}</span></div>
        {positions.map((position) => (
          <button key={position.n} type="button" className="pl-plan__row" data-warn={warn.includes(position.n) ? "true" : undefined} aria-haspopup="dialog" onClick={() => setSelected(position.n)}>
            <span className="pl-plan__num">{position.n}</span>
            <span>{position.name}</span>
            <span>{shotsWord(uses.get(position.n)?.length ?? 0)}</span>
          </button>
        ))}
        {sides.length === 0 ? null : (
          <>
            <div className="pl-plan__head"><span>Sides</span><span>left · right</span></div>
            {sides.map((side) => sideLine(side, true))}
          </>
        )}
        {/* The Stage inspector's own sheet, so the form keeps the Stage's rows at a finger's size. */}
        <PageSheet open={current !== null} onClose={() => setSelected(null)} title={current?.name ?? ""} className="fy-stage-inspector-sheet">
          <div data-screen="shot"><div className="fy-swstage__panel">{form}</div></div>
        </PageSheet>
      </section>
    );
  }

  return (
    <section className="pl-plan" aria-label="Plan" data-testid="workspace-plan">
      <div className="fy-swstage__work">
        <PlanView
          look="desk"
          className="fy-swstage__viewport"
          sets={sets}
          cast={cast}
          sides={sides}
          positions={positions}
          selected={current?.n ?? null}
          warn={warn}
          aspect={aspect}
          fallback={[667, 440]}
          clause={clause}
          settled={refusals}
          onSelect={setSelected}
          // A hand move drops the words: they no longer say where the camera stands.
          onMove={(n, p) => edit(n, { p, words: null })}
        />
        <aside className="fy-swstage__panel" aria-label="Plan inspector">
          <div className="fy-swstage__block">
            <Eyebrow title="Positions" meta={counts} />
            {(current === null ? positions : [current]).map((position) => (
              <button
                key={position.n}
                type="button"
                className="fy-swstage__item"
                data-selected={current?.n === position.n ? "true" : undefined}
                data-warn={warn.includes(position.n) ? "true" : undefined}
                // The folded line is the way back to the list, as a pressed line is on the Stage.
                onClick={() => setSelected(current?.n === position.n ? null : position.n)}
              >
                <span className="pl-plan__num">{position.n}</span>
                <span>{position.name}</span>
                <span>{shotsWord(uses.get(position.n)?.length ?? 0)}</span>
              </button>
            ))}
            {current === null ? (
              <button type="button" className="fy-swstage__add" disabled={positions.length >= MAX_PLACE_POSITIONS} onClick={add}><Plus size={12} />Add position</button>
            ) : null}
          </div>
          {current !== null ? form : sides.length === 0 ? null : (
            <div className="fy-swstage__block">
              <Eyebrow title="Sides" meta="left · right" />
              {sides.map((side) => sideLine(side, false))}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
