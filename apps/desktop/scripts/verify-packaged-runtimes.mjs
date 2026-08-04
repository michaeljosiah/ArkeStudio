import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertPeArchitecture, verifyManifest } from "./runtime-support.mjs";

export default async function verifyPackagedRuntimes(context) {
  const arch = context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : null;
  if (!arch) throw new Error(`unsupported Electron package architecture ${context.arch}`);
  const resources = join(context.appOutDir, "resources");
  const voxa = join(resources, "voxa");
  const espeak = join(resources, "espeak-ng");
  assertPeArchitecture(join(voxa, "voxa.exe"), arch);
  assertPeArchitecture(join(espeak, "espeak-ng.exe"), arch);
  if (verifyManifest(voxa).arch !== arch || verifyManifest(espeak).arch !== arch) {
    throw new Error(`packaged runtime manifest does not match ${arch}`);
  }
  for (const runtime of [
    "msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll",
    ...(arch === "x64" ? ["vcruntime140_1.dll"] : []), "vcomp140.dll",
  ]) {
    if (!existsSync(join(voxa, runtime))) throw new Error(`packaged Voxa lacks ${runtime}`);
  }
  const forbidden = new Set(["kokoro-82m", "whisper-base-en", "model_quantized.onnx", "ggml-base.en.bin"]);
  const inspect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (forbidden.has(entry.name)) throw new Error(`model weight ${entry.name} entered the installer`);
      if (entry.isDirectory()) inspect(join(dir, entry.name));
    }
  }
  inspect(resources);
  if (readdirSync(voxa).some((name) => name === "x64" || name === "arm64")) {
    throw new Error("packaged Voxa contains architecture staging directories");
  }
  const nativeIndex = join(resources, "app.asar.unpacked", "node_modules", "better-sqlite3-electron", "build", "Release", "better_sqlite3.node");
  if (existsSync(nativeIndex)) assertPeArchitecture(nativeIndex, arch);
}
