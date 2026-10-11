import { assertEffectRasterSize, compositeRgba, prepareEffectReactions, renderEffectLayersRgba, type EffectClip,
  type EffectFeatureManifest, type PreparedEffectReaction } from "@arke-studio/contracts";
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
  analysisEpoch?: number;
}

export type PreviewFrameResult = Pick<PreviewFrameRequest, "id" | "generation" | "absoluteFrame" | "width" | "height" | "analysisEpoch"> & (
  { pixels: Uint8ClampedArray; error?: never } | { error: string; pixels?: never }
);

/** The worker and browser parity fixture execute this same alpha-preserving composition. */
export function renderPreviewFrame(request: PreviewFrameRequest, preparedByEffectId?: Readonly<Record<string, PreparedEffectReaction>>): Uint8ClampedArray {
  const { width, height, absoluteFrame, frameRate } = request;
  assertEffectRasterSize(width, height);
  const output = new Uint8ClampedArray(width * height * 4);
  for (let index = 3; index < output.length; index += 4) output[index] = 255;
  for (const picture of request.pictures) {
    const { rect, pixels } = picture;
    if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > width || rect.y + rect.height > height || pixels.length !== rect.width * rect.height * 4) throw new Error("The picture matte is outside the preview frame.");
    if (picture.effects.length) {
      const effects = renderEffectLayersRgba(picture.effects, absoluteFrame, frameRate, rect.width, rect.height, preparedByEffectId);
      compositeRgba(pixels, effects, "atop");
    }
    // Rows avoid allocating a full-frame padded copy for every contained picture.
    for (let row = 0; row < rect.height; row++) {
      const at = ((rect.y + row) * width + rect.x) * 4;
      compositeRgba(output.subarray(at, at + rect.width * 4), pixels.subarray(row * rect.width * 4, (row + 1) * rect.width * 4));
    }
  }
  if (request.composition.length) compositeRgba(output, renderEffectLayersRgba(request.composition, absoluteFrame, frameRate, width, height, preparedByEffectId));
  return output;
}

/** Long-song arrays cross the worker boundary once per mapping change, never once per frame. */
export interface PreviewAnalysisInstall {
  kind: "analysis";
  analysisEpoch: number;
  effects: readonly EffectClip[];
  startFrame: number;
  endFrame: number;
  manifestsByKey: Readonly<Record<string, EffectFeatureManifest>>;
  manifestKeyByEffectId: Readonly<Record<string, string>>;
}
export type PreviewAnalysisResult = { kind: "analysis-ready"; analysisEpoch: number; error?: string };
export type PreviewReactionSources = Pick<PreviewAnalysisInstall, "manifestsByKey" | "manifestKeyByEffectId">;

export class PreviewReactionBank {
  private epoch = 0;
  private prepared: Readonly<Record<string, PreparedEffectReaction>> = {};
  private error: string | null = null;

  install(input: PreviewAnalysisInstall): void {
    this.epoch = input.analysisEpoch; this.prepared = {}; this.error = null;
    try {
      this.prepared = prepareEffectReactions(input.effects, input.manifestsByKey, input.manifestKeyByEffectId,
        { startFrame: input.startFrame, endFrame: input.endFrame });
    } catch (error) {
      this.error = error instanceof Error ? error.message : "The reaction could not be prepared.";
      throw error;
    }
  }

  render(request: PreviewFrameRequest): Uint8ClampedArray {
    if ((request.analysisEpoch ?? 0) !== this.epoch) throw new Error("The reaction frame is from an obsolete analysis.");
    if (this.error !== null) throw new Error(this.error);
    return renderPreviewFrame(request, this.prepared);
  }
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
