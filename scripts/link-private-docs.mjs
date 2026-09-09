// Links a checkout to the private document set: the master spec, the capability specs, the ADRs
// and the one internal architecture note. See CLAUDE.md, "The specs are not in this repository".
//
// This exists because the hand-written version of these four commands had a real bug in it — a
// hard link cannot be re-created over an existing file, so the documented recovery for a stale
// link failed and left the checkout reading an obsolete spec while believing it was repaired.
// The linking rules are fiddly in a way that does not survive being retyped: two of the paths are
// directories and take junctions, two are single files and take hard links, and the whole thing is
// only safe in a checkout where git does not track those paths.
//
// Dry run is the default, as it is for prune-merged.mjs. Pass --apply to act.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, linkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");

const privateRoot =
  process.env.ARKE_PRIVATE_DOCS ??
  join(process.env.USERPROFILE ?? process.env.HOME ?? "", "OneDrive", "Documents", "04_AI_Projects", "Arke Worlds", "arke-studio-specs");

// kind: "junction" for directories, "hardlink" for single files.
const LINKS = [
  { kind: "junction", path: "docs/specifications", source: "specifications" },
  { kind: "junction", path: "docs/decisions", source: "decisions" },
  { kind: "hardlink", path: "docs/specification.md", source: "specification.md" },
  {
    kind: "hardlink",
    path: "docs/architecture/character-audio-foundation.md",
    source: "architecture/character-audio-foundation.md",
  },
];

const problems = [];
const actions = [];

if (!existsSync(privateRoot)) {
  console.error(`The private document set is not at ${privateRoot}.`);
  console.error("Set ARKE_PRIVATE_DOCS if it lives elsewhere. Nothing was changed.");
  process.exit(1);
}

// Whether git tracks a path in THIS checkout. A tracked path means the branch still carries the
// documents — either the change that removes them has not merged, or this checkout is on a branch
// from before it. Linking would delete tracked content, and any uncommitted edit to it with no
// copy anywhere else. That is the one failure this script exists to refuse.
const tracked = (path) => {
  try {
    return execFileSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", path], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim().length > 0;
  } catch {
    return false;
  }
};

const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

for (const link of LINKS) {
  const target = join(repoRoot, link.path);
  const source = join(privateRoot, link.source);

  if (!existsSync(source)) {
    problems.push(`${link.path}: nothing to link to — ${source} does not exist`);
    continue;
  }
  if (tracked(link.path)) {
    problems.push(
      `${link.path}: git still tracks this in ${currentBranch()}. Linking would delete tracked files ` +
        `and any uncommitted edit to them. Merge the change that removes them and switch this checkout to it first.`,
    );
    continue;
  }

  if (link.kind === "junction") {
    if (isLink(target)) {
      const to = resolve(readlinkSync(target));
      if (to === resolve(source)) {
        actions.push(`${link.path}: already linked`);
      } else {
        actions.push(`${link.path}: RELINK (points at ${to})`);
        if (apply) {
          rmSync(target, { recursive: false, force: true });
          symlinkSync(source, target, "junction");
        }
      }
    } else if (existsSync(target)) {
      // A real directory holds real files. Never remove one — it is not ours to judge.
      problems.push(`${link.path}: a real directory, not a link. Move or delete it yourself, then re-run.`);
    } else {
      actions.push(`${link.path}: CREATE junction -> ${source}`);
      if (apply) symlinkSync(source, target, "junction");
    }
    continue;
  }

  // Hard links are indistinguishable from ordinary files, so identity is decided on content.
  // Equal content means it is either already linked or a faithful copy, and re-linking is safe.
  // Differing content means one side holds edits the other does not, and guessing which to keep
  // would silently discard somebody's writing — OneDrive replacing a file on sync produces
  // exactly this, and it is the case the old instructions got wrong.
  if (existsSync(target)) {
    const same = readFileSync(target).equals(readFileSync(source));
    if (same) {
      actions.push(`${link.path}: already current (re-linking)`);
      if (apply) {
        rmSync(target, { force: true });
        linkSync(source, target);
      }
    } else {
      problems.push(
        `${link.path}: differs from the private copy. One of them has edits the other does not — ` +
          `compare them and copy the version you want into ${source} yourself, then re-run.`,
      );
    }
  } else {
    actions.push(`${link.path}: CREATE hard link -> ${source}`);
    if (apply) {
      mkdirSync(dirname(target), { recursive: true });
      linkSync(source, target);
    }
  }
}

function currentBranch() {
  try {
    return execFileSync("git", ["-C", repoRoot, "branch", "--show-current"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || "a detached HEAD";
  } catch {
    return "this branch";
  }
}

console.log(`Private document set: ${privateRoot}`);
console.log(`Checkout: ${repoRoot} (${currentBranch()})\n`);
for (const action of actions) console.log(`  ${action}`);
for (const problem of problems) console.error(`  REFUSED  ${problem}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} path(s) refused. Nothing else was changed.`);
  process.exit(1);
}
if (!apply) console.log("\nDry run. Re-run with --apply to make these links.");
else console.log("\nLinked.");
