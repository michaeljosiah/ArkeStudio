import { spawn } from "node:child_process";
import net from "node:net";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const root = resolve(value("--root") ?? "");
if (!root) throw new Error("--root is required");
const models = value("--models") ? resolve(value("--models")) : null;
const audioFixture = value("--audio") ? resolve(value("--audio")) : null;

const server = net.createServer();
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("could not allocate a loopback port");
const port = address.port;
await new Promise((resolvePromise) => server.close(resolvePromise));

const executable = join(root, "voxa.exe");
const runtimeArgs = ["--host", "127.0.0.1", "--port", String(port)];
if (models) runtimeArgs.push(
  "--kokoro-model", join(models, "kokoro-82m", "model_quantized.onnx"),
  "--kokoro-config", join(models, "kokoro-82m", "config.json"),
  "--kokoro-voices", join(models, "kokoro-82m", "voices"),
  "--whisper-model", join(models, "whisper-base-en", "ggml-base.en.bin"),
  "--espeak", join(root, "..", "..", "espeak-ng", basename(root), "espeak-ng.exe"),
  "--espeak-data", join(root, "..", "..", "espeak-ng", basename(root), "share", "espeak-ng-data"),
);
const child = spawn(executable, runtimeArgs, {
  stdio: "ignore",
  windowsHide: true,
  env: { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" },
});
try {
  let health;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      await sleep(100);
    }
  }
  if (!health) throw new Error("Voxa did not expose /health");
  if (health.protocolVersion !== 1 || !["x64", "arm64"].includes(health.architecture)) {
    throw new Error(`incompatible Voxa health: ${JSON.stringify(health)}`);
  }
  if (!health.engines?.includes("kokoro") || !health.engines?.includes("whisper")) {
    throw new Error("Voxa health omitted required engines");
  }
  if (!health.engineStatus?.kokoro || !health.engineStatus?.whisper) throw new Error("Voxa health omitted engine status");
  const voices = await (await fetch(`http://127.0.0.1:${port}/voices`)).json();
  if (!Array.isArray(voices) || voices.length < 6 || voices[0]?.id !== "af_bella") {
    throw new Error("Voxa voice catalogue is incompatible");
  }
  if (models) {
    const tts = await fetch(`http://127.0.0.1:${port}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: "af_bella", text: "The harbour remembers.", speed: 1.0 }),
    });
    const wav = Buffer.from(await tts.arrayBuffer());
    if (!tts.ok || wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error(`Voxa TTS smoke failed (HTTP ${tts.status})`);
    }
    if (audioFixture) {
      const { readFile } = await import("node:fs/promises");
      const stt = await fetch(`http://127.0.0.1:${port}/stt`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: await readFile(audioFixture),
      });
      const transcription = await stt.json();
      if (!stt.ok || typeof transcription.text !== "string" || transcription.text.trim().length === 0) {
        throw new Error(`Voxa STT smoke failed (HTTP ${stt.status})`);
      }
      console.log(`[smoke-voxa] real TTS WAV ${wav.length} bytes; STT ${transcription.text.length} characters`);
    }
  }
  console.log(`[smoke-voxa] Voxa ${health.version} protocol 1 ${health.architecture}; ${voices.length} voices`);
} finally {
  child.kill();
  await Promise.race([new Promise((resolvePromise) => child.once("exit", resolvePromise)), sleep(3_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
