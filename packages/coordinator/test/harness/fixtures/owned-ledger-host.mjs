import { spawn } from "node:child_process";
import { once } from "node:events";
import { ChildLedger } from "../../../src/child-ledger.ts";
import { ownedChildHooks } from "../../../src/harness/owned-child.ts";

const [command, ledgerPath] = process.argv.slice(2);
const child = spawn(command, ["-e", `
  const { spawn } = require('node:child_process');
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.stdout.write(JSON.stringify({ pid: process.pid, helper: helper.pid }));
  setInterval(() => {}, 1000);
`], {
  detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
// Publish the detached root immediately so a failed ledger/admission regression can
// still kill the actual group after terminating this host.
process.stdout.write(JSON.stringify({ pid: child.pid }) + "\n");
const hooks = ownedChildHooks("codex", command, { ledger: new ChildLedger(ledgerPath) });
const evidence = once(child.stdout, "data");
await hooks.onSpawn(child);
process.stdout.write(JSON.stringify({ ...JSON.parse((await evidence)[0].toString()), ready: true }) + "\n");
setInterval(() => {}, 1000);
