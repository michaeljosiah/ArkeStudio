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
  /** Null when the lock is a claim still being written, which names nobody yet. */
  constructor(readonly pid: number | null) {
    super(
      pid === null
        ? "world is being opened by another Arke Studio process"
        : `world is open in another Arke Studio process (pid ${pid})`,
    );
  }
}

/**
 * `world.lock` no longer names this process: it was reclaimed as stale — a cold heartbeat, or a
 * pid that looked dead — while this process still believed it held the world.
 *
 * Raised before new writes and at release. The successor's lock is left where it is.
 */
export class WorldLockDeposedError extends Error {
  constructor(readonly pid: number | null) {
    super(`world ownership lost${pid === null ? " (lock missing or unreadable)" : ` (lock now names pid ${pid})`}: writes refused; close and reopen the world`);
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
  private failure: Error | null = null;
  private heartbeatFailures = 0;
  private refreshing = false;

  onLost: ((error: Error) => void) | undefined;
  onHeartbeatError: ((error: unknown, consecutive: number) => void) | undefined;

  constructor(worldDir: string, private readonly options: WorldLockOptions = {}) {
    this.path = join(worldDir, LOCK_FILE);
  }

  /** Whether this process currently believes it owns the world. */
  get held(): boolean {
    return this.record !== null && this.failure === null;
  }

  /** A disk check, not an atomic fence: takeover can still race the subsequent write. */
  async assertOwned(): Promise<void> {
    if (this.failure) throw this.failure;
    const current = await this.read();
    if (this.record === null || current === null || !sameRecord(current, this.record)) {
      throw this.lose(new WorldLockDeposedError(current?.pid ?? null));
    }
    if (this.failure) throw this.failure;
  }

  private lose(error: Error): Error {
    if (!this.failure) {
      this.failure = error;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      try { this.onLost?.(error); } catch (callbackError) {
        console.warn("[world.lock] ownership-loss notification failed", callbackError);
      }
    }
    return this.failure;
  }

  /** Serialized heartbeats never refresh a successor's known claim. Fail closed after three
   * consecutive errors; recovery requires reopening, not a later successful timestamp write. */
  async refreshHeartbeat(): Promise<void> {
    if (this.refreshing || !this.held) return;
    this.refreshing = true;
    try {
      await this.assertOwned();
      if (!this.held) return;
      const now = new Date();
      await (this.options.touch ?? utimes)(toExtendedLength(this.path), now, now);
      this.heartbeatFailures = 0;
    } catch (error) {
      this.heartbeatFailures++;
      console.warn(`[world.lock] heartbeat failed (${this.heartbeatFailures}/3): ${error instanceof Error ? error.message : String(error)}`);
      try { this.onHeartbeatError?.(error, this.heartbeatFailures); } catch {
        /* Logging cannot prevent the ownership cutoff. */
      }
      if (this.heartbeatFailures >= 3) {
        this.lose(new Error("world is read-only: lock heartbeat failed three times; close and reopen the world"));
      }
    } finally {
      this.refreshing = false;
    }
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
        this.failure = null;
        this.heartbeatFailures = 0;
        this.heartbeat = setInterval(() => {
          void this.refreshHeartbeat();
        }, HEARTBEAT_MS);
        this.heartbeat.unref?.();
        return;
      }

      // Somebody already claimed it. Only a crash justifies taking it from them — a live pid
      // with a fresh heartbeat is a real owner, including our own process, where it means
      // another open store instance.
      const existing = await this.read();
      const fresh = await this.heartbeatFresh();
      if (existing === null) {
        /*
         * A lock that names nobody. Creating the file and writing the record into it are two
         * operations, and in the moment between them a live claim looks exactly like this — so
         * a fresh one is somebody mid-acquire, not debris. Reclaiming it on sight let this
         * process unlink a claim its winner was still writing (the winner's write then lands on
         * an unlinked handle and reports success), and both came away holding the world, which
         * is the defect the exclusive create is here to close.
         *
         * Only an unparseable lock that has *also* gone cold is debris — a crash between the
         * two operations, cleared once the heartbeat window has passed like any other.
         */
        if (fresh) throw new WorldLockedError(null);
      } else if (pidAlive(existing.pid) && fresh) {
        throw new WorldLockedError(existing.pid);
      }
      await this.clearStale(existing);
    }
    // Every pass was beaten to the reclaim. Name whoever holds it now rather than looping.
    throw new WorldLockedError((await this.read())?.pid ?? null);
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
      const record: unknown = JSON.parse(await readFile(toExtendedLength(this.path), "utf8"));
      if (record === null || typeof record !== "object") return null;
      const value = record as Partial<LockRecord>;
      return typeof value.pid === "number" && typeof value.startedAt === "string"
        ? value as LockRecord : null;
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
   * (WorldLockDeposedError) — a stale in-memory claim is not permission to remove the file.
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

export interface WorldLockOptions {
  /** I/O seam for deterministic heartbeat-failure tests. */
  touch?: typeof utimes;
}
