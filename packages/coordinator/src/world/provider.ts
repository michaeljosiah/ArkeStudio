import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  BIBLE_PATH,
  DEFAULT_AUDIO_POLICY,
  ulid,
  unattendedProposalsOf,
  worldSheets,
  type ArtDirectionRecord,
  type WorldBundle,
  type WorldSummary,
} from "@arke-studio/contracts";
import { ProposalManager } from "../gate/proposals.js";
import { AppIndex } from "../index-db/app-index.js";
import type { DatabaseCtor } from "../index-db/sqlite.js";
import type { WorldProvider } from "../world-provider.js";
import { atomicWriteFile, renameWithRetry, type AtomicDeps } from "./atomic.js";
import { initialBible } from "./bible.js";
import { appendChanges } from "./change-writer.js";
import { checkPathBudget, fromPortable, toExtendedLength, type PathBudget } from "./paths.js";
import { installSampleWorld } from "./sample-world.js";
import { findKeyArt, readWorldMeta, scanWorld, WorldOpenError } from "./scan.js";
import { uniqueSlug } from "./slug.js";
import { WorldStore } from "./store.js";

/**
 * The real filesystem WorldProvider (SPEC-002 T-14), replacing SPEC-001's mock. Owns the app
 * root, world discovery and creation, the app-level index (SPEC-003 R-5, R-6), and the
 * lifecycle of the one open WorldStore.
 */

export interface CreateWorldInput {
  name: string;
  logline?: string;
  tone?: string;
  genre?: string;
  /** The look chosen during genesis. Absent means none was chosen, not an empty one. */
  artDirection?: string;
  /** The through-line the founding conversation wrote. Absent means the world has no bible yet. */
  bible?: string;
}

/** Codes a held handle produces. The rename has already retried through them (issue 288). */
const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

export interface FsWorldProviderOptions {
  clock?: () => string;
  /** Injected SQLite constructor (Electron-ABI in the desktop shell; Node's by default). */
  sqlite?: DatabaseCtor;
  /** Injectable for the archive-failure tests, exactly as `AtomicDeps` is for the retry ones. */
  rename?: AtomicDeps["rename"];
}

export class FsWorldProvider implements WorldProvider {
  private store: WorldStore | null = null;
  private closing = false;
  private readonly scopedOperations = new Set<Promise<unknown>>();
  private onAdoptedCb: ((worldId: string) => void) | null = null;
  private onLockErrorCb: ((worldId: string, message: string, consecutive: number) => void) | null = null;
  private appIndex: AppIndex | null = null;
  private appIndexReady = false;
  readonly pathBudget: PathBudget;
  private readonly clock: () => string;
  private readonly sqlite: DatabaseCtor | undefined;
  private readonly renameDeps: AtomicDeps;

  constructor(
    readonly appRoot: string,
    opts: FsWorldProviderOptions = {},
  ) {
    this.pathBudget = checkPathBudget(appRoot);
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.sqlite = opts.sqlite;
    this.renameDeps = opts.rename ? { rename: opts.rename } : {};
  }

  private worldsDir(): string {
    return join(this.appRoot, "worlds");
  }

  /** Create the app root and its skeleton on first run, without prompting (R-1). */
  async ensureAppRoot(): Promise<void> {
    await mkdir(toExtendedLength(this.worldsDir()), { recursive: true });
    await mkdir(toExtendedLength(join(this.appRoot, "queue")), { recursive: true });
    await mkdir(toExtendedLength(join(this.appRoot, "logs")), { recursive: true });
    const configPath = join(this.appRoot, "config.json");
    try {
      await stat(toExtendedLength(configPath));
    } catch {
      await atomicWriteFile(configPath, JSON.stringify({ schemaVersion: 1 }, null, 2) + "\n");
    }
    if (!this.appIndexReady) {
      this.appIndexReady = true;
      // The app index is a cache over the logs and the worlds present; failure degrades to
      // direct scans, never to an error (SPEC-003 R-4).
      try {
        this.appIndex = AppIndex.open(this.appRoot, this.sqlite);
        await this.appIndex.rebuildFromLogs(
          join(this.appRoot, "queue", "jobs.jsonl"),
          join(this.appRoot, "ledger.jsonl"),
        );
      } catch {
        this.appIndex = null;
      }
    }
  }

  /** The app-level index (registry, jobs, ledger) when it opened. */
  getAppIndex(): AppIndex | null {
    return this.appIndex;
  }

  /** The open world's derived index, when available. */
  getWorldIndex() {
    return this.store?.getIndex() ?? null;
  }

  /** The accept gate over the open world (SPEC-004). */
  gate(): ProposalManager | null {
    return this.store ? new ProposalManager(this.store) : null;
  }

  /** The open world quietly refreshed itself — no accusation, just newer Bible bytes (R-BIBLE-6). */
  onWorldAdopted(cb: (worldId: string) => void): void {
    this.onAdoptedCb = cb;
  }

  onWorldLockError(cb: (worldId: string, message: string, consecutive: number) => void): void {
    this.onLockErrorCb = cb;
  }

  private lockEvents(worldId: string) {
    return {
      onHeartbeatError: (error: unknown, consecutive: number) =>
        this.onLockErrorCb?.(worldId, error instanceof Error ? error.message : String(error), consecutive),
    };
  }

  /**
   * List worlds. Once seeded, cached summaries serve known worlds while a folder pass discovers
   * additions; only newly discovered worlds have their summary scanned (SPEC-003 R-6, D3).
   */
  async listWorlds(): Promise<WorldSummary[]> {
    await this.ensureAppRoot();
    if (this.appIndex?.seeded) {
      const cached = this.appIndex.listWorlds(this.worldsDir());
      const cachedByFolder = new Map(cached.map((world) => [world.slug.toLowerCase(), world]));
      const entries = await readdir(toExtendedLength(this.worldsDir())).catch(() => [] as string[]);
      const additions: WorldSummary[] = [];
      const scanFolder = async (folder: string): Promise<void> => {
        additions.push(...(await this.scanAllSummaries(new Set(entries.filter((entry) => entry !== folder)))));
      };
      for (const folder of entries) {
        const known = cachedByFolder.get(folder.toLowerCase());
        if (!known) {
          await scanFolder(folder);
          continue;
        }
        try {
          const meta = await readWorldMeta(join(this.worldsDir(), folder));
          if (meta.worldId !== known.worldId || meta.slug !== known.slug) {
            this.appIndex.removeWorld(known.worldId);
            await scanFolder(folder);
          }
        } catch {
          /* AppIndex.listWorlds already drops missing known rows; unreadable replacements stay absent. */
        }
      }
      for (const summary of additions) this.appIndex.upsertWorld(summary);
      const replaced = new Set(additions.map((world) => world.slug.toLowerCase()));
      return [...cached.filter((world) => !replaced.has(world.slug.toLowerCase())), ...additions].sort((a, b) => b.updated.localeCompare(a.updated));
    }
    const summaries = await this.scanAllSummaries();
    if (this.appIndex) {
      for (const s of summaries) this.appIndex.upsertWorld(s);
      this.appIndex.markSeeded();
    }
    return summaries;
  }

  private async scanAllSummaries(skipSlugs: ReadonlySet<string> = new Set()): Promise<WorldSummary[]> {
    const out: WorldSummary[] = [];
    let entries: string[];
    try {
      entries = await readdir(toExtendedLength(this.worldsDir()));
    } catch {
      return out;
    }
    for (const slug of entries) {
      if (skipSlugs.has(slug)) continue;
      const dir = join(this.worldsDir(), slug);
      try {
        if (!(await stat(toExtendedLength(dir))).isDirectory()) continue;
      } catch {
        continue;
      }
      let meta;
      try {
        meta = await readWorldMeta(dir);
      } catch (err) {
        // Not-a-world children are ignored, not reported as corrupt (R-1). A newer-schema
        // world is skipped here; opening it directly yields the refusal message (R-25).
        if (err instanceof WorldOpenError && err.reason === "not-a-world") continue;
        continue;
      }
      const countMd = async (sub: string) => {
        try {
          return (await readdir(toExtendedLength(join(dir, sub)))).filter((f) => f.endsWith(".md")).length;
        } catch {
          return 0;
        }
      };
      const productions = await (async () => {
        try {
          const dirs = await readdir(toExtendedLength(join(dir, "productions")));
          let n = 0;
          for (const p of dirs) {
            try {
              await stat(toExtendedLength(join(dir, "productions", p, "production.json")));
              n++;
            } catch {
              /* not a production */
            }
          }
          return n;
        } catch {
          return 0;
        }
      })();
      out.push({
        worldId: meta.worldId,
        slug: meta.slug,
        name: meta.name,
        ...(meta.logline !== undefined ? { logline: meta.logline } : {}),
        // Read here, not assumed: the picker card used to name `world-art.png` itself, which
        // showed a placeholder over every world whose key art was any other format.
        keyArt: await findKeyArt(dir),
        counts: {
          characters: await countMd("characters"),
          locations: await countMd("locations"),
          factions: await countMd("factions"),
          canonEntries: await countMd("canon"),
          productions,
        },
        updated: meta.updated,
      });
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** Create a world folder: slug, world.json, first change line (SPEC-002 §2.2). */
  async createWorld(input: CreateWorldInput): Promise<{ worldId: string; slug: string }> {
    await this.ensureAppRoot();
    const taken = await readdir(toExtendedLength(this.worldsDir())).catch(() => [] as string[]);
    const slug = uniqueSlug(input.name, "world", taken);
    const worldId = ulid();
    const at = this.clock();
    const dir = join(this.worldsDir(), slug);
    await mkdir(toExtendedLength(dir), { recursive: true });
    const meta = {
      worldId,
      slug,
      // Worlds are born at the oldest schema they satisfy, not the newest this build knows
      // (SPEC-023 R-23): a fresh world has no conversations and no new-model entities, so
      // older builds may open it; the first write that needs the boundary raises it.
      schemaVersion: 1,
      name: input.name,
      ...(input.logline ? { logline: input.logline } : {}),
      ...(input.tone ? { tone: input.tone } : {}),
      ...(input.genre ? { genre: input.genre } : {}),
      canonRevision: 0,
      nextCanonId: 1,
      created: at,
      updated: at,
    };
    await atomicWriteFile(join(dir, "world.json"), JSON.stringify(meta, null, 2) + "\n");
    // A look chosen at genesis is v1, accepted, with nothing behind it — the same record any
    // later change produces, so nothing downstream needs to know a world was born with one.
    // Chosen is not derived: a world with no record still resolves a look from tone and genre,
    // and says on the art-direction screen that this is where it came from.
    if (input.artDirection) {
      const record: ArtDirectionRecord = {
        version: 1,
        description: input.artDirection,
        acceptedAt: at,
        audio: DEFAULT_AUDIO_POLICY,
        failureModes: [],
        history: [],
      };
      await mkdir(toExtendedLength(join(dir, "art-direction")), { recursive: true });
      await atomicWriteFile(
        join(dir, "art-direction", "art-direction.json"),
        JSON.stringify(record, null, 2) + "\n",
      );
    }
    // The one document that is the author's rather than the model's, written at v1 with no
    // history behind it — the same state any other first version has. It is deliberately not
    // a proposal: the Bible is ungated everywhere else (master §4.5), and a world cannot be
    // asked to approve the thinking that produced it.
    if (input.bible) {
      await atomicWriteFile(join(dir, fromPortable(BIBLE_PATH)), initialBible(input.bible, at));
    }
    await appendChanges(join(dir, "changes.jsonl"), [
      { ts: at, entity: "world", created: true, source: "form", canonRevisionAfter: 0 },
      // The shape a commit would have written for the same file (`commit.ts:401`), so the
      // history screen reads a born bible and an edited one the same way.
      ...(input.bible
        ? [{ ts: at, entity: "bible", fromVersion: null, toVersion: 1, source: "genesis", canonRevisionAfter: 0 }]
        : []),
    ]);
    this.appIndex?.upsertWorld({
      worldId,
      slug,
      name: input.name,
      ...(input.logline ? { logline: input.logline } : {}),
      // A world is born without key art. It arrives the first time one is accepted.
      keyArt: null,
      counts: { characters: 0, locations: 0, factions: 0, canonEntries: 0, productions: 0 },
      updated: at,
    });
    return { worldId, slug };
  }

  /**
   * Install the sample world (SPEC-016 R-6). The copy and the identity rewrite live in
   * `sample-world.ts`; what belongs here is the app index, which learns about the new world
   * the same way it learns about a folder someone dropped in by hand — the next `listWorlds`
   * finds it and scans it, so its counts come from the world rather than from an assumption.
   */
  async installSampleWorld(sourceDir: string): Promise<{ worldId: string; slug: string; name: string }> {
    await this.ensureAppRoot();
    return installSampleWorld({ sourceDir, appRoot: this.appRoot });
  }

  async worldDir(worldId: string): Promise<string> {
    return this.findWorldDir(worldId);
  }

  private async findWorldDir(worldId: string): Promise<string> {
    for (const slug of await readdir(toExtendedLength(this.worldsDir())).catch(() => [] as string[])) {
      const dir = join(this.worldsDir(), slug);
      try {
        const meta = await readWorldMeta(dir);
        if (meta.worldId === worldId) return dir;
      } catch {
        /* not a world */
      }
    }
    throw new Error(`no world with id ${worldId}`);
  }

  /** Open for read-write: recovery, lock, scan, index, watcher. Closes any previous world. */
  async loadWorld(worldId: string): Promise<WorldBundle> {
    const dir = await this.findWorldDir(worldId);
    if (this.store) {
      if (this.store.worldId === worldId) {
        // The registry row follows the open world, not just its opening. Every snapshot refresh
        // arrives here, and skipping the refresh meant the picker described the world as it was
        // when it was opened — so accepting key art changed the hub and left the card that
        // sent you there showing the previous image until the world was closed.
        const open = this.store.getBundle();
        this.refreshRegistry(open);
        return open;
      }
      await this.closeStore();
    }
    this.store = await WorldStore.open(dir, {
      clock: this.clock,
      ...(this.sqlite ? { sqlite: this.sqlite } : {}),
      events: {
        ...this.lockEvents(worldId),
        onAdopted: () => this.onAdoptedCb?.(worldId),
      },
    });
    const bundle = this.store.getBundle();
    this.refreshRegistry(bundle);
    return bundle;
  }

  /** Registry rows follow the world's real counts whenever a bundle passes through. */
  private refreshRegistry(bundle: WorldBundle): void {
    // Closed-world attention counts (SPEC-014 R-7, T-5/T-6): computed here, at the moment the
    // bundle passes through, and labelled as-of now. A crash leaving them stale is honest by
    // construction — the label always says when they were true.
    let unreviewedTakes = 0;
    const decidedReferences = new Set(bundle.referenceReviews.map((review) => review.takeId));
    unreviewedTakes += bundle.referenceTakes.filter((take) => !decidedReferences.has(take.id)).length;
    for (const production of bundle.productions) {
      const decided = new Set(production.reviews.map((r) => r.takeId));
      unreviewedTakes += production.takes.filter((t) => !decided.has(t.id)).length;
    }
    const openProposals = unattendedProposalsOf(bundle.proposals, bundle.conversations).length;
    this.appIndex?.upsertWorld({
      worldId: bundle.meta.worldId,
      slug: bundle.meta.slug,
      name: bundle.meta.name,
      ...(bundle.meta.logline !== undefined ? { logline: bundle.meta.logline } : {}),
      // Straight off the bundle the open world just produced, so accepting key art updates the
      // card as soon as the world passes through — not on the next cold scan of the library.
      keyArt: bundle.keyArt,
      counts: {
        // The world's own cast, matching the hub, the ledgers and their counts (SPEC-020 R-8).
        // The picker summarises the world, and a total that counted a production's guests would
        // be a number no surface in the world can show and no click can reach.
        characters: worldSheets(bundle.sheets).filter((s) => s.type === "character").length,
        locations: worldSheets(bundle.sheets).filter((s) => s.type === "location").length,
        factions: worldSheets(bundle.sheets).filter((s) => s.type === "faction").length,
        canonEntries: bundle.canon.length,
        productions: bundle.productions.length,
      },
      attention: {
        unreviewedTakes,
        openProposals,
        asOf: new Date().toISOString(),
      },
      updated: bundle.meta.updated,
    });
  }

  private async closeStore(): Promise<void> {
    const store = this.store;
    if (!store) return;
    // Detached before the close drains, so no later write can be admitted through the provider.
    // The registry is refreshed afterwards: writes admitted before close are allowed to finish,
    // and reading their bundle early can cache a paid take as unreviewed after its accept lands.
    this.store = null;
    try {
      await store.close();
    } finally {
      this.refreshRegistry(store.getBundle());
    }
  }

  /** The open store, for mutations. Null until a world is loaded. */
  openStore(): WorldStore | null {
    return this.store;
  }

  async withWorldStore<T>(worldId: string, fn: (store: WorldStore) => Promise<T>): Promise<T> {
    if (this.closing) throw new Error("the world provider is closing");
    const operation = (async () => {
      if (this.store?.worldId === worldId) return fn(this.store);
      const dir = await this.findWorldDir(worldId);
      const scoped = await WorldStore.open(dir, {
        events: this.lockEvents(worldId),
        clock: this.clock,
        ...(this.sqlite ? { sqlite: this.sqlite } : {}),
      });
      try {
        return await fn(scoped);
      } finally {
        this.refreshRegistry(scoped.getBundle());
        await scoped.close();
      }
    })();
    this.scopedOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.scopedOperations.delete(operation);
    }
  }

  /**
   * Archive a world: it leaves the library without leaving the disk.
   *
   * The folder moves to `archive/<slug>`, whole and unchanged — commit journal, artifacts,
   * lock file and all — so recovery is a move back rather than a restore from anything. That
   * is the point of a world being plain files (SPEC-002): the safe version of delete is a
   * rename, and it costs nothing on the same volume.
   *
   * The store is closed first. Windows will not move a directory holding an open SQLite index,
   * and the failure it gives for that reads as a permissions problem, which it is not.
   *
   * Closing is not on its own enough, because the app is not the only thing that can be holding
   * the folder (issue 288). A media probe is a child process reading an artifact, and Defender
   * and the search indexer take transient handles on anything in a user profile. So the move
   * goes through the same backoff every other exclusive-access operation here uses, and a world
   * that still will not move is *reopened* before the failure is reported: it was closed in order
   * to be archived, it was not archived, and leaving it closed but still in the library would
   * strand the screen on a world nothing has open.
   */
  async archiveWorld(worldId: string): Promise<{ folder: string }> {
    const dir = await this.findWorldDir(worldId);
    const wasOpen = this.store?.worldId === worldId;
    if (wasOpen) await this.closeStore();
    try {
      const target = await this.moveToArchive(dir);
      this.appIndex?.removeWorld(worldId);
      return { folder: target };
    } catch (err) {
      // Reopened before the throw, so the refusal the user reads describes a library that is
      // still exactly as it was. Every step after the close is inside this — making `archive/`
      // and reading it can fail too, and a world left closed by one of those is stranded just
      // as thoroughly as one left closed by the rename.
      //
      // Never during shutdown: there is no screen left to strand, and reopening behind a close
      // that has already released the lock would leave the process holding a world it has no
      // remaining opportunity to put down.
      //
      // And never over a world somebody has since opened. Message handlers overlap, so an
      // open-world for a different world can land during the move's backoff — putting this one
      // back on top of it would close the world the screen has just been told about and leave
      // the provider serving one nobody selected, which is a worse version of the strand this
      // reopen exists to prevent.
      if (wasOpen && !this.closing && this.store === null) await this.loadWorld(worldId).catch(() => {});
      throw err;
    }
  }

  /** `archive/<slug>`, or a stamped name when something is already there. Returns where it went. */
  private async moveToArchive(dir: string): Promise<string> {
    const archiveRoot = join(this.appRoot, "archive");
    await mkdir(toExtendedLength(archiveRoot), { recursive: true });

    // Archiving the same slug twice must not overwrite the first one — the second gets a
    // stamped name rather than silently replacing what is already in there.
    const slug = basename(dir);
    let target = join(archiveRoot, slug);
    try {
      await stat(toExtendedLength(target));
      target = join(archiveRoot, `${slug}-${this.clock().replace(/[:.]/g, "-")}`);
    } catch {
      /* nothing there under that name — the plain one will do */
    }
    // The same backoff as every other exclusive-access operation on a world (D7): Defender, the
    // search indexer and a media probe all take handles nobody asked them to hold, and each is
    // gone a moment later.
    try {
      await renameWithRetry(dir, target, this.renameDeps);
    } catch (err) {
      /*
       * Only the move is read as "in use", and only here.
       *
       * A folder held open fails with a permissions code, and reporting that verbatim describes a
       * problem nobody has — the world is not read-only, something is reading it. But the same
       * code from `mkdir archive/` above means the opposite: the destination is genuinely out of
       * reach, retrying will not help, and the permissions diagnosis is the useful one. So the
       * translation sits against the rename rather than over everything archiving does.
       */
      if (!HELD_OPEN.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      throw new Error("something is still using that world's files — nothing moved, so try again in a moment");
    }
    return target;
  }

  /** Media file types the renderer may fetch — nothing else is servable. */
  private static readonly MEDIA_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".pdf": "application/pdf",
  };

  /**
   * Text the renderer may read, and only out of the artifact shelf (issue 477).
   *
   * A markdown or text artifact has no `<img>` to point at it: the viewer has to fetch the bytes
   * and render them itself. That is the whole reason these are here — and the reason they are
   * kept apart from the media map rather than added to it. A world folder is full of markdown
   * that is not an artifact (the bible, every sheet, every canon entry), and this route is
   * loopback HTTP with an open CORS header on it, so "any .md under the world" would be a wider
   * door than the feature asked for. Confined to `artifacts/`, the door is exactly the shelf.
   */
  private static readonly TEXT_TYPES: Record<string, string> = {
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  };

  /**
   * The content type a world-relative path may be served as, or undefined for "not servable".
   *
   * Sidecars are `<file>.json` and `.json` is in neither map, so an artifact's record stays
   * unreadable over HTTP while its bytes are readable — which is the split the shelf wants.
   */
  private static contentTypeFor(portable: string): string | undefined {
    const ext = portable.slice(portable.lastIndexOf(".")).toLowerCase();
    const media = FsWorldProvider.MEDIA_TYPES[ext];
    if (media !== undefined) return media;
    const text = FsWorldProvider.TEXT_TYPES[ext];
    if (text === undefined) return undefined;
    return portable.startsWith("artifacts/") ? text : undefined;
  }

  /**
   * Read-only media for the renderer (design-fidelity pass): any registered world's media
   * files, resolved under the worlds directory with the traversal cases refused outright.
   */
  /** Genesis sandboxes live beside worlds, never inside one — world-less by construction. */
  async genesisDir(genesisId: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(genesisId)) throw new Error("invalid genesis id");
    const dir = join(this.appRoot, ".genesis", genesisId);
    await mkdir(toExtendedLength(dir), { recursive: true });
    return dir;
  }

  async discardGenesis(genesisId: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(genesisId)) return;
    await rm(toExtendedLength(join(this.appRoot, ".genesis", genesisId)), { recursive: true, force: true });
  }

  async serveMedia(slug: string, relPath: string): Promise<{ path: string; contentType: string } | null> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
    const portable = relPath.replace(/\\/g, "/");
    if (portable.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
    const contentType = FsWorldProvider.contentTypeFor(portable);
    if (contentType === undefined) return null;
    const abs = join(this.worldsDir(), slug, fromPortable(portable));
    try {
      const info = await stat(toExtendedLength(abs));
      if (!info.isFile()) return null;
    } catch {
      return null;
    }
    return { path: toExtendedLength(abs), contentType };
  }

  /**
   * Read-only media from a genesis sandbox — the look preview, before any world exists
   * (SPEC-031 R-50). Same guarding as `serveMedia`, different root: sandboxes live under
   * `.genesis/`, deliberately outside the worlds directory.
   *
   * Media only — a sandbox holds a look preview and nothing a text viewer would open, so the
   * artifact-shelf text types (issue 477) deliberately do not reach here.
   */
  async serveGenesisMedia(genesisId: string, relPath: string): Promise<{ path: string; contentType: string } | null> {
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(genesisId)) return null;
    const portable = relPath.replace(/\\/g, "/");
    if (portable.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
    const ext = portable.slice(portable.lastIndexOf(".")).toLowerCase();
    const contentType = FsWorldProvider.MEDIA_TYPES[ext];
    if (contentType === undefined) return null;
    const abs = join(this.appRoot, ".genesis", genesisId, fromPortable(portable));
    try {
      const info = await stat(toExtendedLength(abs));
      if (!info.isFile()) return null;
    } catch {
      return null;
    }
    return { path: toExtendedLength(abs), contentType };
  }

  async reconcileExternalEdit(worldId: string, path: string): Promise<WorldBundle> {
    if (!this.store || this.store.worldId !== worldId) await this.loadWorld(worldId);
    await this.store!.reconcileExternalEdit(path);
    return this.store!.getBundle();
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await Promise.all(this.scopedOperations);
      await this.closeStore();
      try {
        this.appIndex?.close();
      } catch {
        /* cache */
      }
      this.appIndex = null;
      this.appIndexReady = false;
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }

  /** Read-only scan of an arbitrary world directory — the corpus/tests entry point. */
  static scanDirectory(dir: string) {
    return scanWorld(dir);
  }
}
