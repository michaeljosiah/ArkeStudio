import { readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic.js";
import { toExtendedLength } from "./paths.js";

/**
 * Single-process ownership (SPEC-002 R-3). The lock records pid and start time — never a
 * machine identifier (R-24). Stale locks are reclaimed: a dead pid, or a heartbeat that
 * stopped, means a crash, and the alternative is a user locked out of their own work.
 */

const LOCK_FILE = "world.lock";
const HEARTBEAT_MS = 20_000;
const STALE_AFTER_MS = 90_000;

export class WorldLockedError extends Error {
  constructor(readonly pid: number) {
    super(`world is open in another Arke Studio process (pid ${pid})`);
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

export class WorldLock {
  private readonly path: string;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private held = false;

  constructor(worldDir: string) {
    this.path = join(worldDir, LOCK_FILE);
  }

  /** Acquire or throw WorldLockedError. Reclaims stale locks (dead pid or cold heartbeat). */
  async acquire(): Promise<void> {
    const existing = await this.read();
    if (existing) {
      const fresh = await this.heartbeatFresh();
      // A live pid with a fresh heartbeat is a real owner — including our own process, where
      // it means another open store instance. Dead pid or cold heartbeat (pid reuse after a
      // crash) → stale, reclaim.
      if (pidAlive(existing.pid) && fresh) {
        throw new WorldLockedError(existing.pid);
      }
    }
    await this.write();
    this.held = true;
    this.heartbeat = setInterval(() => {
      void utimes(toExtendedLength(this.path), new Date(), new Date()).catch(() => {});
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
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

  private async write(): Promise<void> {
    const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };
    await atomicWriteFile(this.path, JSON.stringify(record));
  }

  async release(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.held) {
      this.held = false;
      await rm(toExtendedLength(this.path), { force: true }).catch(() => {});
    }
  }
}
