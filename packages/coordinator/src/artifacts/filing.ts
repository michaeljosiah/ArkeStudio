import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, stat, statfs } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ulid, type ArtifactKind, type ArtifactSidecar } from "@arke-studio/contracts";
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
  const next = { ...artifact, links: merged };
  const raw = await readSidecarRaw(store, artifact.file);
  await store.gateOp(async () => writeSidecar(store, next, raw));
  return next;
}

export interface FileInput {
  sourcePath: string;
  links?: string[];
  importedFrom?: string;
  /** The user has seen the size (R-6). Without it, large files come back needs-consent. */
  allowLarge?: boolean;
  /** Files a replacement recording what it supersedes (R-5). */
  supersedes?: string;
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
  const existing = store.getBundle().artifacts.find((a) => a.hash === hash);
  if (existing) {
    const merged = await addLinks(store, existing, input.links ?? []);
    return { outcome: "deduplicated", artifact: merged };
  }

  const original = basename(input.sourcePath);
  const ext = extname(original).toLowerCase();
  const stem = slugify(original.slice(0, original.length - ext.length)) || "artifact";
  const taken = new Set(store.getBundle().artifacts.map((a) => a.file));
  let file = `${stem}${ext}`;
  for (let i = 2; taken.has(file); i++) file = `${stem}-${i}${ext}`;

  const sidecar: ArtifactSidecar = {
    id: `ar_${ulid()}`,
    kind: kindForFile(original),
    file,
    hash: hash as ArtifactSidecar["hash"],
    origin: { by: "user", ...(input.importedFrom !== undefined ? { importedFrom: input.importedFrom } : {}) },
    links: [...new Set(input.links ?? [])],
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes as ArtifactSidecar["supersedes"] } : {}),
    created: store.now(),
  };
  await store.gateOp(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(toExtendedLength(join(store.dir, "artifacts")), { recursive: true });
    await copyFile(toExtendedLength(input.sourcePath), toExtendedLength(join(store.dir, "artifacts", file)));
    await writeSidecar(store, sidecar, null);
  });
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

export async function importFolder(store: WorldStore, sourceDir: string): Promise<ImportReport> {
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
