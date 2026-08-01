import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/**
 * Scratch directories, swept when the test file that made them finishes.
 *
 * Every `mkdtemp` in the suite goes through here. Left to themselves the copies pile up —
 * one fixture world per test, thousands of them — until the disk runs out and unrelated
 * tests start failing with ENOSPC.
 */
const dirs: string[] = [];

/** Handles to let go of first: SQLite holds the index open, and Windows will not delete an open file. */
const closers: Array<() => unknown> = [];

/** A temp directory that goes away when this test file is done with it. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Register something that holds files open — a store, an index — to be closed before the sweep.
 * Tests that close their own handles need not bother; this is for the ones that deliberately
 * leave one open, and for closes that a failing assertion would skip.
 */
export function closeOnCleanup(closer: () => unknown): void {
  closers.push(closer);
}

async function sweep(): Promise<void> {
  for (const close of closers.splice(0).reverse()) {
    try {
      await close();
    } catch {
      /* a handle that will not close must not strand the directories behind it */
    }
  }
  for (const dir of dirs.splice(0)) {
    // force + retries: an antivirus scan or a lingering SQLite handle answers EBUSY for a moment.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
      (err: NodeJS.ErrnoException) => {
        console.warn(`temp sweep left ${dir} behind: ${err.code ?? err.message}`);
      },
    );
  }
}

after(sweep);

// A crash or a bail-out never reaches the hook above; take one synchronous pass on the way out.
process.on("exit", () => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the process is leaving; `npm run clean:temp` collects whatever is left */
    }
  }
});
