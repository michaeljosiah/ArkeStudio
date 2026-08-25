import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { KokoroClient } from "@arke-studio/providers";
import { VoxaClient } from "@arke-studio/voice";
import { environmentVoxaArgs, safeVoxaExtraArgs, selectVoxa, validateVoxaExecutable } from "../src/voxa-runtime.js";

const settings = (executablePath: string | null = null) => ({
  executablePath,
  extraArgs: [],
});

async function peExecutable(arch: "x64" | "arm64", name = "voxa.exe"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arke voxa "));
  await mkdir(root, { recursive: true });
  const path = join(root, name);
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "ascii");
  bytes.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 68);
  await writeFile(path, bytes);
  return path;
}

describe("Voxa discovery", () => {
  it("uses environment, configured, bundled, then absent deterministically", async () => {
    const environmentPath = await peExecutable("x64", "environment.exe");
    const configuredPath = await peExecutable("x64", "configured.exe");
    const bundledPath = await peExecutable("x64", "bundled.exe");

    assert.equal(selectVoxa({ settings: settings(configuredPath), environmentPath, bundledPath, expectedArchitecture: "x64" }).source, "environment");
    assert.equal(selectVoxa({ settings: settings(configuredPath), bundledPath, expectedArchitecture: "x64" }).source, "configured");
    assert.equal(selectVoxa({ settings: settings(), bundledPath, expectedArchitecture: "x64" }).source, "bundled");
    assert.equal(selectVoxa({ settings: settings(), bundledPath: null, expectedArchitecture: "x64" }).source, "absent");
  });

  it("falls back to bundled Voxa when a persisted custom path is missing", async () => {
    const bundledPath = await peExecutable("x64");
    const result = selectVoxa({
      settings: settings(join("C:\\Program Files", "Missing Voxa", "voxa.exe")),
      bundledPath,
      expectedArchitecture: "x64",
    });
    assert.equal(result.source, "bundled");
    assert.equal(result.configured, true);
    assert.match(result.warning ?? "", /fell back/);
  });

  it("rejects an architecture mismatch distinctly", async () => {
    const path = await peExecutable("arm64");
    const result = validateVoxaExecutable(path, "x64");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.category, "architecture-mismatch");
  });

  it("parses only JSON argument arrays and preserves paths containing spaces", () => {
    assert.deepEqual(environmentVoxaArgs('["--model","C:\\\\Program Files\\\\Voxa\\\\model.onnx"]'), [
      "--model",
      "C:\\Program Files\\Voxa\\model.onnx",
    ]);
    assert.deepEqual(environmentVoxaArgs('--model "C:\\Program Files\\Voxa\\model.onnx"'), []);
  });

  it("does not allow advanced arguments to replace managed loopback or model paths", () => {
    assert.deepEqual(
      safeVoxaExtraArgs(["--acceleration", "cpu", "--host", "0.0.0.0", "--port=80", "--trace"]),
      ["--acceleration", "cpu", "--trace"],
    );
  });
});

describe("Voxa synthesis wiring", () => {
  it("shares one synthesis lane between direct and queue-backed Kokoro", async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45, 9, 9]);
    let active = 0;
    let peak = 0;
    const voxa = new VoxaClient(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return new Response(wav, { status: 200 });
      },
      "http://127.0.0.1:7777",
      { timeouts: { tts: 1_000 } },
    );
    const queued = new KokoroClient(
      async () => {
        throw new Error("queue synthesis must use the shared Voxa client");
      },
      () => "http://127.0.0.1:7777",
      (input) => voxa.synthesize(input),
    );

    await Promise.all([
      voxa.synthesize({ voiceId: "af_bella", text: "direct preview" }),
      queued.submit("", {
        model: "kokoro-82m",
        params: { voiceId: "af_bella", text: "queue take" },
      } as never),
    ]);
    assert.equal(peak, 1);
  });
});
