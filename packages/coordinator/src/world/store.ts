import { recoverPerformanceStorage } from "../audio/performance-purge.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  BIBLE_PATH,
  WorldAuthoredFieldChangesSchema,
  type ExternalEdit,
  type WorldAuthoredFieldChanges,
  type WorldBundle,
} from "@arke-studio/contracts";
import { WorldIndex } from "../index-db/world-index.js";
import type { DatabaseCtor } from "../index-db/sqlite.js";
import { restoredSceneContent } from "../productions/scene-record.js";
import { atomicWriteFile } from "./atomic.js";
import { readBible } from "./bible.js";
import { readChanges } from "./change-writer.js";
import {
  CommitPlanError,
  Committer,
  PROSE_STYLE_SCHEMA_VERSION,
  classify,
  type CommitHooks,
  type CommitInput,
  type CommitResult,
  type PendingCommit,
} from "./commit.js";
import { WorldLock, type WorldLockOptions } from "./lock.js";
import { fromPortable, toExtendedLength } from "./paths.js";
import { scanWorld, type ScanResult } from "./scan.js";
import { JsonFile, MarkdownFile, sha256 } from "./text-files.js";
import { WorldWatcher } from "./watcher.js";

/**
 * An open world (SPEC-002): lock held, incomplete commits recovered, entities scanned,
 * closed-world edits surfaced for explicit reconciliation, and a watcher marking the world
 * stale on out-of-band writes. Every mutation goes through the commit primitive.
 */

const SCAN_STATE_PATH = ".index/scan-state.json";

interface ScanState {
  /** portable path → content hash at last app-owned write/close. */
  manifest: Record<string, string>;
  /** Number of durable change lines reflected by the manifest. */
  changeCount?: number;
}

export interface WorldStoreEvents {
  /**
   * The store refreshed its own scan without anybody being at fault (R-BIBLE-6).
   *
   * The only thing the watcher does now. There used to be an `onStale` beside it — an accusation
   * that something outside the app had written to a gated file, raised as a banner with a Reload
   * button. It could not tell Arke's own writes from anybody else's often enough to be worth
   * keeping: the harness writing a drafted sheet, or a commit whose rescan landed a beat late,
   * both read as "another program wrote to the world folder", and the person was asked to
   * reload over their own work. Detection of edits made while the world was CLOSED is untouched
   * and is where that guarantee actually lives (R-28) — nothing is merged silently there either.
   */
  onAdopted?: () => void;
  onOwnershipLost?: (error: Error) => void;
  onHeartbeatError?: (error: unknown, consecutive: number) => void;
}

/** Checked after a fresh scan and inside the store's mutation queue. Null means still current. */
export type WorldStatePrecondition = () => string | null;

export class WorldStateStaleError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "WorldStateStaleError";
  }
}

export class WorldStore {
  private constructor(
    readonly dir: string,
    private readonly lock: WorldLock | null,
    private readonly committer: Committer,
    private scan: ScanResult,
    private externalEdits: ExternalEdit[],
    private scanState: ScanState,
    private readonly events: WorldStoreEvents,
    private readonly clockFn: () => string,
  ) {
    this.lockHeld = lock !== null;
    if (lock) lock.onHeartbeatError = events.onHeartbeatError;
    if (lock) lock.onLost = (error) => {
      this.ownershipFailure = error;
      this.lockHeld = false;
      this.watcher?.stop();
      this.events.onOwnershipLost?.(error);
    };
  }

  private watcher: WorldWatcher | null = null;
  private mutex: Promise<unknown> = Promise.resolve();
  private index: WorldIndex | null = null;
  private verifying = false;
  private verifyAgain = false;
  private closed = false;
  private readonly admittedGate = new AsyncLocalStorage<{ active: boolean }>();
  private lockHeld: boolean;
  private ownershipFailure: Error | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly closingController = new AbortController();

  static async open(
    dir: string,
    opts: {
      readOnly?: boolean;
      events?: WorldStoreEvents;
      clock?: () => string;
      sqlite?: DatabaseCtor;
      lockOptions?: WorldLockOptions;
    } = {},
  ): Promise<WorldStore> {
    const committer = new Committer(dir, opts.clock, async () => {
      if (!lock) throw new Error("world is read-only");
      await lock.assertOwned();
    });

    /*
     * Ownership first, then recovery.
     *
     * An interrupted commit must resolve before anything reads (R-15), but recovery is not a
     * read: it rolls a `planning` journal back or a `committing` journal forward, renaming live
     * files. Running it before the lock meant a second instance resolved a journal that the
     * world's actual owner was in the middle of writing — the one thing the lock exists to
     * prevent, done by the code that runs before the lock is taken.
     *
     * A read-only open takes no lock, so it never recovers either. It has no claim on the world
     * and renaming live files is not something a read-only consumer may do; the unresolved
     * commit is reported instead, and resolved by whoever opens the world for writing.
     */
    let lock: WorldLock | null = null;
    if (!opts.readOnly) {
      lock = new WorldLock(dir, opts.lockOptions);
      await lock.acquire();
    }

    let store: WorldStore | null = null;
    let pending: PendingCommit[] = [];
    let recoveredPerformances: string[] = [];
    try {
      if (opts.readOnly) pending = await committer.pendingRecovery();
      else { await committer.recover(); await lock!.assertOwned(); recoveredPerformances = await recoverPerformanceStorage(dir); }
      const scan = await scanWorld(dir);
      if (pending.length > 0) {
        scan.bundle.problems = [
          ...scan.bundle.problems,
          ...pending.map((p) => ({
            path: `.commit/${p.commitId}.json`,
            message:
              p.phase === "prepared"
                ? "an interrupted commit is unresolved; nothing of it reached the world, and it will be rolled back when this world is opened for writing"
                : "an interrupted commit is unresolved; this world is part-way through it and is not a consistent snapshot until it is opened for writing and the commit completed",
          })),
        ];
      }
      let scanState = opts.readOnly ? null : await readScanState(dir);
      if (!opts.readOnly && scanState === null) scanState = await reconstructScanState(dir, scan);
      else if (scanState !== null) scanState = await advanceCommittedScanState(dir, scanState);
      if (scanState) for (const path of recoveredPerformances) {
        const hash = scan.manifest[path];
        if (hash === undefined) delete scanState.manifest[path];
        else scanState.manifest[path] = hash;
      }
      const externalEdits = scanState === null ? [] : detectExternalEdits(scan, scanState);
      store = new WorldStore(
        dir,
        lock,
        committer,
        scan,
        externalEdits,
        scanState ?? { manifest: {} },
        opts.events ?? {},
        opts.clock ?? (() => new Date().toISOString()),
      );
      if (!opts.readOnly) {
        await store.adoptBibleIfMoved();
        await store.adoptProseStyleBoundary();
        await store.ensureCurrentHistorySnapshots();
        await store.saveScanState();
        store.startWatcher();
        try {
          store.index = WorldIndex.open(dir, scan.bundle, opts.sqlite);
        } catch {
          store.index = null;
        }
      }
      return store;
    } catch (err) {
      store?.watcher?.stop();
      try {
        store?.index?.close();
      } catch {
        /* a failed cache open has no cleanup guarantee */
      }
      await lock?.release().catch(() => {});
      throw err;
    }
  }

  /** The derived index, when it opened. Null in read-only mode or after an index failure. */
  getIndex(): WorldIndex | null {
    return this.index;
  }

  /**
   * Run a gate operation that writes inside the world (`.proposals/`): serialised with
   * commits, watcher-suppressed so our own writes never read as external, rescanned after so
   * the bundle stays honest (SPEC-004).
   */
  async gateOp<T>(fn: () => Promise<T>, precondition?: WorldStatePrecondition): Promise<T> {
    this.assertWritable();
    return this.serialise(async () => {
      // Admission happened before enqueue so work already ahead of close may drain. This second
      // check proves the lock still exists when the callback actually reaches the filesystem.
      await this.verifyOwnership();
      this.watcher?.suppress();
      const admission = { active: true };
      try {
        if (precondition) {
          await this.rescan();
          const detail = precondition();
          if (detail) throw new WorldStateStaleError(detail);
        }
        return await this.admittedGate.run(admission, fn);
      } finally {
        // Async-local context is inherited by timers and detached promises. Revoking the shared
        // token keeps those descendants from borrowing this invocation's close-drain permit.
        admission.active = false;
        await this.rescan().catch(() => {});
        this.watcher?.unsuppress();
      }
    });
  }

  /**
   * One app-owned filesystem write outside the commit/proposal machinery. Kept separate from
   * gateOp so callers do not imply proposal semantics, but uses the same serialization,
   * watcher ownership and post-write rescan (issue #87).
   */
  async ownedWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.assertWritable();
    return this.serialise(async () => {
      await this.verifyOwnership();
      this.watcher?.suppress();
      try {
        return await fn();
      } finally {
        await this.rescan().catch(() => {});
        this.watcher?.unsuppress();
      }
    });
  }

  /** The committer's clock — gate records share the world's notion of now. */
  now(): string {
    return this.clockFn();
  }

  getBundle(): WorldBundle {
    return {
      ...this.scan.bundle,
      externalEdits: this.externalEdits,
    };
  }

  get worldId(): string {
    return this.scan.meta.worldId;
  }

  /** True as soon as close starts, before the serialization queue releases the world lock. */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Aborts the instant close starts — before the lock is released, and before anything that
   * moves the folder can run (issue 288).
   *
   * Refusing writes is not enough for background work that holds an *operating system handle* on
   * the world: a media probe is a child process reading a file, and on Windows a directory with
   * an open handle inside it cannot be renamed. Archiving closes the store and then renames, so
   * the close is the only moment that is both after "this world is going away" and before the
   * move — which makes it the honest place to hang cancellation, rather than asking every caller
   * to remember which pass belongs to which world.
   */
  get closingSignal(): AbortSignal {
    return this.closingController.signal;
  }

  /**
   * Raise world.json.schemaVersion to `version` if the world is still below it (SPEC-023
   * R-23, issue #403). A no-op when the world already crossed the boundary, so every feature
   * that needs it can call it unconditionally before its first write.
   */
  async ensureSchemaVersion(version: number, source: string): Promise<void> {
    const current = this.scan.meta.schemaVersion;
    if (current >= version) return;
    await this.commit({ kind: "world-schema-upgrade", source, files: [], raiseSchemaVersion: version });
  }

  /** Serialised commit through the one primitive (D1). Rescans so the bundle stays honest. */
  async commit(
    input: CommitInput,
    hooks?: CommitHooks,
    precondition?: WorldStatePrecondition,
  ): Promise<CommitResult> {
    this.assertWritable();
    return this.serialise(async () => {
      await this.verifyOwnership();
      this.watcher?.suppress();
      try {
        if (precondition) {
          await this.rescan();
          const detail = precondition();
          if (detail) throw new WorldStateStaleError(detail);
        }
        return await this.commitUnserialised(input, hooks);
      } finally {
        this.watcher?.unsuppress();
      }
    });
  }

  /**
   * The commit body without the serialise/suppress envelope — for callers already inside
   * `gateOp` (SPEC-004), where re-entering the chain would deadlock. Never call directly
   * outside that envelope.
   */
  async commitUnserialised(input: CommitInput, hooks?: CommitHooks): Promise<CommitResult> {
    // gateOp admits before enqueue, so a close may start while its callback is still running.
    // Only that async call chain may drain under the lock; unrelated calls still see the close.
    if (this.admittedGate.getStore()?.active === true) this.assertLockHeld();
    else this.assertWritable();
    const result = await this.committer.commit(input, hooks);
    await this.rescan([...input.files.map((f) => f.path), "world.json"]);
    return result;
  }

  /**
   * Rename the world — the label only, never the folder.
   *
   * A world's name was written once at creation and read everywhere after, so a world named in
   * the first thirty seconds of an idea was named for good. It is a label, and labels change.
   *
   * The directory is deliberately untouched. It is this world's address: media URLs, artifact
   * paths, the lock and every stored reference resolve through it, and moving it would break
   * all of them to change a word on a screen — the same rule scenes and episodes follow, where
   * the stem is identity and the title is what a person is allowed to rewrite.
   */
  async renameWorld(name: string, source = "form"): Promise<CommitResult> {
    const trimmed = name.trim();
    if (trimmed === "") throw new CommitPlanError("a world needs a name");
    return this.commit({ kind: "world-rename", source, files: [], worldFields: { name: trimmed } });
  }

  /** Update only registered authored world fields; null clears an optional field. */
  async updateWorldMetadata(
    changes: WorldAuthoredFieldChanges,
    source: string,
    requestId?: string,
    precondition?: WorldStatePrecondition,
  ): Promise<CommitResult> {
    const fields = WorldAuthoredFieldChangesSchema.parse(changes);
    return this.commit(
      {
        kind: "world-metadata-edit",
        source,
        files: [],
        worldFields: fields,
        ...(requestId ? { requestId } : {}),
      },
      undefined,
      precondition,
    );
  }

  /** Retire, never delete (R-26): the entity stays on disk, marked, still resolving. */
  async retire(
    portablePath: string,
    source: string,
    requestId?: string,
    precondition?: WorldStatePrecondition,
  ): Promise<CommitResult> {
    const live = await this.readEntity(portablePath);
    if (live === null) throw new CommitPlanError(`${portablePath} does not exist`);
    const doc = MarkdownFile.parse(live);
    doc.setData({ retired: true });
    return this.commit(
      {
        kind: "retire",
        source,
        files: [{ path: portablePath, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
        ...(requestId ? { requestId } : {}),
      },
      undefined,
      precondition,
    );
  }

  /** Undo the first authored look by returning the world to its metadata-derived direction. */
  async restoreDerivedArtDirection(source: string): Promise<CommitResult> {
    const live = await this.readEntity(ART_DIRECTION_PATH);
    if (live === null) throw new CommitPlanError("the world look is already derived");
    return this.commit({
      kind: "art-direction-restore-derived",
      source,
      files: [{ path: ART_DIRECTION_PATH, action: "delete", baseHash: sha256(live) }],
    });
  }

  /**
   * Restore a historical version as a new version (R-20): the content of v<n> becomes the
   * next version; v(n+1)…current stay in history untouched.
   */
  async restoreVersion(
    portablePath: string,
    version: number,
    source: string,
    requestId?: string,
    precondition?: WorldStatePrecondition,
  ): Promise<CommitResult> {
    const kind = classify(portablePath);
    // Chapters joined the list with turn 126: an accepted draft cuts a version and a snapshot
    // (commit.ts keeps one per version on the chapter track), so "Earlier versions" can put one
    // back exactly as the bible does. A direct save preserves the version and refreshes the
    // current snapshot, which is why only accepted drafts appear in that list.
    const restorable = new Set(["sheet", "canon", "bible", "scene", "story", "prose-style", "season", "episode", "art-direction", "chapter"]);
    const historyPath = restorable.has(kind.track) ? historyPathForVersion(portablePath, version) : null;
    if (historyPath === null) {
      throw new CommitPlanError(
        `restore is not defined for ${kind.track}`,
      );
    }

    const live = await this.readEntity(portablePath);
    let snapshot = await this.readEntity(historyPath);
    // The first derived look and imported legacy histories live inside the accepted record rather
    // than as standalone snapshots. Materialise that embedded version for the same commit path.
    if (snapshot === null && kind.track === "art-direction" && live !== null) {
      const record = ArtDirectionRecordSchema.parse(JSON.parse(live));
      const historical = record.history.find((entry) => entry.version === version);
      if (historical) {
        snapshot = `${JSON.stringify({
          version: record.version,
          description: historical.description,
          ...(historical.masterLook ? { masterLook: historical.masterLook } : {}),
          ...(historical.keyArtIntent !== undefined ? { keyArtIntent: historical.keyArtIntent } : {}),
          acceptedAt: record.acceptedAt,
          audio: historical.audio,
          failureModes: historical.failureModes,
          history: record.history,
        }, null, 2)}\n`;
      }
    }
    if (snapshot === null) throw new CommitPlanError(`no history snapshot at ${historyPath}`);
    /*
     * A restored scene comes back graph-backed (SPEC-029 R-15) — see `restoredSceneContent`,
     * which decides what those bytes are and refuses a snapshot it cannot stand behind. Undo is
     * the one operation that has to be trusted absolutely, so a snapshot that cannot be read, or
     * whose graph is not one path, is named rather than written back on the strength of not
     * having been understood. The boundary is raised inside the commit, from the bytes, and
     * never lowered.
     */
    let content = snapshot;
    if (kind.track === "scene") {
      try {
        content = restoredSceneContent(snapshot);
      } catch (err) {
        throw new CommitPlanError(
          `${historyPath} cannot be restored: ${err instanceof Error ? err.message.slice(0, 300) : "unreadable"}`,
        );
      }
    }
    return this.commit(
      {
        kind: "restore",
        source,
        files: [
          {
            path: portablePath,
            action: live === null ? "create" : "replace",
            content,
            baseHash: live === null ? null : sha256(live),
          },
        ],
        ...(requestId ? { requestId } : {}),
      },
      undefined,
      precondition,
    );
  }

  /** Reserve canon ids under the lock — logged like any other allocation (R-11, R-21). */
  async allocateCanonIds(
    count: number,
    source: string,
    precondition?: WorldStatePrecondition,
  ): Promise<string[]> {
    const result = await this.commit(
      {
        kind: "canon-id-allocation",
        source,
        files: [],
        allocateCanonIds: count,
      },
      undefined,
      precondition,
    );
    return result.allocatedCanonIds;
  }

  /**
   * Adopt one closed-world edit (R-28): the manifest-era version is already in `.history/`,
   * so adoption bumps the entity version, stamps, and logs `source: "external-edit"`.
   */
  async reconcileExternalEdit(portablePath: string): Promise<void> {
    if (this.closed) throw new Error("world is closed");
    this.assertLockHeld();
    await this.serialise(async () => {
      await this.verifyOwnership();
      const edit = this.externalEdits.find((e) => e.path === portablePath);
      if (!edit) return;
      this.watcher?.suppress();
      try {
        const live = await this.readEntity(portablePath);
        const committedHash = this.scanState.manifest[portablePath];

        // Reclassify under the serialization lock. An editor may have recreated a deletion,
        // deleted a modification, or restored the committed bytes while the prompt was waiting.
        if (live !== null && committedHash === sha256(live)) {
          this.externalEdits = this.externalEdits.filter((candidate) => candidate.path !== portablePath);
          await this.rescan();
          await this.afterExternalEditsCleared();
          return;
        }
        if (live === null && committedHash === undefined) {
          this.externalEdits = this.externalEdits.filter((candidate) => candidate.path !== portablePath);
          await this.rescan();
          await this.afterExternalEditsCleared();
          return;
        }

        const versioned = historyDirectory(portablePath) !== null;
        const committedBase = versioned
          ? committedHash === undefined
            ? null
            : await this.readLastCommittedEntity(portablePath)
          : undefined;
        await this.committer.commit({
          kind: "external-edit",
          source: "external-edit",
          files: [
            {
              path: portablePath,
              action: live === null ? "delete" : "replace",
              ...(live !== null ? { content: live } : {}),
              baseHash: live === null ? null : sha256(live),
              ...(committedBase !== undefined ? { committedBase } : {}),
              committedBaseHash: committedHash ?? null,
            },
          ],
        });
        this.externalEdits = this.externalEdits.filter((e) => e.path !== portablePath);
        await this.rescan();
        await this.afterExternalEditsCleared();
      } catch (err) {
        const refusal = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        this.externalEdits = this.externalEdits.map((candidate) =>
          candidate.path === portablePath
            ? { path: candidate.path, kind: candidate.kind, refusal }
            : candidate,
        );
      } finally {
        this.watcher?.unsuppress();
      }
    });
  }

  /** Rescan from disk and re-save the scan state. */
  async reload(): Promise<WorldBundle> {
    this.assertWritable();
    await this.serialise(async () => {
      await this.verifyOwnership();
      this.scan = await scanWorld(this.dir);
      this.externalEdits = detectExternalEdits(this.scan, this.scanState);
      await this.saveScanState();
      await this.afterExternalEditsCleared();
    });
    return this.getBundle();
  }

  /**
   * What waited on the last external edit clearing (codex on PR 903, rounds two and three): the
   * Bible adopted if it moved, and the style's boundary. A world that opened with edits waiting
   * skipped both, and every path that empties the set comes through here — an edit committed,
   * an edit found put back or already gone, a reload — because the moment they clear is the
   * moment adoption can happen, whichever way they cleared.
   */
  private async afterExternalEditsCleared(): Promise<void> {
    if (this.externalEdits.length > 0) return;
    await this.adoptBibleIfMoved();
    await this.adoptProseStyleBoundary();
  }

  /**
   * Fence the world at a boundary a feature needs with no file of its own to carry it (codex on
   * PR 903): a World Chat turn held to a passage or to a reply is recorded as an event a build
   * older than the constraints reads as corruption, so the world is raised first and that build
   * refuses it by name instead. Only ever raises; a world already there is left alone, and a
   * world with external edits waiting is refused like any other write.
   */
  async raiseSchemaBoundary(version: number, kind: string): Promise<void> {
    const current = (this.scan.bundle.meta as { schemaVersion?: number }).schemaVersion ?? 1;
    if (current >= version) return;
    await this.commit({ kind, source: "app", files: [], raiseSchemaVersion: version });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    // Synchronous, alongside the flag and the watcher: everything holding a handle on this world
    // has to let go before the queue drains, because whoever closed it may be about to move it.
    this.closingController.abort();
    this.watcher?.stop();
    this.watcher = null;
    this.closePromise = this.serialise(async () => {
      try {
        this.index?.close();
      } catch {
        /* a cache that cannot close is a cache that gets rebuilt */
      }
      this.index = null;
      if (this.lock) {
        /*
         * The release happens whatever the scan state does. `.index/` is derived and deletable
         * by design, so a scan state that cannot be written — a full disk, a permissions change
         * — must not be what keeps a world locked: the heartbeat would go on refreshing a lock
         * nothing intends to hold, and this process could not reopen its own world until it
         * exited. The failure is not swallowed for that, only deferred until the lock is off.
         */
        let scanStateFailure: unknown;
        try {
          await this.saveScanState();
        } catch (err) {
          scanStateFailure = err;
        }
        // No serialised mutation can still be active here: close itself owns the queue now.
        // Mark ownership gone before release so even a failing/deposed release cannot leave this
        // store advertising a write permit it no longer has.
        this.lockHeld = false;
        await this.lock.release();
        if (scanStateFailure !== undefined) throw scanStateFailure;
      }
    });
    return this.closePromise;
  }

  // ---- internals -----------------------------------------------------------

  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.catch(() => {});
    return run;
  }

  /**
   * Admit writes synchronously, before they enter the queue.
   *
   * A write invoked before close is enqueued before close and is allowed to finish while the lock
   * is held. `close()` flips `closed` synchronously before enqueueing itself, so a later write is
   * refused here rather than running behind close after lock release.
   */
  private assertWritable(): void {
    if (this.closed) throw new Error("world is closed");
    this.assertLockHeld();
    if (this.externalEdits.length > 0) {
      throw new CommitPlanError("world has external edits awaiting reconciliation");
    }
  }

  private async verifyOwnership(): Promise<void> {
    this.assertLockHeld();
    await this.lock!.assertOwned();
  }

  private assertLockHeld(): void {
    if (this.ownershipFailure) throw this.ownershipFailure;
    if (!this.lockHeld) throw new Error(this.closed ? "world is closed" : "world is read-only");
  }

  /**
   * Rescan after a mutation. With the changed-path set (a commit), the index applies an
   * incremental delta (SPEC-003 R-20); without one (reload, reconcile), it syncs by
   * fingerprint and rebuilds only if the world actually differs.
   */
  private async rescan(changedPaths?: string[]): Promise<void> {
    this.scan = await scanWorld(this.dir);
    await this.saveScanState();
    try {
      if (this.index && changedPaths) this.index.applyCommit(changedPaths, this.scan.bundle);
      else this.index?.sync(this.scan.bundle);
    } catch {
      // A cache failure never surfaces: drop the index; the next open rebuilds it (R-4).
      try {
        this.index?.close();
      } catch {
        /* already broken */
      }
      this.index = null;
    }
  }

  private async readEntity(portablePath: string): Promise<string | null> {
    try {
      return await readFile(toExtendedLength(join(this.dir, fromPortable(portablePath))), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async saveScanState(): Promise<void> {
    await this.verifyOwnership();
    const unresolved = new Set(this.externalEdits.map((edit) => edit.path));
    const manifest = { ...this.scanState.manifest };

    for (const [path, hash] of Object.entries(this.scan.manifest)) {
      if (unresolved.has(path)) continue;
      manifest[path] = hash;
    }
    for (const path of Object.keys(manifest)) {
      if (!(path in this.scan.manifest) && !unresolved.has(path)) {
        delete manifest[path];
      }
    }

    this.scanState = { manifest, changeCount: this.scan.changeCount };
    await atomicWriteFile(
      join(this.dir, fromPortable(SCAN_STATE_PATH)),
      JSON.stringify(this.scanState, null, 2),
    );
  }

  /** Seed the current committed snapshot when adopting a world that predates history tracking. */
  private async ensureCurrentHistorySnapshots(): Promise<void> {
    const unresolved = new Set(this.externalEdits.map((edit) => edit.path));
    const seeds = Object.entries(this.scan.manifest)
      .filter(([portablePath]) => !unresolved.has(portablePath) && historyDirectory(portablePath) !== null)
      .map(async ([portablePath, hash]) => {
        const content = await this.readEntity(portablePath);
        if (content === null || sha256(content) !== hash) return;
        const snapshot = historySnapshot(portablePath, content);
        if (snapshot === null) return;
        const existing = await this.readEntity(snapshot.path);
        if (existing === null) {
          await this.verifyOwnership();
          await atomicWriteFile(join(this.dir, fromPortable(snapshot.path)), content);
        }
        else if (existing !== content) {
          throw new CommitPlanError(`${snapshot.path}: history snapshot conflicts with the committed version`);
        }
      });
    // A failed open must not release the world lock while another seed is still writing.
    const results = await Promise.allSettled(seeds);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  }

  private async readLastCommittedEntity(portablePath: string): Promise<string> {
    const expected = this.scanState.manifest[portablePath];
    if (expected === undefined) {
      throw new CommitPlanError(`${portablePath}: last committed version is unavailable`);
    }
    // The manifest supplies the identity; history supplies the canonical bytes.
    const historyDir = historyDirectory(portablePath);
    if (historyDir !== null) {
      const entries = await readdir(join(this.dir, fromPortable(historyDir))).catch(() => []);
      for (const entry of entries) {
        if (!/^v\d+\.(md|json)$/.test(entry)) continue;
        const content = await this.readEntity(`${historyDir}/${entry}`);
        if (content !== null && sha256(content) === expected) return content;
      }
    }
    throw new CommitPlanError(`${portablePath}: last committed version is unavailable`);
  }

  /**
   * The watcher's only remaining job: notice the Bible moved and take the new bytes (R-BIBLE-6).
   *
   * `bible.md` is the one authored file the product invites the user to open in a text editor, so
   * a hand-edit to it is the feature working. Everything else the watcher used to do — compare
   * byte manifests, wait, compare again, and declare the world stale — is gone with the banner it
   * fed.
   */
  private startWatcher(): void {
    this.watcher = new WorldWatcher(this.dir, () => {
      if (this.closed) return;
      void this.serialise(() => this.adoptBibleIfMoved()).catch(() => {
        /* a bible that could not be re-read is re-read on the next event, or at open */
      });
    });
    this.watcher.start();
  }

  /**
   * Hot-reload the Bible instead of accusing anybody of editing it (R-BIBLE-6).
   *
   * `bible.md` is the one authored file the product invites the user to open in a text editor, so
   * a hand-edit to it is the feature working, not an anomaly. It is absent from the manifests for
   * that reason — R-23's staleness and R-28's reconciliation both exist to protect *gated* files,
   * and applying either here would answer an edit the app asked for with "this world changed
   * outside Arke Studio", or with a reconciliation prompt for prose nobody needs to approve.
   *
   * A hand edit is committed as the next Bible version before the refreshed scan is published.
   */
  private async adoptBibleIfMoved(): Promise<void> {
    if (this.closed || this.externalEdits.length > 0) return;
    const live = await this.readEntity(BIBLE_PATH);
    if (live === null) return;
    const committed = await latestHistoryContent(this.dir, BIBLE_PATH);
    if (committed === null) {
      const snapshot = historySnapshot(BIBLE_PATH, live);
      if (snapshot !== null) await atomicWriteFile(join(this.dir, fromPortable(snapshot.path)), live);
      return;
    }
    if (committed === live) {
      const current = await readBible(this.dir);
      const held = this.scan.bundle.bible;
      if (current.text === held.text && current.present === held.present) return;
      await this.rescan();
      this.events.onAdopted?.();
      return;
    }

    let content = live;
    try {
      MarkdownFile.parse(content);
    } catch {
      content = MarkdownFile.create({ version: 1 }, live.replace(/^﻿/, "").replace(/\r\n/g, "\n")).serialize();
    }
    this.watcher?.suppress();
    try {
      await this.committer.commit({
        kind: "external-bible-edit",
        source: "external-edit",
        files: [
          {
            path: BIBLE_PATH,
            action: "replace",
            content,
            baseHash: sha256(live),
            committedBase: committed,
            committedBaseHash: sha256(committed),
          },
        ],
      });
      await this.rescan();
      this.events.onAdopted?.();
    } finally {
      this.watcher?.unsuppress();
    }
  }

  /**
   * A prose style written by hand into a world below its boundary (turn 128, codex on PR 897):
   * the record is adopted through the committer — the one funnel that raises the schema when
   * style bytes land — so a build older than the style refuses the world rather than drafting
   * without a style the author plainly meant. Nothing in the record changes; adoption bumps its
   * version and stamps it, as every external edit's does. Skipped while other external edits
   * wait, since those gate every write until they are reconciled.
   */
  private async adoptProseStyleBoundary(): Promise<void> {
    if (this.closed || this.externalEdits.length > 0) return;
    const schemaVersion = (this.scan.bundle.meta as { schemaVersion?: number }).schemaVersion ?? 1;
    if (schemaVersion >= PROSE_STYLE_SCHEMA_VERSION) return;
    const styled = this.scan.bundle.productions.find((production) => production.proseStyle);
    if (styled === undefined) return;
    const path = `productions/${styled.meta.id}/prose-style.json`;
    const live = await this.readEntity(path);
    if (live === null) return;
    const committed = await latestHistoryContent(this.dir, path);
    this.watcher?.suppress();
    try {
      await this.committer.commit({
        kind: "prose-style-adopted",
        source: "external-edit",
        files: [
          {
            path,
            action: "replace",
            content: live,
            baseHash: sha256(live),
            ...(committed !== null ? { committedBase: committed, committedBaseHash: sha256(committed) } : { committedBaseHash: null }),
          },
        ],
      });
      await this.rescan();
      this.events.onAdopted?.();
    } finally {
      this.watcher?.unsuppress();
    }
  }
}

/**
 * Closed-world edit detection (R-28): compare the on-disk manifest against `.index/`'s
 * scan-state. If that derived file is absent, canonical history reconstructs versioned baselines;
 * entities with no history are adopted as-is, so deleting `.index/` never deletes authored state.
 */
async function readScanState(dir: string): Promise<ScanState | null> {
  try {
    const previous = JSON.parse(
      await readFile(toExtendedLength(join(dir, fromPortable(SCAN_STATE_PATH))), "utf8"),
    ) as ScanState;
    return previous && typeof previous.manifest === "object" ? previous : null;
  } catch {
    return null;
  }
}

function historySnapshot(portablePath: string, content: string): { path: string; version: number } | null {
  try {
    const kind = classify(portablePath);
    let version: number | undefined;
    if (kind.track === "sheet" || kind.track === "chapter" || kind.track === "canon" || kind.track === "bible") {
      const doc = MarkdownFile.parse(content);
      if (kind.track !== "canon") version = doc.data["version"] as number | undefined;
      else {
        const stamps = [doc.data["introducedAt"], doc.data["settledAt"], doc.data["amendedAt"]].filter(
          (value): value is number => typeof value === "number",
        );
        version = stamps.length > 0 ? Math.max(...stamps) : 0;
      }
    } else if (historyDirectory(portablePath) !== null) {
      version = JsonFile.parse(content).value["version"] as number | undefined;
    }
    if (typeof version !== "number") return null;
    const path = historyPathForVersion(portablePath, version);
    return path === null ? null : { path, version };
  } catch {
    // Malformed entities remain visible as scan problems; history seeding must not block open.
  }
  return null;
}

async function reconstructScanState(dir: string, scan: ScanResult): Promise<ScanState> {
  const manifest = { ...scan.manifest };
  for (const portablePath of Object.keys(manifest)) {
    if (historyDirectory(portablePath) === null) continue;
    const committed = await latestHistoryContent(dir, portablePath);
    if (committed !== null) manifest[portablePath] = sha256(committed);
  }
  return { manifest, changeCount: scan.changeCount };
}

async function latestHistoryContent(dir: string, portablePath: string): Promise<string | null> {
  const historyDir = historyDirectory(portablePath);
  if (historyDir === null) return null;
  const entries = await readdir(join(dir, fromPortable(historyDir))).catch(() => []);
  const latest = entries
    .map((entry) => ({ entry, match: /^v(\d+)\.(md|json)$/.exec(entry) }))
    .filter((candidate): candidate is { entry: string; match: RegExpExecArray } => candidate.match !== null)
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))[0];
  if (!latest) return null;
  return readFile(toExtendedLength(join(dir, fromPortable(`${historyDir}/${latest.entry}`))), "utf8").catch(
    () => null,
  );
}

/**
 * Repair derived state after a commit landed but the process died before its post-commit rescan.
 * Only change lines written after the state's durable watermark may advance its hashes.
 */
async function advanceCommittedScanState(dir: string, previous: ScanState): Promise<ScanState> {
  if (previous.changeCount === undefined) return previous;
  const changes = await readChanges(join(dir, "changes.jsonl"));
  if (previous.changeCount > changes.length) return previous;
  const manifest = { ...previous.manifest };
  for (const change of changes.slice(previous.changeCount)) {
    const path = change["path"];
    const before = change["contentHashBefore"];
    const after = change["contentHashAfter"];
    if (typeof path !== "string" || (before !== null && typeof before !== "string")) continue;
    if (after !== null && typeof after !== "string") continue;
    const held = manifest[path];
    if ((before === null && held !== undefined) || (typeof before === "string" && held !== before)) continue;
    if (after === null) delete manifest[path];
    else manifest[path] = after;
  }
  return { manifest, changeCount: changes.length };
}

function historyPathForVersion(portablePath: string, version: number): string | null {
  const directory = historyDirectory(portablePath);
  if (directory === null) return null;
  return `${directory}/v${version}.${portablePath.endsWith(".md") ? "md" : "json"}`;
}

function historyDirectory(portablePath: string): string | null {
  const kind = classify(portablePath);
  if (kind.track === "sheet") return `.history/${kind.collection}/${kind.id}`;
  if (kind.track === "canon") return `.history/canon/${kind.id}`;
  if (kind.track === "chapter") return `.history/productions/${kind.production}/chapters/${kind.file}`;
  if (kind.track === "scene") return `.history/productions/${kind.production}/scenes/${kind.file}`;
  if (kind.track === "story" || kind.track === "prose-style" || kind.track === "routing" || kind.track === "season") {
    return `.history/productions/${kind.production}/${kind.track}`;
  }
  if (kind.track === "episode") return `.history/productions/${kind.production}/episodes/${kind.file}`;
  if (kind.track === "series") return `.history/series/${kind.id}`;
  if (kind.track === "art-direction") return ".history/art-direction";
  if (kind.track === "bible") return ".history/bible";
  return null;
}

function detectExternalEdits(scan: ScanResult, previous: ScanState): ExternalEdit[] {
  const edits: ExternalEdit[] = [];
  for (const [path, hash] of Object.entries(scan.manifest)) {
    const prior = previous.manifest[path];
    if (prior === undefined) edits.push({ path, kind: "created" });
    else if (prior !== hash) edits.push({ path, kind: "modified" });
  }
  for (const path of Object.keys(previous.manifest)) {
    if (!(path in scan.manifest)) edits.push({ path, kind: "deleted" });
  }
  // world.json changing outside the app is real, but reporting it as an entity edit would be
  // noise — schema migration and clone detection own that file's lifecycle.
  return edits.filter((e) => e.path !== "world.json");
}

/** Remove the derived scan-state (used by tests proving `.index/` is safe to delete). */
export async function deleteScanState(dir: string): Promise<void> {
  await rm(toExtendedLength(join(dir, fromPortable(SCAN_STATE_PATH))), { force: true });
}
