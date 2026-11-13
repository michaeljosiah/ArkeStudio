import { assertEffectRasterSize, compositeRgba, addWeightedPicture, compositeWeightedTrack, effectReactionFingerprintMaterial, prepareEffectReactions, applyEffectLayersRgba, type EffectClip,
  type EffectFeatureManifest, type PreparedEffectReaction, type PictureBlendMode } from "@arke-studio/contracts";
import type { PreviewPicturePixels } from "./editor-preview-media.js";

export interface PreviewFrameRequest {
  id: number;
  generation: number;
  absoluteFrame: number;
  frameRate: number;
  width: number;
  height: number;
  pictures: Array<PreviewPicturePixels & { id: string; effects: EffectClip[]; trackId?: string; weight?: number; blendMode?: PictureBlendMode; opacity?: number }>;
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
  let trackId: string | undefined, trackPixels: Float32Array | undefined;
  const flush = () => { if (trackPixels) compositeWeightedTrack(output, trackPixels); trackPixels = undefined; };
  for (const picture of request.pictures) {
    const { rect, pixels } = picture;
    if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > width || rect.y + rect.height > height || pixels.length !== rect.width * rect.height * 4) throw new Error("The picture matte is outside the preview frame.");
    if (picture.effects.length) {
      applyEffectLayersRgba(pixels, picture.effects, absoluteFrame, frameRate, rect.width, rect.height, "atop", preparedByEffectId);
    }
    if (picture.weight !== undefined) {
      if (picture.trackId !== trackId) { flush(); trackId = picture.trackId; }
      trackPixels ??= new Float32Array(output.length);
      addWeightedPicture(trackPixels, pixels, picture.weight, rect, width, output, picture.blendMode, picture.opacity);
      continue;
    }
    flush(); trackId = undefined;
    // Rows avoid allocating a full-frame padded copy for every contained picture.
    for (let row = 0; row < rect.height; row++) {
      const at = ((rect.y + row) * width + rect.x) * 4;
      compositeRgba(output.subarray(at, at + rect.width * 4), pixels.subarray(row * rect.width * 4, (row + 1) * rect.width * 4), "over", picture.blendMode, picture.opacity);
    }
  }
  flush();
  if (request.composition.length) applyEffectLayersRgba(output, request.composition, absoluteFrame, frameRate, width, height, "over", preparedByEffectId);
  return output;
}

/** Long-song arrays cross the worker boundary only when the retained source set changes. */
export interface PreviewAnalysisInstall {
  kind: "analysis";
  analysisEpoch: number;
  effects: readonly EffectClip[];
  startFrame: number;
  endFrame: number;
  /** Omitted for a mapping-only update; a supplied object replaces the retained bounded set. */
  manifestsByKey?: Readonly<Record<string, EffectFeatureManifest>>;
  manifestKeyByEffectId: Readonly<Record<string, string>>;
}
export type PreviewAnalysisResult = { kind: "analysis-ready"; analysisEpoch: number; error?: string };
export type PreviewReactionSources = Required<Pick<PreviewAnalysisInstall, "manifestsByKey" | "manifestKeyByEffectId">>;

/** Appearance does not invalidate prepared response; source, phase and response edits do. */
export function previewReactionMappingKey(effects: readonly EffectClip[], sources: PreviewReactionSources,
  range: { startFrame: number; endFrame: number }): string {
  return JSON.stringify([range.startFrame, range.endFrame, effects.filter(effect => effect.reaction.enabled && sources.manifestKeyByEffectId[effect.id])
    .map(effect => [effect.id, effect.startFrame, effect.durationFrames, effect.preset, effect.audioInput,
      effectReactionFingerprintMaterial(effect, sources.manifestKeyByEffectId[effect.id]!)])]);
}

export class PreviewReactionBank {
  private epoch = 0;
  private prepared: Readonly<Record<string, PreparedEffectReaction>> = {};
  private error: string | null = null;
  private manifests: Readonly<Record<string, EffectFeatureManifest>> = {};

  install(input: PreviewAnalysisInstall): void {
    this.epoch = input.analysisEpoch; this.prepared = {}; this.error = null;
    try {
      if (input.manifestsByKey !== undefined) this.manifests = input.manifestsByKey;
      this.prepared = prepareEffectReactions(input.effects, this.manifests, input.manifestKeyByEffectId,
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
