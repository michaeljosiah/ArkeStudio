import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent } from "react";
import { createPortal } from "react-dom";
import {
  assemblePrompt,
  assembleBoardPrompt,
  boardPromptFor,
  DEFAULT_SHOT_SEC,
  stageLineCrossings,
  orderedShots,
  productionShape,
  promptFor,
  resolveCast,
  shotSpeakers,
  shotCardState,
  shotCoverage,
  UNTITLED_SHOT,
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
  type WorldBundle,
} from "@arke-studio/contracts";
import { mediaUrl } from "../../lib/media.js";
import { acceptedTakeId, takesForShot } from "../../lib/selectors.js";
import { shotHasFrame, type WorkspaceBoardPack } from "./boards.js";
import { selectedShotId, subjectMatchesBoard, useWorkspaceSelection } from "./selection.js";
import { acceptTake, clearShotFrame, frameRunCommand, importShotFrame, retryJobFinalization } from "../../lib/store.js";
import { finalizationRetryJobId, frameRunShotState } from "./frame-run.js";
import { BenchBrief } from "../../components/bench-brief.js";
import { FrameActions } from "./frame-actions.js";
import { ChevronDown, ChevronRight, ChevronUp, Cog, FileText, Grid2x2, Grip, ImageMark, Lines, MapPin, More, Pencil, Plus, StickyNote } from "../../components/icons.js";
import { characterPortraitPath, locationPortraitPath, Portrait } from "../../components/portrait.js";
import { Button } from "../../components/ui.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];

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
  layout = "list",
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
  onOpenCharacter,
  locationName,
  onOpenLocation,
}: {
  layout?: "list" | "grid";
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
  /** A band's character chip leads to the character dialog (SPEC-044 R-22). */
  onOpenCharacter: (sheetId: string, trigger: HTMLElement) => void;
  /** The scene's place, named on the open row's timing line as a chip that opens it (turn 143). */
  locationName: string | null;
  onOpenLocation: (trigger: HTMLElement) => void;
}) {
  const shots = orderedShots(scene);
  const lineFindings = useMemo(() => stageLineCrossings(scene, aspect), [scene, aspect]);
  const { subject, select } = useWorkspaceSelection();
  const current = selectedShotId(subject);
  // One row open at a time, and the open row is the selected row (turn 143): there is no
  // selected-and-closed state, so the selection the views already share is the open state too.
  // The Grid keeps its cards; opening is the List's form of selection.
  const openShotId = layout === "list" && current !== null && shots.some((shot) => shot.id === current) ? current : null;
  const closeRow = useCallback(() => select({ kind: "scene" }), [select]);
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
                  shot: { title: UNTITLED_SHOT, description: "" },
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
        data-layout={layout}
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
                      shot: { title: UNTITLED_SHOT, description: "" },
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
                lineWarning={lineFindings.filter(finding => finding.shotIds.includes(shot.id)).map(finding => finding.message).join("\n")}
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
                layout={layout}
                selected={shot.id === current}
                open={shot.id === openShotId}
                folded={openShotId !== null && shot.id !== openShotId}
                onClose={closeRow}
                locationName={locationName}
                onOpenLocation={onOpenLocation}
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
                onOpenCharacter={onOpenCharacter}
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
                shot: { title: UNTITLED_SHOT, description: "" },
              })
            }
          >
            <span className="fy-swaddshot__ring" aria-hidden="true"><Plus size={12} /></span>
            Add shot
          </button>
        </li>
      </ol>
      {attention > 0 ? <div className="fy-swready">
        <span className="fy-swready__dot" aria-hidden="true" />
        <span>{attention === 1 ? "1 item worth reviewing" : `${attention} items worth reviewing`}</span>
        <span className="fy-swready__meta">scene {scene.number} · v{scene.version}</span>
      </div> : null}
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
  lineWarning,
  shot,
  scene,
  world,
  production,
  artifacts,
  sheets,
  slug,
  digests,
  aspect,
  layout,
  selected,
  open,
  folded,
  onClose,
  locationName,
  onOpenLocation,
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
  onOpenCharacter,
  prevShotId,
  nextShotId,
}: {
  lineWarning: string;
  shot: Shot;
  scene: SceneRecord;
  world: WorldBundle;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  sheets: readonly Sheet[];
  slug: string | undefined;
  digests: ReadonlyMap<string, string>;
  aspect: string;
  layout: "list" | "grid";
  selected: boolean;
  /** The row open in place (turn 143): its panels shown, the others folded. List only. */
  open: boolean;
  folded: boolean;
  onClose: () => void;
  locationName: string | null;
  onOpenLocation: (trigger: HTMLElement) => void;
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
  onOpenCharacter: (sheetId: string, trigger: HTMLElement) => void;
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
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDuration, setEditingDuration] = useState(false);
  const titleTrigger = useRef<HTMLButtonElement>(null);
  const durationTrigger = useRef<HTMLButtonElement>(null);
  const editReturnFocus = useRef<"title" | "duration" | null>(null);
  const [durationDraft, setDurationDraft] = useState(String(shot.durationSec ?? DEFAULT_SHOT_SEC));
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [pendingHide, setPendingHide] = useState<{
    expected: string | null;
    draft: string;
    refusalVersion: number;
    /** What the acknowledged write closes: the Grid card's prompt, or the whole open row. */
    closes: "prompt" | "row";
  } | null>(null);
  // The open row's own state (turn 143): which panels are folded to their head, whether the
  // prompt is shown whole, and the notes draft. None of it outlives the row.
  const [foldedPanels, setFoldedPanels] = useState<ReadonlySet<"description" | "prompt" | "notes">>(new Set());
  const [promptWhole, setPromptWhole] = useState(false);
  const [notesDraft, setNotesDraft] = useState(shot.notes ?? "");
  const pressTop = useRef<number | null>(null);
  /**
   * A prompt write the blur (or Rebuild) admitted and the durable override has not yet matched.
   * Close waits on this rather than inferring a write from the draft: a draft that differs from
   * the durable prompt with nothing in flight is a refused write, and Close must send it again.
   */
  const promptWrite = useRef<{ expected: string | null; refusalVersion: number } | null>(null);
  // In the Grid a card's prompt opens on its toggle; in the List the prompt is one of the open
  // row's panels, so it is shown exactly when the row is.
  const promptShown = layout === "grid" ? promptOpen : open;
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
  // What a cited character brings to this shot (SPEC-044 R-22): voice where they speak in it,
  // by the same resolution the planner and the dialog use; look where the shot cites them.
  const speakers = shotSpeakers(scene, [shot]).speakers;
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
  const capability = productionShape(production.meta).dispatchCapability === "image" ? "image" : "video";
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
  useEffect(() => {
    if (editingTitle || editingDuration || disabled || editReturnFocus.current === null) return;
    (editReturnFocus.current === "title" ? titleTrigger : durationTrigger).current?.focus();
    editReturnFocus.current = null;
  }, [editingTitle, editingDuration, disabled]);
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

  useLayoutEffect(() => {
    if (!selected) {
      restored.current = false;
      return;
    }
    if (restored.current || band.current === null) return;
    restored.current = true;
    // A press on the title or the script opened the row with the editor already focused; the
    // band takes focus only when nothing inside it holds it.
    const focusBand = () => {
      if (band.current === null) return;
      const active = typeof document === "undefined" ? null : document.activeElement;
      if (active !== null && active !== band.current && band.current.contains(active)) return;
      band.current.focus({ preventScroll: true });
    };
    if (pressTop.current !== null) {
      // The row a person pressed keeps its top edge where it was (turn 143): the rows above it
      // have just folded, so it moved up by their loss, and the list scrolls back by the same.
      // Measured here, after the commit and before paint, so the row never paints elsewhere.
      const delta = band.current.getBoundingClientRect().top - pressTop.current;
      pressTop.current = null;
      const scroller = band.current.closest<HTMLElement>(".fy-swrows");
      if (delta !== 0 && scroller !== null) scroller.scrollTop += delta;
      focusBand();
      return;
    }
    band.current.scrollIntoView?.({ block: "nearest" });
    focusBand();
  }, [selected]);
  // The draft follows the durable note and nothing else: a refused write leaves the person's
  // words in the box to blur again, rather than putting the old note back over them.
  useEffect(() => {
    setNotesDraft(shot.notes ?? "");
  }, [shot.notes]);
  useEffect(() => {
    setScriptDraft(shot.description);
  }, [shot.description]);
  useEffect(() => {
    if (promptWrite.current !== null && durablePromptOverride === promptWrite.current.expected) promptWrite.current = null;
    if (pendingHide !== null) {
      if (durablePromptOverride === pendingHide.expected) {
        pendingRebuildVersion.current = null;
        preservedRefusal.current = null;
        promptDirty.current = false;
        setPromptDraft(null);
        setPendingHide(null);
        // A row opened in the meantime is the selection now; this one's close is already done.
        if (pendingHide.closes === "row") { if (open) onClose(); }
        else setPromptOpen(false);
      }
    }
    if (durablePromptOverride === null) pendingRebuildVersion.current = null;
  }, [durablePromptOverride, onClose, open, pendingHide]);
  useEffect(() => {
    // A refusal answers the write in flight: the draft is the person's again, to send once more.
    if (promptWrite.current !== null && promptWrite.current.refusalVersion !== refusalVersion) {
      promptWrite.current = null;
      promptDirty.current = true;
    }
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
      capability,
    })) {
      setPromptDraft(null);
      return false;
    }
    promptWrite.current = { expected: replacement, refusalVersion };
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
      promptWrite.current = { expected: null, refusalVersion };
      setPromptDraft(assembledPrompt);
    } else {
      setPromptDraft(null);
    }
  };
  // Hide (a Grid card's prompt) and Close (the open row) share this: an unchanged prompt
  // closes at once and writes nothing; a changed one is written and closes only when the
  // durable override comes back matching, so a refused write leaves the draft on screen.
  const hidePrompt = (value: string, closes: "prompt" | "row") => {
    const next = value.trim();
    if (next === currentPrompt.text.trim()) {
      preservedRefusal.current = null;
      promptDirty.current = false;
      if (closes === "row") onClose();
      else setPromptOpen(false);
      return;
    }
    const expected = next === "" || next === assembledPrompt.trim() ? null : next;
    if (!onCommand({ kind: "set-prompt-override", shotId: shot.id, text: expected, capability })) {
      promptDirty.current = true;
      setPromptDraft(value);
      return;
    }
    promptDirty.current = false;
    setPromptDraft(value);
    setPendingHide({ expected, draft: value, refusalVersion, closes });
  };
  const openRow = () => {
    if (staged || open) return;
    pressTop.current = band.current?.getBoundingClientRect().top ?? null;
    onSelect();
  };
  // Close takes focus like any button, so whichever editor held it blurs and writes first —
  // the script, the notes, or the prompt — and one write is in flight at most. A prompt write
  // the blur admitted is waited on rather than sent again; a refused one is the draft's again
  // and goes through hidePrompt, which resends it and waits.
  const closeRow = () => {
    if (pendingHide !== null) return;
    if (promptWrite.current !== null) {
      setPendingHide({ expected: promptWrite.current.expected, draft: promptDraft ?? promptValue, refusalVersion, closes: "row" });
      return;
    }
    hidePrompt(promptValue, "row");
  };
  const commitNotes = (value: string) => {
    const next = value.trim();
    if (disabled || next === (shot.notes ?? "")) return;
    // A write that is not taken (one is already in flight) keeps the draft, as a refusal does.
    if (next === "") onCommand({ kind: "edit-shot", shotId: shot.id, change: {}, clear: ["notes"] });
    else onCommand({ kind: "edit-shot", shotId: shot.id, change: { notes: next } });
  };
  const togglePanel = (panel: "description" | "prompt" | "notes") => {
    // The fold control sits inside the prompt's blur boundary, so folding that panel would
    // unmount the editor without the blur that writes it; the fold writes a dirty draft first.
    if (panel === "prompt" && !foldedPanels.has("prompt") && promptDirty.current) commitPrompt(promptValue);
    setFoldedPanels((current) => {
      const next = new Set(current);
      if (next.has(panel)) next.delete(panel);
      else next.add(panel);
      return next;
    });
  };
  // The select offers the lengths a shot is usually cut to, and always the length it has.
  const durationSec = shot.durationSec ?? DEFAULT_SHOT_SEC;
  const durationOptions = [...new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 15, durationSec])].sort((a, b) => a - b);
  const titleControl = editingTitle ? (
    <input
      className="fy-swrow__title-input" aria-label={`Title for shot ${shot.number}`} value={titleDraft} disabled={disabled} autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setTitleDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        editReturnFocus.current = "title";
        if (event.key === "Escape") { event.currentTarget.value = shot.title; setTitleDraft(shot.title); event.currentTarget.blur(); }
        else event.currentTarget.blur();
      }}
      onBlur={(event) => {
        const title = event.currentTarget.value.trim();
        if (!title || title === shot.title || disabled || !onCommand({ kind: "edit-shot", shotId: shot.id, change: { title } })) setTitleDraft(shot.title);
        setEditingTitle(false);
      }}
    />
  ) : <button ref={titleTrigger} type="button" className="fy-swrow__title-edit" aria-label={`Edit title for shot ${shot.number}`} disabled={disabled} onClick={() => setEditingTitle(true)}><span className="fy-swrow__title">{shot.title}</span><Pencil size={14} /></button>;
  const stateChip = state === "needs attention" || state === "story"
    ? <span className="fy-swchip" data-state={state}><span aria-hidden="true" />{state === "needs attention" ? "Needs attention" : "Needs frame"}</span>
    : null;
  // The open row's duration is set from Shot settings, so its timing line reads rather than
  // edits (turn 143); the wide and folded rows keep the metadata editable, as 138 binds.
  const durationControl = open || folded ? (
    <span>{durationSec}s</span>
  ) : editingDuration ? (
    <input
      aria-label={`Duration for shot ${shot.number}`} type="number" min="0.01" step="any" value={durationDraft} disabled={disabled} autoFocus
      onChange={(event) => setDurationDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        editReturnFocus.current = "duration";
        if (event.key === "Escape") { event.currentTarget.value = String(durationSec); setDurationDraft(event.currentTarget.value); event.currentTarget.blur(); }
        else event.currentTarget.blur();
      }}
      onBlur={(event) => {
        const next = Number(event.currentTarget.value);
        if (!Number.isFinite(next) || next <= 0 || next === durationSec || disabled || !onCommand({ kind: "edit-shot", shotId: shot.id, change: { durationSec: next } })) setDurationDraft(String(durationSec));
        setEditingDuration(false);
      }}
    />
  ) : <button ref={durationTrigger} type="button" aria-label={`Edit duration for shot ${shot.number}`} title="Edit duration in seconds" disabled={disabled} onClick={() => setEditingDuration(true)}>{durationSec}s</button>;
  const scriptEditor = (
    <div
      className="fy-swrow__script fy-swrow__scripteditor"
      title="Write what happens · type @ to name anything in the world"
      onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
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
  );
  const promptToggle = promptShown ? null : (
    <button
      type="button"
      className="fy-swrow__prompt-toggle"
      aria-expanded={false}
      onClick={(event) => { event.stopPropagation(); if (layout === "grid") setPromptOpen(true); else openRow(); }}
    >
      <ChevronRight size={14} />Frame prompt{shot.promptOverride === undefined ? null : <span>Authored</span>}
    </button>
  );
  const promptMeta = !promptShown || (refs.length === 0 && overrides.length === 0) ? null : (
    <div className="fy-swrow__meta">
      <div className="fy-swrow__refs">
        {refs.map((entry) => {
          const title = `${entry.sheet.type} · v${entry.sheet.version}`;
          const inner = (
            <>
              <span className="fy-swrow__refthumb">
                <Portrait
                  worldSlug={slug}
                  path={entry.sheet.type === "location" ? locationPortraitPath(world, entry.sheet.id) : characterPortraitPath(world, entry.sheet.id)}
                  label=""
                  radius={99}
                />
              </span>
              {entry.sheet.name}
              {entry.sheet.type === "character" ? (
                <span className="fy-swrow__refwords">{speakers.includes(entry.sheet.id) ? "voice · look" : "look"}</span>
              ) : null}
            </>
          );
          return entry.sheet.type === "character" ? (
            <button
              key={entry.sheet.id}
              type="button"
              className="fy-swrow__ref fy-swrow__ref--door"
              title={title}
              aria-haspopup="dialog"
              onClick={(event) => { event.stopPropagation(); onOpenCharacter(entry.sheet.id, event.currentTarget); }}
            >
              {inner}
            </button>
          ) : (
            <span key={entry.sheet.id} className="fy-swrow__ref" title={title}>{inner}</span>
          );
        })}
      </div>
      <div className="fy-swrow__overrides">
        {overrides.map((label) => <span key={label} className="fy-swrow__override" title="overrides the scene">{label}</span>)}
      </div>
    </div>
  );
  const promptEditor = (
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
  );
  const rebuildButton = (
    <button
      type="button"
      title="Rebuild from the script, references and camera"
      disabled={disabled || !canRebuild}
      onClick={rebuildPrompt}
    >
      Rebuild
    </button>
  );
  const commitPromptOnBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (!promptDirty.current) return;
    commitPrompt(event.currentTarget.querySelector("textarea")?.value ?? promptValue);
  };
  const panelFold = (panel: "description" | "prompt" | "notes", label: string) => (
    <button
      type="button"
      className="fy-swrow__panelfold"
      aria-label={`${foldedPanels.has(panel) ? "Show" : "Fold"} ${label} for shot ${shot.number}`}
      aria-expanded={!foldedPanels.has(panel)}
      onClick={() => togglePanel(panel)}
    >
      {foldedPanels.has(panel) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
    </button>
  );
  const rowActions = (
    <div className="fy-swrow__actions" onClick={(event) => event.stopPropagation()}>
      <div className="fy-swrow__actionline">
        <Button
          variant="outline"
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
        {layout === "grid" ? null : (
          <button
            type="button"
            className="fy-swedit fy-swrow__more fy-swrow__fold"
            title={open ? "Close" : "Open"}
            aria-label={`${open ? "Close" : "Open"} shot ${shot.number}`}
            aria-expanded={open}
            disabled={staged || pendingHide !== null}
            onClick={() => (open ? closeRow() : openRow())}
          >
            {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        )}
      </div>
    </div>
  );
  return (
    <div
      ref={(element) => {
        band.current = element;
        onBand(element);
      }}
      className="fy-swrow__band"
      style={{ "--shot-aspect": aspect.replace(":", " / ") } as CSSProperties}
      data-shot-id={shot.id}
      data-state={state}
      data-selected={selected ? "true" : undefined}
      data-open={open ? "true" : undefined}
      data-folded={folded ? "true" : undefined}
      data-staged={staged ? "true" : undefined}
      role="group"
      tabIndex={staged ? -1 : 0}
      aria-disabled={staged ? "true" : undefined}
      aria-label={`Shot ${shot.number}, ${shot.title}, ${staged ? "staged, " : ""}${state}${waitingTakeCount === 0 ? "" : `, ${waitingTakeCount} take${waitingTakeCount === 1 ? "" : "s"} waiting`}`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onDragOver={(event) => !disabled && event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(); }}
      onClick={() => !staged && openRow()}
      onKeyDown={(event) => {
        // Escape closes the open row from anywhere in it — a menu that took the key (the @
        // picker) has prevented it — and the band takes the focus the editor is about to lose.
        if (event.key === "Escape" && open && !event.defaultPrevented && event.target !== event.currentTarget) {
          event.preventDefault();
          closeRow();
          event.currentTarget.focus({ preventScroll: true });
          return;
        }
        if (event.target !== event.currentTarget) return;
        if (staged) return;
        if (event.key === "Delete") {
          event.preventDefault();
          menuReturnFocus.current = event.currentTarget;
          openDelete();
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openRow();
        } else if (event.key === "Escape" && open) {
          event.preventDefault();
          closeRow();
        } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && !disabled) {
          // The grip is the pointer's way to reorder; this is the keyboard's (the menu lost its
          // Move entries to the design). The row keeps focus, so a second press keeps moving.
          event.preventDefault();
          const to = event.key === "ArrowUp" ? (prevShotId === null ? null : { before: prevShotId }) : nextShotId === null ? null : { after: nextShotId };
          if (to !== null) onCommand({ kind: "move-shot", shotId: shot.id, to });
        }
      }}
    >
      <span
        className="fy-swrow__grip" aria-hidden="true" title="Drag to reorder shot" draggable={!disabled}
        onDragStart={(event) => { if (!disabled) onDragStart(); event.dataTransfer?.setData("text/plain", shot.id); }}
        onDragEnd={onDragEnd}
      ><Grip size={14} /></span>
      {selected ? <span className="fy-swrow__ring" aria-hidden="true" /> : null}
      {staged ? <span className="fy-swrow__staged">staged</span> : null}
      <div className="fy-swrow__frame fy-imghost">
        {src === null ? (
          <div className="fy-swrow__hatch"><ImageMark size={17} /><span className="fy-swrow__nofr">no frame yet</span></div>
        ) : (
          <img className="fy-swrow__img" alt={shot.title} src={src} draggable={false} />
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
          {shot.number}
        </span>
        <span className="fy-swrow__chipmeta">
          {durationSec}s
        </span>
        {/* A folded row's strip is too small for the hover toolbar; the row opens to it. */}
        {folded ? null : (
          <>
            <FrameActions
              shotNumber={shot.number}
              title={shot.title}
              slug={slug}
              framePath={framePath}
              variants={frameVariants.length}
              disabled={disabled}
              canUpload={canPickFiles()}
              canClear={hasFramePointer}
              onPreview={onPreview}
              onVariants={(trigger) => { variantsTrigger.current = trigger; variantsDialog.current?.showModal(); }}
              onUpload={() => importShotFrame(worldId, production.meta.id, shot.id)}
              onClear={() => clearShotFrame(worldId, production.meta.id, shot.id)}
              readAloud={{ source: { of: "shot", productionId: production.meta.id, sceneId: scene.id, shotId: shot.id }, title: `Shot ${shot.number} · script`, text: shot.description }}
            />
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
          </>
        )}
        {runState === null ? null : (
          <FrameState
            state={runState}
            onRetry={run === null ? null : retryForShot(run, runState, shot.id, worldId, production.meta.id)}
            onRetryFinalization={onRetryFinalization}
          />
        )}
      </div>
      {folded ? (
        <div className="fy-swrow__body">
          <div className="fy-swrow__titleline">
            {titleControl}
            {stateChip}
            <span className="fy-swrow__timing">{durationControl}<span aria-hidden="true">·</span><span>{aspect}</span>{shot.promptOverride === undefined ? null : <span className="fy-swrow__authored">Authored</span>}</span>
          </div>
          <div className="fy-swrow__script fy-swrow__scriptline">{shot.description}</div>
        </div>
      ) : (
        /* One body for the wide row, the card and the open row, so an editor keeps its place in
           the tree — and its focus and draft — across List and Grid (turn 138) and across the
           row opening (turn 143). The open row places these children on the band's grid. */
        <div className="fy-swrow__body">
          <div className="fy-swrow__head">
            {/* The title and the script open the row (turn 143), so their presses reach the band;
                the editor the press landed in keeps its focus. */}
            <div className="fy-swrow__titleline">
              {titleControl}
              {lineWarning ? <span className="fy-swrow__playblast" title={lineWarning}>180° line</span> : null}
              {shot.staging?.playblast === undefined ? null : <span className="fy-swrow__playblast" title="Staged · a playblast is filed">staged</span>}
            </div>
            <div className="fy-swrow__timing" onClick={(event) => event.stopPropagation()}>
              {durationControl}
              <span aria-hidden="true">·</span><span>{aspect}</span>
              {open && locationName !== null ? (
                <>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    className="fy-swrow__place"
                    title={locationName}
                    aria-haspopup="dialog"
                    onClick={(event) => onOpenLocation(event.currentTarget)}
                  >
                    <MapPin size={13} />{locationName}
                  </button>
                </>
              ) : null}
              {stateChip}
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
                    if (layout === "grid") setPromptOpen(true);
                    else openRow();
                  }}
                >
                  Re-read
                </button>
              </div>
            ) : null}
            {/* The open row reads its script under the title and edits it in the Description
                panel (turn 143): the same draft, clamped to two lines here. */}
            {open ? <div className="fy-swrow__script fy-swrow__scriptread">{scriptDraft}</div> : null}
          </div>
          <section
            className={open ? "fy-swrow__panel fy-swrow__panel--description" : "fy-swrow__descwrap"}
            data-folded={open && foldedPanels.has("description") ? "true" : undefined}
          >
            {open ? (
              <div className="fy-swrow__panelhead">
                <FileText size={15} /><span>Description</span>{panelFold("description", "the description")}
              </div>
            ) : null}
            {open && foldedPanels.has("description") ? null : scriptEditor}
          </section>
          {promptShown ? (
            <section
              className={open ? "fy-swrow__panel fy-swrow__panel--prompt fy-swrow__prompt" : "fy-swrow__prompt"}
              data-folded={open && foldedPanels.has("prompt") ? "true" : undefined}
              data-whole={open && promptWhole ? "true" : undefined}
              onClick={(event) => event.stopPropagation()}
              onBlur={commitPromptOnBlur}
            >
              {open ? (
                <div className="fy-swrow__panelhead">
                  <FileText size={15} /><span>Frame prompt</span>
                  {shot.promptOverride === undefined ? null : <span className="fy-swrow__authored">Authored</span>}
                  {rebuildButton}
                  <button type="button" className="fy-swrow__wholeprompt" aria-pressed={promptWhole} onClick={() => setPromptWhole(!promptWhole)}>
                    {promptWhole ? "Show less" : "View full prompt"}
                  </button>
                  {panelFold("prompt", "the frame prompt")}
                </div>
              ) : (
                <div className="fy-swrow__prompthead">
                  <span>image prompt</span>
                  {rebuildButton}
                  <button type="button" disabled={pendingHide !== null} onClick={() => hidePrompt(promptValue, "prompt")}>
                    Hide
                  </button>
                </div>
              )}
              {open && foldedPanels.has("prompt") ? null : promptEditor}
              {open && foldedPanels.has("prompt") ? null : promptMeta}
            </section>
          ) : promptToggle}
          {open ? (
            <section className="fy-swrow__panel fy-swrow__panel--notes" data-folded={foldedPanels.has("notes") ? "true" : undefined} onClick={(event) => event.stopPropagation()}>
              <div className="fy-swrow__panelhead">
                <StickyNote size={15} /><span>Notes</span>{panelFold("notes", "the notes")}
              </div>
              {foldedPanels.has("notes") ? null : (
                <textarea
                  className="fy-swrow__notes"
                  aria-label={`Notes for shot ${shot.number}`}
                  placeholder="Add notes about this shot…"
                  value={notesDraft}
                  disabled={disabled}
                  rows={1}
                  onChange={(event) => setNotesDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
                  onBlur={(event) => commitNotes(event.currentTarget.value)}
                />
              )}
            </section>
          ) : null}
          {open ? (
            <section className="fy-swrow__panel fy-swrow__panel--settings" onClick={(event) => event.stopPropagation()}>
              <div className="fy-swrow__panelhead">
                <Cog size={15} /><span>Shot settings</span>
              </div>
              <div className="fy-swrow__settingsgrid">
                <label>
                  <span>Duration</span>
                  <select
                    aria-label={`Duration for shot ${shot.number}`}
                    value={String(durationSec)}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next) && next > 0 && next !== durationSec) onCommand({ kind: "edit-shot", shotId: shot.id, change: { durationSec: next } });
                    }}
                  >
                    {durationOptions.map((seconds) => <option key={seconds} value={String(seconds)}>{seconds}s</option>)}
                  </select>
                </label>
                <label>
                  <span>Aspect ratio</span>
                  {/* The production's, read here and set on the production (turn 143). */}
                  <select aria-label={`Aspect ratio for shot ${shot.number}`} value={aspect} disabled title="Set on the production" onChange={() => {}}>
                    <option value={aspect}>{aspect}</option>
                  </select>
                </label>
              </div>
            </section>
          ) : null}
        </div>
      )}
      {rowActions}
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
                      onCommand({ kind: "insert-shot", at: { after: shot.id }, shot: { title: UNTITLED_SHOT, description: "" } });
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
