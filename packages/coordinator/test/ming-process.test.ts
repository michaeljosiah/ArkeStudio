import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { LocalGpu } from "../src/local-ai/gpu.js";
import { MingProcess } from "../src/local-ai/ming.js";
import { ChildLedger, killTree } from "../src/child-ledger.js";
import { tempDir } from "./tmp.js";
import { untilAsync } from "./wait.js";

it("holds the GPU until its native batch process exits, strips credentials, and can run another batch", { timeout: 60_000 }, async () => {
  const root = await tempDir("ming-native-");
  const worker = join(root, "worker.mjs"), output = join(root, "ready.json");
  await writeFile(worker, `import {writeFileSync} from 'node:fs';
console.error('native worker diagnostic');
writeFileSync(process.argv[2], JSON.stringify({pid:process.pid, key:process.env.OPENAI_API_KEY, offline:process.env.HF_HUB_OFFLINE, temp:process.env.TEMP, cwd:process.cwd()}));
if(process.argv[3]!=='once') setInterval(()=>{},1000);`);
  const ledger = new ChildLedger(join(root, "children.json"));
  // Exercise the same native lifecycle on CI without requiring Python or a downloaded model.
  const processOwner = new MingProcess(ledger, (command, args, options) => spawn(command, args.slice(1), options));
  const gpu = new LocalGpu((engine, signal) => engine === "Ming" ? processOwner.unload(signal) : Promise.resolve(), ["Ollama", "ComfyUI", "Ming"]);
  const abort = new AbortController();
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-must-stay-in-host";
  const command = { python: process.execPath, worker, args: [output], cacheRoot: join(root, "cache") };
  try {
    const batch = gpu.runMingBatch(signal => processOwner.run(command, signal), abort.signal);
    const rejected = assert.rejects(batch, /cancelled/);
    await untilAsync(async () => readFile(output, "utf8").then(() => true, () => false), "worker ready");
    const ready = JSON.parse(await readFile(output, "utf8"));
    assert.equal(ready.key, undefined);
    assert.equal(ready.offline, "1");
    assert.equal(ready.temp, join(root, "cache", "temp"));
    assert.equal(ready.cwd, join(root, "cache"));
    let admitted = false;
    const next = gpu.acquire("ComfyUI", new AbortController().signal).then(release => { admitted = true; return release; });
    assert.equal(admitted, false);
    abort.abort(new Error("cancelled"));
    await rejected;
    (await next)();
    assert.throws(() => process.kill(ready.pid, 0));
    assert.match(await readFile(join(root, "cache", "worker.log"), "utf8"), /native worker diagnostic/);
    await gpu.runMingBatch(signal => processOwner.run({ ...command, args: [output, "once"] }, signal), new AbortController().signal);
    const rows = JSON.parse(await readFile(join(root, "children.json"), "utf8"));
    assert.deepEqual(rows.children, []);
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
    abort.abort(); gpu.stop(); await processOwner.dispose();
  }
});

it("settles failed cancellation while retaining the native process and GPU for cleanup retry", { timeout: 60_000 }, async () => {
  const root = await tempDir("ming-failed-kill-"), worker = join(root, "worker.mjs"), ready = join(root, "ready");
  await writeFile(worker, `import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);`);
  let refuse = true;
  const cleanup = { timeoutMs: 50, kill: async (pid: number) => {
    if (refuse) return;
    if (process.platform === "win32") await killTree(pid); else process.kill(-pid, "SIGKILL");
  } };
  const owner = new MingProcess(undefined, (command, args, options) => spawn(command, args.slice(1), options), cleanup);
  const gpu = new LocalGpu((engine, signal) => engine === "Ming" ? owner.unload(signal) : Promise.resolve(), ["Ollama", "ComfyUI", "Ming"]);
  const abort = new AbortController();
  try {
    const batch = gpu.runMingBatch(signal => owner.run({ python: process.execPath, worker, args: [ready], cacheRoot: join(root, "cache") }, signal), abort.signal);
    const rejected = assert.rejects(batch, /not confirmed process exit/);
    await untilAsync(async () => readFile(ready, "utf8").then(() => true, () => false), "worker ready");
    const pid = Number(await readFile(ready, "utf8"));
    abort.abort(new Error("cancelled"));
    await rejected;
    assert.equal(gpu.isBusy("Ming"), true);
    assert.doesNotThrow(() => process.kill(pid, 0));
    refuse = false; cleanup.timeoutMs = 10_000;
    await owner.dispose();
    assert.throws(() => process.kill(pid, 0));
  } finally { refuse = false; cleanup.timeoutMs = 10_000; abort.abort(); gpu.stop(); await owner.dispose(); }
});
