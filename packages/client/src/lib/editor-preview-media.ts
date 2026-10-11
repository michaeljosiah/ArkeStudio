import { containedPictureRect, EFFECT_SLATE_STYLE } from "@arke-studio/contracts";

/** Browser decoding only. Effect simulation, fitting and blending never use a second clock. */
export interface PreviewMediaSource {
  id: string;
  path: string;
  still: boolean;
  sourceSec: number;
  /** The last sample a filed segment is allowed to expose. */
  sourceOutSec?: number;
}

export interface PreviewPicturePixels {
  rect: { x: number; y: number; width: number; height: number };
  pixels: Uint8ClampedArray;
}

/** Integer contain geometry shared by capture and the target-local effect raster. */
export const previewContainRect = containedPictureRect;

interface Decoder {
  element: HTMLImageElement | HTMLVideoElement;
  still: boolean;
  url: string;
  failed: boolean;
  wanted: number | null;
  playedAt: number;
  cleanup: () => void;
}

/** Retains decoders across frame requests; inactive sources are released, never left sounding. */
export class PreviewMediaPool {
  private decoders = new Map<string, Decoder>();
  private canvas: HTMLCanvasElement;
  private destroyed = false;
  private slateFontReady = false;
  private slateFontWaiting = false;
  private slateFontFailed = false;
  constructor(private doc: Document, private urlFor: (path: string) => string | null, private ready: () => void) {
    this.canvas = doc.createElement("canvas");
  }

  retain(ids: ReadonlySet<string>): void {
    for (const [id, decoder] of this.decoders) if (!ids.has(id)) {
      decoder.cleanup();
      this.decoders.delete(id);
    }
  }

  capture(source: PreviewMediaSource, width: number, height: number, playing: boolean, nowMs: number, frameRate: number): PreviewPicturePixels | null {
    const url = this.urlFor(source.path);
    if (!url) throw new Error(`Picture ${source.id} has no available media URL.`);
    let decoder = this.decoders.get(source.id);
    if (decoder && (decoder.url !== url || decoder.still !== source.still)) {
      decoder.cleanup();
      this.decoders.delete(source.id);
      decoder = undefined;
    }
    if (!decoder) {
      const element = this.doc.createElement(source.still ? "img" : "video");
      element.crossOrigin = "anonymous";
      const changed = () => { if (!this.destroyed) this.ready(); };
      const error = () => { const current = this.decoders.get(source.id); if (current) current.failed = true; changed(); };
      const events = source.still ? ["load"] : ["loadeddata", "loadedmetadata", "seeked", "canplay"];
      for (const event of events) element.addEventListener(event, changed);
      element.addEventListener("error", error);
      if (!source.still) {
        const video = element as HTMLVideoElement;
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
      }
      decoder = { element, still: source.still, url, failed: false, wanted: null, playedAt: -Infinity, cleanup: () => {
        for (const event of events) element.removeEventListener(event, changed);
        element.removeEventListener("error", error);
        if (!source.still) (element as HTMLVideoElement).pause();
        element.removeAttribute("src");
        if (!source.still) (element as HTMLVideoElement).load();
      } };
      this.decoders.set(source.id, decoder);
      element.src = url;
    }
    if (decoder.failed) throw new Error(`Picture ${source.id} could not be decoded.`);
    let intrinsicWidth: number, intrinsicHeight: number;
    if (source.still) {
      const image = decoder.element as HTMLImageElement;
      if (!image.complete || !image.naturalWidth) return null;
      intrinsicWidth = image.naturalWidth; intrinsicHeight = image.naturalHeight;
    } else {
      const video = decoder.element as HTMLVideoElement;
      if (video.readyState < 2) return null;
      intrinsicWidth = video.videoWidth; intrinsicHeight = video.videoHeight;
      const end = Math.min(source.sourceOutSec ?? Infinity, Number.isFinite(video.duration) ? video.duration : Infinity);
      // Chromium quantizes currentTime to microseconds. Seeking exactly to e.g. 10/24 can
      // land just before frame 10; sample inside it. At a physical end use the last source
      // sample, not one output-frame interval earlier (source and production rates may differ).
      const lastSample = end === Infinity ? Infinity : Math.max(0, end - 0.0001);
      const target = Math.max(0, Math.min(source.sourceSec + 0.0001, lastSample));
      const hold = source.sourceSec >= lastSample;
      if (!playing || hold) {
        if (!video.paused) video.pause();
        // Unlike the free-running monitor, paused frame steps cannot use a 120 ms tolerance.
        if (decoder.wanted !== target || Math.abs(video.currentTime - target) > 0.0001) {
          decoder.wanted = target;
          if (Math.abs(video.currentTime - target) > 0.0001) { video.currentTime = target; return null; }
        }
      } else {
        if (decoder.wanted === null || Math.abs(video.currentTime - target) > 0.25) {
          decoder.wanted = target;
          if (Math.abs(video.currentTime - target) > 1 / frameRate) { video.currentTime = target; return null; }
        }
        if (video.paused && nowMs - decoder.playedAt >= 500) {
          decoder.playedAt = nowMs;
          void video.play().catch(() => {});
        }
      }
      if (video.seeking) return null;
    }
    const rect = previewContainRect(intrinsicWidth, intrinsicHeight, width, height);
    this.canvas.width = rect.width; this.canvas.height = rect.height;
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This device cannot capture picture frames for effects.");
    context.clearRect(0, 0, rect.width, rect.height);
    context.drawImage(decoder.element, 0, 0, rect.width, rect.height);
    return { rect, pixels: context.getImageData(0, 0, rect.width, rect.height).data };
  }

  captureSlate(label: string, width: number, height: number, resolution: number): PreviewPicturePixels | null {
    if (this.slateFontFailed) throw new Error("The bundled slate font could not be loaded.");
    if (!this.slateFontReady && this.doc.fonts) {
      if (!this.slateFontWaiting) {
        this.slateFontWaiting = true;
        void this.doc.fonts.load(`${EFFECT_SLATE_STYLE.fontSize}px "${EFFECT_SLATE_STYLE.fontFamily}"`).then(() => {
          this.slateFontReady = true;
          if (!this.destroyed) this.ready();
        }).catch(() => {
          this.slateFontFailed = true;
          if (!this.destroyed) this.ready();
        });
      }
      return null;
    }
    this.canvas.width = width; this.canvas.height = height;
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This device cannot draw a picture slate.");
    context.fillStyle = EFFECT_SLATE_STYLE.background;
    context.fillRect(0, 0, width, height);
    context.fillStyle = EFFECT_SLATE_STYLE.colour;
    context.font = `${EFFECT_SLATE_STYLE.fontSize * resolution}px "${EFFECT_SLATE_STYLE.fontFamily}"`;
    context.textAlign = "center";
    const metrics = context.measureText(label);
    context.fillText(label, width / 2, (height + metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
    return { rect: { x: 0, y: 0, width, height }, pixels: context.getImageData(0, 0, width, height).data };
  }

  pause(): void {
    for (const decoder of this.decoders.values()) if (!decoder.still) (decoder.element as HTMLVideoElement).pause();
  }

  destroy(): void {
    this.destroyed = true;
    this.retain(new Set());
    this.canvas.width = this.canvas.height = 1;
  }
}
