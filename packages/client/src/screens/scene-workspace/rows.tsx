import { useEffect, useRef, useState } from "react";
import {
  assembleBoardPrompt,
  boardPromptFor,
  DEFAULT_SHOT_SEC,
  orderedShots,
  resolveCast,
  shotCardState,
  shotCoverage,
  type ArtifactSidecar,
  type ClientMessage,
  type FrameRunState,
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
import { frameRunCommand } from "../../lib/store.js";
import { frameRunShotState } from "./frame-run.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];

const CHIP: Record<ShotCardState, string> = {
  "needs attention": "needs attention",
  story: "story",
  storyboard: "storyboard",
  "production-ready": "production-ready",
  rendered: "rendered",
};

export function StoryboardRows({
  scene,
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
  worldId,
  onViewBoardSheet,
  onGenerateFrame,
  onEditShot,
  onOpenShotInGenerator,
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
  worldId: string;
  onViewBoardSheet: (board: PackedBoard, trigger: HTMLElement) => void;
  onGenerateFrame: (shotId: string, trigger: HTMLButtonElement) => void;
  onEditShot: (shotId: string) => void;
  onOpenShotInGenerator: (shotId: string) => void;
  onPlanVideo: () => void;
  onRenderBoard: (memberShotIds: string[]) => void;
}) {
  const shots = orderedShots(scene);
  const { subject, select } = useWorkspaceSelection();
  const current = selectedShotId(subject);
  const [dragShot, setDragShot] = useState<string | null>(null);
  const [dragBoundary, setDragBoundary] = useState<string | null>(null);
  const boards = boardPack.ok ? boardPack.boards : [];
  const boardAt = new Map(boards.map((board) => [board.memberShotIds[0]!, board]));

  if (shots.length === 0) {
    return (
      <div className="fy-swempty" data-testid="workspace-empty">
        <p className="fy-swempty__line">No shots yet.</p>
        <button
          type="button"
          className="fy-swedit"
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
        </button>
      </div>
    );
  }

  return (
    <>
      {!boardPack.ok ? <p className="fy-swboards__refusal">{boardPack.reason}</p> : null}
      <ol className="fy-swrows" data-testid="workspace-rows" aria-label={`Shots in scene ${scene.number}`}>
        {shots.map((shot, index) => {
          const board = boardAt.get(shot.id);
          return (
            <li key={shot.id} className="fy-swrow" data-testid={`workspace-row-${shot.id}`}>
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
              <Row
                shot={shot}
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
                canMoveUp={index > 0}
                canMoveDown={index < shots.length - 1}
                onSelect={() => select({ kind: "shot", shotId: shot.id })}
                onCommand={onCommand}
                onMoveUp={() => onCommand({ kind: "move-shot", shotId: shot.id, to: { before: shots[index - 1]!.id } })}
                onMoveDown={() => onCommand({ kind: "move-shot", shotId: shot.id, to: { after: shots[index + 1]!.id } })}
                onDragStart={() => setDragShot(shot.id)}
                onDragEnd={() => setDragShot(null)}
                onDrop={() => {
                  if (dragShot !== null && dragShot !== shot.id) {
                    onCommand({ kind: "move-shot", shotId: dragShot, to: { before: shot.id } });
                    setDragShot(null);
                  }
                }}
                refusalVersion={refusalVersion}
                runState={frameRunShotState(frameRun, shot.id)}
                run={frameRun}
                worldId={worldId}
                onGenerateFrame={(trigger) => onGenerateFrame(shot.id, trigger)}
                onEdit={() => onEditShot(shot.id)}
                onOpenInGenerator={() => onOpenShotInGenerator(shot.id)}
              />
            </li>
          );
        })}
      </ol>
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
      <button type="button" title="Insert a shot here" aria-label={`Insert before shot ${shot.number}`} disabled={locked} onClick={onInsert}>
        +
      </button>
      <span />
      {moving ? (
        <button type="button" disabled={locked} onClick={onMoveBoundary}>Move boundary here</button>
      ) : showBoards && canSplit ? (
        <button type="button" disabled={locked} onClick={onSplit}>Split board here</button>
      ) : null}
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
  const first = members[0]?.number;
  const last = members.at(-1)?.number;
  const startId = board.memberShotIds[0]!;
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
          ⠿ Board {board.letter}
        </button>
        {staged ? <span className="fy-swboard__staged">staged</span> : null}
        <span>shots {first}{last !== first ? `–${last}` : ""}</span>
        <span className="fy-swboard__rule" />
        {board.reason === null ? null : <span>split · {board.reason}</span>}
        <span>{board.durationSec}s / {capSec}s</span>
        <button type="button" disabled={locked || staged || generatorPending} onClick={onRender}>
          {generatorPending ? "Opening…" : "Render board"}
        </button>
        <button type="button" disabled={locked || staged} onClick={onPlanVideo}>Plan video</button>
        <button type="button" title="Consolidated prompt" disabled={locked} onClick={() => setPromptOpen((open) => !open)}>P</button>
        <button
          type="button"
          className="fy-swboard__sheet"
          title="View board sheet"
          aria-label={`View board sheet ${board.letter}`}
          onClick={(event) => onViewBoardSheet(board, event.currentTarget)}
        >
          <span aria-hidden="true" />
        </button>
        {board.reason === null ? null : (
          <button
            type="button"
            disabled={locked || board.reason === "clip limit" || board.reason === "panel limit"}
            title={board.reason === "clip limit" || board.reason === "panel limit" ? `Cannot merge across the ${board.reason}` : undefined}
            onClick={() =>
              onCommand(
                { kind: "set-board-override", shotId: startId, override: "merge" },
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
        <div className="fy-swboard__prompt">
          <div>
            <span>consolidated prompt · sent once for the board</span>
            {stored === null ? null : (
              <button type="button" disabled={locked} onClick={() => onCommand({ kind: "clear-board-prompt", members: [...board.memberShotIds] })}>
                Rebuild
              </button>
            )}
            <button type="button" onClick={() => setPromptOpen(false)}>Hide</button>
          </div>
          <textarea
            key={`${stored ?? assembled}:${refusalVersion}`}
            defaultValue={stored ?? assembled}
            disabled={locked}
            aria-label={`Consolidated prompt for board ${board.letter}`}
            onBlur={(event) => {
              const text = event.currentTarget.value.trim();
              if (text.length === 0) {
                event.currentTarget.value = stored ?? assembled;
              } else if (text !== (stored ?? assembled)) {
                if (!onCommand({ kind: "set-board-prompt", members: [...board.memberShotIds], text })) {
                  event.currentTarget.value = stored ?? assembled;
                }
              }
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function Row({
  shot,
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
  canMoveUp,
  canMoveDown,
  onSelect,
  onCommand,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragEnd,
  onDrop,
  refusalVersion,
  runState,
  run,
  worldId,
  onGenerateFrame,
  onEdit,
  onOpenInGenerator,
}: {
  shot: Shot;
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
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: () => void;
  onCommand: (command: Command) => boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  refusalVersion: number;
  runState: ReturnType<typeof frameRunShotState>;
  run: FrameRunState | null;
  worldId: string;
  onGenerateFrame: (trigger: HTMLButtonElement) => void;
  onEdit: () => void;
  onOpenInGenerator: () => void;
}) {
  const band = useRef<HTMLDivElement | null>(null);
  const restored = useRef(false);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const accepted = newShot ? null : acceptedTakeId(production, shot.id);
  const acceptedTake = accepted === null ? undefined : takesForShot(production, shot.id).find((take) => take.id === accepted);
  const coverage = shotCoverage(shot, digests);
  const hasFrame = shotHasFrame(production, artifacts, shot.id);
  const state = shotCardState({
    blankScript: shot.description.trim() === "",
    clipAccepted: acceptedTake?.kind === "clip",
    hasFrame,
    coverage,
  });
  const artifactId = production.selections[shot.id]?.startFrameArtifactId ?? null;
  const artifact = artifactId === null ? undefined : artifacts.find((candidate) => candidate.id === artifactId);
  const legacyStill = acceptedTake?.kind === "frame" || acceptedTake?.kind === "still" ? acceptedTake : undefined;
  const src =
    slug === undefined
      ? null
      : artifact !== undefined && hasFrame
        ? mediaUrl(slug, `artifacts/${artifact.file}`)
        : legacyStill?.media === undefined
          ? null
          : mediaUrl(slug, `productions/${production.meta.id}/takes/${legacyStill.id}/${legacyStill.media}`);
  const refs = resolveCast(shot.description, [...sheets]).cast;
  const overrides = [
    shot.framing?.size === undefined ? null : `${shot.framing.size} override`,
    shot.framing?.movement === undefined ? null : `${shot.framing.movement} override`,
  ].filter((label): label is string => label !== null);
  const runScriptChanged = runState !== null && run !== null && sceneVersionMoved(run, production, shot.id);

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
    if (band.current === null) return;
    const editor = band.current.querySelector<HTMLElement>(".fy-swrow__script");
    if (editor !== null) editor.textContent = shot.description;
  }, [shot.description, refusalVersion]);

  const disabled = locked || staged;
  const resetScript = (element: HTMLElement) => {
    element.textContent = shot.description;
  };
  return (
    <div
      ref={band}
      className="fy-swrow__band"
      data-state={state}
      data-selected={selected ? "true" : undefined}
      data-staged={staged ? "true" : undefined}
      role="group"
      tabIndex={staged ? -1 : 0}
      aria-disabled={staged ? "true" : undefined}
      aria-label={`Shot ${shot.number}, ${shot.title}, ${staged ? "staged, " : ""}${state}`}
      draggable={!disabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(event) => !disabled && event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(); }}
      onClick={() => !staged && onSelect()}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (staged) return;
        if (event.key === "Delete") {
          event.preventDefault();
          setConfirmDelete(true);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      {selected ? <span className="fy-swrow__ring" aria-hidden="true" /> : null}
      {staged ? <span className="fy-swrow__staged">staged</span> : null}
      <div className="fy-swrow__frame" style={{ aspectRatio: aspect.replace(":", " / ") }}>
        {src === null ? (
          <div className="fy-swrow__hatch"><span className="fy-swrow__nofr">no frame yet</span></div>
        ) : (
          <div className="fy-swrow__img" role="img" aria-label={shot.title} style={{ backgroundImage: `url(${src})` }} />
        )}
        <span className="fy-swrow__label">shot {shot.number}</span>
        <span className="fy-swrow__chipmeta">
          {aspect} · {(shot.durationSec ?? DEFAULT_SHOT_SEC).toFixed(1)}s{shot.framing?.lens === undefined ? "" : ` · ${shot.framing.lens}`}
        </span>
        {runState === null ? null : (
          <FrameState
            state={runState}
            onRetry={run === null ? null : retryForShot(run, runState, shot.id, worldId, production.meta.id)}
          />
        )}
      </div>
      <div className="fy-swrow__body">
        <div className="fy-swrow__titleline">
          <span className="fy-swrow__title">Shot {shot.number} · {shot.title}</span>
          <span className="fy-swchip" data-state={state}>{CHIP[state]}</span>
        </div>
        {coverage === "changed" || runScriptChanged ? <div className="fy-swrow__stale"><span className="fy-swrow__stalelabel">script changed</span></div> : null}
        <div
          className="fy-swrow__script"
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-label={`Script for shot ${shot.number}`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onBlur={(event) => {
            const description = event.currentTarget.textContent ?? "";
            if (!disabled && description !== shot.description) {
              if (!onCommand({ kind: "edit-shot", shotId: shot.id, change: { description } })) {
                resetScript(event.currentTarget);
              }
            }
          }}
        >
          {shot.description}
        </div>
        {refs.length === 0 && overrides.length === 0 ? null : (
          <div className="fy-swrow__meta">
            <div className="fy-swrow__refs">
              {refs.map((entry) => <span key={entry.sheet.id} className="fy-swrow__ref" title={entry.sheet.type}>{entry.sheet.name}</span>)}
            </div>
            <div className="fy-swrow__overrides">
              {overrides.map((label) => <span key={label} className="fy-swrow__override">{label}</span>)}
            </div>
          </div>
        )}
      </div>
      <div className="fy-swrow__actions" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="fy-swrow__generate"
          disabled={disabled || run?.status === "active" || run?.status === "paused"}
          onClick={(event) => onGenerateFrame(event.currentTarget)}
        >
          {hasFrame ? "Regenerate" : "Generate frame"}
        </button>
        <button
          type="button"
          className="fy-swedit"
          disabled={disabled}
          aria-label={`Actions for shot ${shot.number}`}
          aria-expanded={menu}
          aria-haspopup="menu"
          onClick={() => setMenu((open) => !open)}
        >
          •••
        </button>
        {menu ? (
          <div className="fy-swrow__menu" role="menu">
            <button type="button" role="menuitem" disabled={disabled} onClick={onEdit}>Edit shot</button>
            <button type="button" role="menuitem" disabled={disabled || generatorPending} onClick={onOpenInGenerator}>
              {generatorPending ? "Opening…" : "Open in generator"}
            </button>
            <button type="button" role="menuitem" disabled={disabled || !canMoveUp} onClick={onMoveUp}>Move before previous</button>
            <button type="button" role="menuitem" disabled={disabled || !canMoveDown} onClick={onMoveDown}>Move after next</button>
            <button type="button" role="menuitem" disabled={disabled} onClick={() => onCommand({ kind: "duplicate-shot", shotId: shot.id })}>Duplicate</button>
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => onCommand({ kind: "insert-shot", at: { after: shot.id }, shot: { title: "Untitled shot", description: "" } })}
            >
              Add shot after
            </button>
            <button type="button" role="menuitem" className="fy-swrow__danger" disabled={disabled} onClick={() => setConfirmDelete(true)}>Delete</button>
          </div>
        ) : null}
        {confirmDelete ? (
          <div className="fy-swrow__confirm" role="alert">
            <span>Delete shot {shot.number}?</span>
            <button type="button" onClick={() => onCommand({ kind: "delete-shot", shotId: shot.id })}>Delete</button>
            <button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        ) : null}
        <p className="fy-swrow__slot">{shot.promptOverride === undefined ? "prompt · auto" : "edited by you"}</p>
      </div>
    </div>
  );
}

function sceneVersionMoved(run: FrameRunState, production: ProductionBundle, shotId: string): boolean {
  const scene = production.scenes.find((candidate) => candidate.id === run.run.sceneId);
  return scene !== undefined && scene.version !== run.run.sceneVersion && run.run.steps.some((step) => step.updateShotIds.includes(shotId));
}

function failureCopy(state: { failureClass: "transient" | "terminal" | "provider-fault" | "offline" | null; error: string | null }): string {
  if (state.failureClass === "provider-fault") return state.error === null ? "provider fault · lane held" : `${state.error} · lane held`;
  if (state.failureClass === "terminal") return state.error ?? "the provider refused this request";
  if (state.failureClass === "offline") return state.error === null ? "offline · lane held" : `${state.error} · lane held`;
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

function FrameState({ state, onRetry }: { state: NonNullable<ReturnType<typeof frameRunShotState>>; onRetry: (() => boolean) | null }) {
  if (state.status === "queued" || state.status === "not-enqueued" || state.status === "submitting") {
    const held = state.failureClass === "provider-fault" || state.failureClass === "offline";
    return <div className="fy-swrow__run" data-state={held ? "failed" : "queued"}>{held ? failureCopy(state) : "queued"}</div>;
  }
  if (state.status === "running") {
    const held = state.failureClass === "provider-fault" || state.failureClass === "offline";
    return <div className="fy-swrow__run" data-state={held ? "failed" : "running"}>{held ? failureCopy(state) : "generating frame..."}</div>;
  }
  if (state.status === "failed" || state.status === "missing" || state.status === "needs-reconciliation") {
    return (
      <div className="fy-swrow__run" data-state="failed" role="status">
        <span>{failureCopy(state)}</span>
        {onRetry === null ? null : <button type="button" onClick={onRetry}>Retry</button>}
      </div>
    );
  }
  if (onRetry !== null) return <div className="fy-swrow__run" data-state="retry"><span>{state.status === "superseded" ? "overtaken" : "frame added"}</span><button type="button" onClick={onRetry}>Retry</button></div>;
  return null;
}
