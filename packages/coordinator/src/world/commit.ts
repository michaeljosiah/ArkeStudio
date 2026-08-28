import { mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  BIBLE_PATH,
  deriveArtDirectionDescription,
  isGraphScene,
  migrateLegacyScene,
  newId,
  SceneRecordSchema,
  WorldMetaSchema,
  type SceneRecord,
} from "@arke-studio/contracts";
import {
  carriesSceneFlow,
  graphSceneFor,
  GRAPH_SCENE_SCHEMA_VERSION,
} from "../productions/scene-record.js";
import { atomicWriteFile, renameWithRetry } from "./atomic.js";
import { appendChanges, readChanges } from "./change-writer.js";
import { fromPortable, toExtendedLength } from "./paths.js";
import { JsonFile, MarkdownFile, sha256 } from "./text-files.js";

/**
 * The commit primitive (SPEC-002 §2.5, D1): every mutation to a world goes through here, and
 * atomicity, base-hash verification, history, versioning and the change log live here — once.
 *
 * A commit is a journalled transaction (R-15, master spec §3.5):
 *   planning   — journal and staging on disk; nothing canonical touched
 *   committing — snapshots and staged files may have begun landing
 *   done       — everything renamed and logged; cleanup only
 *
 * Recovery on open rolls back from `planning` (world byte-identical to before) and rolls
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
   * The last committed content when the physical live file is an outside edit. The live bytes
   * still satisfy `baseHash`; this value supplies the version, diff and outgoing history snapshot.
   * Explicit null means the outside edit created the file.
   */
  committedBase?: string | null;
  /** Last committed hash when those bytes are unavailable for an unversioned outside edit. */
  committedBaseHash?: string | null;
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
  /**
   * Raise world.json.schemaVersion to this value in the same transaction (SPEC-023 R-23,
   * issue #403). Only ever raises — a world already at or above the requested version is left
   * alone — so the first feature write that needs the newer boundary carries it, and a retry
   * is a no-op.
   */
  raiseSchemaVersion?: number;
  /**
   * The client request this commit answers (issue #384). Stamped on the change lines so a
   * redelivered request can find the commit that already served it and return the same result
   * instead of creating a second entity.
   */
  requestId?: string;
  /**
   * Fields to set on world.json in the same transaction — the world's own label, never its
   * identity. The folder name is the address every path, artifact and lock hangs off, so
   * nothing here may rename it (SPEC-002's stable-identity rule applied to the world itself).
   */
  worldFields?: Record<string, unknown>;
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
  protocolVersion?: 2;
  commitId: string;
  phase: "planning" | "prepared" | "committing" | "done";
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

/** An interrupted commit still on disk, named but not acted on (see `Committer.pendingRecovery`). */
export interface PendingCommit {
  commitId: string;
  phase: "prepared" | "committing";
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
  | { track: "routing"; production: string }
  | { track: "season"; production: string }
  | { track: "episode"; production: string; file: string }
  | { track: "series"; id: string }
  | { track: "production-meta"; production: string }
  | { track: "art-direction" }
  | { track: "bible" }
  | { track: "unversioned" };

export function classify(path: string): Classified {
  if (path === BIBLE_PATH) return { track: "bible" };
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
  m = /^productions\/([a-z0-9-]+)\/routing\.json$/.exec(path);
  if (m) return { track: "routing", production: m[1]! };
  m = /^productions\/([a-z0-9-]+)\/season\.json$/.exec(path);
  if (m) return { track: "season", production: m[1]! };
  m = /^productions\/([a-z0-9-]+)\/episodes\/([^/]+)\.json$/.exec(path);
  if (m) return { track: "episode", production: m[1]!, file: m[2]! };
  m = /^series\/([a-z0-9-]+)\.json$/.exec(path);
  if (m) return { track: "series", id: m[1]! };
  m = /^productions\/([a-z0-9-]+)\/production\.json$/.exec(path);
  if (m) return { track: "production-meta", production: m[1]! };
  if (path === ART_DIRECTION_PATH) return { track: "art-direction" };
  return { track: "unversioned" };
}

/**
 * Fields the committer writes itself, so a proposal restating them says nothing (R-12, D7).
 *
 * `version` and `updated` are stamped below from the base and the clock, never from what was
 * staged — which is exactly why they cannot be read as evidence of a change. A file whose only
 * difference is the version it declares or the day it was written is a file that says the same
 * thing.
 */
const STAMPED_BY_COMMITTER = ["version", "updated"] as const;

/**
 * Would writing this actually change what the world says?
 *
 * The gate used to ask this by comparing bytes, and bytes answer a different question. Three
 * things move without anything changing: the committer stamps `version` and `updated`, and a
 * document that has been rebuilt rather than edited comes back in canonical key order with YAML
 * arrays in block style where the file on disk had them inline. Any one of them is enough to make
 * an identical sheet look like an edit — so an accept that changed nothing passed the no-op check,
 * committed, cut v2, wrote a history snapshot and logged a commit, over a file whose body was
 * byte-identical to v1 (driven 2026-08-23, `king-s-daughter` / `adaeze-working-name`).
 *
 * Asked of the parsed document instead, which is the form the question is actually about. Parsing
 * failures fall back to the byte comparison: a file this cannot read is one whose meaning it
 * cannot judge, and calling it unchanged on those grounds would drop a real edit — much the worse
 * of the two mistakes.
 */
export function changesAnything(path: string, live: string, proposed: string): boolean {
  if (live === proposed) return false;
  const track = classify(path).track;
  try {
    if (track === "sheet" || track === "chapter" || track === "bible" || track === "canon") {
      const before = MarkdownFile.parse(live);
      const after = MarkdownFile.parse(proposed);
      if (before.body.trim() !== after.body.trim()) return true;
      const keys = new Set([...Object.keys(before.data), ...Object.keys(after.data)]);
      for (const key of STAMPED_BY_COMMITTER) keys.delete(key);
      // Canon's lifecycle stamps are the committer's too, and it decides which of them moves
      // from the transition rather than from the file it was handed.
      if (track === "canon") for (const key of ["introducedAt", "settledAt", "amendedAt"]) keys.delete(key);
      return [...keys].some((k) => JSON.stringify(before.data[k]) !== JSON.stringify(after.data[k]));
    }
    /*
     * A scene is compared as the graph scene each side means (SPEC-029 §3.3 step 2).
     *
     * Two shapes reach this question now, and the honest comparison is not between the files as
     * written but between what each one says once it is a graph: the live scene as it stands or
     * as it would deterministically migrate, and the proposal as itself if it carries a flow, or
     * as the record accepting it would land if it does not.
     *
     * Both halves matter, and both were got wrong before landing here. A legacy amendment — all
     * Arke and the storyboard can still author — over a scene that is already graph-backed must
     * come out equal when it says what the world already says, or it reads as a change forever
     * and can never be settled: the trap the note above records for sheets. And a proposal that
     * carries a flow must be compared with its flow, or a beat, an edge or a node identity that
     * nothing else could have expressed vanishes into the projection and the proposal is retired
     * as a no-op — reviewed, approved, and silently thrown away.
     */
    if (track === "scene") {
      const liveRecord = SceneRecordSchema.parse(JSON.parse(live));
      const proposedRecord = SceneRecordSchema.parse(JSON.parse(proposed));
      const before = isGraphScene(liveRecord) ? liveRecord : migrateLegacyScene(liveRecord);
      const after = isGraphScene(proposedRecord)
        ? proposedRecord
        : graphSceneFor(liveRecord, proposedRecord);
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      keys.delete("version");
      return [...keys].some((k) => JSON.stringify(asFields(before)[k]) !== JSON.stringify(asFields(after)[k]));
    }
    if (
      track === "story" ||
      track === "routing" ||
      track === "season" ||
      track === "episode" ||
      track === "series"
    ) {
      const before = JsonFile.parse(live).value;
      const after = JsonFile.parse(proposed).value;
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      keys.delete("version");
      return [...keys].some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    }
    if (track === "art-direction") {
      // The record the committer rebuilds field by field: the version, the acceptance stamp and
      // the history are its own, and what a proposal actually proposes is the other four.
      const before = ArtDirectionRecordSchema.parse(JSON.parse(live));
      const after = ArtDirectionRecordSchema.parse(JSON.parse(proposed));
      return (
        before.description !== after.description ||
        before.masterLook !== after.masterLook ||
        JSON.stringify(before.audio) !== JSON.stringify(after.audio) ||
        JSON.stringify(before.failureModes) !== JSON.stringify(after.failureModes)
      );
    }
  } catch {
    /* unreadable either side — fall through to the bytes, which already differ */
  }
  return true;
}

const asFields = (record: SceneRecord): Record<string, unknown> =>
  record as unknown as Record<string, unknown>;

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
      if (f.committedBase !== undefined && f.action === "create") {
        throw new CommitPlanError(`${f.path}: a committed base is only valid for an outside edit`);
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
      const base = f.committedBase === undefined ? live : f.committedBase;
      const logicalCreate = f.action === "create" || (f.action === "replace" && f.committedBase === null);
      let newContent: string | null = f.action === "delete" ? null : f.content!;
      let historyPrev: string | null = null;
      let historyNew: string | null = null;
      let fromVersion: number | null = null;
      let toVersion: number | undefined;
      let fieldsChanged: string[] | undefined;

      if (kind.track === "sheet" || kind.track === "chapter" || kind.track === "bible") {
        // The bible rides the sheet track: Markdown, a monotonic version in frontmatter, a full
        // snapshot per version. It is ungated (§3.1, direct authored), so the version and the
        // snapshot are the *only* things standing between an agent edit and lost work — which is
        // why it never passes `preserveVersion`, unlike chapter prose. Every save is restorable.
        const dirPath =
          kind.track === "sheet"
            ? `.history/${kind.collection}/${kind.id}`
            : kind.track === "bible"
              ? ".history/bible"
              : `.history/productions/${kind.production}/chapters/${kind.file}`;
        const baseDoc = base !== null ? MarkdownFile.parse(base) : null;
        fromVersion = baseDoc ? ((baseDoc.data["version"] as number) ?? 1) : null;
        if (f.action !== "delete") {
          const doc = MarkdownFile.parse(newContent!);
          toVersion =
            logicalCreate ? 1 : f.preserveVersion === true ? (fromVersion ?? 1) : (fromVersion ?? 0) + 1; // R-17; SPEC-012 R-5
          doc.setData({ version: toVersion, updated: at.slice(0, 10) });
          newContent = doc.serialize();
          historyNew = `${dirPath}/v${toVersion}.md`;
          fieldsChanged = baseDoc ? diffMarkdown(baseDoc, doc) : undefined;
          versions[f.path] = toVersion;
        }
        if (baseDoc) historyPrev = `${dirPath}/v${fromVersion}.md`;
      } else if (kind.track === "canon") {
        const dirPath = `.history/canon/${kind.id}`;
        const baseDoc = base !== null ? MarkdownFile.parse(base) : null;
        fromVersion = baseDoc ? canonStamp(baseDoc.data) : null;
        if (f.action !== "delete") {
          const doc = MarkdownFile.parse(newContent!);
          // Stamp the lifecycle field the transition implies (R-16).
          if (logicalCreate) {
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
      } else if (
        kind.track === "scene" ||
        kind.track === "story" ||
        kind.track === "routing" ||
        kind.track === "season" ||
        kind.track === "episode" ||
        kind.track === "series"
      ) {
        // Season, episode, and series ride the same JSON version/history machinery the story
        // track proved (SPEC-023 R-17): the committer stamps `version`, snapshots whole files.
        const dirPath =
          kind.track === "series"
            ? `.history/series/${kind.id}`
            : `.history/productions/${kind.production}/${
                kind.track === "scene"
                  ? `scenes/${kind.file}`
                  : kind.track === "episode"
                    ? `episodes/${kind.file}`
                    : kind.track
              }`;
        const baseDoc = base !== null ? JsonFile.parse(base) : null;
        fromVersion = baseDoc ? ((baseDoc.value["version"] as number) ?? 1) : null;
        if (f.action !== "delete") {
          const doc = JsonFile.parse(newContent!);
          toVersion =
            logicalCreate ? 1 : f.preserveVersion === true ? (fromVersion ?? 1) : (fromVersion ?? 0) + 1;
          doc.set({ version: toVersion });
          newContent = doc.serialize();
          historyNew = `${dirPath}/v${toVersion}.json`;
          versions[f.path] = toVersion;
        }
        if (baseDoc) historyPrev = `${dirPath}/v${fromVersion}.json`;
      } else if (kind.track === "art-direction") {
        const baseRecord = base !== null ? ArtDirectionRecordSchema.parse(JSON.parse(base)) : null;
        // Even without a physical record the world has a derived v1 look. The first authored
        // record therefore replaces that logical baseline as v2 rather than being born at v1.
        fromVersion = baseRecord?.version ?? 1;
        historyPrev = baseRecord ? `.history/art-direction/v${fromVersion}.json` : null;
        if (f.action !== "delete") {
          const proposed = ArtDirectionRecordSchema.parse(JSON.parse(newContent!));
          const worldMeta = WorldMetaSchema.parse(worldDoc.value);
          const effectiveFrom = baseRecord?.version ?? 1;
          toVersion = effectiveFrom + 1;
          // Rebuilt field by field, which is why the standing constraints have to be named here
          // too (#244). This is the authoritative author of the record — the version and the
          // history are decided here, not by whatever the proposal staged.
          const previous = baseRecord
            ? {
                version: baseRecord.version,
                description: baseRecord.description,
                ...(baseRecord.masterLook ? { masterLook: baseRecord.masterLook } : {}),
                acceptedAt: baseRecord.acceptedAt,
                audio: baseRecord.audio,
                failureModes: baseRecord.failureModes,
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
            history: [...(baseRecord?.history ?? []), previous],
          });
          newContent = `${JSON.stringify(next, null, 2)}\n`;
          historyNew = `.history/art-direction/v${toVersion}.json`;
          fieldsChanged = [
            ...(baseRecord?.description !== next.description ? ["description"] : []),
            ...(baseRecord?.masterLook !== next.masterLook ? ["master-look"] : []),
            ...(JSON.stringify(baseRecord?.audio) !== JSON.stringify(next.audio) ? ["audio-policy"] : []),
            ...(JSON.stringify(baseRecord?.failureModes ?? []) !== JSON.stringify(next.failureModes)
              ? ["failure-modes"]
              : []),
          ];
          versions[f.path] = toVersion;
        }
      }
      // production-meta and unversioned: change-logged only, no history, no stamps (§2.4.1).
      // production.json is unversioned, so the change line IS its entire history — it has to
      // say which fields moved (issue 389), or an edited aspect leaves an audit line that
      // records only that something happened. `updated` is excluded: every edit moves it, and
      // a field that always changes says nothing.
      if (kind.track === "production-meta" && f.action === "replace" && base !== null && newContent !== null) {
        try {
          const before = JSON.parse(base) as Record<string, unknown>;
          const after = JSON.parse(newContent) as Record<string, unknown>;
          const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
            (key) => key !== "updated" && JSON.stringify(before[key]) !== JSON.stringify(after[key]),
          );
          if (moved.length > 0) fieldsChanged = moved;
        } catch {
          /* an unparseable side leaves the line fieldless, as before */
        }
      }

      changes.push({
        ts: at,
        commitId,
        entity: f.path.replace(/\.(md|json)$/, ""),
        path: f.path,
        contentHashBefore:
          f.committedBaseHash !== undefined ? f.committedBaseHash : base === null ? null : sha256(base),
        contentHashAfter: newContent === null ? null : sha256(newContent),
        ...(f.action === "delete" ? { deleted: true } : {}),
        fromVersion,
        ...(toVersion !== undefined ? { toVersion } : {}),
        ...(fieldsChanged && fieldsChanged.length ? { fieldsChanged } : {}),
        source: input.source,
        canonRevisionAfter: revisionTo,
        ...(input.proposalId ? { proposalId: input.proposalId } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });

      files.push({
        path: f.path,
        action: f.action,
        baseHash: f.baseHash,
        newHash: newContent !== null ? sha256(newContent) : null,
        historyPrev,
        historyNew,
        ...(base !== null ? { prevContent: base } : {}),
        ...(newContent !== null ? { newContent } : {}),
      });
    }

    // ---- world.json: revision, allocation, schema version, updated ---------
    const allocatedCanonIds: string[] = [];
    const worldUpdates: Record<string, unknown> = { updated: at };
    if (touchesCanon) worldUpdates["canonRevision"] = revisionTo;
    /*
     * A commit that lands a graph-backed scene fences the world (SPEC-029 R-9), whoever asked
     * for it and whether or not they thought about it.
     *
     * Derived from the bytes rather than taken from the caller, because the boundary is not an
     * intention — it is a fact about what is now on disk. A build that knows only `shots[]`
     * reads a `flow` scene as a parse failure and opens the world one scene short of itself, so
     * every route by which such a file can appear has to fence it: the migration writer, an
     * accepted proposal, a restore, and the two that would never have thought to — adopting a
     * hand-written graph scene through closed-world reconciliation, and landing a board on a
     * scene that is already one. One rule at the funnel every write passes through beats five
     * callers each remembering.
     */
    const landsGraphScene = files.some(
      (f) => classify(f.path).track === "scene" && f.newContent != null && carriesSceneFlow(f.newContent),
    );
    const raiseSchemaVersion = Math.max(
      input.raiseSchemaVersion ?? 0,
      landsGraphScene ? GRAPH_SCENE_SCHEMA_VERSION : 0,
    );
    if (raiseSchemaVersion > 0) {
      const current = (worldDoc.value["schemaVersion"] as number) ?? 1;
      if (raiseSchemaVersion > current) {
        worldUpdates["schemaVersion"] = raiseSchemaVersion;
        // The audit trail names the boundary crossing: older builds refuse this world from
        // here on, and the log is where "since when?" gets answered.
        changes.push({
          ts: at,
          commitId,
          entity: "world",
          fieldsChanged: ["schemaVersion"],
          fromVersion: current,
          toVersion: raiseSchemaVersion,
          source: input.source,
        });
      }
    }
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
    // The caller's own fields last, so a rename cannot be undone by bookkeeping above it —
    // and `id`, `slug` and `schemaVersion` are refused by name rather than quietly dropped.
    if (input.worldFields) {
      for (const [key, value] of Object.entries(input.worldFields)) {
        if (key === "id" || key === "slug" || key === "schemaVersion" || key === "canonRevision") {
          throw new Error(`world.${key} is not a label and cannot be set this way`);
        }
        worldUpdates[key] = value;
      }
    }
    worldDoc.set(worldUpdates);
    const worldNew = worldDoc.serialize();

    const journal: Journal = {
      protocolVersion: 2,
      commitId,
      phase: "planning",
      kind: input.kind,
      source: input.source,
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
      at,
      canonRevisionFrom: revisionFrom,
      canonRevisionTo: revisionTo,
      worldJsonBaseHash: sha256(worldRaw),
      worldJsonNewContent: worldNew,
      files,
      changes: changes.map((change, commitIndex) => ({ ...change, commitIndex })),
      allocatedCanonIds,
    };

    // ---- planning ----------------------------------------------------------
    const journalPath = this.abs(`${COMMIT_DIR}/${commitId}.json`);
    await atomicWriteFile(journalPath, JSON.stringify(journal, null, 2));
    hooks.at?.("prepared-written");

    try {
      // The planning journal already carries snapshot bytes. Validate every canonical destination
      // now; roll-forward installs the final bytes idempotently after the point of no return.
      const snapshots = this.snapshotPlan(files);
      for (const [path, snapshot] of snapshots) {
        const existing = await this.readLive(path);
        if (existing !== null && !snapshot.allowedExisting.has(sha256(existing))) {
          throw new CommitPlanError(`${path}: history snapshot conflicts with this commit`);
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

      // The first check protects proposal staleness; this one closes the asynchronous staging
      // window before the transaction crosses its point of no return.
      for (const [path, snapshot] of snapshots) {
        const existing = await this.readLive(path);
        if (existing !== null && !snapshot.allowedExisting.has(sha256(existing))) {
          throw new CommitPlanError(`${path}: history snapshot moved while this commit was staged`);
        }
      }
      const moved: CommitStaleError["stale"] = [];
      for (const f of input.files) {
        const live = await this.readLive(f.path);
        const found = live === null ? null : sha256(live);
        if ((f.action === "create" && live !== null) || (f.action !== "create" && found !== f.baseHash)) {
          moved.push({ path: f.path, expected: f.action === "create" ? null : f.baseHash, found });
        }
      }
      const worldNow = await this.readLive("world.json");
      const worldFound = worldNow === null ? null : sha256(worldNow);
      if (worldFound !== journal.worldJsonBaseHash) {
        moved.push({ path: "world.json", expected: journal.worldJsonBaseHash, found: worldFound });
      }
      if (moved.length > 0) throw new CommitStaleError(moved);
    } catch (err) {
      if (err instanceof CrashSignal) throw err; // a real kill leaves debris for recover()
      // Still fully in `planning` — roll back so the world is byte-identical (R-15).
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

    for (const [path, snapshot] of this.snapshotPlan(journal.files)) {
      const existing = await this.readLive(path);
      if (existing !== null && sha256(existing) === sha256(snapshot.content)) continue;
      await atomicWriteFile(this.abs(path), snapshot.content);
    }
    hooks.at?.("snapshots-installed");

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
    const logged = (await readChanges(changesPath)).filter((line) => line.commitId === journal.commitId);
    const missing = journal.changes.filter((change, index) => {
      const commitIndex = (change as { commitIndex?: number }).commitIndex ?? index;
      return !logged.some(
        (line) => line["commitIndex"] === commitIndex || isDeepStrictEqual(line, change),
      );
    });
    await appendChanges(changesPath, missing);
    hooks.at?.("changes-appended");

    const journalPath = this.abs(`${COMMIT_DIR}/${journal.commitId}.json`);
    await atomicWriteFile(journalPath, JSON.stringify({ ...journal, phase: "done" }, null, 2));
    await this.cleanup(journal.commitId);
  }

  /** Roll back a `planning` commit: snapshots and live files were never installed. */
  private async rollback(journal: Journal): Promise<void> {
    await this.cleanup(journal.commitId);
  }

  /** Restore canonical history touched by protocol-v1 `prepared` journals before cleanup. */
  private async rollbackLegacyPrepared(journal: Journal): Promise<void> {
    for (const file of journal.files) {
      if (file.historyPrev && file.prevContent !== undefined) {
        await atomicWriteFile(this.abs(file.historyPrev), file.prevContent);
      }
      if (file.historyNew && file.historyNew !== file.historyPrev) {
        await rm(toExtendedLength(this.abs(file.historyNew)), { force: true }).catch(() => {});
      }
    }
    await this.cleanup(journal.commitId);
  }

  private snapshotPlan(files: JournalFile[]): Map<string, { content: string; allowedExisting: Set<string> }> {
    const snapshots = new Map<string, { content: string; allowedExisting: Set<string> }>();
    for (const file of files) {
      for (const [path, content] of [
        [file.historyPrev, file.prevContent],
        [file.historyNew, file.newContent],
      ] as const) {
        if (path === null || content === undefined) continue;
        const hash = sha256(content);
        const existing = snapshots.get(path);
        if (existing) {
          existing.content = content;
          existing.allowedExisting.add(hash);
        } else {
          snapshots.set(path, { content, allowedExisting: new Set([hash]) });
        }
      }
    }
    return snapshots;
  }

  private async cleanup(commitId: string): Promise<void> {
    await rm(toExtendedLength(this.abs(`${COMMIT_DIR}/staging/${commitId}`)), {
      recursive: true,
      force: true,
    }).catch(() => {});
    await rm(toExtendedLength(this.abs(`${COMMIT_DIR}/${commitId}.json`)), { force: true }).catch(() => {});
  }

  /**
   * What recovery would resolve, without resolving it — for a read-only open, which holds no
   * lock and so must not rename a live file (R-15). It reports the unresolved commit and leaves
   * it for whoever opens the world for writing.
   *
   * A journal too damaged to parse is reported as `prepared`, which is the only phase it can
   * have reached: nothing live moves before the journal is wholly on disk.
   */
  async pendingRecovery(): Promise<PendingCommit[]> {
    const out: PendingCommit[] = [];
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
        out.push({ commitId: entry.slice(0, -".json".length), phase: "prepared" });
        continue;
      }
      // `done` is debris awaiting a sweep, not an unresolved commit — the world is already whole.
      if (journal.phase === "done") continue;
      out.push({
        commitId: journal.commitId,
        phase: journal.phase === "planning" ? "prepared" : journal.phase,
      });
    }
    return out;
  }

  /**
   * Recovery on open (R-15): the journal phase decides — roll back from `prepared`, roll
   * forward from `committing`, clean up from `done`. The world lock guarantees at most one
   * journal author, so what is found is never ambiguous — which is why this runs *after* the
   * lock is acquired and never on a read-only open (see `pendingRecovery`).
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
      if (journal.phase === "planning") {
        await this.rollback(journal);
        out.push({ commitId: journal.commitId, action: "rolled-back" });
      } else if (journal.phase === "prepared") {
        await this.rollbackLegacyPrepared(journal);
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
