import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { WorldChatDeletionBlock, WorldChatSummary } from "@arke-studio/contracts";
import { Composer } from "../components/composer.js";
import { Working } from "../components/working.js";
import { EmptyState } from "../components/layout.js";
import { Button, cx } from "../components/ui.js";
import { useOpenWorldGuard } from "../lib/selectors.js";
import {
  archiveWorldChat,
  attachHostFiles,
  attachHostText,
  cancelWorldChat,
  deleteWorldChat,
  hostCanAttach,
  retryWorldChatTurn,
  createWorldChat,
  openWorldChat,
  sendWorldChat,
  unarchiveWorldChat,
  useStore,
  useWorldChatProgress,
  useWorldChatRefusals,
  useWorldChatWrapUpRefusal,
  worldChatAttachFiles,
  worldChatAttachTarget,
  wrapUpWorldChat,
} from "../lib/store.js";

/**
 * World Chat (#70 phase 3): talking about a world, and seeing what was heard.
 *
 * The design binds this to Genesis — the same split, the same composer, the same rail — so the
 * layout classes here are `fy-gate`'s, not new ones. That is not only tidiness: a creator who has
 * made a world already knows this shape, and a second nearly-identical split would teach them
 * that similar-looking screens behave differently.
 *
 * The rule that shapes everything: the conversation decides nothing. There are no controls on a
 * point, because a point is corrected by saying so. Deciding happens exactly twice — once when
 * the conversation is turned into proposals, and once on the approvals screen — and neither of
 * those is here.
 */

/**
 * Conversations ordered by what they are still waiting on, not by when they were touched.
 *
 * Recency is the obvious order and the wrong one. A conversation whose proposals are sitting
 * unanswered is owed something; one that was merely opened yesterday is not. Sorting by time
 * would bury the first under the second on a busy day.
 */
export function byPendingConsequence(a: WorldChatSummary, b: WorldChatSummary): number {
  if (a.openProposalCount !== b.openProposalCount) return b.openProposalCount - a.openProposalCount;
  if (a.status !== b.status) {
    const rank = (s: WorldChatSummary["status"]) => (s === "open" ? 0 : s === "closed" ? 1 : 2);
    return rank(a.status) - rank(b.status);
  }
  if (a.pointCount !== b.pointCount) return b.pointCount - a.pointCount;
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * Why Delete is unavailable, in the length a row has room for (R-50).
 *
 * Said in text beside the disabled control rather than in a tooltip. A reason only a mouse can
 * reach is not a reason, and this is the one place in the feature where the app says no to
 * something the person plainly meant.
 */
const WHY_NOT_DELETABLE: Record<WorldChatDeletionBlock, string> = {
  "active-run": "a turn is still running",
  "wrap-up-in-flight": "it is being turned into proposals",
  "unresolved-proposals": "its proposals are still waiting",
};

function whatItIsWaitingOn(row: WorldChatSummary): string {
  if (row.openProposalCount > 0) {
    return `${row.openProposalCount} proposal${row.openProposalCount === 1 ? "" : "s"} waiting on you`;
  }
  if (row.status === "closed") return "closed · nothing waiting";
  if (row.status === "archived") return "archived";
  if (row.pointCount === 0) return "open · nothing understood yet";
  return `open · ${row.pointCount} point${row.pointCount === 1 ? "" : "s"} understood`;
}

/**
 * One row, and the two things that can be done to it from here.
 *
 * Archive sits beside Delete rather than behind it because Archive is the answer whenever Delete
 * is refused — and Delete is refused for as long as a conversation's proposals are undecided,
 * which is most of the time it has done anything at all. A list offering only the control that
 * will not work is a list that reads as broken.
 *
 * Deleting confirms in place, two clicks and no dialog, as archiving a world does. The second
 * click is the consent, and the sentence between them says what actually goes.
 */
function ConversationRow({ worldId, row }: { worldId: string; row: WorldChatSummary }) {
  const [confirming, setConfirming] = useState(false);
  const blocked = row.deletionBlock;

  return (
    <li className="fy-chatlist__row">
      <Link to={`/w/${worldId}/chat/${row.id}`} className="fy-chatlist__item">
        <span className="fy-chatlist__title">{row.title}</span>
        <span
          className={cx("fy-chatlist__sub", row.openProposalCount > 0 && "fy-chatlist__sub--waiting")}
        >
          {whatItIsWaitingOn(row)}
        </span>
      </Link>
      {confirming ? (
        <div className="fy-chatlist__confirm">
          <span className="fy-chatlist__confirmsay">
            Delete this conversation? Its transcript, everything it understood and anything
            attached to it go for good, and proposals it produced can no longer be sent back here.
          </span>
          <span className="fy-chatlist__acts">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                deleteWorldChat(worldId, row.id);
                setConfirming(false);
              }}
            >
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        </div>
      ) : (
        <div className="fy-chatlist__acts">
          {blocked && <span className="fy-chatlist__blocked">Cannot delete — {WHY_NOT_DELETABLE[blocked]}</span>}
          {row.status === "archived" ? (
            <Button variant="ghost" size="sm" onClick={() => unarchiveWorldChat(worldId, row.id)}>
              Restore
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              title="Shelve it — nothing is deleted"
              onClick={() => archiveWorldChat(worldId, row.id)}
            >
              Archive
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={blocked !== undefined}
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
        </div>
      )}
    </li>
  );
}

export function WorldChatScreen() {
  const { worldId } = useParams();
  useOpenWorldGuard(worldId);
  const { state } = useStore();
  const navigate = useNavigate();
  const world = state?.world;
  const [starting, setStarting] = useState(false);

  /**
   * Start one, and go to it when it opens.
   *
   * Creating is the coordinator's job, so the new id does not exist here yet — but the create
   * handler opens the conversation as it finishes, so the workspace arriving in state is the
   * signal to navigate. Watching that is exact; diffing the conversation list would also fire
   * for one created in another window.
   *
   * No title is asked for. Nobody knows what a conversation is about before having it, and being
   * made to name it first is a toll on the thing the feature exists for. It can be renamed once
   * there is something to call it.
   */
  const opened = state?.worldChat?.conversationId ?? null;
  useEffect(() => {
    if (!starting || !opened || !worldId) return;
    setStarting(false);
    navigate(`/w/${worldId}/chat/${opened}`);
  }, [starting, opened, worldId, navigate]);

  const start = () => {
    if (!worldId || starting) return;
    setStarting(true);
    createWorldChat(worldId, "New conversation", crypto.randomUUID());
  };

  const rows = useMemo(() => [...(world?.conversations ?? [])].sort(byPendingConsequence), [world?.conversations]);
  const live = rows.filter((r) => r.status !== "archived");
  const archived = rows.filter((r) => r.status === "archived");

  if (!world) return null;

  return (
    <div data-screen="world-chat">
      {rows.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          hint={
            harnessReady(state)
              ? "Talk about this world and the studio keeps track of what it understood. Nothing is written to the world until you turn a conversation into proposals and accept them."
              : "Talk about this world and the studio keeps track of what it understood. Chat needs OpenCode running before anyone can answer — you can still start one and come back to it."
          }
          action={
            <Button variant="primary" size="lg" onClick={start} disabled={starting}>
              {starting ? "Starting…" : "Start a conversation"}
            </Button>
          }
        />
      ) : (
        <div className="fy-chatlist">
          <div className="fy-chatlist__head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-eyebrow-sm">WORLD CHAT</div>
              <h1 className="fy-story__h1">What we have been talking about</h1>
            </div>
            <Button variant="primary" onClick={start} disabled={starting}>
              {starting ? "Starting…" : "New conversation"}
            </Button>
          </div>
          {live.length > 0 && (
            <ul className="fy-chatlist__items">
              {live.map((row) => (
                <ConversationRow key={row.id} worldId={worldId!} row={row} />
              ))}
            </ul>
          )}
          {/* Archived conversations keep their own heading rather than sinking quietly to the
              bottom of one list. Archiving has to visibly tidy, or nobody uses it — and it is the
              only thing available while a conversation's proposals are still undecided. */}
          {archived.length > 0 && (
            <>
              <h2 className="fy-chatlist__grouphead">
                Archived · {archived.length}
              </h2>
              <ul className="fy-chatlist__items">
                {archived.map((row) => (
                  <ConversationRow key={row.id} worldId={worldId!} row={row} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One conversation: the transcript on the left, what was understood on the right.
 *
 * The rail is read-only by design (§0.1). An earlier draft asked for approval point by point
 * while the conversation was still going, which meant deciding twelve times about things that had
 * not settled yet. Reading is not deciding, so there is nothing here to press.
 */
export function WorldChatConversationScreen() {
  const { worldId, conversationId } = useParams();
  useOpenWorldGuard(worldId);
  const { state, connection } = useStore();
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  /**
   * Chips taken off the composer, for this visit only.
   *
   * Removing a chip means "stop referring to this", not "delete it" — the file stays in the
   * conversation and anything already said about it stays checkable (§13.1). Held locally rather
   * than durably because the store's unlink is scoped to a message, and these have not been sent
   * with one yet; the same local dismissal the canon composer uses.
   */
  const [dismissed, setDismissed] = useState<string[]>([]);
  const refusals = useWorldChatRefusals(conversationId);
  const wrapUpRefusal = useWorldChatWrapUpRefusal(conversationId);
  /** Set while a wrap-up is in flight, so the button cannot be pressed twice into the same log. */
  const [wrappingUp, setWrappingUp] = useState(false);

  const world = state?.world;
  const row = world?.conversations.find((c) => c.id === conversationId);

  // Ask for the workspace on arrival and release it on the way out, so a session that visits
  // twenty conversations still holds one.
  useEffect(() => {
    if (!worldId || !conversationId) return;
    openWorldChat(worldId, conversationId);
    return () => openWorldChat(worldId, null);
  }, [worldId, conversationId]);

  // The workspace — transcript, receipts and points — is loaded by id rather than carried in the
  // world snapshot, because opening a world must not cost every conversation ever had.
  const workspace = state?.worldChat ?? null;
  const loaded = workspace && workspace.conversationId === conversationId ? workspace : null;
  // Gated on the run's own start so a label from the previous turn is not shown for this one.
  const progress = useWorldChatProgress(conversationId, loaded?.runStartedAt ?? null);

  /**
   * Go to the proposals once there are proposals to go to.
   *
   * This used to navigate on the click itself. That reads well when the wrap-up works and lies
   * when it does not: the coordinator can refuse — the conversation moved on, nothing is settled
   * enough, a change would not write — and the screen had already left for an approvals list that
   * was empty, which is indistinguishable from a button that does nothing. Closing is the
   * coordinator's own signal that every proposal is durable (R-42a), so it is the thing to wait
   * for. The wait is a few file writes, not a model call.
   *
   * The connection ends the wait too. Neither answer can cross a socket that has gone, and a wait
   * with nothing left to answer it is the failure this whole change is about.
   */
  const closed = loaded?.status === "closed";
  useEffect(() => {
    if (!wrappingUp || !worldId) return;
    if (closed) {
      setWrappingUp(false);
      navigate(`/w/${worldId}/proposals`);
    } else if (wrapUpRefusal || connection !== "open") {
      setWrappingUp(false);
    }
  }, [wrappingUp, closed, wrapUpRefusal, connection, worldId, navigate]);

  if (!world) return null;
  /**
   * Missing means missing from both.
   *
   * The row and the workspace arrive by different routes, so one can lag the other by a frame —
   * and the workspace is the better authority: it was loaded by this id and came back. Declaring
   * the conversation gone because the *summary list* had not caught up is how somebody who has
   * just created one is told it does not exist.
   */
  if (!row && !loaded) {
    return (
      <div data-screen="world-chat-conversation">
        <EmptyState
          title="That conversation is not here"
          hint="It may have been deleted. The conversations this world still has are on the World Chat screen."
        />
      </div>
    );
  }
  const points = loaded?.points ?? [];
  const groups = groupBySubject(points);
  const openThreads = points.filter((p) => p.kind === "question");
  const carried = points.filter((p) => p.kind === "point" && p.settled).length;
  const running = loaded?.runStatus === "running";
  const failure = loaded?.lastFailure;
  /**
   * Attachments are private to this conversation, and the chips say which are readable.
   * An image can be attached and referred to; it cannot be quoted, and the chip should not
   * suggest otherwise (§13.2).
   */
  const chips = (loaded?.attachments ?? [])
    .filter((a) => !dismissed.includes(a.id))
    .map((a) => ({
      id: a.id,
      file: a.readability === "not-readable" ? `${a.fileName} · not readable in chat` : a.fileName,
      kind: a.kind,
    }));

  return (
    <div data-screen="world-chat-conversation" className="fy-chat__wrap">
      <div className="fy-gate">
        <div className="fy-gate__main">
          <div className="fy-gate__head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-eyebrow-sm">WORLD CHAT</div>
              <h1 className="fy-story__h1">{row?.title ?? "New conversation"}</h1>
            </div>
            {/* Beside the title rather than beneath it (41a): the head bottom-aligns the two so a
                named subject reads as one line instead of a stack that grows. */}
            {row?.entryContext && row.entryContext.kind !== "world" && (
              <div className="fy-chat__about">{aboutLabel(row.entryContext)}</div>
            )}
          </div>

          <div className="fy-gate__body">
            {loaded === null ? (
              <div className="fy-chat__loading">Opening this conversation…</div>
            ) : (
              <div className="fy-chat__transcript" aria-live="polite">
                {loaded.messages.map((m) => (
                  <div key={m.id} className={cx("fy-chat__turn", `fy-chat__turn--${m.role}`)}>
                    <div className="fy-chat__bubble">
                      {m.text}
                      {m.role === "studio" && m.receipts.length > 0 && (
                        // One tick for the row, not one per receipt: the tick means "this is what
                        // was read", and repeating it turned a footnote into a checklist.
                        <div className="fy-chat__receipts">{`✓ ${m.receipts.join(" · ")}`}</div>
                      )}
                    </div>
                  </div>
                ))}
                {/*
                  The turn in flight, where its reply will be. In the transcript rather than on
                  the composer because that is where the answer is going to appear, and it is
                  where the eye already is after sending.
                */}
                {running && (
                  <Working
                    label={progress}
                    startedAt={loaded?.runStartedAt ?? null}
                    {...(worldId && conversationId
                      ? { onStop: () => cancelWorldChat(worldId, conversationId) }
                      : {})}
                  />
                )}
                {/*
                  A turn that failed says so where the reply would have been. Silence here is
                  indistinguishable from never having asked, which is how a two-minute timeout
                  reads as "nothing happens".
                */}
                {failure && !running && (
                  <div className="fy-chat__failed" role="status">
                    <div className="fy-chat__failedtext">{failureLine(failure)}</div>
                    {/* Retrying a turn is saying something again, so it is held back for the same
                        reason the composer is while a wrap-up is running. */}
                    {!wrappingUp && (
                      <button
                        type="button"
                        className="fy-chat__retry"
                        onClick={() =>
                          worldId && conversationId && retryWorldChatTurn(worldId, conversationId, failure.turnId)
                        }
                      >
                        Try that again
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="fy-chat__composer">
            <Composer
              value={draft}
              onChange={setDraft}
              onSubmit={() => {
                const text = draft.trim();
                if (!text || !worldId || running || wrappingUp) return;
                sendWorldChat(worldId, conversationId!, text, chips.map((c) => c.id));
                setDraft("");
              }}
              placeholder="Keep going…"
              busy={running}
              busyLabel="Thinking…"
              attachments={chips}
              refusals={refusals}
              // Appended to whatever is already typed, never sent: speaking gets you to a draft,
              // and the draft is still corrected and sent by hand (SPEC-018 R-2, R-5).
              onDictate={(text) => setDraft((prev) => (prev ? `${prev} ${text}` : text))}
              {...(worldId && conversationId && !wrappingUp
                ? { onAttach: () => worldChatAttachFiles(worldId, conversationId) }
                : {})}
              {...(worldId && conversationId && hostCanAttach() && !wrappingUp
                ? {
                    onAttachFiles: (files: readonly File[]) =>
                      attachHostFiles(worldChatAttachTarget(worldId, conversationId), files),
                    onAttachText: (text: string) =>
                      attachHostText(
                        worldChatAttachTarget(worldId, conversationId),
                        text,
                        "pasted-note.txt",
                      ),
                  }
                : {})}
              onRemoveAttachment={(id) => setDismissed((prev) => [...prev, id])}
              /*
               * Nothing may be said to a conversation that is being turned into proposals.
               *
               * The window is new: the screen used to leave for the approvals list on the press,
               * so there was no composer left to type into. Now that it waits here, a message or
               * a file landing mid-wrap-up would be appended around `wrapup.completed` — in the
               * conversation but absent from the proposals just made from it, or written after it
               * closed. The coordinator does not refuse it, so the screen must not offer it.
               */
              disabledReason={
                wrappingUp ? "This conversation is being turned into proposals." : composerReason(state)
              }
            />
            {/* Stop lives on the working line in the transcript now, beside what it would stop. */}
            <div className="fy-chat__composernote">
              world author · talking changes nothing until you wrap up
            </div>
          </div>
        </div>

        <div className="fy-gate__side">
          <div className="fy-panel__head">
            <div className="fy-panel__headline">
              <div className="fy-panel__title">What I&rsquo;ve understood</div>
              <div className="fy-panel__count">
                {points.length} point{points.length === 1 ? "" : "s"} · nothing decided
              </div>
            </div>
            <div className="fy-panel__note">
              If a line is wrong, say so and it changes. There is nothing to approve here.
            </div>
          </div>

          <div className="fy-panel__body">
            {points.length === 0 ? (
              <div className="fy-panel__empty">
                Nothing understood yet. Say what you know about this world and it lands here.
              </div>
            ) : (
              <>
                {groups.map((group) => (
                  <div key={group.subject} className="fy-panel__group">
                    <div className="fy-panel__grouphead">
                      <div className="fy-panel__subject">{group.subject}</div>
                      <div className="fy-panel__kind">{group.kind}</div>
                    </div>
                    {group.items.map((p) => (
                      <div key={p.id} className="fy-panel__point">
                        {p.text}
                      </div>
                    ))}
                  </div>
                ))}
                {openThreads.length > 0 && (
                  <div className="fy-panel__group">
                    <div className="fy-panel__grouphead">
                      <div className="fy-panel__subject">Still open</div>
                      <div className="fy-panel__kind">not settled</div>
                    </div>
                    {openThreads.map((p) => (
                      <div key={p.id} className="fy-panel__point">
                        {p.text}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div style={{ flex: 1, minHeight: 16 }} />
          <div style={{ display: "grid", gap: 8 }}>
            <Button
              variant="primary"
              size="lg"
              disabled={carried === 0 || loaded === null || running || wrappingUp}
              onClick={() => {
                if (!worldId || !loaded) return;
                // Waiting only on a command that was actually sent. A press made after the socket
                // dropped transmits nothing, and nothing can then arrive to end the wait — the
                // button would sit on "Turning this into proposals…" for the rest of the session.
                //
                // No confirmation sheet, and no navigation yet either: an earlier design had a
                // sheet here that said less than the screen it stood in front of, and the version
                // after it left for the proposals before knowing there were any. The effect above
                // goes when the conversation closes.
                if (wrapUpWorldChat(worldId, conversationId!, loaded.seq)) setWrappingUp(true);
              }}
            >
              {wrappingUp ? "Turning this into proposals…" : "Turn this into proposals"}
            </Button>
            {/*
              A refused wrap-up is the one thing this rail must not swallow. Nothing was written,
              so the panel above is unchanged and says nothing about it — without this line the
              press leaves no trace at all.
            */}
            {wrapUpRefusal && !wrappingUp && (
              <div className="fy-panel__refused" role="status">
                {wrapUpRefusal}
              </div>
            )}
            <div className="fy-panel__caption">
              {carried === 0
                ? "Nothing is settled enough to propose yet."
                : `${carried} of ${points.length} points become proposals. Closes the conversation and takes you to them, where nothing is written to the world until you accept.`}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function aboutLabel(context: NonNullable<WorldChatSummary["entryContext"]>): string {
  switch (context.kind) {
    case "canon-entry":
      return `about ${context.entryId}`;
    case "canon-question":
      return "about a canon question";
    case "sheet":
      return `about ${context.sheetId}`;
    case "attachment":
      return "about an attachment";
    default:
      return "";
  }
}

/** Points group under the thing they are about, per R-15 — not under what kind of change they are. */
function groupBySubject(
  points: ReadonlyArray<{ id: string; kind: string; subject: string; subjectKind: string; text: string }>,
): Array<{ subject: string; kind: string; items: Array<{ id: string; text: string }> }> {
  const groups: Array<{ subject: string; kind: string; items: Array<{ id: string; text: string }> }> = [];
  for (const point of points) {
    if (point.kind === "question") continue;
    const existing = groups.find((g) => g.subject === point.subject);
    if (existing) existing.items.push({ id: point.id, text: point.text });
    else groups.push({ subject: point.subject, kind: point.subjectKind, items: [{ id: point.id, text: point.text }] });
  }
  return groups;
}

/**
 * Why the composer cannot send, when it cannot (§2.8).
 *
 * A dead box that says nothing is the failure this avoids: without a harness there is no one to
 * answer, and the honest thing is to say so rather than accept a message that will go nowhere.
 */
/** Whether there is anything to talk to. Starting a conversation nobody can answer is a dead end. */
function harnessReady(state: ReturnType<typeof useStore>["state"]): boolean {
  return state?.app.health.harness.status === "healthy";
}

/**
 * What a failed turn says.
 *
 * Plainly, and about the app rather than the person: they typed something reasonable and waited.
 * The `detail` the coordinator carries is operator-safe by construction, so it can be shown, but
 * it is a supporting clause and never the whole sentence -- "the studio took too long to answer"
 * on its own does not tell somebody the message is still there and can be sent again.
 */
function failureLine(failure: { status: string; detail?: string }): string {
  const opening =
    failure.status === "timeout"
      ? "That took too long and stopped."
      : failure.status === "budget-exceeded"
        ? "That turn ran past its budget and stopped."
        : "That did not go through.";
  return `${opening} Nothing was lost — your message is still here.`;
}

function composerReason(state: ReturnType<typeof useStore>["state"]): string | undefined {
  if (!state) return "Still connecting.";
  if (state.app.health.harness.status !== "healthy") {
    return "Chat needs OpenCode running. Everything already understood is still here.";
  }
  return undefined;
}
