import { open, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ulid } from "@arke-studio/contracts";
import { toExtendedLength } from "./paths.js";

/**
 * Atomic, crash-safe writes (SPEC-002 R-13, R-14).
 *
 * Every write stages to a temporary file in the same directory and renames into place —
 * renames are atomic on NTFS, so a kill leaves the target wholly old or wholly new. The
 * rename retries with backoff because Defender and the search indexer hold transient handles
 * on files in a user profile, and a rename onto a held target fails EPERM/EBUSY (D7).
 */

const RETRY_DELAYS_MS = [0, 50, 100, 200, 400, 800];
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface AtomicDeps {
  /** Injectable for the retry unit tests; defaults to fs.rename with prefixing. */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * Run a filesystem operation through the same backoff (D7): Defender and the search indexer
 * hold transient handles on files in a user profile, and any operation that needs exclusive
 * access to one — renaming onto it, unlinking it — can fail EPERM/EBUSY for a moment and
 * succeed immediately after. Anything else throws on the first attempt.
 */
export async function withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code)) throw err;
    }
  }
  throw lastError;
}

export async function renameWithRetry(
  from: string,
  to: string,
  deps: AtomicDeps = {},
): Promise<void> {
  const doRename = deps.rename ?? ((f: string, t: string) => rename(toExtendedLength(f), toExtendedLength(t)));
  await withTransientRetry(() => doRename(from, to));
}

/**
 * Write `content` to `path` atomically: temp file in the same directory, flushed to disk,
 * renamed into place with retry. UTF-8, no BOM; callers are responsible for LF content.
 */
export async function atomicWriteFile(path: string, content: string | Uint8Array, deps: AtomicDeps = {}): Promise<void> {
  const dir = dirname(path);
  await mkdir(toExtendedLength(dir), { recursive: true });
  const tmp = join(dir, `.tmp-${ulid()}`);
  const handle = await open(toExtendedLength(tmp), "w");
  try {
    await handle.writeFile(content, typeof content === "string" ? { encoding: "utf8" } : {});
    await handle.sync(); // flushed before the rename — the journal protocol depends on ordering
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, path, deps);
  } catch (err) {
    await rm(toExtendedLength(tmp), { force: true }).catch(() => {});
    throw err;
  }
}
