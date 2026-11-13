import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// tsc with a 4 GB heap (issue 2788). The coordinator's import graph needs more than Node's
// default of about 2 GB, so a typecheck on a machine with less than 16 GB aborted out of memory.
// A script rather than NODE_OPTIONS in each package.json, because that syntax differs between
// cmd, PowerShell and sh, and every workspace's typecheck has to run on all three.

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const { status, signal } = spawnSync(process.execPath, ["--max-old-space-size=4096", tsc, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(status ?? (signal === null ? 0 : 1));
