import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, stat, statfs } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ArtifactSidecarSchema, ulid, type ArtifactKind, type ArtifactSidecar } from "@arke-studio/contracts";
import { measureMediaInfo, type MediaProbe } from "../media/probe.js";
import { toExtendedLength } from "../world/paths.js";
import { slugify } from "../world/slug.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";

/**
 * Artifact filing (SPEC-015 §2.3): copy in, never reference (D8); dedupe by content hash (D9);
 * sidecar per artifact (D6); original names kept, slugified (D7). Every sidecar write goes
 * through the world's commit primitive; the media copy rides the suppression envelope.
 */

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

/** Merge links into an existing artifact — dedupe keeps one copy, many uses (R-4, D9). */
export async function addLinks(store: WorldStore, artifact: ArtifactSidecar, links: string[]): Promise<ArtifactSidecar> {
  const merged = [...new Set([...artifact.links, ...links])];
  if (merged.length === artifact.links.length) return artifact;
  // Merged onto the sidecar as it is *now*, inside the gate (Codex round 3). Building the
  // replacement from the copy fetched before, while using the latest raw only as a base hash,
  // meant the write succeeded and silently dropped anything added meanwhile -- a measurement the
  // backfill had just recorded, erased by somebody adding a link.
  return await store.gateOp(async () => {
    const raw = await readSidecarRaw(store, artifact.file);
    const current = raw === null ? artifact : (JSON.parse(raw) as ArtifactSidecar);
    const merged2 = { ...current, links: [...new Set([...current.links, ...links])] };
    await writeSidecar(store, merged2, raw);
    return merged2;
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
    const raw = await readSidecarRaw(store, artifact.file);
    const base = raw === null ? artifact : (JSON.parse(raw) as ArtifactSidecar);
    const next = { ...base };
    if (production === null) delete next.production;
    else next.production = production as ArtifactSidecar["production"];
    await writeSidecar(store, next, raw);
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
 * Measure media artifacts filed before anything measured them (#283).
 *
 * Every world that existed before filing learned to measure has audio and video with no
 * `mediaInfo`, and nothing would ever fill it in: the field is written at filing time and those
 * files were filed long ago. Left alone, those worlds keep paying a probe on every export click
 * and their Cut screen can never show a spine timeline at all, because the client has no ffprobe
 * to reach for.
 *
 * So it happens once, on open, in the background. Not during the scan: a world's load is measured
 * against a cold-scan budget and spawning a probe per media artifact inside it would blow that for
 * a number nobody has asked for yet.
 *
 * A measurement is added, never corrected. If a sidecar already carries one it is left exactly as
 * it is -- the bytes cannot have changed, so a second opinion about them would only be a way for
 * two runs of this to disagree.
 */
/**
 * Measure one artifact and record it, if it is not already recorded.
 *
 * Probing happens outside the world's gate and the write inside it, because a probe is slow and a
 * commit must be serialised. The re-read inside the gate is what makes "never re-taken" true
 * against what is on disk rather than against a bundle read before the probe began.
 *
 * Only a *full* measurement is stored (Codex round 4). `measureMediaInfo` answers a
 * duration-only probe with `hasAudio: false`, which is the right conservative reading for a
 * decision made in the moment and the wrong thing to write down: stored, it is indistinguishable
 * from a measured silence, the artifact is never revisited, and spine export refuses a real audio
 * track on a machine that could have measured it properly. A narrow probe therefore records
 * nothing and leaves the question open for a host that can answer it.
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
  // Re-checked after the probe: the world can have closed during the very call that made this
  // slow, and gateOp does not refuse work on a closed store -- it would commit without the lock.
  if (abandoned()) return false;
  return await store.gateOp(async () => {
    if (abandoned()) return false;
    const raw = await readSidecarRaw(store, file);
    if (raw === null) return false;
    try {
      // Parsed, not cast (Codex round 6). A sidecar edited to valid JSON but invalid shape while
      // the probe ran would otherwise be spread into a replacement and written back -- `{}` would
      // reduce the file to nothing but the measurement. The scanner reports malformed sidecars
      // without rewriting them, and this pass has no better claim to overwrite one.
      const parsed = ArtifactSidecarSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return false;
      const current = parsed.data;
      if (current.mediaInfo !== undefined) return false;
      await writeSidecar(store, { ...current, mediaInfo: info }, raw);
      return true;
    } catch {
      // A sidecar that will not parse is a problem the scan already reports; measuring is not the
      // pass that should fix it, and failing here would abandon every artifact after it.
      return false;
    }
  });
}

/**
 * Measure media artifacts filed before anything measured them (#283).
 *
 * Every world that existed before filing learned to measure has audio and video with no
 * `mediaInfo`, and nothing would ever fill it in. Left alone those worlds keep paying a probe on
 * every export click, and their Cut screen can never show a spine timeline at all, the client
 * having no ffprobe to reach for.
 *
 * So it happens once, on open, in the background. Not during the scan: a world's load is measured
 * against a cold-scan budget and a probe per media artifact inside it would blow that for a
 * number nobody has asked for yet.
 */
export async function backfillMediaInfo(
  store: WorldStore,
  probe: MediaProbe,
  /**
   * `signal` stops the pass; `stillOpen` says whether this store is still the app's open world.
   *
   * Both exist because this runs for as long as ffprobe takes and the user is not waiting for it.
   * Without the signal a slow probe held the shutdown drain past the desktop's fifteen-second
   * budget and the last window would not close. Without `stillOpen`, switching worlds mid-probe
   * left this committing to a store whose lock had already been released.
   */
  opts: { signal?: AbortSignal; stillOpen?: () => boolean; onMeasured?: (file: string) => void } = {},
): Promise<number> {
  const { signal, stillOpen, onMeasured } = opts;
  const abandoned = (): boolean => signal?.aborted === true || stillOpen?.() === false;
  let measured = 0;
  for (const artifact of store.getBundle().artifacts) {
    if (abandoned()) break;
    if (artifact.kind !== "audio" && artifact.kind !== "video") continue;
    if (artifact.mediaInfo !== undefined) continue;
    if (await measureInto(store, artifact.file, probe, abandoned)) {
      measured += 1;
      // Per measurement, not per pass (Codex round 5): a world with one readable track and three
      // unreadable ones had its answer on disk immediately and on screen a minute later.
      onMeasured?.(artifact.file);
    }
  }
  return measured;
}
