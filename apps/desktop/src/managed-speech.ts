import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VoxaSettings } from "@arke-studio/contracts";
import { validateVoxaExecutable, type VoxaSelection } from "./voxa-runtime.js";

export type SpeechBackend = "voxa" | "pipecat";

/** Rollout starts on the qualified target; explicit external Voxa direction wins. */
export const initialSpeechBackend = (architecture: "x64" | "arm64" | null, environmentVoxa?: string, armEmulation = false): SpeechBackend =>
  architecture === "x64" && !armEmulation && !environmentVoxa ? "pipecat" : "voxa";

/** Private launch state, deliberately absent from settings, argv and renderer snapshots. */
export class ManagedSpeech {
  private readonly token = randomBytes(32).toString("base64url");
  constructor(private readonly options: {
    root: string; modelRoot: string; espeak: string; decoder: string; architecture: "x64" | "arm64" | null;
    settings: () => VoxaSettings;
  }) {}

  get backend(): SpeechBackend { return this.options.settings().backend ?? "voxa"; }
  capability = (): string | undefined => this.backend === "pipecat" ? this.token : undefined;
  healthHeaders = (): Record<string, string> => this.backend === "pipecat" ? { Authorization: `Bearer ${this.token}` } : {};

  legacyPaths() {
    const { modelRoot, espeak } = this.options;
    return { kokoroModel: join(modelRoot, "kokoro-82m/model_quantized.onnx"), kokoroConfig: join(modelRoot, "kokoro-82m/config.json"),
      kokoroVoices: join(modelRoot, "kokoro-82m/voices"), whisperModel: join(modelRoot, "whisper-base-en/ggml-base.en.bin"),
      espeak, espeakData: join(dirname(espeak), "share/espeak-ng-data") };
  }

  select(): VoxaSelection {
    const { root, architecture } = this.options;
    const python = join(root, "python", "python.exe");
    const absent = (detail: string, failure: VoxaSelection["failure"] = "runtime-missing"): VoxaSelection => ({
      source: "absent", command: null, configured: false, bundledAvailable: false,
      executableName: null, warning: detail, failure,
    });
    if (architecture !== "x64") return absent("Pipecat is not qualified for this architecture; select Voxa for local speech.", "architecture-mismatch");
    if (!existsSync(join(root, "app", "service.py")) || !existsSync(join(root, "runtime-manifest.json")))
      return absent("The managed Pipecat speech runtime is missing.");
    try {
      const manifest = JSON.parse(readFileSync(join(root, "runtime-manifest.json"), "utf8"));
      if (manifest.name !== "pipecat-speech" || manifest.arch !== "x64" || manifest.protocolVersion !== 1)
        return absent("The managed speech runtime manifest is incompatible.", "incompatible-health");
    } catch { return absent("The managed speech runtime manifest is unreadable.", "incompatible-health"); }
    const validation = validateVoxaExecutable(python, architecture);
    if (!validation.ok) return absent(validation.detail, validation.category);
    return { source: "bundled", command: python, configured: false, bundledAvailable: true,
      executableName: "python.exe", warning: null, failure: null };
  }

  launch(selection: VoxaSelection) {
    const { root, modelRoot, espeak } = this.options;
    return { command: selection.command,
      args: ["-E", "-s", "-B", join(root, "app", "service.py"), "--port", "{port}",
        "--kokoro", join(modelRoot, "kokoro-82m"), "--whisper", join(modelRoot, "faster-whisper-base-en"), "--espeak", espeak, "--decoder", this.options.decoder,
        "--alignment", join(root, "alignment/Arke.LocalAlignment.exe"), "--alignment-model", join(modelRoot, "whisper-base-en/ggml-base.en.bin")],
      env: { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows", ARKE_SPEECH_CAPABILITY: this.token,
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", TOKENIZERS_PARALLELISM: "false", NUMBA_CACHE_DIR: join(modelRoot, ".speech-cache/numba") },
      inheritEnv: false,
    };
  }

  recognitionFiles(): string[] {
    const { root } = this.options;
    try {
      const manifest = JSON.parse(readFileSync(join(root, "runtime-manifest.json"), "utf8"));
      return [join(root, "runtime-manifest.json"), ...manifest.files.filter((file: { path: string }) =>
        /^(app\/(?:engines|decoder|service)\.py|python\/(?:python\.exe|python311\.dll|Lib\/site-packages\/(?:faster_whisper|ctranslate2|tokenizers|onnxruntime|numpy)[/.]))/.test(file.path)
        && !file.path.split("/").includes("..") && !file.path.includes("\\")
      ).map((file: { path: string }) => join(root, file.path))];
    } catch { return [join(root, "runtime-manifest.json")]; }
  }

  /** Recovery policy identity must not change just because a private capability is renewed. */
  digest(launch: { command: string | null; args?: string[]; env?: Record<string, string> }): string {
    const { ARKE_SPEECH_CAPABILITY: _private, ...environment } = launch.env ?? {};
    return createHash("sha256").update(JSON.stringify([this.options.architecture, this.backend, launch.command, launch.args, environment])).digest("hex");
  }
}
