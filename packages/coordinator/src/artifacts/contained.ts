import { lstat, realpath } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { toExtendedLength } from "../world/paths.js";

/**
 * Paths a world names that a pass is about to read or write, checked to be the world's own.
 *
 * A sidecar names a file and the shelf is `artifacts/`; a poster goes under `.index/`. Both are
 * lexically inside the world, and neither check survives a link: a world copied in from
 * elsewhere can carry a symlink under `artifacts/` to a host file, or an `.index/` that is a
 * link out, and a pass that runs on open would read the one and write through the other with
 * nobody asking. So both ends are resolved and compared as real paths, the way filing's own
 * measurement pass checks before it hands ffprobe a file.
 */

/** The real directory at `<worldDir>/<segments>`, or null when it is not the world's own once links are followed. */
export async function ownDirectory(worldDir: string, ...segments: string[]): Promise<string | null> {
  try {
    const [worldReal, real] = await Promise.all([
      realpath(toExtendedLength(worldDir)),
      realpath(toExtendedLength(join(worldDir, ...segments))),
    ]);
    if (real !== join(worldReal, ...segments)) return null;
    return (await lstat(toExtendedLength(real))).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The real path of `file` when it is a plain file directly inside the world's own `artifacts/`,
 * or null: a name with a path in it, a link that leaves the directory, a directory, a file that
 * is not there.
 */
export async function containedArtifactFile(worldDir: string, file: string): Promise<string | null> {
  if (basename(file) !== file || file === "..") return null;
  const root = await ownDirectory(worldDir, "artifacts");
  if (root === null) return null;
  try {
    const target = await realpath(toExtendedLength(join(root, file)));
    if (target !== join(root, basename(target)) || !target.startsWith(root + sep)) return null;
    return (await lstat(toExtendedLength(target))).isFile() ? target : null;
  } catch {
    return null;
  }
}
