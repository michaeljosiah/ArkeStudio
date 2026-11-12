import type { CatalogueEntry } from "../setup/catalogue.js";
import assets from "./speech-assets.json" with { type: "json" };

export const PIPECAT_WHISPER_COMPONENT = "stt-faster-whisper-base-en";

/** Separate weight format: installing GGML is never evidence that CTranslate2 is ready. */
export function speechCatalogue(): CatalogueEntry {
  return {
    id: PIPECAT_WHISPER_COMPONENT, displayName: "Whisper base.en · Pipecat dictation",
    purpose: "Local speech recognition for Pipecat", engine: "voxa", optional: true, removable: false,
    sizeMb: Math.ceil(assets.files.reduce((bytes, file) => bytes + file.bytes, 0) / 1_000_000),
    spec: { kind: "files", dir: "faster-whisper-base-en", files: assets.files.map(file => ({
      file: file.file, sizeMb: Math.ceil(file.bytes / 1_000_000), sha256: file.sha256,
      url: `https://huggingface.co/${assets.repository}/resolve/${assets.revision}/${file.file}`,
    })) },
  };
}
