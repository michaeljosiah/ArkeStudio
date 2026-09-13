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
//                                          — and says what each one holds that the set does not,
//                                          because a stray can be the only copy of an amendment
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
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
    // A status that could not be read is not a clean one. The whole point of running this after
    // a session is to learn whether an amendment is still uncommitted, and "clean" printed over a
    // failed command would answer the opposite of what was asked.
    if (dirty === null) {
      if (head !== null) {
        console.error("  could not read the repository's status — check it by hand before trusting anything here");
        process.exit(1);
      }
    } else if (dirty) console.log(`  uncommitted edits:\n${dirty.split("\n").map((line) => `    ${line}`).join("\n")}`);
    else if (head !== null) console.log("  clean");
  }

  const strays = LINKED_PATHS.filter((path) => !tracked(path) && describe(path) !== null);
  for (const path of strays) console.error(`  ${path} is ${describe(path)} in this checkout, and git does not track it here.`);
  if (strays.length > 0) {
    // A stray may be the one copy of an amendment: a session that was still writing through a
    // junction when the links went writes into these paths now, and the ignore rules hide it from
    // git. So before anyone is told to remove anything, say what each stray holds that the private
    // set does not — a link holds nothing, a copy identical to the set holds nothing, and a copy
    // that differs is work to carry across first.
    console.error("Nothing links the private set into a checkout any more.");
    for (const path of strays) console.error(`  ${path}: ${strayVerdict(path, root)}`);
    if (check) process.exit(1);
  }
}

/** What removing a stray would lose, so the remedy never discards an amendment. */
function strayVerdict(path, root) {
  const full = join(repoRoot, path);
  if (lstatSync(full).isSymbolicLink()) return "a link — removing it drops nothing; `cmd /c rmdir` it";
  const files = statSync(full).isDirectory()
    ? readdirSync(full, { recursive: true }).map(String).filter((f) => statSync(join(full, f)).isFile())
    : [""];
  if (!existsSync(root)) return `a copy holding ${files.length} file(s), and the private set is not here to compare against — keep it until it is`;
  const differing = files.filter((f) => {
    const mine = join(full, f);
    const theirs = join(root, relativeInPrivateSet(path), f);
    // Line endings are noise here (the set is LF, a Windows editor writes CRLF); words are not.
    const text = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    return !existsSync(theirs) || text(mine) !== text(theirs);
  });
  if (differing.length === 0) return "identical to the private set — nothing to carry across; remove it";
  return `${differing.length} file(s) differ from the private set (${differing.slice(0, 3).map((f) => f || path).join(", ")}${differing.length > 3 ? ", …" : ""}) — carry those edits into ${root} and commit there BEFORE removing it`;
}

/** Where a linked checkout path lives inside the private set. */
function relativeInPrivateSet(path) {
  return path === "docs/architecture/character-audio-foundation.md" ? "architecture/character-audio-foundation.md" : path.replace(/^docs\//, "");
}
