import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { WorldChatSummary } from "@arke-studio/contracts";
import { Composer } from "../components/composer.js";
import { EmptyState } from "../components/layout.js";
import { Button, cx } from "../components/ui.js";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { openWorldChat, useStore } from "../lib/store.js";

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

function whatItIsWaitingOn(row: WorldChatSummary): string {
  if (row.openProposalCount > 0) {
    return `${row.openProposalCount} proposal${row.openProposalCount === 1 ? "" : "s"} waiting on you`;
  }
  if (row.status === "closed") return "closed · nothing waiting";
  if (row.status === "archived") return "archived";
  if (row.pointCount === 0) return "open · nothing understood yet";
  return `open · ${row.pointCount} point${row.pointCount === 1 ? "" : "s"} understood`;
}

export function WorldChatScreen() {
  const { worldId } = useParams();
  useOpenWorldGuard(worldId);
  const { state } = useStore();
  const world = state?.world;

  const rows = useMemo(() => [...(world?.conversations ?? [])].sort(byPendingConsequence), [world?.conversations]);

  if (!world) return null;

  return (
    <div data-screen="world-chat">
      {rows.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          hint="Talk about this world and the studio keeps track of what it understood. Nothing is written to the world until you turn a conversation into proposals and accept them."
        />
      ) : (
        <div className="fy-chatlist">
          <div className="fy-chatlist__head">
            <div className="fy-eyebrow-sm">WORLD CHAT</div>
            <h1 className="fy-story__h1">What we have been talking about</h1>
          </div>
          <ul className="fy-chatlist__items">
            {rows.map((row) => (
              <li key={row.id}>
                <Link to={`/w/${worldId}/chat/${row.id}`} className="fy-chatlist__item">
                  <span className="fy-chatlist__title">{row.title}</span>
                  <span
                    className={cx(
                      "fy-chatlist__sub",
                      row.openProposalCount > 0 && "fy-chatlist__sub--waiting",
                    )}
                  >
                    {whatItIsWaitingOn(row)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
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
  const { state } = useStore();
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");

  const world = state?.world;
  const row = world?.conversations.find((c) => c.id === conversationId);

  // Ask for the workspace on arrival and release it on the way out, so a session that visits
  // twenty conversations still holds one.
  useEffect(() => {
    if (!worldId || !conversationId) return;
    openWorldChat(worldId, conversationId);
    return () => openWorldChat(worldId, null);
  }, [worldId, conversationId]);

  if (!world) return null;
  if (!row) {
    return (
      <div data-screen="world-chat-conversation">
        <EmptyState
          title="That conversation is not here"
          hint="It may have been deleted. The conversations this world still has are on the World Chat screen."
        />
      </div>
    );
  }

  // The workspace — transcript, receipts and points — is loaded by id rather than carried in the
  // world snapshot, because opening a world must not cost every conversation ever had.
  const loaded = state?.worldChat?.conversationId === row.id ? state.worldChat : null;
  const points = loaded?.points ?? [];
  const groups = groupBySubject(points);
  const openThreads = points.filter((p) => p.kind === "question");
  const carried = points.filter((p) => p.kind === "point" && p.settled).length;

  return (
    <div data-screen="world-chat-conversation" className="fy-chat__wrap">
      <div className="fy-gate">
        <div className="fy-gate__main">
          <div className="fy-gate__head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-eyebrow-sm">WORLD CHAT</div>
              <h1 className="fy-story__h1">{row.title}</h1>
              {row.entryContext && row.entryContext.kind !== "world" && (
                <div className="fy-chat__about">{aboutLabel(row.entryContext)}</div>
              )}
            </div>
          </div>

          <div className="fy-gate__body">
            {loaded === null ? (
              <div className="fy-chat__loading">Opening this conversation…</div>
            ) : (
              <div className="fy-chat__transcript" aria-live="polite">
                {loaded.messages.map((m) => (
                  <div key={m.id} className={cx("fy-chat__turn", `fy-chat__turn--${m.role}`)}>
                    <div className="fy-chat__bubble">{m.text}</div>
                    {m.role === "studio" && m.receipts.length > 0 && (
                      <div className="fy-chat__receipts">
                        {m.receipts.map((r, i) => (
                          <span key={i} className="fy-chat__receipt">
                            {r}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="fy-chat__composer">
            <Composer
              value={draft}
              onChange={setDraft}
              onSubmit={() => setDraft("")}
              placeholder="Keep going…"
              disabledReason={composerReason(state)}
            />
            <div className="fy-chat__composernote">
              world author · talking changes nothing until you wrap up
            </div>
          </div>
        </div>

        <div className="fy-gate__side">
          <div className="fy-panel__head">
            <div className="fy-panel__title">What I&rsquo;ve understood</div>
            <div className="fy-panel__count">
              {points.length} point{points.length === 1 ? "" : "s"} · nothing decided
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
                    <div className="fy-panel__subject">{group.subject}</div>
                    <div className="fy-panel__kind">{group.kind}</div>
                    {group.items.map((p) => (
                      <div key={p.id} className="fy-panel__point">
                        {p.text}
                      </div>
                    ))}
                  </div>
                ))}
                {openThreads.length > 0 && (
                  <div className="fy-panel__group">
                    <div className="fy-panel__subject">Still open</div>
                    <div className="fy-panel__kind">not settled</div>
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
              disabled={carried === 0}
              onClick={() => navigate(`/w/${worldId}/proposals`)}
            >
              Turn this into proposals
            </Button>
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
function composerReason(state: ReturnType<typeof useStore>["state"]): string | undefined {
  if (!state) return "Still connecting.";
  if (state.app.health.harness.status !== "healthy") {
    return "Chat needs OpenCode running. Everything already understood is still here.";
  }
  return undefined;
}
