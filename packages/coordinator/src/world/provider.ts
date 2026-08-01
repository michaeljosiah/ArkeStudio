import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ulid, type WorldBundle, type WorldSummary } from "@arke-studio/contracts";
import type { WorldProvider } from "../world-provider.js";
import { atomicWriteFile } from "./atomic.js";
import { appendChanges } from "./change-writer.js";
import { checkPathBudget, toExtendedLength, type PathBudget } from "./paths.js";
import { readWorldMeta, scanWorld, WorldOpenError, SUPPORTED_SCHEMA_VERSION } from "./scan.js";
import { uniqueSlug } from "./slug.js";
import { WorldStore } from "./store.js";

/**
 * The real filesystem WorldProvider (SPEC-002 T-14), replacing SPEC-001's mock. Owns the app
 * root, world discovery and creation, and the lifecycle of the one open WorldStore.
 */

export interface CreateWorldInput {
  name: string;
  logline?: string;
  tone?: string;
  genre?: string;
}

export class FsWorldProvider implements WorldProvider {
  private store: WorldStore | null = null;
  private onStaleCb: ((worldId: string) => void) | null = null;
  readonly pathBudget: PathBudget;

  constructor(
    readonly appRoot: string,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    this.pathBudget = checkPathBudget(appRoot);
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
  }

  onWorldStale(cb: (worldId: string) => void): void {
    this.onStaleCb = cb;
  }

  async listWorlds(): Promise<WorldSummary[]> {
    await this.ensureAppRoot();
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

  /** Open for read-write: recovery, lock, scan, watcher. Closes any previously open world. */
  async loadWorld(worldId: string): Promise<WorldBundle> {
    const dir = await this.findWorldDir(worldId);
    if (this.store) {
      if (this.store.worldId === worldId) return this.store.getBundle();
      await this.store.close();
      this.store = null;
    }
    this.store = await WorldStore.open(dir, {
      clock: this.clock,
      events: { onStale: () => this.onStaleCb?.(worldId) },
    });
    return this.store.getBundle();
  }

  /** The open store, for mutations. Null until a world is loaded. */
  openStore(): WorldStore | null {
    return this.store;
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
    await this.store?.close();
    this.store = null;
  }

  /** Read-only scan of an arbitrary world directory — the corpus/tests entry point. */
  static scanDirectory(dir: string) {
    return scanWorld(dir);
  }
}
