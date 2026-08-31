import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  DEFAULT_SHOT_SEC,
  orderedShots,
  legacySceneView,
  type ClientMessage,
  type ArtifactSidecar,
  type PackedBoard,
  type ProductionBundle,
  type SceneRecord,
  type WorldBundle,
} from "@arke-studio/contracts";
import { productionModel, resolveModel } from "../../components/dispatch-bar.js";
import { seconds } from "../../lib/format.js";
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
import { SceneReview, SceneSynopsis, useBlockDigests } from "../storyboard.js";
import { SceneFlow } from "./flow.js";
import { StoryboardRows } from "./rows.js";
import { SelectionProvider, selectedShotId, subjectMatchesBoard, type WorkspaceSubject } from "./selection.js";
import { boardsForScene, shotHasFrame } from "./boards.js";
import { FrameRunBar, FrameRunBoardFailures, FrameRunReview, GenerateFramesDialog } from "./frame-run.js";
import { Button } from "../../components/ui.js";
import { BoardSheet } from "./board-sheet.js";
import { ScenePreview } from "./preview.js";
import { sceneIsComplete } from "./completion.js";
import { PlansPanel } from "./plans.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];

/**
 * The scene authoring shell (SPEC-029 R-21..R-29), mounted for every scene detail route.
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
  const digests = useBlockDigests(legacySceneView(scene));
  const [view, setView] = useState<"storyboard" | "flow" | "preview">("storyboard");
  const [showBoards, setShowBoards] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [generateTarget, setGenerateTarget] = useState<{ shotId?: string } | null>(null);
  const [sceneReviewOpen, setSceneReviewOpen] = useState(false);
  const [boardSheetKey, setBoardSheetKey] = useState<string | null>(null);
  const [boardSheetTrigger, setBoardSheetTrigger] = useState<HTMLElement | null>(null);
  const [refusalVersion, setRefusalVersion] = useState(0);
  const [commandPending, setCommandPending] = useState(false);
  const [generatorPending, setGeneratorPending] = useState(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
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
  const totalSec = shots.reduce((sum, shot) => sum + (shot.durationSec ?? DEFAULT_SHOT_SEC), 0);
  const framed = shots.filter((shot) => shotHasFrame(production, artifacts, shot.id)).length;
  const focus = selectedShotId(subject);
  const focused = focus === null ? undefined : workingShots.find((shot) => shot.id === focus);
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
  const subjectBoard = subject.kind !== "board" || !boardPack.ok
    ? null
    : boardPack.boards.find((board) => subjectMatchesBoard(subject, board.memberShotIds)) ?? null;
  const episode = production.episodes.find((candidate) => candidate.scenes.includes(scene.id));
  const complete = sceneIsComplete(scene, production, artifacts, digests);
  const locationName = scene.inherits?.location === undefined
    ? null
    : world.sheets.find((sheet) => sheet.id === scene.inherits?.location)?.name ?? scene.inherits.location;
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
  const planVideo = () => {
    if (pendingPlan.current !== null || sceneFile === undefined || videoModel == null) return;
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
      <div className="fy-sw" data-screen="scene-detail" data-testid="scene-workspace" data-dock={dock ? "true" : "false"}>
        <main className="fy-sw__centre">
          <header className="fy-sw__head">
            <p className="fy-sw__breadcrumb">
              {production.meta.title}
              {episode === undefined ? ` · scene ${scene.number}` : ` · episode ${episode.order} · ${episode.title}`}
            </p>
            <div className="fy-sw__headline">
              <h1 className="fy-sw__title">
                Scene {scene.number} · {scene.title}
              </h1>
              <div className="fy-sw__actions">
                <Button variant="outline" onClick={() => setSceneReviewOpen((open) => !open)}>Review scene</Button>
                <Button
                  variant="primary"
                  disabled={frameRun?.status === "active" || frameRun?.status === "paused"}
                  onClick={(event) => {
                    generateReturnFocus.current = event.currentTarget;
                    setGenerateTarget({});
                  }}
                >
                  Generate frames
                </Button>
              </div>
            </div>
            <SceneSynopsis
              scene={legacySceneView(scene)}
              onCommit={(synopsis) => write({ kind: "edit-scene", synopsis })}
            />
            <div className="fy-sw__context" aria-label="Scene context">
              {locationName === null ? null : <span>{locationName}</span>}
              {scene.inherits?.timeOfDay === undefined ? null : <span>{scene.inherits.timeOfDay}</span>}
              {scene.inherits?.tone === undefined ? null : <span>{scene.inherits.tone}</span>}
              <span>{aspect}</span>
              <span className="fy-sw__metrics">{shots.length} shots · {seconds(totalSec)} · {framed} frames filed</span>
            </div>
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
              {(["storyboard", "flow", "preview"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={view === candidate}
                  className="fy-sw__tab"
                  data-on={view === candidate ? "true" : undefined}
                  onClick={() => setView(candidate)}
                >
                  {candidate === "storyboard" ? "Storyboard" : candidate === "flow" ? "Flow" : "Preview"}
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
              onGenerateFrame={(shotId, trigger) => {
                generateReturnFocus.current = trigger;
                setGenerateTarget({ shotId });
              }}
              onEditShot={(shotId) => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/scenes/${scene.id}/shots/${shotId}`)}
              onOpenShotInGenerator={(shotId) => openGenerator({ kind: "shot", shotId })}
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
              stagedShotIds={stagedShotIds}
              newShotIds={newShotIds}
              stagedBoards={stagedBoards}
              locked={staged !== undefined || sceneFile === undefined || commandPending}
              onCommand={write}
              generatorPending={generatorPending}
              onOpenShotInGenerator={(shotId) => openGenerator({ kind: "shot", shotId })}
              onRenderBoard={(memberShotIds) => openGenerator({ kind: "board", memberShotIds })}
            />
          ) : (
            <ScenePreview
              key={`${production.meta.id}/${scene.id}`}
              production={production}
              scene={scene}
              artifacts={artifacts}
              boards={acceptedBoardPack.ok ? acceptedBoardPack.boards : []}
              worldSlug={world.meta.slug}
              aspect={aspect}
            />
          )}
          <PlansPanel
            worldId={world.meta.worldId}
            prodId={production.meta.id}
            sceneId={scene.id}
            refused={planError}
          />
          {complete && episode !== undefined ? (
            <button
              type="button"
              className="fy-sw__done"
              onClick={() => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/episodes/${episode.id}`)}
            >
              Done · back to the episode
            </button>
          ) : null}
        </main>

        {dock ? (
          <ProductionConversation
            worldId={world.meta.worldId}
            productionId={production.meta.id}
            entry={{ kind: "scene", productionId: production.meta.id, sceneId: scene.id }}
            dock={{
              title: dockTitle,
              subject: dockSubject,
              ...(thumbnailSrc === null || focused === undefined
                ? {}
                : { thumbnail: { src: thumbnailSrc, alt: `Frame for shot ${focused.number}` } }),
            }}
            openingNote="opening…"
            emptyLine={`Nothing written with Arke for scene ${scene.number} yet.`}
            placeholder="Ask about this scene · @ to reference"
            onSelectShot={(shotId) => setSubject({ kind: "shot", shotId })}
            {...(staged === undefined
              ? { pointsEmpty: "Nothing understood yet. As you talk, what Arke takes from the scene appears here." }
              : {
                  side: (
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
                  ),
                })}
          />
        ) : null}
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
