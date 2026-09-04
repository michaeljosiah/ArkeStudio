import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { WorldChatDeletionBlock, WorldChatSummary } from "@arke-studio/contracts";
import { Composer } from "../components/composer.js";
import { attachmentChipLabel, ConversationTranscript } from "../components/conversation.js";
import { EmptyState } from "../components/layout.js";
import { Button, IconButton, cx } from "../components/ui.js";
import { ChevronDown, ChevronRight, More, PanelLeft, Plus } from "../components/icons.js";
import { useOpenWorldGuard } from "../lib/selectors.js";
import {
  archiveWorldChat,
  setWorldChatInitiative,
  attachHostFiles,
  attachHostText,
  cancelWorldChat,
  restoreBible,
  deleteWorldChat,
  hostCanAttach,
  retryWorldChatTurn,
  createWorldChat,
  dismissWorldChatRipples,
  openWorldChat,
  openWorldChatMedia,
  sendWorldChat,
  unarchiveWorldChat,
  useStore,
  useWorldChatProgress,
  useWorldChatRipples,
  rejectWorldChatPoint,
  saveWorldChatPoint,
  subscribeWorldChatMediaOpened,
  useWorldChatRefusals,
  useWorldChatWrapUpRefusal,
  worldChatAttachFiles,
  worldChatAttachTarget,
  wrapUpWorldChat,
} from "../lib/store.js";

/**
 * World Chat (#70 phase 3, restaged by design 71): talking about a world, and seeing what was
 * heard.
 *
 * The design binds this to Genesis — the same split, the same composer, the same rail — so the
 * layout classes here are `fy-gate`'s, not new ones. That is not only tidiness: a creator who has
 * made a world already knows this shape, and a second nearly-identical split would teach them
 * that similar-looking screens behave differently.
 *
 * What 71 changed is the way in. There used to be a list screen in front of all of this, and
 * every visit paid for it: arriving at World Chat meant choosing which conversation to read
 * before saying anything. The address is now a conversation nobody has said anything in yet, and
 * the conversations already had are a rail down the left that can be put away. One screen draws
 * both — `/chat` and `/chat/:conversationId` differ by what is in the middle, not by shape.
 *
 * The rule that shapes the rail is that a decision belongs where the point is. Save writes that
 * line to the world and Reject drops it, both from the rail on the right, and Accept all writes
 * what is left and closes the conversation. Talking still changes nothing — it is how a point
 * that is nearly right gets corrected, and the composer still says so.
 *
 * What did not change is who decides. Saving goes through the accept gate exactly as a reviewed
 * proposal does, so the history, the ripples and the change log are the same; the review is the
 * press. The one thing a press cannot decide is a proposal carrying an open choice — a question
 * only the person can answer — and those still wait on the approvals screen.
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
 * Why Delete is unavailable, in the length the menu has room for (R-50).
 *
 * Said in text beside the disabled item rather than in a tooltip. A reason only a mouse can reach
 * is not a reason, and this is the one place in the feature where the app says no to something
 * the person plainly meant.
 */
const WHY_NOT_DELETABLE: Record<WorldChatDeletionBlock, string> = {
  "active-run": "a turn is still running",
  "wrap-up-in-flight": "it is being turned into proposals",
  "unresolved-proposals": "its proposals are still waiting",
  "pending-actions": "its actions are still waiting",
};

/**
 * The second line on a row, or nothing at all.
 *
 * The list this replaces said something under every title — `open · 4 points to decide`,
 * `closed · everything decided`. In a rail that is scanned rather than read, that is a permanent
 * second line spent on the state a person is not looking for. What survives is the one thing a
 * conversation can be owed: an answer.
 */
function whatItIsWaitingOn(row: WorldChatSummary): string | null {
  /*
   * "Waiting on you", not "a question": most are questions a press could not answer, but one
   * left by an accept that came back stale or unconfirmed is not — it wants a rebase or a look,
   * and sending somebody hunting for a question that does not exist is worse than saying less.
   */
  if (row.openProposalCount > 0) return `${row.openProposalCount} waiting on you`;
  return null;
}

/** What the menu on a row was opened for, and where to draw it. */
interface RowMenu {
  id: string;
  x: number;
  y: number;
  confirming: boolean;
}

/**
 * One row in the history rail: a title, what it is owed, and the way to everything else.
 *
 * The link stays a link and the menu button is its sibling, so keyboard order is row then menu
 * and neither has to swallow the other's click.
 */
function ConversationRow({
  worldId,
  row,
  current,
  open,
  onOpenMenu,
  onCloseMenu,
}: {
  worldId: string;
  row: WorldChatSummary;
  current: boolean;
  open: boolean;
  onOpenMenu: (menu: RowMenu) => void;
  onCloseMenu: () => void;
}) {
  const waiting = whatItIsWaitingOn(row);
  return (
    <div className={cx("fy-chatnav__row", current && "fy-chatnav__row--on")}>
      <Link to={`/w/${worldId}/chat/${row.id}`} className="fy-chatnav__item">
        <span className={cx("fy-chatnav__title", row.status === "closed" && "fy-chatnav__title--closed")}>
          {row.title}
        </span>
        {waiting && <span className="fy-chatnav__waiting">{waiting}</span>}
      </Link>
      <IconButton
        label="More"
        className={cx("fy-chatnav__more", open && "fy-chatnav__more--on")}
        aria-expanded={open}
        onClick={(e) => {
          if (open) {
            onCloseMenu();
            return;
          }
          // Measured on the press, because the menu is drawn outside the rail: the list scrolls,
          // and a menu positioned inside it is clipped at the first row past the fold.
          const at = e.currentTarget.getBoundingClientRect();
          onOpenMenu({ id: row.id, x: at.right - 190, y: at.bottom + 4, confirming: false });
        }}
      >
        <More size={14} />
      </IconButton>
    </div>
  );
}

/**
 * What a row can be told to do.
 *
 * Archive sits beside Delete rather than behind it because Archive is the answer whenever Delete
 * is refused — and Delete is refused for as long as a conversation's proposals are undecided,
 * which is most of the time it has done anything at all. A menu offering only the control that
 * will not work is a menu that reads as broken.
 *
 * Deleting confirms in place, two presses and no dialog, as archiving a world does. The second
 * press is the consent, and the sentence between them says what actually goes.
 *
 * Drawn as a child of the screen rather than of the rail. The rail carries an entrance animation
 * on `transform`, and an animated transform makes its element the containing block for anything
 * fixed inside it — which put this menu a rail's height below the row it belongs to, and shrank
 * the scrim that dismisses it to the width of the rail.
 */
export function RowMenuPanel({
  worldId,
  row,
  menu,
  onOpenMenu,
  onCloseMenu,
}: {
  worldId: string;
  row: WorldChatSummary;
  menu: RowMenu;
  onOpenMenu: (menu: RowMenu) => void;
  onCloseMenu: () => void;
}) {
  return (
    <>
      <div className="fy-chatnav__scrim" onClick={onCloseMenu} />
      <div className="fy-chatnav__menu" style={{ left: menu.x, top: menu.y }} role="menu">
        {menu.confirming ? (
          <>
            <div className="fy-chatnav__confirmsay">
              Delete this conversation? Its transcript, everything it understood and anything
              attached to it go for good, and proposals it produced can no longer be sent back
              here.
            </div>
            <div className="fy-chatnav__confirmacts">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  deleteWorldChat(worldId, row.id);
                  onCloseMenu();
                }}
              >
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={onCloseMenu}>
                Keep
              </Button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              className="fy-chatnav__menuitem"
              onClick={() => {
                if (row.status === "archived") unarchiveWorldChat(worldId, row.id);
                else archiveWorldChat(worldId, row.id);
                onCloseMenu();
              }}
            >
              {row.status === "archived" ? "Restore" : "Archive"}
            </button>
            <button
              type="button"
              className="fy-chatnav__menuitem"
              disabled={row.deletionBlock !== undefined}
              onClick={() => onOpenMenu({ ...menu, confirming: true })}
            >
              Delete
              {row.deletionBlock && (
                <span className="fy-chatnav__menuwhy">{WHY_NOT_DELETABLE[row.deletionBlock]}</span>
              )}
            </button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * The conversations this world has had, beside the one being had now.
 *
 * 236px and untinted — the geometry the production rail already uses — because this is
 * navigation between conversations rather than the content of one. The tinted 470px rail on the
 * other side stays the only column holding something to decide.
 *
 * Put away it is 48px, and both its controls survive: starting a conversation is what the screen
 * is for and must not cost an expand first.
 */
function HistoryRail({
  worldId,
  live,
  archived,
  currentId,
  open,
  onToggle,
  onNew,
  menu,
  onOpenMenu,
  onCloseMenu,
}: {
  worldId: string;
  live: readonly WorldChatSummary[];
  archived: readonly WorldChatSummary[];
  currentId: string | undefined;
  open: boolean;
  onToggle: () => void;
  onNew: () => void;
  menu: RowMenu | null;
  onOpenMenu: (menu: RowMenu) => void;
  onCloseMenu: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const rowProps = { worldId, onOpenMenu, onCloseMenu };
  return (
    <div className={cx("fy-chatnav", !open && "fy-chatnav--shut")}>
      <div className="fy-chatnav__head">
        {open && (
          <Button variant="outline" size="sm" className="fy-chatnav__new" onClick={onNew}>
            New conversation
          </Button>
        )}
        <IconButton label={open ? "Hide history" : "Show history"} onClick={onToggle}>
          <PanelLeft size={14} />
        </IconButton>
        {!open && (
          <IconButton label="New conversation" onClick={onNew}>
            <Plus size={14} />
          </IconButton>
        )}
      </div>
      {open && (
        <>
          <div className="fy-chatnav__list">
            {live.map((row) => (
              <ConversationRow
                key={row.id}
                row={row}
                current={row.id === currentId}
                open={menu?.id === row.id}
                {...rowProps}
              />
            ))}
            {/* Archived conversations stay behind a disclosure rather than sinking quietly to the
                bottom of one list. Archiving has to visibly tidy, or nobody uses it — and it is
                the only thing available while a conversation's proposals are still undecided. */}
            {showArchived &&
              archived.map((row) => (
                <ConversationRow
                key={row.id}
                row={row}
                current={row.id === currentId}
                open={menu?.id === row.id}
                {...rowProps}
              />
              ))}
          </div>
          {archived.length > 0 && (
            <button
              type="button"
              className="fy-chatnav__group"
              aria-expanded={showArchived}
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {`Archived · ${archived.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One point, and the two things that can now be done to it.
 *
 * The design this replaces had no controls on a point at all — deciding happened twice, and both
 * times about everything at once. That was right when a decision meant a whole conversation and
 * wrong in practice: a dozen points of which two are wrong took twelve to another screen to reject
 * two there. Save writes this line to the world; Reject drops it; talking still corrects it.
 *
 * A point that is not ready shows why instead of a Save it cannot honour. The reason is the same
 * one wrap-up would have given, said where it can be acted on rather than after the fact.
 */
function PointRow({
  point,
  busy,
  onSave,
  onReject,
  onMedia,
}: {
  point: {
    id: string;
    text: string;
    settled: boolean;
    kind: string;
    revision: number;
    groupId?: string;
    media?: { medium: "image" | "video"; brief: string; sessionId?: string; blockedReason?: string };
  };
  busy: boolean;
  onSave: () => void;
  onReject: () => void;
  onMedia: () => void;
}) {
  return (
    <div className="fy-panel__point">
      <div className="fy-panel__pointtext">{point.text}</div>
      {point.media && <div className="fy-panel__mediabrief">{point.media.brief}</div>}
      <div className="fy-panel__pointacts">
        {point.media ? (
          <Button variant="ghost" size="sm" disabled={busy || Boolean(point.media.blockedReason)} onClick={onMedia}>
            {busy ? "Preparing…" : point.media.sessionId ? "Open Bench" : `Prepare ${point.media.medium}`}
          </Button>
        ) : point.settled ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onSave}>
            {busy ? "Saving…" : "Save"}
          </Button>
        ) : (
          <span className="fy-panel__pointwhy">
            {point.kind === "question" ? "still open" : "still a maybe"}
          </span>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onReject}>
          Reject
        </Button>
      </div>
      {point.media?.blockedReason && <div className="fy-panel__mediawhy">{point.media.blockedReason}</div>}
    </div>
  );
}

/**
 * The first thing done in a conversation that does not exist yet.
 *
 * Nothing is created by arriving: a rail full of empty `New conversation` rows is the cost of
 * creating one per visit, and it is paid by everybody who ever opened the screen to read. So the
 * conversation is created by the first act — a sentence, a file, a pasted note — and that act is
 * held here until there is somewhere to put it.
 */
type Opening =
  | { kind: "say"; text: string }
  | { kind: "pick" }
  | { kind: "files"; files: readonly File[] }
  | { kind: "note"; text: string };

export function WorldChatScreen() {
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
  /** Whether the history is shown. Kept for the visit, as the rail itself is. */
  const [historyOpen, setHistoryOpen] = useState(true);
  /** The row whose menu is open, held here so the menu can be drawn clear of the rail. */
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const refusals = useWorldChatRefusals(conversationId);
  const wrapUpRefusal = useWorldChatWrapUpRefusal(conversationId);
  const rippleNotice = useWorldChatRipples(conversationId);
  /** Set while a wrap-up is in flight, so the button cannot be pressed twice into the same log. */
  const [wrappingUp, setWrappingUp] = useState(false);
  /**
   * Points with a decision in flight.
   *
   * Held per point rather than for the rail, because deciding one is no reason to freeze the
   * other eleven — the whole change is that these are separate decisions. Cleared when the
   * workspace comes back, which is the only thing that knows whether the point survived.
   */
  const [busyPoints, setBusyPoints] = useState<string[]>([]);
  const mediaRequests = useRef(new Map<string, string>());
  const [mediaRefusal, setMediaRefusal] = useState<string | null>(null);
  /** The act waiting on a conversation to exist, and what was open when it was asked for. */
  const [opening, setOpening] = useState<{ act: Opening; wasOpen: string | null } | null>(null);
  /** What a deferred attach would not take, since the composer's own call answered before it ran. */
  const [deferredTrouble, setDeferredTrouble] = useState<readonly { name: string; reason: string }[]>([]);

  const world = state?.world;
  const row = world?.conversations.find((c) => c.id === conversationId);

  // Ask for the workspace on arrival and release it on the way out, so a session that visits
  // twenty conversations still holds one. A new conversation has none to ask for.
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
  const opened = workspace?.conversationId ?? null;

  useEffect(() => {
    mediaRequests.current.clear();
    setMediaRefusal(null);
  }, [conversationId]);

  useEffect(
    () =>
      subscribeWorldChatMediaOpened((answer) => {
        const candidateId = mediaRequests.current.get(answer.requestId);
        if (!candidateId || answer.conversationId !== conversationId || answer.worldId !== worldId) return;
        mediaRequests.current.delete(answer.requestId);
        setBusyPoints((points) => points.filter((id) => id !== candidateId));
        if (answer.sessionId) {
          setMediaRefusal(null);
          void navigate(`/w/${worldId}/artifacts/bench/${answer.sessionId}`);
        } else {
          setMediaRefusal(answer.reason ?? "The Bench could not be prepared.");
        }
      }),
    [conversationId, navigate, worldId],
  );

  /**
   * The conversation arriving is what the held act was waiting for.
   *
   * Creating is the coordinator's job, so the new id does not exist here yet — but the create
   * handler opens the conversation as it finishes, so the workspace arriving in state is the
   * signal. It has to be a *different* workspace than the one open when the act was held: a
   * screen arrived at with somebody else's conversation still loaded would otherwise take the
   * message meant for a new one and put it in that.
   *
   * The create and the act stay two frames. Related frames sent in one tick race, and the second
   * would reach the coordinator before the conversation it names exists.
   */
  useEffect(() => {
    if (!opening || !worldId) return;
    if (connection !== "open") {
      // Nothing was transmitted, or the answer went with the socket. The draft is still here.
      setOpening(null);
      return;
    }
    if (!opened || opened === opening.wasOpen) return;
    const act = opening.act;
    setOpening(null);
    if (act.kind === "say") {
      sendWorldChat(worldId, opened, act.text);
      setDraft("");
    } else if (act.kind === "pick") {
      worldChatAttachFiles(worldId, opened);
    } else if (act.kind === "files") {
      void attachHostFiles(worldChatAttachTarget(worldId, opened), act.files).then(setDeferredTrouble);
    } else {
      void attachHostText(worldChatAttachTarget(worldId, opened), act.text, "pasted-note.txt").then(
        setDeferredTrouble,
      );
    }
    navigate(`/w/${worldId}/chat/${opened}`, { replace: true });
  }, [opening, opened, worldId, connection, navigate]);

  /**
   * Start one. No title is asked for: nobody knows what a conversation is about before having
   * it, and the coordinator names it from the opening sentence anyway.
   */
  const hold = (act: Opening) => {
    if (!worldId || opening) return;
    setOpening({ act, wasOpen: opened });
    createWorldChat(worldId, "New conversation", crypto.randomUUID());
  };

  /*
   * A decision on one point. Save writes it; Reject drops it. Both send the revision the rail is
   * showing, so a point corrected by talking since is refused rather than acted on as it was.
   */
  const decide = (point: { id: string; revision: number; groupId?: string }, action: "save" | "reject") => {
    if (!worldId || !conversationId) return;
    /*
     * A grouped point writes its siblings too, so the request carries what the rail was showing
     * for each of them. Checking only the point that was pressed would let a sibling corrected in
     * another window be written unseen, as part of a save nobody made about it.
     */
    const members = point.groupId
      ? points.filter((p) => p.groupId === point.groupId).map((p) => ({ candidateId: p.id, revision: p.revision }))
      : [];
    const sent =
      action === "save"
        ? saveWorldChatPoint(worldId, conversationId, point.id, point.revision, members) !== null
        : rejectWorldChatPoint(worldId, conversationId, point.id, point.revision, members);
    if (sent) setBusyPoints((prev) => [...prev, point.id]);
  };

  const openMedia = (point: { id: string; revision: number; media?: { sessionId?: string } }) => {
    if (!worldId || !conversationId) return;
    if (point.media?.sessionId) {
      void navigate(`/w/${worldId}/artifacts/bench/${point.media.sessionId}`);
      return;
    }
    const requestId = openWorldChatMedia(worldId, conversationId, point.id, point.revision);
    if (!requestId) return;
    mediaRequests.current.set(requestId, point.id);
    setBusyPoints((points) => [...points, point.id]);
    setMediaRefusal(null);
  };

  /*
   * The workspace arriving is the answer: whatever it now holds is what survived the decision.
   *
   * A refusal is an answer too, and several arrive without appending anything to the conversation
   * — a readiness that moved, a staging that was refused. The sequence is then unchanged and a
   * point would sit on "Saving…" until something unrelated happened, so the refusal clears it as
   * surely as a new sequence does.
   */
  useEffect(() => {
    setBusyPoints([]);
  }, [loaded?.seq, wrapUpRefusal]);

  const closed = loaded?.status === "closed";
  /** The attempt this window made, if any: an answer naming another one is somebody else's. */
  const asked = useRef<string | null>(null);
  /** A mixed Accept all shows its landed ripples here before carrying its unanswered point away. */
  const proposalsAfterNews = useRef(false);
  const refusedMine = wrapUpRefusal !== null && wrapUpRefusal.requestId === asked.current;
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
   * The connection ends the *waiting look* but not the errand. A socket that drops mid-wrap-up
   * takes the answer with it, and leaving the button on "Writing them…" for the rest of the
   * session is the failure this whole change is about — but the coordinator may well have
   * finished, and the closed workspace that proves it arrives on the next connection. So the
   * asking is remembered in a ref that no reconnection clears, and the button is freed meanwhile.
   */
  useEffect(() => {
    if (!worldId) return;
    if (asked.current && closed) {
      asked.current = null;
      setWrappingUp(false);
      /*
       * Only when something is actually waiting.
       *
       * Accept all writes; it no longer stages for a screen to visit afterwards, so being taken
       * to an empty approvals list would be the app performing a step it had just removed. What
       * can still be waiting is a proposal carrying an open choice — a question only the person
       * can answer — and that is worth going to, because it is the one thing this press could
       * not decide for them.
       */
      if ((row?.openProposalCount ?? 0) > 0) {
        if (rippleNotice) proposalsAfterNews.current = true;
        else navigate(`/w/${worldId}/proposals`);
      }
    } else if (proposalsAfterNews.current && !rippleNotice && (row?.openProposalCount ?? 0) > 0) {
      proposalsAfterNews.current = false;
      navigate(`/w/${worldId}/proposals`);
    } else if (wrappingUp && (refusedMine || connection !== "open")) {
      setWrappingUp(false);
    }
  }, [wrappingUp, closed, refusedMine, connection, worldId, navigate, row?.openProposalCount, rippleNotice]);

  const rows = useMemo(
    () => [...(world?.conversations ?? [])].sort(byPendingConsequence),
    [world?.conversations],
  );
  const live = useMemo(() => rows.filter((r) => r.status !== "archived"), [rows]);
  const archived = useMemo(() => rows.filter((r) => r.status === "archived"), [rows]);
  // A conversation deleted in another window takes its menu with it rather than leaving one
  // standing over a row that is gone.
  const menuRow = menu ? rows.find((r) => r.id === menu.id) : undefined;

  if (!world) return null;
  /**
   * Missing means missing from both.
   *
   * The row and the workspace arrive by different routes, so one can lag the other by a frame —
   * and the workspace is the better authority: it was loaded by this id and came back. Declaring
   * the conversation gone because the *summary list* had not caught up is how somebody who has
   * just created one is told it does not exist.
   */
  const missing = conversationId !== undefined && !row && !loaded;
  const points = loaded?.points ?? [];
  const groups = groupBySubject(points);
  const openThreads = points.filter((p) => p.kind === "question");
  const carried = points.filter((p) => p.kind === "point" && p.settled).length;
  const running = loaded?.runStatus === "running";
  const failure = loaded?.lastFailure;
  const starting = opening !== null;
  /**
   * Attachments are private to this conversation, and the chips say which are readable.
   * An image can be attached and referred to; it cannot be quoted, and the chip should not
   * suggest otherwise (§13.2).
   */
  const chips = (loaded?.attachments ?? [])
    .filter((a) => !dismissed.includes(a.id))
    .map((a) => ({
      id: a.id,
      file: attachmentChipLabel(a),
      kind: a.kind,
    }));

  return (
    <div
      data-screen={conversationId ? "world-chat-conversation" : "world-chat"}
      className="fy-chat__wrap"
    >
      <div className="fy-gate">
        <HistoryRail
          worldId={worldId!}
          live={live}
          archived={archived}
          currentId={conversationId}
          open={historyOpen}
          onToggle={() => setHistoryOpen((v) => !v)}
          onNew={() => navigate(`/w/${worldId}/chat`)}
          menu={menu}
          onOpenMenu={setMenu}
          onCloseMenu={() => setMenu(null)}
        />

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
            {/* The mode changes initiative, never acceptance authority (SPEC-023 R-21). */}
            {loaded && conversationId && worldId && (
              <button
                type="button"
                className="fy-pill"
                style={{ cursor: "pointer", marginLeft: "auto" }}
                title="How eagerly the studio proposes. Nothing lands without your acceptance either way."
                onClick={() => {
                  const next =
                    loaded.initiative === "assist"
                      ? "collaborate"
                      : loaded.initiative === "collaborate"
                        ? "develop"
                        : "assist";
                  setWorldChatInitiative(worldId, conversationId, next);
                }}
              >
                {loaded.initiative === "assist" ? "Assist" : loaded.initiative === "develop" ? "Develop" : "Collaborate"}
              </button>
            )}
          </div>

          <div className="fy-gate__body">
            {missing ? (
              <EmptyState
                title="That conversation is not here"
                hint="It may have been deleted. The ones this world still has are in the history beside this."
              />
            ) : conversationId && loaded === null ? (
              <div className="fy-chat__loading">Opening this conversation…</div>
            ) : (
              <ConversationTranscript
                workspace={loaded}
                running={running}
                progress={progress}
                failure={failure && !running ? failure : null}
                canRetry={!wrappingUp}
                {...(worldId && conversationId ? { onStop: () => cancelWorldChat(worldId, conversationId) } : {})}
                {...(worldId && conversationId
                  ? { onRetry: (turnId: string) => retryWorldChatTurn(worldId, conversationId, turnId) }
                  : {})}
                {...(worldId ? { onUndoBible: (fromVersion: number) => restoreBible(worldId, fromVersion) } : {})}
              />
            )}
          </div>

          <div className="fy-chat__composer">
            <Composer
              value={draft}
              onChange={setDraft}
              onSubmit={() => {
                const text = draft.trim();
                if (!text || !worldId || running || wrappingUp || starting) return;
                if (!conversationId) {
                  hold({ kind: "say", text });
                  return;
                }
                sendWorldChat(worldId, conversationId, text, chips.map((c) => c.id));
                setDraft("");
              }}
              placeholder={conversationId ? "Keep going…" : "Say something about this world…"}
              busy={running || starting}
              busyLabel={starting ? "Starting…" : "Thinking…"}
              attachments={chips}
              refusals={[...refusals, ...deferredTrouble]}
              // Appended to whatever is already typed, never sent: speaking gets you to a draft,
              // and the draft is still corrected and sent by hand (SPEC-018 R-2, R-5).
              onDictate={(text) => setDraft((prev) => (prev ? `${prev} ${text}` : text))}
              {...(worldId && !wrappingUp
                ? {
                    onAttach: () => {
                      if (conversationId) worldChatAttachFiles(worldId, conversationId);
                      else hold({ kind: "pick" });
                    },
                  }
                : {})}
              {...(worldId && hostCanAttach() && !wrappingUp
                ? {
                    onAttachFiles: (files: readonly File[]) => {
                      if (conversationId) {
                        return attachHostFiles(worldChatAttachTarget(worldId, conversationId), files);
                      }
                      // Held until the conversation exists, so this call has no refusals to
                      // report yet; the ones the deferred attach earns reach the composer
                      // through `deferredTrouble`.
                      hold({ kind: "files", files });
                      return Promise.resolve([]);
                    },
                    onAttachText: (text: string) => {
                      if (conversationId) {
                        return attachHostText(
                          worldChatAttachTarget(worldId, conversationId),
                          text,
                          "pasted-note.txt",
                        );
                      }
                      hold({ kind: "note", text });
                      return Promise.resolve([]);
                    },
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
                wrappingUp
                  ? "This conversation is being turned into proposals."
                  : (composerReason(state) ?? closedReason(loaded?.status))
              }
            />
            {/* Stop lives on the working line in the transcript now, beside what it would stop. */}
            <div className="fy-chat__composernote">
              world author · talking changes nothing until you save
            </div>
          </div>
        </div>

        <div className="fy-gate__side">
          <div className="fy-panel__head">
            <div className="fy-panel__headline">
              <div className="fy-panel__title">What I&rsquo;ve understood</div>
              <div className="fy-panel__count">
                {carried} of {points.length} ready
              </div>
            </div>
            <div className="fy-panel__note">
              Save writes a line to the world. If one is wrong, say so and it changes — or reject it.
            </div>
            {mediaRefusal && <div className="fy-panel__mediawhy" role="status">{mediaRefusal}</div>}
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
                      <PointRow
                        key={p.id}
                        point={p}
                        busy={busyPoints.includes(p.id) || running || wrappingUp}
                        onSave={() => decide(p, "save")}
                        onReject={() => decide(p, "reject")}
                        onMedia={() => openMedia(p)}
                      />
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
                      <PointRow
                        key={p.id}
                        point={p}
                        busy={busyPoints.includes(p.id) || running || wrappingUp}
                        onSave={() => decide(p, "save")}
                        onReject={() => decide(p, "reject")}
                        onMedia={() => openMedia(p)}
                      />
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
                // button would sit on "Writing them…" for the rest of the session.
                //
                // No confirmation sheet, and no navigation yet either: an earlier design had a
                // sheet here that said less than the screen it stood in front of, and the version
                // after it left for the proposals before knowing there were any. The effect above
                // goes when the conversation closes.
                const attempt = wrapUpWorldChat(worldId, conversationId!, loaded.seq);
                if (!attempt) return;
                asked.current = attempt;
                setWrappingUp(true);
              }}
            >
              {wrappingUp ? "Writing them…" : `Accept all${carried > 0 ? ` · ${carried}` : ""}`}
            </Button>
            {/*
              A refused wrap-up is the one thing this rail must not swallow. Nothing was written,
              so the panel above is unchanged and says nothing about it — without this line the
              press leaves no trace at all.
            */}
            {wrapUpRefusal && !wrappingUp && (
              <div className="fy-panel__refused" role="status">
                {wrapUpRefusal.detail}
              </div>
            )}
            {rippleNotice && (
              <div className="fy-panel__refused" role="status">
                <strong>What changed elsewhere</strong>
                {rippleNotice.items.map((item, index) => (
                  <div key={`${item.kind}:${index}`}>{item.summary}</div>
                ))}
                <Button variant="ghost" onClick={() => dismissWorldChatRipples(conversationId!)}>
                  Dismiss
                </Button>
              </div>
            )}
            <div className="fy-panel__caption">
              {carried === 0
                ? "Nothing is ready to write yet."
                : `Writes the ${carried} ready to the world and closes this conversation. Save them one at a time above to keep talking.`}
            </div>
          </div>
        </div>
      </div>
      {menuRow && (
        <RowMenuPanel
          worldId={worldId!}
          row={menuRow}
          menu={menu!}
          onOpenMenu={setMenu}
          onCloseMenu={() => setMenu(null)}
        />
      )}
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
    case "production":
      return `Development · ${context.productionId}`;
    case "episode":
      return `episode · ${context.episodeId}`;
    case "scene":
      return `scene · ${context.sceneId}`;
    default:
      return "";
  }
}

/** Points group under the thing they are about, per R-15 — not under what kind of change they are. */
function groupBySubject<P extends { id: string; kind: string; subject: string; subjectKind: string }>(
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

/**
 * What a failed turn says.
 *
 * Plainly, and about the app rather than the person: they typed something reasonable and waited.
 * The `detail` the coordinator carries is operator-safe by construction, so it can be shown, but
 * it is a supporting clause and never the whole sentence -- "the studio took too long to answer"
 * on its own does not tell somebody the message is still there and can be sent again.
 */
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

/**
 * Why the composer cannot send — and after Accept all, it can.
 *
 * A closed conversation used to refuse with "send one back to carry on", which is advice nobody
 * could take: Accept all writes what it carried, so a wrap-up that succeeded leaves no proposal
 * to send back and the thread was finished whether or not the person was. Saying something
 * reopens it, which is what carrying on has always meant.
 *
 * Archived still refuses. That one was filed on purpose and is restored on purpose.
 */
function closedReason(status: string | undefined): string | undefined {
  if (status === "archived") return "This conversation is archived. Restore it to carry on.";
  return undefined;
}
