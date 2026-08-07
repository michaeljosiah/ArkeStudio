import { useEffect, useRef, useState } from "react";
import { Loading } from "./loading.js";

/**
 * What the studio is doing, while it is doing it (#70 §15.3).
 *
 * Ported from opencode's session-turn indicator, which reads `[spinner] Making edits · 12s`. Three
 * things in that design are doing the work, and all three are here:
 *
 *   · **a verb, not a state.** "Searching canon" is a thing being done for you; "busy" is a thing
 *     being done to you. The label changes as the turn moves, so the surface is evidence that
 *     something is happening rather than an assertion that it is.
 *   · **elapsed time.** It is the only honest number available — nothing can say how long is
 *     left — and it is what turns "is this broken?" into "this is taking a while".
 *   · **a throttle.** Labels are held for 2.5s before being replaced, opencode's interval. Without
 *     it a run that makes four quick searches strobes through four words and reads as a glitch.
 *
 * What is deliberately *not* ported is opencode's spinner: sixteen squares pulsing on randomised
 * delays. This app already settled its one loading state — the wordmark's A with a band of light,
 * which does not move — and having two would make the studio thinking look like a different kind
 * of wait from everything else that waits. See components/loading.tsx for that decision.
 *
 * opencode has no `prefers-reduced-motion` handling at all in its web UI; its terminal UI has an
 * explicit animations toggle that falls back to a static glyph. The house loader is already
 * static, so the reduced-motion case costs nothing here — the words carry the state either way,
 * which is the rule this app holds anyway (SPEC-018 R-16).
 */

/** opencode's interval, and it is the load-bearing number: below ~2s this reads as a strobe. */
const LABEL_HOLD_MS = 2_500;

/**
 * Hold a label for a minimum interval, then take the newest one.
 *
 * The trailing timer matters: without it the last change in a burst is dropped, so a turn that
 * finishes its searches quickly would sit on "Searching canon" while it wrote the reply.
 */
function useHeldLabel(label: string, holdMs = LABEL_HOLD_MS): string {
  const [held, setHeld] = useState(label);
  const changedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const since = Date.now() - changedAt.current;
    if (since >= holdMs) {
      changedAt.current = Date.now();
      setHeld(label);
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      changedAt.current = Date.now();
      setHeld(label);
    }, holdMs - since);
    return () => clearTimeout(timer.current);
  }, [label, holdMs]);

  return held;
}

/**
 * Seconds since the turn began, ticking.
 *
 * Counted from the coordinator's timestamp rather than from when this mounted, so reconnecting
 * mid-turn — or navigating away and back — does not restart the clock on a turn that has been
 * running for a minute.
 */
function useElapsed(startedAt: string | null): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (startedAt === null) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function Working({
  label,
  startedAt,
  onStop,
}: {
  /** What it is doing. Falls back to a resting word, because a spinner with no words is a shrug. */
  label: string | null;
  startedAt: string | null;
  onStop?: () => void;
}) {
  const held = useHeldLabel(label ?? "Thinking");
  const elapsed = useElapsed(startedAt);

  /**
   * Escape stops the turn, as it does in opencode.
   *
   * Bound on the window rather than the composer: by the time somebody wants to stop, focus may
   * be anywhere on the page — and a shortcut that only works if you never clicked away is one
   * that fails exactly when it is wanted. Single press, no confirmation: this is interrupting a
   * read, not discarding work, and everything already said stays where it is.
   */
  useEffect(() => {
    if (!onStop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onStop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStop]);

  return (
    <div className="fy-working" role="status" aria-live="polite">
      <Loading inline />
      <span className="fy-working__label">{held}</span>
      {elapsed && (
        <>
          <span className="fy-working__dot" aria-hidden="true">
            ·
          </span>
          {/* Read out as a word, because "12s" alone announces as a bare number. */}
          <span className="fy-working__elapsed">
            <span aria-hidden="true">{elapsed}</span>
            <span className="fy-sr-only">{elapsed} elapsed</span>
          </span>
        </>
      )}
      {onStop && (
        <button type="button" className="fy-working__stop" onClick={onStop}>
          Stop <span className="fy-working__key">esc</span>
        </button>
      )}
    </div>
  );
}
