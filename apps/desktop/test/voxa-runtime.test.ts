import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { environmentVoxaArgs, safeVoxaExtraArgs, selectVoxa, validateVoxaExecutable } from "../src/voxa-runtime.js";

const settings = (executablePath: string | null = null) => ({
  executablePath,
  modelRoot: null,
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
