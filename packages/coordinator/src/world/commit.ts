import { mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  deriveArtDirectionDescription,
  newId,
  WorldMetaSchema,
} from "@arke-studio/contracts";
import { atomicWriteFile, renameWithRetry } from "./atomic.js";
import { appendChanges, hasCommitLine } from "./change-writer.js";
import { fromPortable, toExtendedLength } from "./paths.js";
import { JsonFile, MarkdownFile, sha256 } from "./text-files.js";

/**
 * The commit primitive (SPEC-002 §2.5, D1): every mutation to a world goes through here, and
 * atomicity, base-hash verification, history, versioning and the change log live here — once.
 *
 * A commit is a journalled transaction (R-15, master spec §3.5):
 *   prepared   — journal on disk with the full plan and hashes; nothing live touched
 *   committing — snapshots and staged files written; renames may have begun
 *   done       — everything renamed and logged; cleanup only
 *
 * Recovery on open rolls back from `prepared` (world byte-identical to before) and rolls
 * forward from `committing` (idempotent — every step checks recorded hashes).
 */

/** Thrown by test hooks to simulate a kill: recovery, not in-process rollback, must handle it. */
export class CrashSignal extends Error {}

export class CommitStaleError extends Error {
  constructor(readonly stale: Array<{ path: string; expected: string | null; found: string | null }>) {
    super(
      `commit refused: base moved for ${stale.map((s) => s.path).join(", ")} — staleness is detected, never merged`,
    );
  }
}

export class CommitPlanError extends Error {}

export interface CommitFileInput {
  /** World-relative portable path, e.g. "characters/maren-kest.md". Never world.json. */
  path: string;
  action: "replace" | "create" | "delete";
  /** Full proposed content for replace/create. The committer stamps version fields itself. */
  content?: string;
  /** sha256 of the base content this change was drafted against; null for create (R-27). */
  baseHash: string | null;
  /**
   * Save without cutting a version (SPEC-012 R-5): direct chapter authoring and shot prompt
   * overrides are production output, not gated change. The history snapshot for the current
   * version is refreshed rather than a new one cut.
   */
  preserveVersion?: boolean;
}

export interface CommitInput {
  kind: string;
  source: string;
  proposalId?: string;
  files: CommitFileInput[];
  /** Reserve this many canon ids in the same transaction (world.json nextCanonId). */
  allocateCanonIds?: number;
}

export interface CommitResult {
  commitId: string;
  canonRevision: number;
  /** Canon ids reserved by this commit, in order. */
  allocatedCanonIds: string[];
  /** path → new version (sheets, scenes, chapters, story). */
  versions: Record<string, number>;
}

interface JournalFile {
  path: string;
  action: "replace" | "create" | "delete";
  baseHash: string | null;
  newHash: string | null;
  /** Snapshot of the outgoing content (world-relative), when the entity is versioned. */
  historyPrev: string | null;
  /** Snapshot of the incoming content — what makes closed-world reconciliation able to name a prior version. */
  historyNew: string | null;
  prevContent?: string;
  newContent?: string;
}

interface Journal {
  commitId: string;
  phase: "prepared" | "committing" | "done";
  kind: string;
  source: string;
  proposalId?: string;
  at: string;
  canonRevisionFrom: number;
  canonRevisionTo: number;
  worldJsonBaseHash: string;
  worldJsonNewContent: string;
  files: JournalFile[];
  changes: object[];
  allocatedCanonIds: string[];
}

export interface CommitHooks {
  /** Test hook: throw from a point to simulate a kill exactly there. */
  at?: (point: string) => void;
}

const COMMIT_DIR = ".commit";

// ---------------------------------------------------------------------------
// Path classification — which track a file belongs to (§2.6)
// ---------------------------------------------------------------------------

type Classified =
  | { track: "canon"; id: string }
  | { track: "sheet"; collection: "characters" | "locations" | "factions"; id: string }
  | { track: "scene"; production: string; file: string }
  | { track: "chapter"; production: string; file: string }
  | { track: "story"; production: string }
  | { track: "production-meta"; production: string }
  | { track: "art-direction" }
  | { track: "unversioned" };

export function classify(path: string): Classified {
  let m = /^canon\/(CANON-\d+)\.md$/.exec(path);
  if (m) return { track: "canon", id: m[1]! };
  m = /^(characters|locations|factions)\/([a-z0-9][a-z0-9-]*)\.md$/.exec(path);
  if (m) return { track: "sheet", collection: m[1] as "characters", id: m[2]! };
  m = /^productions\/([a-z0-9-]+)\/scenes\/([^/]+)\.json$/.exec(path);
  if (m) return { track: "scene", production: m[1]!, file: m[2]! };
  m = /^productions\/([a-z0-9-]+)\/chapters\/([^/]+)\.md$/.exec(path);
  if (m) return { track: "chapter", production: m[1]!, file: m[2]! };
  m = /^productions\/([a-z0-9-]+)\/story\.json$/.exec(path);
  if (m) return { track: "story", production: m[1]! };
  m = /^productions\/([a-z0-9-]+)\/production\.json$/.exec(path);
  if (m) return { track: "production-meta", production: m[1]! };
  if (path === ART_DIRECTION_PATH) return { track: "art-direction" };
  return { track: "unversioned" };
}

/** The revision stamp a canon entry's content carries — what addresses its history snapshot. */
function canonStamp(data: Record<string, unknown>): number {
  const nums = [data["introducedAt"], data["settledAt"], data["amendedAt"]].filter(
    (v): v is number => typeof v === "number",
  );
  return nums.length ? Math.max(...nums) : 0;
}

// ---------------------------------------------------------------------------

export class Committer {
  constructor(
    private readonly worldDir: string,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private abs(portable: string): string {
    return join(this.worldDir, fromPortable(portable));
  }

  private async readLive(portable: string): Promise<string | null> {
    try {
      return await readFile(toExtendedLength(this.abs(portable)), "utf8");
    } catch {
      return null;
    }
  }

  /** Run a full journalled commit. Callers serialise; the world lock guarantees one process. */
  async commit(input: CommitInput, hooks: CommitHooks = {}): Promise<CommitResult> {
    const at = this.clock();
    const commitId = newId("cm");

    for (const f of input.files) {
      if (f.path === "world.json" || f.path.startsWith(".")) {
        throw new CommitPlanError(`callers never write ${f.path}; the committer owns it`);
      }
      if (f.action !== "delete" && typeof f.content !== "string") {
        throw new CommitPlanError(`${f.path}: ${f.action} requires content`);
      }
    }

    // ---- verify bases under the lock (R-27) --------------------------------
    const worldRaw = await this.readLive("world.json");
    if (worldRaw === null) throw new CommitPlanError("world.json missing — not a world");
    const worldDoc = JsonFile.parse(worldRaw);
    const stale: CommitStaleError["stale"] = [];
    const liveByPath = new Map<string, string | null>();
    for (const f of input.files) {
      const live = await this.readLive(f.path);
      liveByPath.set(f.path, live);
      const found = live === null ? null : sha256(live);
      if (f.action === "create") {
        if (live !== null) stale.push({ path: f.path, expected: null, found });
      } else if (found !== f.baseHash) {
        stale.push({ path: f.path, expected: f.baseHash, found });
      }
    }
    if (stale.length > 0) throw new CommitStaleError(stale);

    // ---- plan: versions, stamps, history, change lines ---------------------
    const revisionFrom = worldDoc.value["canonRevision"] as number;
    const touchesCanon = input.files.some((f) => classify(f.path).track === "canon");
    const revisionTo = touchesCanon ? revisionFrom + 1 : revisionFrom; // once, regardless of count (R-16)

    const files: JournalFile[] = [];
    const changes: object[] = [];
    const versions: Record<string, number> = {};

    for (const f of input.files) {
      const kind = classify(f.path);
      const live = liveByPath.get(f.path) ?? null;
      let newContent: string | null = f.action === "delete" ? null : f.content!;
      let historyPrev: string | null = null;
      let historyNew: string | null = null;
      let fromVersion: number | null = null;
      let toVersion: number | undefined;
      let fieldsChanged: string[] | undefined;

      if (kind.track === "sheet" || kind.track === "chapter") {
        const dirPath =
          kind.track === "sheet"
            ? `.history/${kind.collection}/${kind.id}`
            : `.history/productions/${kind.production}/chapters/${kind.file}`;
        const baseDoc = live !== null ? MarkdownFile.parse(live) : null;
        fromVersion = baseDoc ? ((baseDoc.data["version"] as number) ?? 1) : null;
        if (f.action !== "delete") {
          const doc = MarkdownFile.parse(newContent!);
          toVersion =
            f.action === "create" ? 1 : f.preserveVersion === true ? (fromVersion ?? 1) : (fromVersion ?? 0) + 1; // R-17; SPEC-012 R-5
          doc.setData({ version: toVersion, updated: at.slice(0, 10) });
          newContent = doc.serialize();
          historyNew = `${dirPath}/v${toVersion}.md`;
          fieldsChanged = baseDoc ? diffMarkdown(baseDoc, doc) : undefined;
          versions[f.path] = toVersion;
        }
        if (baseDoc) historyPrev = `${dirPath}/v${fromVersion}.md`;
      } else if (kind.track === "canon") {
        const dirPath = `.history/canon/${kind.id}`;
        const baseDoc = live !== null ? MarkdownFile.parse(live) : null;
        fromVersion = baseDoc ? canonStamp(baseDoc.data) : null;
        if (f.action !== "delete") {
          const doc = MarkdownFile.parse(newContent!);
          // Stamp the lifecycle field the transition implies (R-16).
          if (f.action === "create") {
            doc.setData({ introducedAt: revisionTo });
          } else if (doc.data["status"] === "settled" && baseDoc?.data["status"] !== "settled") {
            doc.setData({ settledAt: revisionTo });
          } else {
            doc.setData({ amendedAt: revisionTo });
          }
          newContent = doc.serialize();
          toVersion = revisionTo;
          historyNew = `${dirPath}/v${revisionTo}.md`;
          fieldsChanged = baseDoc ? diffMarkdown(baseDoc, doc) : undefined;
        }
        if (baseDoc) historyPrev = `${dirPath}/v${canonStamp(baseDoc.data)}.md`;
      } else if (kind.track === "scene" || kind.track === "story") {
        const idPart = kind.track === "scene" ? `scenes/${kind.file}` : "story";
        const dirPath = `.history/productions/${kind.production}/${idPart}`;
        const baseDoc = live !== null ? JsonFile.parse(live) : null;
        fromVersion = baseDoc ? ((baseDoc.value["version"] as number) ?? 1) : null;
        if (f.action !== "delete") {
          const doc = JsonFile.parse(newContent!);
          toVersion =
            f.action === "create" ? 1 : f.preserveVersion === true ? (fromVersion ?? 1) : (fromVersion ?? 0) + 1;
          doc.set({ version: toVersion });
          newContent = doc.serialize();
          historyNew = `${dirPath}/v${toVersion}.json`;
          versions[f.path] = toVersion;
        }
        if (baseDoc) historyPrev = `${dirPath}/v${fromVersion}.json`;
      } else if (kind.track === "art-direction") {
        const proposed = ArtDirectionRecordSchema.parse(JSON.parse(newContent!));
        const base = live !== null ? ArtDirectionRecordSchema.parse(JSON.parse(live)) : null;
        const worldMeta = WorldMetaSchema.parse(worldDoc.value);
        fromVersion = base?.version ?? 1;
        toVersion = fromVersion + 1;
        // Rebuilt field by field, which is why the standing constraints have to be named here
        // too (#244). This is the authoritative author of the record — the version and the
        // history are decided here, not by whatever the proposal staged — so a field the rebuild
        // does not mention is a field that does not survive being accepted, however carefully
        // the gate composed it. The schema's defaults would then quietly restore a permissive
        // world to the strict default, and the first sign would be a clip with music under it.
        const previous = base
          ? {
              version: base.version,
              description: base.description,
              ...(base.masterLook ? { masterLook: base.masterLook } : {}),
              acceptedAt: base.acceptedAt,
              audio: base.audio,
              failureModes: base.failureModes,
            }
          : {
              version: 1,
              description: deriveArtDirectionDescription(worldMeta),
              acceptedAt: worldMeta.created,
            };
        const next = ArtDirectionRecordSchema.parse({
          version: toVersion,
          description: proposed.description,
          ...(proposed.masterLook ? { masterLook: proposed.masterLook } : {}),
          acceptedAt: at,
          audio: proposed.audio,
          failureModes: proposed.failureModes,
          history: [...(base?.history ?? []), previous],
        });
        newContent = `${JSON.stringify(next, null, 2)}\n`;
        historyPrev = base ? `.history/art-direction/v${fromVersion}.json` : null;
        historyNew = `.history/art-direction/v${toVersion}.json`;
        fieldsChanged = [
          ...(base?.description !== next.description ? ["description"] : []),
          ...(base?.masterLook !== next.masterLook ? ["master-look"] : []),
        ];
        versions[f.path] = toVersion;
      }
      // production-meta and unversioned: change-logged only, no history, no stamps (§2.4.1).

      changes.push({
        ts: at,
        commitId,
        entity: f.path.replace(/\.(md|json)$/, ""),
        ...(f.action === "delete" ? { deleted: true } : {}),
        fromVersion,
        ...(toVersion !== undefined ? { toVersion } : {}),
        ...(fieldsChanged && fieldsChanged.length ? { fieldsChanged } : {}),
        source: input.source,
        canonRevisionAfter: revisionTo,
        ...(input.proposalId ? { proposalId: input.proposalId } : {}),
      });

      files.push({
        path: f.path,
        action: f.action,
        baseHash: f.baseHash,
        newHash: newContent !== null ? sha256(newContent) : null,
        historyPrev,
        historyNew,
        ...(live !== null ? { prevContent: live } : {}),
        ...(newContent !== null ? { newContent } : {}),
      });
    }

    // ---- world.json: revision, allocation, updated -------------------------
    const allocatedCanonIds: string[] = [];
    const worldUpdates: Record<string, unknown> = { updated: at };
    if (touchesCanon) worldUpdates["canonRevision"] = revisionTo;
    if (input.allocateCanonIds && input.allocateCanonIds > 0) {
      const next = worldDoc.value["nextCanonId"] as number;
      for (let i = 0; i < input.allocateCanonIds; i++) {
        allocatedCanonIds.push(`CANON-${String(next + i).padStart(3, "0")}`);
      }
      worldUpdates["nextCanonId"] = next + input.allocateCanonIds;
      for (const id of allocatedCanonIds) {
        changes.push({ ts: at, commitId, allocation: id, source: input.source, canonRevisionAfter: revisionTo });
      }
    }
    worldDoc.set(worldUpdates);
    const worldNew = worldDoc.serialize();

    const journal: Journal = {
      commitId,
      phase: "prepared",
      kind: input.kind,
      source: input.source,
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
      at,
      canonRevisionFrom: revisionFrom,
      canonRevisionTo: revisionTo,
      worldJsonBaseHash: sha256(worldRaw),
      worldJsonNewContent: worldNew,
      files,
      changes,
      allocatedCanonIds,
    };

    // ---- prepared ----------------------------------------------------------
    const journalPath = this.abs(`${COMMIT_DIR}/${commitId}.json`);
    await atomicWriteFile(journalPath, JSON.stringify(journal, null, 2));
    hooks.at?.("prepared-written");

    try {
      // snapshots (R-18: outgoing written before the live file is replaced)
      for (const f of files) {
        if (f.historyPrev && f.prevContent !== undefined) {
          await atomicWriteFile(this.abs(f.historyPrev), f.prevContent);
        }
        if (f.historyNew && f.newContent !== undefined) {
          await atomicWriteFile(this.abs(f.historyNew), f.newContent);
        }
      }
      hooks.at?.("snapshots-written");

      // staging
      for (const f of files) {
        if (f.newContent !== undefined) {
          await atomicWriteFile(this.abs(`${COMMIT_DIR}/staging/${commitId}/${f.path}`), f.newContent);
        }
      }
      await atomicWriteFile(this.abs(`${COMMIT_DIR}/staging/${commitId}/world.json`), worldNew);
      hooks.at?.("staged-written");
    } catch (err) {
      if (err instanceof CrashSignal) throw err; // a real kill leaves debris for recover()
      // Still fully in `prepared` — roll back so the world is byte-identical (R-15).
      await this.rollback(journal).catch(() => {});
      throw err;
    }

    // ---- committing: the point of no return --------------------------------
    await atomicWriteFile(journalPath, JSON.stringify({ ...journal, phase: "committing" }, null, 2));
    hooks.at?.("committing-marked");

    await this.rollForward(journal, hooks);
    return { commitId, canonRevision: revisionTo, allocatedCanonIds, versions };
  }

  /** Idempotent completion from `committing` — every step checks recorded hashes. */
  private async rollForward(journal: Journal, hooks: CommitHooks = {}): Promise<void> {
    const staging = (p: string) => this.abs(`${COMMIT_DIR}/staging/${journal.commitId}/${p}`);

    let i = 0;
    for (const f of journal.files) {
      const live = await this.readLive(f.path);
      if (f.action === "delete") {
        if (live !== null) await unlink(toExtendedLength(this.abs(f.path)));
      } else if (live === null || sha256(live) !== f.newHash) {
        await mkdir(toExtendedLength(dirname(this.abs(f.path))), { recursive: true });
        await renameWithRetry(staging(f.path), this.abs(f.path));
      }
      hooks.at?.(`renamed:${i++}`);
    }

    // world.json last — its revision advancing is the world-level signal the commit landed.
    const worldLive = await this.readLive("world.json");
    if (worldLive === null || sha256(worldLive) !== sha256(journal.worldJsonNewContent)) {
      await renameWithRetry(staging("world.json"), this.abs("world.json"));
    }
    hooks.at?.("world-renamed");

    const changesPath = this.abs("changes.jsonl");
    if (!(await hasCommitLine(changesPath, journal.commitId))) {
      await appendChanges(changesPath, journal.changes);
    }
    hooks.at?.("changes-appended");

    const journalPath = this.abs(`${COMMIT_DIR}/${journal.commitId}.json`);
    await atomicWriteFile(journalPath, JSON.stringify({ ...journal, phase: "done" }, null, 2));
    await this.cleanup(journal.commitId);
  }

  /** Roll back a `prepared` commit: remove snapshots and staging; live files were never touched. */
  private async rollback(journal: Journal): Promise<void> {
    for (const f of journal.files) {
      for (const h of [f.historyPrev, f.historyNew]) {
        if (h) await rm(toExtendedLength(this.abs(h)), { force: true }).catch(() => {});
      }
    }
    await this.cleanup(journal.commitId);
  }

  private async cleanup(commitId: string): Promise<void> {
    await rm(toExtendedLength(this.abs(`${COMMIT_DIR}/staging/${commitId}`)), {
      recursive: true,
      force: true,
    }).catch(() => {});
    await rm(toExtendedLength(this.abs(`${COMMIT_DIR}/${commitId}.json`)), { force: true }).catch(() => {});
  }

  /**
   * Recovery on open (R-15): the journal phase decides — roll back from `prepared`, roll
   * forward from `committing`, clean up from `done`. The world lock guarantees at most one
   * journal author, so what is found is never ambiguous.
   */
  async recover(): Promise<Array<{ commitId: string; action: "rolled-back" | "rolled-forward" | "cleaned" }>> {
    const out: Array<{ commitId: string; action: "rolled-back" | "rolled-forward" | "cleaned" }> = [];
    let entries: string[];
    try {
      entries = await readdir(toExtendedLength(this.abs(COMMIT_DIR)));
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      let journal: Journal;
      try {
        journal = JSON.parse(await readFile(toExtendedLength(this.abs(`${COMMIT_DIR}/${entry}`)), "utf8")) as Journal;
      } catch {
        // An unreadable journal can only be a partially written `prepared` — nothing live moved.
        await rm(toExtendedLength(this.abs(`${COMMIT_DIR}/${entry}`)), { force: true }).catch(() => {});
        continue;
      }
      if (journal.phase === "prepared") {
        await this.rollback(journal);
        out.push({ commitId: journal.commitId, action: "rolled-back" });
      } else if (journal.phase === "committing") {
        await this.rollForward(journal);
        out.push({ commitId: journal.commitId, action: "rolled-forward" });
      } else {
        await this.cleanup(journal.commitId);
        out.push({ commitId: journal.commitId, action: "cleaned" });
      }
    }
    // Orphaned staging directories with no journal are pre-`prepared` debris — discard.
    try {
      const staged = await readdir(toExtendedLength(this.abs(`${COMMIT_DIR}/staging`)));
      const journalled = new Set(out.map((o) => o.commitId));
      for (const dir of staged) {
        if (!journalled.has(dir)) {
          await rm(toExtendedLength(this.abs(`${COMMIT_DIR}/staging/${dir}`)), { recursive: true, force: true });
        }
      }
    } catch {
      /* no staging dir */
    }
    return out;
  }
}

/** Shallow, honest field diff for the change line: frontmatter keys plus changed section headings. */
function diffMarkdown(base: MarkdownFile, next: MarkdownFile): string[] {
  const changed = new Set<string>();
  const keys = new Set([...Object.keys(base.data), ...Object.keys(next.data)]);
  for (const k of keys) {
    if (k === "version" || k === "updated") continue;
    if (JSON.stringify(base.data[k]) !== JSON.stringify(next.data[k])) changed.add(k);
  }
  // Sheets have `## ` sections; canon bodies are plain prose — diff whichever this is.
  let baseSections: Map<string, string> | null = null;
  let nextSections: Map<string, string> | null = null;
  try {
    baseSections = new Map(base.sections().map((s) => [s.heading, s.body]));
    nextSections = new Map(next.sections().map((s) => [s.heading, s.body]));
  } catch {
    if (base.body.trim() !== next.body.trim()) changed.add("body");
  }
  if (baseSections && nextSections) {
    for (const [heading, body] of nextSections) {
      if (baseSections.get(heading) !== body) changed.add(sectionSlug(heading));
    }
    for (const heading of baseSections.keys()) {
      if (!nextSections.has(heading)) changed.add(sectionSlug(heading));
    }
  }
  return [...changed];
}

function sectionSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
