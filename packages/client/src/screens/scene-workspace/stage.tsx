import { StageInspectorSheet } from "./responsive-chrome.js";
import { useMediaQuery } from "../../lib/media-query.js";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link as RouterLink } from "react-router";
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
  stageCameraRest,
  stageCameraStandoffWarnings,
  stageCameraMotionWarnings,
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
  type StageReview,
  type SceneRecord,
  type ResolvedShotStaging,
  type Shot,
  type StagingKey,
  type StagingSet,
  type WorldBundle,
} from "@arke-studio/contracts";
import { StageUnderlay } from "./stage-underlay.js";
import { Eyebrow, Link, Row, Stepper, Triad, Value, StageEditContext, fieldEscape, sameLine } from "./stage-inspector.js";
import { PlateChip, PlateForm, platePicture, type PlateCandidate } from "./stage-plate.js";
import { STAGE_LOOKS, STAGE_LOOK_LABELS, type StageLook } from "@arke-studio/contracts";
import { AddSetMenu, KitRows, type AddSetChoice } from "./stage-kit-form.js";
import { AtmosphereRows, LightForm, MaterialRow, SurfaceRows } from "./stage-light-form.js";
import { CameraWords } from "./stage-words-form.js";
import { STAGE_POSE_LABELS, STAGE_POSES, stageFastTurns, type StagePose } from "@arke-studio/contracts";
import { stageFrameKey, type StageFrameWords } from "@arke-studio/contracts";
import { stageLightDefault, type SceneAtmosphere, type StageLight } from "@arke-studio/contracts";
import { STAGE_KIT_SIZES } from "@arke-studio/contracts";
import { stagePlateKey, type ScenePlate } from "@arke-studio/contracts";
import { stageBoardAnimatic, stageBoardAnimaticIsStale, stageBoardAt, stageBoardCuts, stageBoardJumps, stageBoardLineFindings, stageBoardStagings } from "@arke-studio/contracts";
import { selectedShotId, useWorkspaceSelection } from "./selection.js";
import { figureColour, StageViewport, type StageData, type StageSelection } from "./stage-viewport.js";
import { readStageLook, rememberStageLook } from "../../lib/stage-look-preference.js";
import { send, useStore, subscribeStageConstruction, beginStageExport, cancelStageExport, failStagePlayblastAction, stagePlayblast, writeStageExportFrame } from "../../lib/store.js";
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

function withoutWords(key: StagingKey): StagingKey {
  const { frame: _frame, ...rest } = key;
  return rest;
}

/** Insert-or-update at the playhead: the Blender workflow, move the playhead then the camera. */
function withKeyAt(staging: ResolvedShotStaging, at: number, patch: Partial<StagingKey>, fov=34, aspect=16/9): { staging: ResolvedShotStaging; index: number } {
  const keys = staging.keys;
  const near = keys.findIndex((key) => Math.abs(key.t - at) < 0.12);
  if (near >= 0) {
    // Moving a worded key by hand makes it numbers again: the words no longer say where it is (issue 1820).
    const moves = "p" in patch || "l" in patch;
    return { staging: { ...staging, keys: keys.map((key, index) => (index === near ? { ...(moves ? withoutWords(key) : key), ...patch } : key)) }, index: near };
  }
  // Only the edited channel changes; the rest of the pose is what was playing at the playhead.
  const made: StagingKey = { ...stageCameraKeyAt(staging, at, staging.keys.at(-1)?.t ?? DEFAULT_SHOT_SEC, fov, aspect), ...patch, t: round(at) };
  const next = sortedKeys([...keys, made]);
  return { staging: { ...staging, keys: next }, index: next.indexOf(made) };
}

/** A lane's words (design turn 228d): the pose at each mark where it changes, and a walk where one starts. */
function lanePoses(keys: readonly StagePerformanceKey[]): Array<{ t: number; word: string }> {
  const words: Array<{ t: number; word: string }> = [];
  let pose: string | null = null;
  keys.forEach((key, index) => {
    const next = keys[index + 1];
    const walks = next !== undefined && Math.hypot(next.x - key.x, next.z - key.z) > 0.3;
    const word = walks ? (key.gait ?? "walk") : STAGE_POSE_LABELS[key.pose ?? "stand"].toLowerCase();
    if (word !== pose) words.push({ t: key.t, word });
    pose = word;
  });
  return words;
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
  review,
  frozenScene = false,
  fullscreen = null,
  head = true,
  board = null,
  onRenderBoard,
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
  onCommand: (command: Command, stageReviewId?: string) => boolean;
  onRenderShot?: (shotId: string) => void;
  constructionRequest?: { actionId: string; conversationId: string; shotId: string; instruction: string; preserve: "blocking" | "camera" | "none" };
  playblastRequest?: { actionId: string; conversationId: string; shotId: string };
  review?: StageReview;
  /** Approval previews retain their frozen scene rather than hydrating an unrelated live draft. */
  frozenScene?: boolean;
  /** In full screen the way out sits on this head row (turn 144); null means the page is not in it. */
  fullscreen?: { leave: () => void } | null;
  /**
   * The head row — the shot stepper and the staging words. On the shot page (turn 145) the
   * filmstrip steps and the view row carries the words, so the row goes; in full screen it comes
   * back for the way out alone, which 144 put on this row.
   */
  head?: boolean;
  /** The board this shot cuts into (issue 1824, design turn 228g); null when it stands alone. */
  board?: { letter: string; memberShotIds: string[]; capSec: number } | null;
  onRenderBoard?: (memberShotIds: string[]) => void;
}) {
  const shots = orderedShots(scene);
  const { subject, select } = useWorkspaceSelection();
  const selected = selectedShotId(subject);
  const index = Math.max(0, shots.findIndex((candidate) => candidate.id === selected));
  const shot: Shot | null = shots[index] ?? null;
  const { state } = useStore();
  const retained = frozenScene ? undefined : review ?? state?.stageReviews?.filter(value => value.worldId === world.meta.worldId &&
    value.productionId === production.meta.id && value.sceneId === scene.id && value.shotId === shot?.id).at(-1);
  const retainedReviewId = useRef<string | null>(null);
  const hydratedReviewId = useRef<string | null>(null);
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
  // The plate is the scene's, not a thing in the viewport, so selecting it is the panel's own state.
  const [plateSelected, setPlateSelected] = useState(false);
  // A light is the scene's too, selected in the panel (issue 1825).
  const [lightSelected, setLightSelected] = useState<number | null>(null);
  // The camera form shows the words first; the numbers sit behind Edit as numbers (issue 1820).
  const [numbers, setNumbers] = useState(false);
  // Greybox · Lit · Plate (issue 1825): how a person likes to see the Stage, remembered on this
  // device and never written to the world; the playblast records the look it was exported in.
  const [look, setLookState] = useState<StageLook>(readStageLook);
  const setLook = (next: StageLook) => {
    setLookState(next);
    rememberStageLook(next);
  };
  // Where a build estimated the plate's camera; Keep saves it on the plate (issue 1818).
  const [draftPlateCamera, setDraftPlateCamera] = useState<ScenePlate["camera"] | null>(null);
  // A build's lights and atmosphere (issue 1825), kept with the blocking.
  const [draftLook, setDraftLook] = useState<{ lights?: StageLight[]; atmosphere?: SceneAtmosphere } | null>(null);
  const [motionMark, setMotionMark] = useState<MotionMark | null>(null);
  // Where the shot's form puts the reference rows; null while another form is up (turn 144).
  const [referenceSlot, setReferenceSlot] = useState<HTMLElement | null>(null);
  const stageRoot = useRef<HTMLElement | null>(null);
  const phone = useMediaQuery("(max-width: 599px)");
  const touch = useMediaQuery("(hover: none)");
  const compact = useMediaQuery("(max-width: 1099px)");
  const [stageWidth, setStageWidth] = useState(Number.POSITIVE_INFINITY);
  const [touchMode, setTouchMode] = useState<"camera" | "figures" | "set">("figures");
  const inspectorSheet = phone || ((touch || compact) && stageWidth < 756);
  useEffect(() => {
    const element = stageRoot.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setStageWidth(element.getBoundingClientRect().width);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
  const inspection = useRef<HTMLDetailsElement | null>(null);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const viewport = useRef<StageViewport | null>(null);
  const playStart = useRef<{ wall: number; from: number } | null>(null);
  const handledPlayblastActions = useRef(new Set<string>());
  const frozen = locked || exporting !== null || constructing;
  // A board (issue 1824, design turn 228g): the shots the scene's packing cuts this one into, on
  // one clock, each with its own camera. The view is for watching, checking and recording the
  // board; editing stays on This shot, where each shot's own staging is.
  const [boardView, setBoardView] = useState(false);
  const [boardAction, setBoardAction] = useState<"shared" | "shot">("shared");
  const boardCuts = useMemo(() => (board === null ? [] : stageBoardCuts(scene, board.memberShotIds)), [scene, board]);
  const boardStaged = board !== null && boardCuts.length >= 2 && stageBoardStagings(scene, board.memberShotIds) !== null;
  const boardOn = boardView && boardStaged;
  const boardTotal = boardCuts.at(-1)?.to ?? 0;
  const clock = boardOn ? boardTotal : durationSec;
  const boardHere = boardOn ? stageBoardAt(boardCuts, at) : null;
  useEffect(() => { if (boardView && !boardStaged) setBoardView(false); }, [boardView, boardStaged]);

  // The end key is the end pose, so it always sits at the shot's length: a staging kept before
  // the shot was retimed plays to its end pose here and is repaired by the next Keep.
  const working = useMemo(() => {
    const base = draft ?? resolvedPersisted;
    return base === null ? null : stagingRetimed(base, durationSec);
  }, [draft, resolvedPersisted, durationSec]) as ResolvedShotStaging | null;
  // A hand edit strips the build's provenance (the draft is no longer what the model said), and a
  // native <details> keeps its own open state regardless — so the disclosure is shut here, not
  // left expanded over an empty body while its dress says it cannot open.
  const inspected = working?.authorship !== undefined;
  useEffect(() => { if (!inspected) inspection.current?.removeAttribute("open"); }, [inspected]);
  const cameraWarnings = useMemo(() => working ? [...stageCameraStandoffWarnings(working, durationSec), ...stageCameraMotionWarnings(working, durationSec)] : [], [working, durationSec]);
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
  const latest = useRef({ working, active, frozen, at, framing, aspect, board: boardOn });
  latest.current = { working, active, frozen, at, framing, aspect, board: boardOn };

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
      if (next >= clock && !loop) {
        setAt(clock);
        setPlaying(false);
        playStart.current = null;
        return;
      }
      const time = loop ? next % clock : next;
      if (next >= clock) playStart.current = { wall, from: time };
      setAt(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, clock, loop, frozen]);

  const stop = () => {
    setPlaying(false);
    playStart.current = null;
  };
  const patchCamera = (change: (current: ResolvedShotStaging) => ResolvedShotStaging) => {
    const { working: current, frozen: editingFrozen, board: watching } = latest.current;
    if (current === null || editingFrozen || watching) return;
    cameraDirty.current = true;
    const {authorship: _authorship, ...edited} = change(current);
    setDraft(edited);
  };
  const patchBlocking = (change: (current: ResolvedShotStaging) => ResolvedShotStaging) => {
    const { working: current, frozen: editingFrozen, board: watching } = latest.current;
    if (current === null || editingFrozen || watching) return;
    blockingDirty.current = true;
    const {authorship: _authorship, ...edited} = change(current);
    setDraft(edited);
  };
  const patchKey = (which: number, change: Partial<StagingKey>) => {
    const moves = !("frame" in change) && ["p", "l", "anchor", "track", "anchorSpace"].some((field) => field in change);
    patchCamera((current) => ({ ...current, keys: current.keys.map((key, position) => (position === which ? { ...(moves ? withoutWords(key) : key), ...change } : key)) }));
  };

  const plateView = useMemo(() => {
    const plate = scene.blocking?.plate;
    if (plate === undefined || plate.camera === undefined) return null;
    const url = platePicture(plate, world);
    return url === null ? null : { url, camera: plate.camera };
  }, [scene.blocking?.plate, world]);
  const shotData: StageData | null = useMemo(() => {
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
      look,
      lights: scene.blocking?.lights ?? [],
      ...(scene.blocking?.atmosphere === undefined ? {} : { atmosphere: scene.blocking.atmosphere }),
      plate: plateView,
    };
  }, [working, shot, ghost, previous, durationSec, active, mode, at, framing.lens, aspect, sheets, look, scene.blocking?.lights, scene.blocking?.atmosphere, plateView]);
  // Each member's staging and where its camera opens, for the board's view and its animatic.
  const boardMembers = useMemo(() => {
    if (!boardStaged) return [];
    const ordered = orderedShots(scene);
    return boardCuts.map((cut) => {
      const member = ordered.find((candidate) => candidate.id === cut.shotId)!;
      const length = cut.to - cut.from;
      const resolved = stagingRetimed(resolvedShotStaging(scene, member.staging!), length) as ResolvedShotStaging;
      const opening = sampleStageCamera(resolved, 0, length);
      return { cut, resolved, length, lens: effectiveFraming(scene, member).lens, p: opening.p as [number, number, number], l: opening.l as [number, number, number] };
    });
  }, [boardStaged, boardCuts, scene]);
  const memberData = (index: number, local: number, overview: boolean): StageData | null => {
    const member = boardMembers[index];
    if (member === undefined) return null;
    const { resolved } = member;
    return {
      cast: resolved.cast.map((figure, position) => ({
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
        ghost: null,
      })),
      ...(resolved.performances ? { performances: resolved.performances } : {}),
      ...(resolved.objectMotions ? { objectMotions: resolved.objectMotions } : {}),
      sets: resolved.sets,
      keys: resolved.keys,
      durationSec: member.length,
      active: 0,
      mode,
      at: local,
      fov: stagingFov(member.lens, aspect),
      aspect: aspectNumber(aspect),
      lensLabel: member.lens ?? "lens unset",
      rig: resolved.rig,
      seed: resolved.seed,
      rigIntensity: resolved.rigIntensity,
      look,
      lights: scene.blocking?.lights ?? [],
      ...(scene.blocking?.atmosphere === undefined ? {} : { atmosphere: scene.blocking.atmosphere }),
      plate: plateView,
      board: overview
        ? {
            number: member.cut.number,
            rigs: boardMembers.filter((_, position) => position !== index).map((other) => ({ number: other.cut.number, p: other.p, l: other.l })),
            caption: `${member.cut.number} · ${(member.cut.from + local).toFixed(1)}s`,
          }
        : null,
    };
  };
  const boardIndex = boardHere?.index ?? -1;
  const boardLocal = boardHere?.local ?? 0;
  const boardData = useMemo(
    () => (boardOn && boardIndex >= 0 ? memberData(boardIndex, boardLocal, true) : null),
    [boardOn, boardIndex, boardLocal, boardMembers, mode, aspect, look, sheets, scene.blocking?.lights, scene.blocking?.atmosphere, plateView],
  );
  const data = boardOn ? boardData : shotData;

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
        // The recording is drawn in the look on screen, and the pin says which (issue 1825).
        look,
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

  const exportAnimatic = async () => {
    const view = viewport.current;
    if (view === null || board === null || sceneFile === undefined || exporting !== null) return;
    const stagings = stageBoardStagings(scene, board.memberShotIds);
    if (stagings === null) return;
    const parts = boardMembers.map((_, index) => memberData(index, 0, false)).filter((part): part is StageData => part !== null);
    stop();
    setNote(null);
    setExporting(0);
    try {
      const { jobId, openingFrame } = await view.recordBoard(parts, {
        start: beginStageExport,
        write: writeStageExportFrame,
        cancel: cancelStageExport,
      }, setExporting);
      if (viewport.current !== view) {
        await cancelStageExport(jobId);
        setNote("export stopped - the shot changed");
        return;
      }
      if (openingFrame.size === 0) {
        await cancelStageExport(jobId);
        setNote("the Stage export came back empty - export it again");
        return;
      }
      const outcome = await stagePlayblast({
        kind: "stage-animatic",
        worldId: world.meta.worldId,
        productionId: production.meta.id,
        sceneFile,
        sceneId: scene.id,
        baseVersion: scene.version,
        members: [...board.memberShotIds],
        stagings,
        durationSec: boardTotal,
        aspect,
        look,
      }, jobId, new Uint8Array(await openingFrame.arrayBuffer()), []);
      if (!outcome.ok) setNote(outcome.reason);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "the animatic could not be recorded");
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
      setDraftPlateCamera(result.draft.plateCamera ?? null);
      setDraftLook(result.draft.lights || result.draft.atmosphere ? { ...(result.draft.lights ? { lights: result.draft.lights } : {}), ...(result.draft.atmosphere ? { atmosphere: result.draft.atmosphere } : {}) } : null);
    }
    if (result.status === "inspect") setInspectionRound(result.round);
    if (result.status === "ready" && constructionRequest) retainedReviewId.current = pending.id;
    if (result.status === "ready" || result.status === "failed") { setConstructing(false); setInspectionRound(null); }
  }), [world.meta.worldId, shot?.id, scene.id, scene.version, persisted?.version]);
  useEffect(() => {
    if (retained && retained.id !== hydratedReviewId.current) {
      if (draft !== null && moved && construction.current?.id !== retained.id && retainedReviewId.current !== retained.id) {
        setNote("Keep or discard your current Stage edits before reviewing the constructed draft.");
        return;
      }
      hydratedReviewId.current = retained.id; retainedReviewId.current = retained.id;
      aiDraftVersion.current = retained.baseVersion;
      cameraDirty.current = true; blockingDirty.current = true; scopeDirty.current = true;
      setScope("shot");
      setDraft({ ...retained.draft.staging, version: persisted?.version ?? 1, cast: retained.draft.cast, sets: retained.draft.sets });
      setDraftPlateCamera(retained.draft.plateCamera ?? null);
      setDraftLook(retained.draft.lights || retained.draft.atmosphere ? { ...(retained.draft.lights ? { lights: retained.draft.lights } : {}), ...(retained.draft.atmosphere ? { atmosphere: retained.draft.atmosphere } : {}) } : null);
      setNote(retained.draft.assessment);
    } else if (!retained && state?.stageReviews !== undefined && hydratedReviewId.current && retainedReviewId.current && !constructing) {
      retainedReviewId.current = null; hydratedReviewId.current = null; aiDraftVersion.current = null;
      cameraDirty.current = false; blockingDirty.current = false; scopeDirty.current = false;
      setDraft(null);
    }
  }, [retained, state?.stageReviews, constructing, persisted?.version, draft, moved]);
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
    if (frozen || draft === null || working === null) return;
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
    const plate = scene.blocking?.plate;
    if (draftPlateCamera !== null && plate !== undefined) {
      // A build that read the plate says where its camera stood; that lands with the Keep, on the
      // scene's own marks unless this Keep moves those too, so a shot override never leaks into them.
      const marks = command.blocking ?? { cast: scene.blocking!.cast, sets: scene.blocking!.sets };
      command.blocking = { ...marks, plate: { ...plate, camera: draftPlateCamera } };
    }
    if (draftLook !== null && (scene.blocking !== undefined || command.blocking !== undefined)) {
      const marks = command.blocking ?? { cast: scene.blocking!.cast, sets: scene.blocking!.sets };
      command.blocking = { ...marks, ...draftLook };
    }
    if (onCommand(command, retainedReviewId.current ?? undefined)) { aiDraftVersion.current = null; setDraftPlateCamera(null); setDraftLook(null); }
  };
  const discard = () => {
    if (retainedReviewId.current && !send({ kind: "stage-review-discard", worldId: world.meta.worldId, reviewId: retainedReviewId.current })) {
      setNote("The studio is disconnected. The draft is still waiting for review."); return;
    }
    retainedReviewId.current = null;
    aiDraftVersion.current = null;
    setDraftPlateCamera(null);
    setDraftLook(null);
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
  // Into the board at this shot's cut; out at the shot the playhead is on.
  const chooseBoard = (on: boolean) => {
    if (on === boardOn || moved || frozen) return;
    stop();
    if (on) {
      setBoardView(true);
      setAt(boardCuts.find((cut) => cut.shotId === shot?.id)?.from ?? 0);
      setSelection(null);
      setMotionMark(null);
      viewport.current?.select(null);
      return;
    }
    const here = stageBoardAt(boardCuts, at);
    setBoardView(false);
    if (here !== null && here.cut.shotId !== shot?.id) select({ kind: "shot", shotId: here.cut.shotId });
    else setAt(here?.local ?? 0);
  };
  const toggle = () => {
    if (frozen) return;
    if (playing) {
      stop();
      return;
    }
    const from = at >= clock ? 0 : at;
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
    setAt(Math.max(0, Math.min(clock, time)));
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
    else if (event.key === "End") seekTime(clock);
    else if (/^[1-9]$/.test(event.key) && boardOn) { const cut = boardCuts[Number(event.key) - 1]; if (cut === undefined) return; seekTime(cut.from); }
    else if (/^[1-9]$/.test(event.key) && keys[Number(event.key) - 1]) seek(Number(event.key) - 1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const scrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (latest.current.frozen) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    seekTime((event.clientX - bounds.left) / Math.max(1, bounds.width) * clock);
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
  const addSet = (choice: AddSetChoice = "box") => {
    if (working === null) return;
    const index = working.sets.length;
    patchBlocking((current) => {
      const figure = current.cast[0];
      // A kit item (issue 1819) starts at its kit's own size and is named for what it is; a
      // primitive is the one-metre block it always was.
      const kit = choice === "box" || choice === "cylinder" || choice === "sphere" ? null : choice;
      const [w, h, d] = kit === null ? [1, 0.75, 1] : STAGE_KIT_SIZES[kit];
      const taken = new Set(current.sets.map((set) => set.name));
      const stem = kit === null ? "set" : kit;
      let name = kit === null ? `set ${current.sets.length + 1}` : stem;
      for (let n = 2; taken.has(name); n++) name = `${stem} ${n}`;
      return {
        ...current,
        sets: [...current.sets, {
          name,
          x: kit === "room" || kit === "street" ? 0 : figure?.x ?? 0,
          z: kit === "room" || kit === "street" ? 0 : round((figure?.z ?? 0) + 1),
          w,
          h,
          d,
          ...(kit === null ? (choice === "box" ? {} : { shape: choice as "cylinder" | "sphere" }) : { kit: kit === "room" ? { kind: kit, open: ["front" as const] } : { kind: kit }, solid: true }),
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
  /**
   * The plate (issue 1818), the lights and the atmosphere (issue 1825) are written with the scene's
   * own marks, so the write moves nothing else.
   */
  const writeScene = (change: { plate?: ScenePlate | null; lights?: StageLight[] | null; atmosphere?: SceneAtmosphere | null }) => {
    if (shot === null || working === null) return;
    const marks = scene.blocking ?? { cast: working.cast, sets: working.sets };
    onCommand({ kind: "edit-stage", shotId: shot.id, blocking: { cast: marks.cast, sets: marks.sets, ...change } });
  };
  const writePlate = (next: ScenePlate | null) => writeScene({ plate: next });
  const sceneLights = scene.blocking?.lights ?? [];
  const writeLight = (index: number, next: StageLight | null) => {
    const lights = next === null ? sceneLights.filter((_, at) => at !== index) : sceneLights.map((light, at) => (at === index ? next : light));
    writeScene({ lights: lights.length === 0 ? null : lights });
  };
  const addLight = () => {
    if (working === null) return;
    const taken = new Set(sceneLights.map((light) => light.name));
    let name = "light";
    for (let n = 2; taken.has(name); n++) name = `light ${n}`;
    const figure = working.cast[0];
    writeScene({ lights: [...sceneLights, stageLightDefault(name, { x: figure?.x ?? 0, z: figure?.z ?? 0 })] });
    setSelection(null); viewport.current?.select(null); setPlateSelected(false);
    setLightSelected(sceneLights.length);
  };
  const pickPlate = (candidate: PlateCandidate) => {
    if (shot === null) return;
    const plate = scene.blocking?.plate;
    // Another picture is another view: the old camera estimate does not carry over to it.
    writePlate({
      source: { source: "artifact", artifactId: candidate.id, hash: candidate.hash },
      label: plate?.label ?? candidate.location ?? "Location",
      shotId: plate?.shotId ?? shot.id,
      ...(plate?.rides === false ? { rides: false } : {}),
    });
  };
  const matchPlate = () => {
    const plate = scene.blocking?.plate;
    if (plate === undefined) return;
    patchCamera((current) => {
      const opening = stagePlateKey(plate, current.keys[0]);
      return opening === null ? current : { ...current, keys: [opening, ...current.keys.slice(1)] };
    });
  };
  const pick = (next: Exclude<StageSelection, null>) => {
    if (boardOn) return;
    setPlateSelected(false);
    setLightSelected(null);
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
  // The three postures keep their verbs; the named poses (issue 1821) are said by their label.
  const poseWord = (pose: StagePose | undefined): string => (pose === "sit" ? "sits" : pose === "lie" ? "lies" : pose === undefined || pose === "stand" ? "stands" : STAGE_POSE_LABELS[pose].toLowerCase());
  const shotLensMm = framing.lens === undefined ? undefined : String(Number.parseFloat(framing.lens) || "");
  const filed = persisted?.playblast;
  const stale = persisted !== null && stagePlayblastIsStale(scene, persisted, { durationSec, aspect, lens: framing.lens });
  const ghostable = previous?.staging !== undefined;
  const busy = staging && persisted === null;
  const boardPin = board === null ? null : stageBoardAnimatic(scene, board.memberShotIds);
  const boardStale = boardPin !== null && stageBoardAnimaticIsStale(scene, boardPin, aspect);
  const boardLines = boardOn && board !== null ? stageBoardLineFindings(scene, board.memberShotIds, aspect) : [];
  const boardJumps = boardOn && board !== null && boardAction === "shared" ? stageBoardJumps(scene, board.memberShotIds) : [];
  const boardScope = board === null ? null : (
    <span className="fy-swstage__scope" role="radiogroup" aria-label="Stage scope" data-testid="stage-scope">
      <button type="button" role="radio" aria-checked={!boardOn} data-on={!boardOn ? "true" : undefined} onClick={() => chooseBoard(false)}>This shot</button>
      <button type="button" role="radio" aria-checked={boardOn} data-on={boardOn ? "true" : undefined}
        disabled={!boardStaged || moved || frozen}
        title={!boardStaged ? "Stage every shot of the board first" : moved ? "Keep the move first" : undefined}
        onClick={() => chooseBoard(true)}>Board {board.letter}</button>
    </span>
  );
  return (
    <StageEditContext.Provider value={() => {
      const original = draft, cameraWasDirty = cameraDirty.current, blockingWasDirty = blockingDirty.current;
      return () => { cameraDirty.current = cameraWasDirty; blockingDirty.current = blockingWasDirty; setDraft(original); };
    }}>
    <section ref={stageRoot} className="fy-swstage" data-inspector-sheet={inspectorSheet || undefined} data-testid="workspace-stage" aria-label="Stage" tabIndex={0} onKeyDown={timelineKey}>
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
              <strong>{boardOn ? `Board ${board!.letter}` : `Shot ${shot.number}`}</strong>
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
          <span className="fy-swstage__meta">{boardOn ? `${boardCuts.length} shots · ${boardTotal.toFixed(1)}s` : `${shot.title} · ${durationSec.toFixed(1)}s`}</span>
          {boardScope}
          {working === null ? null : (
            <span className="fy-swstage__version">
              {boardOn
                ? `v${scene.version} · ${boardLines.length === 0 ? "180° clear" : `${boardLines.length} line ${boardLines.length === 1 ? "crossing" : "crossings"}`}`
                : `v${persisted?.version ?? 1} · ${keys.length} keys · ${stagingMotionWord(working,durationSec)}`}
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
        {head || fullscreen !== null ? null : boardScope}
        {cameraWarnings.map(warning => <p key={warning} className="fy-swstage__quiet">{warning}</p>)}
        {working === null || shot === null ? null : <PlateChip plate={scene.blocking?.plate} world={world} disabled={frozen || locked || moved} onPick={pickPlate} />}
        <input aria-label="Blockout instruction" placeholder="Describe the blockout or changes…" value={instruction} onChange={e => setInstruction(e.target.value)} disabled={constructing} maxLength={4000} />
        {persisted ? <select aria-label="Preserve Stage work" value={preserve} onChange={e => setPreserve(e.target.value as typeof preserve)} disabled={constructing}>
          <option value="blocking">Keep blocking</option><option value="camera">Keep camera</option><option value="none">Revise both</option>
        </select> : null}
        <Button size="sm" className="fy-tip--end" disabled={frozen || moved} hint="Uses the configured language model · up to 3 turns / 5 minutes" onClick={() => construct()}>Build with Arke</Button>
        <RouterLink className="fy-swstage__link" to="/settings/harness?agent=stage-designer">Stage model</RouterLink>
        {constructing ? <Button size="sm" onClick={() => { const run = construction.current; if (run) send({ kind: "stage-construct-cancel", worldId: world.meta.worldId, requestId: run.id }); }}>Stop</Button> : null}
        {note ? <span role="status">{note}</span> : null}
        {/* The disclosure ends the bar as 144a draws it, and opens once a build has something to
            say — the kept staging's record as much as a draft's; until then it is shut and says
            so by its dress, rather than absent — a person should see where a build's assessment
            will land before asking for one. */}
        <details
          ref={inspection}
          className="fy-swstage__inspection"
          aria-disabled={working?.authorship ? undefined : "true"}
          onToggle={(event) => { if (!working?.authorship && event.currentTarget.open) event.currentTarget.open = false; }}
        >
          <summary tabIndex={working?.authorship ? undefined : -1} onClick={(event) => { if (!working?.authorship) event.preventDefault(); }}><ChevronRight size={12} />AI inspection and assumptions</summary>
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
                {!touch && (["look", "camera"] as const).map((candidate) => (
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
                {touch && (["camera", "figures", "set"] as const).map(candidate => <button key={candidate} type="button" role="radio" aria-checked={touchMode === candidate} data-on={touchMode === candidate || undefined} onClick={() => {
                  setTouchMode(candidate); setMode(candidate === "camera" ? "camera" : "look");
                  if (candidate === "camera") pick({ kind: "rig" });
                  else if (candidate === "figures") { const first = working.cast[0]; if (first) pick({ kind: "cast", sheetId: first.sheetId }); }
                  else if (working.sets.length > 0) pick({ kind: "set", index: 0 });
                }}>{candidate === "camera" ? "Camera" : candidate === "figures" ? "Figures" : "Set"}</button>)}
              </div>
              <div className="fy-swstage__corner">
                {moved ? (
                  <span className="fy-swstage__moved" data-testid="stage-moved">
                    <span>{motionChanged ? "Stage changed" : overrideChanged || sharedChanged ? cameraChanged ? "Stage changed" : "blocking moved" : `${keyName(active, keys.length)} moved`}</span>
                    <button type="button" aria-label="Discard" title="Discard" onClick={discard}><X size={11} /></button>
                    <button type="button" className="fy-swstage__keep" disabled={locked || frozen} onClick={keep}>Keep</button>
                  </span>
                ) : null}
                <div className="fy-swstage__looks" role="radiogroup" aria-label="Look" data-testid="stage-look">
                  {STAGE_LOOKS.map((candidate) => (
                    <button key={candidate} type="button" role="radio" aria-checked={look === candidate} data-on={look === candidate ? "true" : undefined}
                      disabled={candidate === "plate" && plateView === null}
                      title={candidate === "plate" && plateView === null ? (scene.blocking?.plate === undefined ? "Add a plate first" : "Match the plate's camera first") : undefined}
                      onClick={() => setLook(candidate)}>{STAGE_LOOK_LABELS[candidate]}</button>
                  ))}
                </div>
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

        <StageInspectorSheet sheet={inspectorSheet}><aside className="fy-swstage__panel" aria-label="Stage inspector">
          {working === null ? (
            <p className="fy-swstage__note">Nothing staged yet.</p>
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
                  disabled={boardOn}
                  onClick={() => pick({ kind: "rig" })}
                >
                  <span className="fy-swstage__mark" data-kind="camera" aria-hidden="true" />
                  <span>camera</span>
                  <span>{boardOn ? `${boardCuts.length} cameras` : `${stagingMotionWord(working, durationSec)} · ${keys.length} ${keys.length === 1 ? "key" : "keys"}`}</span>
                </button>
                {scene.blocking?.plate === undefined ? null : (
                  <button
                    type="button"
                    className="fy-swstage__item"
                    data-selected={plateSelected ? "true" : undefined}
                    data-testid="stage-plate-line"
                    disabled={boardOn}
                    onClick={() => { setSelection(null); viewport.current?.select(null); setLightSelected(null); setPlateSelected((on) => !on); }}
                  >
                    <span className="fy-swstage__mark" data-kind="plate" aria-hidden="true" />
                    <span>plate</span>
                    <span>{scene.blocking.plate.label} · {scene.blocking.plate.camera === undefined ? "not matched" : "matched"}</span>
                  </button>
                )}
                {working.cast.map((figure, position) => (
                  <button
                    key={figure.sheetId}
                    type="button"
                    className="fy-swstage__item"
                    data-selected={(selection?.kind === "cast" || selection?.kind === "walkend") && selection.sheetId === figure.sheetId ? "true" : undefined}
                    title={figureLegs(figure.sheetId).map((leg) => stageSpeedWarning(leg, nameOf)).filter(Boolean).join("\n") || undefined}
                    disabled={boardOn}
                    onClick={() => pick({ kind: "cast", sheetId: figure.sheetId })}
                  >
                    <span className="fy-swstage__mark" style={{ background: `#${figureColour(position).toString(16).padStart(6, "0")}` }} aria-hidden="true" />
                    <span>{nameOf(figure.sheetId)}</span>
                    {(() => {
                      const spin = stageFastTurns(working).find((turn) => turn.sheetId === figure.sheetId);
                      return spin === undefined
                        ? <span>{movementWord(figure)} · {poseWord(figure.pose)}</span>
                        : <span className="fy-swstage__warnstate" title={`${Math.round(spin.degrees)}° in ${(spin.to - spin.from).toFixed(1)} s`}>turns too fast at {spin.from.toFixed(1)} s</span>;
                    })()}
                  </button>
                ))}
                {working.sets.length === 0 ? null : <div className="fy-swstage__group">set · {working.sets.length}</div>}
                {working.sets.map((set, position) => (
                  <button
                    key={position}
                    type="button"
                    className="fy-swstage__item"
                    data-selected={selection?.kind === "set" && selection.index === position ? "true" : undefined}
                    disabled={boardOn}
                    onClick={() => pick({ kind: "set", index: position })}
                  >
                    <span className="fy-swstage__mark" data-kind="set" aria-hidden="true" />
                    <span>{set.name}</span>
                    <span>{set.shape ?? "box"}{set.solid ? " · solid" : ""}</span>
                  </button>
                ))}
                <AddSetMenu disabled={frozen || boardOn} onPick={addSet} />
                {sceneLights.length === 0 ? null : <div className="fy-swstage__group">lights · {sceneLights.length}</div>}
                {sceneLights.map((light, position) => (
                  <button
                    key={`${light.name}:${position}`}
                    type="button"
                    className="fy-swstage__item"
                    data-selected={lightSelected === position ? "true" : undefined}
                    data-testid="stage-light-line"
                    disabled={boardOn}
                    onClick={() => { setSelection(null); viewport.current?.select(null); setPlateSelected(false); setLightSelected((current) => (current === position ? null : position)); }}
                  >
                    <span className="fy-swstage__mark" data-kind="light" style={{ background: light.colour }} aria-hidden="true" />
                    <span>{light.name}</span>
                    <span>{light.kind} · {light.strength}</span>
                  </button>
                ))}
                <button type="button" className="fy-swstage__add" disabled={frozen || locked || moved || boardOn || sceneLights.length >= 24} onClick={addLight}><Plus size={12} />Add light</button>
              </div>

              {boardOn && board !== null ? (
                <div className="fy-swstage__block" data-testid="stage-board">
                  <Eyebrow title={`Board ${board.letter}`} meta={`${boardTotal.toFixed(1)} of ${board.capSec} s`} />
                  {boardCuts.map((cut, position) => (
                    <button key={cut.shotId} type="button" className="fy-swstage__item" data-selected={position === boardIndex ? "true" : undefined}
                      onClick={() => seekTime(cut.from)}>
                      <span className="fy-swstage__mark" data-kind="camera" aria-hidden="true" />
                      <span>{cut.number} · {cut.title}</span>
                      <span>{(cut.to - cut.from).toFixed(1)} s</span>
                    </button>
                  ))}
                  <Row label="line">
                    {boardLines.length === 0
                      ? <Value><span className="fy-swstage__ok">180° · clear</span></Value>
                      : <Value><span className="fy-swstage__warnstate">{boardLines.length} {boardLines.length === 1 ? "crossing" : "crossings"}</span></Value>}
                  </Row>
                  {boardLines.map((finding) => <span key={`${finding.pair.join("|")}:${finding.at}`} className="fy-swstage__quiet">{finding.message}</span>)}
                  <Row label="action" top>
                    <span className="fy-swstage__chips" role="radiogroup" aria-label="Board action">
                      {(["shared", "shot"] as const).map((candidate) => (
                        <button key={candidate} type="button" role="radio" aria-checked={boardAction === candidate} data-on={boardAction === candidate ? "true" : undefined}
                          onClick={() => setBoardAction(candidate)}>{candidate === "shared" ? "Shared" : "Per shot"}</button>
                      ))}
                    </span>
                  </Row>
                  {boardJumps.map((jump) => (
                    <span key={`${jump.sheetId}:${jump.shotId}`} className="fy-swstage__quiet">
                      {nameOf(jump.sheetId)} {jump.posture ? "changes posture" : `jumps ${jump.distance.toFixed(1)} m`} at the cut to {jump.number}
                    </span>
                  ))}
                </div>
              ) : null}
              {boardOn ? null : <>
              {lightSelected !== null && sceneLights[lightSelected] !== undefined ? (
                <>
                  <LightForm
                    light={sceneLights[lightSelected]!}
                    sets={working.sets}
                    disabled={frozen || locked || moved}
                    onChange={(next) => writeLight(lightSelected, next)}
                    onRemove={() => { const index = lightSelected; setLightSelected(null); writeLight(index, null); }}
                  />
                  <AtmosphereRows atmosphere={scene.blocking?.atmosphere} disabled={frozen || locked || moved} onChange={(atmosphere) => writeScene({ atmosphere })} />
                </>
              ) : null}
              {plateSelected && scene.blocking?.plate !== undefined ? (
                <PlateForm
                  plate={scene.blocking.plate}
                  world={world}
                  shots={shots}
                  currentShotId={shot.id}
                  disabled={frozen || locked || moved}
                  onChange={writePlate}
                  onReplace={pickPlate}
                  onMatch={matchPlate}
                  onRemove={() => { setPlateSelected(false); writePlate(null); }}
                />
              ) : null}
              {(selection?.kind === "rig" || selection?.kind === "aim") && activeKey !== null ? (
                <div className="fy-swstage__block">
                  <Eyebrow title="Camera" meta={keyName(active, keys.length)} />
                  <CameraWords
                    words={activeKey.frame}
                    cast={working.cast.map((figure) => ({ sheetId: figure.sheetId, name: nameOf(figure.sheetId) }))}
                    defaultSubject={activeKey.track ?? activeKey.anchor}
                    shotLensMm={shotLensMm}
                    at={(() => { const pose = sampleStageCamera(working, activeKey.t, durationSec); return `${pose.p.map((value) => value.toFixed(2)).join(" ")} · aim ${pose.l.map((value) => value.toFixed(2)).join(" ")}`; })()}
                    numbers={numbers || activeKey.frame === undefined}
                    disabled={frozen}
                    onWords={(words: StageFrameWords) => {
                      const resolved = stageFrameKey(working, { ...words, aspect }, activeKey.t, durationSec, aspect, framing.lens);
                      if (resolved === null) return;
                      patchCamera((current) => ({ ...current, keys: current.keys.map((key, position) => position === active ? {
                        ...resolved, t: key.t,
                        ...(key.easeIn === undefined ? {} : { easeIn: key.easeIn }),
                        ...(key.easeOut === undefined ? {} : { easeOut: key.easeOut }),
                        ...(key.roll === undefined ? {} : { roll: key.roll }),
                      } : key) }));
                    }}
                    onNumbers={() => setNumbers((on) => !on)}
                  />
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
                  {numbers || activeKey.frame === undefined ? <>
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
                    <Stepper label="Ease in" value={activeKey.easeIn ?? 0} step={0.05} min={0} max={0.5} disabled={frozen || !stageCameraRest(working!.keys, active)} onCommit={(value) => patchKey(active, { easeIn: value })} />
                  </Row>
                  <Row label="ease out">
                    <Stepper label="Ease out" value={activeKey.easeOut ?? 0} step={0.05} min={0} max={0.5} disabled={frozen || !stageCameraRest(working!.keys, active)} onCommit={(value) => patchKey(active, { easeOut: value })} />
                  </Row>
                  </> : null}
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
                            {STAGE_POSES.map((pose) => <option key={pose} value={pose}>{STAGE_POSE_LABELS[pose]}</option>)}
                          </select>
                        </Row>
                        {/* A hand on someone or something, and where the figure looks (issue 1821, design turn 228d). */}
                        <Row label="hand">
                          <span className="fy-swstage__chips" role="radiogroup" aria-label={`${name} ${chosen.t}s hand`}>
                            {([["none", "None"], ["left", "Left"], ["right", "Right"], ["both", "Both"]] as const).map(([side, label]) => {
                              const on = (chosen.hand?.side ?? "none") === side;
                              return <button key={side} type="button" role="radio" aria-checked={on} data-on={on ? "true" : undefined} disabled={frozen}
                                onClick={() => {
                                  if (side === "none") { patchChosen({ hand: undefined }); return; }
                                  const other = working.cast.find((figure) => figure.sheetId !== sheetId);
                                  const target = chosen.hand?.on ?? other?.sheetId ?? working.sets[0]?.name;
                                  if (target !== undefined) patchChosen({ hand: { ...chosen.hand, side, on: target, ...(chosen.hand?.part === undefined && other !== undefined && target === other.sheetId ? { part: "left shoulder" as const } : {}) } });
                                }}>{label}</button>;
                            })}
                          </span>
                        </Row>
                        {chosen.hand === undefined ? null : (
                          <Row label="on">
                            <select className="fy-swstage__select" aria-label={`${name} ${chosen.t}s hand on`} value={`${chosen.hand.on}|${chosen.hand.part ?? ""}`} disabled={frozen}
                              onChange={(event) => { const [on, part] = event.target.value.split("|"); patchChosen({ hand: { side: chosen.hand!.side, on: on!, ...(part ? { part: part as NonNullable<StagePerformanceKey["hand"]>["part"] } : {}) } }); }}>
                              {working.cast.filter((figure) => figure.sheetId !== sheetId).flatMap((figure) => (["left shoulder", "right shoulder", "head", "hand", "waist"] as const).map((part) => (
                                <option key={`${figure.sheetId}|${part}`} value={`${figure.sheetId}|${part}`}>{nameOf(figure.sheetId)} · {part}</option>
                              )))}
                              {working.sets.map((set) => <option key={`${set.name}|`} value={`${set.name}|`}>{set.name}</option>)}
                            </select>
                          </Row>
                        )}
                        <Row label="look at">
                          <select className="fy-swstage__select" aria-label={`${name} ${chosen.t}s looks at`} value={chosen.look ?? ""} disabled={frozen}
                            onChange={(event) => patchChosen({ look: event.target.value === "" ? undefined : event.target.value })}>
                            <option value="">Ahead</option>
                            {working.cast.filter((figure) => figure.sheetId !== sheetId).map((figure) => <option key={figure.sheetId} value={figure.sheetId}>{nameOf(figure.sheetId)}</option>)}
                            {working.sets.map((set) => <option key={set.name} value={set.name}>{set.name}</option>)}
                          </select>
                        </Row>
                        <Row label="at"><Value muted><span className="fy-swstage__quietmono">{chosen.t.toFixed(2)} s{chosen.hold ? ` · hold ${chosen.hold.toFixed(2)} s` : ""}</span></Value></Row>
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
                    {set.kit ? <KitRows kit={set.kit} name={set.name} disabled={frozen} onChange={(kit) => patchSet(position, { kit })} /> : null}
                    {set.kit ? <SurfaceRows set={set} disabled={frozen} onChange={(surfaces) => patchSet(position, surfaces === undefined ? { surfaces: undefined } : { surfaces })} /> : <MaterialRow set={set} disabled={frozen} onChange={(material) => patchSet(position, { material })} />}
                    {set.kit ? null : <Row label="shape">
                      <select className="fy-swstage__select" aria-label={`${set.name} shape`} value={set.shape ?? "box"} disabled={frozen} onChange={e => patchSet(position, { shape: e.target.value as StagingSet["shape"] })}>
                        <option value="box">Box</option><option value="cylinder">Cylinder</option><option value="sphere">Sphere</option>
                        {/* A mesh is its vertices and triangles, which no primitive has; the choice exists only for a set built as one. */}
                        {set.shape === "mesh" ? <option value="mesh">Mesh</option> : null}
                      </select>
                    </Row>}
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

              </>}
              {/* The ways on are the shot's whatever is selected (140a's foot, kept by 144): the
                  playblast's state, then Export and Render, pinned under the forms. On a board they
                  are the animatic's (issue 1824). */}
              <span className="fy-swstage__spacer" />
              {boardOn && board !== null ? (
                <div className="fy-swstage__block fy-swstage__block--ways">
                  <Row label="animatic">
                    <span className="fy-swstage__value" data-filed={boardPin === null || boardStale ? undefined : "true"}>
                      {boardPin === null ? "not filed" : boardStale ? "filed · stale" : "filed"}
                    </span>
                  </Row>
                  {note === null ? null : <span className="fy-swstage__quiet" role="status">{note}</span>}
                  <div className="fy-swstage__ways">
                    <Button variant="outline" size="sm" disabled={locked || exporting !== null || sceneFile === undefined} onClick={() => void exportAnimatic()}>
                      {exporting === null ? "Export animatic" : `exporting… ${Math.round(exporting * 100)}%`}
                    </Button>
                    {onRenderBoard && <Button variant="primary" size="sm"
                      disabled={generatorPending || frozen || boardPin === null || boardStale}
                      title={boardPin === null || boardStale ? "Export the current animatic first" : undefined}
                      onClick={() => onRenderBoard(board.memberShotIds)}>
                      {generatorPending ? "Opening…" : "Render with this"}
                    </Button>}
                  </div>
                </div>
              ) : (
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
                  {onRenderShot && <Button
                    variant="primary"
                    size="sm"
                    // The session is prepared from the KEPT staging; a move still in hand would render the old one.
                    disabled={generatorPending || frozen || moved || stale || filed === undefined}
                    title={moved ? "Keep the move first" : stale || filed === undefined ? "Export the current blockout first" : undefined}
                    onClick={() => onRenderShot(shot.id)}
                  >
                    {generatorPending ? "Opening…" : "Render with this"}
                  </Button>}
                </div>
              </div>
              )}

              {/* Mounted whatever is selected: the reference plate lives in the viewport and its choice
                  must survive a change of form; only its rows belong to the shot's form. */}
              <StageUnderlay key={`underlay:${world.meta.worldId}:${shot.id}`} world={world} production={production} shotId={shot.id}
                viewport={viewportElement} aspect={aspect} at={at} playing={playing} visible={mode === "camera" && exporting === null && !constructing}
                disabled={frozen} onChoose={() => setMode("camera")} slot={referenceSlot} />
            </>
          )}
        </aside></StageInspectorSheet>
      </div>
      {touch && <div className="fy-stage-gestures"><span>1 finger · orbit</span><span>2 fingers · pan / pinch</span><span>Double-tap · follow figure</span></div>}

      {(touch || inspectorSheet) && working !== null && <div className="fy-stage-touch-ways"><Button variant="outline" disabled={!moved || locked || frozen} onClick={keep}>Keep blocking</Button>{onRenderShot && <Button variant="primary" disabled={generatorPending || frozen || moved || stale || filed === undefined} title={moved ? "Keep the move first" : stale || filed === undefined ? "Export the current blockout from the inspector first" : undefined} onClick={() => onRenderShot(shot.id)}>Render with this</Button>}</div>}
      {working === null ? null : (
        <div className="fy-swstage__timeline">
          <div className="fy-swstage__transport">
          <button type="button" className="fy-swstage__play" aria-label={playing ? "Pause" : "Play"} disabled={frozen} onClick={toggle}>
            {playing ? <PauseSolid size={11} /> : <PlaySolid size={11} />}
          </button>
          <button type="button" className="fy-swstage__loop" aria-pressed={loop} disabled={frozen} onClick={() => { if (!frozen) setLoop(!loop); }}>Loop</button>
          <span className="fy-swstage__time">{Math.min(at, clock).toFixed(1)}s / {clock.toFixed(1)}s</span>
          </div>
          {boardOn ? <>
          <div className="fy-swstage__track fy-swstage__cuts" data-testid="stage-cuts">
            <div className="fy-swstage__scrubber" role="slider" tabIndex={0}
              aria-label="Board playhead" aria-valuemin={0} aria-valuemax={boardTotal} aria-valuenow={at} aria-valuetext={`${at.toFixed(2)} seconds`}
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
            {boardCuts.map((cut, position) => (
              <button key={cut.shotId} type="button" className="fy-swstage__cut" data-on={position === boardIndex ? "true" : undefined}
                style={{ left: `${cut.from / boardTotal * 100}%`, width: `calc(${(cut.to - cut.from) / boardTotal * 100}% - 3px)` }}
                aria-label={`Shot ${cut.number} from ${cut.from.toFixed(1)} to ${cut.to.toFixed(1)} seconds`}
                onClick={() => seekTime(cut.from)}>
                <b>{cut.number}</b><em>{cut.title}</em>
              </button>
            ))}
            <span className="fy-swstage__cut-head" style={{ left: `${at / Math.max(0.01, boardTotal) * 100}%` }} aria-hidden="true" />
          </div>
          <span className="fy-swstage__keytools"><span className="fy-swstage__count">{boardCuts.length} shots</span></span>
          {(working?.cast ?? []).flatMap((figure, position) => {
            // A figure's action across the cuts: each member's marks on the board's clock.
            const marks = boardMembers.flatMap((member) => (member.resolved.performances?.find((track) => track.sheetId === figure.sheetId)?.keys ?? []).map((key) => ({ ...key, t: key.t + member.cut.from })));
            if (marks.length === 0) return [];
            const colour = `#${figureColour(position).toString(16).padStart(6, "0")}`;
            const name = nameOf(figure.sheetId);
            return [(
              <Fragment key={`board:${figure.sheetId}`}>
                <span className="fy-swstage__lane-label"><i style={{ background: colour }} />{name}</span>
                <div className="fy-swstage__track fy-swstage__motion-track" aria-label={`${name} action`} style={{ color: colour }}>
                  <span className="fy-swstage__rail" aria-hidden="true" />
                  <span className="fy-swstage__lane-head" style={{ left: `${at / Math.max(0.01, boardTotal) * 100}%` }} aria-hidden="true" />
                  {boardCuts.slice(1).map((cut) => <span key={cut.shotId} className="fy-swstage__lane-cut" style={{ left: `${cut.from / boardTotal * 100}%` }} aria-hidden="true" />)}
                  {marks.map((key, index) => (
                    <span key={index} className="fy-swstage__key" data-mid="true" style={{ left: `${key.t / boardTotal * 100}%`, transform: "translateX(-50%)" }} aria-hidden="true"><span /></span>
                  ))}
                  {lanePoses(marks).map((label) => <span key={`${label.t}`} className="fy-swstage__lane-pose" style={{ left: `${label.t / boardTotal * 100}%` }}>{label.word}</span>)}
                </div>
                <span className="fy-swstage__count">{marks.length} marks</span>
              </Fragment>
            )];
          })}
          </> : <>
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
                {lane.kind === "performance" ? lanePoses(lane.keys as readonly StagePerformanceKey[]).map((label) => (
                  <span key={`${label.t}`} className="fy-swstage__lane-pose" style={{ left: `${label.t / durationSec * 100}%` }}>{label.word}</span>
                )) : null}
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
          </>}
        </div>
      )}
    </section>
    </StageEditContext.Provider>
  );
}
