import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { discoverConversations } from "../world-chat/discover.js";
import { discoverBenchSessions } from "../bench/service.js";
import {
  CLONED_VOICES_PATH,
  parseVoiceLibrary,
  type ClonedVoice,
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  ArtifactSidecarSchema,
  CanonEntrySchema,
  ChangeRecordSchema,
  ChapterFrontmatterSchema,
  type ChapterFrontmatter,
  EpisodeSchema,
  type Episode,
  ProductionSchema,
  ProposalSchema,
  ReferenceKitSchema,
  ReviewDecisionSchema,
  RipplePreviewSchema,
  SceneSchema,
  SeasonSchema,
  SeriesSchema,
  sortScenes,
  type Scene,
  SelectionsSchema,
  ProductionSpineSchema,
  CutFileSchema,
  TakeMediaInfoRecordSchema,
  type TakeMediaInfoRecord,
  SheetSchema,
  RoutingSchema,
  StoryOverviewSchema,
  TakeSchema,
  WorldMetaSchema,
  resolveArtDirection,
  type ArtDirectionOverride,
  type ArtDirectionRecord,
  type ProductionBundle,
  type Sheet,
  type SheetKind,
  type StagedProposal,
  type WorldBundle,
  type WorldMeta,
  type WorldProblem,
} from "@arke-studio/contracts";
import { MarkdownFile, sha256 } from "./text-files.js";
import { readBible } from "./bible.js";
import { projectReview } from "../gate/review.js";
import { SETTLED_FILE } from "../gate/proposals.js";
import { toExtendedLength, toPortable } from "./paths.js";
import { readChanges } from "./change-writer.js";

/**
 * The world scan (SPEC-002 R-2, §2.12): parse and validate every entity, collecting per-file
 * failures instead of dying on the first — for a hand-editable format, one stray character
 * must never make a world inaccessible. Also produces the manifest (path → content hash) that
 * closed-world reconciliation compares against (R-28).
 */

/**
 * The newest world schema this build understands (SPEC-023 R-23, issue #403). Version 2 marks
 * a world that may contain durable conversations (`.conversations`, #70 §4.1) or the new-model
 * production entities (`medium`/`kind`, `series/`, `season.json`, `episodes/`, scene scripts).
 * Worlds are born at 1 and raised lazily by the first write that needs the boundary, so a
 * world that never uses those features stays openable by older builds; a build older than the
 * boundary refuses a version-2 world by name instead of silently dropping strict-parse
 * failures or exporting private conversation state.
 */
export const SUPPORTED_SCHEMA_VERSION = 2;

export class WorldOpenError extends Error {
  constructor(
    message: string,
    readonly reason: "not-a-world" | "schema-newer" | "unreadable",
  ) {
    super(message);
  }
}

export interface ScanResult {
  meta: WorldMeta;
  bundle: WorldBundle;
  problems: WorldProblem[];
  /** Gated text files only — the reconciliation surface. Portable paths. */
  manifest: Record<string, string>;
  /** Hashes of measured take media — for staleness only; never an adoptable text path. */
  mediaManifest: Record<string, string>;
  /** Complete durable change-line count; the bundle carries only the latest 50 records. */
  changeCount: number;
}

/** What counts as an image when reading a candidate off the disk rather than out of a record. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/** The accepted key art, whatever format it came in as. `world-art.png` remains the usual one. */
const KEY_ART_NAMES = new Set([...IMAGE_EXTENSIONS].map((extension) => `world-art${extension}`));

/**
 * The world's accepted key art, or null. Exported because the picker's summaries are built
 * without a full scan — the registry has to answer this question the same way the bundle does,
 * or a card and the screen behind it disagree about which image the world has.
 */
export async function findKeyArt(dir: string): Promise<string | null> {
  return readdir(toExtendedLength(dir))
    .then((entries) => entries.filter((entry) => KEY_ART_NAMES.has(entry.toLowerCase())).sort()[0] ?? null)
    .catch(() => null);
}

/**
 * The one image waiting in a directory, as a portable path — or null for an absent directory,
 * an empty one, or one holding nothing we would serve. Sorted so the answer is stable rather
 * than whatever order the filesystem happened to hand back.
 */
async function firstImageIn(dir: string, relative: string, portable: string): Promise<string | null> {
  return (await imagesIn(dir, relative, portable))[0] ?? null;
}

/**
 * Every image in a landing directory, by name (design 65).
 *
 * Sorted by filename rather than by mtime, so the set is stable across scans and reads back in
 * the order the jobs were numbered — `candidate-1` before `candidate-2`, whichever finished
 * first. A directory that does not exist is an empty set, not an error: nothing is waiting.
 */
async function imagesIn(dir: string, relative: string, portable: string): Promise<string[]> {
  const entries = await readdir(toExtendedLength(join(dir, relative)))
    .then((names) => names.filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase())).sort())
    .catch(() => [] as string[]);
  return entries.map((name) => `${portable}/${name}`);
}

/**
 * Every image staged for a generation to look at, by surface key (design 67).
 *
 * One image per key, and the key is the directory name. A world holding the pre-67 master-look
 * reference is read into the `master-look` key rather than losing it — nothing writes to that
 * path any more, so this fades on its own once the staged image is used or cleared.
 */
async function readStagedReferences(dir: string): Promise<Record<string, string>> {
  const staged: Record<string, string> = {};
  const legacy = await firstImageIn(dir, join("incoming", "master-look-ref"), "incoming/master-look-ref");
  if (legacy !== null) staged["master-look"] = legacy;
  const root = join("incoming", "staged-refs");
  for (const key of await listDir(join(dir, root))) {
    const image = await firstImageIn(dir, join(root, key), `incoming/staged-refs/${key}`);
    if (image !== null) {
      staged[key] = image;
      continue;
    }
    // An artifact-backed slot (issue 305 §4) holds a pointer, never a copy: the staged path is
    // the artifact's own file, so clearing the slot removes this directory and nothing else.
    try {
      const raw = await readFile(toExtendedLength(join(dir, root, key, "artifact.json")), "utf8");
      const parsed = JSON.parse(raw) as { file?: unknown };
      if (typeof parsed.file === "string" && parsed.file.length > 0 && !parsed.file.includes("/") && !parsed.file.includes("\\")) {
        const target = join(dir, "artifacts", parsed.file);
        if (await stat(toExtendedLength(target)).then(() => true, () => false)) {
          staged[key] = `artifacts/${parsed.file}`;
        }
      }
    } catch {
      /* an empty or malformed slot simply stages nothing */
    }
  }
  return staged;
}

const SHEET_DIRS: ReadonlyArray<{ dir: string; type: SheetKind }> = [
  { dir: "characters", type: "character" },
  { dir: "locations", type: "location" },
  { dir: "factions", type: "faction" },
];

/**
 * The media hash a scan checks a measurement against, streamed and cached (Codex round 2).
 *
 * Read whole into a Buffer first, which is fine for a sidecar and ruinous for footage: a world
 * reload happens after routine mutations, so a multi-gigabyte take was re-read and re-hashed into
 * memory on every one of them — stalling the Electron main process to rebuild a snapshot.
 *
 * Streamed so the file never lands in memory at once, and memoised on identity — path, size and
 * mtime — so an unchanged take is hashed once per session rather than once per scan. Identity is
 * a cheap proxy and deliberately not the authority: when it changes the file is re-hashed, and
 * the hash is still what decides whether the measurement is believed.
 */
const mediaHashCache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; hash: string }>();

async function hashMedia(absolutePath: string): Promise<string | null> {
  const path = toExtendedLength(absolutePath);
  let identity;
  try {
    identity = await stat(path);
  } catch {
    return null;
  }
  const cached = mediaHashCache.get(path);
  // ctime as well as size and mtime (Codex round 3): copy, restore and repair tools preserve
  // mtime, and a same-size rewrite with a restored timestamp would otherwise return the previous
  // digest and keep a stale measurement alive. ctime moves whenever the bytes are written.
  // A heuristic still — a filesystem that reports none of the three faithfully would defeat it —
  // but one that costs nothing and closes the case a backup tool actually produces.
  if (
    cached &&
    cached.size === identity.size &&
    cached.mtimeMs === identity.mtimeMs &&
    cached.ctimeMs === identity.ctimeMs
  ) {
    return cached.hash;
  }
  try {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
    const hash = `sha256:${digest.digest("hex")}`;
    mediaHashCache.set(path, { size: identity.size, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs, hash });
    return hash;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(toExtendedLength(path));
    return true;
  } catch {
    return false;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(toExtendedLength(path));
  } catch {
    return [];
  }
}

async function read(path: string): Promise<string> {
  return readFile(toExtendedLength(path), "utf8");
}

/** Read world.json alone — the openability gate (R-1, R-25). */
export async function readWorldMeta(dir: string): Promise<WorldMeta> {
  let raw: string;
  try {
    raw = await read(join(dir, "world.json"));
  } catch {
    throw new WorldOpenError(`${dir} has no world.json`, "not-a-world");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (err) {
    throw new WorldOpenError(`world.json does not parse: ${String(err)}`, "unreadable");
  }
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (typeof schemaVersion === "number" && schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new WorldOpenError(
      `this world was written by a newer Arke Studio (schema ${schemaVersion}; this build supports ${SUPPORTED_SCHEMA_VERSION}). Update the app — the world has not been modified.`,
      "schema-newer",
    );
  }
  return WorldMetaSchema.parse(parsed);
}

/**
 * Take kinds whose generation lands in `candidates/`, and whose take therefore owns a copy of a
 * file this scan would otherwise read back as loose (issue 274).
 *
 * Named as a set rather than tested one kind at a time: this was written when main photos were
 * the only thing that landed there, location views were added to `candidates/` later, and every
 * accepted view came back as an unreviewed candidate waiting for a decision it had already had.
 * The remaining kinds land in `incoming/`, so listing them here would only risk a look's
 * basename suppressing an unrelated upload that happened to match it.
 */
const CANDIDATE_BACKED_TAKE_KINDS: ReadonlySet<string> = new Set(["main-photo", "location-view"]);

export async function scanWorld(dir: string): Promise<ScanResult> {
  const meta = await readWorldMeta(dir);
  const problems: WorldProblem[] = [];
  const manifest: Record<string, string> = {};
  /*
   * Media identities, kept out of the text manifest (Codex round 3).
   *
   * Round 2 put them *in* it so reconciliation could see replaced footage — and the manifest is
   * also where external edits come from, so a changed take offered an Adopt button that reads the
   * whole file as UTF-8. That is the buffering hazard again, moved from the scanner into the
   * adoption path, where it would freeze the coordinator on a gigabyte of video.
   *
   * Compared for staleness, never adopted as text.
   */
  const mediaManifest: Record<string, string> = {};

  const tryParse = async <T>(rel: string, parse: (raw: string) => T): Promise<T | null> => {
    try {
      const raw = await read(join(dir, rel));
      manifest[toPortable(rel)] = sha256(raw);
      return parse(raw);
    } catch (err) {
      problems.push({ path: toPortable(rel), message: (err as Error).message.slice(0, 500) });
      return null;
    }
  };

  manifest["world.json"] = sha256(await read(join(dir, "world.json")));

  // Deliberately outside `tryParse`, so it never joins `manifest`. The manifest is the
  // reconciliation surface for gated files (R-28); the bible is ungated and invites hand-edits,
  // which the store adopts silently rather than reporting (see `adoptBibleIfMoved`).
  const bible = await readBible(dir);

  let artDirectionRecord: ArtDirectionRecord | null = null;
  const artDirectionPath = ART_DIRECTION_PATH;
  if (await exists(join(dir, artDirectionPath))) {
    artDirectionRecord = await tryParse(artDirectionPath, (raw) =>
      ArtDirectionRecordSchema.parse(JSON.parse(raw)),
    );
  }

  // The world's cloned voices (SPEC-022 §2.3). `parseVoiceLibrary` keeps what parses rather than
  // refusing the file, so a hand-edited line costs one voice instead of every voice the world
  // owns — which is also why this does not go through `tryParse`'s all-or-nothing shape. A world
  // with no file simply has none, and that is the normal state until somebody clones something.
  let clonedVoices: ClonedVoice[] = [];
  if (await exists(join(dir, CLONED_VOICES_PATH))) {
    const parsed = await tryParse(CLONED_VOICES_PATH, (raw) => {
      const doc = JSON.parse(raw) as { voices?: unknown };
      const voices = parseVoiceLibrary(doc);
      // Valid JSON whose entries are all unreadable is not an empty library — it is a broken one,
      // and reading it as "nothing was ever cloned" hides the failure SPEC-002 R-2 requires named.
      if (voices.length === 0 && Array.isArray(doc.voices) && doc.voices.length > 0) {
        throw new Error(`${doc.voices.length} voice entries could not be read`);
      }
      return voices;
    });
    clonedVoices = parsed ?? [];
  }

  const sheets: Sheet[] = [];
  for (const { dir: sub, type } of SHEET_DIRS) {
    for (const file of (await listDir(join(dir, sub))).filter((f) => f.endsWith(".md")).sort()) {
      const sheet = await tryParse(`${sub}/${file}`, (raw) => {
        const doc = MarkdownFile.parse(raw);
        return SheetSchema.parse({ ...doc.data, type, sections: doc.sections() });
      });
      if (sheet) sheets.push(sheet);
    }
  }

  const canon = [];
  for (const file of (await listDir(join(dir, "canon"))).filter((f) => f.endsWith(".md")).sort()) {
    const entry = await tryParse(`canon/${file}`, (raw) => {
      const doc = MarkdownFile.parse(raw);
      return CanonEntrySchema.parse({ ...doc.data, body: doc.body.trim() });
    });
    if (entry) canon.push(entry);
  }

  const referenceKits = [];
  const referenceCandidates: Record<string, string[]> = {};
  const referenceTakes = [];
  for (const sheetId of await listDir(join(dir, "references"))) {
    if (await exists(join(dir, "references", sheetId, "kit.json"))) {
      const kit = await tryParse(`references/${sheetId}/kit.json`, (raw) =>
        ReferenceKitSchema.parse(JSON.parse(raw)),
      );
      if (kit) referenceKits.push(kit);
    }
    const candidates = (await listDir(join(dir, "references", sheetId, "candidates")))
      .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
      .sort();
    const sheetTakes = [];
    for (const takeDir of await listDir(join(dir, "references", sheetId, "takes"))) {
      if (!(await exists(join(dir, "references", sheetId, "takes", takeDir, "take.json")))) continue;
      const take = await tryParse(`references/${sheetId}/takes/${takeDir}/take.json`, (raw) =>
        TakeSchema.parse(JSON.parse(raw)),
      );
      if (take) {
        referenceTakes.push(take);
        sheetTakes.push(take);
      }
    }
    // Generated media is copied into its immutable take. The source candidate is staging, not
    // a second creative result, and must not reappear after restart if queue state is absent.
    const generatedSources = new Set(
      sheetTakes
        .filter((take) => CANDIDATE_BACKED_TAKE_KINDS.has(take.kind) && take.jobId !== undefined)
        .map((take) =>
          typeof take.params["sourceCandidate"] === "string"
            ? take.params["sourceCandidate"]
            : take.media
              ? `references/${sheetId}/candidates/${take.media}`
              : undefined,
        )
        .filter((path): path is string => typeof path === "string"),
    );
    const visibleCandidates = candidates
      .map((file) => `references/${sheetId}/candidates/${file}`)
      .filter((path) => !generatedSources.has(path));
    if (visibleCandidates.length > 0) referenceCandidates[sheetId] = visibleCandidates;
  }

  const artifacts = [];
  for (const file of (await listDir(join(dir, "artifacts"))).filter((f) => f.endsWith(".json")).sort()) {
    const sidecar = await tryParse(`artifacts/${file}`, (raw) => ArtifactSidecarSchema.parse(JSON.parse(raw)));
    if (sidecar) artifacts.push(sidecar);
  }

  const productions: ProductionBundle[] = [];
  for (const id of (await listDir(join(dir, "productions"))).sort()) {
    const pdir = join(dir, "productions", id);
    if (!(await exists(join(pdir, "production.json")))) continue;
    const metaDoc = await tryParse(`productions/${id}/production.json`, (raw) => {
      const value = ProductionSchema.parse(JSON.parse(raw));
      if (value.id !== id) throw new Error(`production.json id "${value.id}" does not match directory "${id}"`);
      return value;
    });
    if (!metaDoc) continue;

    const story = (await exists(join(pdir, "story.json")))
      ? await tryParse(`productions/${id}/story.json`, (raw) => StoryOverviewSchema.parse(JSON.parse(raw)))
      : null;
    const routing = (await exists(join(pdir, "routing.json")))
      ? await tryParse(`productions/${id}/routing.json`, (raw) => RoutingSchema.parse(JSON.parse(raw)))
      : null;
    const treatment = (await exists(join(pdir, "story.md")))
      ? (await read(join(pdir, "story.md"))).replace(/\r\n/g, "\n")
      : null;

    // Chapter order (SPEC-012 D3): `order` is the authority, legacy `number` is read when it is
    // absent, and anything unresolvable — a tie, a missing value, a value that is not a positive
    // integer — falls back to filename order. The summary carries the resolved dense sequence, so
    // no display surface has to reapply this rule.
    const chapterEntries: Array<{ file: string; fm: ChapterFrontmatter }> = [];
    for (const file of (await listDir(join(pdir, "chapters"))).filter((f) => f.endsWith(".md")).sort()) {
      const fm = await tryParse(`productions/${id}/chapters/${file}`, (raw) =>
        ChapterFrontmatterSchema.parse(MarkdownFile.parse(raw).data),
      );
      if (fm) chapterEntries.push({ file: file.slice(0, -".md".length), fm });
    }
    const chapterRank = (fm: ChapterFrontmatter): number => {
      const v = fm.order ?? fm.number;
      return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : Infinity;
    };
    chapterEntries.sort((a, b) => chapterRank(a.fm) - chapterRank(b.fm) || (a.file < b.file ? -1 : 1));
    const chapters = chapterEntries.map(({ file, fm }, i) => ({
      id: fm.id,
      file,
      order: i + 1,
      title: fm.title,
      status: fm.status ?? "planned",
      version: fm.version,
      ...(fm.words !== undefined ? { words: fm.words } : {}),
      ...(fm.draws !== undefined ? { draws: fm.draws } : {}),
    }));

    // Scene order (issue #387): explicit `order` wins, the birth number is the fallback, ties
    // break by id — never by filename. The actual on-disk stem is captured beside each scene so
    // no consumer ever reconstructs a path from number and slug.
    const sceneEntries: Array<{ file: string; scene: Scene }> = [];
    const sceneFiles: Record<string, string> = {};
    for (const file of (await listDir(join(pdir, "scenes"))).filter((f) => f.endsWith(".json")).sort()) {
      const scene = await tryParse(`productions/${id}/scenes/${file}`, (raw) => SceneSchema.parse(JSON.parse(raw)));
      if (!scene) continue;
      const stem = file.slice(0, -".json".length);
      if (sceneFiles[scene.id] !== undefined) {
        problems.push({
          path: toPortable(`productions/${id}/scenes/${file}`),
          message: `duplicate scene id ${scene.id} — already carried by ${sceneFiles[scene.id]}.json`,
        });
        continue;
      }
      sceneFiles[scene.id] = stem;
      sceneEntries.push({ file: stem, scene });
    }
    const scenes = sortScenes(sceneEntries.map((e) => e.scene));

    // Episodes (SPEC-023 R-12): explicit order with stem tie-break; stems captured like scenes'.
    const episodeEntries: Array<{ file: string; episode: Episode }> = [];
    const episodeFiles: Record<string, string> = {};
    for (const file of (await listDir(join(pdir, "episodes"))).filter((f) => f.endsWith(".json")).sort()) {
      const episode = await tryParse(`productions/${id}/episodes/${file}`, (raw) => EpisodeSchema.parse(JSON.parse(raw)));
      if (!episode) continue;
      const stem = file.slice(0, -".json".length);
      if (episodeFiles[episode.id] !== undefined) {
        problems.push({
          path: toPortable(`productions/${id}/episodes/${file}`),
          message: `duplicate episode id ${episode.id} — already carried by ${episodeFiles[episode.id]}.json`,
        });
        continue;
      }
      episodeFiles[episode.id] = stem;
      episodeEntries.push({ file: stem, episode });
    }
    episodeEntries.sort((a, b) => a.episode.order - b.episode.order || (a.file < b.file ? -1 : 1));
    const episodes = episodeEntries.map((e) => e.episode);

    const takes = [];
    const takeMediaInfo: ProductionBundle["takeMediaInfo"] = {};
    for (const takeDir of await listDir(join(pdir, "takes"))) {
      if (!(await exists(join(pdir, "takes", takeDir, "take.json")))) continue;
      const take = await tryParse(`productions/${id}/takes/${takeDir}/take.json`, (raw) =>
        TakeSchema.parse(JSON.parse(raw)),
      );
      if (take) takes.push(take);
      // The probe result lives beside take.json, never inside it (#253): a take is the immutable
      // record of what was dispatched and what came back, and a measurement taken afterwards is
      // neither. A take with no sidecar is simply one nobody has measured.
      // Every take, not only those with media (Codex round 3). Guarding on `take.media` meant a
      // valid take whose media never landed kept a leftover malformed sidecar that was neither
      // reported nor in the manifest — contradicting the "only absence passes quietly" contract
      // the previous commit claimed to restore, one line above where it said so.
      if (take) {
        /*
         * One read, and everything tryParse used to give (Codex round 2).
         *
         * Read straight through rather than stat-then-read: most takes have no sidecar, and an
         * existence check on each is a second syscall spent proving a negative — enough to push
         * a 500-take world past its cold-scan budget.
         *
         * But absence is the *only* thing that may pass quietly. A sidecar that is present and
         * malformed is a file somebody has to fix, so it keeps the scanner's per-file error
         * contract; and a sidecar that was read must enter the manifest, or editing one while
         * the world is open changes nothing reconciliation can see and the old duration is
         * served until an unrelated reload.
         */
        const rel = `productions/${id}/takes/${takeDir}/media-info.json`;
        const raw = await readFile(toExtendedLength(join(dir, rel)), "utf8").catch(
          (err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? null : err),
        );
        let record: TakeMediaInfoRecord | null = null;
        if (raw instanceof Error) {
          problems.push({ path: toPortable(rel), message: raw.message.slice(0, 500) });
        } else if (raw !== null) {
          manifest[toPortable(rel)] = sha256(raw);
          try {
            record = TakeMediaInfoRecordSchema.parse(JSON.parse(raw));
          } catch (err) {
            problems.push({ path: toPortable(rel), message: (err as Error).message.slice(0, 500) });
          }
        }
        /*
         * The hash is checked, not merely stored (Codex round 1).
         *
         * `sourceHash` exists so a record that outlived its media is detectable — and nothing
         * detected it, so a replaced or re-landed file kept reporting the old duration as a
         * current measurement. A stale duration is worse than none: the spine would anchor a
         * shot to a window it fits, and the export would find footage of another length.
         *
         * Keyed by the take's own id rather than the directory name, because the snapshot is
         * validated against `TakeIdSchema` — a hand-renamed directory would otherwise put a key
         * in the map that no frame can carry, and the world would stop sending snapshots
         * entirely rather than losing one measurement.
         */
        // `take.media` is an unrestricted string in the schema, so a hand-edited or imported
        // take.json can name `../../..` and make every scan stream a file outside the world.
        // A take's media is a plain filename inside its own directory; anything else is not it.
        const safeMedia = take.media !== undefined && basename(take.media) === take.media && take.media !== "..";
        if (record && take.media && safeMedia) {
          const mediaPath = join(pdir, "takes", takeDir, take.media);
          const actual = await hashMedia(mediaPath);
          if (actual === record.sourceHash) takeMediaInfo[take.id] = record;
          /*
           * The media's identity joins the manifest (Codex round 2).
           *
           * Reconciliation compares manifests, not bundles — so replacing a take's media while
           * the world was open changed nothing the watcher could see, and the stale measurement
           * stayed in the live snapshot until an unrelated rescan or a restart. The manifest is
           * what "did anything change" is asked of, so what changed has to be in it.
           */
          mediaManifest[`productions/${id}/takes/${takeDir}/${take.media}`] = actual ?? "missing";
        }
      }
    }
    takes.sort((a, b) => a.dispatchedAt.localeCompare(b.dispatchedAt));

    let reviews: ProductionBundle["reviews"] = [];
    if (await exists(join(pdir, "reviews.jsonl"))) {
      reviews = (await readChanges(join(pdir, "reviews.jsonl")))
        .map((line) => {
          const r = ReviewDecisionSchema.safeParse(line);
          return r.success ? r.data : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
    }

    const selections = (await exists(join(pdir, "selections.json")))
      ? ((await tryParse(`productions/${id}/selections.json`, (raw) => SelectionsSchema.parse(JSON.parse(raw)))) ?? {})
      : {};

    // No spine is the ordinary case, not a fault: a short film or a dialogue production keeps the
    // scene-order cut it has always had, and absence needs no migration and no rewrite (#253).
    // A spine.json that will not parse also reads as null here — tryParse reports it as a world
    // problem, and a production is better off on the legacy path than on half a timeline.
    const spine = (await exists(join(pdir, "spine.json")))
      ? ((await tryParse(`productions/${id}/spine.json`, (raw) => ProductionSpineSchema.parse(JSON.parse(raw)))) ??
        null)
      : null;

    // cut.json keeps owning dialogue, score and ambience placement; the spine owns the master
    // track alone. Loading it here is what lets the two be mixed in one graph at export.
    const cut = (await exists(join(pdir, "cut.json")))
      ? // Both fallbacks carry every field the schema does: a production with no cut.json — or
        // one whose cut.json no longer parses — must still answer `overlays` with an empty list
        // rather than `undefined`, or every reader crashes on the productions that have none.
        ((await tryParse(`productions/${id}/cut.json`, (raw) => CutFileSchema.parse(JSON.parse(raw)))) ?? {
          audio: [],
          overlays: [],
        })
      : { audio: [], overlays: [] };

    // season.json — the season beside its production (SPEC-023 R-10); null when none.
    const season = (await exists(join(pdir, "season.json")))
      ? await tryParse(`productions/${id}/season.json`, (raw) => SeasonSchema.parse(JSON.parse(raw)))
      : null;

    productions.push({
      meta: metaDoc,
      story,
      season,
      routing,
      treatment,
      chapters,
      scenes,
      sceneFiles,
      episodes,
      episodeFiles,
      takes,
      reviews,
      selections,
      spine,
      cut,
      takeMediaInfo,
    });
  }

  // series/<slug>.json — thin Series records (SPEC-023 R-9). A file that fails to parse is a
  // named problem and the row is dropped; the seasons it referenced remain ordinary productions.
  const series = [];
  for (const file of (await listDir(join(dir, "series"))).filter((f) => f.endsWith(".json")).sort()) {
    const record = await tryParse(`series/${file}`, (raw) => {
      const value = SeriesSchema.parse(JSON.parse(raw));
      const stem = file.slice(0, -".json".length);
      if (value.id !== stem) throw new Error(`series id "${value.id}" does not match file "${stem}"`);
      return value;
    });
    if (record) series.push(record);
  }

  let referenceReviews: WorldBundle["referenceReviews"] = [];
  if (await exists(join(dir, "references", "reviews.jsonl"))) {
    referenceReviews = (await readChanges(join(dir, "references", "reviews.jsonl")))
      .map((line) => {
        const parsed = ReviewDecisionSchema.safeParse(line);
        return parsed.success ? parsed.data : null;
      })
      .filter((review): review is NonNullable<typeof review> => review !== null);
  }

  const proposals: StagedProposal[] = [];
  for (const pid of await listDir(join(dir, ".proposals"))) {
    // A settled proposal is over, whatever is still on disk. `accept` writes the tombstone and
    // then deletes best-effort, so a directory that lost its delete to a busy handle lingers with
    // the decision already recorded — and a founding build, accepting several in quick succession
    // under its own write pressure, leaves a whole set of them. Counting those would ask the
    // author again for a yes already given (SPEC-031 R-25, R-30). The gate's `listOpen` reads the
    // same file; this is the other reader, and every screen renders this snapshot.
    if (await exists(join(dir, ".proposals", pid, SETTLED_FILE))) continue;
    if (!(await exists(join(dir, ".proposals", pid, "proposal.json")))) continue;
    const proposal = await tryParse(`.proposals/${pid}/proposal.json`, (raw) => ProposalSchema.parse(JSON.parse(raw)));
    if (!proposal) continue;
    const ripple = (await exists(join(dir, ".proposals", pid, "ripple.json")))
      ? await tryParse(`.proposals/${pid}/ripple.json`, (raw) => RipplePreviewSchema.parse(JSON.parse(raw)))
      : null;
    const proposedArtDirection =
      proposal.kind === "art-direction"
        ? await tryParse(`.proposals/${pid}/${artDirectionPath}`, (raw) =>
            ArtDirectionRecordSchema.parse(JSON.parse(raw)),
          )
        : null;
    // The review is computed here because this is the one place that has both halves: the
    // proposed file and the base captured beside it.
    const readStaged = async (rel: string): Promise<string | null> =>
      (await exists(join(dir, ".proposals", pid, ...rel.split("/"))))
        ? await readFile(toExtendedLength(join(dir, ".proposals", pid, ...rel.split("/"))), "utf8").catch(() => null)
        : null;
    const proposedByPath = new Map<string, string | null>();
    const baseByPath = new Map<string, string | null>();
    for (const t of proposal.targets) {
      proposedByPath.set(t.path, await readStaged(t.path));
      baseByPath.set(t.path, await readStaged(`_base/${t.path}`));
    }
    const review = projectReview({
      proposal,
      proposed: (path) => proposedByPath.get(path) ?? null,
      base: (path) => baseByPath.get(path) ?? null,
    });

    proposals.push({
      proposal,
      ripple,
      ...(proposedArtDirection ? { artDirection: proposedArtDirection } : {}),
      ...(review.targets.length > 0 ? { review } : {}),
    });
  }
  // Proposals are operational staging, not committed entities. Keep parsing and reporting them,
  // but never offer their dot-prefixed files to the generic external-edit committer.
  for (const path of Object.keys(manifest)) {
    if (path.startsWith(".proposals/")) delete manifest[path];
  }

  const allChanges = await readChanges(join(dir, "changes.jsonl"));
  const changes = allChanges
    .map((line) => {
      const r = ChangeRecordSchema.safeParse(line);
      return r.success ? r.data : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .slice(-50);

  /*
   * The two candidates and the accepted key art, read by listing rather than by stat.
   *
   * Each of these arrives two ways: generated, where the dispatcher writes the name the job
   * asked for, and uploaded, where the file is named for the format its bytes actually carry.
   * A stat on `candidate.png` finds the first and silently loses the second — and the accepted
   * key art stopped being `world-art.png` for the same reason.
   */
  const keyArtCandidates = await imagesIn(dir, join("incoming", "world-image"), "incoming/world-image");
  const masterLookCandidates = await imagesIn(dir, join("incoming", "master-look"), "incoming/master-look");
  const stagedReferences = await readStagedReferences(dir);
  const keyArt = await findKeyArt(dir);

  const resolved = resolveArtDirection(meta, artDirectionRecord);
  const overrides: ArtDirectionOverride[] = [];
  for (const kit of referenceKits) {
    if (!kit.styleOverride?.trim()) continue;
    const sheet = sheets.find((candidate) => candidate.id === kit.sheetId);
    if (!sheet) continue;
    overrides.push({
      id: sheet.id,
      name: sheet.name,
      kind: sheet.type,
      description: kit.styleOverride.trim(),
    });
  }
  for (const production of productions) {
    if (!production.meta.styleOverride?.trim()) continue;
    overrides.push({
      id: production.meta.id,
      name: production.meta.title,
      kind: "production",
      description: production.meta.styleOverride.trim(),
    });
  }
  overrides.sort((a, b) => a.name.localeCompare(b.name));

  const visualAssets = new Set<string>();
  if (resolved.masterLook) visualAssets.add(resolved.masterLook);
  for (const entry of resolved.history) if (entry.masterLook) visualAssets.add(entry.masterLook);
  for (const artifact of artifacts) {
    if (artifact.kind === "image" || artifact.kind === "board") visualAssets.add(`artifacts/${artifact.file}`);
  }
  for (const kit of referenceKits) {
    for (const tile of kit.tiles) if (tile.file) visualAssets.add(`references/${kit.sheetId}/${tile.file}`);
    for (const compilation of kit.compilations) {
      visualAssets.add(`references/${kit.sheetId}/${compilation.file}`);
    }
  }
  for (const take of referenceTakes) {
    if (take.media && take.reference) {
      visualAssets.add(`references/${take.reference.sheetId}/takes/${take.id}/${take.media}`);
    }
  }
  for (const production of productions) {
    for (const scene of production.scenes) {
      if (scene.board) visualAssets.add(`productions/${production.meta.id}/${scene.board.image}`);
    }
    for (const take of production.takes) {
      if (take.kind !== "voice" && take.media) {
        visualAssets.add(`productions/${production.meta.id}/takes/${take.id}/${take.media}`);
      }
    }
  }

  let earlierAcceptedTakes = 0;
  // Counted alongside, because a proposal replacing the current look turns all of these into
  // earlier ones the moment it lands — see acceptedTakesAtCurrentVersion.
  let acceptedTakesAtCurrentVersion = 0;
  const countTake = (take: {
    kind?: string;
    provenance: { artDirectionVersion?: number };
    params?: Record<string, unknown>;
  }): void => {
    // Voice is not a look. A line of audio records no art direction version — nothing about it
    // depends on one — and the fallback below would otherwise read that silence as "made under
    // the current look" and count it among the work a new look strands. The same scan already
    // leaves voice out of visual assets for the same reason.
    if (take.kind === "voice") return;
    const style = take.params?.["artDirection"] as { source?: unknown } | undefined;
    if (style?.source !== undefined && style.source !== "world") return;
    // A visual take with no recorded version is a legacy or uploaded one, and the rest of the app
    // resolves that to the current look — accepting a character reference does exactly this.
    // Dropping it from both counts told somebody less work would be pinned than actually is.
    const at = take.provenance.artDirectionVersion ?? resolved.version;
    if (at < resolved.version) earlierAcceptedTakes += 1;
    else if (at === resolved.version) acceptedTakesAtCurrentVersion += 1;
  };

  const latestReferenceReviews = new Map<string, "accept" | "reject">();
  for (const review of referenceReviews) latestReferenceReviews.set(review.takeId, review.decision);
  for (const take of referenceTakes) {
    if (latestReferenceReviews.get(take.id) !== "accept") continue;
    countTake(take);
  }
  for (const production of productions) {
    const latest = new Map<string, "accept" | "reject">();
    for (const review of production.reviews) latest.set(review.takeId, review.decision);
    for (const take of production.takes) {
      if (latest.get(take.id) !== "accept") continue;
      countTake(take);
    }
  }

  const bundle: WorldBundle = {
    meta,
    bible,
    artDirection: {
      ...resolved,
      reach: {
        visualAssets: visualAssets.size,
        referenceKits: referenceKits.filter((kit) => !kit.styleOverride?.trim()).length,
        productions: productions.filter((production) => !production.meta.styleOverride?.trim()).length,
        earlierAcceptedTakes,
        acceptedTakesAtCurrentVersion,
      },
      overrides,
    },
    keyArtCandidates,
    keyArt,
    masterLookCandidates,
    stagedReferences,
    sheets,
    canon,
    referenceKits,
    referenceCandidates,
    referenceTakes,
    referenceReviews,
    artifacts,
    clonedVoices,
    productions,
    series,
    proposals,
    // Rows only. discoverConversations reads summaries, never transcripts.
    conversations: (await discoverConversations(dir)).summaries,
    // Same split for the bench (issue 305): rows to resume from, never the takes.
    benchSessions: await discoverBenchSessions(dir),
    changes,
    problems,
    externalEdits: [],
  };
  return { meta, bundle, problems, manifest, mediaManifest, changeCount: allChanges.length };
}
