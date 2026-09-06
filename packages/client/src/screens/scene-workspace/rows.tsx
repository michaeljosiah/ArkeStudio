import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  assemblePrompt,
  assembleBoardPrompt,
  boardPromptFor,
  DEFAULT_SHOT_SEC,
  orderedShots,
  productionShape,
  promptFor,
  resolveCast,
  shotCardState,
  shotCoverage,
  type ArtifactSidecar,
  type BenchSessionSummary,
  type ClientMessage,
  type FrameRunState,
  type Job,
  type PackedBoard,
  type ProductionBundle,
  type SceneRecord,
  type Sheet,
  type Shot,
  type ShotCardState,
  type WorldBundle,
} from "@arke-studio/contracts";
import { mediaUrl } from "../../lib/media.js";
import { acceptedTakeId, takesForShot } from "../../lib/selectors.js";
import { shotHasFrame, type WorkspaceBoardPack } from "./boards.js";
import { selectedShotId, subjectMatchesBoard, useWorkspaceSelection } from "./selection.js";
import { acceptTake, clearShotFrame, frameRunCommand, importShotFrame, retryJobFinalization } from "../../lib/store.js";
import { finalizationRetryJobId, frameRunShotState } from "./frame-run.js";
import { BenchBrief } from "../../components/bench-brief.js";
import { ReadAloudButton } from "../../components/read-aloud.js";
import { Grid2x2, Grip, ImageMark, Lines, More, Plus } from "../../components/icons.js";
import { characterPortraitPath, locationPortraitPath, Portrait } from "../../components/portrait.js";
import { Button } from "../../components/ui.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];

const CHIP: Record<ShotCardState, string> = {
  "needs attention": "needs attention",
  story: "story",
  storyboard: "storyboard",
  "production-ready": "production-ready",
  rendered: "rendered",
};

const UPLOAD_UNAVAILABLE = "Upload is available in the desktop app";

export function waitingTakeSessions(
  sessions: readonly BenchSessionSummary[],
  productionId: string,
  sceneId: string,
  shotId: string,
): BenchSessionSummary[] {
  return sessions.filter((summary) => {
    const subject = summary.subject;
    return summary.waitingCount > 0 &&
      subject?.kind === "shot" &&
      subject.productionId === productionId &&
      subject.sceneId === sceneId &&
      subject.shotId === shotId;
  });
}

export function WaitingTakeLinks({ sessions, worldId }: { sessions: readonly BenchSessionSummary[]; worldId: string }) {
  if (sessions.length === 0) return null;
  return (
    <div className="fy-swrow__waiting">
      {sessions.map((summary) => (
        <a
          key={summary.id}
          href={`#/w/${worldId}/artifacts/bench/${summary.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          {summary.waitingCount} take{summary.waitingCount === 1 ? "" : "s"} waiting{" "}
          <span>· {summary.mode}</span>
        </a>
      ))}
    </div>
  );
}

function canPickFiles(): boolean {
  return typeof window !== "undefined" && window.arke !== undefined;
}

export function StoryboardRows({
  scene,
  acceptedScene,
  world,
  production,
  artifacts,
  sheets,
  slug,
  digests,
  aspect,
  capSec,
  boardPack,
  showBoards,
  stagedShotIds,
  newShotIds,
  stagedBoards,
  locked,
  generatorPending,
  onCommand,
  refusalVersion,
  frameRun,
  jobs,
  worldId,
  onViewBoardSheet,
  onGenerateFrame,
  onEditShot,
  onOpenShotInGenerator,
  onStageShot,
  onPreviewShot,
  onTalkToArke,
  onPlanVideo,
  onRenderBoard,
}: {
  scene: SceneRecord;
  acceptedScene: SceneRecord;
  world: WorldBundle;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  sheets: readonly Sheet[];
  slug: string | undefined;
  digests: ReadonlyMap<string, string>;
  aspect: string;
  capSec: number;
  boardPack: WorkspaceBoardPack;
  showBoards: boolean;
  stagedShotIds: ReadonlySet<string>;
  newShotIds: ReadonlySet<string>;
  stagedBoards: boolean;
  locked: boolean;
  generatorPending: boolean;
  onCommand: (command: Command) => boolean;
  refusalVersion: number;
  frameRun: FrameRunState | null;
  jobs: readonly Job[];
  worldId: string;
  onViewBoardSheet: (board: PackedBoard, trigger: HTMLElement) => void;
  onGenerateFrame: (shotId: string, trigger: HTMLButtonElement) => void;
  onEditShot: (shotId: string) => void;
  onOpenShotInGenerator: (shotId: string) => void;
  onStageShot: (shotId: string) => void;
  onPreviewShot: (shotId: string) => void;
  onTalkToArke: () => void;
  onPlanVideo: () => void;
  onRenderBoard: (memberShotIds: string[]) => void;
}) {
  const shots = orderedShots(scene);
  const { subject, select } = useWorkspaceSelection();
  const current = selectedShotId(subject);
  const rowBands = useRef(new Map<string, HTMLDivElement>());
  const rowsRoot = useRef<HTMLDivElement | HTMLOListElement | null>(null);
  const rowsOwnFocus = useRef(false);
  const focusedShotId = useRef<string | null>(null);
  const deleteDialogShotId = useRef<string | null>(null);
  const confirmedDeleteShotId = useRef<string | null>(null);
  const previousShotIds = useRef(orderedShots(acceptedScene).map((shot) => shot.id));
  const [dragShot, setDragShot] = useState<string | null>(null);
  const [dragBoundary, setDragBoundary] = useState<string | null>(null);
  const boards = boardPack.ok ? boardPack.boards : [];
  const boardAt = new Map(boards.map((board) => [board.memberShotIds[0]!, board]));
  const shotIdentity = shots.map((shot) => shot.id).join("\u0000");
  const stagedIdentity = shots.filter((shot) => stagedShotIds.has(shot.id)).map((shot) => shot.id).join("\u0000");
  const boardIdentity = boards.map((board) => board.memberShotIds.join("\u0000")).join("\u0001");

  useLayoutEffect(() => {
    const currentIds = shots.map((shot) => shot.id);
    const currentSet = new Set(currentIds);
    const available = (shotId: string | null): shotId is string =>
      shotId !== null && currentSet.has(shotId) && !stagedShotIds.has(shotId);
    const unavailable = (shotId: string | null): shotId is string => shotId !== null && !available(shotId);
    const replacementFor = (shotId: string): string | null => {
      const acceptedIds = orderedShots(acceptedScene).map((shot) => shot.id);
      const basis = previousShotIds.current.includes(shotId) ? previousShotIds.current : acceptedIds;
      const index = basis.indexOf(shotId);
      const candidates = index < 0
        ? currentIds
        : [...basis.slice(index + 1), ...basis.slice(0, index).reverse(), ...currentIds];
      return candidates.find((candidate, at) => available(candidate) && candidates.indexOf(candidate) === at) ?? null;
    };
    const focusFrom = unavailable(confirmedDeleteShotId.current)
      ? confirmedDeleteShotId.current
      : unavailable(deleteDialogShotId.current)
        ? deleteDialogShotId.current
        : rowsOwnFocus.current && unavailable(focusedShotId.current)
          ? focusedShotId.current
          : null;

    if (focusFrom !== null) {
      const replacement = replacementFor(focusFrom);
      select(replacement === null ? { kind: "scene" } : { kind: "shot", shotId: replacement });
      focusedShotId.current = replacement;
      rowsOwnFocus.current = true;
      if (confirmedDeleteShotId.current === focusFrom) confirmedDeleteShotId.current = null;
      if (deleteDialogShotId.current === focusFrom) deleteDialogShotId.current = null;
      requestAnimationFrame(() => {
        const target = replacement === null ? rowsRoot.current : rowBands.current.get(replacement);
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    } else if (subject.kind === "shot" && !available(subject.shotId)) {
      const replacement = replacementFor(subject.shotId);
      select(replacement === null ? { kind: "scene" } : { kind: "shot", shotId: replacement });
    } else if (subject.kind === "board" && !boards.some((board) => subjectMatchesBoard(subject, board.memberShotIds))) {
      const replacement = boards.find((board) => board.memberShotIds.some((shotId) => subject.memberShotIds.includes(shotId)));
      select(replacement === undefined ? { kind: "scene" } : { kind: "board", memberShotIds: [...replacement.memberShotIds] });
    }
    previousShotIds.current = currentIds;
  }, [acceptedScene, boardIdentity, select, shotIdentity, shots, stagedIdentity, stagedShotIds, subject, boards]);
  useEffect(() => {
    confirmedDeleteShotId.current = null;
  }, [refusalVersion]);
  // The readiness line counts what the design's does: blank scripts and scripts a frame no longer
  // covers. Both are the row's own `needs attention` and `script changed` reads, so the footer can
  // never say ready while a row above it is asking for a look.
  const attention = shots.filter((shot) => shot.description.trim() === "" || shotCoverage(shot, digests) === "changed").length;

  if (shots.length === 0) {
    return (
      <div ref={(element) => { rowsRoot.current = element; }} className="fy-sw__empty" data-testid="workspace-empty" tabIndex={-1}>
        <div>
          <h2>Build this scene</h2>
          <p>Tell Arke what happens, or start adding shots yourself. Nothing here needs the assistant.</p>
          <div>
            <Button variant="primary" size="sm" onClick={onTalkToArke}>Talk to Arke</Button>
            <Button
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() =>
                onCommand({
                  kind: "insert-shot",
                  at: { atStart: true },
                  shot: { title: "Untitled shot", description: "" },
                })
              }
            >
              Add first shot
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {!boardPack.ok ? <p className="fy-swboards__refusal">{boardPack.reason}</p> : null}
      <ol
        ref={(element) => { rowsRoot.current = element; }}
        className="fy-swrows"
        data-testid="workspace-rows"
        aria-label={`Shots in scene ${scene.number}`}
        tabIndex={-1}
        onFocusCapture={(event) => {
          rowsOwnFocus.current = true;
          focusedShotId.current = (event.target as Element).closest<HTMLElement>(".fy-swrow__band")?.dataset.shotId ?? null;
        }}
        onBlurCapture={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          rowsOwnFocus.current = false;
        }}
      >
        {shots.map((shot, index) => {
          const board = boardAt.get(shot.id);
          const runState = frameRunShotState(frameRun, shot.id);
          const retryFinalizationId = runState === null || frameRun === null || frameRun.run.mode === "board"
            ? null
            : finalizationRetryJobId(frameRun, runState.stepIndex, jobs);
          return (
            <li key={shot.id} className="fy-swrow" data-testid={`workspace-row-${shot.id}`}>
              {showBoards && board !== undefined ? (
                <BoardBand
                  board={board}
                  scene={scene}
                  world={world}
                  shots={shots}
                  capSec={capSec}
                  aspect={aspect}
                  locked={locked}
                  generatorPending={generatorPending}
                  staged={stagedBoards || board.memberShotIds.some((id) => stagedShotIds.has(id))}
                  movable={board.reason !== null && board.reason !== "clip limit" && board.reason !== "panel limit"}
                  refusalVersion={refusalVersion}
                  selected={subjectMatchesBoard(subject, board.memberShotIds)}
                  onSelect={() => select({ kind: "board", memberShotIds: [...board.memberShotIds] })}
                  onCommand={onCommand}
                  onDragStart={() => setDragBoundary(shot.id)}
                  onDragEnd={() => setDragBoundary(null)}
                  onViewBoardSheet={onViewBoardSheet}
                  onRender={() => onRenderBoard([...board.memberShotIds])}
                  onPlanVideo={onPlanVideo}
                />
              ) : null}
              {/* The insert line sits between a band and its first card, the way the design draws it,
                  so a board's header is never separated from the row it heads. */}
              {index > 0 ? (
                <Divider
                  shot={shot}
                  showBoards={showBoards}
                  canSplit={!boardAt.has(shot.id)}
                  locked={locked}
                  dragBoundary={dragBoundary}
                  onInsert={() =>
                    onCommand({
                      kind: "insert-shot",
                      at: { before: shot.id },
                      shot: { title: "Untitled shot", description: "" },
                    })
                  }
                  onSplit={() => onCommand({ kind: "set-board-override", shotId: shot.id, override: "split" })}
                  onMoveBoundary={() => {
                    if (dragBoundary !== null) {
                      onCommand({ kind: "move-board-boundary", fromShotId: dragBoundary, toShotId: shot.id });
                      setDragBoundary(null);
                    }
                  }}
                />
              ) : null}
              <Row
                shot={shot}
                prevShotId={shots[shots.indexOf(shot) - 1]?.id ?? null}
                nextShotId={shots[shots.indexOf(shot) + 1]?.id ?? null}
                scene={scene}
                world={world}
                production={production}
                artifacts={artifacts}
                sheets={sheets}
                slug={slug}
                digests={digests}
                aspect={aspect}
                selected={shot.id === current}
                staged={stagedShotIds.has(shot.id)}
                newShot={newShotIds.has(shot.id)}
                locked={locked}
                generatorPending={generatorPending}
                onSelect={() => select({ kind: "shot", shotId: shot.id })}
                onBand={(element) => {
                  if (element === null) rowBands.current.delete(shot.id);
                  else rowBands.current.set(shot.id, element);
                }}
                onCommand={onCommand}
                onDelete={() => {
                  confirmedDeleteShotId.current = shot.id;
                  const accepted = onCommand({ kind: "delete-shot", shotId: shot.id });
                  if (!accepted) confirmedDeleteShotId.current = null;
                  return accepted;
                }}
                onDeleteDialogOpen={() => { deleteDialogShotId.current = shot.id; }}
                onDeleteDialogClose={() => {
                  if (deleteDialogShotId.current === shot.id) deleteDialogShotId.current = null;
                }}
                onDragStart={() => setDragShot(shot.id)}
                onDragEnd={() => setDragShot(null)}
                onDrop={() => {
                  if (dragShot !== null && dragShot !== shot.id) {
                    onCommand({ kind: "move-shot", shotId: dragShot, to: { before: shot.id } });
                    setDragShot(null);
                  }
                }}
                refusalVersion={refusalVersion}
                runState={runState}
                run={frameRun}
                onRetryFinalization={retryFinalizationId === null ? null : () => retryJobFinalization(retryFinalizationId)}
                worldId={worldId}
                onGenerateFrame={(trigger) => onGenerateFrame(shot.id, trigger)}
                onEdit={() => onEditShot(shot.id)}
                onOpenInGenerator={() => onOpenShotInGenerator(shot.id)}
                onStage={() => onStageShot(shot.id)}
                onPreview={() => onPreviewShot(shot.id)}
              />
            </li>
          );
        })}
        <li className="fy-swaddshot">
          <button
            type="button"
            disabled={locked}
            onClick={() =>
              onCommand({
                kind: "insert-shot",
                // An empty scene is a valid one; its first shot has nothing to follow.
                at: shots.length === 0 ? { atStart: true } : { after: shots.at(-1)!.id },
                shot: { title: "Untitled shot", description: "" },
              })
            }
          >
            <span className="fy-swaddshot__ring" aria-hidden="true"><Plus size={12} /></span>
            Add shot
          </button>
        </li>
      </ol>
      <div className="fy-swready">
        <span className="fy-swready__dot" data-ready={attention === 0 ? "true" : undefined} aria-hidden="true" />
        <span>{attention === 0 ? "Ready to generate" : attention === 1 ? "1 item worth reviewing" : `${attention} items worth reviewing`}</span>
        <span className="fy-swready__meta">scene {scene.number} · v{scene.version}</span>
      </div>
    </>
  );
}

function Divider({
  shot,
  showBoards,
  canSplit,
  locked,
  dragBoundary,
  onInsert,
  onSplit,
  onMoveBoundary,
}: {
  shot: Shot;
  showBoards: boolean;
  canSplit: boolean;
  locked: boolean;
  dragBoundary: string | null;
  onInsert: () => void;
  onSplit: () => void;
  onMoveBoundary: () => void;
}) {
  const moving = dragBoundary !== null && dragBoundary !== shot.id;
  return (
    <div
      className="fy-swdivider"
      data-moving={moving ? "true" : undefined}
      onDragOver={(event) => moving && event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onMoveBoundary();
      }}
    >
      {moving ? (
        <>
          {/* The whole line is the drop zone; the label stays a button so the click path the band
              handle opens (click the handle, then click a line) still reaches the keyboard. */}
          <span />
          <button type="button" disabled={locked} onClick={onMoveBoundary}>Move boundary here</button>
          <span />
        </>
      ) : (
        <>
          <button type="button" title="Insert a shot here" aria-label={`Insert before shot ${shot.number}`} disabled={locked} onClick={onInsert}>
            <Plus size={12} />
          </button>
          <span />
          {showBoards && canSplit ? (
            <button type="button" title="Start a new board here" disabled={locked} onClick={onSplit}>Split board here</button>
          ) : null}
        </>
      )}
    </div>
  );
}

function BoardBand({
  board,
  scene,
  world,
  shots,
  capSec,
  aspect,
  locked,
  generatorPending,
  staged,
  movable,
  refusalVersion,
  selected,
  onSelect,
  onCommand,
  onDragStart,
  onDragEnd,
  onViewBoardSheet,
  onRender,
  onPlanVideo,
}: {
  board: PackedBoard;
  scene: SceneRecord;
  world: WorldBundle;
  shots: readonly Shot[];
  capSec: number;
  aspect: string;
  locked: boolean;
  generatorPending: boolean;
  staged: boolean;
  movable: boolean;
  refusalVersion: number;
  selected: boolean;
  onSelect: () => void;
  onCommand: (command: Command) => boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onViewBoardSheet: (board: PackedBoard, trigger: HTMLElement) => void;
  onRender: () => void;
  onPlanVideo: () => void;
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const promptDirty = useRef(false);
  const preservedRefusal = useRef<number | null>(null);
  const pendingRebuildVersion = useRef<number | null>(null);
  const [pendingHide, setPendingHide] = useState<{
    expected: string;
    draft: string;
    refusalVersion: number;
  } | null>(null);
  const members = board.memberShotIds.map((id) => shots.find((shot) => shot.id === id)!).filter(Boolean);
  const stored = boardPromptFor(scene, board.memberShotIds);
  const assembled = assembleBoardPrompt({
    world: world.meta,
    sheets: world.sheets,
    scene,
    shots: members,
    aspect,
    artDirection: world.artDirection.description,
  });
  const promptValue = stored ?? assembled;
  const previousPromptValue = useRef(promptValue);
  const [promptDraft, setPromptDraft] = useState(promptValue);
  const first = members[0]?.number;
  const last = members.at(-1)?.number;
  const startId = board.memberShotIds[0]!;
  useEffect(() => {
    const durablePromptChanged = previousPromptValue.current !== promptValue;
    previousPromptValue.current = promptValue;
    if (pendingHide !== null) {
      if (stored === pendingHide.expected) {
        pendingRebuildVersion.current = null;
        preservedRefusal.current = null;
        promptDirty.current = false;
        setPromptDraft(promptValue);
        setPendingHide(null);
        setPromptOpen(false);
      }
      return;
    }
    if (!durablePromptChanged || preservedRefusal.current === refusalVersion || promptDirty.current || promptDraft === promptValue) return;
    pendingRebuildVersion.current = null;
    setPromptDraft(promptValue);
  }, [pendingHide, promptDraft, promptValue, refusalVersion, stored]);
  useEffect(() => {
    if (pendingHide !== null) {
      if (pendingHide.refusalVersion === refusalVersion) return;
      preservedRefusal.current = refusalVersion;
      promptDirty.current = true;
      setPromptDraft(pendingHide.draft);
      setPendingHide(null);
      return;
    }
    if (pendingRebuildVersion.current === null || pendingRebuildVersion.current === refusalVersion) return;
    pendingRebuildVersion.current = null;
    promptDirty.current = false;
    setPromptDraft(promptValue);
  }, [pendingHide, promptValue, refusalVersion]);
  const commitPrompt = (value = promptDraft): boolean => {
    const next = value.trim();
    promptDirty.current = false;
    if (next.length === 0 || next === promptValue) {
      setPromptDraft(promptValue);
      return true;
    }
    if (!onCommand({ kind: "set-board-prompt", members: [...board.memberShotIds], text: next })) {
      setPromptDraft(promptValue);
      return false;
    }
    setPromptDraft(next);
    return true;
  };
  const hidePrompt = (value: string) => {
    const next = value.trim();
    if (next.length === 0 || next === promptValue) {
      preservedRefusal.current = null;
      promptDirty.current = false;
      setPromptDraft(promptValue);
      setPromptOpen(false);
      return;
    }
    if (!onCommand({ kind: "set-board-prompt", members: [...board.memberShotIds], text: next })) {
      promptDirty.current = true;
      setPromptDraft(value);
      return;
    }
    promptDirty.current = false;
    setPromptDraft(value);
    setPendingHide({ expected: next, draft: value, refusalVersion });
  };
  return (
    <div
      className="fy-swboard"
      data-testid={`workspace-board-${board.letter}`}
      data-selected={selected ? "true" : undefined}
      data-staged={staged ? "true" : undefined}
      onClick={onSelect}
      onFocus={onSelect}
    >
      <div className="fy-swboard__line">
        <button
          type="button"
          className="fy-swboard__handle"
          draggable={!locked && movable}
          disabled={locked || !movable}
          aria-label={`Move board ${board.letter} boundary`}
          onClick={onDragStart}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <Grip size={10} /> Board {board.letter}
        </button>
        <span className="fy-swboard__meta">{members.length > 1 ? `shots ${first}–${last}` : `shot ${first}`}</span>
        <span className="fy-swboard__rule" />
        {board.reason === null ? null : <span className="fy-swboard__meta" data-kind="reason">split · {board.reason}</span>}
        <span className="fy-swboard__meta" data-kind="duration">{board.durationSec.toFixed(1)}s / {capSec}s</span>
        <button
          type="button"
          className="fy-swboard__sheet"
          title="Consolidated prompt"
          aria-label={`Consolidated prompt for board ${board.letter}`}
          disabled={locked}
          onClick={() => setPromptOpen((open) => !open)}
        >
          <Lines size={14} />
        </button>
        <button
          type="button"
          className="fy-swboard__sheet"
          title="View board sheet"
          aria-label={`View board sheet ${board.letter}`}
          onClick={(event) => onViewBoardSheet(board, event.currentTarget)}
        >
          <Grid2x2 size={14} />
        </button>
        {staged ? <span className="fy-swboard__staged">staged</span> : null}
        {/* No Stage link on the band: staging is per shot until board scope exists (SPEC-036 §1.13),
            and a link that staged only the first member would claim more than it did. */}
        <button type="button" title="Send this board to the generator" disabled={locked || staged || generatorPending} onClick={onRender}>
          {generatorPending ? "Opening…" : "Render board"}
        </button>
        <button type="button" disabled={locked || staged} onClick={onPlanVideo}>Plan video</button>
        {board.reason === null ? null : (
          <button
            type="button"
            disabled={locked || board.reason === "clip limit" || board.reason === "panel limit"}
            title={
              board.reason === "clip limit" || board.reason === "panel limit"
                ? `Cannot merge across the ${board.reason}`
                : board.reason === "by hand"
                  ? "Remove this hand split"
                  : "Merge this board into the one above"
            }
            onClick={() =>
              onCommand(
                board.reason === "by hand"
                  ? { kind: "clear-board-override", shotId: startId, override: "split" }
                  : { kind: "set-board-override", shotId: startId, override: "merge" },
              )
            }
          >
            Merge up
          </button>
        )}
      </div>
      {board.notes.length === 0 ? null : (
        <div className="fy-swboard__notes">
          {board.notes.map((note, index) => <span key={`${note.text}:${index}`} data-kind={note.kind}>{note.text}</span>)}
        </div>
      )}
      {promptOpen ? (
        <div
          className="fy-swboard__prompt"
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            if (!promptDirty.current) return;
            commitPrompt(event.currentTarget.querySelector("textarea")?.value ?? promptDraft);
          }}
        >
          <div>
            <span>consolidated prompt · sent once for the board</span>
            <button
              type="button"
              disabled={locked || stored === null}
              onClick={() => {
                promptDirty.current = false;
                if (onCommand({ kind: "clear-board-prompt", members: [...board.memberShotIds] })) {
                  pendingRebuildVersion.current = refusalVersion;
                  setPromptDraft(assembled);
                } else {
                  setPromptDraft(promptValue);
                }
              }}
            >
              Rebuild
            </button>
            <button
              type="button"
              disabled={pendingHide !== null}
              onClick={(event) => {
                const value = event.currentTarget.closest(".fy-swboard__prompt")?.querySelector("textarea")?.value ?? promptDraft;
                hidePrompt(value);
              }}
            >
              Hide
            </button>
          </div>
          <textarea
            value={promptDraft}
            disabled={locked}
            aria-label={`Consolidated prompt for board ${board.letter}`}
            onChange={(event) => {
              promptDirty.current = true;
              setPromptDraft(event.target.value);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function Row({
  shot,
  scene,
  world,
  production,
  artifacts,
  sheets,
  slug,
  digests,
  aspect,
  selected,
  staged,
  newShot,
  locked,
  generatorPending,
  onSelect,
  onBand,
  onCommand,
  onDelete,
  onDeleteDialogOpen,
  onDeleteDialogClose,
  onDragStart,
  onDragEnd,
  onDrop,
  refusalVersion,
  runState,
  run,
  onRetryFinalization,
  worldId,
  onGenerateFrame,
  onEdit,
  onOpenInGenerator,
  onStage,
  onPreview,
  prevShotId,
  nextShotId,
}: {
  shot: Shot;
  scene: SceneRecord;
  world: WorldBundle;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  sheets: readonly Sheet[];
  slug: string | undefined;
  digests: ReadonlyMap<string, string>;
  aspect: string;
  selected: boolean;
  staged: boolean;
  newShot: boolean;
  locked: boolean;
  generatorPending: boolean;
  onSelect: () => void;
  onBand: (element: HTMLDivElement | null) => void;
  onCommand: (command: Command) => boolean;
  onDelete: () => boolean;
  onDeleteDialogOpen: () => void;
  onDeleteDialogClose: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  refusalVersion: number;
  runState: ReturnType<typeof frameRunShotState>;
  run: FrameRunState | null;
  onRetryFinalization: (() => void) | null;
  worldId: string;
  onGenerateFrame: (trigger: HTMLButtonElement) => void;
  onEdit: () => void;
  onOpenInGenerator: () => void;
  onStage: () => void;
  onPreview: () => void;
  /** The rows either side, for moving without a pointer. */
  prevShotId: string | null;
  nextShotId: string | null;
}) {
  const band = useRef<HTMLDivElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const menuPanel = useRef<HTMLDivElement | null>(null);
  const variantsTrigger = useRef<HTMLButtonElement | null>(null);
  const variantsDialog = useRef<HTMLDialogElement | null>(null);
  const menuReturnFocus = useRef<HTMLElement | null>(null);
  const restored = useRef(false);
  const promptDirty = useRef(false);
  const preservedRefusal = useRef<number | null>(null);
  const pendingRebuildVersion = useRef<number | null>(null);
  const focusWhenVisible = useRef(false);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [scriptDraft, setScriptDraft] = useState(shot.description);
  const [titleDraft, setTitleDraft] = useState(shot.title);
  const [durationDraft, setDurationDraft] = useState(String(shot.durationSec ?? DEFAULT_SHOT_SEC));
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [pendingHide, setPendingHide] = useState<{
    expected: string | null;
    draft: string;
    refusalVersion: number;
  } | null>(null);
  const accepted = newShot ? null : acceptedTakeId(production, shot.id);
  const takes = takesForShot(production, shot.id);
  const acceptedTake = accepted === null ? undefined : takes.find((take) => take.id === accepted);
  const coverage = shotCoverage(shot, digests);
  const hasFrame = shotHasFrame(production, artifacts, shot.id);
  const state = shotCardState({
    blankScript: shot.description.trim() === "",
    clipAccepted: acceptedTake?.kind === "clip",
    hasFrame,
    coverage,
  });
  const waitingSessions = waitingTakeSessions(world.benchSessions, production.meta.id, scene.id, shot.id);
  const waitingTakeCount = waitingSessions.reduce((total, summary) => total + summary.waitingCount, 0);
  const artifactId = production.selections[shot.id]?.startFrameArtifactId ?? null;
  const artifact = artifactId === null ? undefined : artifacts.find((candidate) => candidate.id === artifactId);
  const hasFramePointer =
    artifactId !== null || (production.selections[shot.id]?.startFrameTakeId ?? null) !== null;
  const legacyStill = acceptedTake?.kind === "frame" || acceptedTake?.kind === "still" ? acceptedTake : undefined;
  const framePath = artifact !== undefined && hasFrame
    ? `artifacts/${artifact.file}`
    : legacyStill?.media === undefined
      ? null
      : `productions/${production.meta.id}/takes/${legacyStill.id}/${legacyStill.media}`;
  const src = slug === undefined || framePath === null ? null : mediaUrl(slug, framePath);
  const frameVariants = takes.filter(
    (take) => (take.kind === "frame" || take.kind === "still") && take.media !== undefined,
  );
  const refs = resolveCast(shot.description, [...sheets]).cast;
  const structuredOverrides = [
    shot.framing?.size,
    shot.framing?.angle,
    shot.framing?.lens,
    shot.framing?.focus,
    shot.framing?.movement,
    shot.framing?.pace,
    shot.framing?.lighting,
    shot.framing?.timeOfDay,
    shot.framing?.grade,
  ].filter((value): value is string => value !== undefined && value.trim() !== "");
  // Older scenes carry the same authored camera decisions in one line. Keeping that line visible
  // is more honest than presenting an empty override payload until the shot is opened and saved.
  const overrides = (structuredOverrides.length > 0
    ? structuredOverrides
    : (shot.camera?.split("·").map((value) => value.trim()).filter(Boolean) ?? []))
    .map((value) => `${value} override`)
    .slice(0, 2);
  const runScriptChanged = runState !== null && run !== null && sceneVersionMoved(run, production, shot.id);
  const style = production.meta.styleOverride?.trim() || world.artDirection.description;
  const capability = productionShape(production.meta).dispatchCapability === "image" ? "image" : undefined;
  const assembledPrompt = assemblePrompt(world.meta, world.sheets, scene, shot, style, undefined, capability);
  const currentPrompt = promptFor(world.meta, world.sheets, scene, shot, style, undefined, capability);
  const durablePromptOverride = shot.promptOverride?.text ?? null;
  const promptValue = promptDraft ?? currentPrompt.text;
  const mentionOptions = sheets.map((sheet) => ({
    token: sheet.id,
    kind: "image" as const,
    name: sheet.name,
    meta: `${sheet.type} · v${sheet.version}`,
    imagePath: sheet.type === "location" ? locationPortraitPath(world, sheet.id) : characterPortraitPath(world, sheet.id),
  }));
  const disabled = locked || staged;
  const menuOpen = menu || confirmDelete;

  const closeMenu = useCallback((restoreFocus = false) => {
    if (confirmDelete) onDeleteDialogClose();
    focusWhenVisible.current = false;
    setMenu(false);
    setConfirmDelete(false);
    setMenuPosition(null);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        const target = menuReturnFocus.current;
        if (target?.isConnected && (target as HTMLButtonElement).disabled !== true) target.focus();
        else if (band.current?.isConnected) band.current.focus();
      });
    }
  }, [confirmDelete, onDeleteDialogClose]);
  const openDelete = () => {
    onDeleteDialogOpen();
    focusWhenVisible.current = true;
    setMenu(false);
    setConfirmDelete(true);
    setMenuPosition(null);
  };
  const placeMenu = useCallback(() => {
    const trigger = menuTrigger.current;
    const panel = menuPanel.current;
    if (trigger === null || panel === null) return;
    const anchor = trigger.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    if (![anchor.right, anchor.bottom, anchor.top, box.width, box.height, window.innerWidth, window.innerHeight].every(Number.isFinite)) {
      setMenuPosition({ left: 8, top: 8 });
      return;
    }
    const left = Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8));
    const below = anchor.bottom + 6;
    const top = below + box.height <= window.innerHeight - 8
      ? below
      : Math.max(8, anchor.top - box.height - 6);
    setMenuPosition({ left, top });
  }, []);

  useEffect(() => {
    if (!selected) {
      restored.current = false;
      return;
    }
    if (restored.current || band.current === null) return;
    restored.current = true;
    band.current.scrollIntoView?.({ block: "nearest" });
    band.current.focus({ preventScroll: true });
  }, [selected]);
  useEffect(() => {
    setScriptDraft(shot.description);
  }, [shot.description]);
  useEffect(() => {
    if (pendingHide !== null) {
      if (durablePromptOverride === pendingHide.expected) {
        pendingRebuildVersion.current = null;
        preservedRefusal.current = null;
        promptDirty.current = false;
        setPromptDraft(null);
        setPendingHide(null);
        setPromptOpen(false);
      }
    }
    if (durablePromptOverride === null) pendingRebuildVersion.current = null;
  }, [durablePromptOverride, pendingHide]);
  useEffect(() => {
    if (pendingHide !== null) {
      if (pendingHide.refusalVersion === refusalVersion) return;
      preservedRefusal.current = refusalVersion;
      promptDirty.current = true;
      setPromptDraft(pendingHide.draft);
      setPendingHide(null);
      return;
    }
    if (pendingRebuildVersion.current === null || pendingRebuildVersion.current === refusalVersion) return;
    pendingRebuildVersion.current = null;
    promptDirty.current = false;
    setPromptDraft(null);
  }, [pendingHide, refusalVersion]);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    if (menuPosition === null) {
      placeMenu();
    }
  }, [menuOpen, menuPosition, placeMenu]);
  useLayoutEffect(() => {
    if (!menuOpen || menuPosition === null || !focusWhenVisible.current) return;
    focusWhenVisible.current = false;
    const target = menuPanel.current?.querySelector<HTMLButtonElement>(
      confirmDelete ? "button:not(:disabled)" : '[role="menuitem"]:not(:disabled)',
    );
    target?.focus();
  }, [confirmDelete, menuOpen, menuPosition]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target !== null && menuPanel.current?.contains(target)) return;
      if (!confirmDelete && target !== null && menuTrigger.current?.contains(target)) return;
      if (!confirmDelete) {
        closeMenu();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      menuPanel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    };
    const containFocus = (event: FocusEvent) => {
      if (!confirmDelete || (event.target instanceof Node && menuPanel.current?.contains(event.target))) return;
      menuPanel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("click", outside, true);
    document.addEventListener("focusin", containFocus, true);
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("click", outside, true);
      document.removeEventListener("focusin", containFocus, true);
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
      window.removeEventListener("keydown", key);
    };
  }, [closeMenu, confirmDelete, menuOpen, placeMenu]);
  useEffect(() => {
    if (confirmDelete && staged) closeMenu(false);
  }, [closeMenu, confirmDelete, staged]);

  useEffect(() => {
    setTitleDraft(shot.title);
    setDurationDraft(String(shot.durationSec ?? DEFAULT_SHOT_SEC));
  }, [shot.title, shot.durationSec, refusalVersion]);

  const commitScript = (next = scriptDraft) => {
    if (disabled || next === shot.description) return;
    if (!onCommand({ kind: "edit-shot", shotId: shot.id, change: { description: next } })) {
      setScriptDraft(shot.description);
    }
  };
  const commitPrompt = (value = promptValue) => {
    const next = value.trim();
    promptDirty.current = false;
    if (next === currentPrompt.text.trim()) {
      setPromptDraft(null);
      return true;
    }
    const replacement = next === "" || next === assembledPrompt.trim() ? null : next;
    if (!onCommand({
      kind: "set-prompt-override",
      shotId: shot.id,
      text: replacement,
    })) {
      setPromptDraft(null);
      return false;
    }
    setPromptDraft(replacement === null ? assembledPrompt : next);
    return true;
  };
  // Rebuild and Re-read share this: drop whatever was typed and read the prompt off the current
  // script again. Only a durable override needs a command; a local draft is just let go.
  const canRebuild = durablePromptOverride !== null || promptDraft !== null;
  const rebuildPrompt = () => {
    promptDirty.current = false;
    if (durablePromptOverride === null) {
      setPromptDraft(null);
      return;
    }
    if (onCommand({ kind: "set-prompt-override", shotId: shot.id, text: null })) {
      pendingRebuildVersion.current = refusalVersion;
      setPromptDraft(assembledPrompt);
    } else {
      setPromptDraft(null);
    }
  };
  const hidePrompt = (value: string) => {
    const next = value.trim();
    if (next === currentPrompt.text.trim()) {
      preservedRefusal.current = null;
      promptDirty.current = false;
      setPromptOpen(false);
      return;
    }
    const expected = next === "" || next === assembledPrompt.trim() ? null : next;
    if (!onCommand({ kind: "set-prompt-override", shotId: shot.id, text: expected })) {
      promptDirty.current = true;
      setPromptDraft(value);
      return;
    }
    promptDirty.current = false;
    setPromptDraft(value);
    setPendingHide({ expected, draft: value, refusalVersion });
  };
  return (
    <div
      ref={(element) => {
        band.current = element;
        onBand(element);
      }}
      className="fy-swrow__band"
      data-shot-id={shot.id}
      data-state={state}
      data-selected={selected ? "true" : undefined}
      data-staged={staged ? "true" : undefined}
      role="group"
      tabIndex={staged ? -1 : 0}
      aria-disabled={staged ? "true" : undefined}
      aria-label={`Shot ${shot.number}, ${shot.title}, ${staged ? "staged, " : ""}${state}${waitingTakeCount === 0 ? "" : `, ${waitingTakeCount} take${waitingTakeCount === 1 ? "" : "s"} waiting`}`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onDragOver={(event) => !disabled && event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(); }}
      onClick={() => !staged && onSelect()}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (staged) return;
        if (event.key === "Delete") {
          event.preventDefault();
          menuReturnFocus.current = event.currentTarget;
          openDelete();
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && !disabled) {
          // The grip is the pointer's way to reorder; this is the keyboard's (the menu lost its
          // Move entries to the design). The row keeps focus, so a second press keeps moving.
          event.preventDefault();
          const to = event.key === "ArrowUp" ? (prevShotId === null ? null : { before: prevShotId }) : nextShotId === null ? null : { after: nextShotId };
          if (to !== null) onCommand({ kind: "move-shot", shotId: shot.id, to });
        }
      }}
    >
      {selected ? <span className="fy-swrow__ring" aria-hidden="true" /> : null}
      {staged ? <span className="fy-swrow__staged">staged</span> : null}
      <div className="fy-swrow__frame fy-imghost" style={{ aspectRatio: aspect.replace(":", " / ") }}>
        {src === null ? (
          <div className="fy-swrow__hatch"><ImageMark size={17} /><span className="fy-swrow__nofr">no frame yet</span></div>
        ) : (
          <div className="fy-swrow__img" role="img" aria-label={shot.title} style={{ backgroundImage: `url(${src})` }} />
        )}
        <span
          className="fy-swrow__label"
          title="Drag to reorder"
          draggable={!disabled}
          onDragStart={(event) => {
            event.stopPropagation();
            onDragStart();
          }}
          onDragEnd={onDragEnd}
        >
          shot {shot.number}
        </span>
        <span className="fy-swrow__chipmeta">
          {aspect} · {(shot.durationSec ?? DEFAULT_SHOT_SEC).toFixed(1)}s{shot.framing?.lens === undefined ? "" : ` · ${shot.framing.lens}`}
        </span>
        {framePath === null ? null : (
          // The circle alone is the hit area, so the rest of the thumbnail stays draggable (§7.1).
          <button
            type="button"
            className="fy-swrow__preview"
            aria-label={`Preview frame for shot ${shot.number}`}
            title="Open larger"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onPreview();
            }}
          />
        )}
        <div
          className="fy-swrow__frameactions"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" disabled={shot.description.trim() === ""} onClick={() => setPromptOpen((open) => !open)}>Prompt</button>
          {/*
            The script is written in place, so read-aloud sits with the row's other buttons rather
            than hovering over the text (issue 857) — a speaker inside an editor fights the caret,
            which is the same call the bible made about its own document.
          */}
          <ReadAloudButton
            source={{ of: "shot", productionId: production.meta.id, sceneId: scene.id, shotId: shot.id }}
            title={`Shot ${shot.number} · script`}
            text={shot.description}
          />
          <button
            ref={variantsTrigger}
            type="button"
            disabled={frameVariants.length === 0}
            onClick={() => variantsDialog.current?.showModal()}
          >
            Variants
          </button>
          <button
            type="button"
            disabled={disabled || !canPickFiles()}
            title={canPickFiles() ? "Use an image from this computer" : UPLOAD_UNAVAILABLE}
            onClick={() => importShotFrame(worldId, production.meta.id, shot.id)}
          >
            Upload
          </button>
          {/*
            The reverse of the chain (issue 851). An accept files a still onto the next shot, and
            nothing else takes one off — so without this a shot handed a boundary frame could only
            be moved off it by drawing over it.
          */}
          <button
            type="button"
            disabled={disabled || !hasFramePointer}
            title="Clear the start frame; dispatch from this shot's own references"
            aria-label={`Clear the start frame for shot ${shot.number}`}
            onClick={() => clearShotFrame(worldId, production.meta.id, shot.id)}
          >
            Clear
          </button>
        </div>
        <dialog
          ref={variantsDialog}
          className="fy-swvariants"
          aria-label={`Frame variants for shot ${shot.number}`}
          onClose={() => variantsTrigger.current?.focus()}
          onClick={(event) => {
            if (event.target === event.currentTarget) variantsDialog.current?.close();
          }}
        >
          <div className="fy-swvariants__panel">
            <header>
              <div>
                <span>Shot {shot.number} · frame history</span>
                <h2>{shot.title}</h2>
              </div>
              <button type="button" aria-label="Close frame variants" onClick={() => variantsDialog.current?.close()}>Close</button>
            </header>
            <div className="fy-swvariants__grid">
              {frameVariants.map((take) => {
                const path = `productions/${production.meta.id}/takes/${take.id}/${take.media!}`;
                const current = production.selections[shot.id]?.startFrameTakeId === take.id || artifact?.links.includes(take.id) === true;
                return (
                  <article key={take.id} data-current={current ? "true" : undefined}>
                    <img
                      src={slug === undefined ? undefined : mediaUrl(slug, path)}
                      alt={`Variant for shot ${shot.number}`}
                      style={{ aspectRatio: aspect.replace(":", " / ") }}
                    />
                    <div>
                      <span>{take.model}</span>
                      <button
                        type="button"
                        disabled={current || disabled}
                        onClick={() => {
                          acceptTake(worldId, production.meta.id, take.id, shot.id);
                          variantsDialog.current?.close();
                        }}
                      >
                        {current ? "Current" : "Use frame"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </dialog>
        {runState === null ? null : (
          <FrameState
            state={runState}
            onRetry={run === null ? null : retryForShot(run, runState, shot.id, worldId, production.meta.id)}
            onRetryFinalization={onRetryFinalization}
          />
        )}
      </div>
      <div className="fy-swrow__body">
        <div className="fy-swrow__titleline">
          <span className="fy-swrow__title">Shot {shot.number} · {shot.title}</span>
          <span className="fy-swchip" data-state={state}>{CHIP[state]}<span aria-hidden="true" /></span>
          {shot.staging?.playblast === undefined ? null : (
            <span className="fy-swrow__playblast" title="Staged · a playblast is filed">staged</span>
          )}
        </div>
        <div className="fy-swrow__fields" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <label>
            Title
            <input
              aria-label={`Title for shot ${shot.number}`}
              value={titleDraft}
              disabled={disabled}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") { event.currentTarget.value = shot.title; setTitleDraft(shot.title); event.currentTarget.blur(); }
              }}
              onBlur={(event) => {
                const title = event.currentTarget.value.trim();
                if (!title || title === shot.title || disabled || !onCommand({ kind: "edit-shot", shotId: shot.id, change: { title } })) setTitleDraft(shot.title);
              }}
            />
          </label>
          <label>
            Duration · seconds
            <input
              aria-label={`Duration for shot ${shot.number}`}
              type="number" min="0.01" step="any"
              value={durationDraft}
              disabled={disabled}
              onChange={(event) => setDurationDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") { event.currentTarget.value = String(shot.durationSec ?? DEFAULT_SHOT_SEC); setDurationDraft(event.currentTarget.value); event.currentTarget.blur(); }
              }}
              onBlur={(event) => {
                const durationSec = Number(event.currentTarget.value);
                if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec === (shot.durationSec ?? DEFAULT_SHOT_SEC) || disabled ||
                  !onCommand({ kind: "edit-shot", shotId: shot.id, change: { durationSec } })) setDurationDraft(String(shot.durationSec ?? DEFAULT_SHOT_SEC));
              }}
            />
          </label>
        </div>
        <WaitingTakeLinks sessions={waitingSessions} worldId={worldId} />
        {coverage === "changed" || runScriptChanged ? (
          <div className="fy-swrow__stale">
            <span className="fy-swrow__stalelabel">script changed</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                rebuildPrompt();
                setPromptOpen(true);
              }}
            >
              Re-read
            </button>
          </div>
        ) : null}
        <div
          className="fy-swrow__script fy-swrow__scripteditor"
          title="Write what happens · type @ to name anything in the world"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            commitScript(event.currentTarget.querySelector("textarea")?.value ?? scriptDraft);
          }}
        >
          <BenchBrief
            value={scriptDraft}
            onChange={setScriptDraft}
            options={mentionOptions}
            worldSlug={slug}
            underlay={scriptDraft}
            label={`Script for shot ${shot.number}`}
            placeholder="Write what happens."
            disabled={disabled}
          />
        </div>
        {promptOpen ? (
          <div
            className="fy-swrow__prompt"
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              if (!promptDirty.current) return;
              commitPrompt(event.currentTarget.querySelector("textarea")?.value ?? promptValue);
            }}
          >
            <div className="fy-swrow__prompthead">
              <span>image prompt</span>
              <button
                type="button"
                title="Rebuild from the script, references and camera"
                disabled={disabled || !canRebuild}
                onClick={rebuildPrompt}
              >
                Rebuild
              </button>
              <button
                type="button"
                disabled={pendingHide !== null}
                onClick={(event) => {
                  const value = event.currentTarget.closest(".fy-swrow__prompt")?.querySelector("textarea")?.value ?? promptValue;
                  hidePrompt(value);
                }}
              >
                Hide
              </button>
            </div>
            <BenchBrief
              value={promptValue}
              onChange={(value) => {
                promptDirty.current = true;
                setPromptDraft(value);
              }}
              options={mentionOptions}
              worldSlug={slug}
              underlay={promptValue}
              label={`Image prompt for shot ${shot.number}`}
              disabled={disabled}
            />
          </div>
        ) : null}
        {refs.length === 0 && overrides.length === 0 ? null : (
          <div className="fy-swrow__meta">
            <div className="fy-swrow__refs">
              {refs.map((entry) => (
                <span key={entry.sheet.id} className="fy-swrow__ref" title={`${entry.sheet.type} · v${entry.sheet.version}`}>
                  <span className="fy-swrow__refthumb">
                    <Portrait
                      worldSlug={slug}
                      path={entry.sheet.type === "location" ? locationPortraitPath(world, entry.sheet.id) : characterPortraitPath(world, entry.sheet.id)}
                      label=""
                      radius={99}
                    />
                  </span>
                  {entry.sheet.name}
                </span>
              ))}
            </div>
            <div className="fy-swrow__overrides">
              {overrides.map((label) => <span key={label} className="fy-swrow__override" title="overrides the scene">{label}</span>)}
            </div>
          </div>
        )}
      </div>
      <div className="fy-swrow__actions" onClick={(event) => event.stopPropagation()}>
        <div className="fy-swrow__actionline">
          <Button
            variant={hasFrame ? "outline" : "primary"}
            size="sm"
            className="fy-swrow__generate"
            disabled={disabled || run?.status === "active" || run?.status === "paused"}
            onClick={(event) => onGenerateFrame(event.currentTarget)}
          >
            {hasFrame ? "Regenerate" : "Generate frame"}
          </Button>
          <button
            ref={menuTrigger}
            type="button"
            className="fy-swedit fy-swrow__more"
            title="More"
            disabled={disabled}
            aria-label={`Actions for shot ${shot.number}`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => {
              menuReturnFocus.current = menuTrigger.current;
              setConfirmDelete(false);
              setMenuPosition(null);
              focusWhenVisible.current = !menu;
              setMenu(!menu);
            }}
          >
            <More size={15} />
          </button>
        </div>
        {promptOpen ? null : (
          <div className="fy-swrow__slot">
            <span>{shot.promptOverride === undefined ? "prompt · auto" : "prompt · edited by you"}</span>
            <button type="button" disabled={disabled} onClick={() => setPromptOpen(true)}>Edit</button>
          </div>
        )}
      </div>
      {menuOpen && typeof document !== "undefined"
        ? createPortal(
            <>
              {confirmDelete ? (
                <div
                  data-testid="row-confirmation-blocker"
                  aria-hidden="true"
                  style={{ position: "fixed", inset: 0, zIndex: 99 }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    menuPanel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    menuPanel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
                  }}
                />
              ) : null}
            <div
              ref={menuPanel}
              className={confirmDelete ? "fy-swrow__confirm" : "fy-swrow__menu"}
              role={confirmDelete ? "alertdialog" : "menu"}
              aria-modal={confirmDelete ? "true" : undefined}
              aria-label={confirmDelete ? `Delete shot ${shot.number}?` : `Actions for shot ${shot.number}`}
              style={menuPosition === null ? { left: 0, top: 0, visibility: "hidden" } : menuPosition}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                const selector = confirmDelete ? "button:not(:disabled)" : '[role="menuitem"]:not(:disabled)';
                const items = [...(menuPanel.current?.querySelectorAll<HTMLButtonElement>(selector) ?? [])];
                const current = items.indexOf(document.activeElement as HTMLButtonElement);
                let next: number | null = null;
                if (!confirmDelete && event.key === "ArrowDown") next = (current + 1) % items.length;
                else if (!confirmDelete && event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
                else if (!confirmDelete && event.key === "Home") next = 0;
                else if (!confirmDelete && event.key === "End") next = items.length - 1;
                else if (event.key === "Tab" && confirmDelete) {
                  event.preventDefault();
                  next = event.shiftKey
                    ? (current - 1 + items.length) % items.length
                    : (current + 1) % items.length;
                } else if (event.key === "Tab") {
                  event.preventDefault();
                  closeMenu(true);
                }
                const item = next === null ? undefined : items[next];
                if (item === undefined) return;
                event.preventDefault();
                item.focus();
              }}
            >
              {confirmDelete ? (
                <>
                  <span>Delete shot {shot.number}?</span>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (onDelete()) closeMenu(true);
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => closeMenu(true)}>Cancel</button>
                </>
              ) : (
                <>
                  <button type="button" role="menuitem" disabled={staged} onClick={() => { closeMenu(true); onStage(); }}>Stage this shot</button>
                  <button type="button" role="menuitem" disabled={disabled || generatorPending} onClick={onOpenInGenerator}>
                    {generatorPending ? "Opening…" : "Open in generator"}
                  </button>
                  <button type="button" role="menuitem" disabled={disabled} onClick={() => { closeMenu(true); onEdit(); }}>Advanced</button>
                  <button type="button" role="menuitem" disabled={disabled} onClick={() => { closeMenu(true); onCommand({ kind: "duplicate-shot", shotId: shot.id }); }}>Duplicate</button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={disabled}
                    onClick={() => {
                      closeMenu(true);
                      onCommand({ kind: "insert-shot", at: { after: shot.id }, shot: { title: "Untitled shot", description: "" } });
                    }}
                  >
                    Add shot after
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="fy-swrow__danger"
                    disabled={disabled}
                    onClick={openDelete}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

function sceneVersionMoved(run: FrameRunState, production: ProductionBundle, shotId: string): boolean {
  const scene = production.scenes.find((candidate) => candidate.id === run.run.sceneId);
  return scene !== undefined && scene.version !== run.run.sceneVersion && run.run.steps.some((step) => step.updateShotIds.includes(shotId));
}

function failureCopy(state: Pick<NonNullable<ReturnType<typeof frameRunShotState>>, "status" | "failureClass" | "error">): string {
  if (state.failureClass === "provider-fault") return state.error === null ? "provider fault · lane held" : `${state.error} · lane held`;
  if (state.failureClass === "terminal") return state.error ?? "the provider refused this request";
  if (state.failureClass === "offline") {
    // Offline holds the lane only while the job is still queued or running: the dispatcher paused
    // it and resumes it when connectivity returns. Once the job has given up after its last
    // attempt it is terminal and nothing is paused, so a failed row that still said "lane held"
    // promised a resume that was never coming (issue 697). A credential rejection is the other
    // way round — it terminalizes and pauses the lane — which is why provider-fault above keeps
    // the suffix on a failed row.
    const held = state.status === "queued" || state.status === "submitting" || state.status === "running";
    if (!held) return state.error ?? "offline";
    return state.error === null ? "offline · lane held" : `${state.error} · lane held`;
  }
  return state.error ?? "came back dark";
}

function retryForShot(
  run: FrameRunState,
  state: NonNullable<ReturnType<typeof frameRunShotState>>,
  shotId: string,
  worldId: string,
  productionId: string,
): (() => boolean) | null {
  if (run.run.mode === "board") {
    // A failed initial board has no immutable parent sheet. Its retry belongs to the durable
    // board strip; cells become retryable only when the backend says that parent context exists.
    if (!state.canRetryCell || (state.grain === "initial" && state.status === "failed")) return null;
    return () => frameRunCommand({ kind: "frame-run-retry-cell", worldId, productionId, runId: run.run.id, stepIndex: state.stepIndex, shotId });
  }
  if (!state.stepCanRetry) return null;
  return () => frameRunCommand({ kind: "frame-run-retry-step", worldId, productionId, runId: run.run.id, stepIndex: state.stepIndex });
}

function FrameState({
  state,
  onRetry,
  onRetryFinalization,
}: {
  state: NonNullable<ReturnType<typeof frameRunShotState>>;
  onRetry: (() => boolean) | null;
  onRetryFinalization: (() => void) | null;
}) {
  if (state.status === "queued" || state.status === "not-enqueued" || state.status === "submitting") {
    const held = state.failureClass === "provider-fault" || state.failureClass === "offline";
    return <div className="fy-swrow__run" data-state={held ? "failed" : "queued"}>{held ? failureCopy(state) : "queued"}</div>;
  }
  if (state.status === "running") {
    const held = state.failureClass === "provider-fault" || state.failureClass === "offline";
    return <div className="fy-swrow__run" data-state={held ? "failed" : "running"}>{held ? failureCopy(state) : "generating frame…"}</div>;
  }
  if (state.status === "failed" || state.status === "missing" || state.status === "needs-reconciliation") {
    return (
      <div className="fy-swrow__run" data-state="failed" role="status">
        <span>{failureCopy(state)}</span>
        {onRetryFinalization !== null
          ? <button type="button" onClick={onRetryFinalization}>Retry finalization</button>
          : onRetry === null
            ? null
            : <button type="button" onClick={onRetry}>Retry</button>}
      </div>
    );
  }
  if (onRetry !== null) return <div className="fy-swrow__run" data-state="retry"><span>{state.status === "superseded" ? "overtaken" : "frame added"}</span><button type="button" onClick={onRetry}>Retry</button></div>;
  return null;
}
