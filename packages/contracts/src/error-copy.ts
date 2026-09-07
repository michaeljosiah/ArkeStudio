/**
 * Plain-English error copy (the house rule for screens: labels and short sentences, never a
 * developer sentence — see `docs/decisions` and `screens-do-not-explain`). A caught error's own
 * `.message` is written for whoever reads logs or a failing test, not for the person looking at
 * the screen; `diagnostics.ts`'s own `rule-failed` finding already treats a thrown error's message
 * as unvouched text and carries only its type, never its words. This module is the one place both
 * `coordinator` and `client` reach for when an exception has to become on-screen copy, so that
 * judgment call is made once rather than reinvented at each of the many places an error is caught.
 */

/** Node's own `err.code` for the failures a person can actually do something about. */
const SYSTEM_ERROR_COPY: Record<string, string> = {
  ENOENT: "That file no longer exists.",
  EACCES: "Permission was denied.",
  EPERM: "Permission was denied.",
  EBUSY: "That file is in use by something else.",
  ENOSPC: "The disk is full.",
  ECONNREFUSED: "Couldn't connect — try again.",
  ETIMEDOUT: "The connection timed out.",
  ECONNRESET: "The connection was lost.",
};

/** What nothing more specific can be said about — never a raw exception message. */
export const GENERIC_ERROR_COPY = "Something went wrong. Try again.";

/**
 * The shared fallback: known system-error codes get their own sentence; a plain `Error` (the
 * overwhelming case in this codebase — `throw new Error("a sentence a reader could stand in
 * front of")`) is trusted as already being that sentence and passed through untouched; the
 * engine's own error types (`SyntaxError`, `TypeError`, `RangeError` — a bad JSON parse, an
 * unexpected shape) report positions and internals nobody authored for a screen, so those fall
 * back to the generic line rather than being shown.
 *
 * App-specific error classes with their own developer-facing `.message` (a stale commit, a
 * malformed plan) are not handled here — they are known only where they are thrown, so the
 * package that defines them wraps this function with its own cases first.
 */
export function describeError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code in SYSTEM_ERROR_COPY) return SYSTEM_ERROR_COPY[code]!;
  if (err instanceof SyntaxError || err instanceof TypeError || err instanceof RangeError) {
    return GENERIC_ERROR_COPY;
  }
  if (err instanceof Error && err.message.length > 0) return err.message;
  return GENERIC_ERROR_COPY;
}
