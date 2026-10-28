import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { mingSpeechChunks, MingSpeechService, type MingSpeechDeps } from "../src/local-ai/ming-speech.js";
import { MING_ASSETS } from "../src/local-ai/ming-catalogue.js";
import { MingProcess } from "../src/local-ai/ming.js";
import { NativeSetupProcessJob } from "../src/setup/process-job.js";
import { tempDir } from "./tmp.js";
import { untilAsync } from "./wait.js";

const bytes = Buffer.from("asset");
const hash = createHash("sha256").update(bytes).digest("hex");
it("limits very short-word passages to forty words without dropping text", () => {
  const text = "I am in it. ".repeat(50).trim();
  const chunks = mingSpeechChunks(text);
  assert.equal(chunks.join(" "), text);
  assert.ok(chunks.every(chunk => chunk.split(/\s+/u).length <= 40 && chunk.length <= 240));
});
const input = {model: "ming-3-0.5b", text: "One sentence. ".repeat(45).trim(), language: "en", instructions: "Quiet anger.",
  reference: {name: "voice.wav", contentType: "audio/wav" as const, data: bytes, transcript: "The reference words."}};

async function fixture(run: MingSpeechDeps["run"], processRunning = () => false) {
  const root = await tempDir("ming-speech-");
  const assets = structuredClone(MING_ASSETS);
  for (const row of [assets.source, assets.sdk, ...Object.values(assets.variants).flatMap(variant => [...variant.models, ...variant.wheels])]) {row.bytes = bytes.length; row.sha256 = hash;}
  for (const [variant, data] of Object.entries(assets.variants)) {
    for (const row of [assets.source, assets.sdk, ...data.wheels, ...data.models]) {
      const place = data.models.includes(row as typeof data.models[number]) ? "models" : "runtime";
      const path = join(root, "models", "ming", place, variant, row.file);
      await mkdir(dirname(path), {recursive: true}); await writeFile(path, bytes);
    }
  }
  const service = new MingSpeechService({appRoot: root, assets, platform: "win32", arch: "x64", python: async () => process.execPath,
    processRunning, run});
  return {service, root};
}

it("verifies the closure and sends all text chunks with one reference/direction, then removes private inputs", async () => {
  let batch = "";
  const {service} = await fixture(async command => {
    const path = command.args[1]!; batch = dirname(path);
    const request = JSON.parse(await readFile(path, "utf8"));
    assert.equal(request.chunks.join(" "), input.text);
    assert.ok(request.chunks.length > 1 && request.chunks.every((text: string) => text.length <= 240));
    assert.equal(request.instructions, input.instructions); assert.equal(request.transcript, input.reference.transcript);
    assert.deepEqual(await readFile(request.reference), bytes);
    await writeFile(request.output, Buffer.alloc(48));
    await writeFile(join(batch, "result.json"), JSON.stringify({completedChunks: request.chunks.length}));
  });
  assert.equal((await service.status(input.model)).ready, true);
  assert.equal((await service.synthesize(input, new AbortController().signal)).length, 48);
  assert.equal(await stat(batch).catch(() => null), null);
});

it("refuses changed weights before launch and refuses partial chunk success", async () => {
  let launches = 0;
  const {service, root} = await fixture(async command => {
    launches++;
    const request = JSON.parse(await readFile(command.args[1]!, "utf8"));
    await writeFile(request.output, Buffer.alloc(48));
    await writeFile(join(dirname(request.output), "result.json"), JSON.stringify({completedChunks: 0}));
  });
  await assert.rejects(service.synthesize(input, new AbortController().signal), /every narration chunk/);
  await writeFile(join(root, "models/ming/models/dense/model.safetensors"), "other");
  await assert.rejects(service.synthesize(input, new AbortController().signal), /verification failed/);
  assert.equal(launches, 1);
});

it("file mutation fences new readers and an admitted reader fences destructive changes", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {finish = resolve;});
  const {service} = await fixture(async () => pending);
  const release = service.reserveFileChange();
  await assert.rejects(service.synthesize(input, new AbortController().signal), /files are being changed/);
  release();
  const reading = service.synthesize(input, new AbortController().signal);
  assert.throws(() => service.reserveFileChange(), /Stop the current Ming reading/);
  finish();
  await assert.rejects(reading); // The stand-in intentionally writes no result.
  service.reserveFileChange()();
});

it("surfaces a controlled short-read refusal after confirmed worker exit instead of publishing audio", async () => {
  const {service} = await fixture(async command => {
    await writeFile(join(dirname(command.args[1]!), "failure.json"), JSON.stringify({reason: "Ming stopped too early. Try a shorter passage."}));
    throw new Error("Worker exited with failure");
  });
  await assert.rejects(service.synthesize(input, new AbortController().signal), /Ming stopped too early/);
});

it("retains the exact failed native batch until later confirmed cleanup without replay", async () => {
  let batch = "", releases!: () => Promise<void>, launches = 0;
  const {service} = await fixture(async command => {
    launches++; batch = dirname(command.args[1]!);
    releases = command.retain!();
    throw new Error("native exit remains unknown");
  }, () => true);
  await assert.rejects(service.synthesize(input, new AbortController().signal), /exit remains unknown/);
  assert((await stat(batch)).isDirectory());
  assert.deepEqual(await readFile(join(batch, "reference.wav")), bytes);
  await releases();
  assert.equal(await stat(batch).catch(() => null), null);
  await releases();
  assert.equal(launches, 1);
});

it("a queued batch cancelled before native admission cleans only its own inputs while another worker runs", async () => {
  let batch = "";
  const {service} = await fixture(async command => {
    batch = dirname(command.args[1]!);
    // The GPU lane refused admission, so the native owner never retained this command.
    throw new Error("cancelled in GPU queue");
  }, () => true);
  await assert.rejects(service.synthesize(input, new AbortController().signal), /cancelled in GPU queue/);
  assert.equal(await stat(batch).catch(() => null), null);
});

it("native release leaves inputs available until the host has finished reading the batch result", async () => {
  let batch = "";
  const {service} = await fixture(async command => {
    batch = dirname(command.args[1]!);
    const request = JSON.parse(await readFile(command.args[1]!, "utf8"));
    const release = command.retain!();
    await writeFile(request.output, Buffer.alloc(48));
    await writeFile(join(batch, "result.json"), JSON.stringify({completedChunks: request.chunks.length}));
    await release();
    assert.deepEqual(await readFile(request.reference), bytes);
    assert((await stat(request.output)).isFile());
  });
  assert.equal((await service.synthesize(input, new AbortController().signal)).length, 48);
  assert.equal(await stat(batch).catch(() => null), null);
});

it("the speech service removes its retained inputs after the real original worker is confirmed stopped", {timeout: 120_000}, async () => {
  let refuse = true, batch = "", worker = "";
  const native = new NativeSetupProcessJob();
  const owner = new MingProcess(undefined, {prepareCommand: (command, args) => ({command, args: args.slice(1)}), job: {
    bind: (pid, signal) => native.bind(pid, signal), active: (pid, signal) => native.active(pid, signal),
    terminate: async (pid, signal) => { if (refuse) throw new Error("synthetic unavailable cleanup"); await native.terminate(pid, signal); },
  }});
  const {service, root} = await fixture((command, signal) => {
    batch = dirname(command.args[1]!);
    return owner.run({...command, worker}, signal);
  }, () => owner.running);
  worker = join(root, "worker.mjs");
  const ready = join(root, "ready");
  await writeFile(worker, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  const abort = new AbortController();
  try {
    const reading = service.synthesize(input, abort.signal);
    const rejected = assert.rejects(reading, /not confirmed process exit/);
    await untilAsync(async () => readFile(ready, "utf8").then(() => true, () => false), "speech native worker", 45_000);
    const pid = Number(await readFile(ready, "utf8"));
    abort.abort(); await rejected;
    assert.deepEqual(await readFile(join(batch, "reference.wav")), bytes);
    assert.throws(() => service.reserveFileChange(), /Stop the current Ming reading/);
    assert.doesNotThrow(() => process.kill(pid, 0));
    refuse = false; await owner.unload(new AbortController().signal);
    assert.throws(() => process.kill(pid, 0));
    assert.equal(await stat(batch).catch(() => null), null);
    service.reserveFileChange()();
  } finally { refuse = false; abort.abort(); await owner.dispose(); }
});
