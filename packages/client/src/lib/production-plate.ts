import { productionShape, type Production } from "@arke-studio/contracts";

const PLATES = new Set(["microdrama", "film", "music-video", "interactive", "visual-novel", "book", "audio-drama", "album", "single", "soundtrack"]);
const BY_MEDIUM: Record<string, string> = { story: "book", video: "film", music: "album" };

/** The kind's own picture, for a production with none yet. Relative: the packaged app loads from file://. */
export function productionPlate(meta: Pick<Production, "format"> & { medium?: Production["medium"]; kind?: string }): string {
  const shape = productionShape(meta);
  if (shape.hasPages) return "./comic-styles/clean-line.jpg";
  const kind = meta.kind !== undefined && PLATES.has(meta.kind) ? meta.kind : shape.isAudioDrama ? "audio-drama" : BY_MEDIUM[shape.medium] ?? "film";
  return `./video-kinds/${kind}.webp`;
}
