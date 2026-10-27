import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { LocalGpu } from "../src/local-ai/gpu.js";
import { MingProcess } from "../src/local-ai/ming.js";
import { ChildLedger } from "../src/child-ledger.js";
import { NativeSetupProcessJob } from "../src/setup/process-job.js";
import { tempDir } from "./tmp.js";
import { untilAsync } from "./wait.js";

it("holds the GPU until its native batch process exits, strips credentials, and can run another batch", { timeout: 120_000 }, async () => {
  const root = await tempDir("ming-native-");
  const worker = join(root, "worker.mjs"), output = join(root, "ready.json");
  await writeFile(worker, `import {writeFileSync} from 'node:fs';
console.error('native worker diagnostic');
writeFileSync(process.argv[2], JSON.stringify({pid:process.pid, key:process.env.OPENAI_API_KEY, offline:process.env.HF_HUB_OFFLINE, temp:process.env.TEMP, cwd:process.cwd()}));
if(process.argv[3]!=='once') setInterval(()=>{},1000);`);
  const ledger = new ChildLedger(join(root, "children.json"));
  // Exercise the same native lifecycle on CI without requiring Python or a downloaded model.
  const processOwner = new MingProcess(ledger, { prepareCommand: (command, args) => ({ command, args: args.slice(1) }) });
  const gpu = new LocalGpu((engine, signal) => engine === "Ming" ? processOwner.unload(signal) : Promise.resolve(), ["Ollama", "ComfyUI", "Ming"]);
  const abort = new AbortController();
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-must-stay-in-host";
  const command = { python: process.execPath, worker, args: [output], cacheRoot: join(root, "cache") };
  try {
    const batch = gpu.runMingBatch(signal => processOwner.run(command, signal), abort.signal);
    const rejected = assert.rejects(batch, /cancelled/);
    await untilAsync(async () => readFile(output, "utf8").then(() => true, () => false), "worker ready", 45_000);
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

it("settles failed cancellation while retaining the native process and GPU for cleanup retry", { timeout: 120_000 }, async () => {
  const root = await tempDir("ming-failed-kill-"), worker = join(root, "worker.mjs"), ready = join(root, "ready");
  await writeFile(worker, `import {writeFileSync,appendFileSync} from 'node:fs'; writeFileSync(process.argv[2],String(process.pid)); appendFileSync(process.argv[2]+'.starts','started\\n'); if(process.argv[3]!=='once') setInterval(()=>{},1000);`);
  let refuse = true; const native = new NativeSetupProcessJob();
  const owner = new MingProcess(undefined, { prepareCommand: (command, args) => ({ command, args: args.slice(1) }), job: {
    bind: (pid, signal) => native.bind(pid, signal), active: (pid, signal) => native.active(pid, signal),
    terminate: async (pid, signal) => { if (refuse) throw new Error("synthetic unconfirmed exit"); await native.terminate(pid, signal); },
  } });
  const gpu = new LocalGpu((engine, signal) => engine === "Ming" ? owner.unload(signal) : Promise.resolve(), ["Ollama", "ComfyUI", "Ming"]);
  const abort = new AbortController();
  try {
    const batch = gpu.runMingBatch(signal => owner.run({ python: process.execPath, worker, args: [ready], cacheRoot: join(root, "cache") }, signal), abort.signal);
    const rejected = assert.rejects(batch, /not confirmed process exit/);
    await untilAsync(async () => readFile(ready, "utf8").then(() => true, () => false), "worker ready", 45_000);
    const pid = Number(await readFile(ready, "utf8"));
    abort.abort(new Error("cancelled"));
    await rejected;
    assert.equal(gpu.isBusy("Ming"), true);
    assert.equal(owner.cleanupAuthorized, false, "an unledgered native fixture cannot advertise reviewed cleanup");
    assert.doesNotThrow(() => process.kill(pid, 0));
    let admitted = false;
    const waiting = gpu.acquire("ComfyUI", new AbortController().signal).then(release => { admitted = true; return release; });
    await assert.rejects(gpu.confirmMingCleanup(new AbortController().signal), /not confirmed process exit/);
    assert(!admitted); assert(owner.running); assert.equal(gpu.isBusy("Ming"), true);
    refuse = false;
    await gpu.confirmMingCleanup(new AbortController().signal); (await waiting)();
    assert.throws(() => process.kill(pid, 0));
    assert(!owner.running); assert.equal(gpu.isBusy("Ming"), false);
    assert.equal(await readFile(ready + ".starts", "utf8"), "started\n", "cleanup did not replay the old narration");
    await gpu.runMingBatch(signal => owner.run({ python: process.execPath, worker, args: [ready, "once"], cacheRoot: join(root, "cache") }, signal), new AbortController().signal);
    assert.equal(await readFile(ready + ".starts", "utf8"), "started\nstarted\n", "one newly authorized batch ran after confirmation");
  } finally { refuse = false; abort.abort(); gpu.stop(); await owner.dispose(); }
});

it("a completed Ming parent retains its ordinary helper and the GPU until the helper actually exits", { timeout: 120_000 }, async () => {
  const root = await tempDir("ming-helper-"), worker = join(root, "worker.mjs"), ready = join(root, "helper.json"), finish = join(root, "finish");
  const helper = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);process.exit(0)}},20)`;
  await writeFile(worker, `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore',detached:process.platform==='win32'});child.once('spawn',()=>process.exit(0));child.once('error',()=>process.exit(9));`);
  const owner = new MingProcess(undefined, { prepareCommand: (command, args) => ({ command, args: args.slice(1) }) });
  const gpu = new LocalGpu((engine, signal) => engine === "Ming" ? owner.unload(signal) : Promise.resolve(), ["Ollama", "ComfyUI", "Ming"]);
  let completed = false;
  const batch = gpu.runMingBatch(signal => owner.run({ python: process.execPath, worker, args: [], cacheRoot: join(root, "cache") }, signal), new AbortController().signal)
    .then(() => { completed = true; });
  try {
    await untilAsync(async () => readFile(ready, "utf8").then(() => true, () => false), "Ming's ordinary helper", 45_000);
    const pid = JSON.parse(await readFile(ready, "utf8")).pid as number;
    assert(owner.running); assert(gpu.isBusy("Ming")); assert(!completed); process.kill(pid, 0);
    let admitted = false;
    const next = gpu.acquire("ComfyUI", new AbortController().signal).then(release => { admitted = true; return release; });
    assert(!admitted); await writeFile(finish, "finish"); await batch; (await next)();
    assert(completed); assert(!owner.running); assert(!gpu.isBusy("Ming"));
  } finally { await writeFile(finish, "finish"); gpu.stop(); await owner.dispose(); await batch.catch(() => {}); }
});
