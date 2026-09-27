import { spawn } from "node:child_process";
import { once } from "node:events";
import { ownedChildHooks } from "../../../src/harness/owned-child.ts";
import { probeProcesses } from "../../../src/child-ledger.ts";

const mode = process.argv[2];
const child = spawn(process.execPath, ["-e", `
  const { spawn } = require('node:child_process');
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  process.stdout.write(JSON.stringify({ root: process.pid, helper: helper.pid }));
  setInterval(() => {}, 1000);
`], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const ready = once(child.stdout, "data").then(([chunk]) => {
  const pids = JSON.parse(chunk.toString());
  // Publish ownership before a test seam can wait, so even a failed regression can reap
  // its fixtures after terminating the host.
  process.stdout.write(JSON.stringify(pids));
  return pids;
});
const never = () => new Promise(() => {});
let rows = [];
const hooks = ownedChildHooks("codex-exit-fixture", process.execPath, {
  // Deliberately remove the kernel leash: this regression must prove the exit callback.
  leash: async () => ({ ok: false }), listDescendants: async () => rows,
  ...(mode === "during-spawn" ? { ledger: { record: never, release: async () => {} } } : {}),
  ...(mode === "orphan" ? { probe: never } : {}),
});
if (mode === "during-spawn") {
  void hooks.onSpawn(child);
} else {
  const pids = await ready;
  if (mode === "orphan") {
    // Setup, not what is under test: the identity the exit path will kill by. On a loaded
    // Windows runner this one query has taken longer than the app's 30 seconds, and the host
    // then died with exit 1 before the regression it exists for ever ran.
    const info = (await probeProcesses([pids.helper], { timeoutMs: 90_000 })).get(pids.helper);
    if (!info) throw new Error("Fixture helper exited before ownership was recorded.");
    rows = [{ ...info, parentPid: child.pid }];
  }
  await hooks.onSpawn(child);
}
await ready;
if (mode === "orphan") {
  child.kill("SIGKILL");
  await once(child, "exit");
}
// Skip adapter.dispose()/host shutdown completely, but flush test evidence before exiting.
process.stdout.write("", () => process.exit(17));
