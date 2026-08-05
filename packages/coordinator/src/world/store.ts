import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalEdit, WorldBundle } from "@arke-studio/contracts";
import { WorldIndex } from "../index-db/world-index.js";
import type { DatabaseCtor } from "../index-db/sqlite.js";
import { atomicWriteFile } from "./atomic.js";
import { appendChanges } from "./change-writer.js";
import { CommitPlanError, Committer, classify, type CommitHooks, type CommitInput, type CommitResult } from "./commit.js";
import { WorldLock } from "./lock.js";
import { fromPortable, toExtendedLength } from "./paths.js";
import { scanWorld, type ScanResult } from "./scan.js";
import { MarkdownFile, sha256 } from "./text-files.js";
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
}

export interface WorldStoreEvents {
  /** Another program touched world files while open (R-23). */
  onStale?: () => void;
}

export class WorldStore {
  private constructor(
    readonly dir: string,
    private readonly lock: WorldLock | null,
    private readonly committer: Committer,
    private scan: ScanResult,
    private externalEdits: ExternalEdit[],
    private readonly events: WorldStoreEvents,
    private readonly clockFn: () => string,
  ) {}

  private stale = false;
  private watcher: WorldWatcher | null = null;
  private mutex: Promise<unknown> = Promise.resolve();
  private index: WorldIndex | null = null;
  private verifying = false;
  private verifyAgain = false;
  private closed = false;

  static async open(
    dir: string,
    opts: {
      readOnly?: boolean;
      events?: WorldStoreEvents;
      clock?: () => string;
      sqlite?: DatabaseCtor;
    } = {},
  ): Promise<WorldStore> {
    const committer = new Committer(dir, opts.clock);
    // Recovery first — an interrupted commit must resolve before anything reads (R-15).
    await committer.recover();

    let lock: WorldLock | null = null;
    if (!opts.readOnly) {
      lock = new WorldLock(dir);
      await lock.acquire();
    }

    let scan: ScanResult;
    try {
      scan = await scanWorld(dir);
    } catch (err) {
      await lock?.release();
      throw err;
    }
    const externalEdits = opts.readOnly ? [] : await detectExternalEdits(dir, scan);
    const store = new WorldStore(
      dir,
      lock,
      committer,
      scan,
      externalEdits,
      opts.events ?? {},
      opts.clock ?? (() => new Date().toISOString()),
    );
    if (!opts.readOnly) {
      await store.saveScanState();
      store.startWatcher();
      // The index is a cache: a failure to open it degrades queries, never the world (SPEC-003 R-4).
      try {
        store.index = WorldIndex.open(dir, scan.bundle, opts.sqlite);
      } catch {
        store.index = null;
      }
    }
    return store;
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
  async gateOp<T>(fn: () => Promise<T>): Promise<T> {
    return this.serialise(async () => {
      this.watcher?.suppress();
      try {
        return await fn();
      } finally {
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
    return this.serialise(async () => {
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
    return { ...this.scan.bundle, externalEdits: this.externalEdits, stale: this.stale };
  }

  get worldId(): string {
    return this.scan.meta.worldId;
  }

  /** Serialised commit through the one primitive (D1). Rescans so the bundle stays honest. */
  async commit(input: CommitInput, hooks?: CommitHooks): Promise<CommitResult> {
    return this.serialise(async () => {
      this.watcher?.suppress();
      try {
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
    const result = await this.committer.commit(input, hooks);
    await this.rescan([...input.files.map((f) => f.path), "world.json"]);
    return result;
  }

  /** Retire, never delete (R-26): the entity stays on disk, marked, still resolving. */
  async retire(portablePath: string, source: string): Promise<CommitResult> {
    const live = await this.readEntity(portablePath);
    if (live === null) throw new CommitPlanError(`${portablePath} does not exist`);
    const doc = MarkdownFile.parse(live);
    doc.setData({ retired: true });
    return this.commit({
      kind: "retire",
      source,
      files: [{ path: portablePath, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
    });
  }

  /**
   * Restore a historical version as a new version (R-20): the content of v<n> becomes the
   * next version; v(n+1)…current stay in history untouched.
   */
  async restoreVersion(portablePath: string, version: number, source: string): Promise<CommitResult> {
    const kind = classify(portablePath);
    let historyPath: string;
    if (kind.track === "sheet") historyPath = `.history/${kind.collection}/${kind.id}/v${version}.md`;
    else if (kind.track === "canon") historyPath = `.history/canon/${kind.id}/v${version}.md`;
    else throw new CommitPlanError(`restore is defined for sheets and canon, not ${kind.track}`);

    const snapshot = await this.readEntity(historyPath);
    if (snapshot === null) throw new CommitPlanError(`no history snapshot at ${historyPath}`);
    const live = await this.readEntity(portablePath);
    return this.commit({
      kind: "restore",
      source,
      files: [
        {
          path: portablePath,
          action: live === null ? "create" : "replace",
          content: snapshot,
          baseHash: live === null ? null : sha256(live),
        },
      ],
    });
  }

  /** Reserve canon ids under the lock — logged like any other allocation (R-11, R-21). */
  async allocateCanonIds(count: number, source: string): Promise<string[]> {
    const result = await this.commit({ kind: "canon-id-allocation", source, files: [], allocateCanonIds: count });
    return result.allocatedCanonIds;
  }

  /**
   * Adopt one closed-world edit (R-28): the manifest-era version is already in `.history/`,
   * so adoption bumps the entity version, stamps, and logs `source: "external-edit"`.
   */
  async reconcileExternalEdit(portablePath: string): Promise<void> {
    const edit = this.externalEdits.find((e) => e.path === portablePath);
    if (!edit) return;
    await this.serialise(async () => {
      this.watcher?.suppress();
      try {
        if (edit.kind === "deleted") {
          // The file is gone; record the disappearance so the log explains it.
          await appendChanges(join(this.dir, "changes.jsonl"), [
            {
              ts: new Date().toISOString(),
              entity: portablePath.replace(/\.(md|json)$/, ""),
              deleted: true,
              source: "external-edit",
            },
          ]);
        } else {
          const live = await this.readEntity(portablePath);
          if (live !== null) {
            const kind = classify(portablePath);
            if (kind.track === "sheet" || kind.track === "canon" || kind.track === "chapter") {
              const doc = MarkdownFile.parse(live);
              const fromVersion = (doc.data["version"] as number | undefined) ?? null;
              // Adopt via the committer so snapshot/version/log happen together (D16). The
              // edit itself is the base — we accept the bytes on disk as the proposed content.
              await this.committer.commit({
                kind: "external-edit",
                source: "external-edit",
                files: [{ path: portablePath, action: "replace", content: live, baseHash: sha256(live) }],
              });
              void fromVersion;
            } else {
              await appendChanges(join(this.dir, "changes.jsonl"), [
                {
                  ts: new Date().toISOString(),
                  entity: portablePath.replace(/\.(md|json)$/, ""),
                  source: "external-edit",
                },
              ]);
            }
          }
        }
        this.externalEdits = this.externalEdits.filter((e) => e.path !== portablePath);
        await this.rescan();
      } finally {
        this.watcher?.unsuppress();
      }
    });
  }

  /** Reload after an external change: rescan, clear staleness (R-23). */
  async reload(): Promise<WorldBundle> {
    await this.serialise(async () => {
      await this.rescan();
      this.stale = false;
      await this.saveScanState();
    });
    return this.getBundle();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.watcher?.stop();
    this.watcher = null;
    await this.serialise(async () => {
      try {
        this.index?.close();
      } catch {
        /* a cache that cannot close is a cache that gets rebuilt */
      }
      this.index = null;
      if (this.lock) {
        await this.saveScanState();
        await this.lock.release();
      }
    });
  }

  // ---- internals -----------------------------------------------------------

  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.catch(() => {});
    return run;
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
    } catch {
      return null;
    }
  }

  private async saveScanState(): Promise<void> {
    const state: ScanState = { manifest: this.scan.manifest };
    await atomicWriteFile(join(this.dir, fromPortable(SCAN_STATE_PATH)), JSON.stringify(state, null, 2));
  }

  private startWatcher(): void {
    this.watcher = new WorldWatcher(this.dir, () => this.verifyExternalChange());
    this.watcher.start();
  }

  private verifyExternalChange(): void {
    if (this.stale || this.closed) return;
    if (this.verifying) {
      this.verifyAgain = true;
      return;
    }
    this.verifying = true;
    void this.serialise(async () => {
      do {
        this.verifyAgain = false;
        let changed = false;
        try {
          const current = await scanWorld(this.dir);
          changed = !sameManifest(this.scan.manifest, current.manifest);
        } catch {
          // A malformed or missing world.json is itself a verified byte-level change.
          changed = true;
        }
        if (this.closed || this.stale) return;
        if (changed) {
          this.stale = true;
          this.events.onStale?.();
          return;
        }
      } while (this.verifyAgain);
    }).finally(() => {
      const rerun = this.verifyAgain;
      this.verifying = false;
      if (rerun) this.verifyExternalChange();
    });
  }
}

function sameManifest(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/**
 * Closed-world edit detection (R-28): compare the on-disk manifest against `.index/`'s
 * scan-state. A world with no scan-state (foreign, fresh, or index deleted) is adopted as-is
 * rather than reported as edited — `.index/` is deletable and its absence must cost nothing.
 */
async function detectExternalEdits(dir: string, scan: ScanResult): Promise<ExternalEdit[]> {
  let previous: ScanState | null = null;
  try {
    previous = JSON.parse(
      await readFile(toExtendedLength(join(dir, fromPortable(SCAN_STATE_PATH))), "utf8"),
    ) as ScanState;
  } catch {
    return [];
  }
  if (!previous || typeof previous.manifest !== "object") return [];

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
