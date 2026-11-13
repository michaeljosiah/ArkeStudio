import { containedPictureRect, EFFECT_SLATE_STYLE, PICTURE_SAMPLE_TOLERANCE_SEC, pictureMotionWindow, type PictureMotionPosition } from "@arke-studio/contracts";

/** Browser decoding only. Effect simulation, fitting and blending never use a second clock. */
export interface PreviewMediaSource {
  id: string;
  path: string;
  still: boolean;
  sourceSec: number;
  /** The last sample a filed segment is allowed to expose. */
  sourceOutSec?: number;
  /** Where a moving still has got to at this frame. */
  motion?: PictureMotionPosition;
  /** A video at another speed: `sourceSec` already counts it, and playback runs at it. */
  speed?: number;
  /** A video last frame first: `sourceSec` falls as the film runs. */
  reverse?: true;
}

/**
 * How far, in source seconds, the frame on a reversed clip's element may be from the frame wanted
 * and still stand in for it while the film plays. Past this it is the wrong picture rather than
 * a late one: the top of the file, shown before the first seek to the window's end has landed.
 */
const REVERSE_STAND_IN_SEC = 0.5;

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
  /** The source second the element last settled on, for a reversed clip in playback. */
  shown: number | null;
  playedAt: number;
  discontinuous: boolean;
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
      decoder = { element, still: source.still, url, failed: false, wanted: null, shown: null, playedAt: -Infinity, discontinuous: false, cleanup: () => {
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
      const target = Math.max(0, Math.min(source.sourceSec + PICTURE_SAMPLE_TOLERANCE_SEC, lastSample));
      const hold = source.sourceSec >= lastSample;
      // Left to run, the element keeps the clip's own speed, so it drifts no faster than a clip at 1.
      const rate = source.speed ?? 1;
      if (video.playbackRate !== rate) video.playbackRate = rate;
      if (decoder.discontinuous) {
        decoder.discontinuous = false; decoder.wanted = target; decoder.shown = null;
        if (Math.abs(video.currentTime - target) > 0.0001) { video.currentTime = target; return null; }
      }
      if (source.reverse && playing && !hold) {
        /*
         * A video element does not run backwards, so every frame of a reversed clip is a seek, and
         * a seek back through a long run of frames takes longer than a frame lasts. Waiting for the
         * exact frame, as a paused step does, would wait for ever while the film plays: each seek
         * lands on a frame the transport has already left. So one seek is in flight at a time, and
         * the frame the last one landed on stands in until the next lands. The picture moves, a
         * little late; stopped, it is the exact frame, by the branch below.
         */
        if (!video.paused) video.pause();
        if (!video.seeking) {
          decoder.shown = video.currentTime;
          if (Math.abs(video.currentTime - target) > 0.0001) { decoder.wanted = target; video.currentTime = target; }
        }
        if (decoder.shown === null || Math.abs(decoder.shown - target) > REVERSE_STAND_IN_SEC) return null;
      } else if (!playing || hold) {
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
      // A reversed clip in playback draws through its seek; everything else waits for its frame.
      if (video.seeking && !(source.reverse && playing && !hold)) return null;
    }
    const rect = previewContainRect(intrinsicWidth, intrinsicHeight, width, height);
    this.canvas.width = rect.width; this.canvas.height = rect.height;
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This device cannot capture picture frames for effects.");
    context.clearRect(0, 0, rect.width, rect.height);
    // A moving still keeps its place in the frame; the move chooses which part of the picture fills it.
    const part = source.still && source.motion ? pictureMotionWindow(source.motion, intrinsicWidth, intrinsicHeight) : null;
    if (part) context.drawImage(decoder.element, part.x, part.y, part.width, part.height, 0, 0, rect.width, rect.height);
    else context.drawImage(decoder.element, 0, 0, rect.width, rect.height);
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

  /** A seek/wrap is an explicit clock jump, including loops shorter than playback tolerance. */
  discontinue(): void {
    for (const decoder of this.decoders.values()) if (!decoder.still) {
      decoder.discontinuous = true;
      // A retained source may have naturally ended; the new position is a new play request.
      decoder.playedAt = -Infinity;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.retain(new Set());
    this.canvas.width = this.canvas.height = 1;
  }
}
