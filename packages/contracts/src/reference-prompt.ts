import type { ManifestModel } from "./manifest.js";

/** The same translation is used for the reviewed prompt and the submitted prompt. Video
 * soundtracks occupy H3's first audio slots; host preparation gives silent clips a silent track
 * so that numbering never depends on a decoder discovering audio after review. */
export function referencePrompt(text: string, model: ManifestModel, videos = 0, standaloneAudioOffset = 0): string {
  if (model.limits.referenceSyntax !== "minimax-h3") return text;
  return text.replace(/(?<![\w<])@?(Image|image|Video|video|Audio)\s*([1-9][0-9]*)\b/g, (_match, kind: string, index: string) => {
    const number = Number(index);
    if (kind.toLowerCase() === "image") return `<Picture ${number}>`;
    if (kind.toLowerCase() === "video") return `<Video ${number}>`;
    return `<Audio ${videos + standaloneAudioOffset + number}>`;
  });
}
