// The Test phases workflow's table (issue 2825): each file's wall time split into the phases
// `packages/coordinator/test/phase-timing.ts` timed, and what is left. Printed, and written to the
// run's summary, so the two platforms' runs can be laid side by side.
import { appendFileSync, readFileSync } from "node:fs";
import { relative } from "node:path";

const [log, dir] = process.argv.slice(2);
const rows = [];
for (const line of readFileSync(log, "utf8").split("\n")) {
  const found = line.match(/phase-timing (\{.*\})/);
  if (found) rows.push(JSON.parse(found[1]));
}
if (rows.length === 0) {
  console.log("test phases: no file reported its phases; the run stopped before any finished");
  process.exit(1);
}
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const phases = ["copy", "open", "sync", "remove"];
const table = [
  `### Test phases, ${process.platform}`, "",
  "| File | Wall | Copy | Open | Sync | Remove | Rest |", "|---|---:|---:|---:|---:|---:|---:|",
  ...rows.sort((a, b) => b.wallMs - a.wallMs).map((row) => {
    const cells = phases.map((phase) => `${seconds(row.phases[phase].ms)} ×${row.phases[phase].calls}`);
    return `| \`${relative(dir, row.file).replaceAll("\\", "/")}\` | ${seconds(row.wallMs)} | ${cells.join(" | ")} | ${seconds(row.wallMs - row.coveredMs)} |`;
  }),
  "", "Phases nest (opening a store syncs its lock file), so a row's phases can add up to more than the time they took. Rest is the time no phase was under way.", "",
].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
