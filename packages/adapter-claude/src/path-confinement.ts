import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Is the path a tool was pointed at inside the session's working directory?
 *
 * `cwd` is where the harness process starts; it is not a boundary the filesystem enforces. An
 * absolute path in a tool argument reaches wherever it says, and the intent table above this one
 * only reads tool NAMES — so `Read` was permitted to both roles and its argument was never
 * looked at. Measured against 2.1.235: World Chat, the read-only role, read a sentinel out of
 * `%LOCALAPPDATA%\Temp` while confined to a proposal directory, and the gate said allow.
 *
 * The realistic trigger is not a person asking. It is untrusted content already inside a world —
 * an imported document, a canon entry — steering a turn into reading a credential file and
 * surfacing it into the conversation.
 *
 * Three details decide whether this actually holds, and each is a way the obvious version fails:
 *
 * - Symlinks are resolved BEFORE comparing. A link inside the directory pointing out of it is a
 *   path that passes a string test and reads somebody else's file.
 * - The comparison requires a separator boundary, so a sibling directory whose name merely
 *   starts with the working directory's — `cv_1-evil` against `cv_1` — is outside, not inside.
 * - Case is folded on Windows only. The same file is reachable as `C:\Users\…` and `c:\users\…`
 *   there and those are two different files on Linux, so folding everywhere would open on one
 *   platform exactly what it closes on the other.
 *
 * KNOWN, and safe in the direction it fails: Node's `realpath` does NOT expand Windows 8.3 short
 * names — measured, `AR1317~1` comes back as `AR1317~1`. So a short-form path to a file that IS
 * inside the directory is refused rather than admitted. That is a false refusal, not a hole: a
 * short name cannot make an outside path resolve to an inside one, and nothing generates these
 * on its own. Left alone rather than papered over with a `stat`-based identity comparison, which
 * would only work for files that already exist and would say nothing about `Write`.
 */

/** Case matters on Linux and does not on Windows; the comparison has to follow the platform. */
const CASE_INSENSITIVE = process.platform === "win32";

function comparable(path: string): string {
  return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

/**
 * The real path of `target`, resolving symlinks as far as the filesystem can.
 *
 * `realpath` throws on a path that does not exist, and a path that does not exist yet is the
 * normal case for `Write` — it is being created. So walk up to the nearest ancestor that DOES
 * exist, resolve that, and re-attach the segments below it. That still resolves a symlinked
 * parent, which is the case that matters: the leaf being absent is not evidence about where the
 * directory holding it actually lives.
 */
async function realpathOfNearestExisting(target: string): Promise<string> {
  let current = target;
  const below: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return below.length === 0 ? real : join(real, ...below.reverse());
    } catch {
      const parent = dirname(current);
      // The root, and it does not resolve. Nothing further to try; the caller compares as-is
      // and a path we could not resolve fails the containment test rather than passing it.
      if (parent === current) return target;
      below.push(basename(current));
      current = parent;
    }
  }
}

/** The working directory with symlinks resolved — computed once per session, not per call. */
export async function resolveRoot(cwd: string): Promise<string> {
  return realpathOfNearestExisting(resolve(cwd));
}

/**
 * Whether `target` — already resolved — is the root or sits underneath it.
 *
 * The root itself counts as inside: `Glob` with `path` set to the working directory is the
 * ordinary case, not an escape.
 */
export function isWithin(root: string, target: string): boolean {
  const r = comparable(root);
  const t = comparable(target);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Resolve one tool argument against the session root, and say whether it stayed inside.
 *
 * A relative argument resolves against the working directory, which is what a relative path in a
 * tool call means. An absolute one is taken at its word and then tested — that is the whole point.
 */
export async function confinePath(
  root: string,
  raw: string,
): Promise<{ inside: true; resolved: string } | { inside: false; resolved: string }> {
  /*
   * The root is resolved here too, not just at session creation.
   *
   * Resolving one side and not the other compares two different spellings of the same place,
   * and it fails by REFUSING work that was inside all along — silently, and only on machines
   * whose paths happen to need resolving. Caught by CI: GitHub's Windows runner puts an 8.3
   * short name (`RUNNER~1`) in its temp path, and every in-directory case failed there while
   * passing on a developer machine whose paths have no short names in them.
   *
   * {@link resolveRoot} at session creation stays, because the canonical root is what the trace
   * should show. This makes a caller that forgets it wrong about nothing.
   */
  const base = await realpathOfNearestExisting(resolve(root));
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  const resolved = await realpathOfNearestExisting(absolute);
  return isWithin(base, resolved) ? { inside: true, resolved } : { inside: false, resolved };
}
