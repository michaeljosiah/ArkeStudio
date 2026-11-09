// Prints `coordinator=true|false` for CI's job outputs: whether a pull request's changes need the
// coordinator's shards (issue 2812). A push to main, or a diff that cannot be read, always does.
// Usage: node scripts/ci-scope.mjs <event name>

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientFilesRead, coordinatorNeeded } from "./ci-test-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name));
    else if (/\.test\.[cm]?[tj]sx?$/.test(entry.name)) sources.push(readFileSync(join(dir, entry.name), "utf8"));
  }
};

let needed = true;
if (process.argv[2] === "pull_request") {
  try {
    // A pull request is checked out as its merge commit: the first parent is the base it merges into.
    const changed = execFileSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    walk(join(root, "packages/coordinator/test"));
    needed = coordinatorNeeded(changed, clientFilesRead(sources));
    console.error(`${changed.length} changed files; coordinator suite ${needed ? "needed" : "not needed"}`);
  } catch (error) {
    console.error(`could not read the change (${error instanceof Error ? error.message : error}); running everything`);
  }
}
console.log(`coordinator=${needed}`);
