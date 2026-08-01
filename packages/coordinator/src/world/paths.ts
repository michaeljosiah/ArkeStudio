import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Roots and path safety (SPEC-002 §2.2, §2.4.1).
 *
 * The app root is %USERPROFILE%\ArkeStudio (overridable for tests and dev via
 * ARKE_STUDIO_ROOT). Filesystem operations on Windows use extended-length prefixes so the
 * app's own reads and writes are not subject to the 260-character MAX_PATH default (R-10).
 */

export function defaultAppRoot(): string {
  const override = process.env["ARKE_STUDIO_ROOT"];
  if (override && override.trim() !== "") return resolve(override);
  return join(homedir(), "ArkeStudio");
}

/**
 * Prefix an absolute Windows path with `\\?\` so Win32 APIs accept lengths beyond MAX_PATH.
 * No-op elsewhere, on relative paths, and on already-prefixed or UNC paths.
 */
export function toExtendedLength(path: string): string {
  if (process.platform !== "win32") return path;
  if (!isAbsolute(path)) return path;
  if (path.startsWith("\\\\")) {
    // UNC → \\?\UNC\server\share\…
    return path.startsWith("\\\\?\\") ? path : `\\\\?\\UNC\\${path.slice(2)}`;
  }
  return `\\\\?\\${path}`;
}

/** Join then extended-length-prefix — the form every world filesystem call uses. */
export function fsPath(...segments: string[]): string {
  return toExtendedLength(join(...segments));
}

/** Internal references use forward slashes so a world moves across platforms (R-24). */
export function toPortable(relPath: string): string {
  return relPath.split(sep).join("/");
}

export function fromPortable(relPath: string): string {
  return relPath.split("/").join(sep);
}

/**
 * The deepest path the layout generates (§2.4.1):
 * <root>\worlds\<48>\productions\<48>\takes\<tk_ULID>\clip.mp4
 */
const FIXED_SEGMENTS = "worlds/".length + "/productions/".length + "/takes/".length + "tk_".length + 26 + "/clip.mp4".length;
const SLUG_CAP = 48;
const CLASSIC_LIMIT = 260;

export interface PathBudget {
  rootLength: number;
  worstCase: number;
  /** True when the classic limit would be threatened for tools that lack long-path support. */
  tight: boolean;
}

/**
 * Report the budget at first run (R-10). The app itself uses extended-length prefixes, so this
 * is a warning about *other* tools (explorer, editors) the user will point at the folder.
 */
export function checkPathBudget(appRoot: string): PathBudget {
  const worstCase = appRoot.length + 1 + FIXED_SEGMENTS + SLUG_CAP * 2;
  return { rootLength: appRoot.length, worstCase, tight: worstCase >= CLASSIC_LIMIT };
}

export { SLUG_CAP };
