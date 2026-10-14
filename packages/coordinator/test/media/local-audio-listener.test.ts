import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { audioListenerChildEnvironment, createLocalAudioListener, localAudioListenerOptions } from "../../src/media/local-audio-listener.js";
import { writeSpeechWav } from "../../src/audio/speech-wav.js";
const answer = { engine: { id: "local-qwen2-audio-v1", model: "Qwen2-Audio-7B-Instruct", modelHash: "sha256:" + "a".repeat(64), runtime: "test" }, review: "Soft music." };
const bytes = writeSpeechWav({ rate: 16000, samples: new Float32Array(16000) });

test("local listening child preserves required runtime paths without inheriting credentials or proxies", () => {
  const env = audioListenerChildEnvironment({ SystemRoot: "system", PATH: "runtime", TEMP: "scratch", CUDA_PATH: "cuda",
    OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret", HF_TOKEN: "secret", AWS_ACCESS_KEY_ID: "secret",
    AWS_SECRET_ACCESS_KEY: "secret", HTTP_PROXY: "secret", CUSTOM_SERVICE_SECRET: "secret" });
  assert.equal(env["SystemRoot"], "system"); assert.equal(env["PATH"], "runtime");
  assert.equal(env["TEMP"], "scratch"); assert.equal(env["CUDA_PATH"], "cuda");
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HF_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "HTTP_PROXY", "CUSTOM_SERVICE_SECRET"])
    assert.equal(env[key], undefined);
  assert.equal(env["HF_HUB_OFFLINE"], "1"); assert.equal(env["PYTHONNOUSERSITE"], "1");
});

test("native listening protocol sends only WAV/focus, uses offline unshelled execution and refuses invalid/oversized responses", async t => {
  const directory = await mkdtemp(join(tmpdir(), "arke-listening-process-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const worker = join(directory, "worker.py"); await writeFile(worker, "fixture");
  let mode = "valid", calls = 0;
  const spawnFixture = ((command, args, options) => {
    calls++; assert.equal(command, process.execPath); assert.equal(args?.[0], "-I"); assert.ok(args?.includes(worker));
    assert.equal(options?.shell, false); assert.equal(options?.windowsHide, true); assert.equal(options?.env?.["HF_HUB_OFFLINE"], "1");
    const source = args?.includes("--probe") ? "process.stdout.write(JSON.stringify({ready:true}))" : mode === "oversized"
      ? "process.stdout.write('x'.repeat(70000))" : mode === "invalid" ? "process.stdout.write('invalid')"
      : `let raw=''; process.stdin.on('data', c=>raw+=c); process.stdin.on('end',()=>{const input=JSON.parse(raw); if(Object.keys(input).sort().join(',')!=='audio,focuses'||Buffer.from(input.audio,'base64').toString('ascii',0,4)!=='RIFF') process.exit(2); process.stdout.write(${JSON.stringify(JSON.stringify(answer))});});`;
    return spawn(process.execPath, ["-e", source], options);
  }) as typeof spawn;
  const listener = createLocalAudioListener({ python: process.execPath, worker, modelDirectory: directory }, spawnFixture);
  assert.ok(await listener.ready(new AbortController().signal));
  assert.deepEqual(await listener.listen(bytes, ["music"], new AbortController().signal), answer);
  mode = "invalid"; await assert.rejects(listener.listen(bytes, ["music"], new AbortController().signal), /Invalid local/);
  mode = "oversized"; await assert.rejects(listener.listen(bytes, ["music"], new AbortController().signal), /failed/);
  const stop = new AbortController(); stop.abort(); const before = calls;
  await assert.rejects(listener.listen(bytes, ["music"], stop.signal)); assert.equal(calls, before);
});

test("native Stop kills a live worker and settles after its close", async () => {
  let child!: ReturnType<typeof spawn>;
  const listener = createLocalAudioListener({ python: process.execPath, worker: process.execPath, modelDirectory: tmpdir() },
    ((_command, _args, options) => { child = spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], options ?? {}); return child; }) as typeof spawn);
  const stop = new AbortController(), result = listener.listen(bytes, ["music"], stop.signal);
  stop.abort(); await assert.rejects(result, /stopped/); assert.ok(child.killed); assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("incomplete host configuration remains unavailable, and missing runtimes fail readiness before decoding", async () => {
  assert.deepEqual(localAudioListenerOptions(process.execPath, {}), {});
  assert.deepEqual(localAudioListenerOptions(process.execPath, { ARKE_AUDIO_LISTENER_PYTHON: "relative", ARKE_AUDIO_LISTENER_MODEL: tmpdir() }), {});
  assert.throws(() => createLocalAudioListener({ python: "relative", worker: process.execPath, modelDirectory: tmpdir() }), /absolute/);
  const listener = createLocalAudioListener({ python: join(tmpdir(), "absent-python"), worker: process.execPath, modelDirectory: tmpdir() });
  assert.equal(await listener.ready(new AbortController().signal), false);
});
