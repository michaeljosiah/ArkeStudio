import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ulid, type WorldBundle, type WorldSummary } from "@arke-studio/contracts";
import { ProposalManager } from "../gate/proposals.js";
import { AppIndex } from "../index-db/app-index.js";
import type { DatabaseCtor } from "../index-db/sqlite.js";
import type { WorldProvider } from "../world-provider.js";
import { atomicWriteFile } from "./atomic.js";
import { appendChanges } from "./change-writer.js";
import { checkPathBudget, fromPortable, toExtendedLength, type PathBudget } from "./paths.js";
import { readWorldMeta, scanWorld, WorldOpenError, SUPPORTED_SCHEMA_VERSION } from "./scan.js";
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
}

export interface FsWorldProviderOptions {
  clock?: () => string;
  /** Injected SQLite constructor (Electron-ABI in the desktop shell; Node's by default). */
  sqlite?: DatabaseCtor;
}

export class FsWorldProvider implements WorldProvider {
  private store: WorldStore | null = null;
  private onStaleCb: ((worldId: string) => void) | null = null;
  private appIndex: AppIndex | null = null;
  private appIndexReady = false;
  readonly pathBudget: PathBudget;
  private readonly clock: () => string;
  private readonly sqlite: DatabaseCtor | undefined;

  constructor(
    readonly appRoot: string,
    opts: FsWorldProviderOptions = {},
  ) {
    this.pathBudget = checkPathBudget(appRoot);
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.sqlite = opts.sqlite;
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

  onWorldStale(cb: (worldId: string) => void): void {
    this.onStaleCb = cb;
  }

  /**
   * List worlds. Once the registry is seeded, the picker renders from it without opening or
   * scanning any world (SPEC-003 R-6, D3); the first call seeds it with one folder pass.
   */
  async listWorlds(): Promise<WorldSummary[]> {
    await this.ensureAppRoot();
    if (this.appIndex?.seeded) {
      return this.appIndex.listWorlds(this.worldsDir());
    }
    const summaries = await this.scanAllSummaries();
    if (this.appIndex) {
      for (const s of summaries) this.appIndex.upsertWorld(s);
      this.appIndex.markSeeded();
    }
    return summaries;
  }

  private async scanAllSummaries(): Promise<WorldSummary[]> {
    const out: WorldSummary[] = [];
    let entries: string[];
    try {
      entries = await readdir(toExtendedLength(this.worldsDir()));
    } catch {
      return out;
    }
    for (const slug of entries) {
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
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
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
    await appendChanges(join(dir, "changes.jsonl"), [
      { ts: at, entity: "world", created: true, source: "form", canonRevisionAfter: 0 },
    ]);
    this.appIndex?.upsertWorld({
      worldId,
      slug,
      name: input.name,
      ...(input.logline ? { logline: input.logline } : {}),
      counts: { characters: 0, locations: 0, factions: 0, canonEntries: 0, productions: 0 },
      updated: at,
    });
    return { worldId, slug };
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
      if (this.store.worldId === worldId) return this.store.getBundle();
      await this.closeStore();
    }
    this.store = await WorldStore.open(dir, {
      clock: this.clock,
      ...(this.sqlite ? { sqlite: this.sqlite } : {}),
      events: { onStale: () => this.onStaleCb?.(worldId) },
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
    for (const production of bundle.productions) {
      const decided = new Set(production.reviews.map((r) => r.takeId));
      unreviewedTakes += production.takes.filter((t) => !decided.has(t.id)).length;
    }
    this.appIndex?.upsertWorld({
      worldId: bundle.meta.worldId,
      slug: bundle.meta.slug,
      name: bundle.meta.name,
      ...(bundle.meta.logline !== undefined ? { logline: bundle.meta.logline } : {}),
      counts: {
        characters: bundle.sheets.filter((s) => s.type === "character").length,
        locations: bundle.sheets.filter((s) => s.type === "location").length,
        factions: bundle.sheets.filter((s) => s.type === "faction").length,
        canonEntries: bundle.canon.length,
        productions: bundle.productions.length,
      },
      attention: {
        unreviewedTakes,
        openProposals: bundle.proposals.length,
        asOf: new Date().toISOString(),
      },
      updated: bundle.meta.updated,
    });
  }

  private async closeStore(): Promise<void> {
    if (!this.store) return;
    this.refreshRegistry(this.store.getBundle());
    await this.store.close();
    this.store = null;
  }

  /** The open store, for mutations. Null until a world is loaded. */
  openStore(): WorldStore | null {
    return this.store;
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
    ".pdf": "application/pdf",
  };

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
    const ext = portable.slice(portable.lastIndexOf(".")).toLowerCase();
    const contentType = FsWorldProvider.MEDIA_TYPES[ext];
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

  async reloadWorld(worldId: string): Promise<WorldBundle> {
    if (!this.store || this.store.worldId !== worldId) return this.loadWorld(worldId);
    return this.store.reload();
  }

  async reconcileExternalEdit(worldId: string, path: string): Promise<WorldBundle> {
    if (!this.store || this.store.worldId !== worldId) await this.loadWorld(worldId);
    await this.store!.reconcileExternalEdit(path);
    return this.store!.getBundle();
  }

  async close(): Promise<void> {
    await this.closeStore();
    try {
      this.appIndex?.close();
    } catch {
      /* cache */
    }
    this.appIndex = null;
    this.appIndexReady = false;
  }

  /** Read-only scan of an arbitrary world directory — the corpus/tests entry point. */
  static scanDirectory(dir: string) {
    return scanWorld(dir);
  }
}
