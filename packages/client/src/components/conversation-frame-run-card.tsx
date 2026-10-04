import { orderedShots, type ConversationActionCard, type FrameRunState } from "@arke-studio/contracts";
import { useNavigate, type NavigateFunction } from "react-router";
import { useStore, frameRunCommand } from "../lib/store.js";
import { Portrait } from "./portrait.js";
import { takeMediaPath } from "../lib/take-presentation.js";

/** The live card follows only its sealed purchase or retained run receipt. */
export function ConversationFrameRunCard({ action }: { action: ConversationActionCard }) {
  const state = useStore().state, navigate = useNavigate();
  if (!state?.world || state.world.meta.worldId !== action.worldId || !action.actionKind.startsWith("world-chat-production-frame-run-") ||
      !["approved", "queued", "running", "completed", "failed", "cancelled"].includes(action.status)) return null;
  const keys = new Set(action.generationWork?.jobKeys ?? []);
  const run = state.frameRuns?.find(candidate => candidate.worldId === action.worldId && candidate.productionId === action.productionId &&
    (candidate.run.id === `fr_${action.actionId.slice(4)}` || action.receipt?.kind === "frame-run" && candidate.run.id === action.receipt.id ||
      candidate.run.steps.some(step => keys.has(step.dispatch.idempotencyKey))));
  if (!run) return null;
  return <FrameRunReport run={run} worldId={action.worldId} productionId={run.productionId} sceneId={run.run.sceneId} navigate={navigate} />;
}

const REPORT_FAILURE_STATUSES = new Set(["failed", "missing", "needs-reconciliation"]);
/** What actually came back: a frame filed by the run, or one reconciled from a job it lost sight of. */
const REPORT_RETURNED_STATUSES = new Set(["succeeded", "reconciled"]);

export function FrameRunReport({
  run,
  worldId,
  productionId,
  sceneId,
  navigate,
  onSelectShot,
  shotLabel,
}: {
  run: FrameRunState | null;
  worldId: string | undefined;
  productionId: string;
  sceneId: string;
  navigate: NavigateFunction;
  onSelectShot?: (shotId: string) => void;
  shotLabel?: (shotId: string) => string;
}) {
  const world = useStore().state?.world;
  const production = world && world.meta.worldId === worldId ? world.productions.find(p => p.meta.id === productionId) : undefined;
  if (run === null) {
    return <div className="fy-chat__runreport" data-state="loading">Loading run report…</div>;
  }
  const selectShot = (shotId: string) => {
    if (onSelectShot !== undefined) {
      onSelectShot(shotId);
    } else if (worldId !== undefined) {
      void navigate(`/w/${worldId}/p/${productionId}/scenes/${sceneId}?shot=${shotId}`);
    }
  };
  /*
   * Every step first, then every failure (design 3195-3201). A failure wedged under its own board
   * broke the count the eye was keeping down the card, and a run is read as what came back
   * before what did not.
   */
  const stepRows: React.ReactNode[] = [];
  const failureRows: React.ReactNode[] = [];
  run.run.steps.forEach((step, index) => {
    const state = run.steps[index];
    if (state === undefined) return;
    const failed = REPORT_FAILURE_STATUSES.has(state.status);
    const pending = ["not-enqueued", "queued", "submitting", "running"].includes(state.status);
    // What came back, not what was asked for: a board with one dark member reads "2 frames"
    // beside that member's failure row rather than claiming all three.
    const kept = state.shots.filter((shot) => REPORT_RETURNED_STATUSES.has(shot.status)).length;
    const board = run.run.mode === "board" && step.dispatch.target.kind === "board-sheet";
    const value = pending
      ? `running${step.grain === "initial" ? "" : " · retry"}`
      : `${kept} frame${kept === 1 ? "" : "s"}${board && kept > 1 ? " · one pass" : ""}${step.grain === "initial" ? "" : " · retry"}`;
    stepRows.push(
      <div key={`step:${index}`} className="fy-chat__runreport-row" data-kind="step" data-state={failed ? "failed" : pending ? "pending" : "complete"}>
        <button type="button" onClick={() => selectShot(step.updateShotIds[0]!)}>
          <span className="fy-chat__runreport-dot" aria-hidden="true" />
          <span className="fy-chat__runreport-key">{step.label.toLowerCase()}</span>
          <span>{value}</span>
        </button>
        {world && production && <div className="fy-chat__runreport-frames" aria-label={`${step.label} frames`}>
          {state.shots.map(shot => {
            const take = REPORT_RETURNED_STATUSES.has(shot.status) ? production.takes.find(t =>
              t.jobId === step.jobId && t.coversShots.includes(shot.shotId) && !t.boardSheetParent && ["frame", "still"].includes(t.kind)) : undefined;
            const path = take ? takeMediaPath(production, take) : null;
            const number = production.scenes.flatMap(orderedShots).find(s => s.id === shot.shotId)?.number;
            const label = `${shotLabel?.(shot.shotId) ?? (number ? `Shot ${number}` : step.label)} · ${shot.status}`;
            return <figure key={shot.shotId} data-run-frame={path ? "filed" : "pending"}>
              <Portrait worldSlug={path ? world.meta.slug : undefined} path={path ?? ""} label={label} />
              <figcaption>{label}</figcaption>
            </figure>;
          })}
        </div>}
      </div>,
    );
    for (const shot of state.shots) {
      const historicalFailure = shot.status === "reconciled" && shot.failureClass !== null;
      if (!historicalFailure && !REPORT_FAILURE_STATUSES.has(shot.status)) continue;
      const retried = shot.status === "reconciled";
      const retry = retried || run.run.cancelled
        ? null
        : state.canRetry
          ? () => frameRunCommand({ kind: "frame-run-retry-step", worldId: run.worldId, productionId, runId: run.run.id, stepIndex: index })
          : shot.canRetryCell
            ? () => frameRunCommand({ kind: "frame-run-retry-cell", worldId: run.worldId, productionId, runId: run.run.id, stepIndex: index, shotId: shot.shotId })
            : null;
      const words = `${frameRunFailureCopy(shot)}${retried ? " · retried" : ""}`;
      failureRows.push(
        <div key={`failure:${index}:${shot.shotId}`} className="fy-chat__runreport-row" data-kind="failure" data-state={retried ? "complete" : "failed"}>
          <button type="button" onClick={() => selectShot(shot.shotId)}>
            <span className="fy-chat__runreport-dot" aria-hidden="true" />
            {/* The shot, so two dark members of one board stay apart; the step is all the run state can name on its own. */}
            <span className="fy-chat__runreport-key">{shotLabel?.(shot.shotId) ?? step.label.toLowerCase()}</span>
            <span>{words}</span>
          </button>
          {retry === null ? null : <button type="button" className="fy-chat__runreport-retry" onClick={retry}>Retry</button>}
        </div>,
      );
    }
  });
  const generated = new Set(run.steps.flatMap((step) => step.shots.filter((shot) => REPORT_RETURNED_STATUSES.has(shot.status)).map((shot) => shot.shotId))).size;
  const cancelled = run.status === "cancelled";
  // A completed run can lose every landing race to a newer frame without being empty or pending.
  const summary = [
    cancelled ? "Cancelled" : null,
    generated > 0 || (!cancelled && run.supersededShots === 0) ? `${generated} frame${generated === 1 ? "" : "s"} generated` : null,
    run.supersededShots > 0 ? `${run.supersededShots} newer frame${run.supersededShots === 1 ? "" : "s"} kept` : null,
  ].filter(Boolean).join(" · ");
  // Reconciled failures stay in the history, but a successful retry needs no more attention.
  const needsAttention = !cancelled && run.steps.some((step) => step.shots.some((shot) => REPORT_FAILURE_STATUSES.has(shot.status)));
  return (
    <details className="fy-chat__runsummary" data-state={cancelled ? "cancelled" : needsAttention ? "attention" : generated > 0 || run.supersededShots > 0 ? "complete" : "pending"} open={needsAttention || (!cancelled && run.status !== "completed") ? true : undefined}>
      <summary><span aria-hidden="true" />{summary}{needsAttention ? " · needs attention" : ""}</summary>
      <div className="fy-chat__runreport" aria-label="Frame run report">
        {stepRows}
        {failureRows}
      </div>
    </details>
  );
}

function frameRunFailureCopy(state: { status: string; failureClass: string | null; error: string | null }): string {
  if (state.failureClass === "provider-fault") return state.error === null ? "provider fault · lane held" : `${state.error} · lane held`;
  if (state.failureClass === "offline") {
    // Offline holds the lane only while the job is still queued or running. The report names
    // shots that have already failed, and a job that gave up after its last attempt is terminal
    // with nothing paused behind it — so "lane held" here promised a resume that was never
    // coming (issue 697). Provider-fault keeps the suffix: a credential rejection pauses the
    // lane even as it terminalizes the job.
    const held = state.status === "queued" || state.status === "submitting" || state.status === "running";
    if (!held) return state.error ?? "offline";
    return state.error === null ? "offline · lane held" : `${state.error} · lane held`;
  }
  if (state.failureClass === "terminal") return state.error ?? "the provider refused this request";
  return state.error ?? "came back dark";
}

