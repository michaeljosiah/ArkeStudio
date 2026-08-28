import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

export function assertSha256(path, expected, label) {
  const actual = sha256(path);
  if (actual !== expected.toUpperCase()) throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual}`);
}

export function peArchitecture(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error(`${path} is not a PE executable`);
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 6 > bytes.length || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error(`${path} has no PE header`);
  const machine = bytes.readUInt16LE(pe + 4);
  if (machine === 0x8664) return "x64";
  if (machine === 0xaa64) return "arm64";
  throw new Error(`${path} has unsupported PE machine 0x${machine.toString(16)}`);
}

export function assertPeArchitecture(path, arch) {
  const actual = peArchitecture(path);
  if (actual !== arch) throw new Error(`${path} is ${actual}, expected ${arch}`);
}

export function manifestFor(root, metadata) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name !== "runtime-manifest.json") {
        files.push({
          path: relative(root, path).replaceAll("\\", "/"),
          size: statSync(path).size,
          sha256: sha256(path),
        });
      }
    }
  };
  visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ...metadata, files };
}

export function verifyManifest(root) {
  const path = join(root, "runtime-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const file of manifest.files ?? []) {
    const full = join(root, ...file.path.split("/"));
    if (!statSync(full).isFile()) throw new Error(`${file.path} is not a staged file`);
    if (statSync(full).size !== file.size) throw new Error(`${file.path} size does not match its manifest`);
    assertSha256(full, file.sha256, file.path);
  }
  const actual = manifestFor(root, {}).files.map((file) => file.path);
  const listed = (manifest.files ?? []).map((file) => file.path).sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(actual) !== JSON.stringify(listed)) throw new Error("runtime manifest does not list every staged file");
  return manifest;
}

/**
 * Replace a staged runtime directory with a freshly prepared one, in that order.
 *
 * The prepare scripts used to clear build-resources at module top level, before the first
 * download ran. When the pinned ffmpeg release was deleted upstream (#581) the clear still
 * happened and the download then 404'd, so a machine that had a perfectly good staged ffmpeg was
 * left with none -- the retry strictly worse off than the first attempt, and recoverable only by
 * copying binaries back out of an older win-unpacked. A failed prepare should cost a build, not
 * the checkout, so nothing here is removed until its replacement is verified and in place.
 *
 * The old copy moves aside whole rather than being deleted in front of the new one: a directory
 * rename either happens or does not, where a recursive delete can stop halfway on a locked file
 * and leave a half-emptied stage that electron-builder would package without complaint. `attic`
 * is where it waits, and must sit on the same volume as `stage` for that rename to be the cheap
 * kind.
 */
export function swapStagedDirectory(fresh, stage, attic) {
  if (!existsSync(fresh)) throw new Error(`${fresh} was never prepared, so ${stage} was left as it was`);
  mkdirSync(dirname(stage), { recursive: true });
  rmSync(attic, { recursive: true, force: true });
  const displaced = existsSync(stage);
  if (displaced) {
    mkdirSync(dirname(attic), { recursive: true });
    renameSync(stage, attic);
  }
  try {
    moveDirectory(fresh, stage);
  } catch (error) {
    // The displaced copy is now the only one there is; put it back rather than leave neither.
    if (displaced) renameSync(attic, stage);
    throw error;
  }
  rmSync(attic, { recursive: true, force: true });
}

function moveDirectory(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    // --work may point at another volume, where rename is EXDEV rather than a metadata update.
    if (error.code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}
