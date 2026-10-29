import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { mingOwnerSettled, mingStorageOwner } from "../src/local-ai/ming-owner.js";
import { inspectOwnedCommandJob, NativeSetupProcessJob } from "../src/setup/process-job.js";
import { tempDir } from "./tmp.js";
import { untilAsync } from "./wait.js";

const token = "a".repeat(64), id = `ming_123_100000_${token}`;
it("reconciliation requires the original host to be gone and its exact native job to be empty", async () => {
  let queries = 0, count: number | null = null;
  const inspect = async (name: string) => { queries++; assert.equal(name, `Global\\ArkeOwnedCommand-${token}`); return count; };
  const signal = new AbortController().signal;
  for (const startedAt of [100000, null]) {
    assert(!await mingOwnerSettled(id, signal, {probe: async () => new Map([[123, {pid: 123, image: "node", startedAt}]]), inspect}));
  }
  assert.equal(queries, 0, "a live/unknown owner can still launch into an empty job");
  const probe = async () => new Map();
  count = 1; assert(!await mingOwnerSettled(id, signal, {probe, inspect}));
  count = 0; assert(await mingOwnerSettled(id, signal, {probe, inspect}));
  count = null; assert(await mingOwnerSettled(id, signal, {probe, inspect}));
  assert(!await mingOwnerSettled(id, signal, {probe, inspect: async () => { throw new Error("access denied"); }}));
  assert(!await mingOwnerSettled(id, AbortSignal.abort(), {probe, inspect}));
  assert(!await mingOwnerSettled("ming_invalid", signal, {probe, inspect}));
});

it("a private global job is inspectable without creating a missing job or trusting a local-session alias", {skip: process.platform !== "win32", timeout: 45_000}, async () => {
  const job = new NativeSetupProcessJob("global");
  const owner = mingStorageOwner(job.identity);
  assert.equal(await inspectOwnedCommandJob(job.identity, new AbortController().signal), null);
  assert(!await mingOwnerSettled(owner, new AbortController().signal), "the host remains alive even before launch");
  await assert.rejects(inspectOwnedCommandJob(job.identity.replace("Global", "Local"), new AbortController().signal), /unavailable/);
});

it("a force-closed original host releases its Windows job only after its ordinary worker exits", {skip: process.platform !== "win32", timeout: 120_000}, async () => {
  const root = await tempDir("ming-owner-restart-"), worker = join(root, "worker.mjs"), marker = join(root, "worker-pid");
  await writeFile(worker, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
  const host = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/ming-owner-host.ts", import.meta.url)), root, worker], {windowsHide: true, stdio: "ignore"});
  const exited = new Promise<void>(resolve => host.once("close", () => resolve()));
  try {
    await untilAsync(async () => readFile(marker, "utf8").then(() => true, () => false), "native Ming owner", 45_000);
    const owner = await readFile(join(root, "owner"), "utf8"), pid = Number(await readFile(marker, "utf8"));
    assert(!await mingOwnerSettled(owner, new AbortController().signal));
    host.kill("SIGKILL"); await exited;
    await untilAsync(async () => mingOwnerSettled(owner, new AbortController().signal), "old Ming ownership settled", 30_000);
    assert.throws(() => process.kill(pid, 0));
  } finally { if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL"); await exited; }
});
