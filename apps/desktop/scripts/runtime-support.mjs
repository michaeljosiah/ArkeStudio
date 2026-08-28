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
 * Which GPL a licence file is, read off its own heading.
 *
 * Returns "2" or "3", or null for a text that is not a GPL. Deliberately anchored to the two
 * heading lines the FSF ships rather than to any mention of a version, so that a licence quoting
 * another one inside its preamble cannot be misread.
 */
export function gplVersionOf(text) {
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/i.test(text)) return "3";
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/i.test(text)) return "2";
  return null;
}

/** Every GPL version a notice claims to be written under, as strings. */
export function citedGplVersions(text) {
  return new Set([...text.matchAll(/General Public License,?\s+version\s+(\d+)/gi)].map((match) => match[1]));
}

/**
 * A source notice must be written under the licence that ships beside it.
 *
 * These drifted apart and stayed that way through two releases: BtbN builds ffmpeg with
 * --enable-version3, so GPLv3 text shipped in the folder, while the generated notice went on
 * citing GPLv2 section 3(b) -- a section v3 does not have. Nothing read both files, so nothing
 * noticed. This does, at the same moment the rest of the obligations are checked.
 */
export function assertNoticeMatchesLicence(licenceText, noticeText, label) {
  const shipped = gplVersionOf(licenceText);
  if (!shipped) throw new Error(`${label}: the licence text shipped beside the notice is not a recognised GPL`);
  const cited = citedGplVersions(noticeText);
  if (cited.size === 0) throw new Error(`${label}: the notice does not say which GPL version it is written under`);
  for (const version of cited) {
    if (version !== shipped) {
      throw new Error(`${label}: the notice cites GPL version ${version} but the licence beside it is GPL version ${shipped}`);
    }
  }
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
 * is where it waits, and must sit on the same volume as `stage` -- every rename below depends on
 * that, and a `.incoming` sibling of it is where the fresh copy lands on the way in.
 */
export function swapStagedDirectory(fresh, stage, attic) {
  if (!existsSync(fresh)) throw new Error(`${fresh} was never prepared, so ${stage} was left as it was`);
  mkdirSync(dirname(stage), { recursive: true });
  mkdirSync(dirname(attic), { recursive: true });

  /*
   * Get the fresh copy onto the stage's own volume first, while nothing has been displaced yet.
   *
   * `--work` may point at another drive, where rename is EXDEV and the fallback is a recursive
   * copy. That copy used to run straight into `stage`: if it died part-way -- a full disk, a
   * locked file -- it left a half-written runtime at the path electron-builder reads, and the
   * displaced copy could not then be renamed back over the remains (Codex round 1). Landing
   * beside the attic instead keeps a failed copy somewhere nothing reads, and makes the arrival
   * at `stage` a rename in both cases.
   */
  const landing = `${attic}.incoming`;
  rmSync(landing, { recursive: true, force: true });
  try {
    renameSync(fresh, landing);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    cpSync(fresh, landing, { recursive: true });
    rmSync(fresh, { recursive: true, force: true });
  }

  /*
   * An attic is stale only when there is a `stage` to make it stale.
   *
   * A run killed between the two renames below leaves the attic holding the only working runtime
   * and nothing at `stage`. Clearing it unconditionally, as this did, destroyed that survivor and
   * then reported no displaced copy to restore -- losing a runtime that had in fact been saved
   * (Codex round 1). With no stage, the attic IS the displaced copy.
   */
  let displaced = existsSync(stage);
  if (displaced) {
    rmSync(attic, { recursive: true, force: true });
    renameSync(stage, attic);
  } else {
    displaced = existsSync(attic);
  }

  try {
    renameSync(landing, stage);
  } catch (error) {
    // The displaced copy is now the only one there is; put it back rather than leave neither.
    if (displaced) {
      rmSync(stage, { recursive: true, force: true });
      renameSync(attic, stage);
    }
    throw error;
  }
  rmSync(attic, { recursive: true, force: true });
}
