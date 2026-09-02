import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  DEFAULT_SHOT_SEC,
  effectiveFraming,
  orderedShots,
  resolveCast,
  stageShot,
  stagingRetimed,
  stagingFov,
  stagingMoveWord,
  type ClientMessage,
  type ProductionBundle,
  type SceneRecord,
  type Shot,
  type ShotStaging,
  type StagingKey,
  type WorldBundle,
} from "@arke-studio/contracts";
import { selectedShotId, useWorkspaceSelection } from "./selection.js";
import { figureColour, StageViewport, type StageData, type StageSelection } from "./stage-viewport.js";
import { stagePlayblast } from "../../lib/store.js";
import { Button } from "../../components/ui.js";
import { ChevronLeft, ChevronRight, Lamp, Minus, PauseSolid, PlaySolid, Plus, X } from "../../components/icons.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];

function aspectNumber(aspect: string): number {
  const [wide, high] = aspect.split(":").map(Number);
  return Number.isFinite(wide) && Number.isFinite(high) && high! > 0 ? wide! / high! : 16 / 9;
}

/** A staging with its bookkeeping stripped, for asking whether two are the same move. */
function moveOf(staging: ShotStaging | null): string {
  if (staging === null) return "";
  const { version: _version, playblast: _playblast, ...move } = staging;
  return JSON.stringify(move);
}

const round = (value: number): number => Math.round(value * 100) / 100;
const mix = (a: readonly [number, number, number], b: readonly [number, number, number], f: number): [number, number, number] => [
  round(a[0] + (b[0] - a[0]) * f),
  round(a[1] + (b[1] - a[1]) * f),
  round(a[2] + (b[2] - a[2]) * f),
];

function nearestKey(keys: readonly StagingKey[], at: number): number {
  let best = 0;
  keys.forEach((key, index) => {
    if (Math.abs(key.t - at) < Math.abs(keys[best]!.t - at)) best = index;
  });
  return best;
}

function sortedKeys(keys: readonly StagingKey[]): StagingKey[] {
  return [...keys].sort((left, right) => left.t - right.t);
}

const DEFAULT_POSE = { p: [0, 1.5, 3] as [number, number, number], l: [0, 1.2, 0] as [number, number, number] };

/**
 * The pose the camera holds at `at`: interpolated between the keys either side, the way the
 * viewport plays it, so a key inserted there starts from what was on screen. Keys on different
 * anchors are offsets in different spaces and do not blend; the nearer one stands for the pose.
 */
function sampledKey(keys: readonly StagingKey[], at: number): StagingKey {
  if (keys.length === 0) return { t: at, ...DEFAULT_POSE };
  let before = 0;
  while (before < keys.length - 1 && keys[before + 1]!.t <= at) before += 1;
  const a = keys[before]!;
  const b = keys[Math.min(keys.length - 1, before + 1)]!;
  if (a.anchor !== b.anchor || a.track !== b.track || b.t === a.t) return keys[nearestKey(keys, at)]!;
  const f = Math.max(0, Math.min(1, (at - a.t) / (b.t - a.t)));
  return { ...a, t: at, p: mix(a.p, b.p, f), l: mix(a.l, b.l, f) };
}

/** Insert-or-update at the playhead: the Blender workflow, move the playhead then the camera. */
function withKeyAt(staging: ShotStaging, at: number, patch: Partial<StagingKey>): { staging: ShotStaging; index: number } {
  const keys = staging.keys;
  const near = keys.findIndex((key) => Math.abs(key.t - at) < 0.12);
  if (near >= 0) {
    return { staging: { ...staging, keys: keys.map((key, index) => (index === near ? { ...key, ...patch } : key)) }, index: near };
  }
  // Only the edited channel changes; the rest of the pose is what was playing at the playhead.
  const made: StagingKey = { ...sampledKey(keys, at), ...patch, t: round(at) };
  const next = sortedKeys([...keys, made]);
  return { staging: { ...staging, keys: next }, index: next.indexOf(made) };
}

/** Where a figure stands at `at` seconds: on its walk when it has one, else where it was put. */
function figureAt(figure: ShotStaging["cast"][number], at: number, durationSec: number): { x: number; z: number } {
  if (figure.to === undefined) return { x: figure.x, z: figure.z };
  const u = durationSec <= 0 ? 0 : Math.max(0, Math.min(1, at / durationSec));
  return { x: figure.x + (figure.to[0] - figure.x) * u, z: figure.z + (figure.to[1] - figure.z) * u };
}

function keyName(index: number, count: number): string {
  return index === 0 ? "start" : index === count - 1 ? "end" : `key ${index}`;
}

/**
 * The Stage (the design's Stage tab; the Stage guide): a greybox previs where the shot is
 * blocked out — cast as figures, set as massing, one camera on a motion path — and exported as a
 * playblast the generator receives beside the sheets and the prompt.
 *
 * The staging is authored state on the shot. Edits accumulate in a local draft and land through
 * one `edit-shot` on Keep, so a dozen gizmo drags are one version rather than twelve; Discard
 * is the draft going away. Staging a shot for the first time writes at once — there is nothing
 * to weigh a fresh v1 against.
 */
export function SceneStage({
  scene,
  production,
  world,
  aspect,
  sceneFile,
  locked,
  generatorPending,
  refusalVersion,
  onCommand,
  onRenderShot,
}: {
  scene: SceneRecord;
  production: ProductionBundle;
  world: WorldBundle;
  aspect: string;
  sceneFile: string | undefined;
  locked: boolean;
  generatorPending: boolean;
  /** Counts up on every refused scene write, so a wait can end on a refusal as well as a landing. */
  refusalVersion: number;
  onCommand: (command: Command) => boolean;
  onRenderShot: (shotId: string) => void;
}) {
  const shots = orderedShots(scene);
  const { subject, select } = useWorkspaceSelection();
  const selected = selectedShotId(subject);
  const index = Math.max(0, shots.findIndex((candidate) => candidate.id === selected));
  const shot: Shot | null = shots[index] ?? null;
  const previous = index > 0 ? shots[index - 1] ?? null : null;
  const sheets = world.sheets;
  const persisted = shot?.staging ?? null;
  const durationSec = shot?.durationSec ?? DEFAULT_SHOT_SEC;
  const framing = shot === null ? {} : effectiveFraming(scene, shot);
  const references = useMemo(() => (shot === null ? [] : resolveCast(shot.description, [...sheets]).cast), [shot, sheets]);
  const castIds = references.filter((entry) => entry.sheet.type === "character").map((entry) => entry.sheet.id);
  const locationIds = [
    ...(scene.inherits?.location === undefined ? [] : [scene.inherits.location]),
    ...references.filter((entry) => entry.sheet.type === "location").map((entry) => entry.sheet.id),
  ].filter((id, position, list) => list.indexOf(id) === position);
  const nameOf = (sheetId: string) => sheets.find((sheet) => sheet.id === sheetId)?.name ?? sheetId;

  const [draft, setDraft] = useState<ShotStaging | null>(null);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [keyIndex, setKeyIndex] = useState(0);
  const [mode, setMode] = useState<"look" | "camera">("look");
  const [selection, setSelection] = useState<StageSelection>(null);
  const [ghost, setGhost] = useState(false);
  const [staging, setStaging] = useState(false);
  const [exporting, setExporting] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const viewport = useRef<StageViewport | null>(null);
  const playStart = useRef<{ wall: number; from: number } | null>(null);

  // The end key is the end pose, so it always sits at the shot's length: a staging kept before
  // the shot was retimed plays to its end pose here and is repaired by the next Keep.
  const working = useMemo(() => {
    const base = draft ?? persisted;
    return base === null ? null : stagingRetimed(base, durationSec);
  }, [draft, persisted, durationSec]);
  const moved = draft !== null && moveOf(draft) !== moveOf(persisted);
  const keys = working?.keys ?? [];
  const active = Math.max(0, Math.min(keyIndex, keys.length - 1));
  const activeKey = keys[active] ?? null;
  // The viewport outlives many renders and its callbacks must see the current draft, not the
  // one standing when it was created.
  const latest = useRef({ working, active });
  latest.current = { working, active };

  // A new snapshot that carries the draft's move retires the draft; one that does not — an edit
  // from elsewhere — leaves it standing, since the person's unsaved move is the newer decision.
  useEffect(() => {
    setDraft((current) => (current !== null && moveOf(current) === moveOf(persisted) ? null : current));
    setStaging(false);
  }, [persisted]);
  // A refused write ends the wait too, or "staging…" would stand forever over a refusal.
  useEffect(() => {
    setStaging(false);
  }, [refusalVersion]);
  useEffect(() => {
    setDraft(null);
    setAt(0);
    setPlaying(false);
    setKeyIndex(0);
    setSelection(null);
    setNote(null);
    playStart.current = null;
  }, [shot?.id]);

  // The clock is elapsed from a start timestamp, never accumulated (SPEC-036 R-29).
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const start = playStart.current;
      if (start === null) return;
      const next = start.from + (Date.now() - start.wall) / 1000;
      if (next >= durationSec) {
        setAt(durationSec);
        setPlaying(false);
        playStart.current = null;
        return;
      }
      setAt(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, durationSec]);

  const stop = () => {
    setPlaying(false);
    playStart.current = null;
  };
  const patch = (change: (current: ShotStaging) => ShotStaging) => {
    const current = latest.current.working;
    if (current === null) return;
    setDraft(change(current));
  };
  const patchKey = (which: number, change: Partial<StagingKey>) =>
    patch((current) => ({ ...current, keys: current.keys.map((key, position) => (position === which ? { ...key, ...change } : key)) }));

  const data: StageData | null = useMemo(() => {
    if (working === null || shot === null) return null;
    const ghosts = ghost && previous?.staging !== undefined ? previous.staging.cast : [];
    return {
      cast: working.cast.map((figure, position) => {
        const before = ghosts.find((candidate) => candidate.sheetId === figure.sheetId);
        return {
          sheetId: figure.sheetId,
          name: nameOf(figure.sheetId),
          colour: figureColour(position),
          x: figure.x,
          z: figure.z,
          to: figure.to ?? null,
          ghost: before === undefined ? null : (before.to ?? [before.x, before.z]),
        };
      }),
      sets: working.sets,
      keys: working.keys,
      durationSec,
      active,
      mode,
      at,
      fov: stagingFov(framing.lens),
      aspect: aspectNumber(aspect),
      lensLabel: framing.lens ?? "lens unset",
    };
  }, [working, shot, ghost, previous, durationSec, active, mode, at, framing.lens, aspect, sheets]);

  useEffect(() => {
    const element = host.current;
    if (element === null || data === null || viewport.current !== null) return;
    // No WebGL — a test DOM, a headless run — leaves the panel standing without a viewport.
    const probe = document.createElement("canvas");
    if (typeof probe.getContext !== "function") return;
    let context: RenderingContext | null = null;
    try {
      context = probe.getContext("webgl2") ?? probe.getContext("webgl");
    } catch {
      return;
    }
    if (context === null) return;
    const created = new StageViewport(element, data, {
      autokey: (when, p) => {
        stop();
        patch((current) => {
          const next = withKeyAt(current, when, { p });
          setKeyIndex(next.index);
          return next.staging;
        });
      },
      autoaim: (when, l) => {
        stop();
        patch((current) => {
          const next = withKeyAt(current, when, { l });
          const key = next.staging.keys[next.index]!;
          const { track: _track, ...free } = key;
          setKeyIndex(next.index);
          return { ...next.staging, keys: next.staging.keys.map((candidate, position) => (position === next.index ? free : candidate)) };
        });
      },
      castchange: (sheetId, x, z) =>
        patch((current) => ({ ...current, cast: current.cast.map((figure) => (figure.sheetId === sheetId ? { ...figure, x, z } : figure)) })),
      walkchange: (sheetId, x, z) =>
        patch((current) => ({ ...current, cast: current.cast.map((figure) => (figure.sheetId === sheetId ? { ...figure, to: [x, z] } : figure)) })),
      selchange: setSelection,
      trackpick: (sheetId) => patchKey(latest.current.active, { track: sheetId, l: [0, 1.25, 0] }),
    });
    viewport.current = created;
    return () => {
      created.dispose();
      viewport.current = null;
    };
    // The viewport is created once per staged shot; attribute changes flow through `set`.
  }, [shot?.id, data === null]);
  useEffect(() => {
    if (data !== null) viewport.current?.set(data);
  }, [data]);
  useEffect(() => {
    viewport.current?.select(selection);
  }, [selection]);

  if (shot === null) {
    return <div className="fy-swstage fy-swstage--empty" data-testid="workspace-stage">Add a shot to begin.</div>;
  }

  const write = (next: ShotStaging): boolean =>
    onCommand({ kind: "edit-shot", shotId: shot.id, change: { staging: next } });
  const stage = () => {
    const fresh = stageShot(shot, { cast: castIds, sets: locationIds.map(nameOf), durationSec, framing });
    if (write(fresh)) setStaging(true);
  };
  const keep = () => {
    if (draft === null || working === null || persisted === null) return;
    write({ ...working, version: persisted.version + 1, ...(persisted.playblast === undefined ? {} : { playblast: persisted.playblast }) });
  };
  const toggle = () => {
    if (playing) {
      stop();
      return;
    }
    const from = at >= durationSec ? 0 : at;
    playStart.current = { wall: Date.now(), from };
    setAt(from);
    setPlaying(true);
  };
  const seek = (which: number) => {
    stop();
    setKeyIndex(which);
    setAt(keys[which]?.t ?? 0);
  };
  const addKey = () => {
    if (working === null) return;
    // A staging with no keys (the schema reads them) gets its start and end poses first.
    if (keys.length === 0) {
      patch((current) => ({ ...current, keys: [{ t: 0, ...DEFAULT_POSE }, { t: round(durationSec), ...DEFAULT_POSE }] }));
      return;
    }
    const when = Math.max(0.05, Math.min(durationSec - 0.05, at));
    if (keys.some((key) => Math.abs(key.t - when) < 0.12)) return;
    const made: StagingKey = { ...sampledKey(keys, when), t: round(when) };
    const next = sortedKeys([...keys, made]);
    patch((current) => ({ ...current, keys: next }));
    setKeyIndex(next.indexOf(made));
  };
  const dropKey = () => {
    if (keys.length <= 2 || active === 0 || active === keys.length - 1) return;
    patch((current) => ({ ...current, keys: current.keys.filter((_, position) => position !== active) }));
    setKeyIndex(Math.max(0, active - 1));
  };
  const retime = (which: number, event: ReactMouseEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || which === 0 || which === keys.length - 1 || frozen) return;
    event.stopPropagation();
    const track = event.currentTarget.closest<HTMLElement>("[data-key-track]");
    if (track === null) return;
    const bounds = track.getBoundingClientRect();
    const low = keys[which - 1]!.t + 0.1;
    const high = keys[which + 1]!.t - 0.1;
    stop();
    setKeyIndex(which);
    const move = (next: MouseEvent) => {
      const when = round(Math.max(low, Math.min(high, ((next.clientX - bounds.left) / Math.max(1, bounds.width)) * durationSec)));
      patchKey(which, { t: when });
      setAt(when);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const nudge = (axis: 1 | 2, delta: number) => {
    if (activeKey === null) return;
    const p: [number, number, number] = [...activeKey.p];
    p[axis] = round(p[axis] + delta);
    patchKey(active, { p });
  };
  const anchorTo = (sheetId: string | null) => {
    if (activeKey === null || working === null) return;
    // Subjects are read where they stand AT THIS KEY'S TIME: a walking figure is well down its
    // path by the end key, and an offset taken from its start would jump the camera that far.
    const standingOf = (id: string | undefined) => {
      const figure = id === undefined ? undefined : working.cast.find((candidate) => candidate.sheetId === id);
      return figure === undefined ? undefined : figureAt(figure, activeKey.t, durationSec);
    };
    const base = standingOf(activeKey.anchor);
    const world: [number, number, number] = base === undefined ? [...activeKey.p] : [round(activeKey.p[0] + base.x), activeKey.p[1], round(activeKey.p[2] + base.z)];
    if (sheetId === null) {
      const { anchor: _anchor, ...free } = activeKey;
      patch((current) => ({ ...current, keys: current.keys.map((key, position) => (position === active ? { ...free, p: world } : key)) }));
      return;
    }
    const subject = standingOf(sheetId);
    const offset: [number, number, number] = subject === undefined ? world : [round(world[0] - subject.x), world[1], round(world[2] - subject.z)];
    patchKey(active, { anchor: sheetId, track: sheetId, p: offset });
  };
  const toggleWalk = (sheetId: string) =>
    patch((current) => ({
      ...current,
      cast: current.cast.map((figure) => {
        if (figure.sheetId !== sheetId) return figure;
        if (figure.to !== undefined) {
          const { to: _to, ...holds } = figure;
          return holds;
        }
        return { ...figure, to: [round(figure.x + 0.4), round(figure.z - 3.4)] };
      }),
    }));
  const exportPlayblast = async () => {
    const view = viewport.current;
    if (view === null || persisted === null || sceneFile === undefined || exporting !== null) return;
    stop();
    setNote(null);
    setExporting(0);
    try {
      const blob = await view.record(setExporting);
      // The viewport is disposed when the shot changes, and its recording ends early: a partial
      // take is never filed as the whole shot.
      if (viewport.current !== view) {
        setNote("export stopped — the shot changed");
        return;
      }
      const outcome = await stagePlayblast(
        {
          kind: "stage-playblast",
          worldId: world.meta.worldId,
          productionId: production.meta.id,
          sceneFile,
          sceneId: scene.id,
          baseVersion: scene.version,
          shotId: shot.id,
          stagingVersion: persisted.version,
          durationSec,
          aspect,
          // An unset lens is recorded as the empty string, so setting one later reads as a change.
          lens: framing.lens ?? "",
        },
        new Uint8Array(await blob.arrayBuffer()),
      );
      if (!outcome.ok) {
        setNote(outcome.reason);
        // A browser session has no host to file into; the file is still the person's to keep.
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `shot-${shot.number}-playblast.webm`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : "the playblast could not be recorded");
    } finally {
      setExporting(null);
    }
  };

  const selLabel =
    selection === null
      ? "nothing selected"
      : selection.kind === "rig"
        ? "camera"
        : selection.kind === "aim"
          ? "aim target"
          : `${nameOf(selection.sheetId)} · ${selection.kind === "cast" ? "start" : "end"}`;
  const filed = persisted?.playblast;
  // A playblast shows one staging at one length, lens and aspect; a pin that disagrees with any
  // of those is a file of a shot that no longer exists this way. Absent fields were never recorded.
  const stale =
    filed !== undefined &&
    (filed.version !== persisted?.version ||
      (filed.durationSec !== undefined && filed.durationSec !== durationSec) ||
      (filed.aspect !== undefined && filed.aspect !== aspect) ||
      (filed.lens !== undefined && filed.lens !== (framing.lens ?? "")));
  const ghostable = previous?.staging !== undefined;
  const busy = staging && persisted === null;
  // While the playblast records, the staging it shows must hold still (R-35). Only then: a draft
  // edit writes nothing, so a pending write has no claim on it.
  const frozen = exporting !== null;

  return (
    <section className="fy-swstage" data-testid="workspace-stage" aria-label="Stage">
      <div className="fy-swstage__head">
        <button
          type="button"
          className="fy-swstage__step"
          aria-label="Previous shot"
          disabled={index === 0 || exporting !== null}
          onClick={() => shots[index - 1] && select({ kind: "shot", shotId: shots[index - 1]!.id })}
        >
          <ChevronLeft size={12} />
        </button>
        <strong>Shot {shot.number}</strong>
        <button
          type="button"
          className="fy-swstage__step"
          aria-label="Next shot"
          disabled={index >= shots.length - 1 || exporting !== null}
          onClick={() => shots[index + 1] && select({ kind: "shot", shotId: shots[index + 1]!.id })}
        >
          <ChevronRight size={12} />
        </button>
        <span className="fy-swstage__meta">{shot.title} · {durationSec.toFixed(1)}s</span>
        {working === null ? null : (
          <span className="fy-swstage__version">
            v{persisted?.version ?? 1} · {keys.length} keys · {stagingMoveWord(keys, working.cast)}
          </span>
        )}
      </div>

      <div className="fy-swstage__work">
        <div className="fy-swstage__viewport" data-mode={mode}>
          {working === null ? null : <div ref={host} className="fy-swstage__canvas" data-testid="stage-viewport" />}
          {working === null && !busy ? (
            <div className="fy-swstage__empty">
              <span>Nothing staged yet.</span>
              <Button variant="primary" size="sm" disabled={locked} onClick={stage}>Stage the shot</Button>
            </div>
          ) : null}
          {busy ? <div className="fy-swstage__busy">staging…</div> : null}
          {mode === "camera" ? (
            <div className="fy-swstage__safe" aria-hidden="true"><span /><span /><span /></div>
          ) : null}
          {working === null ? null : (
            <>
              <div className="fy-swstage__modes" role="radiogroup" aria-label="View">
                {(["look", "camera"] as const).map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    role="radio"
                    aria-checked={mode === candidate}
                    data-on={mode === candidate ? "true" : undefined}
                    onClick={() => setMode(candidate)}
                  >
                    {candidate === "look" ? "Look" : "Camera"}
                  </button>
                ))}
              </div>
              <div className="fy-swstage__corner">
                {moved ? (
                  <span className="fy-swstage__moved" data-testid="stage-moved">
                    <span>{keyName(active, keys.length)} moved</span>
                    <button type="button" aria-label="Discard" title="Discard" onClick={() => setDraft(null)}><X size={11} /></button>
                    <button type="button" className="fy-swstage__keep" disabled={locked || frozen} onClick={keep}>Keep</button>
                  </span>
                ) : null}
                <button
                  type="button"
                  className="fy-swstage__ghost"
                  aria-pressed={ghost}
                  disabled={!ghostable}
                  title={ghostable ? "Ghost the previous shot" : "Previous shot not staged"}
                  aria-label="Ghost the previous shot"
                  onClick={() => setGhost((on) => !on)}
                >
                  <Lamp size={14} />
                </button>
              </div>
            </>
          )}
        </div>

        <aside className="fy-swstage__panel">
          {working === null ? (
            <p className="fy-swstage__note">Stage the shot to place the cast, put down the set and start a camera move.</p>
          ) : (
            <>
              <div className="fy-swstage__sel" data-selected={selection === null ? undefined : "true"} title="Click to select · drag the axis arrows to move it · in Camera view drag to pan and tilt · middle or right drag orbits the view">
                <span aria-hidden="true" />
                <span>{selLabel}</span>
              </div>

              <div className="fy-swstage__block">
                <div className="fy-swstage__eyebrow">
                  <span>Camera</span>
                  <span>{keyName(active, keys.length)}</span>
                </div>
                <div className="fy-swstage__row">
                  <span title="Drag the green arrow on the camera to raise or lower it">height</span>
                  <span>{activeKey === null ? "—" : `${activeKey.p[1].toFixed(2)}m`}</span>
                  <span className="fy-swstage__nudge">
                    <button type="button" aria-label="Lower" disabled={frozen} onClick={() => nudge(1, -0.1)}><Minus size={10} /></button>
                    <button type="button" aria-label="Raise" disabled={frozen} onClick={() => nudge(1, 0.1)}><Plus size={10} /></button>
                  </span>
                </div>
                <div className="fy-swstage__row">
                  <span title="Drag the red or blue arrow to move the camera across the floor">back</span>
                  <span>{activeKey === null ? "—" : `${activeKey.p[2].toFixed(2)}m`}</span>
                  <span className="fy-swstage__nudge">
                    <button type="button" aria-label="Closer" disabled={frozen} onClick={() => nudge(2, -0.25)}><Minus size={10} /></button>
                    <button type="button" aria-label="Further" disabled={frozen} onClick={() => nudge(2, 0.25)}><Plus size={10} /></button>
                  </span>
                </div>
                <div className="fy-swstage__row">
                  <span title="Drag the ring, or double-click a figure to track them">aim</span>
                  <span>{activeKey?.track === undefined ? "free" : nameOf(activeKey.track)}</span>
                </div>
                <div className="fy-swstage__row fy-swstage__row--chips">
                  <span title="World keys stay put; anchored keys ride with the subject, so you set the offset once">anchor</span>
                  <span className="fy-swstage__chips">
                    {[null, ...working.cast.map((figure) => figure.sheetId)].map((candidate) => (
                      <button
                        key={candidate ?? "world"}
                        type="button"
                        data-on={(activeKey?.anchor ?? null) === candidate ? "true" : undefined}
                        disabled={frozen}
                        onClick={() => anchorTo(candidate)}
                      >
                        {candidate === null ? "world" : nameOf(candidate)}
                      </button>
                    ))}
                  </span>
                </div>
                <span className="fy-swstage__quiet">{activeKey?.anchor === undefined ? "fixed in the set" : `rides with ${nameOf(activeKey.anchor)}`}</span>
              </div>

              {working.cast.length === 0 ? null : (
                <div className="fy-swstage__block">
                  <div className="fy-swstage__eyebrow"><span title="A walking figure draws a path on the floor · drag its ghost to set where it ends">Movement</span></div>
                  {working.cast.map((figure, position) => (
                    <button key={figure.sheetId} type="button" className="fy-swstage__mover" disabled={frozen} onClick={() => toggleWalk(figure.sheetId)}>
                      <span style={{ background: `#${figureColour(position).toString(16).padStart(6, "0")}` }} aria-hidden="true" />
                      <span>{nameOf(figure.sheetId)}</span>
                      <span data-walks={figure.to === undefined ? undefined : "true"}>{figure.to === undefined ? "holds" : "walks"}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="fy-swstage__block">
                <div className="fy-swstage__eyebrow"><span title="Resolved from the shot · reads out on the prompt">Framing</span></div>
                <div className="fy-swstage__row"><span>size</span><span>{framing.size?.toLowerCase() ?? "—"}</span></div>
                <div className="fy-swstage__row"><span>lens</span><span>{framing.lens ?? "—"}</span></div>
                <div className="fy-swstage__row"><span>movement</span><span>{framing.movement?.toLowerCase() ?? "—"}</span></div>
                {/* A shot written before the structured camera keeps its one line, and it still staged from it. */}
                {shot.camera === undefined || framing.size !== undefined || framing.movement !== undefined ? null : (
                  <div className="fy-swstage__row"><span>camera</span><span>{shot.camera}</span></div>
                )}
              </div>

              <span className="fy-swstage__spacer" />

              <div className="fy-swstage__block fy-swstage__block--playblast">
                <div className="fy-swstage__row">
                  <span>playblast</span>
                  <span data-filed={filed === undefined || stale ? undefined : "true"}>
                    {filed === undefined ? "not filed" : stale ? "filed · stale" : "filed"}
                  </span>
                </div>
                {note === null ? null : <span className="fy-swstage__quiet" role="status">{note}</span>}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={locked || moved || persisted === null || exporting !== null || sceneFile === undefined}
                  title={moved ? "Keep the move first" : undefined}
                  onClick={() => void exportPlayblast()}
                >
                  {exporting === null ? "Export playblast" : `exporting… ${Math.round(exporting * 100)}%`}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  // The session is prepared from the KEPT staging; a move still in hand would render the old one.
                  disabled={generatorPending || locked || moved}
                  title={moved ? "Keep the move first" : undefined}
                  onClick={() => onRenderShot(shot.id)}
                >
                  {generatorPending ? "Opening…" : "Render with this"}
                </Button>
              </div>
            </>
          )}
        </aside>
      </div>

      {working === null ? null : (
        <div className="fy-swstage__timeline">
          <button type="button" className="fy-swstage__play" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
            {playing ? <PauseSolid size={11} /> : <PlaySolid size={11} />}
          </button>
          <span className="fy-swstage__time">{Math.min(at, durationSec).toFixed(1)}s / {durationSec.toFixed(1)}s</span>
          <div className="fy-swstage__track" data-key-track="1">
            <span className="fy-swstage__rail" aria-hidden="true" />
            <span className="fy-swstage__head-fill" style={{ width: `${((Math.min(at, durationSec) / Math.max(0.01, durationSec)) * 100).toFixed(1)}%` }} aria-hidden="true" />
            {keys.map((key, position) => {
              const first = position === 0;
              const last = position === keys.length - 1;
              const left = `${Math.max(0, Math.min(100, (key.t / Math.max(0.01, durationSec)) * 100)).toFixed(2)}%`;
              return (
                <span
                  key={position}
                  className="fy-swstage__key"
                  data-on={position === active ? "true" : undefined}
                  data-mid={!first && !last ? "true" : undefined}
                  style={first ? { left: 0 } : last ? { right: 0 } : { left, transform: "translateX(-50%)" }}
                  title={`${keyName(position, keys.length)} · ${key.t.toFixed(1)}s${first || last ? "" : " · drag to retime"}`}
                  onMouseDown={(event) => {
                    if (first || last) {
                      event.stopPropagation();
                      seek(position);
                    } else retime(position, event);
                  }}
                >
                  <span aria-hidden="true" />
                  {position === active ? <b>{keyName(position, keys.length)} · {key.t.toFixed(1)}s</b> : null}
                </span>
              );
            })}
          </div>
          <span className="fy-swstage__keytools">
            <button type="button" aria-label="Add a camera key at the playhead" title="Add a camera key at the playhead" disabled={frozen} onClick={addKey}><Plus size={12} /></button>
            {keys.length > 2 ? (
              <button type="button" aria-label="Remove the selected key" title="Remove the selected key" disabled={frozen || active === 0 || active === keys.length - 1} onClick={dropKey}><Minus size={12} /></button>
            ) : null}
          </span>
          <span className="fy-swstage__count">{keys.length} keys</span>
        </div>
      )}
    </section>
  );
}
