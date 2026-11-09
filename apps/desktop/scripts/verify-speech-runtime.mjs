import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertPeArchitecture, verifyManifest } from "./runtime-support.mjs";

/** Shared by staging and afterPack: Python must be a complete loose, offline resource. */
export function verifySpeechRuntime(root, arch) {
  if (arch !== "x64") throw new Error("Managed speech is qualified only for Windows x64");
  const manifest = verifyManifest(root);
  if (manifest.name !== "pipecat-speech" || manifest.arch !== arch || manifest.protocolVersion !== 1)
    throw new Error("Managed speech manifest is incompatible");
  assertPeArchitecture(join(root, "python/python.exe"), arch);
  const notices = join(root, "THIRD-PARTY-NOTICES");
  for (const file of ["app/live.py", "app/smoke.py", "app/smoke_live.py", "app/smoke_desktop.py",
    "python/Lib/site-packages/pipecat/audio/vad/data/silero_vad.onnx",
    "python/Lib/site-packages/pipecat/audio/turn/smart_turn/data/smart-turn-v3.2-cpu.onnx",
    "app/service.py", "app/engines.py", "app/decoder.py", "app/alignment.py", "app/NOTICE.txt",
    "THIRD-PARTY-NOTICES/PYTHON-PACKAGES.json", "THIRD-PARTY-NOTICES/SOURCES.json", "THIRD-PARTY-NOTICES/REPLACEMENT.txt",
    "THIRD-PARTY-NOTICES/CPU-RECOGNIZER-BUILD.txt", "THIRD-PARTY-NOTICES/LIBSNDFILE-BUILD.txt",
    "THIRD-PARTY-NOTICES/source/libsndfile-1.2.2.tar.xz", "THIRD-PARTY-NOTICES/source/soxr-1.0.0.tar.gz"])
    if (!existsSync(join(root, file))) throw new Error(`Managed speech lacks ${file}`);
  const packages = JSON.parse(readFileSync(join(notices, "PYTHON-PACKAGES.json"), "utf8"));
  for (const name of ["pipecat-ai", "faster-whisper", "ctranslate2", "soundfile", "soxr", "onnxruntime"])
    if (!packages.some(item => item.name.toLowerCase() === name && item.licenseFiles?.length))
      throw new Error(`Managed speech lacks notices for ${name}`);
  for (const item of packages) for (const file of item.licenseFiles) {
    if (file.includes("..") || file.includes("\\") || file.startsWith("/")) throw new Error("Invalid speech notice path");
    const path = file.startsWith("THIRD-PARTY-NOTICES/") ? join(root, file) : join(root, "python/Lib/site-packages", file);
    if (!existsSync(path)) throw new Error(`Managed speech licence is absent: ${item.name}`);
  }
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (/^(avcodec|avformat|avutil|swscale|swresample|libx264|libx265|cudnn|cublas|libiomp|mkl).*\.dll$/i.test(entry.name)
        || entry.name === "av" && entry.isDirectory()) throw new Error(`Embedded codec/Intel/GPU library in speech: ${entry.name}`);
      if (entry.isDirectory()) walk(join(directory, entry.name));
    }
  };
  walk(join(root, "python"));
  const alignment = join(root, "alignment");
  assertPeArchitecture(join(alignment, "Arke.LocalAlignment.exe"), arch);
  if (verifyManifest(alignment).engine !== "whisper.cpp/dtw-word-boundaries-v1") throw new Error("Invalid acoustic alignment identity");
  return manifest;
}
