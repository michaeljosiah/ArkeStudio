import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat, statfs } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";
import {
  ArtifactSidecarSchema,
  pickableArtifacts,
  ulid,
  type ArtifactGeneration,
  type ArtifactKind,
  type ArtifactSidecar,
  type MediaInfo,
} from "@arke-studio/contracts";
import { measureMediaInfo, type MediaProbe } from "../media/probe.js";
import { atomicWriteFile } from "../world/atomic.js";
import type { CommitInput } from "../world/commit.js";
import { toExtendedLength } from "../world/paths.js";
import { slugify } from "../world/slug.js";
import { sha256 } from "../world/text-files.js";
import { WorldStateStaleError, type WorldStatePrecondition, type WorldStore } from "../world/store.js";

/**
 * Artifact filing (SPEC-015 §2.3): copy in, never reference (D8); dedupe by content hash (D9);
 * sidecar per artifact (D6); original names kept, slugified (D7). Every sidecar write goes
 * through the world's commit primitive; the media copy rides the suppression envelope.
 */

const NEWLINE = String.fromCharCode(10);

export interface ArtifactMutationOptions {
  readonly source?: string;
  readonly requestId?: string;
  readonly precondition?: WorldStatePrecondition;
}

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  ".wav": "audio",
  ".mp3": "audio",
  ".flac": "audio",
  ".ogg": "audio",
  ".m4a": "audio",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".mkv": "video",
  ".md": "document",
  ".txt": "document",
  ".pdf": "document",
  ".docx": "document",
};

export function kindForFile(name: string): ArtifactKind {
  return KIND_BY_EXT[extname(name).toLowerCase()] ?? "other";
}

/**
 * What the attach dialog offers — derived from the kinds above rather than written twice, so
 * the picker and the sidecar can never disagree about what this app can hold. Dropping a file
 * the dialog does not list still files it; the filter is a courtesy, not the gate.
 */
export const ATTACHABLE_EXTENSIONS: readonly string[] = Object.keys(KIND_BY_EXT).map((e) => e.slice(1));

/** The picture rows of the same table — the keyframe lane's upload offers only these. */
export const ATTACHABLE_IMAGE_EXTENSIONS: readonly string[] = Object.entries(KIND_BY_EXT)
  .filter(([, kind]) => kind === "image")
  .map(([ext]) => ext.slice(1));

/** Anything over this states its size and needs explicit consent before copying (R-6). */
export const LARGE_FILE_BYTES = 100 * 1024 * 1024;

export type FileOutcome =
  | { outcome: "filed"; artifact: ArtifactSidecar }
  | { outcome: "deduplicated"; artifact: ArtifactSidecar }
  | { outcome: "needs-consent"; sizeBytes: number; reason: string }
  | { outcome: "refused"; reason: string };

async function writeSidecar(
  store: WorldStore,
  sidecar: ArtifactSidecar,
  baseRaw: string | null,
  options: ArtifactMutationOptions = {},
): Promise<void> {
  await store.commitUnserialised({
    kind: "artifact-file",
    source: options.source ?? "form",
    files: [
      {
        path: `artifacts/${sidecar.file}.json`,
        action: baseRaw === null ? "create" : "replace",
        content: JSON.stringify(sidecar, null, 2) + "\n",
        baseHash: baseRaw === null ? null : sha256(baseRaw),
      },
    ],
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
  });
}

async function readSidecarRaw(store: WorldStore, file: string): Promise<string | null> {
  try {
    return await readFile(toExtendedLength(join(store.dir, "artifacts", `${file}.json`)), "utf8");
  } catch {
    return null;
  }
}

/**
 * The sidecar as it is on disk right now, or null if it is not one.
 *
 * Every writer here rebuilds a whole record from what it reads, so what it reads has to be a whole
 * record. Casting instead of parsing meant a file hand-edited to `{"links":[]}` was spread into a
 * replacement and committed, erasing id, hash and origin -- a rewrite triggered by somebody adding
 * a link (Codex). The scan reports malformed sidecars without rewriting them; nothing here has a
 * better claim, so a writer that cannot read one leaves it alone.
 */
async function currentSidecar(
  store: WorldStore,
  fallback: ArtifactSidecar,
): Promise<{ sidecar: ArtifactSidecar; raw: string | null } | null> {
  const raw = await readSidecarRaw(store, fallback.file);
  // Absent is not malformed: the caller's copy is what a first write is compared against.
  if (raw === null) return { sidecar: fallback, raw: null };
  try {
    const parsed = ArtifactSidecarSchema.safeParse(JSON.parse(raw));
    // The raw bytes travel with it: the base hash has to be of what is actually on disk, not of a
    // re-serialisation that may differ from it by a space.
    return parsed.success ? { sidecar: parsed.data, raw } : null;
  } catch {
    return null;
  }
}

/** A dedup candidate is reusable only while its media still has the hash its metadata claims. */
async function artifactMediaMatches(
  store: WorldStore,
  artifact: ArtifactSidecar,
  expectedHash: string,
): Promise<boolean> {
  if (basename(artifact.file) !== artifact.file || artifact.file === "..") return false;
  const path = join(store.dir, "artifacts", artifact.file);
  const info = await lstat(toExtendedLength(path)).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  const bytes = await readFile(toExtendedLength(path)).catch(() => null);
  return (
    bytes !== null &&
    `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}` === expectedHash
  );
}

/** Merge links into an existing artifact — dedupe keeps one copy, many uses (R-4, D9). */
export async function addLinks(
  store: WorldStore,
  artifact: ArtifactSidecar,
  links: string[],
  options: ArtifactMutationOptions = {},
): Promise<ArtifactSidecar> {
  const merged = [...new Set([...artifact.links, ...links])];
  if (merged.length === artifact.links.length) return artifact;
  // Merged onto the sidecar as it is *now*, inside the gate (Codex round 3). Building the
  // replacement from the copy fetched before, while using the latest raw only as a base hash,
  // meant the write succeeded and silently dropped anything added meanwhile -- a measurement the
  // backfill had just recorded, erased by somebody adding a link.
  return await store.gateOp(async () => {
    const stale = options.precondition?.();
    if (stale) throw new WorldStateStaleError(stale);
    const current = await currentSidecar(store, artifact);
    // Malformed on disk: the scan already reports it, and adding a link is not worth rewriting a
    // file whose id, hash and origin this would replace with whatever happened to parse.
    if (current === null) return artifact;
    const next = { ...current.sidecar, links: [...new Set([...current.sidecar.links, ...links])] };
    await writeSidecar(store, next, current.raw, options);
    return next;
  });
}

/**
 * Re-file an existing artifact under a stated owner (SPEC-020 R-11, R-12).
 *
 * Dedup returns the sidecar that already exists, so without this the escape hatch in §2.5 does
 * not exist: re-filing a production's document at world scope would keep it off the world's shelf
 * and keep `verifyCandidates` refusing its canon, which is exactly what the user was trying to
 * undo. `undefined` means the caller had no opinion and ownership is left alone.
 */
export async function setOwner(
  store: WorldStore,
  artifact: ArtifactSidecar,
  production: string | null | undefined,
  options: ArtifactMutationOptions = {},
): Promise<ArtifactSidecar> {
  if (production === undefined) return artifact;
  const current = artifact.production ?? null;
  if (current === production) return artifact;
  // Same merge-inside-the-gate rule as addLinks: ownership is one field, not a whole record.
  return await store.gateOp(async () => {
    const stale = options.precondition?.();
    if (stale) throw new WorldStateStaleError(stale);
    const base = await currentSidecar(store, artifact);
    if (base === null) return artifact;
    const next = { ...base.sidecar };
    if (production === null) delete next.production;
    else next.production = production as ArtifactSidecar["production"];
    await writeSidecar(store, next, base.raw, options);
    return next;
  });
}

export interface FileInput {
  sourcePath: string;
  /**
   * Measures audio and video as they are filed (#283).
   *
   * `ArtifactSidecarSchema` has carried `mediaInfo` since it was written and nothing ever wrote
   * it, so every consumer fell through to probing the file again at the moment it was needed --
   * export measuring the master on the export click, and the Cut screen unable to measure at all
   * because it has no ffprobe to reach for. An artifact is immutable, so its length and whether
   * it carries audio are true once and true forever; the honest time to record them is when the
   * bytes are copied in.
   */
  mediaProbe?: MediaProbe;
  /**
   * Says this filing's world is no longer the one to commit to.
   *
   * The measurement happens after the gate is released and can outlive the world it belongs to:
   * switching worlds mid-probe closes the store. The store now refuses the eventual write; this
   * predicate also avoids finishing work whose result can no longer be used.
   */
  abandoned?: () => boolean;
  links?: string[];
  importedFrom?: string;
  /** The user has seen the size (R-6). Without it, large files come back needs-consent. */
  allowLarge?: boolean;
  /** Files a replacement recording what it supersedes (R-5). */
  supersedes?: string;
  /**
   * File it as this production's rather than the world's (SPEC-020 R-11). Ownership, not
   * linkage: pass a production here to keep it off the world's shelf, and put it in `links` to
   * say what it is about.
   *
   * Three states. A slug owns it; `null` is the world *explicitly*; `undefined` leaves whatever
   * ownership the artifact already had. Only the caller knows which it means — `importFolder`
   * genuinely has no opinion, while a user re-filing a scoped document from the world's shelf is
   * exercising the escape hatch (§2.5) and must not be read as having no opinion.
   */
  production?: string | null;
  /** Correlation and stale guard supplied by a conversation action; direct controls omit them. */
  mutation?: ArtifactMutationOptions;
}

export async function fileArtifact(store: WorldStore, input: FileInput): Promise<FileOutcome> {
  if (store.isClosed()) return { outcome: "refused", reason: "world is closed" };
  let size: number;
  try {
    size = (await stat(input.sourcePath)).size;
  } catch {
    return { outcome: "refused", reason: `${basename(input.sourcePath)} is not readable` };
  }
  if (size > LARGE_FILE_BYTES && input.allowLarge !== true) {
    return {
      outcome: "needs-consent",
      sizeBytes: size,
      reason: `${basename(input.sourcePath)} is ${(size / (1024 * 1024)).toFixed(0)} MB — copying it into the world is a real commitment of disk`,
    };
  }
  // A full disk fails BEFORE copying, not during (R-6).
  try {
    const fs = await statfs(store.dir);
    const free = fs.bavail * fs.bsize;
    if (free < size * 1.1) {
      return {
        outcome: "refused",
        reason: `not enough disk: ${(size / 1e6).toFixed(0)} MB needed, ${(free / 1e6).toFixed(0)} MB free`,
      };
    }
  } catch {
    /* an unprobeable filesystem does not block filing (unknown ≠ full) */
  }

  const bytes = await readFile(input.sourcePath);
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  const original = basename(input.sourcePath);
  const ext = extname(original).toLowerCase();
  const stem = slugify(original.slice(0, original.length - ext.length)) || "artifact";
  const kind = kindForFile(original);
  const outcome = await store.gateOp<FileOutcome>(async () => {
    const stale = input.mutation?.precondition?.();
    if (stale) throw new WorldStateStaleError(stale);
    // Dedup and allocation happen after this filing owns the same world mutation gate as clone
    // provenance. Neither writer may choose from a bundle that predates the other's media copy.
    const candidates = store.getBundle().artifacts.filter((artifact) => artifact.hash === hash);
    for (const existing of candidates) {
      const current = await currentSidecar(store, existing);
      if (
        current !== null &&
        current.raw !== null &&
        current.sidecar.id === existing.id &&
        current.sidecar.file === existing.file &&
        current.sidecar.hash === hash &&
        (await artifactMediaMatches(store, current.sidecar, hash))
      ) {
        const links = [...new Set([...current.sidecar.links, ...(input.links ?? [])])];
        const next = { ...current.sidecar, links };
        let changed = links.length !== current.sidecar.links.length;
        if (input.production !== undefined && (current.sidecar.production ?? null) !== input.production) {
          changed = true;
          if (input.production === null) delete next.production;
          else next.production = input.production as ArtifactSidecar["production"];
        }
        if (changed) await writeSidecar(store, next, current.raw, input.mutation);
        return { outcome: "deduplicated", artifact: next };
      }
    }

    const taken = new Set(store.getBundle().artifacts.map((artifact) => artifact.file));
    let file = `${stem}${ext}`;
    for (let i = 2; ; i += 1) {
      const media = join(store.dir, "artifacts", file);
      const occupied =
        taken.has(file) ||
        (await lstat(toExtendedLength(media)).catch(() => null)) !== null ||
        (await lstat(toExtendedLength(`${media}.json`)).catch(() => null)) !== null;
      if (!occupied) break;
      file = `${stem}-${i}${ext}`;
    }

    const sidecar: ArtifactSidecar = {
      id: `ar_${ulid()}`,
      kind,
      file,
      hash: hash as ArtifactSidecar["hash"],
      origin: {
        by: "user",
        ...(input.importedFrom !== undefined ? { importedFrom: input.importedFrom } : {}),
      },
      links: [...new Set(input.links ?? [])],
      ...(input.supersedes !== undefined
        ? { supersedes: input.supersedes as ArtifactSidecar["supersedes"] }
        : {}),
      // A new artifact has no ownership to preserve, so `null` and `undefined` mean the same
      // thing here — the world's — and only a slug writes the key.
      ...(typeof input.production === "string"
        ? { production: input.production as ArtifactSidecar["production"] }
        : {}),
      created: store.now(),
    };
    // Stage the bytes that were hashed, not a second read of a source that may have changed.
    await atomicWriteFile(join(store.dir, "artifacts", file), bytes);
    await writeSidecar(store, sidecar, null, input.mutation);
    return { outcome: "filed", artifact: sidecar };
  });
  /*
   * Measured after the gate is released, never inside it (Codex round 4).
   *
   * A probe can take twenty seconds on a file it cannot make sense of. Held inside the world's
   * serialisation envelope that blocks every other edit and every world switch, and inside the
   * message it blocks shutdown past the fifteen seconds the desktop allows before it reports that
   * Arke could not close safely. The artifact is filed either way; the measurement catches up.
   */
  if ((outcome.outcome === "filed" || outcome.outcome === "deduplicated") &&
      outcome.artifact.mediaInfo === undefined && (kind === "audio" || kind === "video")) {
    await measureInto(store, outcome.artifact.file, input.mediaProbe ?? null, input.abandoned);
  }
  return outcome;
}

/** Pickers exclude superseded artifacts — derived, never a flag on the old one (R-5, D10). */
export function pickable(artifacts: ArtifactSidecar[]): ArtifactSidecar[] {
  // The selector itself lives in contracts so the client's reference picker applies the same
  // exclusion without importing coordinator code (issue 305 §4). This export is the seam every
  // existing coordinator caller already uses.
  return pickableArtifacts(artifacts);
}

/**
 * What a generated filing is *about*, per producing surface (issue 305 §7, issue 475).
 *
 * Three things vary and nothing else does: the identity a replay recognises, the name the file
 * takes on the shelf, and what the artifact links to. Written once here so a second producer
 * cannot quietly disagree with the first about any of them.
 */
function generatedIdentity(
  generation: ArtifactGeneration,
  /** The source file's own name, without extension — what a reference is recognisable by. */
  originalStem: string,
): {
  producedBy: string;
  /** Already filed? Compared against sidecars, so it reads the union the same way. */
  isSame: (artifact: ArtifactSidecar) => boolean;
  /** Filename stem, before the collision suffix. */
  stem: string;
  links: string[];
} {
  if (generation.source === "bench") {
    return {
      producedBy: "bench",
      isSame: (artifact) =>
        artifact.generation?.source === "bench" && artifact.generation.takeId === generation.takeId,
      stem: `${slugify(generation.brief.slice(0, 48)) || "bench"}-take-${generation.takeNumber}`,
      // No links: the bench answers to no sheet, and a world-owned artifact needs none.
      links: [],
    };
  }
  return {
    producedBy: "character-reference",
    // The job, not the take: the legacy tile path records no take at all, and one succeeded job
    // made these bytes exactly once however they were then stored.
    isSame: (artifact) =>
      artifact.generation?.source === "character-reference" &&
      artifact.generation.jobId === generation.jobId,
    // The character, then the file the generation actually made — `maren-kest-look-g1-2.png`.
    // The workflow is in the sidecar; a shelf of six `maren-kest-reference-tile-4.png` would
    // tell nobody which angle they were looking at.
    stem: `${slugify(generation.sheetId) || "character"}-${slugify(originalStem) || "reference"}`,
    // Linked to the sheet it is a picture of — linkage, never ownership (SPEC-020): a character's
    // reference belongs to the world's shelf, which is where its history is kept.
    links: [generation.sheetId],
  };
}

/**
 * File a generated result as a world artifact (issue 305 §7, issue 475): trusted system origin,
 * explicit generation provenance, world-owned.
 *
 * Deliberately NOT `fileArtifact`. Content-hash dedup is the wrong rule here twice over: a
 * generated occurrence must not collapse into an earlier user upload of the same bytes, and two
 * generated occurrences with different provenance stay two artifacts — why and how the bytes
 * were made is part of the artifact's identity. The idempotency key is the producing surface's
 * own identity instead: a retry of Keep, or a replayed finalization, returns the artifact it
 * already made rather than a second copy of it.
 */
export async function fileGeneratedArtifact(
  store: WorldStore,
  input: {
    /** Absolute path to the durable copy of the media — a bench take, or a reference take. */
    sourcePath: string;
    generation: ArtifactGeneration;
    mediaProbe?: MediaProbe | null;
    abandoned?: () => boolean;
  },
): Promise<ArtifactSidecar> {
  const bytes = await readFile(toExtendedLength(input.sourcePath));
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;

  const original = basename(input.sourcePath);
  const ext = extname(original).toLowerCase();
  const identity = generatedIdentity(input.generation, basename(original, extname(original)));
  const kind = kindForFile(original);
  const filed = await store.gateOp(async () => {
    const existing = store.getBundle().artifacts.find(identity.isSame);
    if (existing) return { artifact: existing, created: false };

    const taken = new Set(store.getBundle().artifacts.map((artifact) => artifact.file));
    let file = `${identity.stem}${ext}`;
    for (let i = 2; ; i += 1) {
      const media = join(store.dir, "artifacts", file);
      const occupied =
        taken.has(file) ||
        (await lstat(toExtendedLength(media)).catch(() => null)) !== null ||
        (await lstat(toExtendedLength(`${media}.json`)).catch(() => null)) !== null;
      if (!occupied) break;
      file = `${identity.stem}-${i}${ext}`;
    }

    const created: ArtifactSidecar = {
      id: `ar_${ulid()}`,
      kind,
      file,
      hash: hash as ArtifactSidecar["hash"],
      origin: { by: "system", producedBy: identity.producedBy },
      links: identity.links,
      // No `production` key: the world owns it (SPEC-020 R-13). Neither the bench nor a
      // character's reference shelf belongs to one.
      generation: input.generation,
      created: store.now(),
    };
    await atomicWriteFile(join(store.dir, "artifacts", file), bytes);
    await writeSidecar(store, created, null);
    return { artifact: created, created: true };
  });
  if (filed.created && (kind === "audio" || kind === "video")) {
    await measureInto(store, filed.artifact.file, input.mediaProbe ?? null, input.abandoned);
  }
  return filed.artifact;
}

// ---------------------------------------------------------------------------
// Import, stage one (R-9..R-11, D1, D11): filing always succeeds
// ---------------------------------------------------------------------------

const EXCLUDED_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", ".gitignore", ".gitkeep"]);

export interface ImportReport {
  filed: Array<{ name: string; kind: ArtifactKind }>;
  deduplicated: string[];
  excluded: Array<{ name: string; reason: string }>;
  /** Large files awaiting consent — reported, not silently dropped. */
  needsConsent: Array<{ name: string; sizeBytes: number }>;
}

export async function importFolder(
  store: WorldStore,
  sourceDir: string,
  // Threaded through so a folder import measures what a single attach measures (Codex round 1).
  // Filing learned to measure and this path did not, which would have left a whole import
  // unmeasured for no reason a user could see or name.
  mediaProbe?: MediaProbe,
  abandoned?: () => boolean,
): Promise<ImportReport> {
  const report: ImportReport = { filed: [], deduplicated: [], excluded: [], needsConsent: [] };
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      report.excluded.push({ name: rel || dir, reason: "unreadable directory" });
      return;
    }
    for (const entry of entries) {
      // Not merely the measurement (Codex round 6): guarding only the probe left the walk copying
      // and committing the *next* file through a store whose world lock had already been
      // released. An import abandoned halfway is a partial import, which the report already
      // describes; an import writing to a closed world is two stores on one journal.
      if (abandoned?.() === true) return;
      const name = entry.name;
      const relPath = rel ? `${rel}/${name}` : name;
      if (name.startsWith(".") || EXCLUDED_NAMES.has(name.toLowerCase())) {
        // Nobody meant to import .DS_Store — excluded AND reported (R-10, R-11).
        report.excluded.push({ name: relPath, reason: "system or hidden file" });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(join(dir, name), relPath);
        continue;
      }
      const outcome = await fileArtifact(store, {
        ...(mediaProbe !== undefined ? { mediaProbe } : {}),
        ...(abandoned !== undefined ? { abandoned } : {}),
        sourcePath: join(dir, name),
        importedFrom: rel || ".",
      });
      if (outcome.outcome === "filed") report.filed.push({ name: relPath, kind: outcome.artifact.kind });
      else if (outcome.outcome === "deduplicated") report.deduplicated.push(relPath);
      else if (outcome.outcome === "needs-consent")
        report.needsConsent.push({ name: relPath, sizeBytes: outcome.sizeBytes });
      else report.excluded.push({ name: relPath, reason: outcome.reason });
    }
  };
  await walk(sourceDir, "");
  return report;
}

/**
 * Measure one artifact and record it, if it is not already recorded.
 *
 * Probing happens outside the world's gate and the write inside it. A probe can take twenty
 * seconds on a file it cannot make sense of, and holding the serialisation envelope across that
 * blocks every other edit, every world switch, and shutdown itself. The re-read inside the gate
 * is what makes "recorded once" true against what is on disk rather than against a copy fetched
 * before the probe began.
 *
 * `abandoned` stops needless work when the measurement outlives the world it belongs to. The
 * store itself refuses the write once close begins, so this predicate is an optimisation rather
 * than the lock-safety boundary.
 *
 * Only a full measurement is stored. `measureMediaInfo` answers a duration-only probe with
 * `hasAudio: false`, which is the right conservative reading for a decision made in the moment
 * and the wrong thing to write down: stored, it cannot be told from a measured silence, and spine
 * export would refuse a real audio track on a machine that could have measured it properly.
 */
async function measureInto(
  store: WorldStore,
  file: string,
  probe: MediaProbe | null,
  abandoned: () => boolean = () => false,
): Promise<boolean> {
  if (!probe?.info) return false;
  const info = await measureMediaInfo(store, `artifacts/${file}`, probe);
  if (info === null) return false;
  // Re-checked after the probe: the world can have closed during the very call that made this slow.
  if (abandoned()) return false;
  return await store
    .gateOp(async () => {
      if (abandoned()) return false;
      const raw = await readSidecarRaw(store, file);
      if (raw === null) return false;
      // Parsed, not cast: a sidecar edited to valid JSON of the wrong shape while the probe ran
      // would otherwise be spread into a replacement and written back. The scanner reports
      // malformed sidecars without rewriting them, and this has no better claim to overwrite one.
      const parsed = ArtifactSidecarSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.mediaInfo !== undefined) return false;
      await writeSidecar(store, { ...parsed.data, mediaInfo: info }, raw);
      return true;
    })
    .catch(() => false);
}

/**
 * Measure media artifacts filed before anything measured them (issue 283).
 *
 * Every world that existed before filing learned to measure has audio and video with no
 * `mediaInfo`, and nothing would ever fill it in: the field is written at filing time and those
 * files were filed long ago. Left alone, those worlds keep paying a probe on every export click,
 * and their Exports screen can only say the track is unmeasured — the client has no ffprobe to
 * reach for.
 *
 * It runs once, on open, in the background. Not during the scan: a world's load is measured
 * against a cold-scan budget, and a probe per media artifact inside it would blow that for a
 * number nobody has asked for yet.
 *
 * Nothing waits for this. `signal` and `stillOpen` stop it between files, and `WorldStore.gateOp`
 * refuses a closing world regardless — the hard invariant lives there now, so these are about not
 * doing pointless work rather than about safety. A measurement lost to a shutdown or a world
 * switch is simply taken again on the next open.
 */
/** Committed in bounded batches so an interrupted pass keeps what it already learned. */
const BACKFILL_BATCH = 8;

/** One signal that aborts when either does. `AbortSignal.any` is newer than this repo's engines. */
function bothOf(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const merged = new AbortController();
  if (a.aborted || b.aborted) {
    merged.abort();
    return merged.signal;
  }
  const stop = (): void => merged.abort();
  a.addEventListener("abort", stop, { once: true });
  b.addEventListener("abort", stop, { once: true });
  return merged.signal;
}

/**
 * Whether a staged artifact really is a file inside `artifacts/`.
 *
 * The name is checked lexically first, but a symlink passes that and ffprobe follows it, so the
 * resolved path is compared against the resolved directory. A world can be imported from
 * anywhere and this pass runs on open, so anything it reads is something nobody asked it to read.
 */
async function insideArtifacts(store: WorldStore, file: string): Promise<boolean> {
  const dir = join(store.dir, "artifacts");
  try {
    const [root, target] = await Promise.all([
      realpath(toExtendedLength(dir)),
      realpath(toExtendedLength(join(dir, file))),
    ]);
    return target === join(root, basename(target)) && target.startsWith(root + sep);
  } catch {
    return false;
  }
}

export async function backfillMediaInfo(
  store: WorldStore,
  probe: MediaProbe,
  opts: {
    signal?: AbortSignal;
    stillOpen?: () => boolean;
    onMeasured?: (files: readonly string[]) => void;
  } = {},
): Promise<{ measured: number; deferred: boolean }> {
  const { signal, stillOpen, onMeasured } = opts;
  // `isClosed` as well as the caller's two: a world can begin closing without this pass's owner
  // hearing about it — archiving closes the store itself — and the files after that one are work
  // whose every write is already refused.
  const abandoned = (): boolean => signal?.aborted === true || stillOpen?.() === false || store.isClosed();
  if (!probe.info) return { measured: 0, deferred: false };

  /*
   * The probe is cancelled by the store's own close, not only by this pass's signal (issue 288).
   *
   * Between files this pass stops on either signal; *inside* a file it is a child process holding
   * the world open, and archiving closes the store and then renames the folder. Combining the two
   * here means the close that precedes the rename kills the probe as a side effect — no caller
   * has to know which world's pass is running, which is what made every version of that
   * bookkeeping in the coordinator go wrong.
   *
   * Combined by hand rather than with `AbortSignal.any`, which arrived in Node 20.3 while this
   * repo's engines declare 20.0. On 20.0-20.2 the call throws, the coordinator's `startBackfill`
   * swallows the rejection, and the result is a build that quietly never measures legacy media —
   * the exact failure this pass exists to fix, hidden behind the mechanism meant to make it safe.
   */
  const probeOpts = { signal: bothOf(signal, store.closingSignal) };

  /*
   * Probe outside the gate, write in batches (Codex rounds 1 and 2).
   *
   * Measuring file by file cost two full world rescans each -- the commit rescans the paths it
   * touched and `gateOp` rescans everything in its `finally` -- so forty legacy tracks ran forty
   * whole-world scans under the serialisation gate, blocking ordinary edits. Batching fixed that
   * and introduced the opposite fault: a pass interrupted before the end threw away every
   * measurement it had taken, and a world nobody keeps open for the full cumulative probe time
   * would restart from the first file forever and never finish. Bounded batches keep both
   * properties -- few rescans, and progress that survives being interrupted.
   */
  /*
   * Sidecars a person has been asked to reconcile are left alone (Codex rounds 4 and 5).
   *
   * A sidecar edited while the world was closed appears in `externalEdits` for explicit adoption.
   * Rewriting it here -- normalising its bytes and recording an app-owned change -- would adopt
   * part of somebody's edit on their behalf while the screen still shows it as pending, and their
   * later Adopt would apply to a file this pass had already rewritten.
   *
   * Read fresh each time rather than captured once. A pass runs for as long as its probes take,
   * and in that time an edit can appear (so a snapshot from before would rewrite it) or be
   * adopted (so a snapshot from before would skip a file that is now perfectly measurable, and
   * nothing restarts the pass for the rest of the session).
   */
  const isPending = (file: string): boolean =>
    store.getBundle().externalEdits.some((edit) => edit.path === `artifacts/${file}.json`);
  /**
   * The bytes the sidecar describes, or nothing (Codex round 7).
   *
   * Size and modification time proved only that nothing changed *during* the probe. They said
   * nothing about whether the file was already something other than what the sidecar records --
   * media replaced while the world was closed is not tracked as an external edit, so it would
   * have been measured and the measurement stored against a hash describing different bytes.
   *
   * Hashing answers both questions with one check and no window between them: if the media still
   * hashes to what the sidecar says, it is the file the sidecar is about, and it was that file
   * when this read it. The cost is one extra read of a file the probe is reading anyway, once,
   * for a migration that happens once.
   */
  const matchesSidecar = async (file: string, expected: string): Promise<boolean> => {
    try {
      const bytes = await readFile(toExtendedLength(join(store.dir, "artifacts", file)));
      return `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}` === expected;
    } catch {
      return false;
    }
  };

  let measured = 0;
  let attempted = 0;
  let batch: Array<{ file: string; info: MediaInfo; hash: string }> = [];
  /** Set when something was passed over for reconciliation, so the pass is not counted as done. */
  let deferred = false;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const pendingBatch = batch;
    batch = [];
    const written = await store
      .gateOp(async () => {
        // Rechecked inside the gate: the callback can have queued behind another operation and
        // shutdown can abort while it waits. The store refuses a *closed* world, but it is not
        // closed until late in stop(), so without this the whole batch would still be written
        // and rescanned -- making shutdown wait on work deliberately left out of its drain.
        if (abandoned()) return [];
        const files: CommitInput["files"] = [];
        const names: string[] = [];
        for (const { file, info, hash } of pendingBatch) {
          // The media has to be the bytes the sidecar describes, not merely a file with its name.
          if (!(await matchesSidecar(file, hash))) continue;
          // Asked again inside the gate: an edit can arrive while a slow probe runs, and
          // committing over it here would make its bytes the rescan's new baseline -- quietly
          // resolving a staleness the app was about to raise.
          if (isPending(file)) continue;
          const raw = await readSidecarRaw(store, file);
          if (raw === null) continue;
          let current: ArtifactSidecar;
          try {
            const parsed = ArtifactSidecarSchema.safeParse(JSON.parse(raw));
            if (!parsed.success) continue;
            current = parsed.data;
          } catch {
            continue;
          }
          if (current.mediaInfo !== undefined) continue;
          files.push({
            path: `artifacts/${file}.json`,
            action: "replace",
            content: JSON.stringify({ ...current, mediaInfo: info }, null, 2) + NEWLINE,
            baseHash: sha256(raw),
          });
          names.push(file);
        }
        if (files.length === 0) return [];
        await store.commitUnserialised({ kind: "artifact-file", source: "form", files });
        return names;
      })
      .catch(() => [] as string[]);
    measured += written.length;
    // Once per committed batch, not once per file (Codex round 4). The coordinator's callback
    // ignores the name and broadcasts a whole-world snapshot, so eight measurements in one commit
    // meant eight identical snapshots and eight state folds for a single change on disk.
    if (written.length > 0) onMeasured?.(written);
  };

  for (const artifact of store.getBundle().artifacts) {
    if (abandoned()) break;
    if (artifact.kind !== "audio" && artifact.kind !== "video") continue;
    if (artifact.mediaInfo !== undefined) continue;
    /*
     * The filename must be a filename (Codex round 2).
     *
     * `ArtifactSidecarSchema` accepts any non-empty string, so a hand-edited or imported sidecar
     * naming `../../outside.mp3` resolves out of the world -- and this pass runs automatically on
     * open, so merely opening such a world would read arbitrary local media and hold it open for
     * the length of a probe. A sidecar that names something other than a file in `artifacts/` is
     * the scan's problem to report, not this pass's to follow.
     */
    if (basename(artifact.file) !== artifact.file || artifact.file === "..") continue;
    /*
     * And the real path has to land inside artifacts/ too (Codex round 3).
     *
     * `basename` stops `../../outside.mp3`; it does nothing about `foo.mp3` being a symlink to
     * somewhere else, which ffprobe follows. An imported world can carry one, and this pass runs
     * on open, so the read would be unsolicited either way.
     */
    if (isPending(artifact.file)) {
      // Skipped, not finished with: nothing revisits it and nothing restarts the pass, so the
      // caller is told this world still has work rather than being marked as attempted.
      deferred = true;
      continue;
    }
    if (!(await insideArtifacts(store, artifact.file))) continue;
    // Rechecked after that await: on a slow or network-backed world the containment check is
    // itself I/O, and starting a fresh twenty-second probe against a world that has since closed
    // is the one thing this pass is trying not to do.
    if (abandoned()) break;
    // Last check before a twenty-second probe: the containment lookup above is filesystem I/O
    // and the world can close inside it.
    if (abandoned()) break;
    attempted += 1;
    const info = await measureMediaInfo(store, `artifacts/${artifact.file}`, probe, probeOpts);
    if (info !== null) batch.push({ file: artifact.file, info, hash: artifact.hash });
    /*
     * Flushed on attempts, not successes (Codex round 3): one readable track followed by a run of
     * unreadable ones left its measurement sitting in memory through twenty seconds of timeout
     * each, which is the opposite of publishing as they land.
     */
    if (batch.length >= BACKFILL_BATCH || attempted >= BACKFILL_BATCH) {
      attempted = 0;
      await flush();
    }
  }
  await flush();
  return { measured, deferred };
}
