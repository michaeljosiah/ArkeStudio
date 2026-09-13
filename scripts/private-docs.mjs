// Where the private document set is, and whether this checkout is clean of it.
// See CLAUDE.md, "The specs are not in this repository".
//
// The set — the master spec, the capability specs, the ADRs and the one internal architecture
// note — is its own private git repository, cloned beside this one. Nothing links it into a
// checkout any more. Two rounds of junctions and hard links (2026-09-09 to 2026-09-13) taught the
// lesson: git reaches through a junction, so a checkout moved onto an old commit wrote its
// tracked specs over the private set (twice), a delete during a renumbering took a spec that no
// history held, and every fresh worktree started with dead links. A sibling repository has
// history, diffs and a remote, and needs no link to be read.
//
// This script does two small things and refuses nothing it cannot explain:
//   node scripts/private-docs.mjs          prints where the set is, its HEAD and whether it has
//                                          uncommitted edits — the thing to check before and
//                                          after a session that amended a spec
//   node scripts/private-docs.mjs --check  exits non-zero if this checkout carries the set at
//                                          the old linked paths, as a junction, a hard link or a
//                                          real copy, in a checkout where git does not track them
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const git = (cwd, ...args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
};

/**
 * The private set: `ARKE_PRIVATE_DOCS`, else `arke-studio-specs` beside the MAIN checkout. Beside
 * the main checkout, not beside this one: Claude worktrees live inside the repository at
 * `.claude/worktrees/<name>`, so "the sibling" of a worktree would be a path that never exists.
 * The common git directory is the main checkout's `.git` from every worktree.
 */
export function privateDocsRoot() {
  if (process.env.ARKE_PRIVATE_DOCS) return process.env.ARKE_PRIVATE_DOCS;
  const common = git(repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const mainRoot = common ? resolve(common, "..") : repoRoot;
  return resolve(mainRoot, "..", "arke-studio-specs");
}

// The paths a checkout used to link. Their presence in a checkout that does not track them is
// the hazard this script exists to name: a copy that git will not see, or a link git will reach
// through.
const LINKED_PATHS = [
  "docs/specifications",
  "docs/decisions",
  "docs/specification.md",
  "docs/architecture/character-audio-foundation.md",
];

const tracked = (path) => (git(repoRoot, "ls-files", "--", path) ?? "") !== "";

const describe = (path) => {
  const full = join(repoRoot, path);
  let entry;
  try {
    entry = lstatSync(full);
  } catch {
    return null;
  }
  if (entry.isSymbolicLink()) return "a junction or symlink";
  if (entry.isDirectory()) return `a real directory (${readdirSync(full).length} entries)`;
  return statSync(full).nlink > 1 ? "a hard link" : "a real file";
};

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();

function main() {
  const check = process.argv.includes("--check");
  const root = privateDocsRoot();

  // A machine without the set is the normal case in CI and for outside contributors, so --check
  // says nothing about it: the guard below is about this checkout, not about the set.
  if (!check) {
    if (!existsSync(root)) {
      console.error(`The private document set is not at ${root}.`);
      console.error("Clone github.com/michaeljosiah/arke-studio-specs beside this repository, or set ARKE_PRIVATE_DOCS.");
      process.exit(1);
    }
    const head = git(root, "log", "-1", "--format=%h %ad %s", "--date=short");
    const dirty = git(root, "status", "--short");
    console.log(`Private document set: ${root}`);
    console.log(head === null ? "  not a git repository — it should be; see CLAUDE.md" : `  HEAD ${head}`);
    if (dirty) console.log(`  uncommitted edits:\n${dirty.split("\n").map((line) => `    ${line}`).join("\n")}`);
    else if (head !== null) console.log("  clean");
  }

  const strays = LINKED_PATHS.filter((path) => !tracked(path) && describe(path) !== null);
  for (const path of strays) console.error(`  ${path} is ${describe(path)} in this checkout, and git does not track it here.`);
  if (strays.length > 0) {
    console.error("Nothing links the private set into a checkout any more; remove these, do not commit them.");
    if (check) process.exit(1);
  }
}
