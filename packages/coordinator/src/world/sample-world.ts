import { cp, mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { ulid } from "@arke-studio/contracts";
import { atomicWriteFile } from "./atomic.js";
import { toExtendedLength } from "./paths.js";
import { readWorldMeta, WorldOpenError } from "./scan.js";
import { uniqueSlug } from "./slug.js";

/**
 * Installing the sample world (SPEC-016 R-6): The Undersong, copied out of the application's
 * own resources into the user's library.
 *
 * A world is plain files, so installing one is a copy — there is no import format, no
 * migration and nothing to unpack. Only its identity is rewritten. Everything else, including
 * its change history and the proposal waiting at its gate, is the document as authored: a user
 * who installs it gets the world, not a re-enactment of someone making it.
 */

/** Runtime detritus the application writes beside a world. Never part of the document. */
const NOT_THE_DOCUMENT = new Set([".cache", ".lock", "index.db", "index.db-wal", "index.db-shm"]);

/** The source is missing or is not a world — a stated reason, never a silent no-op. */
export class SampleWorldUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SampleWorldUnavailable";
  }
}

export interface InstallSampleWorldOptions {
  /** The world folder shipped with the application, or wherever this build keeps it. */
  sourceDir: string;
  /** The app root. `worlds/` receives the copy; a sibling holds it while it is assembled. */
  appRoot: string;
}

/** Is there a sample world to install at all? Cheap, so the Settings pane can ask on every read. */
export async function sampleWorldAvailable(sourceDir: string | null): Promise<boolean> {
  if (sourceDir === null) return false;
  try {
    await readWorldMeta(sourceDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the sample world into the library under a fresh identity.
 *
 * Only `worldId` and `slug` are rewritten. The id because two copies of one folder must not
 * claim to be the same world — the app index is keyed on it, and the second would shadow the
 * first. The slug because it is the folder name, and `uniqueSlug` is what already decides that
 * a second install is `the-undersong-2` rather than an overwrite.
 *
 * Timestamps are deliberately left alone. `created` records when the world was authored, which
 * is not today, and a world stamped today whose change log starts months ago would be reporting
 * something untrue on its own overview.
 *
 * The copy is assembled outside `worlds/` and renamed in once its identity is its own. Done the
 * other way round there is a window — long, because it is megabytes of art — in which the
 * library holds two worlds claiming the same id, and a `listWorlds()` landing inside it would
 * index the wrong one.
 */
export async function installSampleWorld(
  opts: InstallSampleWorldOptions,
): Promise<{ worldId: string; slug: string; name: string }> {
  const { sourceDir, appRoot } = opts;
  const worldsDir = join(appRoot, "worlds");

  try {
    if (!(await stat(toExtendedLength(sourceDir))).isDirectory()) {
      throw new SampleWorldUnavailable("the sample world is not a folder in this build");
    }
  } catch (err) {
    if (err instanceof SampleWorldUnavailable) throw err;
    throw new SampleWorldUnavailable("this build does not carry the sample world");
  }

  let source;
  try {
    source = await readWorldMeta(sourceDir);
  } catch (err) {
    const detail = err instanceof WorldOpenError ? err.reason : "it could not be read";
    throw new SampleWorldUnavailable(`the sample world could not be opened (${detail})`);
  }

  const worldId = ulid();
  const stagingRoot = join(appRoot, ".installing");
  const staging = join(stagingRoot, worldId);
  await mkdir(toExtendedLength(stagingRoot), { recursive: true });

  try {
    await cp(sourceDir, staging, {
      recursive: true,
      filter: (src) => !NOT_THE_DOCUMENT.has(basename(src)),
    });

    // The slug is chosen against the library as it stands *now* — after the copy, so a world
    // added while those megabytes were being written still cannot be collided with.
    const taken = await readdir(toExtendedLength(worldsDir)).catch(() => [] as string[]);
    const slug = uniqueSlug(source.name, "world", taken);
    await atomicWriteFile(
      join(staging, "world.json"),
      JSON.stringify({ ...source, worldId, slug }, null, 2) + "\n",
    );

    await mkdir(toExtendedLength(worldsDir), { recursive: true });
    await rename(toExtendedLength(staging), toExtendedLength(join(worldsDir, slug)));
    // The app root is a folder people open (Settings · About · Open folder). `rmdir` and not
    // `rm -r`: it removes the staging area only when nothing is in it, so a second install
    // running alongside this one keeps the directory it is still writing into.
    await rmdir(toExtendedLength(stagingRoot)).catch(() => {});
    return { worldId, slug, name: source.name };
  } catch (err) {
    // A half-copied world must not be left where the next install would trip over it.
    await rm(toExtendedLength(staging), { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
