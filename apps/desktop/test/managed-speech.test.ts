import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VoxaSettings } from "@arke-studio/contracts";
import { ManagedSpeech } from "../src/managed-speech.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "arke-speech-"));
  await mkdir(join(root, "python")); await mkdir(join(root, "app"));
  const pe = Buffer.alloc(128); pe.write("MZ"); pe.writeUInt32LE(64, 0x3c); pe.write("PE\0\0", 64); pe.writeUInt16LE(0x8664, 68);
  await writeFile(join(root, "python/python.exe"), pe); await writeFile(join(root, "app/service.py"), "# fixture");
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ name: "pipecat-speech", arch: "x64", protocolVersion: 1 }));
  return root;
}

it("selects only a qualified managed tree and preserves legacy executable settings", async () => {
  const root = await fixture();
  let settings: VoxaSettings = { backend: "pipecat", executablePath: "personal-voxa.exe", extraArgs: ["--personal"] };
  const speech = new ManagedSpeech({ root, modelRoot: join(root, "models"), espeak: join(root, "espeak.exe"), decoder: join(root, "ffmpeg.exe"), architecture: "x64", settings: () => settings });
  const selected = speech.select(); assert.equal(selected.source, "bundled"); assert.equal(selected.command, join(root, "python/python.exe"));
  const launch = speech.launch(selected);
  assert.equal(launch.inheritEnv, false); assert.ok(!launch.args.includes("--personal"));
  assert.ok(launch.args.includes(join(root, "models/faster-whisper-base-en")));
  const token = speech.capability()!; assert.match(token, /^[a-zA-Z0-9_-]{43}$/);
  assert.ok(!launch.args.some(arg => arg.includes(token)));
  assert.equal(speech.healthHeaders().Authorization, `Bearer ${token}`);
  const digest = speech.digest(launch);
  assert.equal(digest, speech.digest({ ...launch, env: { ...launch.env, ARKE_SPEECH_CAPABILITY: "a different private token" } }));
  settings = { ...settings, backend: "voxa" };
  assert.equal(speech.capability(), undefined); assert.deepEqual(speech.healthHeaders(), {});
  assert.equal(settings.executablePath, "personal-voxa.exe");
});

it("refuses absent, incompatible and unqualified architecture runtimes", async () => {
  const root = await fixture();
  const base = { root, modelRoot: root, espeak: join(root, "espeak.exe"), decoder: join(root, "ffmpeg.exe"), settings: () => ({ backend: "pipecat" as const, executablePath: null, extraArgs: [] }) };
  assert.equal(new ManagedSpeech({ ...base, architecture: "arm64" }).select().failure, "architecture-mismatch");
  await writeFile(join(root, "runtime-manifest.json"), "not-json");
  assert.equal(new ManagedSpeech({ ...base, architecture: "x64" }).select().failure, "incompatible-health");
  assert.equal(new ManagedSpeech({ ...base, root: join(root, "missing"), architecture: "x64" }).select().failure, "runtime-missing");
});
