import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  orderedShots,
  writerSceneView,
  type ClientMessage,
  type ArtifactSidecar,
  type PackedBoard,
  type ProductionBundle,
  type SceneRecord,
  type WorldBundle,
} from "@arke-studio/contracts";
import { productionModel, resolveModel } from "../../components/dispatch-bar.js";
import { seconds } from "../../lib/format.js";
import {
  frameRunCommand,
  sceneCommand,
  sendBenchOpenSubject,
  subscribeBenchSubjectOpened,
  subscribeSceneRefusals,
  useClientState,
  useStore,
} from "../../lib/store.js";
import { StagedDecision } from "../../components/conversation.js";
import { SceneReview, useBlockDigests } from "../storyboard.js";
import { SceneFlow } from "./flow.js";
import { StoryboardRows } from "./rows.js";
import { SceneIndex } from "./scene-index.js";
import { SelectionProvider, selectedShotId, type WorkspaceSubject } from "./selection.js";
import { boardsForScene, shotHasFrame } from "./boards.js";
import { FrameRunBar, FrameRunBoardFailures, FrameRunReview, GenerateFramesDialog } from "./frame-run.js";
import { Button } from "../../components/ui.js";
import { BoardSheet } from "./board-sheet.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];

/**
 * The scene authoring shell (SPEC-029 R-21..R-29). The rollout setting mounts it for the whole
 * scene; retired generation links can opt into it directly while that rollout is still staged.
 *
 * `scene index | Storyboard or Flow | Arke` — the three columns turn 103 binds, with Storyboard
 * the default. Read-only at this step: it lands where it can be walked before it replaces the
 * horizontal strip, and every write arrives with the editing step.
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
  const digests = useBlockDigests(writerSceneView(scene));
  const [view, setView] = useState<"storyboard" | "flow">("storyboard");
  const [showBoards, setShowBoards] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [sceneReviewOpen, setSceneReviewOpen] = useState(false);
  const [boardSheetKey, setBoardSheetKey] = useState<string | null>(null);
  const [boardSheetTrigger, setBoardSheetTrigger] = useState<HTMLElement | null>(null);
  const [refusalVersion, setRefusalVersion] = useState(0);
  const [commandPending, setCommandPending] = useState(false);
  const [generatorPending, setGeneratorPending] = useState(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  const pendingCommand = useRef(false);
  const sceneKey = `${world.meta.worldId}/${production.meta.id}/${scene.id}`;
  const currentSceneKey = useRef(sceneKey);
  currentSceneKey.current = sceneKey;
  const pendingGenerator = useRef<{ requestId: string; sceneKey: string } | null>(null);
  const generateButton = useRef<HTMLButtonElement>(null);
  // Arke can be put away (R-28). Local to the session rather than a setting: it is a gesture
  // about right now — "give me the width" — not a preference about how the app should be.
  const [dock, setDock] = useState(true);
  const linkedShotId = searchParams.get("shot");
  const [subject, setSubject] = useState<WorkspaceSubject>(() =>
    linkedShotId !== null && orderedShots(scene).some((shot) => shot.id === linkedShotId)
      ? { kind: "shot", shotId: linkedShotId as never }
      : { kind: "scene" },
  );
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
  const totalSec = shots.reduce((sum, shot) => sum + (shot.durationSec ?? 0), 0);
  const framed = shots.filter((shot) => shotHasFrame(production, artifacts, shot.id)).length;
  const focus = selectedShotId(subject);
  const focused = focus === null ? undefined : shots.find((shot) => shot.id === focus);
  const sceneRuns = [...(state?.frameRuns ?? [])]
    .filter((candidate) =>
      candidate.worldId === world.meta.worldId &&
      candidate.productionId === production.meta.id &&
      candidate.run.sceneId === scene.id)
    .sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt));
  const visibleSceneRuns = sceneRuns.filter((candidate) => candidate.run.dismissed !== true);
  const frameRun = visibleSceneRuns.find((candidate) => candidate.status === "active" || candidate.status === "paused") ?? visibleSceneRuns[0] ?? null;
  const boardsVisible = showBoards || frameRun?.run.mode === "board";
  const selectedBoard = boardSheetKey === null || !boardPack.ok
    ? null
    : boardPack.boards.find((board) => JSON.stringify(board.memberShotIds) === boardSheetKey) ?? null;
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
  const subjectLine =
    subject.kind === "edge"
      ? `Arke · Edge ${subject.fromShotId ?? "Entry"} to ${subject.toShotId ?? "Exit"}`
      : focused === undefined
        ? `Arke · Scene ${scene.number}`
        : `Arke · Shot ${focused.number}`;

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
  const openGenerator = (subject: Extract<ClientMessage, { kind: "bench-open-subject" }>["subject"]) => {
    if (pendingGenerator.current !== null) return;
    const requestId = sendBenchOpenSubject({
      worldId: world.meta.worldId,
      productionId: production.meta.id,
      sceneId: scene.id,
      subject,
    });
    if (requestId !== null) {
      pendingGenerator.current = { requestId, sceneKey };
      setGeneratorPending(true);
      setGeneratorError(null);
    } else {
      setGeneratorError("Not connected - try again.");
    }
  };
  useEffect(() => {
    // Scene Index reuses this component. A response belongs to the scene that sent it and must
    // not navigate back from a newer scene or leave that newer scene's actions blocked.
    pendingGenerator.current = null;
    setGeneratorPending(false);
    setGeneratorError(null);
  }, [world.meta.worldId, production.meta.id, scene.id]);
  useEffect(() => {
    frameRunCommand({ kind: "frame-run-list", worldId: world.meta.worldId, productionId: production.meta.id });
  }, [world.meta.worldId, production.meta.id]);

  return (
    <SelectionProvider value={selection}>
      <div className="fy-sw" data-screen="scene-detail" data-testid="scene-workspace" data-dock={dock ? "true" : "false"}>
        <SceneIndex
          production={production}
          artifacts={artifacts}
          currentSceneId={scene.id}
          onOpen={(sceneId) => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/scenes/${sceneId}`)}
        />

        <main className="fy-sw__centre">
          <header className="fy-sw__head">
            <div className="fy-sw__headline">
              <div>
                <h1 className="fy-sw__title">
                  Scene {scene.number} · {scene.title}
                </h1>
                <p className="fy-sw__metrics">
                  {shots.length} shots · {seconds(totalSec)} · {framed} frames filed
                </p>
              </div>
              <div className="fy-sw__actions">
                <Button variant="outline" onClick={() => setSceneReviewOpen((open) => !open)}>Review scene</Button>
                <Button ref={generateButton} variant="primary" disabled={frameRun?.status === "active" || frameRun?.status === "paused"} onClick={() => setGenerateOpen(true)}>Generate frames</Button>
              </div>
            </div>
            {sceneReviewOpen ? <SceneReview scene={writerSceneView(scene)} onClose={() => setSceneReviewOpen(false)} /> : null}
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
              {(["storyboard", "flow"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={view === candidate}
                  className="fy-sw__tab"
                  data-on={view === candidate ? "true" : undefined}
                  onClick={() => setView(candidate)}
                >
                  {candidate === "storyboard" ? "Storyboard" : "Flow"}
                </button>
              ))}
            </div>
            {frameRun !== null ? (
              <FrameRunBar
                run={frameRun}
                worldId={world.meta.worldId}
                productionId={production.meta.id}
                onReview={() => setReviewOpen(true)}
              />
            ) : (
              <>
                <span className="fy-sw__coverage">
                  {shots.length - framed} of {shots.length} without a frame
                </span>
                <button
                  type="button"
                  className="fy-sw__boards-toggle"
                  aria-pressed={showBoards}
                  onClick={() => setShowBoards((shown) => !shown)}
                >
                  {showBoards ? "Hide boards" : "Show boards"}
                </button>
              </>
            )}
            <button
              type="button"
              className="fy-sw__put"
              aria-pressed={!dock}
              onClick={() => setDock((on) => !on)}
            >
              {dock ? "Hide Arke" : "Show Arke"}
            </button>
          </div>
          {frameRun === null ? null : <FrameRunBoardFailures run={frameRun} worldId={world.meta.worldId} productionId={production.meta.id} />}

          {view === "storyboard" ? (
            <StoryboardRows
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
              worldId={world.meta.worldId}
              onViewBoardSheet={(board: PackedBoard, trigger) => {
                setBoardSheetTrigger(trigger);
                setBoardSheetKey(JSON.stringify(board.memberShotIds));
              }}
              onOpenShotInGenerator={(shotId) => openGenerator({ kind: "shot", shotId })}
              onRenderBoard={(memberShotIds) => openGenerator({ kind: "board", memberShotIds })}
            />
          ) : (
            <SceneFlow
              scene={workingScene}
              production={production}
              sheets={world.sheets}
              artifacts={artifacts}
              slug={world.meta.slug}
              boardPack={boardPack}
              stagedShotIds={stagedShotIds}
              newShotIds={newShotIds}
              stagedBoards={stagedBoards}
              locked={staged !== undefined || sceneFile === undefined || commandPending}
              onCommand={write}
              generatorPending={generatorPending}
              onOpenShotInGenerator={(shotId) => openGenerator({ kind: "shot", shotId })}
              onRenderBoard={(memberShotIds) => openGenerator({ kind: "board", memberShotIds })}
            />
          )}
        </main>

        {/*
          Arke's dock follows the selection and nothing else — there is no "ask Arke to look at
          this" action, because the thing being looked at is the thing that is selected. The
          thread itself arrives with the dock's own step; this is the subject line it will read.
        */}
        {dock ? (
        <aside className="fy-sw__dock" aria-label="Arke">
          <p className="fy-sw__subject" data-testid="workspace-subject">
            {subjectLine}
          </p>
          {staged === undefined ? null : (
            <>
              {removedShots.length === 0 ? null : (
                <div className="fy-swproposal__removes">
                  <span>Removes</span>
                  {removedShots.map((shot) => <span key={shot.id}>Shot {shot.number} · {shot.title}</span>)}
                </div>
              )}
              <StagedDecision
                worldId={world.meta.worldId}
                subject={`scene ${scene.number}`}
                staged={staged}
                writes="Updates this scene and its board boundaries."
              />
            </>
          )}
        </aside>
        ) : null}
        <GenerateFramesDialog
          open={generateOpen}
          state={state}
          world={world}
          production={production}
          scene={scene}
          aspect={aspect}
          videoModel={videoModel}
          returnFocus={generateButton}
          onClose={() => setGenerateOpen(false)}
        />
        {frameRun === null ? null : (
          <FrameRunReview
            run={frameRun}
            scene={scene}
            artifacts={artifacts}
            worldSlug={world.meta.slug}
            open={reviewOpen}
            onClose={() => setReviewOpen(false)}
          />
        )}
        <BoardSheet
          board={selectedBoard}
          scene={workingScene}
          production={production}
          artifacts={artifacts}
          runs={sceneRuns}
          aspect={aspect}
          worldId={world.meta.worldId}
          worldSlug={world.meta.slug}
          returnFocus={boardSheetTrigger}
          onClose={() => setBoardSheetKey(null)}
        />
      </div>
    </SelectionProvider>
  );
}
