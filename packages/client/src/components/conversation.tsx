import { useEffect, useMemo, useState } from "react";
import type { WorldChatWorkspace } from "@arke-studio/contracts";
import { Composer } from "./composer.js";
import {
  cancelWorldChat,
  createWorldChat,
  openWorldChat,
  retryWorldChatTurn,
  sendWorldChat,
  useStore,
  useWorldChatProgress,
} from "../lib/store.js";
import { Working } from "./working.js";
import { Button, cx } from "./ui.js";

/**
 * One conversation, drawn once (design turn 86).
 *
 * World Chat has a screen built around a conversation — a history rail, a points panel, wrap-up.
 * Development has a *view* built around one, where the same turns sit beside the draft they are
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
 * The production's own Development thread, in the view that is shaping it (design turn 86).
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
}: {
  worldId: string | undefined;
  productionId: string | undefined;
  placeholder: string;
  eyebrow?: string;
  heading?: string;
  /** What stands where the transcript will be, before anything has been said. */
  emptyLine: string;
  footer?: React.ReactNode;
}) {
  const { state } = useStore();
  const [message, setMessage] = useState("");
  const thread = useMemo(() => {
    const rows = (state?.world?.conversations ?? []).filter(
      (c) => c.entryContext?.kind === "production" && c.entryContext.productionId === productionId,
    );
    return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }, [state?.world?.conversations, productionId]);
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
      createWorldChat(worldId, text, crypto.randomUUID(), { kind: "production", productionId });
      return;
    }
    sendWorldChat(worldId, conversationId, text);
  };

  return (
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
                <div className="fy-bubble__note">the Development thread · opening…</div>
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
}
