import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, type NavigateFunction } from "react-router";
import type {
  ConversationActionCard,
  FrameRunState,
  ManifestModel,
  StagedProposal,
  WorldChatContext,
  WorldChatPoint,
  WorldChatStatus,
  WorldChatSubject,
  WorldChatWorkspace,
} from "@arke-studio/contracts";
import { modelEligible, proposalDecisionOf, providerModelId, PROVIDERS } from "@arke-studio/contracts";
import { Composer } from "./composer.js";
import {
  cancelWorldChat,
  createWorldChat,
  decideConversationAction,
  frameRunCommand,
  listHarnessModels,
  rejectWorldChatPoint,
  restoreBible,
  saveWorldChatPoint,
  openWorldChat,
  openWorldChatMedia,
  retryWorldChatTurn,
  sendWorldChat,
  setProductionModel,
  subscribeWorldChatMediaOpened,
  subscribeConversationActionDecision,
  useStore,
  useWorldChatProgress,
  useWorldChatWrapUpRefusal,
  worldChatAttachFiles,
  promoteWorldChatAttachment,
  wrapUpWorldChat,
} from "../lib/store.js";
import { eligibilityInputs, productionModel } from "./dispatch-bar.js";
import { Working } from "./working.js";
import { ConnectedProposalPanel } from "../domain/connected.js";
import { Button, IconButton, cx } from "./ui.js";
import { Pin } from "./icons.js";
import { ReadAloud } from "./read-aloud.js";
import { mediaUrl } from "../lib/media.js";

/**
 * One conversation, drawn once (design turn 86).
 *
 * World Chat has a screen built around a conversation — a history rail, a points panel, wrap-up.
 * Production Chat has a *view* built around one, where the same turns sit beside what they are
 * shaping. Both need the transcript itself to look and behave identically, and two renderings of
 * one conversation drift the moment either is touched: a receipt style fixed here, a failure
 * that offers a retry there.
 *
 * So the transcript is this component and nothing else. What surrounds it — what is loaded, what
 * is staged, where the composer sits — belongs to the screen, because that is exactly what
 * differs between them.
 */
export function ConversationTranscript({
  workspace,
  running,
  progress,
  failure,
  canRetry,
  onStop,
  onRetry,
  onUndoBible,
  frameRuns = [],
  onSelectShot,
  shotLabel,
  empty,
}: {
  workspace: WorldChatWorkspace | null;
  running: boolean;
  progress: string | null;
  failure: { turnId: string; status: string; detail?: string } | null;
  /** Retrying is saying something again, so it is held back while a wrap-up runs. */
  canRetry: boolean;
  onStop?: () => void;
  onRetry?: (turnId: string) => void;
  onUndoBible?: (fromVersion: number) => void;
  frameRuns?: readonly FrameRunState[];
  onSelectShot?: (shotId: string) => void;
  /** Names a shot for the report card; the run state carries ids, and only the screen has numbers. */
  shotLabel?: (shotId: string) => string;
  /** What stands in for the transcript before anything has been said. */
  empty?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const worldId = useStore().state?.world?.meta.worldId;
  const messages = workspace?.messages ?? [];
  const visibleTurns = new Set(messages.filter((message) => message.role === "studio").map((message) => message.turnId));
  // The message window is bounded; outstanding decisions and running work must stay reachable.
  const olderActions = (workspace?.actions ?? []).filter((action) =>
    !visibleTurns.has(action.turnId) &&
    ["pending", "approved", "awaiting-host", "queued", "running", "stale"].includes(action.status),
  );
  if (messages.length === 0 && olderActions.length === 0 && !running && !failure && empty) {
    return (
      <div className="fy-chat__transcript" aria-live="polite">
        {empty}
      </div>
    );
  }
  return (
    <div className="fy-chat__transcript" aria-live="polite">
      {olderActions.length > 0 && (
        <div className="fy-chat__turn fy-chat__turn--studio fy-chat__turn--action" aria-label="Earlier actions">
          {olderActions.map((action) => (
            <ConversationPermissionCard key={action.actionId} action={action} conversationSeq={workspace?.seq ?? 0} />
          ))}
        </div>
      )}
      {messages.map((m) => {
        const actions = m.role !== "studio" || m.turnId === undefined
          ? []
          : (workspace?.actions ?? []).filter((action) => action.turnId === m.turnId);
        return (
        <div
          key={m.id}
          className={cx(
            "fy-chat__turn",
            `fy-chat__turn--${m.role}`,
            actions.length > 0 && "fy-chat__turn--action",
            // Arke's replies are long and are prose somebody may want read back rather than read
            // (issue 857). The host is the turn, so the speaker appears under the whole reply.
            m.role === "studio" && "fy-texthost",
          )}
        >
          <div className="fy-chat__bubble">
            {m.text}
            {m.role === "studio" && m.receipts.length > 0 && (
              // One tick for the row, not one per receipt: the tick means "this is what was
              // read", and repeating it turned a footnote into a checklist.
              <div className="fy-chat__receipts">{`✓ ${m.receipts.join(" · ")}`}</div>
            )}
            {m.role === "studio" && m.refusals.length > 0 && (
              // Inside the bubble, under the reply it contradicts. A turn that says it ran a
              // command it was refused reads as wrong only if the refusal is right there
              // (issue 506); the same line a scroll away would never be joined up.
              <div className="fy-chat__refusals">{`✕ Refused: ${m.refusals.join(" · ")}`}</div>
            )}
          </div>
          {/* Only Arke's replies: nobody needs their own sentence spoken back to them. */}
          {m.role === "studio" && workspace !== null && (
            <ReadAloud
              source={{ of: "reply", conversationId: workspace.conversationId, messageId: m.id }}
              title="Arke"
              text={m.text}
            />
          )}
          {/*
            Outside the bubble, because it is not something the Studio said — it is something it
            did, to a file, already. The rail beside this transcript holds what is waiting for a
            yes; this is the opposite kind of thing, and it needs to look like it (master §4.5).
          */}
          {m.bibleEdit && (
            <div className="fy-biblecard">
              <p className="fy-biblecard__text">
                <span className="fy-biblecard__what">Edited your bible · {m.bibleEdit.headings.join(", ")}</span>{" "}
                <span className="fy-mono">
                  v{m.bibleEdit.fromVersion} → v{m.bibleEdit.toVersion}
                </span>
              </p>
              <Button variant="ghost" onClick={() => onUndoBible?.(m.bibleEdit!.fromVersion)}>
                Undo
              </Button>
            </div>
          )}
          {m.benchOutcome && (
            /*
             * The same card as a frame run's report: a filed take is one more thing that came
             * back, and the shot is the whole of what a person needs to find it — the id under
             * the number only ever said which record, which nobody reads a transcript for.
             */
            <div className="fy-chat__runreport" aria-label="Filed production takes">
              {m.benchOutcome.rows.map((row) => (
                <div key={row.shotId} className="fy-chat__runreport-row" data-kind="filed" data-state="complete">
                  <button
                    type="button"
                    onClick={() => {
                      if (worldId === undefined) return;
                      void navigate(
                        `/w/${worldId}/p/${m.benchOutcome!.productionId}/scenes/${m.benchOutcome!.sceneId}?shot=${row.shotId}`,
                      );
                    }}
                  >
                    <span className="fy-chat__runreport-dot" aria-hidden="true" />
                    <span className="fy-chat__runreport-key">shot {row.shotNumber}</span>
                    {/* A filed still carries its artifact; a clip has only the take behind it. */}
                    <span>{row.artifactId === undefined ? "clip filed" : "frame filed"}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          {m.frameRunOutcome && (
            <FrameRunReport
              run={frameRuns.find((candidate) =>
                candidate.run.id === m.frameRunOutcome!.runId &&
                candidate.productionId === m.frameRunOutcome!.productionId &&
                candidate.run.sceneId === m.frameRunOutcome!.sceneId,
              ) ?? null}
              worldId={worldId}
              productionId={m.frameRunOutcome.productionId}
              sceneId={m.frameRunOutcome.sceneId}
              navigate={navigate}
              onSelectShot={onSelectShot}
              {...(shotLabel === undefined ? {} : { shotLabel })}
            />
          )}
          {actions.map((action) => (
            <ConversationPermissionCard
              key={action.actionId}
              action={action}
              conversationSeq={workspace?.seq ?? 0}
            />
          ))}
        </div>
        );
      })}
      {/*
        The turn in flight, where its reply will be. In the transcript rather than on the composer
        because that is where the answer is going to appear, and it is where the eye already is
        after sending.
      */}
      {running && <Working label={progress} startedAt={workspace?.runStartedAt ?? null} {...(onStop ? { onStop } : {})} />}
      {/*
        A turn that failed says so where the reply would have been. Silence here is
        indistinguishable from never having asked, which is how a two-minute timeout reads as
        "nothing happens".
      */}
      {failure && !running && (
        <div className="fy-chat__failed" role="status">
          <div className="fy-chat__failedtext">{failureLine(failure)}</div>
          {canRetry && onRetry && (
            <button type="button" className="fy-chat__retry" onClick={() => onRetry(failure.turnId)}>
              Try that again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const ACTION_STATUS: Record<ConversationActionCard["status"], string> = {
  pending: "Needs your decision",
  approved: "Approved",
  "awaiting-host": "Waiting for you",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  denied: "Denied",
  stale: "Needs a fresh review",
  superseded: "Replaced",
};

const DECIDABLE_CARD_FAMILIES = new Set([
  "authored-diff",
  "command",
  "destructive",
  "take-review",
  "generation",
  "host-action",
  "setting",
]);

export function ConversationPermissionCard({
  action,
  conversationSeq,
}: {
  action: ConversationActionCard;
  conversationSeq: number;
}) {
  const { state } = useStore();
  const navigate = useNavigate();
  const card = useRef<HTMLElement>(null);
  const request = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const supported = DECIDABLE_CARD_FAMILIES.has(action.shown.body.family);
  const terminal = ["completed", "failed", "cancelled", "denied", "stale", "superseded"].includes(action.status);

  useEffect(
    () => subscribeConversationActionDecision((answer) => {
      if (answer.requestId !== request.current || answer.actionId !== action.actionId) return;
      request.current = null;
      setBusy(false);
      setAnnouncement(
        answer.disposition === "recorded"
          ? `${action.shown.title}: ${answer.decision === "approve" ? "approved" : "denied"}.`
          : answer.detail ?? `${action.shown.title} could not be decided.`,
      );
      requestAnimationFrame(() => card.current?.focus());
    }),
    [action.actionId, action.shown.title],
  );

  const decide = (decision: "approve" | "deny") => {
    const expectedStatus = action.status === "stale" ? "stale" : "pending";
    const sent = decideConversationAction(
      action.worldId,
      action.conversationId,
      action.actionId,
      conversationSeq,
      expectedStatus,
      decision,
    );
    if (sent === null) {
      setAnnouncement("The decision could not be sent.");
      return;
    }
    request.current = sent;
    setBusy(true);
    setAnnouncement("");
  };

  const stageRequest = state?.stageConstructionRequests?.find(request=>request.actionId===action.actionId&&request.conversationId===action.conversationId);
  const body = <ConversationActionBody action={action} supported={supported} />;
  const consequences = action.shown.ripples.length > 0 ? (
    <div className="fy-actioncard__body">
      <strong>Consequences</strong>
      <ul>{action.shown.ripples.map((ripple) => <li key={ripple}>{ripple}</li>)}</ul>
    </div>
  ) : null;
  return (
    <article
      ref={card}
      tabIndex={-1}
      className="fy-actioncard"
      data-status={action.status}
      aria-label={`${action.shown.title}, ${ACTION_STATUS[action.status]}`}
    >
      <div className="fy-actioncard__head">
        <div>
          <div className="fy-actioncard__reason">{action.shown.permissionReason.replaceAll("-", " ")}</div>
          <h3>{action.shown.title}</h3>
        </div>
        <span className="fy-actioncard__status">{ACTION_STATUS[action.status]}</span>
      </div>
      <p className="fy-actioncard__consequence">{action.shown.consequence}</p>
      {terminal ? (
        <details className="fy-actioncard__details">
          <summary>Review details</summary>
          {body}
          {consequences}
        </details>
      ) : <>{body}{consequences}</>}
      {action.statusDetail && <p className="fy-actioncard__notice">{action.statusDetail}</p>}
      {action.blockedReason && <p className="fy-actioncard__notice">{action.blockedReason}</p>}
      {action.decision && (
        <div className="fy-actioncard__audit">
          {action.decision.actorId === "local-user" ? "You" : action.decision.actorId}
          {` · ${action.decision.decision === "approve" ? "approved" : "denied"} · ${action.decision.decidedAt}`}
        </div>
      )}
      {action.receipt && (
        <div className="fy-actioncard__receipt">
          <strong>Result</strong>
          <span>{action.receipt.summary}</span>
          {action.receipt.generation && state?.world ? (
            <div className="fy-actioncard__body">
              <p>
                {action.receipt.generation.completed} completed · {action.receipt.generation.failed} failed · {action.receipt.generation.cancelled} cancelled · {action.receipt.generation.unattempted} unattempted
              </p>
              <p>Actual cost: {action.receipt.generation.actualMicroUsd === null ? "Not reported" : `$${(action.receipt.generation.actualMicroUsd / 1_000_000).toFixed(4)}`}</p>
              {action.receipt.generation.results.map((result) => (
                <div key={result.id} className="fy-actioncard__line">
                  {result.status === "completed" && result.mediaPath ? (
                    result.medium === "image" ? (
                      <a href={mediaUrl(state.world!.meta.slug, result.mediaPath)} aria-label={`Open ${result.description}`}>
                        <img className="fy-actioncard__media" src={mediaUrl(state.world!.meta.slug, result.mediaPath)} alt={result.description} />
                      </a>
                    ) : result.medium === "video" ? (
                      <video className="fy-actioncard__media" controls preload="metadata" src={mediaUrl(state.world!.meta.slug, result.mediaPath)} {...(result.posterPath ? { poster: mediaUrl(state.world!.meta.slug, result.posterPath) } : {})} />
                    ) : result.medium === "audio" ? (
                      <audio className="fy-actioncard__media" controls preload="metadata" src={mediaUrl(state.world!.meta.slug, result.mediaPath)} />
                    ) : (
                      <a href={mediaUrl(state.world!.meta.slug, result.mediaPath)}>Open {result.medium}</a>
                    )
                  ) : null}
                  <strong>{result.description}</strong>
                  <span>{result.status}{result.detail ? ` · ${result.detail}` : ""}</span>
                </div>
              ))}
            </div>
          ) : null}
          {action.receipt.kind === "bench-session" && state?.world ? (
            <Button variant="ghost" onClick={() => void navigate(`/w/${state.world!.meta.worldId}/artifacts/bench/${action.receipt!.id}`)}>
              Open Bench
            </Button>
          ) : null}
        </div>
      )}
      {action.status === "awaiting-host" && stageRequest ? <Button variant="primary" onClick={()=>void navigate(`/w/${action.worldId}/p/${stageRequest.productionId}/scenes/${stageRequest.sceneId}`)}>Open Stage to construct</Button>:null}
      {action.undo && <div className="fy-actioncard__audit">Undo available · {action.undo.kind}</div>}
      {supported && (action.status === "pending" || action.availableDecisions.includes("deny")) && (
        <div className="fy-actioncard__actions">
          {action.status === "pending" && <Button
            variant="primary"
            disabled={busy || !action.availableDecisions.includes("approve")}
            onClick={() => decide("approve")}
          >
            {busy ? "Deciding…" : "Approve"}
          </Button>}
          {action.availableDecisions.includes("deny") && <Button
            variant="ghost"
            disabled={busy || !action.availableDecisions.includes("deny")}
            onClick={() => decide("deny")}
          >
            Deny
          </Button>}
        </div>
      )}
      {(action.status === "queued" || action.status === "running") && action.shown.body.family === "generation" && action.shown.body.cancellationSupported && state?.world ? (
        <div className="fy-actioncard__actions">
          <Button variant="ghost" onClick={() => void navigate(`/w/${state.world!.meta.worldId}/artifacts/bench/${action.authority.id}`)}>
            Manage or cancel in Bench
          </Button>
        </div>
      ) : null}
      {!supported && (
        <p className="fy-actioncard__unsupported">This card type is not available in this version. Nothing can be approved.</p>
      )}
      <div className="fy-actioncard__live" aria-live="assertive" role="status">{announcement}</div>
    </article>
  );
}

function ConversationActionBody({ action, supported }: { action: ConversationActionCard; supported: boolean }) {
  const { state } = useStore();
  const body = action.shown.body;
  if (!supported) return null;
  switch (body.family) {
    case "authored-diff":
      return <div className="fy-actioncard__body">
        {body.fields.map((field) => <div key={field.label} className="fy-actioncard__change">
          <strong>{field.label}</strong>
          <span className="fy-actioncard__before">{field.before ?? "Not set"}</span>
          <span aria-hidden="true">→</span>
          <span>{field.after ?? "Removed"}</span>
        </div>)}
        {[...body.conflicts, ...body.openChoices].map((line) => <p key={line} className="fy-actioncard__notice">{line}</p>)}
      </div>;
    case "command":
      return <div className="fy-actioncard__body">
        {body.commands.map((command) => <div key={`${command.label}:${command.detail ?? ""}`} className="fy-actioncard__line"><strong>{command.label}</strong>{command.detail && <span>{command.detail}</span>}</div>)}
        <p>{body.expectedResult}</p>
      </div>;
    case "destructive":
      return <div className="fy-actioncard__body">
        <strong>Will remove</strong>
        <ul>{body.removed.map((item) => <li key={item}>{item}</li>)}</ul>
        {body.retained.length > 0 && <p>Retained: {body.retained.join(" · ")}</p>}
        {body.dependentChanges.length > 0 && <p>Dependent changes: {body.dependentChanges.join(" · ")}</p>}
        {body.blockers.map((line) => <p key={line} className="fy-actioncard__notice">{line}</p>)}
        <p>Undo {body.undoAvailable ? "available" : "not available"}</p>
      </div>;
    case "take-review":
      return <div className="fy-actioncard__body">
        {body.mediaPath && state?.world ? (
          body.mediaKind === "video" ? (
            <video
              className="fy-actioncard__media"
              controls
              preload="metadata"
              src={mediaUrl(state.world.meta.slug, body.mediaPath)}
              {...(body.posterPath ? { poster: mediaUrl(state.world.meta.slug, body.posterPath) } : {})}
            />
          ) : body.mediaKind === "audio" ? (
            <audio className="fy-actioncard__media" controls preload="metadata" src={mediaUrl(state.world.meta.slug, body.mediaPath)} />
          ) : body.mediaKind === "image" ? (
            <img className="fy-actioncard__media" src={mediaUrl(state.world.meta.slug, body.mediaPath)} alt={`Take ${body.mediaId}`} />
          ) : (
            <a href={mediaUrl(state.world.meta.slug, body.mediaPath)}>Open source document</a>
          )
        ) : null}
        <p>{body.mediaKind} · {body.destination}</p>
        {body.scene && <p>Scene: {body.scene}</p>}
        {body.shot && <p>Shot: {body.shot}</p>}
        <p>Current selection: {body.currentSelection ?? "None"}</p>
        {body.reason && <p>{body.reason}</p>}
        {body.rejectionCitation && (
          <p>Cites {body.rejectionCitation.sheet} · {body.rejectionCitation.field}{body.rejectionCitation.note ? ` · ${body.rejectionCitation.note}` : ""}</p>
        )}
        {(body.reviewHistory ?? []).length > 0 && <><strong>Review history</strong><ul>{(body.reviewHistory ?? []).map((line) => <li key={line}>{line}</li>)}</ul></>}
      </div>;
    case "host-action":
      return <div className="fy-actioncard__body"><strong>{body.action}</strong><p>{body.effect}</p></div>;
    case "setting":
      return <div className="fy-actioncard__body"><div className="fy-actioncard__change"><strong>{body.setting}</strong><span className="fy-actioncard__before">{body.current ?? "Not set"}</span><span aria-hidden="true">→</span><span>{body.proposed ?? "Not set"}</span></div>{body.consequences.map((line) => <p key={line}>{line}</p>)}</div>;
    case "generation":
      return <div className="fy-actioncard__body">
        <div className="fy-actioncard__line"><strong>{body.medium}</strong><span>{body.purpose}</span></div>
        <p><strong>Destination</strong> · {body.output}</p>
        <p>{body.prompt}</p>
        {(body.exclusions ?? []).length > 0 && <p>Exclusions: {(body.exclusions ?? []).join(" · ")}</p>}
        {body.references.length > 0 && <p>References: {body.references.map((reference) => `${reference.id} · ${reference.role}`).join("; ")}</p>}
        <p>{body.provider} · {body.model} · {body.quantity} output{body.quantity === 1 ? "" : "s"}</p>
        {(body.options ?? []).length > 0 && <p>Options: {(body.options ?? []).map((option) => `${option.label}: ${option.value}`).join(" · ")}</p>}
        {(body.dimensions || body.durationSec) && <p>{[body.dimensions, body.durationSec ? `${body.durationSec}s` : null].filter(Boolean).join(" · ")}</p>}
        {body.audioPolicy && <p>Audio: {body.audioPolicy}</p>}
        {(body.deterministicInputs ?? []).length > 0 && <p>Frozen inputs: {(body.deterministicInputs ?? []).join(" · ")}</p>}
        {(body.privacy ?? []).map((line) => <p key={line}>{line}</p>)}
        <p>{body.cost}</p>
        {body.quoteDigest && <p>Quote digest: {body.quoteDigest}</p>}
        {body.quoteExpiresAt && <p>Quote expires: {body.quoteExpiresAt}</p>}
        {body.enforceableCapMicroUsd !== undefined && <p>Enforceable cap: ${(body.enforceableCapMicroUsd / 1_000_000).toFixed(4)}</p>}
        {body.estimateMayVary && <p className="fy-actioncard__notice">Estimate only. Actual provider cost may differ.</p>}
      </div>;
  }
}

const REPORT_FAILURE_STATUSES = new Set(["failed", "missing", "needs-reconciliation"]);
/** What actually came back: a frame filed by the run, or one reconciled from a job it lost sight of. */
const REPORT_RETURNED_STATUSES = new Set(["succeeded", "reconciled"]);

function FrameRunReport({
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
  return (
    <div className="fy-chat__runreport" aria-label="Frame run report">
      {stepRows}
      {failureRows}
    </div>
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

/**
 * Why a turn ended without a reply, in the words the screen can say out loud.
 *
 * A rejected answer is not a failed request, and telling somebody "that did not go through" when
 * the studio answered and the gate refused the answer sends them to press retry against a
 * refusal that will repeat. Found by driving (2026-08-21): two season turns died on an
 * unverifiable quotation and the screen offered nothing but "try again".
 */
export function failureLine(failure: { status: string; detail?: string }): string {
  const rejected = failure.detail?.startsWith("rejected: ") === true;
  if (rejected) {
    return `The studio answered and the answer was refused — ${failure.detail!.slice("rejected: ".length)}. Your message is still here; asking a different way usually gets past it.`;
  }
  const opening =
    failure.status === "timeout"
      ? "That took too long and stopped."
      : failure.status === "budget-exceeded"
        ? "That turn ran past its budget and stopped."
        : "That did not go through.";
  return `${opening} Nothing was lost — your message is still here.`;
}

/**
 * What a chip says about a file, beyond its name.
 *
 * Three states and two of them are marked. A file the chat cannot open says so, because a chip
 * that looks attached while the reply cannot see it is the worst of the three. A PDF or a Word
 * file says "text only": the words came through and the pictures, tables and layout did not,
 * which somebody who attached a deck for its images needs to know before they ask about one.
 */
export function attachmentChipLabel(attachment: { fileName: string; readability: string; promoted?: boolean }): string {
  const state = [
    ...(attachment.readability === "not-readable" ? ["not readable in chat"] : []),
    ...(attachment.readability === "extracted-text-available" ? ["text only"] : []),
    ...(attachment.promoted === true ? ["filed in world"] : []),
  ];
  return state.length > 0 ? `${attachment.fileName} · ${state.join(" · ")}` : attachment.fileName;
}

/**
 * A conversation's title, from the first thing said in it (design turn 95).
 *
 * The wire caps a title at 200 characters, and a frame that breaks its schema is dropped without
 * a word — so an opening message longer than that vanished: composer cleared, no conversation, no
 * error, nothing on disk. Anything a person types is a plausible opening, and 200 characters is
 * about two sentences, so this was reachable by saying one ordinary paragraph.
 */
export function conversationTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // The wire refuses an empty title and drops the frame without a word, so this function is
  // total (review 2026-08-22): whitespace in, a real name out.
  if (flat === "") return "New conversation";
  if (flat.length <= 200) return flat;
  // Break at a word so the label reads as a clipped sentence rather than a severed one.
  const cut = flat.slice(0, 199);
  const space = cut.lastIndexOf(" ");
  return (space > 120 ? cut.slice(0, space) : cut) + "…";
}

/** Why a production language choice cannot run, without choosing another model in its place. */
export function languageChoiceReason(
  state: ReturnType<typeof useStore>["state"],
  modelId: string | undefined,
  model?: ManifestModel,
): string | undefined {
  if (modelId === undefined) return undefined;
  if (model === undefined) return `This production still names ${modelId}, which is no longer available.`;
  if ((state?.app.models.disabled ?? []).includes(model.id)) {
    return `${model.displayName} is turned off in AI models and has not been replaced.`;
  }
  if (PROVIDERS[model.provider].local && !modelEligible(model, eligibilityInputs(state))) {
    return `${model.displayName} is unavailable and has not been replaced.`;
  }
  if (state?.app.harnessInfo?.generation === "claude" && model.provider !== "anthropic") {
    return `${model.displayName} is not available through Claude Code.`;
  }
  const harnessModels = state?.app.harnessModels ?? [];
  if (
    harnessModels.length > 0 &&
    !harnessModels.some(
      (candidate) => candidate.provider === model.provider && candidate.id === providerModelId(model),
    )
  ) {
    return `${model.displayName} is not available through the current harness.`;
  }
  return undefined;
}

/**
 * The production's own thread — Production Chat, and its episode and scene kin (turns 86, 89).
 *
 * One continuous conversation per production (SPEC-023 R-20), so every view here enters the same
 * thread with its own subject in focus. The first message creates it — a person should not have
 * to make a conversation before they can say anything — and it is opened on arrival and released
 * on the way out, so a session that visits every view still holds one workspace.
 */
export function ProductionConversation({
  worldId,
  productionId,
  placeholder,
  eyebrow,
  heading,
  emptyLine,
  footer,
  pointsEmpty,
  entry,
  openingNote,
  side,
  openWith,
  dock,
  onSelectShot,
  subject,
}: {
  worldId: string | undefined;
  productionId: string | undefined;
  placeholder: string;
  eyebrow?: string;
  heading?: string;
  /** What stands where the transcript will be, before anything has been said. */
  emptyLine: string;
  footer?: React.ReactNode;
  /** What the understanding rail says before there is any. */
  pointsEmpty?: string;
  /**
   * Which thread this view enters. The production's own by default; an episode or a scene names
   * itself, because the coordinator gives each context its own briefing (R-20) and a message about
   * episode 3 sent into the season's thread arrives with the wrong thing in focus.
   */
  entry?: WorldChatContext;
  /** What the placeholder bubble calls this thread while its workspace loads. */
  openingNote?: string;
  /**
   * What sits beside the transcript instead of the points. The rail has two states and never both
   * at once (turn 91): while talking it is what the conversation understood; once a proposal is
   * staged it is that proposal, under one Accept. A screen showing both would be claiming a point
   * is a proposal, which is the promise the gate exists to keep.
   */
  side?: React.ReactNode;
  /**
   * An opening line typed somewhere else — day one's box — handed over to be said here. It is
   * said rather than merely titled: creating a conversation does not take a turn, so a screen
   * that only creates leaves the first thing a person said unanswered (turn 95).
   */
  openWith?: string;
  /**
   * Docked beside the thing it is about, rather than filling a screen of its own (turns 99, 100).
   * The subject goes in the panel's head, the transcript takes the height, and what would be the
   * side rail — a staged proposal, or the understanding and its wrap-up — sits in a strip above
   * the composer. There is no room for a rail beside a 360px column, and no need for one: the
   * change a proposal makes is drawn on the page beside it.
   */
  dock?: {
    title: string;
    subject: string;
    thumbnail?: { src: string; alt: string };
    conversationFirst?: boolean;
    /** Puts the assistant away. The head draws its pin only when there is somewhere to go. */
    onPutAway?: () => void;
    /** Flips the subject between the shot and the whole scene; the title is a button when set. */
    onToggleSubject?: () => void;
    /** Quick asks above the composer, each said as it stands. */
    /**
     * Quick asks. A prompt that promises a reply and nothing else (turn 128: `Hold this against
     * the style`) says so, and the send carries it, so the coordinator refuses any action the
     * turn comes back with.
     */
    prompts?: readonly (string | { label: string; replyOnly?: boolean })[];
    /**
     * Said before whatever is typed while a shot is the subject. The thread enters at the scene,
     * so the shot the dock names has to be in the words themselves or the studio never hears it.
     */
    subjectPrefix?: string;
    /**
     * A line over the prompts that says what the subject is right now — `about this passage ·
     * 42 words` (turn 128). The prefix is what the thread hears; this is what the author sees.
     */
    subjectLine?: string;
    /** Names a shot for the report card; the run state carries ids, and only the screen has numbers. */
    shotLabel?: (shotId: string) => string;
    /**
     * The line under the composer. The default promises that talking changes nothing; a dock
     * that offers a direct write — the scene's name (SPEC-036 R-38) — must say so instead, or
     * the promise is false the moment the offer is taken.
     */
    note?: string;
  };
  onSelectShot?: (shotId: string) => void;
  /** What is selected on the timeline while they talk (SPEC-039 R-26), sent with each turn. */
  subject?: WorldChatSubject;
}) {
  const { state } = useStore();
  const navigate = useNavigate();
  const [message, setMessage] = useState("");
  const [languageModelId, setLanguageModelId] = useState<string | undefined>();
  /*
   * Wrap-up state lives here rather than inside WrapUp (review 2026-08-22): retry is a way of
   * saying something again, so it is held back while a wrap-up commits — a condition the
   * transcript needs and a child's local state could not express.
   */
  /*
   * Which subject is waiting, not whether something is (codex, 2026-08-23).
   *
   * A boolean here belonged to the dock, and the dock outlives the subject under it: one thread
   * serves the production, its episodes and its scenes. Wrapping episode A and walking to B
   * carried A's wait onto B's button; resetting on arrival then lost it when you walked back to A
   * while it was still committing. A single key fixed both and still lost A's wait the moment B
   * was wrapped too, because wrap-ups on different subjects genuinely do run at once — the
   * coordinator has no idea these are the same dock. A set says what is true: each wait shows on
   * the subject it was started from, survives leaving and returning, and outlives the next one.
   */
  const [wrappingKeys, setWrappingKeys] = useState<ReadonlySet<string>>(() => new Set());
  /** An opening message waiting for the conversation it opened to arrive. */
  const [opening, setOpening] = useState<{
    text: string;
    was: string | null;
    subject?: WorldChatSubject;
    modelId?: string;
    replyOnly?: boolean;
  } | null>(null);
  const [busyMedia, setBusyMedia] = useState<string | null>(null);
  const [mediaRefusal, setMediaRefusal] = useState<string | null>(null);
  const mediaRequest = useRef<{ requestId: string; candidateId: string; conversationId: string } | null>(null);
  const context: WorldChatContext = entry ?? { kind: "production", productionId: productionId ?? "" };
  const contextKey = JSON.stringify(context);
  const wrapping = wrappingKeys.has(contextKey);
  const setWrapping = (next: boolean) =>
    setWrappingKeys((keys) => {
      if (keys.has(contextKey) === next) return keys;
      const out = new Set(keys);
      if (next) out.add(contextKey);
      else out.delete(contextKey);
      return out;
    });
  /*
   * Navigating between subjects reuses this mounted component (episode 3 → episode 4), and an
   * unsent draft typed against one subject must not be sent into the other's thread
   * (review 2026-08-22). The handover latch resets with it, for the same reason.
   */
  useEffect(() => {
    setMessage("");
    setLanguageModelId(undefined);
    setOpening(null);
    setBusyMedia(null);
    setMediaRefusal(null);
    mediaRequest.current = null;
  }, [contextKey]);
  useEffect(() => {
    if (state?.app.health.harness.status === "healthy" && state.app.harnessInfo?.generation !== "claude") {
      listHarnessModels();
    }
  }, [state?.app.health.harness.status, state?.app.harnessInfo?.generation]);
  const rememberedLanguageModel = productionModel(state, productionId, "llm");
  const effectiveLanguageModelId = languageModelId ?? rememberedLanguageModel;
  const languageModels = state?.app.manifest?.models.filter((model) => model.capability === "llm") ?? [];
  const languageModel = languageModels.find((model) => model.id === effectiveLanguageModelId);
  const languageUnavailableReason = languageChoiceReason(state, effectiveLanguageModelId, languageModel);
  const thread = useMemo(() => {
    const wanted = JSON.parse(contextKey) as WorldChatContext;
    const rows = (state?.world?.conversations ?? []).filter((c) => sameContext(c.entryContext, wanted));
    return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }, [state?.world?.conversations, contextKey]);
  const conversationId = thread?.id ?? null;

  useEffect(
    () =>
      subscribeWorldChatMediaOpened((answer) => {
        if (
          answer.requestId !== mediaRequest.current?.requestId ||
          answer.conversationId !== mediaRequest.current.conversationId ||
          answer.worldId !== worldId
        ) return;
        mediaRequest.current = null;
        setBusyMedia(null);
        if (answer.sessionId) {
          setMediaRefusal(null);
          void navigate(`/w/${worldId}/artifacts/bench/${answer.sessionId}`);
        } else {
          setMediaRefusal(answer.reason ?? "The Bench could not be prepared.");
        }
      }),
    [navigate, worldId],
  );

  const openMedia = (point: WorldChatPoint) => {
    if (!worldId || !conversationId || !point.media) return;
    if (point.media.sessionId) {
      void navigate(`/w/${worldId}/artifacts/bench/${point.media.sessionId}`);
      return;
    }
    const requestId = openWorldChatMedia(worldId, conversationId, point.id, point.revision);
    if (!requestId) return;
    mediaRequest.current = { requestId, candidateId: point.id, conversationId };
    setBusyMedia(point.id);
    setMediaRefusal(null);
  };

  useEffect(() => {
    if (!worldId || !conversationId) return;
    openWorldChat(worldId, conversationId);
    return () => openWorldChat(worldId, null);
  }, [worldId, conversationId]);

  const workspace = state?.worldChat ?? null;
  useEffect(() => {
    if (!opening || !worldId) return;
    const opened = workspace?.conversationId ?? null;
    if (!opened || opened === opening.was) return;
    sendWorldChat(worldId, opened, opening.text, [], opening.subject, opening.modelId, opening.replyOnly ?? false);
    setOpening(null);
  }, [opening, worldId, workspace?.conversationId]);
  const loaded = workspace && workspace.conversationId === conversationId ? workspace : null;
  const progress = useWorldChatProgress(conversationId ?? undefined, loaded?.runStartedAt ?? null);
  const running = loaded?.runStatus === "running";
  const failure = loaded?.lastFailure ?? null;

  /*
   * The handover fires once. `openWith` survives a re-render and a reload of this screen, so
   * without the latch a returning visit would say the same line again.
   */
  const handedOver = useRef(false);
  useEffect(() => {
    if (!openWith || handedOver.current || !worldId || !productionId) return;
    /*
     * The latch is a per-mount ref, but `openWith` rides in history state, which outlives the
     * mount — so Back onto this screen replayed the opening line as a fresh paid turn
     * (review 2026-08-22). A line already visible in the thread has been handed over, whatever
     * the ref remembers.
     */
    const alreadySaid = (loaded?.messages ?? []).some((m) => m.role === "user" && m.text === openWith);
    if (alreadySaid || thread?.title === conversationTitle(openWith)) {
      handedOver.current = true;
      return;
    }
    handedOver.current = true;
    if (conversationId) {
      sendWorldChat(worldId, conversationId, openWith, [], undefined, effectiveLanguageModelId);
      return;
    }
    setOpening({
      text: openWith,
      was: workspace?.conversationId ?? null,
      ...(effectiveLanguageModelId !== undefined ? { modelId: effectiveLanguageModelId } : {}),
    });
    createWorldChat(worldId, conversationTitle(openWith), crypto.randomUUID(), context);
    // context is derived from route params and rebuilt each render; the latch above is what
    // makes this safe to leave out of the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openWith, worldId, productionId, conversationId]);

  /** Says one thing into the thread — the composer's draft, or a quick ask said as it stands. */
  const say = (text: string, replyOnly = false) => {
    if (!text || !worldId || !productionId) return;
    // A second line said while the first is still opening its thread would open a second one,
    // and one said over a running turn starts a second turn the first can no longer stop.
    if (opening || running) return;
    /*
     * No thread yet: the first thing said opens one and is then said into it. Creating does not
     * take a turn — it only names the conversation — so without the send that follows, the
     * opening message became a title and the studio never answered it (turn 95).
     */
    if (!conversationId) {
      // The subject goes with it: the first thing said is the likeliest "move this earlier".
      setOpening({
        text,
        was: workspace?.conversationId ?? null,
        ...(subject !== undefined ? { subject } : {}),
        ...(effectiveLanguageModelId !== undefined ? { modelId: effectiveLanguageModelId } : {}),
        ...(replyOnly ? { replyOnly: true } : {}),
      });
      setLanguageModelId(undefined);
      createWorldChat(worldId, conversationTitle(text), crypto.randomUUID(), context);
      return;
    }
    sendWorldChat(worldId, conversationId, text, [], subject, effectiveLanguageModelId, replyOnly);
    setLanguageModelId(undefined);
  };
  const submit = () => {
    const text = message.trim();
    if (!text || !worldId || !productionId) return;
    // The field keeps its words while a thread is still opening; say() would drop them.
    if (opening) return;
    setMessage("");
    const prefix = dock?.subjectPrefix;
    say(prefix === undefined ? text : `${prefix} ${text}`);
  };

  const points = loaded?.points ?? [];
  const carriedPoints = points.filter((p) => p.kind === "point" && p.settled).length;
  /*
   * Every composer carries attach (turn 41's binding; review 2026-08-22 found this one did
   * not). Same wiring as World Chat: chips from the workspace, upload through the picker.
   * There is no held-attachment path here — a production thread exists before anything can be
   * dropped on it, and the first message creates it if not.
   */
  const attachChips = (loaded?.attachments ?? []).map((a) => ({
    id: a.id,
    file: attachmentChipLabel(a),
    kind: a.kind,
    promoted: a.promoted,
  }));
  const attachProps = {
    attachments: attachChips,
    ...(worldId && conversationId
      ? { onAttach: () => worldChatAttachFiles(worldId, conversationId) }
      : {}),
    ...(worldId && conversationId
      ? { onPromoteAttachment: (attachmentId: string) => promoteWorldChatAttachment(worldId, conversationId, attachmentId) }
      : {}),
  };
  const languageControl = productionId ? (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <select
        className="fy-set__pill"
        aria-label="Language model"
        value={effectiveLanguageModelId ?? ""}
        onChange={(event) => setLanguageModelId(event.target.value || undefined)}
      >
        {rememberedLanguageModel === undefined && <option value="">whatever the harness is set to</option>}
        {effectiveLanguageModelId !== undefined && languageModel === undefined && (
          <option value={effectiveLanguageModelId}>{effectiveLanguageModelId} · unavailable</option>
        )}
        {languageModels.map((model) => (
          <option key={`${model.provider}/${model.id}`} value={model.id}>
            {model.displayName}
          </option>
        ))}
      </select>
      <span className="fy-mono">
        {languageModelId !== undefined
          ? "THIS TURN"
          : rememberedLanguageModel !== undefined
            ? "THIS PRODUCTION"
            : "HARNESS DEFAULT"}
      </span>
      {languageModelId !== undefined && languageModelId !== rememberedLanguageModel && worldId && (
        <button
          type="button"
          className="fy-set__link"
          onClick={() => {
            setProductionModel(worldId, productionId, "llm", languageModelId);
            setLanguageModelId(undefined);
          }}
        >
          Remember for this production
        </button>
      )}
    </div>
  ) : null;
  const transcript = (
    <ConversationTranscript
      workspace={loaded}
      running={running}
      progress={progress}
      failure={failure && !running ? failure : null}
      canRetry={!wrapping}
      frameRuns={state?.frameRuns ?? []}
      onSelectShot={onSelectShot}
      {...(dock?.shotLabel === undefined ? {} : { shotLabel: dock.shotLabel })}
      {...(worldId && conversationId ? { onStop: () => cancelWorldChat(worldId, conversationId) } : {})}
      {...(worldId && conversationId
        ? { onRetry: (turnId: string) => retryWorldChatTurn(worldId, conversationId, turnId) }
        : {})}
      {...(worldId
        ? {
            /* The bible card's Undo did nothing on every production-side thread (review
               2026-08-22): the button rendered unconditionally and this wrapper never passed
               the handler World Chat passes. */
            onUndoBible: (fromVersion: number) => restoreBible(worldId, fromVersion),
          }
        : {})}
      empty={
        thread ? (
          <div className="fy-bubble--user">
            {thread.title}
            <div className="fy-bubble__note">{openingNote ?? "opening…"}</div>
          </div>
        ) : (
          <div className="fy-bubble--gate">{emptyLine}</div>
        )
      }
    />
  );

  if (dock) {
    return (
      <aside
        className="fy-arke"
        data-dock="conversation"
        data-conversation-first={dock.conversationFirst ? "true" : undefined}
      >
        <div className="fy-arke__head">
          {/* The slot stays whether or not there is a frame to show in it, so the title does
              not shift left the moment the subject is the scene, a board, or a frameless shot. */}
          <span className="fy-arke__thumb">
            {dock.thumbnail === undefined ? null : <img src={dock.thumbnail.src} alt={dock.thumbnail.alt} />}
          </span>
          {dock.onToggleSubject === undefined ? (
            <span className="fy-arke__who">
              <span className="fy-arke__name">{dock.title}</span>
              <span className="fy-mono">{dock.subject}</span>
            </span>
          ) : (
            <button type="button" className="fy-arke__who" title="Switch between the shot and the whole scene" onClick={dock.onToggleSubject}>
              <span className="fy-arke__name">{dock.title}</span>
              <span className="fy-mono">{dock.subject}</span>
            </button>
          )}
          {dock.onPutAway === undefined ? null : (
            <IconButton className="fy-arke__pin" label="Unpin the assistant" onClick={dock.onPutAway}>
              <Pin size={13} />
            </IconButton>
          )}
        </div>
        <div className="fy-arke__log" aria-live="polite">
          {transcript}
        </div>
        {!dock.conversationFirst || side !== undefined || points.length > 0 || carriedPoints > 0 ? (
          <div className="fy-arke__strip">
            {side ?? (
            <>
              {/* The understanding is still here, put away rather than dropped: a column this
                  narrow cannot hold it open beside a transcript, and the wrap-up beneath it is
                  the only way a conversation becomes anything (turn 92). */}
              {pointsEmpty !== undefined && (!dock.conversationFirst || points.length > 0) && (
                <details className="fy-arke__points">
                  <summary>
                    What it understood <span className="fy-mono">{points.length > 0 ? points.length : "nothing yet"}</span>
                  </summary>
                  <ConversationPoints
                    points={points}
                    empty={pointsEmpty}
                    onMedia={openMedia}
                    busyId={busyMedia}
                    {...(worldId && conversationId
                      ? {
                          onSave: (point: WorldChatPoint) =>
                            saveWorldChatPoint(worldId, conversationId, point.id, point.revision),
                          onReject: (point: WorldChatPoint) =>
                            rejectWorldChatPoint(worldId, conversationId, point.id, point.revision),
                        }
                      : {})}
                  />
                  {mediaRefusal && <div className="fy-panel__mediawhy" role="status">{mediaRefusal}</div>}
                </details>
              )}
              {!dock.conversationFirst || carriedPoints > 0 ? (
                <WrapUp
                  worldId={worldId}
                  conversationId={conversationId}
                  seq={loaded?.seq ?? null}
                  carried={carriedPoints}
                  status={loaded?.status ?? null}
                  subjectKey={contextKey}
                  wrapping={wrapping}
                  onWrappingChange={setWrapping}
                />
              ) : null}
            </>
            )}
          </div>
        ) : null}
        <div className="fy-arke__foot">
          {languageControl}
          {dock.subjectLine !== undefined && <div className="fy-mono fy-arke__subject">{dock.subjectLine}</div>}
          {dock.prompts === undefined || dock.prompts.length === 0 ? null : (
            <div className="fy-arke__prompts">
              {dock.prompts.map((entry) => {
                const prompt = typeof entry === "string" ? entry : entry.label;
                const replyOnly = typeof entry === "string" ? false : entry.replyOnly === true;
                // A prompt is said with the subject before it, as a typed line is (turn 128):
                // `Tighten this` said bare names nothing, and the thread never sees the selection.
                return (
                  <button key={prompt} type="button" className="fy-arke__prompt" disabled={opening !== null || running || languageUnavailableReason !== undefined} onClick={() => say(dock.subjectPrefix === undefined ? prompt : `${dock.subjectPrefix} ${prompt}`, replyOnly)}>
                    {prompt}
                  </button>
                );
              })}
            </div>
          )}
          <Composer
            value={message}
            onChange={setMessage}
            onSubmit={submit}
            placeholder={placeholder}
            {...(dock.conversationFirst ? {} : { agentLabel: "story author" })}
            busy={running || opening !== null}
            busyLabel={opening !== null ? openingNote ?? "opening…" : "reading the world…"}
            disabledReason={languageUnavailableReason}
            onDictate={(text) => setMessage((prev) => (prev ? `${prev} ${text}` : text))}
            {...attachProps}
          />
          <div className="fy-mono">{dock.note ?? "talking changes nothing · a change waits for your yes"}</div>
        </div>
      </aside>
    );
  }

  const pane = (
    <div className="fy-story__chat">
      {(eyebrow || heading) && (
        <div className="fy-story__chathead">
          {eyebrow && <div className="fy-eyebrow-sm">{eyebrow}</div>}
          {heading && <h1 className="fy-story__h1">{heading}</h1>}
        </div>
      )}
      <div className="fy-story__log">
        {transcript}
      </div>
      <div style={{ flex: "none", padding: "14px 36px 22px" }}>
        {languageControl}
        <Composer
          value={message}
          onChange={setMessage}
          onSubmit={submit}
          placeholder={placeholder}
          agentLabel="story author"
          busy={running}
          busyLabel="reading the world…"
          disabledReason={languageUnavailableReason}
          onDictate={(text) => setMessage((prev) => (prev ? `${prev} ${text}` : text))}
          {...attachProps}
        />
        <div className="fy-mono" style={{ marginTop: 8 }}>
          talking changes nothing · wrap-up stages what you keep
        </div>
        {footer}
      </div>
    </div>
  );

  // A staged proposal takes the rail from the points; the two are never up together (turn 91).
  if (side !== undefined) {
    return (
      <>
        {pane}
        <div className="fy-story__side">{side}</div>
      </>
    );
  }
  if (pointsEmpty === undefined) return pane;
  return (
    <>
      {pane}
      <div className="fy-story__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>What it understood</div>
          <span className="fy-mono">{points.length > 0 ? `${points.length} so far` : "nothing yet"}</span>
        </div>
        <ConversationPoints
          points={points}
          empty={pointsEmpty}
          onMedia={openMedia}
          busyId={busyMedia}
          {...(worldId && conversationId
            ? {
                onSave: (point: WorldChatPoint) =>
                  saveWorldChatPoint(worldId, conversationId, point.id, point.revision),
                onReject: (point: WorldChatPoint) =>
                  rejectWorldChatPoint(worldId, conversationId, point.id, point.revision),
              }
            : {})}
        />
        {mediaRefusal && <div className="fy-panel__mediawhy" role="status">{mediaRefusal}</div>}
        {/* Every level has a wrap-up (turn 92). It was drawn on 89a from the start and built
            nowhere, which left the season — the first hop anybody walks — with no way to turn a
            conversation into anything at all. */}
        <WrapUp
          worldId={worldId}
          conversationId={conversationId}
          seq={loaded?.seq ?? null}
          carried={carriedPoints}
          status={loaded?.status ?? null}
          subjectKey={contextKey}
          wrapping={wrapping}
          onWrappingChange={setWrapping}
        />
      </div>
    </>
  );
}

/**
 * Wrap-up: the end of a conversation, in one press (design turns 89, 92; corrected by 96).
 *
 * What is settled goes to the gate together and is **written**. This said "stage what is settled"
 * and promised an accept that would follow, which is not what happens: wrap-up commits, as the
 * coordinator's own comment says it must — "Accept all writes; it does not stage for a screen to
 * visit afterwards", because several changes staged against one base make the first accept
 * staleize the second. Verified end to end on 2026-08-21: one press moved season.json v1 to v2
 * and created story.json, with no proposal left standing.
 *
 * The staged rail beside a conversation is therefore for proposals something *else* staged — a
 * dashed episode tile, a hand edit — never for what this button produces.
 */
function WrapUp({
  worldId,
  conversationId,
  seq,
  carried,
  status,
  subjectKey,
  wrapping,
  onWrappingChange,
}: {
  worldId: string | undefined;
  conversationId: string | null;
  seq: number | null;
  carried: number;
  /** Which subject this button is drawn for; one thread serves several. */
  subjectKey: string;
  /** A wrap-up that landed closes the conversation; nothing else on this dock does. */
  status: WorldChatStatus | null;
  /* Lifted (review 2026-08-22): the transcript holds retry back while a wrap-up commits. */
  wrapping: boolean;
  onWrappingChange: (next: boolean) => void;
}) {
  const setWrapping = onWrappingChange;
  /*
   * Per subject, for the same reason the wait is (codex, 2026-08-23).
   *
   * A single ref held whichever request was pressed last, so two overlapping wrap-ups made the
   * later one's id the only one anything could match. A refusal for the earlier subject then
   * failed to recognise itself, and that subject's button stayed disabled with nothing coming to
   * clear it. Refusals arrive keyed by conversation, and one conversation serves every subject
   * here, so the correlation has to live where the subject does.
   */
  const asked = useRef<Map<string, string>>(new Map());
  const refusal = useWorldChatWrapUpRefusal(conversationId ?? undefined);
  const refusedMine = refusal !== null && refusal.requestId === asked.current.get(subjectKey);
  /*
   * Both endings, and only the two of them (codex, 2026-08-23).
   *
   * A refusal used to be the only one, because a wrap-up was the last thing a conversation did:
   * it closed, the dock went, and a state that never reset never showed. A long season is written
   * in runs and wrapped between them, so the second press met a button still disabled and still
   * reading "Writing them…" from the first.
   *
   * Closing is the success half, not the sequence moving. Anything advances a sequence — saving a
   * point from the rail, a turn finishing elsewhere — so a seq check clears the wait while the
   * wrap-up is still committing and re-enables a button whose second press would land on top of
   * the first. A wrap-up that lands closes the conversation; nothing else here does.
   */
  useEffect(() => {
    if (wrapping && (refusedMine || status === "closed")) setWrapping(false);
  }, [wrapping, refusedMine, status]);
  // A press that transmitted nothing has no answer coming, so the wait must never begin on one.
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
      <Button
        variant="primary"
        size="lg"
        disabled={carried === 0 || !worldId || conversationId === null || seq === null || wrapping}
        onClick={() => {
          if (!worldId || conversationId === null || seq === null) return;
          const attempt = wrapUpWorldChat(worldId, conversationId, seq);
          if (!attempt) return;
          asked.current.set(subjectKey, attempt);
          setWrapping(true);
        }}
      >
        {wrapping ? "Writing them…" : `Wrap up · write what is settled${carried > 0 ? ` · ${carried}` : ""}`}
      </Button>
      {/* A refused wrap-up wrote nothing, so the panel above is unchanged and says nothing about
          it. Without this line the press leaves no trace at all. */}
      {refusal && !wrapping && (
        <div className="fy-panel__refused" role="status">
          {refusal.detail}
        </div>
      )}
      {/* No caption under the button (turn 95). The panel above already shows what is settled and
          what is still a maybe, and the button's own disabled state is that same fact — a line
          restating both is one more thing to read on a screen whose whole job is the transcript. */}
    </div>
  );
}

/**
 * The rail in its second state: what one conversation settled, staged and waiting on a yes
 * (design turns 91, 92).
 *
 * One component for every level, because the decision is the same one at every level and drawing
 * it twice is how two versions of it drift. `Turn this into a proposal` is retired: by the time a
 * person is reading what the conversation settled it already is one, and a button converting a
 * noun into another noun names an implementation step rather than the decision being made. The
 * fields come from the gate's own per-target review, so this cannot claim a change the gate would
 * not make.
 */
export function StagedDecision({
  subject,
  staged,
  writes,
  items,
  onAccepted,
}: {
  worldId: string | undefined;
  /** What is being decided, in the words of the level — "season", "episode 03". */
  subject: string;
  staged: StagedProposal;
  /** What applying does, said plainly under the buttons. */
  writes: string;
  /** A dock can name the concrete things this draft would touch instead of repeating its file. */
  items?: readonly { label: string; meta?: string }[];
  /**
   * Where accepting lands you (turn 91). Absent when this is docked beside the thing it decides
   * (turns 99, 100): you are already on it, and the change appears where it lives.
   */
  onAccepted?: () => void;
}) {
  const world = useStore().state?.world;
  if (!world || proposalDecisionOf(staged.proposal, world.conversations).mode !== "attended") return null;
  return (
    <div aria-label={`Changes to ${subject}`} style={{ display: "grid", gap: 8 }}>
      <ConnectedProposalPanel
        staged={staged}
        onAccepted={onAccepted}
      />
      {items !== undefined && items.length > 0 && (
        <div className="fy-mono">{items.map((item) => item.label).join(" · ")}</div>
      )}
      <div className="fy-mono">{writes}</div>
    </div>
  );
}

/**
 * Whether two entry contexts name the same thread. Compared field by field rather than by
 * identity: the context is rebuilt on every render from route params, so `===` never matches.
 */
function sameContext(a: WorldChatContext | undefined, b: WorldChatContext): boolean {
  if (!a || a.kind !== b.kind) return false;
  const key = (c: WorldChatContext) =>
    JSON.stringify([
      c.kind,
      "productionId" in c ? c.productionId : null,
      "episodeId" in c ? c.episodeId : null,
      "sceneId" in c ? c.sceneId : null,
    ]);
  return key(a) === key(b);
}

/**
 * What the conversation understood, as it understands it (design turn 89).
 *
 * Grouped by the subject each point is about, so a season being broken into episodes is watched
 * happening rather than discovered at wrap-up. These are soft: a point is thinking, not a
 * decision at the door — the staged-proposal rail beside a *details* screen is the other thing,
 * and the two must never be drawn as one.
 */
export function ConversationPoints({
  points,
  empty,
  onSave,
  onReject,
  onMedia,
  busyId,
}: {
  points: readonly WorldChatPoint[];
  empty: string;
  onSave?: (point: WorldChatPoint) => void;
  onReject?: (point: WorldChatPoint) => void;
  onMedia?: (point: WorldChatPoint) => void;
  busyId?: string | null;
}) {
  const groups = groupPointsBySubject(points);
  const open = points.filter((p) => p.kind === "question");
  if (groups.length === 0 && open.length === 0) {
    return (
      <div className="fy-panel">
        <div className="fy-emptycard">
          <div style={{ font: "400 13px/1.7 var(--font-sans)" }}>{empty}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="fy-panel">
      {groups.map((group) => (
        <div key={group.subject} className="fy-panel__group">
          <div className="fy-panel__grouphead">
            <span className="fy-panel__subject">{group.subject}</span>
            <span className="fy-mono">{group.kind}</span>
          </div>
          {group.items.map((point) => (
            <div key={point.id} className="fy-panel__point">
              <div className="fy-panel__pointtext">{point.text}</div>
              {point.media && <div className="fy-panel__mediabrief">{point.media.brief}</div>}
              <div className="fy-panel__pointacts">
                {point.media ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId === point.id || Boolean(point.media.blockedReason)}
                    onClick={() => onMedia?.(point)}
                  >
                    {busyId === point.id
                      ? "Preparing…"
                      : point.media.sessionId
                        ? "Open Bench"
                        : `Prepare ${point.media.medium}`}
                  </Button>
                ) : point.settled ? (
                  <Button variant="ghost" size="sm" disabled={busyId === point.id} onClick={() => onSave?.(point)}>
                    {busyId === point.id ? "Saving…" : "Save"}
                  </Button>
                ) : (
                  <span className="fy-panel__pointwhy">still a maybe</span>
                )}
                {onReject && (
                  <Button variant="ghost" size="sm" disabled={busyId === point.id} onClick={() => onReject(point)}>
                    Reject
                  </Button>
                )}
              </div>
              {point.media?.blockedReason && <div className="fy-panel__mediawhy">{point.media.blockedReason}</div>}
            </div>
          ))}
        </div>
      ))}
      {/* A question is not a claim about the production, so it is listed apart from what is. */}
      {open.length > 0 && (
        <div className="fy-panel__group">
          <div className="fy-panel__grouphead">
            <span className="fy-panel__subject">Still open</span>
            <span className="fy-mono">{open.length} question{open.length === 1 ? "" : "s"}</span>
          </div>
          {open.map((point) => (
            <div key={point.id} className="fy-panel__point">
              <div className="fy-panel__pointtext">{point.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Points under the thing each is about; questions are pulled out and listed on their own. */
export function groupPointsBySubject<P extends { kind: string; subject: string; subjectKind: string }>(
  points: readonly P[],
): Array<{ subject: string; kind: string; items: P[] }> {
  const groups: Array<{ subject: string; kind: string; items: P[] }> = [];
  for (const point of points) {
    if (point.kind === "question") continue;
    const existing = groups.find((g) => g.subject === point.subject);
    if (existing) existing.items.push(point);
    else groups.push({ subject: point.subject, kind: point.subjectKind, items: [point] });
  }
  return groups;
}
