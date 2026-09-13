import { spawn } from "node:child_process";
import { once } from "node:events";
import { ownedChildHooks } from "../../../src/harness/owned-child.ts";
import { platformProbe } from "../../../src/child-ledger.ts";

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
    const info = (await platformProbe([pids.helper])).get(pids.helper);
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
