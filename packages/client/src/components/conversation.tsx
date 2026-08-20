import { useEffect, useMemo, useRef, useState } from "react";
import type { StagedProposal, WorldChatContext, WorldChatPoint, WorldChatWorkspace } from "@arke-studio/contracts";
import { Composer } from "./composer.js";
import {
  acceptProposal,
  cancelWorldChat,
  createWorldChat,
  rejectWorldChatPoint,
  saveWorldChatPoint,
  openWorldChat,
  retryWorldChatTurn,
  sendWorldChat,
  useStore,
  useWorldChatProgress,
  useWorldChatWrapUpRefusal,
  wrapUpWorldChat,
} from "../lib/store.js";
import { Working } from "./working.js";
import { Badge, Button, cx } from "./ui.js";

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
  /** What stands in for the transcript before anything has been said. */
  empty?: React.ReactNode;
}) {
  const messages = workspace?.messages ?? [];
  if (messages.length === 0 && !running && !failure && empty) {
    return (
      <div className="fy-chat__transcript" aria-live="polite">
        {empty}
      </div>
    );
  }
  return (
    <div className="fy-chat__transcript" aria-live="polite">
      {messages.map((m) => (
        <div key={m.id} className={cx("fy-chat__turn", `fy-chat__turn--${m.role}`)}>
          <div className="fy-chat__bubble">
            {m.text}
            {m.role === "studio" && m.receipts.length > 0 && (
              // One tick for the row, not one per receipt: the tick means "this is what was
              // read", and repeating it turned a footnote into a checklist.
              <div className="fy-chat__receipts">{`✓ ${m.receipts.join(" · ")}`}</div>
            )}
          </div>
          {/*
            Outside the bubble, because it is not something the Studio said — it is something it
            did, to a file, already. The rail beside this transcript holds what is waiting for a
            yes; this is the opposite kind of thing, and it needs to look like it (SPEC-022).
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
        </div>
      ))}
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

/** Why a turn ended without a reply, in the words the screen can say out loud. */
export function failureLine(failure: { status: string; detail?: string }): string {
  const opening =
    failure.status === "timeout"
      ? "That took too long and stopped."
      : failure.status === "budget-exceeded"
        ? "That turn ran past its budget and stopped."
        : "That did not go through.";
  return `${opening} Nothing was lost — your message is still here.`;
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
}) {
  const { state } = useStore();
  const [message, setMessage] = useState("");
  const context: WorldChatContext = entry ?? { kind: "production", productionId: productionId ?? "" };
  const contextKey = JSON.stringify(context);
  const thread = useMemo(() => {
    const wanted = JSON.parse(contextKey) as WorldChatContext;
    const rows = (state?.world?.conversations ?? []).filter((c) => sameContext(c.entryContext, wanted));
    return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }, [state?.world?.conversations, contextKey]);
  const conversationId = thread?.id ?? null;

  useEffect(() => {
    if (!worldId || !conversationId) return;
    openWorldChat(worldId, conversationId);
    return () => openWorldChat(worldId, null);
  }, [worldId, conversationId]);

  const workspace = state?.worldChat ?? null;
  const loaded = workspace && workspace.conversationId === conversationId ? workspace : null;
  const progress = useWorldChatProgress(conversationId ?? undefined, loaded?.runStartedAt ?? null);
  const running = loaded?.runStatus === "running";
  const failure = loaded?.lastFailure ?? null;

  const submit = () => {
    const text = message.trim();
    if (!text || !worldId || !productionId) return;
    setMessage("");
    // No thread yet: the first thing said opens it, with that line as its opening.
    if (!conversationId) {
      createWorldChat(worldId, text, crypto.randomUUID(), context);
      return;
    }
    sendWorldChat(worldId, conversationId, text);
  };

  const points = loaded?.points ?? [];
  const pane = (
    <div className="fy-story__chat">
      {(eyebrow || heading) && (
        <div className="fy-story__chathead">
          {eyebrow && <div className="fy-eyebrow-sm">{eyebrow}</div>}
          {heading && <h1 className="fy-story__h1">{heading}</h1>}
        </div>
      )}
      <div className="fy-story__log">
        <ConversationTranscript
          workspace={loaded}
          running={running}
          progress={progress}
          failure={failure && !running ? failure : null}
          canRetry
          {...(worldId && conversationId ? { onStop: () => cancelWorldChat(worldId, conversationId) } : {})}
          {...(worldId && conversationId
            ? { onRetry: (turnId: string) => retryWorldChatTurn(worldId, conversationId, turnId) }
            : {})}
          empty={
            thread ? (
              <div className="fy-bubble--user">
                {thread.title}
                <div className="fy-bubble__note">{openingNote ?? "Production Chat · opening…"}</div>
              </div>
            ) : (
              <div className="fy-bubble--gate">{emptyLine}</div>
            )
          }
        />
      </div>
      <div style={{ flex: "none", padding: "14px 36px 22px" }}>
        <Composer
          value={message}
          onChange={setMessage}
          onSubmit={submit}
          placeholder={placeholder}
          agentLabel="story author"
          busy={running}
          busyLabel="reading the world…"
          onDictate={(text) => setMessage((prev) => (prev ? `${prev} ${text}` : text))}
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
  const carried = points.filter((p) => p.kind === "point" && p.settled).length;
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
          {...(worldId && conversationId
            ? {
                onSave: (point: WorldChatPoint) =>
                  saveWorldChatPoint(worldId, conversationId, point.id, point.revision),
                onReject: (point: WorldChatPoint) =>
                  rejectWorldChatPoint(worldId, conversationId, point.id, point.revision),
              }
            : {})}
        />
        <div className="fy-mono" style={{ marginTop: 10 }}>
          still soft · saying more changes them · wrap-up is what stages them
        </div>
        {/* Every level has a wrap-up (turn 92). It was drawn on 89a from the start and built
            nowhere, which left the season — the first hop anybody walks — with no way to turn a
            conversation into anything at all. */}
        <WrapUp worldId={worldId} conversationId={conversationId} seq={loaded?.seq ?? null} carried={carried} />
      </div>
    </>
  );
}

/**
 * Wrap-up: the end of a conversation, in one press (design turns 89, 92).
 *
 * What is settled gets staged together, as one proposal, at the gate. Nothing is written by this
 * button — the accept that follows does that, and it lives in this same rail once there is
 * something to accept.
 */
function WrapUp({
  worldId,
  conversationId,
  seq,
  carried,
}: {
  worldId: string | undefined;
  conversationId: string | null;
  seq: number | null;
  carried: number;
}) {
  const [wrapping, setWrapping] = useState(false);
  const asked = useRef<string | null>(null);
  const refusal = useWorldChatWrapUpRefusal(conversationId ?? undefined);
  const refusedMine = refusal !== null && refusal.requestId === asked.current;
  useEffect(() => {
    if (wrapping && refusedMine) setWrapping(false);
  }, [wrapping, refusedMine]);
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
          asked.current = attempt;
          setWrapping(true);
        }}
      >
        {wrapping ? "Staging them…" : `Wrap up · stage what is settled${carried > 0 ? ` · ${carried}` : ""}`}
      </Button>
      {/* A refused wrap-up wrote nothing, so the panel above is unchanged and says nothing about
          it. Without this line the press leaves no trace at all. */}
      {refusal && !wrapping && (
        <div className="fy-panel__refused" role="status">
          {refusal.detail}
        </div>
      )}
      <div className="fy-mono">
        {carried === 0
          ? "nothing is settled yet · save a point above to make it ready"
          : "talking changes nothing · the gate writes it"}
      </div>
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
  worldId,
  subject,
  staged,
  writes,
  onAccepted,
}: {
  worldId: string | undefined;
  /** What is being decided, in the words of the level — "season", "episode 03". */
  subject: string;
  staged: StagedProposal;
  /** What accepting does, said plainly under the button. */
  writes: string;
  onAccepted: () => void;
}) {
  const fields = staged.review?.targets.flatMap((t) => t.fields) ?? [];
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <div style={{ font: "600 15px var(--font-sans)" }}>Ready to accept</div>
        <span className="fy-mono">{subject}</span>
      </div>
      <div className="fy-mono" style={{ marginTop: 6 }}>
        this is the proposal · nothing above it has been written
      </div>
      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        {fields.map((field) => (
          <div key={field.field} className="fy-draftcard">
            <div className="fy-draftcard__head">
              <span className="fy-eyebrow-sm">{field.field}</span>
              <Badge tone="warning">would change</Badge>
            </div>
            <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 6 }}>{field.proposed ?? "(removed)"}</div>
            {field.before !== null && <div className="fy-draftcard__was">Accepted: “{field.before}”</div>}
          </div>
        ))}
        {fields.length === 0 && (
          <div className="fy-emptycard">
            <div style={{ font: "400 13px/1.7 var(--font-sans)" }}>
              A proposal is staged and the gate reports no field-by-field review for it. Read it
              whole in Proposals before accepting.
            </div>
          </div>
        )}
        <Button
          variant="primary"
          size="lg"
          disabled={!worldId}
          onClick={() => {
            if (!worldId) return;
            acceptProposal(worldId, staged.proposal.id);
            // Accepting lands you on the thing you accepted (turn 91).
            onAccepted();
          }}
        >
          Accept Proposal
        </Button>
        <div className="fy-mono">{writes}</div>
      </div>
    </>
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
  busyId,
}: {
  points: readonly WorldChatPoint[];
  empty: string;
  onSave?: (point: WorldChatPoint) => void;
  onReject?: (point: WorldChatPoint) => void;
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
              <div className="fy-panel__pointacts">
                {point.settled ? (
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
