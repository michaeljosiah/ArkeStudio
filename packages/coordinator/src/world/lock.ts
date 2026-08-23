import { open, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { withTransientRetry } from "./atomic.js";
import { toExtendedLength } from "./paths.js";

/**
 * Single-process ownership (SPEC-002 R-3). The lock records pid and start time — never a
 * machine identifier (R-24). Stale locks are reclaimed: a dead pid, or a heartbeat that
 * stopped, means a crash, and the alternative is a user locked out of their own work.
 *
 * Ownership is decided by an exclusive create and by nothing else. Reading the file and then
 * writing it is not a lock: two processes opening the same free world both read nothing, both
 * write, and both come away believing they own it. Releasing is the same claim from the other
 * side — the file has to still name us, because a process the reclaim above deposed still
 * thinks it holds the world, and deleting whatever `world.lock` happens to contain would
 * unlock the world underneath its new owner.
 */

const LOCK_FILE = "world.lock";
const HEARTBEAT_MS = 20_000;
const STALE_AFTER_MS = 90_000;
/**
 * One pass per reclaim we lose. Each pass either wins the exclusive create or reads the record
 * of whoever did, so the only way to go round again is another process clearing the same stale
 * lock at the same moment — bounded because every pass that clears one makes progress.
 */
const ACQUIRE_ATTEMPTS = 4;

export class WorldLockedError extends Error {
  constructor(readonly pid: number) {
    super(`world is open in another Arke Studio process (pid ${pid})`);
  }
}

/**
 * `world.lock` no longer names this process: it was reclaimed as stale — a cold heartbeat, or a
 * pid that looked dead — while this process still believed it held the world.
 *
 * Raised rather than swallowed. Everything written since the reclaim went to a world somebody
 * else owns, which the person is entitled to hear about; and the successor's lock is left where
 * it is, because it is not ours to remove.
 */
export class WorldLockDeposedError extends Error {
  constructor(readonly pid: number) {
    super(`world.lock now names pid ${pid}: this process no longer owns the world and did not release it`);
  }
}

interface LockRecord {
  pid: number;
  startedAt: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is not ours — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Identity of a claim: the pid alone is not enough, because pids are reused after a crash. */
function sameRecord(a: LockRecord | null, b: LockRecord | null): boolean {
  if (a === null || b === null) return a === b;
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

export class WorldLock {
  private readonly path: string;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** The record we wrote, and the identity release checks against. Null when we hold nothing. */
  private record: LockRecord | null = null;

  constructor(worldDir: string) {
    this.path = join(worldDir, LOCK_FILE);
  }

  /** Whether this process currently believes it owns the world. */
  get held(): boolean {
    return this.record !== null;
  }

  /**
   * Acquire or throw WorldLockedError. Ownership is settled by an exclusive create, so a race
   * between two openers has exactly one winner: the loser gets EEXIST, reads the winner's
   * record, and is told who holds the world.
   *
   * Stale locks are still reclaimed (a dead pid or a cold heartbeat is a crash, and a crash must
   * not lock a user out of their own work), but reclaiming only clears the dead record — the
   * create that follows decides ownership the same way it would for a free world.
   */
  async acquire(): Promise<void> {
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
      const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };
      if (await this.createExclusive(record)) {
        this.record = record;
        this.heartbeat = setInterval(() => {
          void utimes(toExtendedLength(this.path), new Date(), new Date()).catch(() => {});
        }, HEARTBEAT_MS);
        this.heartbeat.unref?.();
        return;
      }

      // Somebody already claimed it. Only a crash justifies taking it from them — a live pid
      // with a fresh heartbeat is a real owner, including our own process, where it means
      // another open store instance.
      const existing = await this.read();
      if (existing && pidAlive(existing.pid) && (await this.heartbeatFresh())) {
        throw new WorldLockedError(existing.pid);
      }
      await this.clearStale(existing);
    }
    // Every pass was beaten to the reclaim. Name whoever holds it now rather than looping.
    const existing = await this.read();
    throw new WorldLockedError(existing?.pid ?? 0);
  }

  /**
   * `wx` — create or fail. The one operation that decides who owns the world; false means the
   * file was already there, which is somebody else's claim until it proves stale.
   */
  private async createExclusive(record: LockRecord): Promise<boolean> {
    let handle;
    try {
      handle = await open(toExtendedLength(this.path), "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      await handle.writeFile(JSON.stringify(record), { encoding: "utf8" });
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {}); // the write is the failure worth reporting
      // We did not manage to claim the world, so we must not leave a file behind that says we
      // did. The next opener would reclaim the empty record as stale anyway, but only after
      // reading it, and only once — leaving it turns one failed write into somebody's puzzle.
      await rm(toExtendedLength(this.path), { force: true }).catch(() => {});
      throw err;
    }
    await handle.close();
    return true;
  }

  private async read(): Promise<LockRecord | null> {
    try {
      return JSON.parse(await readFile(toExtendedLength(this.path), "utf8")) as LockRecord;
    } catch {
      return null;
    }
  }

  private async heartbeatFresh(): Promise<boolean> {
    try {
      const info = await stat(toExtendedLength(this.path));
      return Date.now() - info.mtimeMs < STALE_AFTER_MS;
    } catch {
      return false;
    }
  }

  /**
   * Clear a lock judged stale — but only while it still says what it said when we judged it.
   * Another process may have reclaimed it in between, and removing it then would delete a live
   * owner's lock. Re-reading first does not close that window (there is no compare-and-delete),
   * but it narrows it to a single syscall, and the exclusive create that follows settles
   * ownership regardless of which of us clears the file.
   */
  private async clearStale(judged: LockRecord | null): Promise<void> {
    if (!sameRecord(await this.read(), judged)) return; // reclaimed under us; go round again
    await rm(toExtendedLength(this.path), { force: true }).catch(() => {});
  }

  /**
   * Release our own lock and no other. The in-memory flag is not evidence of ownership: a
   * process deposed by the stale reclaim still believes it holds the world, and removing
   * whatever `world.lock` contains would leave the successor writing to an unlocked world.
   *
   * A record naming somebody else is therefore not removed, and not passed over quietly either
   * (WorldLockDeposedError) — being deposed means this process has been writing to a world it
   * did not own.
   */
  async release(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const mine = this.record;
    if (mine === null) return;
    this.record = null;

    const current = await this.read();
    // Gone already, or too damaged to name anybody: nothing of ours to remove. An unreadable
    // lock is reclaimed as stale by the next opener, so leaving it costs nothing, and it may be
    // a successor's half-written claim, which removing would cost plenty.
    if (current === null) return;
    if (!sameRecord(current, mine)) throw new WorldLockDeposedError(current.pid);
    // Defender and the search indexer hold transient handles on files in a user profile, and an
    // unlink onto a held file fails EPERM/EBUSY for a moment (D7). A lock left behind by a lost
    // race with a virus scanner locks the user out until the heartbeat goes cold.
    await withTransientRetry(() => rm(toExtendedLength(this.path), { force: true }));
  }
}
