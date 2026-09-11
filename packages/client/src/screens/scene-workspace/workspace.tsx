import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  DEFAULT_SHOT_SEC,
  seasonFindings,
  orderedShots,
  legacySceneView,
  type ClientMessage,
  type ArtifactSidecar,
  type FrameRunState,
  type PackedBoard,
  type ProductionBundle,
  type SceneRecord,
  type WorldBundle,
  type WorldChatSubject,
} from "@arke-studio/contracts";
import { productionModel, resolveModel } from "../../components/dispatch-bar.js";
import { initials, seconds } from "../../lib/format.js";
import { mediaUrl } from "../../lib/media.js";
import { acceptedTakeId, takesForShot } from "../../lib/selectors.js";
import {
  frameRunCommand,
  dispatchScenePlanned,
  sceneCommand,
  sendBenchOpenSubject,
  subscribeBenchSubjectOpened,
  subscribePlanResults,
  subscribeSceneRefusals,
  useClientState,
  useStore,
} from "../../lib/store.js";
import { ProductionConversation, StagedDecision } from "../../components/conversation.js";
import { SceneReview, SceneSynopsis, SceneTitle, useBlockDigests } from "../storyboard.js";
import { SceneFlow } from "./flow.js";
import { StoryboardRows } from "./rows.js";
import { SelectionProvider, selectedShotId, subjectMatchesBoard, type WorkspaceSubject } from "./selection.js";
import { boardsForScene, shotHasFrame } from "./boards.js";
import { FrameRunBar, FrameRunBoardFailures, GenerateFramesDialog } from "./frame-run.js";
import { ShotLightbox } from "./lightbox.js";
import { CastPicker, SheetPicture, sceneCast, type CastPickerMode } from "./cast-picker.js";
import { CharacterDialog } from "./character-dialog.js";
import { LocationDialog } from "./location-dialog.js";
import { Button } from "../../components/ui.js";
import { Film, Grid2x2, ImageMark, ListBullet, Maximize2, Minimize2, More, Pin, Plus, Timer } from "../../components/icons.js";
import { BoardSheet } from "./board-sheet.js";
import { ScenePreview } from "./preview.js";
import { SceneStage } from "./stage.js";
import { PlansPanel } from "./plans.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];

/**
 * The scene authoring shell (SPEC-029 R-21..R-29), mounted for every scene detail route.
 *
 * Storyboard is the default, with the cast and place above it and Arke beside it (design 138).
 * List and Grid share the same rows so changing the layout preserves an unfinished edit.
 *
 * The selection lives HERE, above the tabs, which is the whole of why switching views keeps it
 * (T-18). A per-view selection is unmounted with its view; that is not a bug you can patch
 * inside either view, so the state is hoisted rather than synchronised.
 */
export function SceneWorkspace({
  world,
  production,
  scene,
}: {
  world: WorldBundle;
  production: ProductionBundle;
  scene: SceneRecord;
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // The same digests the strip compares citations against — one hook, cached on the blocks
  // array itself, so mounting this beside anything else costs no second sweep of the script.
  const state = useClientState();
  const connection = useStore().connection;
  const digests = useBlockDigests(legacySceneView(scene));
  const [view, setView] = useState<"storyboard" | "flow" | "stage" | "preview">("storyboard");
  // Full screen (SPEC-044 R-37, R-38): session state like the put-away, never written. The view
  // stays where it is in the tree and the page around it steps aside by CSS, so Flow's positions
  // and zoom and the Stage's draft survive the move without a remount.
  const [full, setFull] = useState(false);
  // Full screen belongs to Flow and the Stage (R-37): a Flow menu entry that moves the view to
  // Storyboard takes the page out of it, since the rows it lands on are not a view that fills.
  const fullscreen = full && (view === "flow" || view === "stage");
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      // A dialog above the view, or the Flow's own menu, owns its Escape; the page leaves full
      // screen only when nothing does. The menu listens on window, after this document listener.
      if (event.key === "Escape" && document.querySelector("dialog[open], .fy-swcanvas__menu") === null) setFull(false);
    };
    document.addEventListener("keydown", onKey);
    // The production rail and the title bar sit outside this screen and under the overlay:
    // unreachable to the pointer already, and inert so the keyboard cannot tab into what nobody
    // can see.
    const chrome = [...document.querySelectorAll(".fy-prodrail, .fy-titlebar")];
    for (const element of chrome) element.setAttribute("inert", "");
    return () => {
      document.removeEventListener("keydown", onKey);
      for (const element of chrome) element.removeAttribute("inert");
    };
  }, [fullscreen]);
  const [showBoards, setShowBoards] = useState(false);
  const [storyboardLayout, setStoryboardLayout] = useState<"list" | "grid">("list");
  // The one lightbox: the row preview, the run bar's Review and Preview's Larger all open it,
  // and its arrows walk the scene's shots carrying the selection with them.
  const [lightboxShotId, setLightboxShotId] = useState<string | null>(null);
  const [generateTarget, setGenerateTarget] = useState<{ shotId?: string } | null>(null);
  const [sceneReviewOpen, setSceneReviewOpen] = useState(false);
  const [boardSheetKey, setBoardSheetKey] = useState<string | null>(null);
  const [boardSheetTrigger, setBoardSheetTrigger] = useState<HTMLElement | null>(null);
  const [refusalVersion, setRefusalVersion] = useState(0);
  const [commandPending, setCommandPending] = useState(false);
  const [generatorPending, setGeneratorPending] = useState(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  // The header's two doors (SPEC-044 R-1, R-2): the picker adds, the tiles and the place chip
  // open their dialogs. Session state, like the lightbox — a door is not an address.
  const [picker, setPicker] = useState<CastPickerMode | null>(null);
  const [openMember, setOpenMember] = useState<string | null>(null);
  const [openPlace, setOpenPlace] = useState<string | null>(null);
  // A closed picker or dialog is unmounted, and a removed modal drops focus on the body; the
  // door that opened it takes focus back, as the Generate frames dialog's does.
  const doorFocus = useRef<HTMLElement | null>(null);
  const closeDoor = () => { setPicker(null); setOpenMember(null); setOpenPlace(null); };
  // Once the modal is gone, not while it still holds the top layer: a focus() under a modal
  // dialog is ignored, and the removal then drops focus on the body.
  useEffect(() => {
    if (picker === null && openMember === null && openPlace === null) doorFocus.current?.focus();
  }, [picker, openMember, openPlace]);
  const pendingCommand = useRef(false);
  const sceneKey = `${world.meta.worldId}/${production.meta.id}/${scene.id}`;
  const currentSceneKey = useRef(sceneKey);
  currentSceneKey.current = sceneKey;
  const pendingGenerator = useRef<{ requestId: string; sceneKey: string } | null>(null);
  const pendingPlan = useRef<string | null>(null);
  const generateReturnFocus = useRef<HTMLElement>(null);
  // Arke can be put away (R-28). Local to the session rather than a setting: it is a gesture
  // about right now — "give me the width" — not a preference about how the app should be.
  const [dock, setDock] = useState(true);
  // The dock title toggles between the shot and the whole scene; this remembers which shot to
  // come back to, since the scene subject carries none.
  const lastShotSubject = useRef<string | null>(null);
  const linkedShotId = searchParams.get("shot");
  const [subject, setSubject] = useState<WorkspaceSubject>(() =>
    linkedShotId !== null && orderedShots(scene).some((shot) => shot.id === linkedShotId)
      ? { kind: "shot", shotId: linkedShotId as never }
      : { kind: "scene" },
  );
  const conversationSubject: WorldChatSubject = subject.kind === "scene"
    ? { kind: "scene", sceneId: scene.id }
    : subject.kind === "shot"
      ? { kind: "shot", sceneId: scene.id, shotId: subject.shotId as never }
      : subject.kind === "board"
        ? { kind: "board", sceneId: scene.id, memberShotIds: subject.memberShotIds as never }
        : {
            kind: "edge",
            sceneId: scene.id,
            fromShotId: subject.fromShotId as never,
            toShotId: subject.toShotId as never,
          };
  const selection = useMemo(() => ({ subject, select: setSubject }), [subject]);
  useEffect(() => {
    if (linkedShotId !== null && orderedShots(scene).some((shot) => shot.id === linkedShotId)) {
      setSubject({ kind: "shot", shotId: linkedShotId as never });
    }
  }, [linkedShotId, scene]);

  const sceneFile = production.sceneFiles[scene.id];
  const scenePath = sceneFile === undefined ? null : `productions/${production.meta.id}/scenes/${sceneFile}.json`;
  const staged = [...world.proposals]
    .filter((entry) => scenePath !== null && entry.proposal.kind === "scene-edit" && entry.scenes?.[scenePath] !== undefined)
    .sort((left, right) =>
      left.proposal.created.localeCompare(right.proposal.created) || left.proposal.id.localeCompare(right.proposal.id),
    )
    .at(-1);
  const workingScene = scenePath === null ? scene : (staged?.scenes?.[scenePath] ?? scene);
  const shots = orderedShots(scene);
  const workingShots = orderedShots(workingScene);
  const acceptedById = new Map(shots.map((shot) => [shot.id, shot]));
  const acceptedOrder = shots.map((shot) => shot.id);
  const workingOrder = workingShots.map((shot) => shot.id);
  const stagedShotIds = new Set(
    workingShots
      .filter((shot, index) => {
        const accepted = acceptedById.get(shot.id);
        return accepted === undefined || JSON.stringify(accepted) !== JSON.stringify(shot) || acceptedOrder[index] !== workingOrder[index];
      })
      .map((shot) => shot.id),
  );
  const newShotIds = new Set(workingShots.filter((shot) => !acceptedById.has(shot.id)).map((shot) => shot.id));
  const workingIds = new Set(workingShots.map((shot) => shot.id));
  const removedShots = shots.filter((shot) => !workingIds.has(shot.id));
  const artifacts: readonly ArtifactSidecar[] = world.artifacts;
  const aspect = production.meta.aspect ?? "16:9";
  // The cap the boards pack against, so Flow packs exactly as the rows do. Absent a model, the
  // widest common clip length rather than a guess that would draw boards nothing would render.
  const resolvedModel = resolveModel(
    state,
    "video",
    undefined,
    productionModel(state, production.meta.id, "video"),
  );
  // A stranded choice is still the model this production names; substituting another cap would
  // make the board move before dispatch has asked the creator to repair that choice.
  const videoModel = resolvedModel.stranded ?? resolvedModel.model;
  const capSec = videoModel?.limits.maxDurationSec ?? 10;
  const panelCap = videoModel?.limits.storyboardPanels;
  const acceptedBoardPack = useMemo(
    () => boardsForScene({ scene, production, artifacts, sheets: world.sheets, capSec, ...(panelCap !== undefined ? { panelCap } : {}) }),
    [scene, production, artifacts, world.sheets, capSec, panelCap],
  );
  const boardPack = useMemo(
    () => boardsForScene({ scene: workingScene, production, artifacts, sheets: world.sheets, capSec, ...(panelCap !== undefined ? { panelCap } : {}), stagedShotIds: newShotIds }),
    [workingScene, production, artifacts, world.sheets, capSec, panelCap, newShotIds],
  );
  const stagedBoards =
    JSON.stringify(scene.boards) !== JSON.stringify(workingScene.boards) ||
    JSON.stringify(acceptedBoardPack) !== JSON.stringify(boardPack);
  const episodeIds = new Set(production.episodes.filter((episode) => episode.scenes.includes(scene.id)).map((episode) => episode.id));
  const lengthFindings = seasonFindings(production).filter((finding) => finding.kind === "cost-pattern" && episodeIds.has(finding.about));
  const totalSec = shots.reduce((sum, shot) => sum + (shot.durationSec ?? DEFAULT_SHOT_SEC), 0);
  const framed = shots.filter((shot) => shotHasFrame(production, artifacts, shot.id)).length;
  const focus = selectedShotId(subject);
  const focused = focus === null ? undefined : workingShots.find((shot) => shot.id === focus);
  if (focus !== null) lastShotSubject.current = focus;
  const shotLabel = (shotId: string) => {
    const shot = workingShots.find((candidate) => candidate.id === shotId);
    return shot === undefined ? shotId : `shot ${shot.number}`;
  };
  const talkToArke = () => {
    // The dock sits beneath full screen; a pinned dock nobody can see is nothing.
    setFull(false);
    setDock(true);
    requestAnimationFrame(() => {
      (document.querySelector(".fy-arke .fy-cx__editor") as HTMLElement | null)?.focus();
    });
  };
  const sceneRuns = [...(state?.frameRuns ?? [])]
    .filter((candidate) =>
      candidate.worldId === world.meta.worldId &&
      candidate.productionId === production.meta.id &&
      candidate.run.sceneId === scene.id)
    .sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt));
  const visibleSceneRuns = sceneRuns.filter((candidate) => candidate.run.dismissed !== true);
  // Cancel returns the row to idle at once, so a cancelled run never becomes the bar. The
  // coordinator keeps the record until it is dismissed, and that dismiss is sent below — once
  // per run, and only once it was actually delivered.
  const frameRun = visibleSceneRuns.find((candidate) => candidate.status === "active" || candidate.status === "paused")
    ?? visibleSceneRuns.find((candidate) => candidate.status === "completed")
    ?? null;
  const reviewShotId = frameRun === null ? null : firstProducedShot(frameRun, artifacts);
  const dismissedCancelled = useRef(new Set<string>());
  useEffect(() => {
    for (const candidate of visibleSceneRuns) {
      if (candidate.status !== "cancelled" || dismissedCancelled.current.has(candidate.run.id)) continue;
      const sent = frameRunCommand({
        kind: "frame-run-dismiss",
        worldId: world.meta.worldId,
        productionId: production.meta.id,
        runId: candidate.run.id,
      });
      if (sent) dismissedCancelled.current.add(candidate.run.id);
    }
  });
  const boardsVisible = showBoards || frameRun?.run.mode === "board";
  const selectedBoard = boardSheetKey === null || !boardPack.ok
    ? null
    : boardPack.boards.find((board) => JSON.stringify(board.memberShotIds) === boardSheetKey) ?? null;
  const subjectBoard = subject.kind !== "board" || !boardPack.ok
    ? null
    : boardPack.boards.find((board) => subjectMatchesBoard(subject, board.memberShotIds)) ?? null;
  const episode = production.episodes.find((candidate) => candidate.scenes.includes(scene.id));
  const locationSheet = scene.inherits?.location === undefined
    ? undefined
    : world.sheets.find((sheet) => sheet.id === scene.inherits?.location);
  const locationName = scene.inherits?.location === undefined ? null : locationSheet?.name ?? scene.inherits.location;
  // What the title editor already knows: a staged proposal or a command in flight refuses a write.
  const locked = staged !== undefined || sceneFile === undefined || commandPending;
  const write = (command: Command): boolean => {
    if (sceneFile === undefined || staged !== undefined || pendingCommand.current) return false;
    const sent = sceneCommand({
          worldId: world.meta.worldId,
          productionId: production.meta.id,
          sceneFile,
          sceneId: scene.id,
          baseVersion: scene.version,
          command,
        });
    if (sent) {
      pendingCommand.current = true;
      setCommandPending(true);
    }
    return sent;
  };
  const dockTitle =
    subject.kind === "edge"
      ? `Arke · Edge ${subject.fromShotId ?? "Entry"} to ${subject.toShotId ?? "Exit"}`
      : subject.kind === "board"
        ? `Arke · ${subjectBoard === null ? "Board" : `Board ${subjectBoard.letter}`}`
        : focused === undefined
          ? `Arke · Scene ${scene.number}`
          : `Arke · Shot ${focused.number}`;
  const dockSubject = subject.kind === "edge"
    ? "scene flow"
    : subject.kind === "board"
      ? subjectBoard === null
        ? `${subject.memberShotIds.length} shots`
        : `shots ${workingShots.find((shot) => shot.id === subjectBoard.memberShotIds[0])?.number ?? "?"}–${workingShots.find((shot) => shot.id === subjectBoard.memberShotIds.at(-1))?.number ?? "?"} · ${subjectBoard.durationSec}s`
      : focused === undefined
        ? `${scene.title} · v${scene.version}`
        : `${focused.title} · ${shotHasFrame(production, artifacts, focused.id) ? "frame filed" : "no frame"}`;
  const focusedFrameId = focused === undefined ? undefined : production.selections[focused.id]?.startFrameArtifactId;
  const focusedArtifact = focusedFrameId === undefined || focused === undefined || !shotHasFrame(production, artifacts, focused.id)
    ? undefined
    : artifacts.find((artifact) => artifact.id === focusedFrameId);
  const focusedAccepted = focused === undefined ? null : acceptedTakeId(production, focused.id);
  const focusedLegacyFrame = focused === undefined || focusedAccepted === null
    ? undefined
    : takesForShot(production, focused.id).find((take) =>
        take.id === focusedAccepted && (take.kind === "frame" || take.kind === "still"),
      );
  const thumbnailSrc = world.meta.slug === undefined
    ? null
    : focusedArtifact !== undefined
      ? mediaUrl(world.meta.slug, `artifacts/${focusedArtifact.file}`)
      : focusedLegacyFrame?.media === undefined
        ? null
        : mediaUrl(world.meta.slug, `productions/${production.meta.id}/takes/${focusedLegacyFrame.id}/${focusedLegacyFrame.media}`);

  useEffect(
    () =>
      subscribeSceneRefusals((event) => {
        if (event.productionId === production.meta.id && event.sceneFile === sceneFile) {
          pendingCommand.current = false;
          setCommandPending(false);
          setRefusalVersion((version) => version + 1);
        }
      }),
    [production.meta.id, sceneFile],
  );
  useEffect(
    () =>
      subscribePlanResults((event) => {
        if (
          event.worldId !== world.meta.worldId ||
          event.productionId !== production.meta.id ||
          event.requestId !== pendingPlan.current
        ) {
          return;
        }
        pendingPlan.current = null;
        setPlanError(event.disposition === "failed" ? (event.reason ?? "The plan could not be created.") : null);
      }),
    [world.meta.worldId, production.meta.id],
  );
  useEffect(() => {
    pendingCommand.current = false;
    setCommandPending(false);
  }, [scene.id, sceneFile, scene.version]);
  useEffect(
    () =>
      subscribeBenchSubjectOpened((event) => {
        const pending = pendingGenerator.current;
        if (
          pending === null ||
          pending.sceneKey !== currentSceneKey.current ||
          event.worldId !== world.meta.worldId ||
          event.requestId !== pending.requestId
        ) {
          return;
        }
        pendingGenerator.current = null;
        setGeneratorPending(false);
        if (event.sessionId === null) {
          setGeneratorError(event.reason ?? "The generator session could not be prepared.");
          return;
        }
        setGeneratorError(null);
        void navigate(`/w/${world.meta.worldId}/artifacts/bench/${event.sessionId}`);
      }),
    [navigate, world.meta.worldId],
  );
  useEffect(() => {
    if (connection === "open" || pendingGenerator.current === null) return;
    pendingGenerator.current = null;
    setGeneratorPending(false);
    setGeneratorError("Connection lost - try again.");
  }, [connection]);
  useEffect(() => {
    if (connection === "open" || pendingPlan.current === null) return;
    pendingPlan.current = null;
    setPlanError("Connection lost - try again.");
  }, [connection]);
  const openGenerator = (
    subject: Extract<ClientMessage, { kind: "bench-open-subject" }>["subject"],
    mode?: "image" | "video",
  ) => {
    if (pendingGenerator.current !== null) return;
    const requestId = sendBenchOpenSubject({
      worldId: world.meta.worldId,
      productionId: production.meta.id,
      sceneId: scene.id,
      subject,
      ...(mode === undefined ? {} : { mode }),
    });
    if (requestId !== null) {
      pendingGenerator.current = { requestId, sceneKey };
      setGeneratorPending(true);
      setGeneratorError(null);
    } else {
      setGeneratorError("Not connected - try again.");
    }
  };
  // The Stage is reached from a row's menu and a Flow staging node as well as its tab: one
  // gesture selects the shot and changes the view, so the tab opens on the shot that asked.
  const openStage = (shotId: string) => {
    setSubject({ kind: "shot", shotId: shotId as never });
    setView("stage");
  };
  const constructionRequest = state?.stageConstructionRequests?.find(request => request.worldId === world.meta.worldId && request.productionId === production.meta.id && request.sceneId === scene.id);
  useEffect(() => {
    if (!constructionRequest) return;
    setSubject({ kind: "shot", shotId: constructionRequest.shotId as never }); setView("stage");
  }, [constructionRequest?.actionId, constructionRequest?.shotId]);
  const playblastRequest = state?.stagePlayblastRequests?.find((request) =>
    request.worldId === world.meta.worldId && request.productionId === production.meta.id && request.sceneId === scene.id);
  useEffect(() => {
    if (playblastRequest === undefined) return;
    setSubject({ kind: "shot", shotId: playblastRequest.shotId as never });
    setView("stage");
  }, [playblastRequest?.actionId, playblastRequest?.shotId]);
  const planVideo = () => {
    if (pendingPlan.current !== null || sceneFile === undefined || videoModel == null) return;
    // The scene page chooses nothing per dispatch (SPEC-044 R-26): the coordinator resolves the
    // scene's cast into references when it plans, and the Bench keeps the one per-dispatch off.
    pendingPlan.current = dispatchScenePlanned(
      world.meta.worldId,
      production.meta.id,
      sceneFile,
      "whole-scene",
      videoModel.id,
      "review-gated",
    );
    setPlanError(null);
  };
  useEffect(() => {
    // The scene route reuses this component. A response belongs to the scene that sent it and must
    // not navigate back from a newer scene or leave that newer scene's actions blocked.
    pendingGenerator.current = null;
    pendingPlan.current = null;
    setGeneratorPending(false);
    setGeneratorError(null);
    setPlanError(null);
  }, [world.meta.worldId, production.meta.id, scene.id]);
  useEffect(() => {
    frameRunCommand({ kind: "frame-run-list", worldId: world.meta.worldId, productionId: production.meta.id });
  }, [world.meta.worldId, production.meta.id]);

  return (
    <SelectionProvider value={selection}>
      <div className="fy-sw" data-screen="scene-detail" data-testid="scene-workspace" data-dock={dock ? "true" : "false"} data-full={fullscreen ? "true" : undefined}>
        <main className="fy-sw__centre">
          {fullscreen ? (
            <>
              <div className="fy-sw__fullpill">
                {production.meta.title} · {episode === undefined ? "" : `episode ${episode.order} · `}scene {scene.number}
                <i aria-hidden="true" />
                <b>{view === "flow" ? "Flow" : "Stage"}</b>
              </div>
              <button type="button" className="fy-sw__fullexit" title="Leave full screen" aria-label="Leave full screen" onClick={() => setFull(false)}>
                <Minimize2 size={14} /><span>Esc</span>
              </button>
            </>
          ) : null}
          <header className="fy-sw__head">
            <p className="fy-sw__breadcrumb">
              {production.meta.title}
              {episode === undefined ? ` · scene ${scene.number}` : ` · episode ${episode.order} · ${episode.title}`}
            </p>
            <div className="fy-sw__headline">
              <h1 className="fy-sw__title">
                Scene {scene.number} ·{" "}
                <SceneTitle
                  title={scene.title}
                  locked={staged !== undefined || sceneFile === undefined || commandPending}
                  onCommit={(title) => write({ kind: "edit-scene", title })}
                />
              </h1>
              <div className="fy-sw__actions">
                <Button variant="outline" size="sm" onClick={() => setSceneReviewOpen((open) => !open)}>Review scene</Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={(event) => {
                    generateReturnFocus.current = event.currentTarget;
                    setGenerateTarget({});
                  }}
                >
                  Generate frames
                </Button>
              </div>
            </div>
            <div className="fy-sw__context" aria-label="Scene context">
              <div className="fy-sw__cast" aria-label="Cast">
                <span className="fy-sw__context-label">Cast</span>
                {sceneCast(scene, world.sheets).map((sheetId) => {
                  const sheet = world.sheets.find((candidate) => candidate.id === sheetId);
                  const name = sheet?.name ?? sheetId;
                  return (
                    <button
                      type="button"
                      key={sheetId}
                      className="fy-sw__tile"
                      title={name}
                      aria-label={name}
                      aria-haspopup="dialog"
                      aria-expanded={openMember === sheetId}
                      onClick={(event) => { doorFocus.current = event.currentTarget; setOpenMember(sheetId); }}
                    >
                      {sheet === undefined ? <span aria-hidden="true">{initials(name).slice(0, 1)}</span> : <SheetPicture world={world} sheet={sheet} />}
                    </button>
                  );
                })}
                <button type="button" className="fy-sw__tile fy-sw__tile--add" title="Add a character" aria-label="Add a character" aria-haspopup="dialog" disabled={locked} onClick={(event) => { doorFocus.current = event.currentTarget; setPicker("character"); }}>
                  <Plus size={16} />
                </button>
              </div>
              <div className="fy-sw__location">
                {locationName === null ? (
                  <button type="button" className="fy-sw__door" aria-haspopup="dialog" disabled={locked} onClick={(event) => { doorFocus.current = event.currentTarget; setPicker("location"); }}>
                    <Plus size={15} />Add a location
                  </button>
                ) : (
                  <button type="button" className="fy-sw__place" title={locationName} aria-haspopup="dialog" aria-expanded={openPlace !== null} onClick={(event) => { doorFocus.current = event.currentTarget; setOpenPlace(scene.inherits?.location ?? null); }}>
                    <span className="fy-sw__plate" aria-hidden="true">{locationSheet === undefined ? initials(locationName).slice(0, 1) : <SheetPicture world={world} sheet={locationSheet} />}</span>
                    <span className="fy-sw__place-name"><span className="fy-sw__context-label">Location</span><span>{locationName}</span></span>
                  </button>
                )}
              </div>
              <div className="fy-sw__metrics" aria-label="Scene metrics"><span><ImageMark size={16} />{aspect}</span><span><Film size={16} />{shots.length} shot{shots.length === 1 ? "" : "s"}</span><span><Timer size={16} />{seconds(totalSec)}</span></div>
              <details className="fy-sw__details" onKeyDown={(event) => {
                if (event.key !== "Escape" || event.defaultPrevented) return;
                event.currentTarget.open = false;
                event.currentTarget.querySelector("summary")?.focus();
              }}>
                <summary aria-label="Scene details" title="Scene details"><More size={18} /></summary>
                <div className="fy-sw__detailspanel">
                  <span className="fy-sw__context-label">What happens</span>
                  <SceneSynopsis scene={legacySceneView(scene)} onCommit={(synopsis) => write({ kind: "edit-scene", synopsis })} />
                  {scene.inherits?.timeOfDay === undefined ? null : <span>{scene.inherits.timeOfDay}</span>}
                  {scene.inherits?.tone === undefined ? null : <span>{scene.inherits.tone}</span>}
                </div>
              </details>
            </div>
            {lengthFindings.map((finding) => <p key={finding.about} className="fy-mono" data-testid="episode-length-note">{finding.message}</p>)}
            {sceneReviewOpen ? <SceneReview scene={legacySceneView(scene)} onClose={() => setSceneReviewOpen(false)} /> : null}
            {generatorError === null ? null : <p role="alert" className="fy-swboards__refusal">{generatorError}</p>}
          </header>

          {/*
            Tabs are a mode of working, not a rendering of the same thing — so they are a
            radiogroup rather than links: choosing one is a choice about this scene, and it
            must not take the address bar with it or the browser Back button becomes an undo
            for something nobody did.
          */}
          <div className="fy-sw__toolbar">
            <div className="fy-sw__tabs" role="radiogroup" aria-label="View">
              {(["storyboard", "flow", "stage", "preview"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={view === candidate}
                  className="fy-sw__tab"
                  data-on={view === candidate ? "true" : undefined}
                  onClick={() => setView(candidate)}
                >
                  {candidate === "storyboard" ? "Storyboard" : candidate === "flow" ? "Flow" : candidate === "stage" ? "Stage" : "Preview"}
                </button>
              ))}
            </div>
            <span className="fy-sw__spacer" />
            {/*
              A run owns the row (R-4, R-17): the bar stands where the coverage line was, and
              the boards toggle waits until the run has finished.
            */}
            {frameRun !== null ? (
              <FrameRunBar
                run={frameRun}
                worldId={world.meta.worldId}
                productionId={production.meta.id}
                // Review opens the first frame THIS run put down, in the lightbox, to arrow through
                // (R-19): a frame is the run's when one of its own jobs produced the artifact, so a
                // shot whose retry failed over an older frame is never shown as new output, and a
                // run that put down nothing has nothing to review.
                {...(reviewShotId === null ? {} : { onReview: () => setLightboxShotId(reviewShotId) })}
              />
            ) : shots.length === 0 ? null : (
              <span className="fy-sw__coverage" data-ready={framed > 0 || undefined}>
                <span aria-hidden="true" />{framed} of {shots.length} frames ready
              </span>
            )}
            {frameRun === null || frameRun.status === "completed" ? (
              <button
                type="button"
                className="fy-sw__boards-toggle"
                aria-pressed={showBoards}
                title="Group shots into boards that fit the clip limit"
                onClick={() => setShowBoards((shown) => !shown)}
              >
                {showBoards ? "Boards on" : "Show boards"}
              </button>
            ) : null}
            {view === "storyboard" ? (
              <div className="fy-sw__layouts" role="group" aria-label="Storyboard layout">
                {(["list", "grid"] as const).map((layout) => (
                  <button
                    key={layout}
                    type="button"
                    aria-pressed={(boardsVisible ? "list" : storyboardLayout) === layout}
                    disabled={layout === "grid" && frameRun?.run.mode === "board"}
                    // Moving focus would blur and commit the current editor before the layout changes.
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => { setStoryboardLayout(layout); if (layout === "grid") setShowBoards(false); }}
                  >
                    {layout === "list" ? <ListBullet size={14} /> : <Grid2x2 size={14} />}{layout === "list" ? "List" : "Grid"}
                  </button>
                ))}
              </div>
            ) : null}
            {view === "flow" || view === "stage" ? (
              <button type="button" className="fy-sw__full" title="Full screen" aria-label="Full screen" onClick={() => setFull(true)}>
                <Maximize2 size={14} />
              </button>
            ) : null}
          </div>
          {frameRun === null ? null : (
            <FrameRunBoardFailures
              run={frameRun}
              jobs={state?.app.jobs ?? []}
              worldId={world.meta.worldId}
              productionId={production.meta.id}
            />
          )}

          {view === "storyboard" ? (
            <StoryboardRows
              layout={boardsVisible ? "list" : storyboardLayout}
              scene={workingScene}
              acceptedScene={scene}
              world={world}
              production={production}
              artifacts={artifacts}
              sheets={world.sheets}
              slug={world.meta.slug}
              digests={digests}
              aspect={aspect}
              capSec={capSec}
              boardPack={boardPack}
              showBoards={boardsVisible}
              stagedShotIds={stagedShotIds}
              newShotIds={newShotIds}
              stagedBoards={stagedBoards}
              locked={staged !== undefined || sceneFile === undefined || commandPending}
              generatorPending={generatorPending}
              onCommand={write}
              refusalVersion={refusalVersion}
              frameRun={frameRun}
              jobs={state?.app.jobs ?? []}
              worldId={world.meta.worldId}
              onViewBoardSheet={(board: PackedBoard, trigger) => {
                setBoardSheetTrigger(trigger);
                setBoardSheetKey(JSON.stringify(board.memberShotIds));
              }}
              onGenerateFrame={(shotId, trigger) => {
                generateReturnFocus.current = trigger;
                setGenerateTarget({ shotId });
              }}
              onEditShot={(shotId) => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/scenes/${scene.id}/shots/${shotId}`)}
              onOpenShotInGenerator={(shotId) => openGenerator({ kind: "shot", shotId })}
              onOpenCharacter={(sheetId, trigger) => { doorFocus.current = trigger; setOpenMember(sheetId); }}
              locationName={locationName}
              onOpenLocation={(trigger) => { doorFocus.current = trigger; setOpenPlace(scene.inherits?.location ?? null); }}
              onStageShot={openStage}
              onPreviewShot={setLightboxShotId}
              onTalkToArke={talkToArke}
              onPlanVideo={planVideo}
              onRenderBoard={(memberShotIds) => openGenerator({ kind: "board", memberShotIds })}
            />
          ) : view === "flow" ? (
            <SceneFlow
              scene={workingScene}
              production={production}
              sheets={world.sheets}
              artifacts={artifacts}
              slug={world.meta.slug}
              boardPack={boardPack}
              capSec={capSec}
              stagedShotIds={stagedShotIds}
              newShotIds={newShotIds}
              stagedBoards={stagedBoards}
              locked={staged !== undefined || sceneFile === undefined || commandPending}
              onCommand={write}
              generatorPending={generatorPending}
              onOpenShotInGenerator={(shotId) => openGenerator({ kind: "shot", shotId })}
              onOpenCharacter={(sheetId, trigger) => { doorFocus.current = trigger; setOpenMember(sheetId); }}
              onOpenStage={openStage}
              onEditShot={(shotId) => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/scenes/${scene.id}/shots/${shotId}`)}
              onViewBoardSheet={(memberShotIds, trigger) => {
                setBoardSheetTrigger(trigger);
                setBoardSheetKey(JSON.stringify(memberShotIds));
              }}
              onShowBoards={() => {
                setFull(false);
                setShowBoards(true);
                setView("storyboard");
              }}
              onRenderBoard={(memberShotIds) => openGenerator({ kind: "board", memberShotIds })}
              onTalkToArke={talkToArke}
            />
          ) : view === "stage" ? (
            <SceneStage
              scene={workingScene}
              production={production}
              world={world}
              aspect={aspect}
              sceneFile={sceneFile}
              locked={staged !== undefined || sceneFile === undefined || commandPending}
              generatorPending={generatorPending}
              refusalVersion={refusalVersion}
              onCommand={write}
              onRenderShot={(shotId) => openGenerator({ kind: "shot", shotId }, "video")}
              {...(constructionRequest ? { constructionRequest } : {})}
              {...(playblastRequest ? { playblastRequest } : {})}
            />
          ) : (
            <ScenePreview
              key={`${production.meta.id}/${scene.id}`}
              production={production}
              scene={scene}
              artifacts={artifacts}
              boards={acceptedBoardPack.ok ? acceptedBoardPack.boards : []}
              worldId={world.meta.worldId}
              worldSlug={world.meta.slug}
              sheets={world.sheets}
              aspect={aspect}
              onEditShot={(shotId) => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/scenes/${scene.id}/shots/${shotId}`)}
              onOpenShotInGenerator={(shotId) => openGenerator({ kind: "shot", shotId })}
            />
          )}
          <PlansPanel
            worldId={world.meta.worldId}
            prodId={production.meta.id}
            sceneId={scene.id}
            refused={planError}
          />
          <footer className="fy-sw__footer">
            <span className="fy-sw__save" role="status" data-pending={commandPending || staged !== undefined || connection !== "open" || undefined}>
              <span aria-hidden="true" />{connection !== "open" ? "Disconnected" : commandPending ? "Saving…" : staged !== undefined ? "Changes awaiting review" : `Connected · v${scene.version}`}
            </span>
            {episode === undefined ? null : <button type="button" className="fy-sw__back" onClick={() => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/episodes/${episode.id}`)}>Back to episode <span aria-hidden="true">→</span></button>}
          </footer>
        </main>

        {dock ? (
          <ProductionConversation
            worldId={world.meta.worldId}
            productionId={production.meta.id}
            entry={{ kind: "scene", productionId: production.meta.id, sceneId: scene.id }}
            subject={conversationSubject}
            dock={{
              title: dockTitle,
              subject: dockSubject,
              conversationFirst: true,
              ...(thumbnailSrc === null || focused === undefined
                ? {}
                : { thumbnail: { src: thumbnailSrc, alt: `Frame for shot ${focused.number}` } }),
              onPutAway: () => setDock(false),
              // The title flips between the shot in hand and the whole scene (§10 of the notes).
              onToggleSubject: () => {
                if (focused !== undefined) setSubject({ kind: "scene" });
                else if (lastShotSubject.current !== null && workingShots.some((shot) => shot.id === lastShotSubject.current)) {
                  setSubject({ kind: "shot", shotId: lastShotSubject.current as never });
                }
              },
              prompts: focused === undefined
                // A scene begins Untitled (R-37), and the dock is where it gets a name (R-38).
                ? [...(scene.title === "Untitled" ? ["Name this scene"] : []), "What is missing from this scene?", "Which shots need a frame?"]
                : [`Tighten shot ${focused.number}`, `What does shot ${focused.number} need?`],
              shotLabel,
              ...(focused === undefined ? {} : { subjectPrefix: `About shot ${focused.number}:` }),
            }}
            openingNote="opening…"
            emptyLine={`Nothing written with Arke for scene ${scene.number} yet.`}
            placeholder={`Ask Arke about ${focused === undefined ? "this scene" : `shot ${focused.number}`}…`}
            onSelectShot={(shotId) => setSubject({ kind: "shot", shotId })}
            {...(staged === undefined
              ? { pointsEmpty: "Nothing understood yet. As you talk, what Arke takes from the scene appears here." }
              : {
                   side: (
                     <>
                      <StagedDecision
                        worldId={world.meta.worldId}
                        subject={`scene ${scene.number}`}
                        staged={staged}
                        items={[
                          ...workingShots
                            .filter((shot) => stagedShotIds.has(shot.id))
                            .map((shot) => ({ label: `Shot ${shot.number} · ${shot.title}`, meta: newShotIds.has(shot.id) ? "new" : "changed" })),
                          ...removedShots.map((shot) => ({ label: `Shot ${shot.number} · ${shot.title}`, meta: "remove" })),
                        ]}
                      />
                    </>
                  ),
                })}
          />
        ) : (
          // Put away, the assistant leaves a slim rail: a way back, and the word that it is here.
          <button type="button" className="fy-sw__rail" title="Pin the assistant back" onClick={() => setDock(true)}>
            <span className="fy-sw__rail-dot" aria-hidden="true" />
            <span className="fy-sw__rail-label">Ask Arke</span>
            <span className="fy-sw__rail-pin"><Pin size={13} /></span>
          </button>
        )}
        <GenerateFramesDialog
          open={generateTarget !== null}
          state={state}
          world={world}
          production={production}
          scene={scene}
          aspect={aspect}
          videoModel={videoModel}
          {...(generateTarget?.shotId === undefined ? {} : { shotId: generateTarget.shotId })}
          returnFocus={generateReturnFocus}
          onClose={() => setGenerateTarget(null)}
          onStarted={() => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/cut?assemble=${scene.id}`)}
        />
        {openMember === null ? null : (
          <CharacterDialog
            key={openMember}
            world={world}
            production={production}
            scene={scene}
            sheetId={openMember}
            locked={locked}
            onClose={closeDoor}
            onWrite={write}
          />
        )}
        {/* Held by the place's id: a place that leaves under the dialog takes the dialog with it. */}
        {openPlace !== null && openPlace === scene.inherits?.location ? (
          <LocationDialog
            world={world}
            production={production}
            scene={scene}
            onClose={closeDoor}
            // Change location is the picker in its third title (R-19); the dialog steps aside
            // for it and the door's focus comes back when the picker closes.
            onChangeLocation={() => { setOpenPlace(null); setPicker("change-location"); }}
          />
        ) : null}
        {picker === null ? null : (
          <CastPicker
            world={world}
            production={production}
            scene={scene}
            mode={picker}
            onPick={(sheetId) => {
              // A press adds and closes (R-4): a member with the time it was added, or the place.
              // A write the page refuses — a proposal staged, a command in flight — leaves the
              // picker open rather than closing on nothing.
              const sent = write(picker === "character"
                ? { kind: "edit-scene", cast: { [sheetId]: { added: new Date().toISOString() } } }
                : { kind: "edit-scene", inherits: { location: sheetId } });
              if (sent) closeDoor();
            }}
            onClose={closeDoor}
          />
        )}
        <ShotLightbox
          scene={scene}
          production={production}
          artifacts={artifacts}
          worldSlug={world.meta.slug}
          aspect={aspect}
          shotId={lightboxShotId}
          onClose={() => setLightboxShotId(null)}
          onSelectShot={(shotId) => {
            setLightboxShotId(shotId);
            setSubject({ kind: "shot", shotId: shotId as never });
          }}
          onEditShot={(shotId) => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/scenes/${scene.id}/shots/${shotId}`)}
          onOpenInGenerator={(shotId) => openGenerator({ kind: "shot", shotId })}
        />
        <BoardSheet
          board={selectedBoard}
          scene={workingScene}
          production={production}
          artifacts={artifacts}
          runs={sceneRuns}
          aspect={aspect}
          capSec={capSec}
          worldId={world.meta.worldId}
          worldSlug={world.meta.slug}
          returnFocus={boardSheetTrigger}
          onClose={() => setBoardSheetKey(null)}
        />
      </div>
    </SelectionProvider>
  );
}

/** The first shot, in run order, that one of the run's OWN jobs put a frame on — or null when it put down none. */
function firstProducedShot(run: FrameRunState, artifacts: readonly ArtifactSidecar[]): string | null {
  const jobs = new Set(run.run.steps.flatMap((step) => (step.jobId === null ? [] : [`frame-run:${step.jobId}`])));
  return (
    run.run.steps
      .flatMap((step) => step.updateShotIds)
      .find((shotId) =>
        artifacts.some(
          (artifact) =>
            artifact.kind === "image" && artifact.origin.by === "system" && jobs.has(artifact.origin.producedBy) && artifact.links.includes(shotId),
        ),
      ) ?? null
  );
}
