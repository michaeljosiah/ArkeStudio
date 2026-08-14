import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, stat, statfs } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ArtifactSidecarSchema, ulid, type ArtifactKind, type ArtifactSidecar, type MediaInfo } from "@arke-studio/contracts";
import { measureMediaInfo, type MediaProbe } from "../media/probe.js";
import type { CommitInput } from "../world/commit.js";
import { toExtendedLength } from "../world/paths.js";
import { slugify } from "../world/slug.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";

/**
 * Artifact filing (SPEC-015 §2.3): copy in, never reference (D8); dedupe by content hash (D9);
 * sidecar per artifact (D6); original names kept, slugified (D7). Every sidecar write goes
 * through the world's commit primitive; the media copy rides the suppression envelope.
 */

const NEWLINE = String.fromCharCode(10);

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  ".wav": "audio", ".mp3": "audio", ".flac": "audio", ".ogg": "audio", ".m4a": "audio",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
  ".mp4": "video", ".mov": "video", ".webm": "video", ".mkv": "video",
  ".md": "document", ".txt": "document", ".pdf": "document",
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

/** Anything over this states its size and needs explicit consent before copying (R-6). */
export const LARGE_FILE_BYTES = 100 * 1024 * 1024;

export type FileOutcome =
  | { outcome: "filed"; artifact: ArtifactSidecar }
  | { outcome: "deduplicated"; artifact: ArtifactSidecar }
  | { outcome: "needs-consent"; sizeBytes: number; reason: string }
  | { outcome: "refused"; reason: string };

async function writeSidecar(store: WorldStore, sidecar: ArtifactSidecar, baseRaw: string | null): Promise<void> {
  await store.commitUnserialised({
    kind: "artifact-file",
    source: "form",
    files: [
      {
        path: `artifacts/${sidecar.file}.json`,
        action: baseRaw === null ? "create" : "replace",
        content: JSON.stringify(sidecar, null, 2) + "\n",
        baseHash: baseRaw === null ? null : sha256(baseRaw),
      },
    ],
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

/** Merge links into an existing artifact — dedupe keeps one copy, many uses (R-4, D9). */
export async function addLinks(store: WorldStore, artifact: ArtifactSidecar, links: string[]): Promise<ArtifactSidecar> {
  const merged = [...new Set([...artifact.links, ...links])];
  if (merged.length === artifact.links.length) return artifact;
  // Merged onto the sidecar as it is *now*, inside the gate (Codex round 3). Building the
  // replacement from the copy fetched before, while using the latest raw only as a base hash,
  // meant the write succeeded and silently dropped anything added meanwhile -- a measurement the
  // backfill had just recorded, erased by somebody adding a link.
  return await store.gateOp(async () => {
    const current = await currentSidecar(store, artifact);
    // Malformed on disk: the scan already reports it, and adding a link is not worth rewriting a
    // file whose id, hash and origin this would replace with whatever happened to parse.
    if (current === null) return artifact;
    const next = { ...current.sidecar, links: [...new Set([...current.sidecar.links, ...links])] };
    await writeSidecar(store, next, current.raw);
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
): Promise<ArtifactSidecar> {
  if (production === undefined) return artifact;
  const current = artifact.production ?? null;
  if (current === production) return artifact;
  // Same merge-inside-the-gate rule as addLinks: ownership is one field, not a whole record.
  return await store.gateOp(async () => {
    const base = await currentSidecar(store, artifact);
    if (base === null) return artifact;
    const next = { ...base.sidecar };
    if (production === null) delete next.production;
    else next.production = production as ArtifactSidecar["production"];
    await writeSidecar(store, next, base.raw);
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
   * switching worlds mid-probe closes the store, and gateOp does not refuse work on a closed
   * store -- it commits without the lock (Codex round 5). The backfill has carried this guard
   * since round 3; filing needed the same one and was left with a predicate that never fired.
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
}

export async function fileArtifact(store: WorldStore, input: FileInput): Promise<FileOutcome> {
  let size: number;
  try {
    size = (await stat(input.sourcePath)).size;
  } catch {
    return { outcome: "refused", reason: `${input.sourcePath} is not readable` };
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
      return { outcome: "refused", reason: `not enough disk: ${(size / 1e6).toFixed(0)} MB needed, ${(free / 1e6).toFixed(0)} MB free` };
    }
  } catch {
    /* an unprobeable filesystem does not block filing (unknown ≠ full) */
  }

  const bytes = await readFile(input.sourcePath);
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;

  // Dedup by content (R-4): same content filed twice is one artifact with more links.
  //
  // One copy on disk means one owner, so a re-filing that states an owner moves it rather than
  // making a second artifact — that statement is the escape hatch of SPEC-020 §2.5, and silence
  // is not a statement. A caller with no opinion (`importFolder`) leaves ownership untouched.
  const existing = store.getBundle().artifacts.find((a) => a.hash === hash);
  if (existing) {
    const linked = await addLinks(store, existing, input.links ?? []);
    const owned = await setOwner(store, linked, input.production);
    return { outcome: "deduplicated", artifact: owned };
  }

  const original = basename(input.sourcePath);
  const ext = extname(original).toLowerCase();
  const stem = slugify(original.slice(0, original.length - ext.length)) || "artifact";
  const taken = new Set(store.getBundle().artifacts.map((a) => a.file));
  let file = `${stem}${ext}`;
  for (let i = 2; taken.has(file); i++) file = `${stem}-${i}${ext}`;

  const kind = kindForFile(original);
  const sidecar: ArtifactSidecar = {
    id: `ar_${ulid()}`,
    kind,
    file,
    hash: hash as ArtifactSidecar["hash"],
    origin: { by: "user", ...(input.importedFrom !== undefined ? { importedFrom: input.importedFrom } : {}) },
    links: [...new Set(input.links ?? [])],
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes as ArtifactSidecar["supersedes"] } : {}),
    // A new artifact has no ownership to preserve, so `null` and `undefined` mean the same
    // thing here — the world's — and only a slug writes the key.
    ...(typeof input.production === "string"
      ? { production: input.production as ArtifactSidecar["production"] }
      : {}),
    created: store.now(),
  };
  await store.gateOp(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(toExtendedLength(join(store.dir, "artifacts")), { recursive: true });
    await copyFile(toExtendedLength(input.sourcePath), toExtendedLength(join(store.dir, "artifacts", file)));
    await writeSidecar(store, sidecar, null);
  });
  /*
   * Measured after the gate is released, never inside it (Codex round 4).
   *
   * A probe can take twenty seconds on a file it cannot make sense of. Held inside the world's
   * serialisation envelope that blocks every other edit and every world switch, and inside the
   * message it blocks shutdown past the fifteen seconds the desktop allows before it reports that
   * Arke could not close safely. The artifact is filed either way; the measurement catches up.
   */
  if (kind === "audio" || kind === "video") {
    await measureInto(store, file, input.mediaProbe ?? null, input.abandoned);
  }
  return { outcome: "filed", artifact: sidecar };
}

/** Pickers exclude superseded artifacts — derived, never a flag on the old one (R-5, D10). */
export function pickable(artifacts: ArtifactSidecar[]): ArtifactSidecar[] {
  const superseded = new Set(artifacts.map((a) => a.supersedes).filter((s): s is string => s !== undefined));
  return artifacts.filter((a) => !superseded.has(a.id));
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
      else if (outcome.outcome === "needs-consent") report.needsConsent.push({ name: relPath, sizeBytes: outcome.sizeBytes });
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
 * `abandoned` is not optional in practice: the measurement outlives the gate, so it can outlive
 * the world it belongs to. Switching worlds mid-probe closes the store, and gateOp does not
 * refuse work on a closed one -- it commits without the world's lock, and reopening that world
 * leaves two stores writing one journal.
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
  return await store.gateOp(async () => {
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
  }).catch(() => false);
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

export async function backfillMediaInfo(
  store: WorldStore,
  probe: MediaProbe,
  opts: { signal?: AbortSignal; stillOpen?: () => boolean; onMeasured?: (file: string) => void } = {},
): Promise<number> {
  const { signal, stillOpen, onMeasured } = opts;
  const abandoned = (): boolean => signal?.aborted === true || stillOpen?.() === false;
  if (!probe.info) return 0;

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
  let measured = 0;
  let batch: Array<{ file: string; info: MediaInfo }> = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const pending = batch;
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
        for (const { file, info } of pending) {
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
    for (const file of written) onMeasured?.(file);
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
    const info = await measureMediaInfo(store, `artifacts/${artifact.file}`, probe);
    if (info === null) continue;
    batch.push({ file: artifact.file, info });
    if (batch.length >= BACKFILL_BATCH) await flush();
  }
  await flush();
  return measured;
}
