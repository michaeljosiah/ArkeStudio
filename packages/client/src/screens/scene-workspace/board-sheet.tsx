import { useEffect, useId, useRef } from "react";
import {
  DEFAULT_SHOT_SEC,
  hasOwnFrame,
  orderedShots,
  type ArtifactSidecar,
  type FrameRunState,
  type PackedBoard,
  type ProductionBundle,
  type SceneRecord,
  type Take,
} from "@arke-studio/contracts";
import { X } from "../../components/icons.js";
import { mediaUrl } from "../../lib/media.js";
import { frameRunCommand } from "../../lib/store.js";

const LIVE = new Set(["not-enqueued", "queued", "submitting", "running", "needs-reconciliation"]);

function sameShots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((shotId, index) => shotId === right[index]);
}

function newestParent(production: ProductionBundle, memberShotIds: readonly string[]): Take | null {
  return production.takes
    .filter((take) =>
      take.boardSheetParent === true &&
      take.media !== undefined &&
      sameShots(take.coversShots, memberShotIds))
    .sort((left, right) => {
      const byTime = (right.completedAt ?? right.dispatchedAt).localeCompare(left.completedAt ?? left.dispatchedAt);
      return byTime || right.id.localeCompare(left.id);
    })[0] ?? null;
}

function descendsFrom(run: FrameRunState, candidateIndex: number, ancestorIndex: number): boolean {
  let at = run.run.steps[candidateIndex]?.retryOf;
  while (at !== undefined) {
    if (at === ancestorIndex) return true;
    at = run.run.steps[at]?.retryOf;
  }
  return false;
}

function lineageFor(
  parent: Take | null,
  memberShotIds: readonly string[],
  runs: readonly FrameRunState[],
): { run: FrameRunState; stepIndex: number } | null {
  if (parent?.jobId === undefined) return null;
  for (const run of runs) {
    for (let index = run.run.steps.length - 1; index >= 0; index -= 1) {
      const step = run.run.steps[index]!;
      if (
        step.jobId === parent.jobId &&
        step.dispatch.target.kind === "board-sheet" &&
        sameShots(step.requestShotIds, memberShotIds)
      ) return { run, stepIndex: index };
    }
  }
  return null;
}

function latestBoardAttempt(
  memberShotIds: readonly string[],
  runs: readonly FrameRunState[],
): { run: FrameRunState; stepIndex: number } | null {
  for (const run of runs) {
    for (let index = run.run.steps.length - 1; index >= 0; index -= 1) {
      const step = run.run.steps[index]!;
      if (step.dispatch.target.kind === "board-sheet" && sameShots(step.requestShotIds, memberShotIds)) {
        return { run, stepIndex: index };
      }
    }
  }
  return null;
}

function currentAttempt(
  lineage: { run: FrameRunState; stepIndex: number } | null,
  shotId: string,
): { stepIndex: number; state: FrameRunState["steps"][number]["shots"][number] } | null {
  if (lineage === null) return null;
  for (let index = lineage.run.run.steps.length - 1; index >= lineage.stepIndex; index -= 1) {
    if (index !== lineage.stepIndex && !descendsFrom(lineage.run, index, lineage.stepIndex)) continue;
    const state = lineage.run.steps[index]?.shots.find((candidate) => candidate.shotId === shotId);
    if (state !== undefined) return { stepIndex: index, state };
  }
  return null;
}

function currentFrame(
  production: ProductionBundle,
  artifacts: readonly ArtifactSidecar[],
  worldSlug: string | undefined,
  shotId: string,
): string | null {
  if (worldSlug === undefined) return null;
  const selection = production.selections[shotId];
  const artifactId = selection?.startFrameArtifactId ?? null;
  const artifact = artifactId === null ? undefined : artifacts.find((candidate) => candidate.id === artifactId);
  if (
    hasOwnFrame(selection, artifacts) &&
    artifact?.kind === "image" &&
    !artifacts.some((candidate) => candidate.supersedes === artifact.id)
  ) return mediaUrl(worldSlug, `artifacts/${artifact.file}`);

  const takeId = selection?.acceptedTakeId ?? null;
  const take = takeId === null ? undefined : production.takes.find((candidate) => candidate.id === takeId);
  return take !== undefined && (take.kind === "frame" || take.kind === "still") && take.media !== undefined
    ? mediaUrl(worldSlug, `productions/${production.meta.id}/takes/${take.id}/${take.media}`)
    : null;
}

export function BoardSheet({
  board,
  scene,
  production,
  artifacts,
  runs,
  aspect,
  worldId,
  worldSlug,
  returnFocus,
  onClose,
}: {
  board: PackedBoard | null;
  scene: SceneRecord;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  runs: readonly FrameRunState[];
  aspect: string;
  worldId: string;
  worldSlug: string | undefined;
  returnFocus: HTMLElement | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const node = dialog.current;
    if (board === null || node === null) return;
    if (node.showModal !== undefined) node.showModal();
    else node.setAttribute("open", "");
    return () => returnFocus?.focus();
  }, [board, returnFocus]);

  if (board === null) return null;
  const shots = orderedShots(scene);
  const members = board.memberShotIds.map((shotId) => shots.find((shot) => shot.id === shotId)).filter((shot) => shot !== undefined);
  const parent = newestParent(production, board.memberShotIds);
  const lineage = lineageFor(parent, board.memberShotIds, runs);
  const boardRetry = latestBoardAttempt(board.memberShotIds, runs);
  const boardState = lineage?.run.steps[lineage.stepIndex] ?? null;
  const boardRetryState = boardRetry?.run.steps[boardRetry.stepIndex] ?? null;
  const anotherRunOwnsScene = (runId: string | undefined) => runs.some((candidate) =>
    candidate.run.id !== runId && (candidate.status === "active" || candidate.status === "paused"));
  const wholeRetryBusy = lineage !== null && lineage.run.run.steps.some((step, index) =>
    index > lineage.stepIndex &&
    descendsFrom(lineage.run, index, lineage.stepIndex) &&
    step.dispatch.target.kind === "board-sheet" &&
    LIVE.has(lineage.run.steps[index]?.status ?? "missing"));
  const first = members[0]?.number;
  const last = members.at(-1)?.number;
  const columns = members.length <= 4 ? 2 : 3;

  return (
    <dialog
      ref={dialog}
      className="fy-swboard-sheet"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="fy-swboard-sheet__panel">
        <header className="fy-swboard-sheet__head">
          <h2 id={titleId}>Board {board.letter}</h2>
          <span>shots {first}{last !== first ? `–${last}` : ""} · {members.length} cell{members.length === 1 ? "" : "s"} · one pass</span>
          <span>{board.durationSec}s</span>
          <button type="button" aria-label="Close board sheet" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="fy-swboard-sheet__grid" data-columns={columns}>
          {members.map((shot) => {
            const attempt = currentAttempt(lineage, shot.id);
            const busy = attempt !== null && LIVE.has(attempt.state.status);
            const src = currentFrame(production, artifacts, worldSlug, shot.id);
            const lighting = shot.framing?.lighting;
            const frozenPanel = lineage?.run.run.steps[lineage.stepIndex]?.request.panels.find((panel) => panel.shotId === shot.id);
            const fixedCellCanRetry =
              attempt === null &&
              frozenPanel?.role === "fixed" &&
              lineage!.run.run.cancelled === false &&
              lineage!.run.run.steps[lineage!.stepIndex]!.dispatch.referenceCapacity > 0 &&
              boardState !== null &&
              ["succeeded", "reconciled", "superseded"].includes(boardState.status);
            const canRetryCell =
              !wholeRetryBusy &&
              !anotherRunOwnsScene(lineage?.run.run.id) &&
              (attempt?.state.canRetryCell === true || fixedCellCanRetry);
            const retryStepIndex = attempt?.stepIndex ?? lineage?.stepIndex;
            return (
              <article
                key={shot.id}
                className="fy-swboard-sheet__cell"
                style={{ aspectRatio: aspect.replace(":", " / ") }}
                data-testid={`board-sheet-cell-${shot.id}`}
              >
                {src === null
                  ? <div className="fy-swboard-sheet__empty">no frame yet</div>
                  : <img src={src} alt={shot.title} />}
                {busy ? <div className="fy-swboard-sheet__busy" role="status" aria-live="polite">regenerating cell...</div> : null}
                <span className="fy-swboard-sheet__number">shot {shot.number}</span>
                <span className="fy-swboard-sheet__meta">{(shot.durationSec ?? DEFAULT_SHOT_SEC).toFixed(1)}s{lighting === undefined ? "" : ` · ${lighting}`}</span>
                <button
                  type="button"
                  className="fy-swboard-sheet__retry-cell"
                  disabled={!canRetryCell}
                  title={canRetryCell ? "Regenerate this cell against the rest of the board" : "A completed board sheet is required before this cell can be retried"}
                  aria-label={`Retry shot ${shot.number} against board ${board.letter}`}
                  onClick={() => {
                    if (lineage === null || retryStepIndex === undefined) return;
                    frameRunCommand({
                      kind: "frame-run-retry-cell",
                      worldId,
                      productionId: production.meta.id,
                      runId: lineage.run.run.id,
                      stepIndex: retryStepIndex,
                      shotId: shot.id,
                    });
                  }}
                >
                  Retry
                </button>
              </article>
            );
          })}
        </div>

        <footer className="fy-swboard-sheet__foot">
          <p>{"One image, one pass \u2014 cast, light and grade are shared. Retrying a cell reuses the rest of the board as reference."}</p>
          <button
            type="button"
            disabled={boardRetryState?.canRetry !== true || anotherRunOwnsScene(boardRetry?.run.run.id)}
            title={anotherRunOwnsScene(boardRetry?.run.run.id)
              ? "Another frame run is active"
              : boardRetryState?.canRetry === true ? "Regenerate this whole board" : "This board has no retryable pass"}
            onClick={() => {
              if (boardRetry === null) return;
              frameRunCommand({
                kind: "frame-run-retry-step",
                worldId,
                productionId: production.meta.id,
                runId: boardRetry.run.run.id,
                stepIndex: boardRetry.stepIndex,
              });
            }}
          >
            Retry board
          </button>
        </footer>
      </div>
    </dialog>
  );
}
