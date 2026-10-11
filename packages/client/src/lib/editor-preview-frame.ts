import { assertEffectRasterSize, compositeRgba, renderEffectLayersRgba, type EffectClip } from "@arke-studio/contracts";
import type { PreviewPicturePixels } from "./editor-preview-media.js";

export interface PreviewFrameRequest {
  id: number;
  generation: number;
  absoluteFrame: number;
  frameRate: number;
  width: number;
  height: number;
  pictures: Array<PreviewPicturePixels & { id: string; effects: EffectClip[] }>;
  composition: EffectClip[];
}

export type PreviewFrameResult = Pick<PreviewFrameRequest, "id" | "generation" | "absoluteFrame" | "width" | "height"> & (
  { pixels: Uint8ClampedArray; error?: never } | { error: string; pixels?: never }
);

/** The worker and browser parity fixture execute this same alpha-preserving composition. */
export function renderPreviewFrame(request: PreviewFrameRequest): Uint8ClampedArray {
  const { width, height, absoluteFrame, frameRate } = request;
  assertEffectRasterSize(width, height);
  const output = new Uint8ClampedArray(width * height * 4);
  for (let index = 3; index < output.length; index += 4) output[index] = 255;
  for (const picture of request.pictures) {
    const { rect, pixels } = picture;
    if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > width || rect.y + rect.height > height || pixels.length !== rect.width * rect.height * 4) throw new Error("The picture matte is outside the preview frame.");
    if (picture.effects.length) {
      const effects = renderEffectLayersRgba(picture.effects, absoluteFrame, frameRate, rect.width, rect.height);
      compositeRgba(pixels, effects, "atop");
    }
    // Rows avoid allocating a full-frame padded copy for every contained picture.
    for (let row = 0; row < rect.height; row++) {
      const at = ((rect.y + row) * width + rect.x) * 4;
      compositeRgba(output.subarray(at, at + rect.width * 4), pixels.subarray(row * rect.width * 4, (row + 1) * rect.width * 4));
    }
  }
  if (request.composition.length) compositeRgba(output, renderEffectLayersRgba(request.composition, absoluteFrame, frameRate, width, height));
  return output;
}

/** Only one request may own transferable buffers; newest demand replaces queued work. */
export class PreviewFrameQueue {
  private sequence = 0;
  private generation = 0;
  private busy: { id: number; generation: number } | null = null;
  private pending: (() => Omit<PreviewFrameRequest, "id" | "generation"> | null) | null = null;
  private closed = false;
  constructor(private send: (request: PreviewFrameRequest) => void, private present: (result: PreviewFrameResult) => void) {}

  request(build: () => Omit<PreviewFrameRequest, "id" | "generation"> | null): void {
    if (this.closed) return;
    this.pending = build;
    this.pump();
  }

  invalidate(): void { this.generation++; this.pending = null; }

  receive(result: PreviewFrameResult): void {
    if (this.closed || !this.busy || result.id !== this.busy.id || result.generation !== this.busy.generation) return;
    this.busy = null;
    if (result.generation === this.generation) this.present(result);
    this.pump();
  }

  destroy(): void { this.closed = true; this.pending = null; this.busy = null; }

  private pump(): void {
    if (this.closed || this.busy || !this.pending) return;
    const build = this.pending;
    this.pending = null;
    const frame = build();
    if (!frame) return;
    const request = { ...frame, id: ++this.sequence, generation: this.generation };
    this.busy = { id: request.id, generation: request.generation };
    this.send(request);
  }
}
