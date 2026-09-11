/**
 * Remove local branches and Claude worktrees that `origin/main` has already absorbed.
 *
 * This exists because the job was being done by hand. On 2026-08-26 an ad-hoc cleanup deleted 55
 * branches correctly — every one of them a genuine ancestor of `origin/main`, every SHA recorded
 * so it could be restored — and then took live worktrees with the same broad stroke. One held
 * uncommitted work on an unmerged branch, and that work was gone. A second session lost its
 * bearings the way an evicted worktree always does: `.claude/worktrees/<name>` sits *inside* the
 * repo, so when the `.git` file disappears git simply walks up, finds the main checkout, and
 * every later command operates on `main` without a word of complaint.
 *
 * The branch half of that run was careful. The worktree half was not held to the same standard,
 * and the worktree half is where unpushed work lives. So both halves are gated here on the same
 * question — has `origin/main` already got this? — and the worktree half is gated twice, because
 * "merged" says nothing about the files sitting in the directory right now.
 *
 * A worktree is removed only when ALL of these hold:
 *   - it is not this one, and not the main checkout;
 *   - it is not locked, and not detached (a detached HEAD has no branch to vouch for it);
 *   - its branch is an ancestor of the base ref;
 *   - `git status` in it is completely clean, untracked files included.
 *
 * A branch is deleted only when it is an ancestor of the base ref, is not protected, and is not
 * checked out in any worktree that survived the pass above.
 *
 * An orphan — a directory under .claude/worktrees that git no longer lists — is removed only when
 * it has no `.git` file, which means a `worktree remove` already passed the gates above and gave
 * up partway through the delete. One that still has a `.git` file is named and left alone.
 *
 * Dry run is the DEFAULT, which is a deliberate break from `clean-temp.mjs` next door: that one
 * sweeps scratch directories, this one deletes work. Nothing is removed without `--apply`.
 *
 *   node scripts/prune-merged.mjs                  # report only, touch nothing
 *   node scripts/prune-merged.mjs --apply          # actually remove what it lists
 *   node scripts/prune-merged.mjs --keep-worktrees # branches only, leave every worktree alone
 *   node scripts/prune-merged.mjs --base <ref>     # default origin/main
 *   node scripts/prune-merged.mjs --no-fetch       # trust the local base ref as-is
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const apply = has("--apply");
const keepWorktrees = has("--keep-worktrees");
const base = valueOf("--base", "origin/main");

/**
 * Never deleted, whatever the graph says. `main` is obvious; the rest are long-lived markers
 * whose value is that they keep pointing at a moment, and a merged ancestor is exactly what such
 * a marker looks like — the ancestor test cannot tell them apart from spent feature branches.
 */
const PROTECTED = new Set(["main", "master", "HEAD"]);

/**
 * What git last said on stderr when it failed. The removal loop prints it, because on 2026-09-11
 * eleven `worktree remove`s failed in a row and this script reported nothing but "left in place" —
 * the cause (below, in `finishRemoval`) took a separate investigation to find.
 */
let lastGitError = "";

/** Run git and return trimmed stdout, or null when it fails — callers decide what a failure means. */
function git(args, cwd = process.cwd()) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (run.status !== 0) {
    lastGitError = (run.stderr ?? "").trim();
    return null;
  }
  return run.stdout.trim();
}

function gitOrDie(args, cwd = process.cwd()) {
  const out = git(args, cwd);
  if (out === null) {
    console.error(`git ${args.join(" ")} failed`);
    process.exit(1);
  }
  return out;
}

const repoRoot = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
if (repoRoot === null) {
  console.error("Not inside a git repository.");
  process.exit(1);
}
// `--git-common-dir` points at the ONE shared .git, so this resolves to the main checkout even
// when the script is run from a worktree. That is the anchor everything else is measured against.
const mainCheckout = resolve(repoRoot, "..");
// `resolve` on both sides or the comparison silently never matches: git prints Windows paths with
// forward slashes, `resolve` hands back backslashes, and `"C:/x" === "C:\\x"` is false. The guard
// that stops this script removing the ground it is standing on is exactly the wrong one to leave
// to string luck.
const here = resolve(gitOrDie(["rev-parse", "--show-toplevel"]));
/** Where Claude's worktrees live. Outside it, a worktree is someone's own and is left alone. */
const managedRoot = resolve(mainCheckout, ".claude", "worktrees");
/**
 * Paths for set membership. `git worktree list` prints a path in whatever case it was registered
 * with; `readdir` prints the case on disk. On Windows those name the same directory, and a
 * case-sensitive comparison would report a live worktree as an orphan — and remove it.
 */
const pathKey = (path) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));

if (!has("--no-fetch")) {
  const remote = base.includes("/") ? base.split("/")[0] : "origin";
  const branch = base.includes("/") ? base.slice(base.indexOf("/") + 1) : base;
  if (git(["fetch", remote, branch, "--quiet"], mainCheckout) === null) {
    console.error(`Could not fetch ${remote} ${branch}. Re-run with --no-fetch to use the local ref.`);
    process.exit(1);
  }
}

const baseSha = git(["rev-parse", "--verify", `${base}^{commit}`], mainCheckout);
if (baseSha === null) {
  console.error(`Base ref "${base}" does not resolve. Pass --base <ref>.`);
  process.exit(1);
}

/** Is `sha` already contained in the base ref? The one question both halves are gated on. */
function absorbed(sha) {
  const run = spawnSync("git", ["merge-base", "--is-ancestor", sha, baseSha], {
    cwd: mainCheckout,
    encoding: "utf8",
    windowsHide: true,
  });
  return run.status === 0;
}

/**
 * `git worktree list --porcelain` emits a blank-line-separated record per worktree. Parsed rather
 * than pattern-matched off the human format, whose columns break on any path containing a space.
 */
function worktrees() {
  const out = gitOrDie(["worktree", "list", "--porcelain"], mainCheckout);
  const found = [];
  let current = null;
  for (const raw of out.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      if (current) found.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current = { path: resolve(value), branch: null, head: null, locked: false, detached: false };
    else if (current && key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (current && key === "HEAD") current.head = value;
    else if (current && key === "locked") current.locked = true;
    else if (current && key === "detached") current.detached = true;
  }
  if (current) found.push(current);
  return found;
}

/** Anything at all in the working tree, ignored files excepted. Untracked counts — it is work too. */
function dirty(path) {
  const out = git(["status", "--porcelain", "--untracked-files=all"], path);
  if (out === null) return "its status could not be read";
  if (out.length > 0) {
    const count = out.split("\n").length;
    return `${count} uncommitted or untracked file${count === 1 ? "" : "s"}`;
  }
  return null;
}

const removals = [];
const kept = [];
const keptBranches = [];

if (keepWorktrees) {
  console.log("Worktrees: skipped (--keep-worktrees).\n");
} else {
  for (const tree of worktrees()) {
    if (tree.path === mainCheckout) continue; // the main checkout is not a candidate, ever
    const label = tree.branch ?? tree.head?.slice(0, 8) ?? "?";
    if (tree.path === here) {
      kept.push([tree.path, label, "it is the worktree this script is running in"]);
      continue;
    }
    // A checkout somewhere else on disk is a person's own working copy, not scratch space this
    // script owns. Merged and clean is not reason enough to take it out from under them.
    if (!has("--all-worktrees") && !tree.path.startsWith(managedRoot + sep)) {
      kept.push([tree.path, label, "it lives outside .claude/worktrees (pass --all-worktrees)"]);
      continue;
    }
    if (tree.locked) {
      kept.push([tree.path, label, "it is locked"]);
      continue;
    }
    if (tree.detached || !tree.branch) {
      kept.push([tree.path, label, "it is detached, so no branch vouches for its commits"]);
      continue;
    }
    const sha = git(["rev-parse", "--verify", `refs/heads/${tree.branch}^{commit}`], mainCheckout);
    if (sha === null) {
      kept.push([tree.path, label, "its branch does not resolve"]);
      continue;
    }
    if (!absorbed(sha)) {
      kept.push([tree.path, label, `${base} does not contain ${tree.branch}`]);
      continue;
    }
    const unclean = dirty(tree.path);
    if (unclean) {
      kept.push([tree.path, label, unclean]);
      continue;
    }
    removals.push({ kind: "worktree", path: tree.path, branch: tree.branch, sha });
  }
}

// Orphans: directories under .claude/worktrees that git no longer lists. Not gated by
// --keep-worktrees: that flag protects work, and these hold none. Every one found on
// 2026-09-11 (twelve of them, ~330 MB each) was the tail of a `git worktree remove` that got
// as far as deleting the `.git` file and the tracked tree, then failed inside node_modules and
// left the rest standing — the failed removal below is exactly how they are made. They are
// worse than clutter: with no `.git` file, a shell inside one resolves upward to the MAIN
// checkout, which is the eviction trap this whole script exists to avoid.
//
// A missing `.git` is the gate, and it is enough: git only takes a worktree's `.git` file
// through `worktree remove`, which had already refused anything dirty (or a person passed
// `--force`, and took that decision themselves). What survives is what git's delete could not
// reach — ignored files and junctions — and nothing git ever vouched for. A `.git` that is still
// there while git does not list the tree is the opposite case: a checkout that lost its
// registration with its contents intact, and nothing here can say whether those contents are
// work. That one is refused, by name, so a person can look.
if (existsSync(managedRoot)) {
  const registered = new Set(worktrees().map((tree) => pathKey(tree.path)));
  for (const entry of readdirSync(managedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(managedRoot, entry.name);
    if (registered.has(pathKey(path)) || pathKey(path) === pathKey(here)) continue;
    if (existsSync(join(path, ".git"))) {
      kept.push([path, entry.name, "git no longer lists it but it still has a .git file; inspect it by hand"]);
      continue;
    }
    removals.push({ kind: "orphan", path });
  }
}

// Re-read after the worktree pass: a branch still checked out somewhere must not be deleted, and
// which trees survive is only known now. Ordering matters — computing this earlier would let a
// branch whose worktree was just removed look occupied, and it would never be collected.
const occupied = new Set(
  worktrees()
    .filter((tree) => !removals.some((r) => r.kind === "worktree" && r.path === tree.path))
    .map((tree) => tree.branch)
    .filter(Boolean),
);

const branchLines = gitOrDie(["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"], mainCheckout);
for (const raw of branchLines.split("\n")) {
  const line = raw.trim();
  if (line === "") continue;
  const [name, sha] = line.split("\t");
  if (!name || !sha) continue;
  if (PROTECTED.has(name)) continue;
  if (occupied.has(name)) {
    keptBranches.push([name, "it is checked out in a worktree that is staying"]);
    continue;
  }
  if (!absorbed(sha)) continue; // unmerged branches are the normal case; not worth a line each
  removals.push({ kind: "branch", name, sha });
}

const worktreeRemovals = removals.filter((r) => r.kind === "worktree");
const orphanRemovals = removals.filter((r) => r.kind === "orphan");
const branchRemovals = removals.filter((r) => r.kind === "branch");

for (const [path, label, why] of kept) console.log(`keep    ${label}  —  ${why}\n        ${path}`);
for (const [name, why] of keptBranches) console.log(`keep    branch   ${name}  —  ${why}`);
if (kept.length + keptBranches.length > 0) console.log("");
for (const r of worktreeRemovals) console.log(`${apply ? "remove" : "would"}  worktree ${r.path}  (${r.branch})`);
for (const r of orphanRemovals) console.log(`${apply ? "remove" : "would"}  orphan   ${r.path}  (no .git; git does not list it)`);
for (const r of branchRemovals) console.log(`${apply ? "delete" : "would"}  branch   ${r.name}  ${r.sha.slice(0, 8)}`);

if (removals.length === 0) {
  console.log("Nothing to prune.");
  process.exit(0);
}

if (!apply) {
  console.log(
    `\n${worktreeRemovals.length} worktree(s), ${orphanRemovals.length} orphan folder(s) and ${branchRemovals.length} branch(es) would go. Re-run with --apply.`,
  );
  process.exit(0);
}

// The manifest is written BEFORE anything is removed. A crash halfway through must still leave a
// record of what was about to go: the SHAs are the only way back, and an unreferenced commit is
// not findable by name once the branch is gone.
const stamp = new Date().toISOString();
const manifest = [
  `# Pruned ${stamp} — every entry verified contained in ${base} (${baseSha.slice(0, 8)})`,
  `# Restore a branch with: git branch <name> <sha>`,
  `# Restore a worktree with: git worktree add <path> <branch>`,
  ...branchRemovals.map((r) => `branch    ${r.name.padEnd(52)} ${r.sha}`),
  ...worktreeRemovals.map((r) => `worktree  ${r.branch.padEnd(52)} ${r.sha}  ${r.path}`),
  // No SHA to record: an orphan has no branch and no .git, so there is nothing to restore it
  // to. The line is a record that the folder existed and was taken on purpose.
  ...orphanRemovals.map((r) => `orphan    ${"".padEnd(52)} ${"".padEnd(40)}  ${r.path}`),
  "",
].join("\n");
const manifestPath = join(mainCheckout, ".claude", `pruned-${stamp.slice(0, 10)}.txt`);
await mkdir(join(mainCheckout, ".claude"), { recursive: true });
await writeFile(manifestPath, manifest, "utf8");

// Counted from what actually happened, never from what was planned. The first draft of this
// reported the size of the two lists above and printed "Removed 1 worktree(s)" directly beneath
// "1 removal(s) failed" — a cleanup tool that overstates what it took is precisely the tool
// nobody can trust afterwards, which is the whole reason this file exists.
let failed = 0;
let worktreesGone = 0;
let orphansGone = 0;
let branchesGone = 0;

/**
 * Delete a directory git has already let go of. `rmSync` treats a junction as the link it is —
 * removes the entry, never enters the target — which was checked on Node 24 against both a live
 * junction and a dangling one before this was trusted with anything, because the junctions in
 * these folders point at `packages/` directories and in a live worktree would point at the main
 * checkout's. Returns the error message on failure, null on success.
 */
function removeDirectory(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * `git worktree remove` on Windows can deregister the tree and delete `.git` and the tracked
 * files, then fail on the ignored tail and report the whole thing as a failure. The usual cause
 * is the worktree-local junction CLAUDE.md tells sessions to create — `node_modules/@arke-studio/
 * desktop -> <worktree>/apps/desktop` — which git leaves dangling by deleting `apps/` first and
 * then cannot read. Eleven removals failed that way on 2026-09-11, each leaving ~330 MB and a
 * folder that resolves to `main`. When git has genuinely let go — no `.git`, not listed — the
 * remainder is safe to take by other means; when git still holds it, the refusal stands and its
 * reason is printed.
 */
function finishRemoval(path) {
  const stillRegistered = worktrees().some((tree) => pathKey(tree.path) === pathKey(path));
  if (stillRegistered || existsSync(join(path, ".git"))) return `git: ${lastGitError || "no reason given"}`;
  return removeDirectory(path);
}

for (const r of worktreeRemovals) {
  if (git(["worktree", "remove", r.path], mainCheckout) === null) {
    const why = finishRemoval(r.path);
    if (why !== null) {
      console.error(`failed  worktree ${r.path} — left in place (${why})`);
      failed += 1;
      continue;
    }
  }
  worktreesGone += 1;
}
for (const r of orphanRemovals) {
  const why = removeDirectory(r.path);
  if (why !== null) {
    console.error(`failed  orphan   ${r.path} — left in place (${why})`);
    failed += 1;
  } else orphansGone += 1;
}
for (const r of branchRemovals) {
  // `-D`, not `-d`: `-d` measures against the CURRENT HEAD, which is routinely behind origin/main
  // and would refuse branches this script has already proved are contained in the base ref. The
  // ancestor test above is the real gate; the manifest is the undo.
  if (git(["branch", "-D", r.name], mainCheckout) === null) {
    console.error(`failed  branch   ${r.name} — left in place (git: ${lastGitError || "no reason given"})`);
    failed += 1;
  } else branchesGone += 1;
}
git(["worktree", "prune"], mainCheckout);

console.log(
  `\nRemoved ${worktreesGone} worktree(s) and ${orphansGone} orphan folder(s), deleted ${branchesGone} branch(es).`,
);
console.log(`Manifest: ${manifestPath}`);
if (failed > 0) {
  console.error(`${failed} removal(s) failed and were left alone.`);
  process.exitCode = 1;
}
