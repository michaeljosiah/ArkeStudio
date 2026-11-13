import { lstat, readdir, realpath, statfs } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import { readWorldMeta } from "./scan.js";
import { cleanupUnsettled } from "../cleanup/ledger.js";

/** Validate a user-chosen world before the existing copy/identity publication owner receives it. */
export async function checkWorldImport(source: string, appRoot: string, signal: AbortSignal): Promise<string> {
  const root = await realpath(source), target = await realpath(appRoot);
  const inside = relative(root, target);
  if (inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) throw new Error("Choose a world folder, not a folder containing your Arke library.");
  await readWorldMeta(root);
  const entries = await readdir(root);
  if (entries.includes("world.lock")) throw new Error("Close this world in its other Arke window before importing it.");
  if (entries.includes(".commit")) {
    for (const name of await readdir(join(root, ".commit"))) {
      // Successful commits leave this shared parent behind. Its mere existence is not
      // pending work; journals, staged payloads and unexpected entries still refuse.
      const path = join(root, ".commit", name), info = await lstat(path);
      if (name === "staging" && info.isDirectory() && !info.isSymbolicLink() && (await readdir(path)).length === 0) continue;
      throw new Error("Open and close the source world in Arke to finish its pending save before importing it.");
    }
  }
  // A clean-up run cut short leaves files between two places until the world it ran in opens (SPEC-066 R-46).
  if (entries.includes("cleanup.jsonl") && await cleanupUnsettled(root)) throw new Error("Open and close the source world in Arke to finish its clean-up before importing it.");
  let bytes = 0;
  async function walk(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      signal.throwIfAborted();
      if ([".cache", ".held", ".index", ".lock", "index.db", "index.db-wal", "index.db-shm"].includes(name)) continue;
      const path = join(directory, name), info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("This world contains a linked file or folder. Copy its content into the world folder before importing it.");
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) bytes += info.size;
      else throw new Error("This world contains an unsupported filesystem entry.");
    }
  }
  await walk(root);
  const volume = await statfs(target);
  if (volume.bavail * volume.bsize < bytes + 1024 * 1024) throw new Error("There is not enough free space in your Arke folder for this world. Free space or choose another workspace.");
  signal.throwIfAborted();
  return root;
}
