import type { ManifestModel } from "./manifest.js";

/** The same translation is used for the reviewed prompt and the submitted prompt. Video
 * soundtracks occupy H3's first audio slots; host preparation gives silent clips a silent track
 * so that numbering never depends on a decoder discovering audio after review. */
export function referencePrompt(text: string, model: ManifestModel, videos = 0, standaloneAudioOffset = 0, generatedBindings = false): string {
  const syntax = model.limits.referenceSyntax;
  if (syntax === undefined) return text;
  // Only generated binding prose has implicit citations. Authored prose requires an explicit @.
  const pattern = generatedBindings ? /(?<![\w<])@?(Image|image|Video|video|Audio)\s*([1-9][0-9]*)\b/g
    : /(?<![\w<])@(Image|image|Video|video|Audio)\s*([1-9][0-9]*)\b/g;
  return text.replace(pattern, (match: string, kind: string, index: string) => {
    const number = Number(index);
    if (syntax === "picture-labels") {
      // The Krea 2 rebalance node hands the encoder each picture behind a "Picture N:" label
      // ahead of the prompt (issue 1083), so the prose has to call it that or it names a picture
      // the encoder never saw. The route carries nothing but pictures; a clip or audio mention
      // is left as written for the gate, which already refuses what cannot ride.
      return kind.toLowerCase() === "image" ? `Picture ${number}` : match;
    }
    if (kind.toLowerCase() === "image") return `<Picture ${number}>`;
    if (kind.toLowerCase() === "video") return `<Video ${number}>`;
    return `<Audio ${videos + standaloneAudioOffset + number}>`;
  });
}
