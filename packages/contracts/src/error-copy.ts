/**
 * Plain-English error copy — the house rule for on-screen text (CLAUDE.md, "House style"):
 * "labels over sentences, and drastically plainer than the prose in comments and specs." A caught
 * error's own `.message` is written for whoever reads logs or a failing test, not for the person
 * looking at the screen; `diagnostics.ts`'s own `rule-failed` finding already treats a thrown
 * error's message as unvouched text and carries only its type, never its words. This module is
 * the one place both `coordinator` and `client` reach for when an exception has to become
 * on-screen copy, so that judgment call is made once rather than reinvented at each of the many
 * places an error is caught.
 */

/** Node's own `err.code` for the failures a person can actually do something about. */
const SYSTEM_ERROR_COPY = new Map<string, string>([
  ["ENOENT", "That file no longer exists."],
  ["EACCES", "Permission was denied."],
  ["EPERM", "Permission was denied."],
  ["EBUSY", "That file is in use by something else."],
  ["ENOSPC", "The disk is full."],
  ["ECONNREFUSED", "Couldn't connect — try again."],
  ["ETIMEDOUT", "The connection timed out."],
  ["ECONNRESET", "The connection was lost."],
]);

/** What nothing more specific can be said about — never a raw exception message. */
export const GENERIC_ERROR_COPY = "Something went wrong. Try again.";

/**
 * A passed-through message stays short enough for every schema field that has ever bounded one —
 * `ExternalEditSchema.refusal`, `BuildJournalEntry.detail` and its neighbours all cap at 300 or
 * more. An unbounded one reaching a stricter field fails that field's own schema on broadcast
 * rather than reaching the screen at all, which is worse than a message trimmed mid-sentence.
 */
const MAX_LENGTH = 300;

/**
 * A filesystem path — Windows drive-letter, UNC (`\\server\share\...` and its extended form
 * `\\?\UNC\server\share\...`, both supported per `world/paths.ts`), or POSIX-rooted — inside a
 * message. Node's own fs errors (`readFile`, `open`, ...) interpolate the full path by default,
 * quoted, with no space before it; an fs failure whose code isn't one of `SYSTEM_ERROR_COPY`'s
 * known set (`EIO`, `EMFILE`, ...) would otherwise fall through to the "trust it, it's already
 * plain" branch below and hand a local disk layout — this machine's username, a network share's
 * name, a host-picked file outside any world (`fileArtifact` reads those too, not only world
 * storage) — to whoever reads the screen. The POSIX branch is anchored on what actually precedes
 * a real path in an fs error — the quote, paren or space Node itself puts there, or the start of
 * the message — rather than counting segments, so a shallow `/tmp/recording.wav` is caught the
 * same as a deep one; a mid-word slash like "either/or" has a letter immediately before it, which
 * the anchor excludes.
 */
const HAS_PATH = /[A-Za-z]:[\\/]|\\\\[^\s'"()]+|(?:^|['"( ])\/[^\s'"()]+/;

/**
 * The outermost system-error code in the cause chain, or null when the chain names none.
 *
 * Undici throws a bare `TypeError: fetch failed` and hangs the actual code (`ECONNREFUSED`,
 * `ETIMEDOUT`, `ECONNRESET`) off `.cause` — `queue/classify.ts`'s `transportClass` reads the same
 * shape for the same reason. `seen` stops a self-referencing cause; a host with both A and AAAA
 * records fails as an `AggregateError` whose members carry the codes and whose outer error
 * carries none, so `.errors` is walked too.
 */
function codeInChain(err: unknown): string | null {
  const seen = new Set<unknown>();
  const pending: unknown[] = [err];
  while (pending.length > 0) {
    const node = pending.shift();
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);
    const code = (node as { code?: unknown }).code;
    if (typeof code === "string" && SYSTEM_ERROR_COPY.has(code)) return code;
    const members = (node as { errors?: unknown }).errors;
    if (Array.isArray(members)) pending.push(...members);
    pending.push((node as { cause?: unknown }).cause);
  }
  return null;
}

/**
 * The shared fallback: a system-error code anywhere in the cause chain gets its own sentence; a
 * plain `Error` (the overwhelming case in this codebase — `throw new Error("a sentence a reader
 * could stand in front of")`) is trusted as already being that sentence and passed through,
 * bounded; every native diagnostic subclass the engine itself throws — `SyntaxError` (a bad JSON
 * parse), `TypeError`/`RangeError` (an unexpected shape or value), `ReferenceError` ("x is not
 * defined"), `URIError` ("URI malformed"), `EvalError`, and an `AggregateError` that reached here
 * still carrying no mapped code (`AggregateError`'s own `.message`, "All promises were rejected",
 * says nothing any of them didn't already say better) — report positions and internals nobody
 * authored for a screen, so all of them fall back to the generic line rather than being shown.
 *
 * App-specific error classes with their own developer-facing `.message` (a stale commit, a
 * malformed plan) are not handled here — they are known only where they are thrown, so the
 * package that defines them wraps this function with its own cases first.
 */
const NATIVE_DIAGNOSTIC_TYPES = [SyntaxError, TypeError, RangeError, ReferenceError, URIError, EvalError, AggregateError];

export function describeError(err: unknown): string {
  const code = codeInChain(err);
  if (code !== null) return SYSTEM_ERROR_COPY.get(code)!;
  if (NATIVE_DIAGNOSTIC_TYPES.some((type) => err instanceof type)) {
    return GENERIC_ERROR_COPY;
  }
  if (err instanceof Error && err.message.length > 0) {
    return HAS_PATH.test(err.message) ? GENERIC_ERROR_COPY : err.message.slice(0, MAX_LENGTH);
  }
  return GENERIC_ERROR_COPY;
}
