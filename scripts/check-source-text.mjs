import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync(
  "git",
  ["ls-files", "-z", "packages/*/src/**", "apps/*/src/**"],
  { cwd: root, encoding: "utf8" },
).split("\0").filter(Boolean);
// Bundled publication fonts are binary assets; their hashes are checked by the
// desktop packaging gate. Keep the NUL-byte check on source and font notices.
const corrupted = files.filter((file) =>
  !/^packages\/coordinator\/src\/publications\/fonts\/[^/]+\.ttf$/.test(file)
  && readFileSync(join(root, file)).includes(0));

if (corrupted.length > 0) {
  console.error(`Tracked source files contain NUL bytes:\n${corrupted.join("\n")}`);
  process.exit(1);
}

// coordinator.ts kept growing about 1,200 lines a week after the 2026-09-05 placement rule, one
// `case` per new command (issue 2786). A new command now has somewhere else to go, a domain module
// under src/commands/ (issue 2796), and the budget comes down as each domain moves there. It still
// warns rather than fails while the switch holds most domains.
const COORDINATOR = "packages/coordinator/src/coordinator.ts";
const COORDINATOR_BUDGET = { lines: 25155, cases: 399 };
const coordinator = readFileSync(join(root, COORDINATOR), "utf8");
const lines = coordinator.split("\n").length;
const cases = (coordinator.match(/^\s*case\s/gm) ?? []).length;
if (lines > COORDINATOR_BUDGET.lines || cases > COORDINATOR_BUDGET.cases) {
  console.log(`::warning file=${COORDINATOR}::coordinator.ts has ${lines} lines and ${cases} case labels, over its budget of ${COORDINATOR_BUDGET.lines} and ${COORDINATOR_BUDGET.cases}: put new behaviour in its domain module (scripts/check-source-text.mjs)`);
}
