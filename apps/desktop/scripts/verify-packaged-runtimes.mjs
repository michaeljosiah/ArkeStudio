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
  // The sample world (SPEC-016 R-6, R-8). An extraResources entry that quietly fails to copy
  // does not fail the build — the application simply reports having no sample world, which is
  // indistinguishable from a build that never carried one. This is the only place that tells
  // the difference before a user does.
  const sampleWorld = join(resources, "sample-world");
  if (!existsSync(join(sampleWorld, "world.json"))) {
    throw new Error("the sample world is missing from the installer (resources/sample-world/world.json)");
  }
  for (const expected of ["characters", "canon", "references", "productions", "world-art.png"]) {
    if (!existsSync(join(sampleWorld, expected))) {
      throw new Error(`the packaged sample world is incomplete — ${expected} did not copy`);
    }
  }

  /*
   * ffmpeg and ffprobe are one runtime, verified together (#253, Codex round 1).
   *
   * They are copied by one wholesale directory rule, so it is easy to believe staging ffmpeg
   * stages both. It does not: a build carrying only ffmpeg.exe installs cleanly, logs the probe
   * as unavailable, and silently disables every measurement — no track can become a clock and no
   * take gets a duration. Asserted here because that failure is invisible until somebody opens
   * the spine, by which time the installer has shipped.
   */
  const ffmpegDir = join(resources, "ffmpeg");
  const staged = ["ffmpeg.exe", "ffprobe.exe"].filter((binary) => existsSync(join(ffmpegDir, binary)));
  // Neither is the existing local-build case: no media runtime, honestly reported at startup.
  // One is the state worth failing on — half a runtime that installs cleanly and then disables
  // whichever half is missing without saying so.
  if (staged.length === 1) {
    const missing = staged[0] === "ffmpeg.exe" ? "ffprobe.exe" : "ffmpeg.exe";
    throw new Error(
      `resources/ffmpeg has ${staged[0]} but not ${missing} — they are one runtime, and shipping half of it ` +
        `disables ${missing === "ffprobe.exe" ? "every media measurement" : "export"} with nothing on screen to say so`,
    );
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
