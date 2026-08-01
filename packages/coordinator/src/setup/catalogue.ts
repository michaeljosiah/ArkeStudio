/**
 * What setup fetches onto this machine, and where from. The engine ships; the language model
 * it runs does not — that is a choice about quality and disk that belongs to the person whose
 * disk it is, so it is made in Settings · Local runtime rather than assumed here.
 *
 * Sizes are the published figures, used for arithmetic *before* anything starts — the
 * free-disk guard and the totals on screen — so they are stated here rather than discovered
 * halfway through a download.
 *
 * Every URL in this file was resolved live when it was written. A source that moves becomes a
 * failed component with its status code, never a silent skip.
 */

export interface DownloadFile {
  url: string;
  /** Where it lands, relative to the component's own folder. */
  file: string;
  /** Published size; used for progress when the server sends no length. */
  sizeMb: number;
  /** First bytes the finished file must have — a truncated or error-page download fails loudly. */
  magic?: readonly number[];
}

export type ComponentKind =
  /** Files fetched into the app root, used in place. */
  | { kind: "files"; dir: string; files: readonly DownloadFile[] }
  /** A third-party installer: fetched, then run. */
  | { kind: "installer"; file: DownloadFile; silentArgs: readonly string[] }
  /**
   * A model pulled by a runtime we do not own, through its own CLI. No catalogue entry ships
   * one — which model Ollama runs is chosen in Settings · Local runtime, on the disk it costs.
   */
  | { kind: "pull"; command: string; args: readonly string[] };

export interface CatalogueEntry {
  id: string;
  displayName: string;
  purpose: string;
  sizeMb: number;
  spec: ComponentKind;
  /** Nothing is attempted until these are ready — a model needs its runtime. */
  requires?: readonly string[];
  /** Shown on the row when the thing that would *use* this is not in the build yet. */
  caveat?: string;
}

const KOKORO = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";
const WHISPER = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/** The app's own preset speakers (packages/voice KOKORO_PRESETS) — one small file each. */
const KOKORO_VOICES = ["af_bella", "af_nicole", "am_michael", "am_adam", "bf_emma", "bm_george"] as const;

/** ONNX files begin with a protobuf field header; GGML files begin with the ASCII tag. */
const ONNX_MAGIC = [0x08] as const;
const GGML_MAGIC = [0x6c, 0x6d, 0x67, 0x67] as const; // "lmgg" — ggml little-endian tag

export const SETUP_CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: "ollama-runtime",
    displayName: "Ollama",
    purpose: "Runs language models here — choose one in Settings · Local runtime",
    sizeMb: 750,
    spec: {
      kind: "installer",
      file: { url: "https://ollama.com/download/OllamaSetup.exe", file: "OllamaSetup.exe", sizeMb: 750 },
      // Inno Setup's flags. If the installer refuses them it is launched visibly instead,
      // and the row says so — never a silent failure, never a silent install either.
      silentArgs: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
    },
  },
  {
    id: "tts-kokoro-82m",
    displayName: "Kokoro 82M · voice",
    purpose: "Speaks lines on this machine, in the six preset voices",
    sizeMb: 400,
    caveat: "the weights land now; the local voice runtime that plays them arrives with a later build",
    spec: {
      kind: "files",
      dir: "kokoro-82m",
      files: [
        { url: `${KOKORO}/onnx/model_q8f16.onnx`, file: "model_q8f16.onnx", sizeMb: 90, magic: ONNX_MAGIC },
        { url: `${KOKORO}/config.json`, file: "config.json", sizeMb: 1 },
        ...KOKORO_VOICES.map((v) => ({ url: `${KOKORO}/voices/${v}.bin`, file: `voices/${v}.bin`, sizeMb: 1 })),
      ],
    },
  },
  {
    id: "stt-whisper-base-en",
    displayName: "Whisper base.en · dictation",
    purpose: "Turns your speech into text, without the audio leaving this machine",
    // The small English model, deliberately: enough to dictate an instruction, and a fraction
    // of Large v3's 3.1 GB. A bigger one is a choice for Settings, not a cost at setup.
    sizeMb: 141,
    caveat: "the weights land now; the local voice runtime that runs them arrives with a later build",
    spec: {
      kind: "files",
      dir: "whisper-base-en",
      files: [{ url: `${WHISPER}/ggml-base.en.bin`, file: "ggml-base.en.bin", sizeMb: 141, magic: GGML_MAGIC }],
    },
  },
] as const;

/** Everything setup would fetch on a bare machine, in megabytes. */
export function catalogueTotalMb(entries: readonly CatalogueEntry[] = SETUP_CATALOGUE): number {
  return entries.reduce((sum, e) => sum + e.sizeMb, 0);
}
