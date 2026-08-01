/**
 * Sweep the scratch directories the test suite leaves in the system temp folder.
 *
 * The suites clean up after themselves (packages/coordinator/test/tmp.ts); this collects
 * what a crashed run, a killed watcher, or an older checkout left behind. Run it with
 * `--dry-run` to see the tally without removing anything.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "arke-";
const dryRun = process.argv.includes("--dry-run");
const root = tmpdir();

/** Bytes on disk, best effort — an unreadable child is worth zero, not a crash. */
async function sizeOf(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  let entries = [];
  try {
    entries = await readdir(path);
  } catch {
    return 0;
  }
  for (const entry of entries) total += await sizeOf(join(path, entry));
  return total;
}

const names = (await readdir(root)).filter((name) => name.startsWith(PREFIX));
if (names.length === 0) {
  console.log(`No ${PREFIX}* scratch directories in ${root}.`);
  process.exit(0);
}

let reclaimed = 0;
let removed = 0;
const stubborn = [];
for (const name of names) {
  const dir = join(root, name);
  const size = await sizeOf(dir);
  if (dryRun) {
    reclaimed += size;
    removed += 1;
    continue;
  }
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    reclaimed += size;
    removed += 1;
  } catch (err) {
    stubborn.push(`${name} (${err.code ?? err.message})`);
  }
}

const gb = (reclaimed / 1024 ** 3).toFixed(2);
console.log(
  dryRun
    ? `Would remove ${removed} ${PREFIX}* directories from ${root}, freeing ${gb} GB.`
    : `Removed ${removed} ${PREFIX}* directories from ${root}, freeing ${gb} GB.`,
);
if (stubborn.length > 0) {
  console.log(`Still held open (a test run in progress?): ${stubborn.join(", ")}`);
  process.exitCode = 1;
}
