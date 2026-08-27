// The test half of CI, for one shard.
//
// Measured 2026-08-27: the coordinator suite is 393s of the repo's 443s of test time — 89% of it
// in one workspace, with no hot file inside it to remove (the slowest 30 suites of 404 are only
// 53% of its elapsed time, and half the suites are under a second). So the way to cut wall clock
// is more runners, not fewer tests, and the tests that would be cut are the ones that kill a
// process and prove recovery did not double-spend.
//
// Coordinator is therefore split across runners with node's own `--test-shard`, which divides the
// *discovered* file list. That matters more than the balance: a test file added tomorrow joins a
// shard by arithmetic, and no file can belong to none. A hand-written list of directories would
// have let a new folder be silently untested, which is the same failure this script's assertion
// exists to prevent.
//
// Every other workspace together is 50s, so they ride on one shard whole rather than being split
// into pieces smaller than their own start-up cost.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The workspace whose suite is large enough to be worth splitting. */
const SHARDED = "@arke-studio/coordinator";

const shardArg = process.argv[2] ?? "1/1";
const [index, total] = shardArg.split("/").map(Number);
if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
  console.error(`ci-test: expected a shard like 2/4, got "${shardArg}"`);
  process.exit(2);
}

/** Every workspace that carries a test script, as {name, dir}. */
function workspacesWithTests() {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const found = [];
  for (const pattern of manifest.workspaces ?? []) {
    // The globs this repo uses are all a single trailing `*`; anything else needs real globbing
    // and should fail loudly here rather than quietly matching nothing.
    if (!pattern.endsWith("/*")) throw new Error(`ci-test: unsupported workspace pattern "${pattern}"`);
    const parent = join(root, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(parent, entry.name);
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.scripts?.test) found.push({ name: pkg.name, dir });
    }
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : 1));
}

const all = workspacesWithTests();

// The assertion the whole design rests on. A workspace that stops carrying tests, or is renamed,
// silently removes itself from CI otherwise — and with no required checks on this repo, a suite
// that does not run is a suite that cannot fail a merge.
if (!all.some((w) => w.name === SHARDED)) {
  console.error(`ci-test: ${SHARDED} carries no test script. Either it was renamed, or its tests`);
  console.error(`ci-test: stopped running. Fix this script rather than letting the suite vanish.`);
  process.exit(2);
}

const others = all.filter((w) => w.name !== SHARDED);

/** Run one command, streaming its output, and report whether it passed. */
function run(label, command, args, cwd) {
  console.log(`\n=== ${label}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  // A signal death has no exit code; treat anything that is not a clean 0 as a failure.
  const ok = result.status === 0;
  if (!ok) console.log(`=== ${label} FAILED (status ${result.status}, signal ${result.signal ?? "none"})`);
  return ok;
}

const failures = [];

// The shard of the big suite. `--test-shard` needs its flags before the pattern, and the pattern
// stays quoted so node expands it identically on both platforms rather than the shell doing it
// on one of them.
const coordinator = all.find((w) => w.name === SHARDED);
if (!run(
  `${SHARDED} shard ${index}/${total}`,
  "node",
  ["--import", "tsx", "--test", `--test-shard=${index}/${total}`, "test/**/*.test.ts"],
  coordinator.dir,
)) {
  failures.push(`${SHARDED} shard ${index}/${total}`);
}

// Everything else, once. On the second shard where there is one, because the first also carries
// lint, types and build in CI — piling the other workspaces there too would make shard 1 the long
// pole and waste the parallelism. With a single shard it has nowhere else to go.
const othersShard = Math.min(2, total);
if (index === othersShard) {
  for (const workspace of others) {
    if (!run(workspace.name, "npm", ["test"], workspace.dir)) failures.push(workspace.name);
  }
}

console.log(`\n=== shard ${index}/${total} summary`);
console.log(`ran: ${SHARDED} shard ${index}/${total}${index === othersShard ? `, plus ${others.length} other workspaces` : ""}`);

if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("all green");
