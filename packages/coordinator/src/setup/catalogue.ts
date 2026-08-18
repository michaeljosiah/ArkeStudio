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
  /** Immutable artifact digest; checked before the file receives its real name. */
  sha256?: string;
}

export type ComponentKind =
  /**
   * Files fetched into the app root, used in place. `externalRoot` names an injected resolver
   * (SetupOptions.externalDirs) whose folder replaces `<appRoot>/models` — a user-directed
   * model library (SPEC-021 §2.4). Entries landing there are the user's guests: detection and
   * download resolve the same per-file paths, repair is file-specific, and nothing about the
   * folder is ever recursively deleted.
   */
  | { kind: "files"; dir: string; files: readonly DownloadFile[]; externalRoot?: string }
  /** A third-party installer: fetched, then run. */
  | { kind: "installer"; file: DownloadFile; silentArgs: readonly string[] }
  /**
   * A model pulled by a runtime we do not own, through its own CLI. No catalogue entry ships
   * one — which model Ollama runs is chosen in Settings · Local runtime, on the disk it costs.
   */
  | { kind: "pull"; command: string; args: readonly string[] }
  /**
   * A compressed archive holding one executable: fetched, verified, extracted, and then run
   * where it landed. Nothing is installed and nothing reaches PATH — the app holds the path
   * itself, so the copy it fetched cannot be confused with one the user manages, and removing
   * the app removes it.
   *
   * Per architecture, because a release publishes one archive per architecture and picking the
   * wrong one produces a binary that will not start rather than a download that fails.
   */
  | {
      kind: "archive";
      /** Relative to the app root, not the models folder — this is a tool, not a weight file. */
      dir: string;
      /** What the archive must contain for the fetch to have worked. */
      executable: string;
      byArch: Partial<Record<"x64" | "arm64", DownloadFile>>;
    }
  /**
   * A whole runtime directory in one pinned archive (SPEC-021 §2.4, D10). `archive` extracts
   * one executable and discards the rest; a portable runtime IS its tree — an embedded Python
   * beside the application — so the entire extraction is staged and renamed into place whole.
   * Presence is `rootMarker` under the installed dir, and the marker may sit one level deep,
   * because upstream archives wrap their content in a single top-level folder.
   */
  | { kind: "tree"; dir: string; rootMarker: string; file: DownloadFile };

export interface CatalogueEntry {
  id: string;
  displayName: string;
  purpose: string;
  sizeMb: number;
  spec: ComponentKind;
  /** Nothing is attempted until these are ready — a model needs its runtime. */
  requires?: readonly string[];
  /**
   * Peak disk this component needs, where that differs from what it downloads — an archive
   * that is extracted holds both copies at once before the archive is deleted. The free-disk
   * guard measures against this; progress still counts the download, so a bar that reaches
   * 100% still means the download finished. Absent means the two are the same.
   */
  installedMb?: number;
  /** Shown on the row when the thing that would *use* this is not in the build yet. */
  caveat?: string;
  /**
   * Offered, not fetched: setup leaves it alone and it waits in Settings · Local runtime until
   * someone asks for it. Big models belong here — the disk is the user's to spend.
   */
  optional?: boolean;
}

const KOKORO = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";
const WHISPER = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/** The app's own preset speakers (packages/voice KOKORO_PRESETS) — one small file each. */
const KOKORO_VOICES = ["af_bella", "af_nicole", "am_michael", "am_adam", "bf_emma", "bm_george"] as const;

const HIGGSFIELD_VERSION = "1.1.22";
const HIGGSFIELD_RELEASE = `https://github.com/higgsfield-ai/cli/releases/download/v${HIGGSFIELD_VERSION}`;

/** ONNX files begin with a protobuf field header; GGML files begin with the ASCII tag. */
const ONNX_MAGIC = [0x08] as const;
const GGML_MAGIC = [0x6c, 0x6d, 0x67, 0x67] as const; // "lmgg" — ggml little-endian tag
/** gzip's two-byte header, so an HTML error page never gets extracted as an archive. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;
/** 7-Zip's signature — the System32 bsdtar this service already resolves reads the format. */
const SEVENZ_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] as const;

const COMFYUI_VERSION = "0.33.1";

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
    spec: {
      kind: "files",
      dir: "kokoro-82m",
      files: [
        {
          url: `${KOKORO}/onnx/model_quantized.onnx`,
          file: "model_quantized.onnx",
          sizeMb: 93,
          magic: ONNX_MAGIC,
          sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
        },
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
    spec: {
      kind: "files",
      dir: "whisper-base-en",
      files: [{ url: `${WHISPER}/ggml-base.en.bin`, file: "ggml-base.en.bin", sizeMb: 141, magic: GGML_MAGIC }],
    },
  },
  // ---- offered, never fetched on their own -------------------------------------------
  // The Higgsfield CLI. Offered rather than fetched because it is only useful to somebody who
  // has a Higgsfield account to sign in to, and downloading a vendor's tool unasked is not the
  // app's call. Discovery prefers an installation already on PATH, so a machine that ran
  // `npm i -g @higgsfield/cli` or `brew install` never ends up with a second, drifting copy.
  //
  // Pinned to a release, with that release's own published checksums. The archive ships
  // `hf.exe`; `higgsfield`, `higgs` and `hf` are shims the npm package installs, which is why
  // discovery looks for all four spellings.
  {
    id: "higgsfield-cli",
    displayName: "Higgsfield CLI",
    purpose: "Generates images and video through your Higgsfield account — sign in from Providers",
    sizeMb: 7,
    optional: true,
    spec: {
      kind: "archive",
      dir: "higgsfield-cli",
      executable: "hf.exe",
      byArch: {
        x64: {
          url: `${HIGGSFIELD_RELEASE}/hf_${HIGGSFIELD_VERSION}_windows_amd64.tar.gz`,
          file: `hf_${HIGGSFIELD_VERSION}_windows_amd64.tar.gz`,
          sizeMb: 7,
          magic: GZIP_MAGIC,
          sha256: "f8eb1700954ec8e019db005107c5c6746dea05e0648437f87e22b981e637b2c7",
        },
        arm64: {
          url: `${HIGGSFIELD_RELEASE}/hf_${HIGGSFIELD_VERSION}_windows_arm64.tar.gz`,
          file: `hf_${HIGGSFIELD_VERSION}_windows_arm64.tar.gz`,
          sizeMb: 6,
          magic: GZIP_MAGIC,
          sha256: "f74f71475c04913a74b5f21f7cb71284b6978e9949b2256d0aa5b51a306fb88b",
        },
      },
    },
  },
  // The ComfyUI engine (SPEC-021 §2.4, D10). Optional and detection-first: presence is
  // answered by the engine service before this directory is even looked at, so an existing
  // install — user-directed, answering on the default port, or at a well-known location — means
  // this is NEVER fetched. Pinned to a release with the release's own published sha256; the
  // NVIDIA build only, said on the row (§1.4). The archive is 7z, which the resolved System32
  // bsdtar reads (verified on the supported platform — see systemTar in local-setup.ts).
  {
    id: "comfyui-runtime",
    displayName: "ComfyUI",
    purpose: "Runs the local image and video recipes — used, never fetched, when you already have one",
    sizeMb: 2034,
    // ~6 GB extracted, and the archive is still on disk while it extracts, so the peak is both
    // at once. Almost none of it is ComfyUI: the tree is an embedded Python plus torch and the
    // CUDA libraries, which is the cost §2.1 says every alternative runtime pays too.
    installedMb: 8200,
    optional: true,
    caveat: `v${COMFYUI_VERSION} · NVIDIA build · about 6 GB on disk`,
    spec: {
      kind: "tree",
      dir: "comfyui-runtime",
      rootMarker: "ComfyUI/main.py",
      file: {
        url: `https://github.com/Comfy-Org/ComfyUI/releases/download/v${COMFYUI_VERSION}/ComfyUI_windows_portable_nvidia.7z`,
        file: "ComfyUI_windows_portable_nvidia.7z",
        sizeMb: 2034,
        magic: SEVENZ_MAGIC,
        sha256: "4a221588979b96b8244e0e50b2edca03af732acae1deba69d60aa3b4d60b9dba",
      },
    },
  },
  // Gemma 4 through Ollama. Sizes are Ollama's published download sizes; the VRAM figures
  // follow the manifest's convention of the weights plus a couple of gigabytes to work in.
  {
    id: "ollama-gemma4-e2b-it-qat",
    displayName: "Gemma 4 · E2B (quantised)",
    purpose: "The small Gemma 4 — the one to try first on a modest graphics card",
    sizeMb: 4300,
    optional: true,
    requires: ["ollama-runtime"],
    spec: { kind: "pull", command: "ollama", args: ["pull", "gemma4:e2b-it-qat"] },
  },
  {
    id: "ollama-gemma4-12b",
    displayName: "Gemma 4 · 12B",
    purpose: "Reads images and holds a 256K context — the one worth having if it fits",
    sizeMb: 7600,
    optional: true,
    requires: ["ollama-runtime"],
    spec: { kind: "pull", command: "ollama", args: ["pull", "gemma4:12b"] },
  },
  {
    id: "ollama-gemma4-26b",
    displayName: "Gemma 4 · 26B",
    purpose: "The large one, for a machine with the memory to hold it",
    sizeMb: 18000,
    optional: true,
    requires: ["ollama-runtime"],
    spec: { kind: "pull", command: "ollama", args: ["pull", "gemma4:26b"] },
  },
] as const;

/** What setup fetches unasked — the optional entries are nobody's cost until they are chosen. */
export function catalogueTotalMb(entries: readonly CatalogueEntry[] = SETUP_CATALOGUE): number {
  return entries.filter((e) => e.optional !== true).reduce((sum, e) => sum + e.sizeMb, 0);
}
