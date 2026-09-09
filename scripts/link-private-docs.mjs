// Links a checkout to the private document set: the master spec, the capability specs, the ADRs
// and the one internal architecture note. See CLAUDE.md, "The specs are not in this repository".
//
// This exists because the hand-written version of these four commands had a real bug in it — a
// hard link cannot be created over an existing file, so the documented recovery for a stale link
// failed and left the checkout reading an obsolete spec while believing it was repaired. The rules
// are fiddly in a way that does not survive being retyped: two of the paths are directories and
// take junctions, two are single files and take hard links, and the whole thing is only safe in a
// checkout where git does not track those paths.
//
// It never replaces a file. Earlier versions built a replacement link and swapped it in, which
// bought nothing and cost a great deal: a staged hard link holds the private document's whole
// content, so a failed swap could leave the master spec sitting at an unignored path ready to be
// committed back into the public repository, and a swap decided from an earlier comparison could
// discard an edit written in between. There is no such window here. A path is created only when
// nothing is there, and anything unexpected is reported for a person to resolve.
//
// Dry run is the default, as it is for prune-merged.mjs. Pass --apply to act.
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
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

const currentBranch = () => {
  try {
    return (
      execFileSync("git", ["-C", repoRoot, "branch", "--show-current"], { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || "a detached HEAD"
    );
  } catch {
    return "this branch";
  }
};

// Whether git tracks a path in THIS checkout. A tracked path means the branch still carries the
// documents — either the change that removes them has not merged, or this checkout is on a branch
// from before it. Linking would delete tracked content, and any uncommitted edit to it with no
// copy anywhere else. That is the one failure this script exists to refuse.
const tracked = (path) => {
  try {
    execFileSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", path], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
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

// Two paths are the same file when they are the same inode — which is exactly what a hard link is,
// and what NTFS reports faithfully. Content equality is not the same question: a copy holding
// identical bytes today drifts the moment either side is edited.
const sameFile = (a, b) => {
  try {
    const [x, y] = [statSync(a), statSync(b)];
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
};

if (!existsSync(privateRoot)) {
  console.error(`The private document set is not at ${privateRoot}.`);
  console.error("Set ARKE_PRIVATE_DOCS if it lives elsewhere. Nothing was changed.");
  process.exit(1);
}

// Plan first, act second. Every refusal has to be known before the first change, or a refusal on
// the fourth path leaves the first three already altered under a message saying nothing happened.
const problems = [];
const plan = [];

for (const link of LINKS) {
  const target = join(repoRoot, link.path);
  const source = join(privateRoot, link.source);

  if (!existsSync(source)) {
    problems.push(`${link.path}: nothing to link to — ${source} does not exist`);
    continue;
  }
  if (tracked(link.path)) {
    problems.push(
      `${link.path}: git still tracks this on ${currentBranch()}. Linking would delete tracked files ` +
        `and any uncommitted edit to them. Merge the change that removes them and switch this checkout to it first.`,
    );
    continue;
  }

  if (link.kind === "junction") {
    if (isLink(target)) {
      const to = resolve(readlinkSync(target));
      if (to === resolve(source)) {
        plan.push({ describe: `${link.path}: already linked`, run: null });
      } else {
        // Removing a junction removes a pointer, never the documents it points at, so repointing
        // one costs nothing if it fails halfway.
        plan.push({
          describe: `${link.path}: REPOINT (currently ${to})`,
          run: () => {
            rmSync(target, { recursive: false, force: true });
            symlinkSync(source, target, "junction");
          },
        });
      }
    } else if (existsSync(target)) {
      // A real directory holds real files. Never remove one — it is not ours to judge.
      problems.push(`${link.path}: a real directory, not a link. Move or delete it yourself, then re-run.`);
    } else {
      plan.push({
        describe: `${link.path}: CREATE junction -> ${source}`,
        run: () => symlinkSync(source, target, "junction"),
      });
    }
    continue;
  }

  // Hard links are the delicate half, because the file at the target is a real document and
  // deleting it can lose writing. So this never deletes one. Already the same inode means there is
  // nothing to repair. Anything else present is reported, and the person decides — which turns the
  // dangerous case into the CREATE case below, where there is nothing to lose.
  if (!existsSync(target)) {
    plan.push({
      describe: `${link.path}: CREATE hard link -> ${source}`,
      run: () => {
        mkdirSync(dirname(target), { recursive: true });
        linkSync(source, target);
      },
    });
  } else if (sameFile(target, source)) {
    plan.push({ describe: `${link.path}: already linked`, run: null });
  } else {
    let detail = "it is a separate file";
    try {
      detail = readFileSync(target).equals(readFileSync(source))
        ? "it is a copy with identical content — probably a hard link OneDrive replaced on sync"
        : "its content differs from the private copy, so one of them holds writing the other does not";
    } catch (error) {
      detail = `it could not be read (${error?.code ?? error})`;
    }
    problems.push(
      `${link.path}: present but not linked — ${detail}. Save anything you need from it, delete it, then re-run.`,
    );
  }
}

console.log(`Private document set: ${privateRoot}`);
console.log(`Checkout: ${repoRoot} (${currentBranch()})\n`);
for (const entry of plan) console.log(`  ${entry.describe}`);
for (const problem of problems) console.error(`  REFUSED  ${problem}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} path(s) refused. Nothing was changed.`);
  process.exit(1);
}
if (!apply) {
  console.log("\nDry run. Re-run with --apply to make these links.");
  process.exit(0);
}

for (const entry of plan) entry.run?.();
console.log("\nLinked.");
