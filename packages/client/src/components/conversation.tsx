import { useEffect, useMemo, useRef, useState } from "react";
import type {
  StagedProposal,
  WorldChatContext,
  WorldChatPoint,
  WorldChatStatus,
  WorldChatWorkspace,
} from "@arke-studio/contracts";
import { Composer } from "./composer.js";
import {
  acceptProposal,
  cancelWorldChat,
  createWorldChat,
  discardProposal,
  rejectWorldChatPoint,
  restoreBible,
  saveWorldChatPoint,
  openWorldChat,
  retryWorldChatTurn,
  sendWorldChat,
  useStore,
  useWorldChatProgress,
  useWorldChatWrapUpRefusal,
  worldChatAttachFiles,
  wrapUpWorldChat,
} from "../lib/store.js";
import { Working } from "./working.js";
import { Badge, Button, cx } from "./ui.js";
import { More } from "./icons.js";

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
  dock?: { title: string; subject: string };
}) {
  const { state } = useStore();
  const [message, setMessage] = useState("");
  /*
   * Wrap-up state lives here rather than inside WrapUp (review 2026-08-22): retry is a way of
   * saying something again, so it is held back while a wrap-up commits — a condition the
   * transcript needs and a child's local state could not express.
   */
  const [wrapping, setWrapping] = useState(false);
  /** An opening message waiting for the conversation it opened to arrive. */
  const [opening, setOpening] = useState<{ text: string; was: string | null } | null>(null);
  const context: WorldChatContext = entry ?? { kind: "production", productionId: productionId ?? "" };
  const contextKey = JSON.stringify(context);
  /*
   * Navigating between subjects reuses this mounted component (episode 3 → episode 4), and an
   * unsent draft typed against one subject must not be sent into the other's thread
   * (review 2026-08-22). The handover latch resets with it, for the same reason.
   */
  useEffect(() => {
    setMessage("");
    setOpening(null);
  }, [contextKey]);
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
  useEffect(() => {
    if (!opening || !worldId) return;
    const opened = workspace?.conversationId ?? null;
    if (!opened || opened === opening.was) return;
    sendWorldChat(worldId, opened, opening.text);
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
      sendWorldChat(worldId, conversationId, openWith);
      return;
    }
    setOpening({ text: openWith, was: workspace?.conversationId ?? null });
    createWorldChat(worldId, conversationTitle(openWith), crypto.randomUUID(), context);
    // context is derived from route params and rebuilt each render; the latch above is what
    // makes this safe to leave out of the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openWith, worldId, productionId, conversationId]);

  const submit = () => {
    const text = message.trim();
    if (!text || !worldId || !productionId) return;
    setMessage("");
    /*
     * No thread yet: the first thing said opens one and is then said into it. Creating does not
     * take a turn — it only names the conversation — so without the send that follows, the
     * opening message became a title and the studio never answered it (turn 95).
     */
    if (!conversationId) {
      setOpening({ text, was: workspace?.conversationId ?? null });
      createWorldChat(worldId, conversationTitle(text), crypto.randomUUID(), context);
      return;
    }
    sendWorldChat(worldId, conversationId, text);
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
    file: a.readability === "not-readable" ? `${a.fileName} · not readable in chat` : a.fileName,
    kind: a.kind,
  }));
  const attachProps = {
    attachments: attachChips,
    ...(worldId && conversationId
      ? { onAttach: () => worldChatAttachFiles(worldId, conversationId) }
      : {}),
  };
  const transcript = (
    <ConversationTranscript
      workspace={loaded}
      running={running}
      progress={progress}
      failure={failure && !running ? failure : null}
      canRetry={!wrapping}
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
      <aside className="fy-arke" data-dock="conversation">
        <div className="fy-arke__head">
          <span className="fy-arke__who">
            <span className="fy-arke__name">{dock.title}</span>
            <span className="fy-mono">{dock.subject}</span>
          </span>
        </div>
        <div className="fy-arke__log" aria-live="polite">
          {transcript}
        </div>
        <div className="fy-arke__strip">
          {side ?? (
            <>
              {/* The understanding is still here, put away rather than dropped: a column this
                  narrow cannot hold it open beside a transcript, and the wrap-up beneath it is
                  the only way a conversation becomes anything (turn 92). */}
              {pointsEmpty !== undefined && (
                <details className="fy-arke__points">
                  <summary>
                    What it understood <span className="fy-mono">{points.length > 0 ? points.length : "nothing yet"}</span>
                  </summary>
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
                </details>
              )}
              <WrapUp
                worldId={worldId}
                conversationId={conversationId}
                seq={loaded?.seq ?? null}
                carried={carriedPoints}
                status={loaded?.status ?? null}
                wrapping={wrapping}
                onWrappingChange={setWrapping}
              />
            </>
          )}
        </div>
        <div className="fy-arke__foot">
          <Composer
            value={message}
            onChange={setMessage}
            onSubmit={submit}
            placeholder={placeholder}
            agentLabel="story author"
            busy={running}
            busyLabel="reading the world…"
            onDictate={(text) => setMessage((prev) => (prev ? `${prev} ${text}` : text))}
            {...attachProps}
          />
          <div className="fy-mono">talking changes nothing · a change waits for your yes</div>
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
        <Composer
          value={message}
          onChange={setMessage}
          onSubmit={submit}
          placeholder={placeholder}
          agentLabel="story author"
          busy={running}
          busyLabel="reading the world…"
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
          {...(worldId && conversationId
            ? {
                onSave: (point: WorldChatPoint) =>
                  saveWorldChatPoint(worldId, conversationId, point.id, point.revision),
                onReject: (point: WorldChatPoint) =>
                  rejectWorldChatPoint(worldId, conversationId, point.id, point.revision),
              }
            : {})}
        />
        {/* Every level has a wrap-up (turn 92). It was drawn on 89a from the start and built
            nowhere, which left the season — the first hop anybody walks — with no way to turn a
            conversation into anything at all. */}
        <WrapUp
          worldId={worldId}
          conversationId={conversationId}
          seq={loaded?.seq ?? null}
          carried={carriedPoints}
          status={loaded?.status ?? null}
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
  wrapping,
  onWrappingChange,
}: {
  worldId: string | undefined;
  conversationId: string | null;
  seq: number | null;
  carried: number;
  /** A wrap-up that landed closes the conversation; nothing else on this dock does. */
  status: WorldChatStatus | null;
  /* Lifted (review 2026-08-22): the transcript holds retry back while a wrap-up commits. */
  wrapping: boolean;
  onWrappingChange: (next: boolean) => void;
}) {
  const setWrapping = onWrappingChange;
  const asked = useRef<string | null>(null);
  const refusal = useWorldChatWrapUpRefusal(conversationId ?? undefined);
  const refusedMine = refusal !== null && refusal.requestId === asked.current;
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
          asked.current = attempt;
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
  /** What applying does, said plainly under the buttons. */
  writes: string;
  /**
   * Where accepting lands you (turn 91). Absent when this is docked beside the thing it decides
   * (turns 99, 100): you are already on it, and the change appears where it lives.
   */
  onAccepted?: () => void;
}) {
  /*
   * Set aside by `Keep discussing` (turn 101). The change is still staged and still on disk —
   * this is a card being folded to a line, not a proposal being dropped, which is the whole
   * difference between the two buttons.
   */
  const [aside, setAside] = useState(false);
  const targets = staged.review?.targets ?? [];
  const fields = targets.flatMap((t) => t.fields);
  /*
   * Whether to show the before-and-after (turn 101, binding three). A diff is what you show when
   * a change would overwrite or delete something a person wrote; for anything additive it is a
   * form standing between somebody and their own work. The rule reads the gate's own review
   * rather than guessing from the proposal kind: `amend` over a field that already had words, or
   * a field proposed as nothing, is a change that takes something away.
   */
  const overwrites =
    fields.some((f) => f.proposed === null) ||
    targets.some((t) => t.action === "amend" && t.fields.some((f) => f.before !== null));
  const count = targets.length;
  if (aside) {
    return (
      <button type="button" className="fy-madeaside" onClick={() => setAside(false)}>
        <span className="fy-dot fy-dot--warn" />
        {count} change{count === 1 ? "" : "s"} waiting
        <span className="fy-mono">show</span>
      </button>
    );
  }
  return (
    <div className="fy-made" aria-label={`Changes to ${subject}`}>
      {/*
        The things themselves, not fields with a before and an after (turn 101). What Arke said
        about them is the message above this card, in the transcript, where a sentence belongs.
      */}
      {overwrites ? (
        <div className="fy-made__diff">
          {/* Grouped under the thing each field changes (review 2026-08-22): a wrap-up amending
              three episodes rendered three cards all reading "Opens" with duplicate keys and
              nothing saying which episode each replacement belonged to. */}
          {targets.map((t) => (
            <div key={t.path}>
              {targets.length > 1 && (
                <div className="fy-mono" style={{ marginBottom: 6 }}>
                  {t.label}
                </div>
              )}
              {t.fields.map((field) => (
                <div key={`${t.path}:${field.field}`} className="fy-draftcard">
                  <div className="fy-draftcard__head">
                    <span className="fy-eyebrow-sm">{field.field}</span>
                    <Badge tone="warning">replaces</Badge>
                  </div>
                  <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 6 }}>
                    {field.proposed ?? "(removed)"}
                  </div>
                  {field.before !== null && <div className="fy-draftcard__was">Now: “{field.before}”</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="fy-made__list">
          {targets.map((t) => (
            <div key={t.path} className="fy-made__row">
              <span className="fy-made__tag">{t.action === "create" ? "NEW" : "CHANGED"}</span>
              <span className="fy-made__name">{t.label}</span>
              <span className="fy-mono">{t.kind}</span>
            </div>
          ))}
          {targets.length === 0 && (
            <div className="fy-made__row">
              <span className="fy-made__name">{staged.proposal.summary}</span>
            </div>
          )}
        </div>
      )}
      <div className="fy-made__acts">
        <Button
          variant="primary"
          size="sm"
          disabled={!worldId}
          onClick={() => {
            if (!worldId) return;
            acceptProposal(worldId, staged.proposal.id);
            // Applying lands you on the thing you changed (turn 91) — or leaves you there, when
            // the panel is docked on it already (turns 99, 100).
            onAccepted?.();
          }}
        >
          Apply changes
        </Button>
        <Button variant="outline" size="sm" onClick={() => setAside(true)}>
          Keep discussing
        </Button>
        <span style={{ flex: 1 }} />
        {/* Dropping it is a real act and lives where a real act lives — away from the yes. */}
        <button
          type="button"
          className="fy-made__drop"
          title="Drop these changes"
          aria-label="Drop these changes"
          disabled={!worldId}
          onClick={() => worldId && discardProposal(worldId, staged.proposal.id)}
        >
          <More size={14} />
        </button>
      </div>
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
