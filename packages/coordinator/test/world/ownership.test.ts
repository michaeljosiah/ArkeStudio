import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CrashSignal, Committer, type CommitInput } from "../../src/world/commit.js";
import { WorldLock, WorldLockDeposedError, WorldLockedError } from "../../src/world/lock.js";
import { WorldStore } from "../../src/world/store.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "./helpers.js";

/**
 * Ownership regressions (SPEC-002 R-3, R-15).
 *
 * The world lock used to be unreliable in both directions — it could be held by two processes at
 * once, and released by one that no longer held it — and recovery, which renames live files, ran
 * before it was taken at all. Each test here fails on the code that shipped before ADR-002.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";
const LOCK_FILE = "world.lock";
/** Comfortably past the lock's 90s staleness window, so a heartbeat reads as stopped. */
const COLD_MS = 5 * 60_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Leave a real interrupted commit on disk: journal in `planning`, snapshots and staging written,
 * nothing live touched. This is the state a kill mid-commit leaves, and the state recovery is
 * entitled to resolve — once it owns the world.
 */
async function crashMidCommit(dir: string): Promise<{ commitId: string; sheet: string }> {
  const sheetPath = "characters/maren-kest.md";
  const live = await readFile(join(dir, sheetPath), "utf8");
  const doc = MarkdownFile.parse(live);
  doc.setBody(doc.body.replace("Salt-crusted braids", "Salt-white braids"));
  const input: CommitInput = {
    kind: "sheet-edit",
    source: "ownership-test",
    files: [{ path: sheetPath, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
  };
  await assert.rejects(
    () =>
      new Committer(dir, CLOCK).commit(input, {
        at: (where) => {
          if (where === "staged-written") throw new CrashSignal("killed mid-commit");
        },
      }),
    CrashSignal,
  );
  const journals = (await readdir(join(dir, ".commit"))).filter((e) => e.endsWith(".json"));
  assert.equal(journals.length, 1, "the crash left exactly one journal to recover");
  return { commitId: journals[0]!.slice(0, -".json".length), sheet: live };
}

async function journalPhase(dir: string, commitId: string): Promise<string | null> {
  const raw = await readFile(join(dir, ".commit", `${commitId}.json`), "utf8").catch(() => null);
  return raw === null ? null : (JSON.parse(raw) as { phase: string }).phase;
}

/** Backdate the lock's mtime so the reclaim reads the owner's heartbeat as stopped. */
async function goCold(dir: string): Promise<void> {
  const when = new Date(Date.now() - COLD_MS);
  await utimes(join(dir, LOCK_FILE), when, when);
}

describe("world ownership: recovery runs under the lock (R-3, R-15)", () => {
  it("leaves staged work for the successor when ownership is lost before committing", async () => {
    const dir = await makeTempWorld();
    const before = await readFile(join(dir, "world.json"), "utf8");
    let checks = 0;
    const committer = new Committer(dir, CLOCK, async () => {
      if (++checks > 1) throw new WorldLockDeposedError(process.pid);
    });
    await assert.rejects(committer.commit({
      kind: "world-rename", source: "ownership-test", files: [], worldFields: { name: "Must not land" },
    }), WorldLockDeposedError);
    assert.equal(await readFile(join(dir, "world.json"), "utf8"), before);
    assert.equal((await committer.pendingRecovery()).length, 1);
    const successor = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => successor.close());
    assert.equal((await committer.pendingRecovery()).length, 0);
    assert.equal(await readFile(join(dir, "world.json"), "utf8"), before);
  });

  it("does not touch another owner's journal when the world is already locked", async () => {
    const dir = await makeTempWorld();
    const { commitId, sheet } = await crashMidCommit(dir);

    // Stand in for the owning process: the lock is held, and its journal is mid-flight.
    const owner = new WorldLock(dir);
    await owner.acquire();
    closeOnCleanup(() => owner.release().catch(() => {}));

    await assert.rejects(() => WorldStore.open(dir, { clock: CLOCK }), WorldLockedError);

    assert.equal(
      await journalPhase(dir, commitId),
      "planning",
      "the refused opener left the owner's journal exactly as it found it",
    );
    assert.ok(
      await stat(join(dir, ".commit", "staging", commitId)).then(
        () => true,
        () => false,
      ),
      "and left the staged files with it",
    );
    assert.equal(await readFile(join(dir, "characters/maren-kest.md"), "utf8"), sheet, "and renamed nothing live");

    // Recovery is not skipped, only deferred: the owner's successor still resolves it.
    await owner.release();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => store.close().catch(() => {}));
    assert.equal(await journalPhase(dir, commitId), null, "the journal is resolved by the process that owns the world");
    await store.close();
  });

  it("recovers on a normal open, as it always did", async () => {
    const dir = await makeTempWorld();
    const { commitId, sheet } = await crashMidCommit(dir);

    const store = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => store.close().catch(() => {}));
    assert.equal(await journalPhase(dir, commitId), null, "the planning journal was rolled back");
    assert.equal(await readFile(join(dir, "characters/maren-kest.md"), "utf8"), sheet, "wholly old, byte for byte");
    assert.deepEqual(store.getBundle().problems, [], "a resolved world reports nothing");
    await store.close();
  });
});

describe("world ownership: a read-only open resolves nothing (R-15)", () => {
  it("reports the unresolved commit instead of rolling it back", async () => {
    const dir = await makeTempWorld();
    const { commitId, sheet } = await crashMidCommit(dir);

    const store = await WorldStore.open(dir, { readOnly: true, clock: CLOCK });
    closeOnCleanup(() => store.close().catch(() => {}));

    assert.equal(await journalPhase(dir, commitId), "planning", "a read-only open renames nothing");
    assert.equal(await readFile(join(dir, "characters/maren-kest.md"), "utf8"), sheet, "the world is untouched");
    assert.equal(
      await stat(join(dir, LOCK_FILE)).then(
        () => true,
        () => false,
      ),
      false,
      "and takes no lock, so it has no claim to recover under",
    );

    const reported = store.getBundle().problems.filter((p) => p.path === `.commit/${commitId}.json`);
    assert.equal(reported.length, 1, "the unresolved commit is named, not silently left");
    assert.match(reported[0]!.message, /unresolved/);
    await store.close();

    // The next writing open is what resolves it.
    const writable = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => writable.close().catch(() => {}));
    assert.equal(await journalPhase(dir, commitId), null);
    await writable.close();
  });

  it("opens a clean world read-only with no problems and no lock", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { readOnly: true, clock: CLOCK });
    closeOnCleanup(() => store.close().catch(() => {}));
    assert.deepEqual(store.getBundle().problems, []);
    assert.equal(
      await stat(join(dir, LOCK_FILE)).then(
        () => true,
        () => false,
      ),
      false,
    );
    await store.close();
  });
});

describe("world ownership: acquire is exclusive (R-3)", () => {
  it("gives a free world to exactly one of two concurrent openers", async () => {
    const dir = await makeTempWorld();
    const a = new WorldLock(dir);
    const b = new WorldLock(dir);
    closeOnCleanup(() => Promise.all([a.release().catch(() => {}), b.release().catch(() => {})]));

    // Read-then-write let both of these read nothing, both write, and both come away held.
    const settled = await Promise.allSettled([a.acquire(), b.acquire()]);

    const won = settled.filter((r) => r.status === "fulfilled");
    const lost = settled.filter((r) => r.status === "rejected");
    assert.equal(won.length, 1, "exactly one opener owns the world");
    assert.equal(lost.length, 1);
    assert.ok(
      lost[0]!.status === "rejected" && lost[0]!.reason instanceof WorldLockedError,
      "the loser is told the world is taken, not handed a second copy of it",
    );
    assert.equal([a.held, b.held].filter(Boolean).length, 1, "and only one of them believes it");

    const record = JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8")) as { pid: number };
    assert.equal(record.pid, process.pid);

    await (a.held ? a : b).release();
  });

  it("gives a free world to exactly one of eight concurrent openers", async () => {
    const dir = await makeTempWorld();
    const locks = Array.from({ length: 8 }, () => new WorldLock(dir));
    closeOnCleanup(() => Promise.all(locks.map((l) => l.release().catch(() => {}))));

    const settled = await Promise.allSettled(locks.map((l) => l.acquire()));
    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1, "one winner, however many racers");
    for (const result of settled) {
      if (result.status === "rejected") assert.ok(result.reason instanceof WorldLockedError, "no other failure mode");
    }
    assert.equal(locks.filter((l) => l.held).length, 1);

    await Promise.all(locks.filter((l) => l.held).map((l) => l.release()));
  });

  it("still reclaims a lock naming a dead pid", async () => {
    const dir = await makeTempWorld();
    await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: 999999901, startedAt: CLOCK() }), "utf8");

    const lock = new WorldLock(dir);
    closeOnCleanup(() => lock.release().catch(() => {}));
    await lock.acquire();

    const record = JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8")) as { pid: number };
    assert.equal(record.pid, process.pid, "a crash does not lock a user out of their own work");
    await lock.release();
  });

  it("still reclaims a lock whose heartbeat stopped", async () => {
    const dir = await makeTempWorld();
    const stalled = new WorldLock(dir);
    await stalled.acquire();
    closeOnCleanup(() => stalled.release().catch(() => {}));
    await goCold(dir);

    const reclaimer = new WorldLock(dir);
    closeOnCleanup(() => reclaimer.release().catch(() => {}));
    await reclaimer.acquire();
    assert.equal(reclaimer.held, true, "a cold heartbeat is a crash, and a crash is reclaimable");
    await reclaimer.release();
  });

  it("refuses a lock naming a live process with a fresh heartbeat", async () => {
    const dir = await makeTempWorld();
    const owner = new WorldLock(dir);
    await owner.acquire();
    closeOnCleanup(() => owner.release().catch(() => {}));

    await assert.rejects(() => new WorldLock(dir).acquire(), WorldLockedError);
    await owner.release();
  });

  it("waits out a lock that names nobody yet rather than unlinking a claim mid-write", async () => {
    const dir = await makeTempWorld();
    // Exactly what the winner of the exclusive create leaves behind between creating the file
    // and writing its record into it. Treating that as debris let the loser unlink it and take
    // the world while the winner's write completed against an unlinked handle — two holders.
    await writeFile(join(dir, LOCK_FILE), "", "utf8");

    const lock = new WorldLock(dir);
    closeOnCleanup(() => lock.release().catch(() => {}));
    await assert.rejects(() => lock.acquire(), WorldLockedError);
    assert.equal(lock.held, false);
    assert.equal(await readFile(join(dir, LOCK_FILE), "utf8"), "", "the claim being written is left alone");
  });

  it("reclaims a lock too damaged to name anybody once it has also gone cold", async () => {
    const dir = await makeTempWorld();
    await writeFile(join(dir, LOCK_FILE), "{ this is not json", "utf8");
    await goCold(dir); // a crash between the create and the record, not a claim in flight

    const lock = new WorldLock(dir);
    closeOnCleanup(() => lock.release().catch(() => {}));
    await lock.acquire();
    const record = JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8")) as { pid: number };
    assert.equal(record.pid, process.pid);
    await lock.release();
  });
});

describe("world ownership: release removes only our own lock (R-3)", () => {
  it("refuses a deposed store's writes before touching live files, history or journals", async () => {
    const dir = await makeTempWorld();
    const owner = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => owner.close().catch(() => {}));
    await goCold(dir);
    await delay(5);
    const successor = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => successor.close().catch(() => {}));
    const paths = ["world.json", "characters/maren-kest.md", "changes.jsonl", "world.lock", ".index/scan-state.json"];
    const before = await Promise.all(paths.map((path) => readFile(join(dir, path), "utf8").catch(() => null)));
    const entries = await readdir(dir, { recursive: true });
    await assert.rejects(owner.renameWorld("Deposed write", "ownership-test"), /ownership lost.*writes refused/);
    await assert.rejects(owner.ownedWrite(async () => { throw new Error("callback must not run"); }), /ownership lost/);
    await assert.rejects(owner.gateOp(async () => { throw new Error("callback must not run"); }), /ownership lost/);
    await assert.rejects(owner.close(), WorldLockDeposedError);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(join(dir, path), "utf8").catch(() => null))), before);
    assert.deepEqual(await readdir(dir, { recursive: true }), entries);
    await successor.renameWorld("Successor write", "ownership-test");
  });

  it("logs heartbeat errors and disables store writes after three consecutive failures", async (t) => {
    const dir = await makeTempWorld();
    const locks: WorldLock[] = [];
    const acquire = WorldLock.prototype.acquire;
    t.mock.method(WorldLock.prototype, "acquire", async function (this: WorldLock) {
      locks.push(this);
      await acquire.call(this);
    });
    const warnings = t.mock.method(console, "warn", () => {});
    const losses: Error[] = [];
    const store = await WorldStore.open(dir, {
      events: { onOwnershipLost: (error) => { losses.push(error); } },
      lockOptions: { touch: async () => { throw new Error("simulated EACCES"); } },
    });
    closeOnCleanup(() => store.close().catch(() => {}));
    // Keep the readable ownership record, but make timestamp updates fail deterministically.
    const lock = locks[0]!;
    await lock.refreshHeartbeat();
    await lock.refreshHeartbeat();
    assert.equal(losses.length, 0);
    await store.renameWorld("Still owned", "ownership-test");
    await lock.refreshHeartbeat();
    assert.match(losses[0]?.message ?? "", /heartbeat failed three times/);
    assert.equal(warnings.mock.callCount(), 3);
    await assert.rejects(store.renameWorld("Must refuse", "ownership-test"), /read-only.*heartbeat/);
    assert.equal(lock.held, false);
  });

  it("does not refresh a successor's heartbeat", async () => {
    const dir = await makeTempWorld();
    const old = new WorldLock(dir);
    await old.acquire();
    closeOnCleanup(() => old.release().catch(() => {}));
    await goCold(dir);
    await delay(5);
    const next = new WorldLock(dir);
    await next.acquire();
    closeOnCleanup(() => next.release());
    await goCold(dir);
    const before = (await stat(join(dir, LOCK_FILE))).mtimeMs;
    await old.refreshHeartbeat();
    assert.equal((await stat(join(dir, LOCK_FILE))).mtimeMs, before);
    await assert.rejects(old.assertOwned(), WorldLockDeposedError);
  });

  it("resets consecutive heartbeat failures after a successful update", async (t) => {
    const dir = await makeTempWorld();
    let failing = true;
    const lock = new WorldLock(dir, { touch: async (...args) => {
      if (failing) throw new Error("temporary failure");
      await utimes(...args);
    } });
    await lock.acquire();
    closeOnCleanup(() => lock.release());
    t.mock.method(console, "warn", () => {});
    const failures: number[] = [];
    lock.onHeartbeatError = (_error, consecutive) => { failures.push(consecutive); };
    await lock.refreshHeartbeat();
    await lock.refreshHeartbeat();
    failing = false;
    await lock.refreshHeartbeat();
    failing = true;
    await lock.refreshHeartbeat();
    await lock.refreshHeartbeat();
    assert.equal(lock.held, true);
    assert.deepEqual(failures, [1, 2, 1, 2]);
    await lock.assertOwned();
  });

  for (const damaged of [false, true]) {
    it(`refuses writes with a ${damaged ? "damaged" : "missing"} ownership record`, async () => {
      const dir = await makeTempWorld();
      const store = await WorldStore.open(dir);
      closeOnCleanup(() => store.close().catch(() => {}));
      const before = await readFile(join(dir, "world.json"), "utf8");
      if (damaged) await writeFile(join(dir, LOCK_FILE), "null");
      else await rm(join(dir, LOCK_FILE));
      await assert.rejects(store.renameWorld("Refuse", "ownership-test"), /lock missing or unreadable/);
      assert.equal(await readFile(join(dir, "world.json"), "utf8"), before);
    });
  }

  it("leaves a successor's lock alone when the deposed process closes", async () => {
    const dir = await makeTempWorld();
    const deposed = new WorldLock(dir);
    await deposed.acquire();
    closeOnCleanup(() => deposed.release().catch(() => {}));
    const takenFrom = await readFile(join(dir, LOCK_FILE), "utf8");

    // The laptop sleeps, or a permissions change silences the heartbeat: the owner is still
    // running and still believes it holds the world, but the file has gone cold.
    await goCold(dir);
    await delay(5); // so the successor's startedAt cannot land in the same millisecond
    const successor = new WorldLock(dir);
    await successor.acquire();
    closeOnCleanup(() => successor.release().catch(() => {}));
    const successorRecord = await readFile(join(dir, LOCK_FILE), "utf8");
    assert.notEqual(successorRecord, takenFrom, "the reclaim wrote a claim of its own");

    // Releasing on the strength of an in-memory flag deleted this.
    await assert.rejects(() => deposed.release(), WorldLockDeposedError);
    assert.equal(
      await readFile(join(dir, LOCK_FILE), "utf8"),
      successorRecord,
      "the live owner's lock survives the deposed process closing",
    );
    assert.equal(deposed.held, false, "and the deposed process stops claiming the world");

    await successor.release();
    assert.equal(
      await stat(join(dir, LOCK_FILE)).then(
        () => true,
        () => false,
      ),
      false,
      "the real owner's own release still removes it",
    );
  });

  it("keeps the world locked when a deposed store closes", async () => {
    const dir = await makeTempWorld();
    const deposed = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => deposed.close().catch(() => {}));
    await goCold(dir);
    await delay(5);

    const successor = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => successor.close().catch(() => {}));
    const successorRecord = await readFile(join(dir, LOCK_FILE), "utf8");

    // Closing tears the store down either way — but it says so rather than unlocking a world
    // the successor is still writing to.
    await assert.rejects(() => deposed.close(), WorldLockDeposedError);
    assert.equal(await readFile(join(dir, LOCK_FILE), "utf8"), successorRecord);

    // The successor is still the owner, and a third opener is still refused.
    await assert.rejects(() => WorldStore.open(dir, { clock: CLOCK }), WorldLockedError);
    await successor.close();
  });

  it("releases the lock even when the scan state cannot be written", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => store.close().catch(() => {}));

    // Stand in for a full disk or a permissions change: the derived scan state has nowhere to
    // go. `.index/` is deletable by design, so this must not be what keeps a world locked —
    // the heartbeat would go on refreshing a lock nothing intends to hold.
    const scanState = join(dir, ".index", "scan-state.json");
    await rm(scanState, { force: true });
    await mkdir(scanState); // a directory where the file goes: the write cannot land

    await assert.rejects(() => store.close(), "the failure is reported, not swallowed");
    assert.equal(
      await stat(join(dir, LOCK_FILE)).then(
        () => true,
        () => false,
      ),
      false,
      "and the lock came off first, so the world is not stranded",
    );

    const reopened = new WorldLock(dir);
    closeOnCleanup(() => reopened.release().catch(() => {}));
    await reopened.acquire();
    await reopened.release();
  });

  it("releases cleanly, and a second release is a no-op", async () => {
    const dir = await makeTempWorld();
    const lock = new WorldLock(dir);
    await lock.acquire();
    closeOnCleanup(() => lock.release().catch(() => {}));

    await lock.release();
    assert.equal(lock.held, false);
    assert.equal(
      await stat(join(dir, LOCK_FILE)).then(
        () => true,
        () => false,
      ),
      false,
    );
    await lock.release(); // idempotent: nothing held, nothing removed, nothing thrown
  });

  it("does not remove a lock that was already taken over and released", async () => {
    const dir = await makeTempWorld();
    const deposed = new WorldLock(dir);
    await deposed.acquire();
    closeOnCleanup(() => deposed.release().catch(() => {}));
    await goCold(dir);
    await delay(5);

    const successor = new WorldLock(dir);
    await successor.acquire();
    await successor.release(); // the successor finishes first; the world is free again

    // Nothing to remove, nobody to accuse — the deposed process just lets go.
    await deposed.release();
    assert.equal(deposed.held, false);
  });
});
