/**
 * Where a test file's time goes, for the Test phases workflow only (issue 2825, finding BT-11).
 * Loaded with `--import` before each file, it times the phases the Windows gap is suspected to live
 * in: copying the fixture world, opening a WorldStore (its scan and index build), syncing a file to
 * disk (what makes a flushed append slow) and removing directories. When the file's process exits it
 * writes one `phase-timing` line. It measures and changes nothing; no ordinary test run loads it.
 */
import fs, { writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { WorldStore } from "../src/world/store.js";

type Phase = "copy" | "open" | "sync" | "remove";
const spent: Record<Phase, { ms: number; calls: number }> = {
  copy: { ms: 0, calls: 0 }, open: { ms: 0, calls: 0 }, sync: { ms: 0, calls: 0 }, remove: { ms: 0, calls: 0 },
};

function timed<F extends (...args: never[]) => Promise<unknown>>(phase: Phase, original: F): F {
  return async function (this: unknown, ...args: Parameters<F>) {
    const start = performance.now();
    try { return await original.apply(this, args); }
    finally { spent[phase].ms += performance.now() - start; spent[phase].calls += 1; }
  } as F;
}

fs.promises.cp = timed("copy", fs.promises.cp);
fs.promises.rm = timed("remove", fs.promises.rm);
// The tests import `cp` and `rm` by name; this carries the replacements into those bindings.
syncBuiltinESMExports();

// FileHandle's prototype is not exported; one handle on a file that always exists reaches it.
const probe = await fs.promises.open(process.execPath, "r");
const handle = Object.getPrototypeOf(probe) as { sync: () => Promise<void>; datasync: () => Promise<void> };
await probe.close();
handle.sync = timed("sync", handle.sync);
handle.datasync = timed("sync", handle.datasync);

(WorldStore as unknown as { open: typeof WorldStore.open }).open = timed("open", WorldStore.open);

process.on("exit", () => {
  const phases = Object.fromEntries(Object.entries(spent).map(([phase, { ms, calls }]) => [phase, { ms: Math.round(ms), calls }]));
  // Written synchronously: an asynchronous write to a pipe can be lost at exit.
  writeSync(2, `phase-timing ${JSON.stringify({ file: process.argv[1], wallMs: Math.round(performance.now()), phases })}\n`);
});
