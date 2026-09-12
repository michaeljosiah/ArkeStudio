import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_SHOT_SEC,
  effectiveStageBlocking,
  effectiveFraming,
  STAGE_FRAME_RATE,
  STAGE_RIGS,
  orderedShots,
  resolveCast,
  resolvedShotStaging,
  stageFigureAt,
  stageObjectAt,
  stageCameraKeyAt,
  sampleStageCamera,
  stageKeyOffset,
  type StageObjectMotion,
  type StagePerformanceKey,
  stageShot,
  STAGE_CAMERA_MOVES,
  stageCameraMove,
  type StageCameraMove,
  stageMotionSpeeds,
  stageSpeedWarning,
  stagePerformanceDeparture,
  stagingRetimed,
  stagingFov,
  stagingMotionWord,
  stagePlayblastIsStale,
  type ClientMessage,
  type ProductionBundle,
  type SceneRecord,
  type ResolvedShotStaging,
  type Shot,
  type StagingKey,
  type StagingSet,
  type WorldBundle,
} from "@arke-studio/contracts";
import { StageUnderlay } from "./stage-underlay.js";
import { Eyebrow, Link, Row, Stepper, Triad, Value, fieldEscape, sameLine } from "./stage-inspector.js";
import { selectedShotId, useWorkspaceSelection } from "./selection.js";
import { figureColour, StageViewport, type StageData, type StageSelection } from "./stage-viewport.js";
import { send, subscribeStageConstruction, beginStageExport, cancelStageExport, failStagePlayblastAction, stagePlayblast, writeStageExportFrame } from "../../lib/store.js";
import { Button } from "../../components/ui.js";
import { ChevronLeft, ChevronRight, Lamp, Minimize2, Minus, PauseSolid, PlaySolid, Plus, X } from "../../components/icons.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];
type MotionLane = { kind: "performance" | "object"; id: string };
type MotionMark = MotionLane & { index: number; keyCount: number };

function aspectNumber(aspect: string): number {
  const [wide, high] = aspect.split(":").map(Number);
  return Number.isFinite(wide) && Number.isFinite(high) && high! > 0 ? wide! / high! : 16 / 9;
}

/** A staging with its bookkeeping stripped, for asking whether two are the same move. */
function moveOf(staging: ResolvedShotStaging | null): string {
  if (staging === null) return "";
  const { version: _version, playblast: _playblast, ...move } = staging;
  return JSON.stringify(move);
}

function cameraOf(staging: ResolvedShotStaging | null): string {
  if (staging === null) return "";
  return JSON.stringify({ keys: staging.keys, performances: staging.performances, objectMotions: staging.objectMotions, authorship: staging.authorship, rig: staging.rig, seed: staging.seed, rigIntensity: staging.rigIntensity });
}

const round = (value: number): number => Math.round(value * 100) / 100;

function sortedKeys(keys: readonly StagingKey[]): StagingKey[] {
  return [...keys].sort((left, right) => left.t - right.t);
}

const DEFAULT_POSE = { p: [0, 1.5, 3] as [number, number, number], l: [0, 1.2, 0] as [number, number, number] };

/** Insert-or-update at the playhead: the Blender workflow, move the playhead then the camera. */
function withKeyAt(staging: ResolvedShotStaging, at: number, patch: Partial<StagingKey>, fov=34, aspect=16/9): { staging: ResolvedShotStaging; index: number } {
  const keys = staging.keys;
  const near = keys.findIndex((key) => Math.abs(key.t - at) < 0.12);
  if (near >= 0) {
    return { staging: { ...staging, keys: keys.map((key, index) => (index === near ? { ...key, ...patch } : key)) }, index: near };
  }
  // Only the edited channel changes; the rest of the pose is what was playing at the playhead.
  const made: StagingKey = { ...stageCameraKeyAt(staging, at, staging.keys.at(-1)?.t ?? DEFAULT_SHOT_SEC, fov, aspect), ...patch, t: round(at) };
  const next = sortedKeys([...keys, made]);
  return { staging: { ...staging, keys: next }, index: next.indexOf(made) };
}

function keyName(index: number, count: number): string {
  return index === 0 ? "start" : index === count - 1 ? "end" : `key ${index}`;
}

function holdsPosition(from: StagingKey, to: StagingKey): boolean {
  // Equal offsets only describe a hold when they belong to the same coordinate space.
  return from.anchor === to.anchor && (!from.anchor || (from.anchorSpace ?? "world") === (to.anchorSpace ?? "world")) &&
    from.p.reduce((distance, value, axis) => distance + (value - to.p[axis]!) ** 2, 0) < 1e-12;
}

/**
 * The Stage (the design's Stage tab; the Stage guide): a greybox previs where the shot is
 * blocked out — cast as figures, set as massing, one camera on a motion path — and exported as a
 * playblast the generator receives beside the sheets and the prompt.
 *
 * Cast and set blocking belong to the scene; camera keys belong to the shot. A complete shot
 * override is the deliberate exception. Both halves share one draft and one atomic Stage command,
 * so a dozen gizmo drags remain one version rather than twelve.
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
  playblastRequest,
  constructionRequest,
  fullscreen = null,
  head = true,
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
  constructionRequest?: { actionId: string; conversationId: string; shotId: string; instruction: string; preserve: "blocking" | "camera" | "none" };
  playblastRequest?: { actionId: string; conversationId: string; shotId: string };
  /** In full screen the way out sits on this head row (turn 144); null means the page is not in it. */
  fullscreen?: { leave: () => void } | null;
  /**
   * The head row — the shot stepper and the staging words. On the shot page (turn 145) the
   * filmstrip steps and the view row carries the words, so the row goes; in full screen it comes
   * back for the way out alone, which 144 put on this row.
   */
  head?: boolean;
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
  const sceneReferences = useMemo(
    () => shots.flatMap((candidate) => resolveCast(candidate.description, [...sheets]).cast),
    [shots, sheets],
  );
  const shotCastIds = useMemo(
    () => shot === null
      ? []
      : resolveCast(shot.description, [...sheets]).cast
        .filter((entry) => entry.sheet.type === "character")
        .map((entry) => entry.sheet.id),
    [shot, sheets],
  );
  const sceneCastIds = sceneReferences
    .filter((entry) => entry.sheet.type === "character")
    .map((entry) => entry.sheet.id)
    .filter((id, position, list) => list.indexOf(id) === position);
  const sceneLocationIds = [
    ...(scene.inherits?.location === undefined ? [] : [scene.inherits.location]),
    ...sceneReferences.filter((entry) => entry.sheet.type === "location").map((entry) => entry.sheet.id),
  ].filter((id, position, list) => list.indexOf(id) === position);
  const nameOf = (sheetId: string) => sheets.find((sheet) => sheet.id === sheetId)?.name ?? sheetId;

  const resolvedPersisted = useMemo(() => {
    if (persisted === null) return null;
    return stagingRetimed(resolvedShotStaging(scene, persisted), durationSec) as ResolvedShotStaging;
  }, [scene, persisted, durationSec]);
  const persistedScope = effectiveStageBlocking(scene, persisted ?? undefined).identity.owner;
  const [draft, setDraft] = useState<ResolvedShotStaging | null>(null);
  const [scope, setScope] = useState<"scene" | "shot">(persistedScope);
  const cameraDirty = useRef(false);
  const blockingDirty = useRef(false);
  const scopeDirty = useRef(false);
  const promotingBlocking = useRef(false);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [keyIndex, setKeyIndex] = useState(0);
  const [mode, setMode] = useState<"look" | "camera">("look");
  const [selection, setSelection] = useState<StageSelection>(null);
  const [motionMark, setMotionMark] = useState<MotionMark | null>(null);
  // Where the shot's form puts the reference rows; null while another form is up (turn 144).
  const [referenceSlot, setReferenceSlot] = useState<HTMLElement | null>(null);
  const stageRoot = useRef<HTMLElement | null>(null);
  const keyDrag = useRef<{ pointerId: number; which: number; lane?: MotionLane; left: number; width: number; low: number; high: number } | null>(null);
  const [ghost, setGhost] = useState(false);
  const [staging, setStaging] = useState(false);
  const [constructing, setConstructing] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [preserve, setPreserve] = useState<"blocking" | "camera" | "none">("blocking");
  const [inspectionRound, setInspectionRound] = useState<number | null>(null);
  const construction = useRef<{ id: string; version: number } | null>(null);
  const inspectionTimes = useRef<number[]>([]);
  const aiDraftVersion = useRef<number | null>(null);
  const [exporting, setExporting] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const viewport = useRef<StageViewport | null>(null);
  const playStart = useRef<{ wall: number; from: number } | null>(null);
  const handledPlayblastActions = useRef(new Set<string>());
  const frozen = locked || exporting !== null || constructing;

  // The end key is the end pose, so it always sits at the shot's length: a staging kept before
  // the shot was retimed plays to its end pose here and is repaired by the next Keep.
  const working = useMemo(() => {
    const base = draft ?? resolvedPersisted;
    return base === null ? null : stagingRetimed(base, durationSec);
  }, [draft, resolvedPersisted, durationSec]) as ResolvedShotStaging | null;
  const motionSpeeds = useMemo(() => working ? stageMotionSpeeds(working, durationSec) : [], [working, durationSec]);
  const cameraChanged = draft !== null && cameraOf(draft) !== cameraOf(resolvedPersisted);
  const motionChanged = draft !== null && (
    JSON.stringify(draft.performances) !== JSON.stringify(resolvedPersisted?.performances) ||
    JSON.stringify(draft.objectMotions) !== JSON.stringify(resolvedPersisted?.objectMotions)
  );
  const currentBlocking = effectiveStageBlocking(scene, persisted ?? undefined);
  const desiredBlocking = draft === null ? null : { cast: draft.cast, sets: draft.sets };
  const overrideChanged = draft !== null && (
    scope !== persistedScope ||
    (scope === "shot" && JSON.stringify(desiredBlocking) !== JSON.stringify({ cast: currentBlocking.cast, sets: currentBlocking.sets }))
  );
  const sharedChanged = draft !== null && scope === "scene" &&
    ((scene.blocking === undefined && promotingBlocking.current) ||
      JSON.stringify(desiredBlocking) !== JSON.stringify({ cast: scene.blocking?.cast ?? [], sets: scene.blocking?.sets ?? [] }));
  const moved = draft !== null && (cameraChanged || overrideChanged || sharedChanged);
  const keys = working?.keys ?? [];
  const active = Math.max(0, Math.min(keyIndex, keys.length - 1));
  const activeKey = keys[active] ?? null;
  // The viewport outlives many renders and its callbacks must see the current draft, not the
  // one standing when it was created.
  const latest = useRef({ working, active, frozen, at, framing, aspect });
  latest.current = { working, active, frozen, at, framing, aspect };

  // A new snapshot that carries the draft's move retires the draft; one that does not — an edit
  // from elsewhere — rebases any half the person did not touch and leaves their own half standing.
  useEffect(() => {
    const rebasedScope = scopeDirty.current ? scope : persistedScope;
    if (promotingBlocking.current && scene.blocking !== undefined) {
      promotingBlocking.current = false;
      blockingDirty.current = false;
    }
    if (!scopeDirty.current && scope !== persistedScope) setScope(persistedScope);
    setDraft((current) => {
      if (current === null) return null;
      if (resolvedPersisted === null) {
        if (aiDraftVersion.current === scene.version) return current;
        cameraDirty.current = false;
        blockingDirty.current = false;
        scopeDirty.current = false;
        promotingBlocking.current = false;
        return null;
      }
      // An absent shared block makes Scene a promotion of the private block, not an empty block.
      const rebasedBlocking = rebasedScope === "scene" && scene.blocking !== undefined
        ? { cast: scene.blocking.cast, sets: scene.blocking.sets }
        : { cast: resolvedPersisted.cast, sets: resolvedPersisted.sets };
      const rebased = {
        ...current,
        ...(!cameraDirty.current ? { keys: resolvedPersisted.keys } : {}),
        ...(!blockingDirty.current ? rebasedBlocking : {}),
      };
      if (moveOf(rebased) !== moveOf(resolvedPersisted) || rebasedScope !== persistedScope) return rebased;
      cameraDirty.current = false;
      blockingDirty.current = false;
      scopeDirty.current = false;
      promotingBlocking.current = false;
      return null;
    });
    setStaging(false);
  }, [scene.blocking, resolvedPersisted, persistedScope, scope]);
  useEffect(() => {
    if (draft === null) setScope(persistedScope);
  }, [draft, persistedScope]);
  // A refused write ends the wait too, or "staging…" would stand forever over a refusal.
  useEffect(() => {
    setStaging(false);
  }, [refusalVersion]);
  useEffect(() => {
    cameraDirty.current = false;
    blockingDirty.current = false;
    scopeDirty.current = false;
    promotingBlocking.current = false;
    setDraft(null);
    setAt(0);
    setPlaying(false);
    setKeyIndex(0);
    setSelection(null);
    setMotionMark(null);
    keyDrag.current = null;
    setNote(null);
    playStart.current = null;
  }, [shot?.id]);
  useEffect(() => {
    keyDrag.current = null;
  }, [frozen, durationSec, resolvedPersisted]);
  useEffect(() => {
    setMotionMark(null);
    // A landing keeps the selection while the thing is still on the stage (turn 144): a person who
    // kept the camera is still on the camera's form, and a removed figure's selection goes with it.
    setSelection((current) => {
      if (current === null || resolvedPersisted === null) return null;
      if (current.kind === "rig" || current.kind === "aim") return current;
      if (current.kind === "set") return resolvedPersisted.sets[current.index] === undefined ? null : current;
      return resolvedPersisted.cast.some((figure) => figure.sheetId === current.sheetId) ? current : null;
    });
  }, [resolvedPersisted]);
  // The selection is a line of the list. When the list loses that line — a set added and then
  // discarded with its draft, a figure gone from the blocking — the selection goes with it and the
  // viewport hears, or the panel would show no form at all: not the missing thing's, not the shot's.
  useEffect(() => {
    if (selection === null || working === null) return;
    const gone = selection.kind === "set"
      ? working.sets[selection.index] === undefined
      : (selection.kind === "cast" || selection.kind === "walkend") && !working.cast.some((figure) => figure.sheetId === selection.sheetId);
    if (!gone) return;
    setSelection(null);
    setMotionMark(null);
    viewport.current?.select(null);
  }, [working, selection]);
  useEffect(() => {
    if (motionMark === null) return;
    const marks = motionMark.kind === "performance"
      ? working?.performances?.find(track => track.sheetId === motionMark.id)?.keys
      : working?.objectMotions?.find(track => track.group === motionMark.id)?.keys;
    // The mark is gone or has a new neighbour; the figure or set it belonged to stays selected.
    if (marks?.length !== motionMark.keyCount) setMotionMark(null);
  }, [working, motionMark]);
  useEffect(() => {
    if (motionMark === null) return;
    const mark = stageRoot.current?.querySelector<HTMLElement>('[data-motion-mark="selected"]');
    const details = mark?.closest("details");
    if (details) details.open = true;
    mark?.scrollIntoView?.({ block: "nearest" });
  }, [motionMark]);

  // The clock is elapsed from a start timestamp, never accumulated (SPEC-036 R-29).
  useEffect(() => {
    if (!playing || frozen) {
      setPlaying(false);
      playStart.current = null;
      return;
    }
    let frame = 0;
    const tick = () => {
      const start = playStart.current;
      if (start === null) return;
      const wall = Date.now();
      const next = start.from + (wall - start.wall) / 1000;
      if (next >= durationSec && !loop) {
        setAt(durationSec);
        setPlaying(false);
        playStart.current = null;
        return;
      }
      const time = loop ? next % durationSec : next;
      if (next >= durationSec) playStart.current = { wall, from: time };
      setAt(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, durationSec, loop, frozen]);

  const stop = () => {
    setPlaying(false);
    playStart.current = null;
  };
  const patchCamera = (change: (current: ResolvedShotStaging) => ResolvedShotStaging) => {
    const { working: current, frozen: editingFrozen } = latest.current;
    if (current === null || editingFrozen) return;
    cameraDirty.current = true;
    const {authorship: _authorship, ...edited} = change(current);
    setDraft(edited);
  };
  const patchBlocking = (change: (current: ResolvedShotStaging) => ResolvedShotStaging) => {
    const { working: current, frozen: editingFrozen } = latest.current;
    if (current === null || editingFrozen) return;
    blockingDirty.current = true;
    const {authorship: _authorship, ...edited} = change(current);
    setDraft(edited);
  };
  const patchKey = (which: number, change: Partial<StagingKey>) =>
    patchCamera((current) => ({ ...current, keys: current.keys.map((key, position) => (position === which ? { ...key, ...change } : key)) }));

  const data: StageData | null = useMemo(() => {
    if (working === null || shot === null) return null;
    const ghosts = ghost && previous?.staging !== undefined ? effectiveStageBlocking(scene, previous.staging).cast : [];
    return {
      cast: working.cast.map((figure, position) => {
        const before = ghosts.find((candidate) => candidate.sheetId === figure.sheetId);
        return {
          sheetId: figure.sheetId,
          name: nameOf(figure.sheetId),
          colour: figureColour(position),
          x: figure.x,
          ...(figure.facing === undefined ? {} : { facing: figure.facing }),
          ...(figure.y === undefined ? {} : { y: figure.y }),
          ...(figure.parent === undefined ? {} : { parent: figure.parent }),
          ...(figure.height === undefined ? {} : { height: figure.height }),
          z: figure.z,
          pose: figure.pose ?? null,
          to: figure.to ?? null,
          ghost: before === undefined ? null : (before.to ?? [before.x, before.z]),
        };
      }),
      ...(working.performances ? { performances: working.performances } : {}),
      ...(working.objectMotions ? { objectMotions: working.objectMotions } : {}),
      sets: working.sets,
      keys: working.keys,
      durationSec,
      active,
      mode,
      at,
      fov: stagingFov(framing.lens, aspect),
      aspect: aspectNumber(aspect),
      lensLabel: framing.lens ?? "lens unset",
      rig: working.rig,
      seed: working.seed,
      rigIntensity: working.rigIntensity,
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
        patchCamera((current) => {
          const next = withKeyAt(current, when, { p }, stagingFov(latest.current.framing.lens,latest.current.aspect), aspectNumber(latest.current.aspect));
          setKeyIndex(next.index);
          return next.staging;
        });
      },
      autoaim: (when, l) => {
        stop();
        patchCamera((current) => {
          const next = withKeyAt(current, when, { l }, stagingFov(latest.current.framing.lens,latest.current.aspect), aspectNumber(latest.current.aspect));
          const key = next.staging.keys[next.index]!;
          const { track: _track, ...free } = key;
          setKeyIndex(next.index);
          return { ...next.staging, keys: next.staging.keys.map((candidate, position) => (position === next.index ? free : candidate)) };
        });
      },
      castchange: (sheetId, x, z) =>
        latest.current.working?.performances?.some(p => p.sheetId === sheetId) ? patchPerformanceAt(sheetId,{x,z}) : patchBlocking((current) => ({ ...current, cast: current.cast.map((figure) => (figure.sheetId === sheetId ? { ...figure, x, z } : figure)) })),
      walkchange: (sheetId, x, z) =>
        patchBlocking((current) => ({ ...current, cast: current.cast.map((figure) => (figure.sheetId === sheetId ? { ...figure, to: [x, z] } : figure)) })),
      selchange: selected => { setSelection(selected); setMotionMark(null); },
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

  const exportPlayblast = async (request?: { actionId: string; conversationId: string; shotId: string }) => {
    const view = viewport.current;
    if (view === null || persisted === null || sceneFile === undefined || exporting !== null || shot === null) return;
    const fail = (reason: string) => {
      setNote(reason);
      if (request) failStagePlayblastAction(world.meta.worldId, request.conversationId, request.actionId, reason);
    };
    stop();
    setNote(null);
    setExporting(0);
    try {
      const { jobId, openingFrame, referenceFrames } = await view.record({
        start: beginStageExport,
        write: writeStageExportFrame,
        cancel: cancelStageExport,
      }, setExporting);
      // The viewport is disposed when the shot changes, and its recording ends early: a partial
      // take is never filed as the whole shot.
      if (viewport.current !== view) {
        await cancelStageExport(jobId);
        fail("export stopped - the shot changed");
        return;
      }
      if (openingFrame.size === 0) {
        await cancelStageExport(jobId);
        fail("the Stage export came back empty - export it again");
        return;
      }
      const common = {
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
      };
      const target = request
        ? {
            kind: "conversation-action-stage-playblast-complete" as const,
            conversationId: request.conversationId,
            actionId: request.actionId,
            status: "completed" as const,
            ...common,
          }
        : { kind: "stage-playblast" as const, ...common };
      const frames = await Promise.all(referenceFrames.map(async ({ png, ...frame }) => ({ ...frame, bytes: new Uint8Array(await png.arrayBuffer()) })));
      const outcome = await stagePlayblast(target, jobId, new Uint8Array(await openingFrame.arrayBuffer()), frames);
      if (!outcome.ok) fail(outcome.reason);
    } catch (error) {
      fail(error instanceof Error ? error.message : "the playblast could not be recorded");
    } finally {
      setExporting(null);
    }
  };

  useEffect(() => {
    if (
      playblastRequest === undefined ||
      playblastRequest.shotId !== shot?.id ||
      persisted === null ||
      sceneFile === undefined ||
      viewport.current === null ||
      exporting !== null ||
      handledPlayblastActions.current.has(playblastRequest.actionId)
    ) return;
    handledPlayblastActions.current.add(playblastRequest.actionId);
    void exportPlayblast(playblastRequest);
  }, [playblastRequest, shot?.id, persisted, sceneFile, exporting]);

  useEffect(() => subscribeStageConstruction(result => {
    const pending = construction.current;
    if (!pending || result.requestId !== pending.id || result.worldId !== world.meta.worldId || result.shotId !== shot?.id || result.sceneId !== scene.id) return;
    if (result.baseVersion !== scene.version) {
      send({ kind: "stage-construct-cancel", worldId: world.meta.worldId, requestId: pending.id });
      setConstructing(false); setNote("The scene changed. Rebuild the blockout."); return;
    }
    setNote(result.detail);
    if (result.draft) {
      inspectionTimes.current = result.draft.sampleTimes ?? [];
      cameraDirty.current = true; blockingDirty.current = true; scopeDirty.current = true;
      aiDraftVersion.current = pending.version;
      setScope("shot");
      setDraft({ ...result.draft.staging, version: persisted?.version ?? 1, cast: result.draft.cast, sets: result.draft.sets });
    }
    if (result.status === "inspect") setInspectionRound(result.round);
    if (result.status === "ready" || result.status === "failed") { setConstructing(false); setInspectionRound(null); }
  }), [world.meta.worldId, shot?.id, scene.id, scene.version, persisted?.version]);
  useEffect(() => {
    if (inspectionRound === null || !data || !constructing) return;
    let live = true;
    const round = inspectionRound;
    const pending = construction.current;
    const frame = requestAnimationFrame(() => {
      const view = viewport.current;
      if (!pending) return;
      if (!view) { setNote("3D rendering is unavailable. The partial draft is retained."); send({kind:"stage-construct-cancel",worldId:world.meta.worldId,requestId:pending.id}); return; }
      void view.inspectFrames(inspectionTimes.current).then(frames => {
        if (live) send({ kind: "stage-inspection", worldId: world.meta.worldId, requestId: pending.id, round, frames });
      }).catch(error => {
        if (live) { setNote(String(error)); send({ kind: "stage-construct-cancel", worldId: world.meta.worldId, requestId: pending.id }); }
      });
    });
    return () => { live = false; cancelAnimationFrame(frame); };
  }, [inspectionRound, data, constructing, world.meta.worldId]);
  useEffect(() => () => {
    const pending = construction.current;
    if (pending) send({ kind: "stage-construct-cancel", worldId: world.meta.worldId, requestId: pending.id });
    construction.current = null; aiDraftVersion.current = null;
    setConstructing(false); setInspectionRound(null);
  }, [shot?.id, world.meta.worldId]);
  const construct = (request?: typeof constructionRequest) => {
    if (!shot || moved || frozen) return;
    stop();
    const id = crypto.randomUUID();
    if (send({ kind: "stage-construct", worldId: world.meta.worldId, productionId: production.meta.id, sceneId: scene.id, shotId: shot.id, baseVersion: scene.version, requestId: id, instruction: request?.instruction ?? instruction, preserve: request?.preserve ?? (persisted || scene.blocking ? preserve : "none"), ...(request ? { actionId: request.actionId, conversationId: request.conversationId } : {}) })) {
      construction.current = { id, version: scene.version }; setConstructing(true); setNote("Constructing the scene and camera…");
    }
  };
  const handledConstructions = useRef(new Set<string>());
  useEffect(() => {
    if (!constructionRequest || constructionRequest.shotId !== shot?.id || moved || frozen || handledConstructions.current.has(constructionRequest.actionId)) return;
    handledConstructions.current.add(constructionRequest.actionId);
    construct(constructionRequest);
  }, [constructionRequest, shot?.id, moved, frozen]);
  if (shot === null) {
    // No shot, no head row: the way out of full screen stands alone in the corner the row would fill.
    return (
      <div className="fy-swstage fy-swstage--empty" data-testid="workspace-stage">
        Add a shot to begin.
        {fullscreen === null ? null : (
          <button type="button" className="fy-swstage__exit" title="Leave full screen · Esc" aria-label="Leave full screen" onClick={fullscreen.leave}>
            <Minimize2 size={14} />
          </button>
        )}
      </div>
    );
  }

  const stage = () => {
    const inherited = effectiveStageBlocking(scene, undefined);
    const firstBlock = scene.blocking === undefined
      ? stageShot(shot, { cast: sceneCastIds, sets: sceneLocationIds.map(nameOf), durationSec, framing, aspect })
      : null;
    const availableCast = firstBlock?.cast ?? inherited.cast;
    const cameraCastIds = shotCastIds.filter((id) => availableCast.some((figure) => figure.sheetId === id));
    const fresh = stageShot(shot, {
      cast: cameraCastIds,
      aspect,
      subjectHeight: availableCast.find(figure => figure.sheetId === cameraCastIds[0])?.height,
      sets: [],
      durationSec,
      framing,
    });
    const first = fresh.cast[0];
    const placed = first && availableCast.find(figure => figure.sheetId === first.sheetId);
    if (first && placed) for (const key of fresh.keys) {
      if (!key.anchor) { key.p[0] += placed.x - first.x; key.p[2] += placed.z - first.z; }
      if (!key.anchor && !key.track) { key.l[0] += placed.x - first.x; key.l[2] += placed.z - first.z; }
    }
    const { cast: _cast, sets: _sets, version: _version, playblast: _playblast, ...camera } = fresh;
    if (onCommand({
      kind: "edit-stage",
      shotId: shot.id,
      staging: camera,
      ...(firstBlock === null ? {} : { blocking: { cast: firstBlock.cast, sets: firstBlock.sets } }),
    })) setStaging(true);
  };
  const keep = () => {
    if (draft === null || working === null) return;
    if (aiDraftVersion.current !== null && aiDraftVersion.current !== scene.version) { setNote("The source scene changed. Rebuild before Keep."); return; }
    const command: Extract<Command, { kind: "edit-stage" }> = { kind: "edit-stage", shotId: shot.id };
    if (cameraChanged || overrideChanged) {
      command.staging = {
        keys: working.keys,
        ...(working.performances ? { performances: working.performances } : {}),
        ...(working.objectMotions ? { objectMotions: working.objectMotions } : {}),
        ...(working.authorship ? { authorship: working.authorship } : {}),
        ...(working.rig === undefined ? {} : { rig: working.rig }),
        ...(working.seed === undefined ? {} : { seed: working.seed }),
        ...(working.rigIntensity === undefined ? {} : { rigIntensity: working.rigIntensity }),
        ...(scope === "shot" ? { cast: working.cast, sets: working.sets } : {}),
      };
    }
    if (sharedChanged) command.blocking = { cast: working.cast, sets: working.sets };
    if (onCommand(command)) aiDraftVersion.current = null;
  };
  const discard = () => {
    aiDraftVersion.current = null;
    cameraDirty.current = false;
    blockingDirty.current = false;
    scopeDirty.current = false;
    promotingBlocking.current = false;
    setDraft(null);
  };
  const chooseScope = (next: "scene" | "shot") => {
    if (working === null || next === scope) return;
    scopeDirty.current = true;
    promotingBlocking.current = next === "scene" && scene.blocking === undefined;
    if (next === "scene" && !promotingBlocking.current) blockingDirty.current = false;
    setDraft({
      ...working,
      ...(next === "scene" && scene.blocking !== undefined
        ? { cast: scene.blocking.cast, sets: scene.blocking.sets }
        : {}),
    });
    setScope(next);
  };
  const toggle = () => {
    if (frozen) return;
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
    if (frozen || keys[which] === undefined) return;
    stop();
    setKeyIndex(which);
    setMotionMark(null);
    setAt(keys[which]?.t ?? 0);
    // The key a person pressed is the camera's; the camera's form follows it (turn 144).
    if (selection?.kind !== "rig" && selection?.kind !== "aim") {
      setSelection({ kind: "rig" });
      viewport.current?.select({ kind: "rig" });
    }
  };
  const seekTime = (time: number) => {
    if (latest.current.frozen) return;
    stop();
    setAt(Math.max(0, Math.min(durationSec, time)));
  };
  // Shortcuts belong to this Stage, leaving text entry and native button activation alone.
  const timelineKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (frozen || working === null || event.altKey || event.ctrlKey || event.metaKey ||
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (event.key === " " && target.closest('button, summary, [role="button"]')) return;
    if (event.key === " ") { if (!event.repeat) toggle(); }
    else if (event.key === "ArrowLeft") seekTime(at - 1 / STAGE_FRAME_RATE);
    else if (event.key === "ArrowRight") seekTime(at + 1 / STAGE_FRAME_RATE);
    else if (event.key === "Home") seekTime(0);
    else if (event.key === "End") seekTime(durationSec);
    else if (/^[1-9]$/.test(event.key) && keys[Number(event.key) - 1]) seek(Number(event.key) - 1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const scrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (latest.current.frozen) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    seekTime((event.clientX - bounds.left) / Math.max(1, bounds.width) * durationSec);
  };
  const addKey = () => {
    if (working === null) return;
    // A staging with no keys (the schema reads them) gets its start and end poses first.
    if (keys.length === 0) {
      patchCamera((current) => ({ ...current, keys: [{ t: 0, ...DEFAULT_POSE }, { t: round(durationSec), ...DEFAULT_POSE }] }));
      return;
    }
    const when = Math.max(0.05, Math.min(durationSec - 0.05, at));
    if (keys.some((key) => Math.abs(key.t - when) < 0.12)) return;
    const made: StagingKey = { ...stageCameraKeyAt(working!, when, durationSec, stagingFov(framing.lens,aspect),aspectNumber(aspect)), t: round(when) };
    const next = sortedKeys([...keys, made]);
    patchCamera((current) => ({ ...current, keys: next }));
    setKeyIndex(next.indexOf(made));
  };
  const dropKey = () => {
    if (keys.length <= 2 || active === 0 || active === keys.length - 1) return;
    patchCamera((current) => ({ ...current, keys: current.keys.filter((_, position) => position !== active) }));
    setKeyIndex(Math.max(0, active - 1));
  };
  const motionKeys = (current: ResolvedShotStaging, lane: MotionLane) => lane.kind === "performance"
    ? current.performances?.find(track => track.sheetId === lane.id)?.keys ?? []
    : current.objectMotions?.find(track => track.group === lane.id)?.keys ?? [];
  const selectMotion = (lane: MotionLane, which: number) => {
    if (frozen || working === null) return;
    const key = motionKeys(working, lane)[which];
    if (!key) return;
    seekTime(key.t);
    setMotionMark({ ...lane, index: which, keyCount: motionKeys(working, lane).length });
    const setIndex = lane.kind === "object" ? working.sets.findIndex((set) => set.group === lane.id) : -1;
    const selected: StageSelection = lane.kind === "performance" ? { kind: "cast", sheetId: lane.id } : setIndex < 0 ? null : { kind: "set", index: setIndex };
    setSelection(selected);
    viewport.current?.select(selected);
  };
  const retime = (which: number, event: ReactPointerEvent<HTMLElement>, lane?: MotionLane) => {
    event.stopPropagation();
    if (event.button !== 0 || frozen || working === null) return;
    event.preventDefault();
    const track = event.currentTarget.closest<HTMLElement>("[data-key-track]");
    if (track === null) return;
    event.currentTarget.focus();
    const marks = lane ? motionKeys(working, lane) : keys;
    const key = marks[which];
    if (!key) return;
    if (lane) selectMotion(lane, which);
    else seek(which);
    if (!lane && (which === 0 || which === keys.length - 1)) return;
    const bounds = track.getBoundingClientRect();
    // Preserve already-close marks; dragging must never cross a neighbour or pin a late action.
    const low = which === 0 ? 0 : Math.min(key.t, marks[which - 1]!.t + 0.1);
    const high = which === marks.length - 1 ? durationSec : Math.max(key.t, marks[which + 1]!.t - 0.1);
    keyDrag.current = { pointerId: event.pointerId, which, ...(lane ? { lane } : {}), left: bounds.left, width: bounds.width, low, high };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveKey = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = keyDrag.current;
    if (!drag || drag.pointerId !== event.pointerId || latest.current.frozen) return;
    const when = Math.max(drag.low, Math.min(drag.high, round((event.clientX - drag.left) / Math.max(1, drag.width) * durationSec)));
    const { lane, which } = drag;
    if (!lane) patchKey(which, { t: when });
    else patchCamera(current => lane.kind === "performance"
      ? { ...current, performances: current.performances?.map(track => track.sheetId === lane.id ? { ...track, keys: track.keys.map((key, i) => i === which ? { ...key, t: when } : key) } : track) }
      : { ...current, objectMotions: current.objectMotions?.map(track => track.group === lane.id ? { ...track, keys: track.keys.map((key, i) => i === which ? { ...key, t: when } : key) } : track) });
    setAt(when);
  };
  const endKeyDrag = (event: ReactPointerEvent<HTMLElement>) => {
    keyDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const anchorTo = (sheetId: string | null) => {
    if (activeKey === null || working === null) return;
    const world = sampleStageCamera({...working, keys:[activeKey]},activeKey.t,durationSec);
    const {anchor: _anchor, anchorSpace: _space, ...free} = activeKey;
    const key = sheetId ? {...free,anchor:sheetId} : free;
    patchKey(active,{...key,anchor:sheetId ?? undefined,anchorSpace:undefined,
      p:stageKeyOffset(working,key,world.p,key.t,durationSec),
      l:activeKey.track ? activeKey.l : stageKeyOffset(working,key,world.l,key.t,durationSec)});
  };

  const toggleWalk = (sheetId: string) =>
    patchBlocking((current) => ({
      ...current,
      cast: current.cast.map((figure) => {
        if (figure.sheetId !== sheetId) return figure;
        if (figure.to !== undefined) {
          const { to: _to, ...holds } = figure;
          return holds;
        }
        const { pose: _pose, ...standing } = figure;
        return { ...standing, to: [round(figure.x + 0.4), round(figure.z - 3.4)] };
      }),
    }));
  const patchPerformanceAt = (sheetId: string, change: Partial<StagePerformanceKey>, time = latest.current.at) => {
    patchCamera(current => {
      const figure = current.cast.find(f => f.sheetId === sheetId);
      if (!figure) return current;
      const existing = current.performances?.find(p => p.sheetId === sheetId);
      const keys = existing?.keys ?? [{ t: 0, easeIn: 0, easeOut: 0, ...stageFigureAt({...figure,parent:undefined}, undefined, 0, durationSec) }, { t: durationSec, easeIn: 0, easeOut: 0, ...stageFigureAt({...figure,parent:undefined}, undefined, durationSec, durationSec) }];
      const near = keys.findIndex(key => Math.abs(key.t - time) < 0.01);
      const next = near >= 0 ? keys.map((key,i) => i === near ? {...key,...change} : key) : [...keys,{t:round(time),easeIn:0,easeOut:0,...stageFigureAt({...figure,parent:undefined},current.performances,time,durationSec),...change}];
      return {...current, performances:[...(current.performances ?? []).filter(p=>p.sheetId!==sheetId),{sheetId,keys:next.sort((a,b)=>a.t-b.t)}]};
    });
  };
  const patchObjectAt = (group: string, change: Partial<StageObjectMotion["keys"][number]>, time = latest.current.at) => {
    patchCamera(current => {
      const existing = current.objectMotions?.find(m=>m.group===group);
      const keys = existing?.keys ?? [{t:0,...stageObjectAt(undefined,group,0)},{t:durationSec,...stageObjectAt(undefined,group,0)}];
      const near = keys.findIndex(k=>Math.abs(k.t-time)<.01);
      const next = near>=0 ? keys.map((k,i)=>i===near?{...k,...change}:k) : [...keys,{t:round(time),...stageObjectAt(current.objectMotions,group,time),...change}];
      return {...current,objectMotions:[...(current.objectMotions??[]).filter(m=>m.group!==group),{...existing,group,keys:next.sort((a,b)=>a.t-b.t)}]};
    });
  };
  const patchSet = (which: number, change: Partial<StagingSet>) =>
    patchBlocking((current) => ({
      ...current,
      sets: current.sets.map((set, position) => position === which ? { ...set, ...change } : set),
    }));
  const addSet = () => {
    if (working === null) return;
    const index = working.sets.length;
    patchBlocking((current) => {
      const figure = current.cast[0];
      return {
        ...current,
        sets: [...current.sets, {
          name: `set ${current.sets.length + 1}`,
          x: figure?.x ?? 0,
          z: round((figure?.z ?? 0) + 1),
          w: 1,
          h: 0.75,
          d: 1,
        }],
      };
    });
    // A new set is the thing to name next, so it is the selection (turn 144).
    const selected: StageSelection = { kind: "set", index };
    setSelection(selected);
    setMotionMark(null);
    viewport.current?.select(selected);
  };
  const removeSet = (which: number) => {
    patchBlocking((current) => ({ ...current, sets: current.sets.filter((_, position) => position !== which) }));
    // The selection is a position in the list: the removed set's clears, and a set after it moves up,
    // or the next set would inherit the selection and take the edits meant for the one removed.
    if (selection?.kind !== "set" || selection.index < which) return;
    const next: StageSelection = selection.index === which ? null : { kind: "set", index: selection.index - 1 };
    setSelection(next);
    setMotionMark(null);
    viewport.current?.select(next);
  };
  // A set's group is a name other things hold — its motion track, a camera anchor or track, a
  // figure's parent. When the group's last set is renamed those follow, and when it is cleared they
  // go; either way Keep would otherwise be refused for naming a group that no longer exists, or in
  // scene scope the blocking would save with the shot's references dangling.
  const patchGroup = (which: number, next: string | undefined) => {
    const { working: current, frozen: editingFrozen } = latest.current;
    if (current === null || editingFrozen) return;
    const previous = current.sets[which]?.group;
    const orphaned = previous !== undefined && !current.sets.some((set, position) => position !== which && set.group === previous);
    const follow = <T extends { anchor?: string; track?: string; parent?: string }>(thing: T, field: "anchor" | "track" | "parent"): T => {
      if (!orphaned || thing[field] !== previous) return thing;
      const { [field]: _stale, ...rest } = thing;
      return (next === undefined ? rest : { ...rest, [field]: next }) as T;
    };
    const keys = current.keys.map((key) => follow(follow(key, "anchor"), "track"));
    const motions = (current.objectMotions ?? []).flatMap((motion) => {
      if (!orphaned || motion.group !== previous) return [motion];
      // A group has one track: a rename onto a group that already moves keeps that group's track.
      if (next === undefined || current.objectMotions!.some((other) => other.group === next)) return [];
      return [{ ...motion, group: next }];
    });
    const cameraTouched = keys.some((key, position) => key !== current.keys[position])
      || motions.length !== (current.objectMotions?.length ?? 0) || motions.some((motion, position) => motion !== current.objectMotions![position]);
    blockingDirty.current = true;
    if (cameraTouched) cameraDirty.current = true;
    const { authorship: _authorship, ...edited } = {
      ...current,
      sets: current.sets.map((set, position) => {
        if (position !== which) return set;
        const { group: _group, ...rest } = set;
        return next === undefined ? rest : { ...rest, group: next };
      }),
      cast: current.cast.map((figure) => follow(figure, "parent")),
      ...(cameraTouched ? { keys, ...(current.objectMotions === undefined ? {} : { objectMotions: motions }) } : {}),
    };
    setDraft(edited);
  };
  // The list's press is the viewport's selection, held once; pressing the selected line again clears it.
  const pick = (next: Exclude<StageSelection, null>) => {
    const selected: StageSelection = sameLine(selection, next) ? null : next;
    setSelection(selected);
    setMotionMark(null);
    viewport.current?.select(selected);
  };
  const setKeyAxis = (axis: 1 | 2, value: number) => {
    if (activeKey === null) return;
    const p: [number, number, number] = [...activeKey.p];
    p[axis] = round(value);
    patchKey(active, { p });
  };
  const setPose = (sheetId: string, pose: "stand" | "sit" | "lie") =>
    patchBlocking((current) => ({
      ...current,
      cast: current.cast.map((figure) => {
        if (figure.sheetId !== sheetId) return figure;
        if (pose === "stand") { const { pose: _pose, ...standing } = figure; return standing; }
        // A seated or lying figure holds where it is; the walk goes with the standing pose.
        const { to: _to, ...holding } = figure;
        return { ...holding, pose };
      }),
    }));
  const figureLegs = (sheetId: string) => motionSpeeds.filter((leg) => leg.kind === "performance" && leg.id === sheetId);
  const movementWord = (figure: ResolvedShotStaging["cast"][number]): string => {
    const legs = figureLegs(figure.sheetId);
    const tooFast = legs.some((leg) => leg.ceiling !== undefined && leg.speed > leg.ceiling);
    if (working?.performances?.some((p) => p.sheetId === figure.sheetId)) {
      const gaits = [...new Set(legs.map((leg) => leg.gait))].join(" / ");
      return `${gaits || "holds"}${tooFast ? " · too fast" : ""}`;
    }
    if (figure.to === undefined) return "holds";
    const length = Math.hypot(figure.to[0] - figure.x, figure.to[1] - figure.z);
    return `walks ${length.toFixed(1)} m${tooFast ? " · too fast" : ""}`;
  };
  const poseWord = (pose: "stand" | "sit" | "lie" | undefined): string => (pose === "sit" ? "sits" : pose === "lie" ? "lies" : "stands");
  const shotLensMm = framing.lens === undefined ? undefined : String(Number.parseFloat(framing.lens) || "");
  const filed = persisted?.playblast;
  const stale = persisted !== null && stagePlayblastIsStale(scene, persisted, { durationSec, aspect, lens: framing.lens });
  const ghostable = previous?.staging !== undefined;
  const busy = staging && persisted === null;
  return (
    <section ref={stageRoot} className="fy-swstage" data-testid="workspace-stage" aria-label="Stage" tabIndex={0} onKeyDown={timelineKey}>
      {head || fullscreen !== null ? (
        <div className="fy-swstage__head" data-stepper={head ? "true" : undefined}>
          {head ? (
            <>
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
            </>
          ) : null}
          <span className="fy-swstage__meta">{shot.title} · {durationSec.toFixed(1)}s</span>
          {working === null ? null : (
            <span className="fy-swstage__version">
              v{persisted?.version ?? 1} · {keys.length} keys · {stagingMotionWord(working,durationSec)}
            </span>
          )}
          {fullscreen === null ? null : (
            <button type="button" className="fy-swstage__exit" title="Leave full screen · Esc" aria-label="Leave full screen" onClick={fullscreen.leave}>
              <Minimize2 size={14} />
            </button>
          )}
        </div>
      ) : null}

      <div className="fy-swstage__construction">
        <input aria-label="Blockout instruction" placeholder="Describe the blockout or changes…" value={instruction} onChange={e => setInstruction(e.target.value)} disabled={constructing} maxLength={4000} />
        {persisted ? <select aria-label="Preserve Stage work" value={preserve} onChange={e => setPreserve(e.target.value as typeof preserve)} disabled={constructing}>
          <option value="blocking">Keep blocking</option><option value="camera">Keep camera</option><option value="none">Revise both</option>
        </select> : null}
        <Button size="sm" className="fy-tip--end" disabled={frozen || moved} hint="Uses the configured language model · up to 3 turns / 5 minutes" onClick={() => construct()}>Build with Arke</Button>
        {constructing ? <Button size="sm" onClick={() => { const run = construction.current; if (run) send({ kind: "stage-construct-cancel", worldId: world.meta.worldId, requestId: run.id }); }}>Stop</Button> : null}
        {note ? <span role="status">{note}</span> : null}
        {/* The disclosure ends the bar as 144a draws it, and opens once a build has something to
            say — the kept staging's record as much as a draft's; until then it is shut and says
            so by its dress, rather than absent — a person should see where a build's assessment
            will land before asking for one. */}
        <details
          className="fy-swstage__inspection"
          aria-disabled={working?.authorship ? undefined : "true"}
          onToggle={(event) => { if (!working?.authorship && event.currentTarget.open) event.currentTarget.open = false; }}
        >
          <summary onClick={(event) => { if (!working?.authorship) event.preventDefault(); }}><ChevronRight size={12} />AI inspection and assumptions</summary>
          {working?.authorship ? <><p>{working.authorship.assessment}</p><ul>{working.authorship.assumptions.map((text,i) => <li key={i}>{text}</li>)}</ul><small>{working.authorship.model} · {working.authorship.inspectedFrames} views inspected</small></> : null}
        </details>
      </div>
      <div className="fy-swstage__work">
        <div ref={setViewportElement} className="fy-swstage__viewport" data-mode={mode}>
          {working === null ? null : <div ref={host} className="fy-swstage__canvas" data-testid="stage-viewport" />}
          {working === null && !busy ? (
            <div className="fy-swstage__empty">
              <span>Nothing staged yet.</span>
              <Button variant="primary" size="sm" disabled={locked} onClick={stage}>Quick layout</Button>
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
                    <span>{motionChanged ? "Stage changed" : overrideChanged || sharedChanged ? cameraChanged ? "Stage changed" : "blocking moved" : `${keyName(active, keys.length)} moved`}</span>
                    <button type="button" aria-label="Discard" title="Discard" onClick={discard}><X size={11} /></button>
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

        <aside className="fy-swstage__panel" aria-label="Stage inspector">
          {working === null ? (
            <p className="fy-swstage__note">Stage the shot to place the cast, put down the set and start a camera move.</p>
          ) : (
            <>
              {/* The stage list (turn 144): what is on the stage, one line each with its state. A press
                  is the viewport's selection too, and pressing the selected line again clears it. */}
              <div className="fy-swstage__block">
                <Eyebrow title="Stage" />
                <button
                  type="button"
                  className="fy-swstage__item"
                  data-selected={selection?.kind === "rig" || selection?.kind === "aim" ? "true" : undefined}
                  onClick={() => pick({ kind: "rig" })}
                >
                  <span className="fy-swstage__mark" data-kind="camera" aria-hidden="true" />
                  <span>camera</span>
                  <span>{stagingMotionWord(working, durationSec)} · {keys.length} {keys.length === 1 ? "key" : "keys"}</span>
                </button>
                {working.cast.map((figure, position) => (
                  <button
                    key={figure.sheetId}
                    type="button"
                    className="fy-swstage__item"
                    data-selected={(selection?.kind === "cast" || selection?.kind === "walkend") && selection.sheetId === figure.sheetId ? "true" : undefined}
                    title={figureLegs(figure.sheetId).map((leg) => stageSpeedWarning(leg, nameOf)).filter(Boolean).join("\n") || undefined}
                    onClick={() => pick({ kind: "cast", sheetId: figure.sheetId })}
                  >
                    <span className="fy-swstage__mark" style={{ background: `#${figureColour(position).toString(16).padStart(6, "0")}` }} aria-hidden="true" />
                    <span>{nameOf(figure.sheetId)}</span>
                    <span>{movementWord(figure)} · {poseWord(figure.pose)}</span>
                  </button>
                ))}
                {working.sets.map((set, position) => (
                  <button
                    key={position}
                    type="button"
                    className="fy-swstage__item"
                    data-selected={selection?.kind === "set" && selection.index === position ? "true" : undefined}
                    onClick={() => pick({ kind: "set", index: position })}
                  >
                    <span className="fy-swstage__mark" data-kind="set" aria-hidden="true" />
                    <span>{set.name}</span>
                    <span>{set.shape ?? "box"}{set.solid ? " · solid" : ""}</span>
                  </button>
                ))}
                <button type="button" className="fy-swstage__add" disabled={frozen} onClick={addSet}><Plus size={12} />Add set</button>
              </div>

              {(selection?.kind === "rig" || selection?.kind === "aim") && activeKey !== null ? (
                <div className="fy-swstage__block">
                  <Eyebrow title="Camera" meta={keyName(active, keys.length)} />
                  <Row label="move">
                    <select className="fy-swstage__select" aria-label="Camera move" value="" disabled={frozen || !working.cast.length} onChange={event => {
                      const move = event.target.value as StageCameraMove;
                      if (!STAGE_CAMERA_MOVES.some(candidate => candidate.id === move)) return;
                      // The move is about the figure the camera aims at, now that choosing a move means the camera is selected.
                      const subjectId = activeKey.track && working.cast.some((figure) => figure.sheetId === activeKey.track) ? activeKey.track : undefined;
                      stop();
                      patchCamera(current => ({ ...current, keys: stageCameraMove(move, current, { durationSec, at, subjectId, lens: framing.lens, aspect }) }));
                      setAt(0); setKeyIndex(0); setMotionMark(null);
                    }}>
                      <option value="">Choose a move…</option>
                      {STAGE_CAMERA_MOVES.map(move => <option key={move.id} value={move.id} title={move.description}>{move.label}</option>)}
                    </select>
                  </Row>
                  <Row label="height">
                    <Stepper label="Camera height" value={activeKey.p[1]} unit="m" step={0.1} decimals={2} disabled={frozen} less="Lower" more="Raise" onCommit={(value) => setKeyAxis(1, value ?? activeKey.p[1])} />
                  </Row>
                  <Row label="back">
                    <Stepper label="Camera back" value={activeKey.p[2]} unit="m" step={0.25} decimals={2} disabled={frozen} less="Closer" more="Further" onCommit={(value) => setKeyAxis(2, value ?? activeKey.p[2])} />
                  </Row>
                  <Row label="aim">
                    <select className="fy-swstage__select" aria-label="Camera aim target" disabled={frozen} value={activeKey.track ?? ""} onChange={event => {
                      const track = event.target.value || undefined;
                      if (track === undefined) { const { track: _track, ...free } = activeKey; patchKey(active, { ...free, track: undefined }); }
                      else patchKey(active, { track, l: [0, 1.25, 0] });
                    }}>
                      <option value="">Free aim</option>
                      {[...working.cast.map(f => f.sheetId), ...new Set(working.sets.flatMap(s => s.group ? [s.group] : []))].map(id => <option key={id} value={id}>{nameOf(id)}</option>)}
                    </select>
                  </Row>
                  <Row label="anchor" top>
                    <span className="fy-swstage__chips">
                      {[null, ...working.cast.map((figure) => figure.sheetId), ...new Set(working.sets.flatMap(s => s.group ? [s.group] : []))].map((candidate) => (
                        <button
                          key={candidate ?? "world"}
                          type="button"
                          data-on={(activeKey.anchor ?? null) === candidate ? "true" : undefined}
                          disabled={frozen}
                          onClick={() => anchorTo(candidate)}
                        >
                          {candidate === null ? "world" : nameOf(candidate)}
                        </button>
                      ))}
                    </span>
                  </Row>
                  {activeKey.anchor ? (
                    <Row label="">
                      <label className="fy-swstage__check"><input type="checkbox" checked={activeKey.anchorSpace === "local"} disabled={frozen} onChange={e => {
                        const world = sampleStageCamera({ ...working, keys: [activeKey] }, activeKey.t, durationSec);
                        const key = { ...activeKey, anchorSpace: e.target.checked ? "local" as const : "world" as const };
                        patchKey(active, { ...key, p: stageKeyOffset(working, key, world.p, key.t, durationSec), l: key.track ? key.l : stageKeyOffset(working, key, world.l, key.t, durationSec) });
                      }} />Turn with target</label>
                    </Row>
                  ) : null}
                  <Row label="roll">
                    <Stepper label="Camera roll" value={activeKey.roll} unit="°" step={5} min={-180} max={180} decimals={0} placeholder="0" disabled={frozen} clearable onCommit={(value) => patchKey(active, { roll: value })} />
                  </Row>
                  <Row label="lens">
                    <Stepper label="Camera lens" value={activeKey.focalMm} unit="mm" step={5} min={8} max={400} decimals={0} placeholder={shotLensMm} disabled={frozen} clearable onCommit={(value) => patchKey(active, { focalMm: value })} />
                  </Row>
                  <Row label="ease in">
                    <Stepper label="Ease in" value={activeKey.easeIn ?? 0} step={0.05} min={0} max={0.5} disabled={frozen} onCommit={(value) => patchKey(active, { easeIn: value })} />
                  </Row>
                  <Row label="ease out">
                    <Stepper label="Ease out" value={activeKey.easeOut ?? 0} step={0.05} min={0} max={0.5} disabled={frozen} onCommit={(value) => patchKey(active, { easeOut: value })} />
                  </Row>
                </div>
              ) : null}

              {selection?.kind === "cast" || selection?.kind === "walkend" ? (() => {
                const sheetId = selection.sheetId;
                const figure = working.cast.find((candidate) => candidate.sheetId === sheetId);
                if (figure === undefined) return null;
                const name = nameOf(sheetId);
                const marks = working.performances?.find(p => p.sheetId === sheetId)?.keys ?? [];
                const timed = marks.length > 0;
                const chosen = motionMark?.kind === "performance" && motionMark.id === sheetId ? marks[motionMark.index] : undefined;
                const chosenIndex = chosen === undefined ? -1 : motionMark!.index;
                const patchChosen = (change: Partial<StagePerformanceKey>) => { if (chosen !== undefined) patchPerformanceAt(sheetId, change, chosen.t); };
                return (
                  <div className="fy-swstage__block">
                    <Eyebrow title="Figure" meta={name} />
                    <Row label="pose">
                      <select className="fy-swstage__select" aria-label={`${name} pose`} value={figure.pose ?? "stand"} disabled={frozen || timed} onChange={(event) => setPose(sheetId, event.target.value as "stand" | "sit" | "lie")}>
                        <option value="stand">Stands</option><option value="sit">Sits</option><option value="lie">Lies</option>
                      </select>
                    </Row>
                    <Row label="moves">
                      <Value>{movementWord(figure)}</Value>
                      {timed ? null : <Link disabled={frozen} onClick={() => toggleWalk(sheetId)}>{figure.to === undefined ? "Set a walk" : "Hold"}</Link>}
                    </Row>
                    <Row label="marks">
                      <Value>{marks.length}</Value>
                      <Link disabled={frozen} onClick={() => patchPerformanceAt(sheetId, {})}>Mark here</Link>
                    </Row>
                    {marks.map((key, index) => (
                      <button
                        key={index}
                        type="button"
                        className="fy-swstage__markrow"
                        data-motion-mark={index === chosenIndex ? "selected" : undefined}
                        disabled={frozen}
                        onClick={() => selectMotion({ kind: "performance", id: sheetId }, index)}
                      >
                        <span>{key.t.toFixed(2)} s</span>
                        <span>{poseWord(key.pose)} · {key.gait ?? "walk"}</span>
                      </button>
                    ))}
                    {chosen === undefined ? null : (
                      <>
                        <Row label="place">
                          <Triad disabled={frozen} cells={[
                            { prefix: "x", label: `${name} ${chosen.t}s x`, value: chosen.x, onCommit: (x) => patchChosen({ x }) },
                            { prefix: "z", label: `${name} ${chosen.t}s z`, value: chosen.z, onCommit: (z) => patchChosen({ z }) },
                            { prefix: "y", label: `${name} ${chosen.t}s y`, value: chosen.y ?? 0, onCommit: (y) => patchChosen({ y }) },
                          ]} />
                        </Row>
                        <Row label="facing">
                          <Stepper label={`${name} ${chosen.t}s facing`} value={chosen.facing ?? 0} unit="°" step={5} decimals={0} disabled={frozen} onCommit={(facing) => patchChosen({ facing })} />
                        </Row>
                        <Row label="pose">
                          <select className="fy-swstage__select" aria-label={`${name} ${chosen.t}s posture`} value={chosen.pose ?? "stand"} disabled={frozen} onChange={e => patchChosen({ pose: e.target.value as StagePerformanceKey["pose"] })}>
                            <option value="stand">Standing</option><option value="sit">Seated</option><option value="lie">Lying</option>
                          </select>
                        </Row>
                        <Row label="gait">
                          <select className="fy-swstage__select" aria-label={`${name} ${chosen.t}s gait`} value={chosen.gait ?? "walk"} disabled={frozen} onChange={e => patchChosen({ gait: e.target.value as StagePerformanceKey["gait"] })}>
                            <option value="walk">Walk</option><option value="jog">Jog</option><option value="run">Run</option>
                          </select>
                        </Row>
                        <Row label="ease in">
                          <Stepper label={`${name} ${chosen.t}s easeIn`} value={chosen.easeIn} placeholder="0" step={0.05} min={0} max={0.5} disabled={frozen} clearable onCommit={(easeIn) => patchChosen({ easeIn })} />
                        </Row>
                        <Row label="ease out">
                          <Stepper label={`${name} ${chosen.t}s easeOut`} value={chosen.easeOut} placeholder="0" step={0.05} min={0} max={0.5} disabled={frozen} clearable onCommit={(easeOut) => patchChosen({ easeOut })} />
                        </Row>
                        <Row label="hold">
                          <Stepper label={`${name} ${chosen.t}s hold`} value={chosen.hold} unit="s" placeholder="0" step={0.1} min={0} decimals={2} disabled={frozen} clearable onCommit={(hold) => patchChosen({ hold })} />
                        </Row>
                        {chosenIndex > 0 ? (
                          <Row label="">
                            <Link disabled={frozen} onClick={() => patchCamera(current => ({ ...current, performances: current.performances?.map(p => p.sheetId === sheetId ? { ...p, keys: p.keys.filter((_, i) => i !== chosenIndex) } : p) }))}>Remove mark</Link>
                          </Row>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })() : null}

              {selection?.kind === "set" ? (() => {
                const position = selection.index;
                const set = working.sets[position];
                if (set === undefined) return null;
                const group = set.group;
                const motion = group === undefined ? undefined : working.objectMotions?.find(m => m.group === group);
                const marks = motion?.keys ?? [];
                const chosen = group !== undefined && motionMark?.kind === "object" && motionMark.id === group ? marks[motionMark.index] : undefined;
                const chosenIndex = chosen === undefined ? -1 : motionMark!.index;
                const patchChosenTuple = (field: "p" | "rotation", axis: 0 | 1 | 2, value: number) => {
                  if (chosen === undefined || group === undefined) return;
                  const tuple: [number, number, number] = [...(chosen[field] ?? [0, 0, 0])];
                  tuple[axis] = value;
                  patchObjectAt(group, { [field]: tuple }, chosen.t);
                };
                const warnings = group === undefined ? [] : motionSpeeds.filter(leg => leg.kind === "object" && leg.id === group).flatMap(leg => { const warning = stageSpeedWarning(leg, nameOf); return warning ? [warning] : []; });
                return (
                  <div className="fy-swstage__block">
                    <Eyebrow title="Set" meta={set.name} />
                    <Row label="name">
                      <input
                        key={set.name}
                        type="text"
                        className="fy-swstage__field"
                        aria-label={`Set ${position + 1} name`}
                        defaultValue={set.name}
                        disabled={frozen}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                          else if (event.key === "Escape") { fieldEscape(event); event.currentTarget.value = set.name; event.currentTarget.blur(); }
                        }}
                        onBlur={(event) => {
                          const name = event.currentTarget.value.trim();
                          if (name.length > 0) patchSet(position, { name });
                          else event.currentTarget.value = set.name;
                        }}
                      />
                    </Row>
                    <Row label="shape">
                      <select className="fy-swstage__select" aria-label={`${set.name} shape`} value={set.shape ?? "box"} disabled={frozen} onChange={e => patchSet(position, { shape: e.target.value as StagingSet["shape"] })}>
                        <option value="box">Box</option><option value="cylinder">Cylinder</option><option value="sphere">Sphere</option>
                        {/* A mesh is its vertices and triangles, which no primitive has; the choice exists only for a set built as one. */}
                        {set.shape === "mesh" ? <option value="mesh">Mesh</option> : null}
                      </select>
                    </Row>
                    <Row label="solid">
                      <label className="fy-swstage__check"><input type="checkbox" aria-label={`${set.name} solid`} checked={set.solid ?? false} disabled={frozen} onChange={e => patchSet(position, { solid: e.target.checked })} /></label>
                    </Row>
                    <Row label="place">
                      <Triad disabled={frozen} cells={[
                        { prefix: "x", label: `Set ${position + 1} x`, value: set.x, onCommit: (x) => patchSet(position, { x }) },
                        { prefix: "y", label: `Set ${position + 1} elevation`, value: set.y ?? 0, onCommit: (y) => patchSet(position, { y }) },
                        { prefix: "z", label: `Set ${position + 1} z`, value: set.z, onCommit: (z) => patchSet(position, { z }) },
                      ]} />
                    </Row>
                    <Row label="size">
                      <Triad disabled={frozen} cells={[
                        { prefix: "w", label: `Set ${position + 1} width`, value: set.w, min: 0.1, onCommit: (w) => patchSet(position, { w }) },
                        { prefix: "h", label: `Set ${position + 1} height`, value: set.h, min: 0.1, onCommit: (h) => patchSet(position, { h }) },
                        { prefix: "d", label: `Set ${position + 1} depth`, value: set.d, min: 0.1, onCommit: (d) => patchSet(position, { d }) },
                      ]} />
                    </Row>
                    <Row label="rotation">
                      <Triad disabled={frozen} step={5} cells={(["pitch", "turn", "roll"] as const).map((word, axis) => ({
                        prefix: word,
                        label: `${set.name} ${word}`,
                        value: set.rotation?.[axis] ?? 0,
                        onCommit: (value: number) => {
                          const rotation: [number, number, number] = [...(set.rotation ?? [0, 0, 0])];
                          rotation[axis] = value;
                          patchSet(position, { rotation });
                        },
                      }))} />
                    </Row>
                    <Row label="group">
                      <input
                        key={group ?? ""}
                        type="text"
                        className="fy-swstage__field"
                        aria-label={`Set ${position + 1} group`}
                        placeholder="—"
                        defaultValue={group ?? ""}
                        disabled={frozen}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                          else if (event.key === "Escape") { fieldEscape(event); event.currentTarget.value = group ?? ""; event.currentTarget.blur(); }
                        }}
                        onBlur={(event) => {
                          const next = event.currentTarget.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
                          if (next === (group ?? "")) { event.currentTarget.value = group ?? ""; return; }
                          patchGroup(position, next === "" ? undefined : next);
                        }}
                      />
                    </Row>
                    {group === undefined ? null : (
                      <>
                        <Row label="marks">
                          <Value>{marks.length}</Value>
                          <Link disabled={frozen} onClick={() => patchObjectAt(group, {})}>Mark here</Link>
                        </Row>
                        {marks.length === 0 ? null : (
                          <Row label="ceiling">
                            <Stepper label={`${group} speed ceiling`} value={motion?.maxSpeed} unit="m/s" placeholder="—" step={1} min={0.01} decimals={2} disabled={frozen} clearable
                              onCommit={(value) => patchCamera(current => ({ ...current, objectMotions: current.objectMotions?.map(m => m.group === group ? { ...m, maxSpeed: value } : m) }))} />
                          </Row>
                        )}
                        {warnings.map(warning => <span key={warning} className="fy-swstage__quiet">{warning}</span>)}
                        {marks.map((key, index) => (
                          <button
                            key={index}
                            type="button"
                            className="fy-swstage__markrow"
                            data-motion-mark={index === chosenIndex ? "selected" : undefined}
                            disabled={frozen}
                            onClick={() => selectMotion({ kind: "object", id: group }, index)}
                          >
                            <span>{key.t.toFixed(2)} s</span>
                            <span>{(key.p ?? [0, 0, 0]).map(v => v.toFixed(1)).join(" · ")}</span>
                          </button>
                        ))}
                        {chosen === undefined ? null : (
                          <>
                            <Row label="place">
                              <Triad disabled={frozen} cells={(["x", "y", "z"] as const).map((prefix, axis) => ({ prefix, label: `${group} ${chosen.t}s p ${axis}`, value: chosen.p?.[axis] ?? 0, onCommit: (value: number) => patchChosenTuple("p", axis as 0 | 1 | 2, value) }))} />
                            </Row>
                            <Row label="rotation">
                              <Triad disabled={frozen} step={5} cells={(["pitch", "turn", "roll"] as const).map((prefix, axis) => ({ prefix, label: `${group} ${chosen.t}s rotation ${axis}`, value: chosen.rotation?.[axis] ?? 0, onCommit: (value: number) => patchChosenTuple("rotation", axis as 0 | 1 | 2, value) }))} />
                            </Row>
                            {chosenIndex > 0 ? (
                              <Row label="">
                                <Link disabled={frozen} onClick={() => patchCamera(current => ({ ...current, objectMotions: current.objectMotions?.map(m => m.group === group ? { ...m, keys: m.keys.filter((_, i) => i !== chosenIndex) } : m) }))}>Remove mark</Link>
                              </Row>
                            ) : null}
                          </>
                        )}
                      </>
                    )}
                    <Row label="">
                      <Link disabled={frozen} onClick={() => removeSet(position)}>Remove set</Link>
                    </Row>
                  </div>
                );
              })() : null}

              {selection === null ? (
                <div className="fy-swstage__block">
                  <Eyebrow title="Shot" meta={shot.title} hint="Framing is resolved from the shot · reads out on the prompt" />
                  <Row label="blocking" top>
                    <span className="fy-swstage__chips" title="Scene blocking is shared by every camera; This shot keeps a private variant">
                      {(["scene", "shot"] as const).map((candidate) => (
                        <button
                          key={candidate}
                          type="button"
                          data-on={scope === candidate ? "true" : undefined}
                          disabled={locked || frozen}
                          onClick={() => chooseScope(candidate)}
                        >
                          {candidate === "scene" ? "Scene" : "This shot"}
                        </button>
                      ))}
                    </span>
                  </Row>
                  <Row label="size"><Value>{framing.size?.toLowerCase() ?? "—"}</Value></Row>
                  <Row label="lens"><Value>{framing.lens ?? "—"}</Value></Row>
                  <Row label="movement"><Value>{framing.movement?.toLowerCase() ?? "—"}</Value></Row>
                  {/* A shot written before the structured camera keeps its one line, and it still staged from it. */}
                  {shot.camera === undefined || framing.size !== undefined || framing.movement !== undefined ? null : (
                    <Row label="camera"><Value>{shot.camera}</Value></Row>
                  )}
                  <Row label="rig">
                    <select className="fy-swstage__select" aria-label="Camera rig" value={working.rig ?? "sticks"} disabled={frozen} onChange={(event) => patchCamera((current) => ({ ...current, rig: event.target.value as ResolvedShotStaging["rig"] }))}>
                      {STAGE_RIGS.map((rig) => <option key={rig} value={rig}>{rig.replace("-", " ")}</option>)}
                    </select>
                  </Row>
                  <Row label="intensity">
                    <Stepper label="Rig intensity" value={working.rigIntensity ?? 1} step={0.25} min={0} max={2} decimals={2} disabled={frozen} less="Less rig motion" more="More rig motion"
                      onCommit={(value) => patchCamera((current) => ({ ...current, rigIntensity: value ?? 1 }))} />
                  </Row>
                  <div className="fy-swstage__slot" ref={setReferenceSlot} />
                </div>
              ) : null}

              {/* The ways on are the shot's whatever is selected (140a's foot, kept by 144): the
                  playblast's state, then Export and Render, pinned under the forms. */}
              <span className="fy-swstage__spacer" />
              <div className="fy-swstage__block fy-swstage__block--ways">
                <Row label="playblast">
                  <span className="fy-swstage__value" data-filed={filed === undefined || stale ? undefined : "true"}>
                    {filed === undefined ? "not filed" : stale ? "filed · stale" : "filed"}
                  </span>
                </Row>
                {note === null ? null : <span className="fy-swstage__quiet" role="status">{note}</span>}
                <div className="fy-swstage__ways">
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
                    disabled={generatorPending || frozen || moved || stale || filed === undefined}
                    title={moved ? "Keep the move first" : stale || filed === undefined ? "Export the current blockout first" : undefined}
                    onClick={() => onRenderShot(shot.id)}
                  >
                    {generatorPending ? "Opening…" : "Render with this"}
                  </Button>
                </div>
              </div>

              {/* Mounted whatever is selected: the reference plate lives in the viewport and its choice
                  must survive a change of form; only its rows belong to the shot's form. */}
              <StageUnderlay key={`underlay:${world.meta.worldId}:${shot.id}`} world={world} production={production} shotId={shot.id}
                viewport={viewportElement} aspect={aspect} at={at} playing={playing} visible={mode === "camera" && exporting === null && !constructing}
                disabled={frozen} onChoose={() => setMode("camera")} slot={referenceSlot} />
            </>
          )}
        </aside>
      </div>

      {working === null ? null : (
        <div className="fy-swstage__timeline">
          <div className="fy-swstage__transport">
          <button type="button" className="fy-swstage__play" aria-label={playing ? "Pause" : "Play"} disabled={frozen} onClick={toggle}>
            {playing ? <PauseSolid size={11} /> : <PlaySolid size={11} />}
          </button>
          <button type="button" className="fy-swstage__loop" aria-pressed={loop} disabled={frozen} onClick={() => { if (!frozen) setLoop(!loop); }}>Loop</button>
          <span className="fy-swstage__time">{Math.min(at, durationSec).toFixed(1)}s / {durationSec.toFixed(1)}s</span>
          </div>
          <div className="fy-swstage__track" data-key-track="1">
            <div className="fy-swstage__scrubber" role="slider" tabIndex={0}
            aria-label="Stage playhead" aria-valuemin={0} aria-valuemax={durationSec} aria-valuenow={at} aria-valuetext={`${at.toFixed(2)} seconds`} aria-disabled={frozen}
            onPointerDown={event => {
              if (event.button !== 0 || frozen) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              scrub(event);
            }}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event); }}
            onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
            />
            <span className="fy-swstage__rail" aria-hidden="true" />
            <span className="fy-swstage__head-fill" style={{ width: `${((Math.min(at, durationSec) / Math.max(0.01, durationSec)) * 100).toFixed(1)}%` }} aria-hidden="true" />
            {keys.slice(1).map((key, i) => {
              const from = keys[i]!;
              if (!holdsPosition(from, key) || key.t <= from.t) return null;
              const pinned = i + 1 === keys.length - 1;
              return (
                <span key={i} className="fy-swstage__hold" aria-label={`Hold from ${from.t.toFixed(2)} to ${key.t.toFixed(2)} seconds`}
                  style={{ left: `${from.t / durationSec * 100}%`, width: `${(key.t - from.t) / durationSec * 100}%` }}>
                  <span aria-hidden="true">Hold</span>
                  <button type="button" className="fy-swstage__hold-end" aria-label={`Retime hold ending at ${key.t.toFixed(2)} seconds`}
                    title={pinned ? "Hold to shot end" : "Drag hold end"} disabled={frozen || pinned}
                    onPointerDown={event => retime(i + 1, event)} onPointerMove={moveKey} onPointerUp={endKeyDrag} onPointerCancel={endKeyDrag}
                    onLostPointerCapture={() => { keyDrag.current = null; }} onClick={() => seek(i + 1)} />
                </span>
              );
            })}
            <span className="fy-swstage__lane-head" style={{ left: `${at / durationSec * 100}%` }} aria-hidden="true" />
            {keys.map((key, position) => {
              const first = position === 0;
              const last = position === keys.length - 1;
              const left = `${Math.max(0, Math.min(100, (key.t / Math.max(0.01, durationSec)) * 100)).toFixed(2)}%`;
              return (
                <button type="button" disabled={frozen}
                  key={position}
                  className="fy-swstage__key"
                  data-on={position === active ? "true" : undefined}
                  data-mid={!first && !last ? "true" : undefined}
                  style={{ left, transform: "translateX(-50%)" }}
                  title={`${keyName(position, keys.length)} · ${key.t.toFixed(1)}s${first || last ? "" : " · drag to retime"}`}
                  aria-label={`Camera ${keyName(position, keys.length)} at ${key.t.toFixed(2)} seconds`}
                  onPointerDown={event => retime(position, event)}
                  onPointerMove={moveKey} onPointerUp={endKeyDrag} onPointerCancel={endKeyDrag}
                  onLostPointerCapture={() => { keyDrag.current = null; }}
                  onClick={() => seek(position)}
                >
                  <span aria-hidden="true" />
                  {position === active ? <b style={first ? { left: 0, transform: "none" } : last ? { left: "auto", right: 0, transform: "none" } : undefined}>{keyName(position, keys.length)} · {key.t.toFixed(1)}s</b> : null}
                </button>
              );
            })}
          </div>
          <span className="fy-swstage__keytools">
            <button type="button" aria-label="Add a camera key at the playhead" title="Add a camera key at the playhead" disabled={frozen} onClick={addKey}><Plus size={12} /></button>
            {keys.length > 2 ? (
              <button type="button" aria-label="Remove the selected key" title="Remove the selected key" disabled={frozen || active === 0 || active === keys.length - 1} onClick={dropKey}><Minus size={12} /></button>
            ) : null}
            <span className="fy-swstage__count">{keys.length} keys</span>
          </span>
          {[
            ...(working.performances ?? []).map(track => ({ kind: "performance" as const, id: track.sheetId, name: nameOf(track.sheetId), keys: track.keys, colour: figureColour(Math.max(0, working.cast.findIndex(figure => figure.sheetId === track.sheetId))) })),
            ...(working.objectMotions ?? []).map((track, i) => ({ kind: "object" as const, id: track.group, name: track.group, keys: track.keys, colour: figureColour(i) })),
          ].map(lane => (
            <Fragment key={`${lane.kind}:${lane.id}`}>
              <button type="button" className="fy-swstage__lane-label" disabled={frozen} title={lane.name} onClick={() => selectMotion(lane, 0)}>
                <i style={{ background: `#${lane.colour.toString(16).padStart(6, "0")}` }} />{lane.name}
              </button>
              <div className="fy-swstage__track fy-swstage__motion-track" data-key-track={lane.kind} aria-label={`${lane.name} ${lane.kind === "performance" ? "action" : "motion"}`} style={{ color: `#${lane.colour.toString(16).padStart(6, "0")}` }}>
                <span className="fy-swstage__rail" aria-hidden="true" />
                <span className="fy-swstage__lane-head" style={{ left: `${at / durationSec * 100}%` }} aria-hidden="true" />
                {lane.kind === "performance" ? working.performances?.find(track => track.sheetId === lane.id)?.keys.slice(0, -1).map((key, index) => {
                  const next = working.performances!.find(track => track.sheetId === lane.id)!.keys[index + 1]!;
                  const end = stagePerformanceDeparture(key, next);
                  return end > key.t ? <span key={index} className="fy-swstage__hold" aria-label={`${lane.name} hold from ${key.t.toFixed(2)} to ${end.toFixed(2)} seconds`} style={{ left: `${key.t / durationSec * 100}%`, width: `${(end - key.t) / durationSec * 100}%` }}><span>Hold</span></span> : null;
                }) : null}
                {lane.keys.map((key, i) => (
                  <button type="button" key={i} className="fy-swstage__key" data-mid="true" disabled={frozen}
                    data-on={motionMark?.kind === lane.kind && motionMark.id === lane.id && motionMark.index === i ? "true" : undefined}
                    style={{ left: `${key.t / durationSec * 100}%`, transform: "translateX(-50%)" }}
                    aria-label={`${lane.name} mark ${i + 1} at ${key.t.toFixed(2)} seconds`} title={`${key.t.toFixed(2)}s · drag to retime`}
                    onPointerDown={event => retime(i, event, lane)} onPointerMove={moveKey} onPointerUp={endKeyDrag} onPointerCancel={endKeyDrag}
                    onLostPointerCapture={() => { keyDrag.current = null; }} onClick={() => selectMotion(lane, i)}>
                    <span aria-hidden="true" />
                  </button>
                ))}
              </div>
              <span className="fy-swstage__count">{lane.keys.length} marks</span>
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}
