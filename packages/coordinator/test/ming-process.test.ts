import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { LocalGpu } from "../src/local-ai/gpu.js";
import { MingProcess } from "../src/local-ai/ming.js";
import { ChildLedger } from "../src/child-ledger.js";
import { tempDir } from "./tmp.js";
import { untilAsync } from "./wait.js";

it("holds the GPU until its native batch process exits, strips credentials, and can run another batch", { timeout: 60_000 }, async () => {
  const root = await tempDir("ming-native-");
  const worker = join(root, "worker.mjs"), output = join(root, "ready.json");
  await writeFile(worker, `import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({pid:process.pid, key:process.env.OPENAI_API_KEY, offline:process.env.HF_HUB_OFFLINE, temp:process.env.TEMP}));
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
    let admitted = false;
    const next = gpu.acquire("ComfyUI", new AbortController().signal).then(release => { admitted = true; return release; });
    assert.equal(admitted, false);
    abort.abort(new Error("cancelled"));
    await rejected;
    (await next)();
    assert.throws(() => process.kill(ready.pid, 0));
    await gpu.runMingBatch(signal => processOwner.run({ ...command, args: [output, "once"] }, signal), new AbortController().signal);
    const rows = JSON.parse(await readFile(join(root, "children.json"), "utf8"));
    assert.deepEqual(rows.children, []);
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
    abort.abort(); gpu.stop(); await processOwner.dispose();
  }
});
