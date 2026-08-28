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
//
// The other half of the job is telling a hung shard from a slow one. That is why the child's
// output is relayed here rather than inherited — see SILENCE_LIMIT_MS.

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The workspace whose suite is large enough to be worth splitting. */
const SHARDED = "@arke-studio/coordinator";

/**
 * How long a step may print nothing before it is called hung rather than slow.
 *
 * Measured on CI, 2026-08-28, over all eight shards of one green run: the longest a healthy shard
 * went without printing was **26s** on windows-latest (9s, 23s, 24s, 26s) and 5s on
 * ubuntu-latest. Eight minutes is eighteen times the worst of those.
 *
 * Generous on purpose. A limit that fires on a slow runner recreates the exact failure this
 * replaces — a red check that means "busy", which teaches everyone to re-run and look away.
 * Being late to a genuine hang costs a few minutes of runner time; being early costs the
 * credibility of every red check on the repo.
 *
 * The summary prints the longest silence each run actually saw, so the next person to wonder
 * whether this number still holds can read it off a log instead of measuring again.
 */
const SILENCE_LIMIT_MS = 8 * 60_000;

/** The largest gap between two bytes of output across every step this shard ran. */
let longestSilence = 0;

/** The step the silence guard gave up on, if one stopped printing. */
let hungStep = null;

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

/**
 * Kill a child and everything below it, reporting what stopped it or null.
 *
 * Everything below it, not just it. There is always something between us and the process that is
 * actually stuck: on Windows `shell: true` puts cmd.exe in the way, and on Linux `npm test` runs
 * the real test runner as a grandchild with inherited stdio. Kill only the child and the
 * grandchild lives on holding the pipe — and `close` needs both an exit and a closed pipe, so the
 * wait in `run` would never end and the job would burn to the ceiling anyway.
 */
function killTree(pid) {
  if (process.platform === "win32") {
    const done = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return done.error ? `taskkill: ${done.error.message}` : null;
  }
  try {
    // A negative pid is the process group, which `detached` below made this child the leader of.
    process.kill(-pid, "SIGKILL");
    return null;
  } catch (err) {
    // Already gone is the ordinary case, not a problem worth a line in the log.
    return err.code === "ESRCH" ? null : `kill: ${err.message}`;
  }
}

/**
 * Run one command, relaying its output, and report whether it passed.
 *
 * Relayed rather than inherited so the gaps in it can be watched. A leaked file watcher and a
 * busy runner take the same amount of wall clock to look alarming, which is why the job ceiling
 * could not tell them apart (#560) — but they look nothing alike to the test runner, which keeps
 * printing a line per test right up until the moment it stops. So the hang is caught on silence,
 * and the ceiling is left as a backstop for the one case silence misses: a suite that never ends
 * and never stops talking.
 */
async function run(label, command, args, cwd) {
  console.log(`\n=== ${label}`);
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // Windows needs a shell to reach `npm.cmd`; POSIX needs its own process group instead, so the
    // kill above can take the grandchildren with it. Neither platform gets both.
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });

  let lastOutputAt = Date.now();
  let lastLine = "";
  let escapeHatch = null;
  const relay = (out) => (chunk) => {
    const now = Date.now();
    // Reported in the summary. The limit above was measured once and the suite keeps growing;
    // this is the line that says how much of it is left, without anyone having to measure again.
    longestSilence = Math.max(longestSilence, now - lastOutputAt);
    lastOutputAt = now;
    const lines = chunk.toString().split("\n").filter((line) => line.trim() !== "");
    if (lines.length > 0) lastLine = lines[lines.length - 1];
    out.write(chunk);
  };
  child.stdout.on("data", relay(process.stdout));
  child.stderr.on("data", relay(process.stderr));

  const watch = setInterval(() => {
    const silentFor = Date.now() - lastOutputAt;
    if (silentFor < SILENCE_LIMIT_MS) return;
    clearInterval(watch);
    hungStep = label;
    longestSilence = Math.max(longestSilence, silentFor);
    console.log(`\n=== ${label} HUNG: nothing printed for ${Math.round(silentFor / 1000)}s`);
    // Naming it is the point: on a leak it is the test that leaked. A step that hung before
    // printing anything at all says so, rather than trailing off after the colon.
    console.log(`=== last line was: ${lastLine === "" ? "(it never printed anything)" : lastLine.trim()}`);
    console.log(`=== A suite that has stopped printing has stopped working — the usual cause is`);
    console.log(`=== a file watcher or a database handle left open by the test above.`);
    // Killing it closes the pipes being read here, which ends the wait below and leaves by the
    // ordinary route — so the summary still prints and there is one way out of this script
    // rather than two.
    const stuck = child.pid === undefined ? "no pid to kill" : killTree(child.pid);
    if (stuck !== null) console.log(`=== the kill reported: ${stuck}`);
    // And a way out even if it did not work. A guard that waits forever for a kill that never
    // landed is one more path to the ceiling, which is the thing being replaced. Ten seconds is
    // long past when a SIGKILL or a taskkill /F has either worked or failed for good.
    escapeHatch = setTimeout(() => {
      console.log(`=== ${label}: the kill did not take, leaving without it`);
      process.exit(1);
    }, 10_000);
  }, 10_000);

  const { status, signal } = await new Promise((resolve) => {
    child.on("error", (err) => resolve({ status: null, signal: err.message }));
    child.on("close", (code, sig) => resolve({ status: code, signal: sig }));
  });
  clearInterval(watch);
  if (escapeHatch !== null) clearTimeout(escapeHatch);
  // The tail counts too: a suite whose last test passed and then took a minute to shut down was
  // silent for that minute, and a number that quietly omitted it would understate the trend.
  longestSilence = Math.max(longestSilence, Date.now() - lastOutputAt);
  // A signal death has no exit code; treat anything that is not a clean 0 as a failure — and a
  // step the guard killed counts as failed whatever status the kill happened to leave behind.
  const ok = status === 0 && hungStep !== label;
  if (!ok) console.log(`=== ${label} FAILED (status ${status}, signal ${signal ?? "none"})`);
  return ok;
}

const failures = [];

// The shard of the big suite. `--test-shard` needs its flags before the pattern, and the pattern
// stays quoted so node expands it identically on both platforms rather than the shell doing it
// on one of them.
const coordinator = all.find((w) => w.name === SHARDED);
if (!(await run(
  `${SHARDED} shard ${index}/${total}`,
  "node",
  ["--import", "tsx", "--test", `--test-shard=${index}/${total}`, "test/**/*.test.ts"],
  coordinator.dir,
))) {
  failures.push(`${SHARDED} shard ${index}/${total}`);
}

// Everything else, once. On the second shard where there is one, because the first also carries
// lint, types and build in CI — piling the other workspaces there too would make shard 1 the long
// pole and waste the parallelism. With a single shard it has nowhere else to go.
const othersShard = Math.min(2, total);
let othersRan = 0;
// A hang is terminal. Whatever leaked is still leaking, and the next workspace would only spend
// another eight minutes finding that out.
if (index === othersShard && hungStep === null) {
  for (const workspace of others) {
    if (!(await run(workspace.name, "npm", ["test"], workspace.dir))) failures.push(workspace.name);
    if (hungStep !== null) break;
    othersRan += 1;
  }
}

console.log(`\n=== shard ${index}/${total} summary`);
// Counted rather than assumed: a shard that stopped early must not claim the workspaces it never
// reached, or its summary becomes one more line that reads like a healthy run.
console.log(`ran: ${SHARDED} shard ${index}/${total}${othersRan > 0 ? `, plus ${othersRan} other workspaces` : ""}`);
console.log(
  `quietest moment: ${Math.round(longestSilence / 1000)}s without output, against a limit of ${SILENCE_LIMIT_MS / 1000}s`,
);

if (hungStep !== null) console.log(`stopped early: ${hungStep} was killed for going quiet`);

if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("all green");
