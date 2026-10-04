import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MediaProbeRunner } from "../takes/qc.js";
import { decodePng, drawScaled, encodePng, solidImage } from "../references/png.js";

export const IMAGE_MAX_EDGE = 1568;
export const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
export interface ImageRenditionMaker { render(bytes: Uint8Array, extension: string): Promise<Uint8Array> }

/** The existing bounded ffmpeg runner owns codecs; only verified bytes enter its scratch. */
export function createImageRenditionMaker(runner: MediaProbeRunner): ImageRenditionMaker {
  return { async render(bytes, extension) {
    const dir = await mkdtemp(join(tmpdir(), "arke-chat-image-"));
    try {
      const input = join(dir, `source${extension}`), output = join(dir, "rendition.png");
      await writeFile(input, bytes, { flag: "wx" });
      const result = await runner.run(["-hide_banner", "-loglevel", "error", "-threads", "1", "-i", input,
        "-map", "0:v:0", "-frames:v", "1", "-vf", `scale=${IMAGE_MAX_EDGE}:${IMAGE_MAX_EDGE}:force_original_aspect_ratio=decrease`,
        "-map_metadata", "-1", "-pix_fmt", "rgba", "-threads", "1", "-y", output], { timeoutMs: 20_000, maxOutputBytes: 1_048_576 });
      if (result.timedOut || result.code !== 0) throw new Error("The image rendition could not be decoded.");
      if ((await stat(output)).size > IMAGE_MAX_BYTES) throw new Error("The image rendition exceeds its byte limit.");
      return new Uint8Array(await readFile(output));
    } finally { await rm(dir, { recursive: true, force: true }); }
  } };
}

/** Decode and re-encode even a PNG: EXIF, text, profiles and other metadata never leave. */
export async function imageRendition(bytes: Uint8Array, extension: string, maker?: ImageRenditionMaker) {
  const decoded = decodePng(maker ? await maker.render(bytes, extension) : bytes, maker ? IMAGE_MAX_EDGE ** 2 : 16_000_000);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.floor(decoded.width * scale)), height = Math.max(1, Math.floor(decoded.height * scale));
  const image = solidImage(width, height, [0, 0, 0, 0]);
  drawScaled(image, decoded, 0, 0, width, height);
  const data = encodePng(image);
  if (data.length > IMAGE_MAX_BYTES) throw new Error("The image rendition exceeds its byte limit.");
  return { data, width, height };
}
