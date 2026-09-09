import { useEffect, useState } from "react";

/**
 * Frames across a video clip's width (issue 1037), drawn in the renderer from the media the
 * coordinator already serves.
 *
 * The poster is one frame; a strip is what lets a person trim by eye. The frames are decoded
 * here rather than written by the coordinator because how many there are is a fact about the
 * screen — the clip's width at the current zoom — not about the file, and a sprite sheet per
 * zoom level is a folder of pictures nobody asked for. One hidden `<video>` per source seeks
 * through the times a clip needs and paints each onto a small canvas; the result is cached by
 * source, time and height, so scrolling and re-rendering never decode a frame twice.
 *
 * Best-effort throughout: a source that will not decode, a canvas the origin taints, a browser
 * without the elements (the tests' DOM) all leave the clip on its poster.
 */

/** How tall a strip frame is drawn; the clip is 58px and the frame fills it. */
export const FILMSTRIP_HEIGHT_PX = 58;
/** A strip frame's width when the source's shape is not known yet. */
const DEFAULT_ASPECT = 16 / 9;
const JPEG_QUALITY = 0.72;
/** How many decoded sources stay alive; beyond this the oldest is released. */
const MAX_SOURCES = 6;

/** How many frames fit across `widthPx` at `heightPx`; at least one when there is any width. */
export function filmstripFrameCount(widthPx: number, heightPx: number, aspect = DEFAULT_ASPECT): number {
  if (widthPx <= 0 || heightPx <= 0) return 0;
  return Math.max(1, Math.floor(widthPx / (heightPx * aspect)));
}

/** The source times a strip samples: the middle of each of `count` equal columns. */
export function filmstripTimes(inSec: number, durationSec: number, count: number): number[] {
  if (count <= 0 || durationSec <= 0) return [];
  const column = durationSec / count;
  return Array.from({ length: count }, (_, index) => Math.round((inSec + column * (index + 0.5)) * 100) / 100);
}

interface Source {
  video: HTMLVideoElement;
  ready: Promise<void>;
  queue: Array<{ key: string; timeSec: number; heightPx: number }>;
  busy: boolean;
  failed: boolean;
  lastUsed: number;
}

const frames = new Map<string, string>();
const listeners = new Set<() => void>();
const sources = new Map<string, Source>();

function supported(): boolean {
  if (typeof document === "undefined" || typeof HTMLVideoElement === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return typeof canvas.getContext === "function" && canvas.getContext("2d") !== null;
  } catch {
    return false;
  }
}

function frameKey(src: string, timeSec: number, heightPx: number): string {
  return `${src}#${timeSec.toFixed(2)}#${heightPx}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function sourceFor(src: string): Source {
  const existing = sources.get(src);
  if (existing !== undefined) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (sources.size >= MAX_SOURCES) {
    const oldest = [...sources.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest !== undefined) {
      oldest[1].video.removeAttribute("src");
      try { oldest[1].video.load(); } catch { /* releasing a decoder is best-effort */ }
      sources.delete(oldest[0]);
    }
  }
  const video = document.createElement("video");
  // The canvas the frames are painted onto must stay readable: the media route answers CORS
  // for the app's own origin, and an anonymous request is what makes that answer count.
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  const ready = new Promise<void>((resolve, reject) => {
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("decode")), { once: true });
  });
  video.src = src;
  const source: Source = { video, ready, queue: [], busy: false, failed: false, lastUsed: Date.now() };
  sources.set(src, source);
  return source;
}

async function seekTo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  if (Math.abs(video.currentTime - timeSec) < 0.01 && video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("seek")); };
    const cleanup = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.currentTime = timeSec;
  });
}

async function drain(src: string, source: Source): Promise<void> {
  if (source.busy || source.failed) return;
  source.busy = true;
  try {
    await source.ready;
    while (source.queue.length > 0) {
      const next = source.queue.shift()!;
      if (frames.has(next.key)) continue;
      await seekTo(source.video, next.timeSec);
      const canvas = document.createElement("canvas");
      const aspect = source.video.videoWidth > 0 && source.video.videoHeight > 0 ? source.video.videoWidth / source.video.videoHeight : DEFAULT_ASPECT;
      canvas.height = next.heightPx;
      canvas.width = Math.max(1, Math.round(next.heightPx * aspect));
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("canvas");
      context.drawImage(source.video, 0, 0, canvas.width, canvas.height);
      frames.set(next.key, canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      notify();
    }
  } catch {
    // A source that cannot be read stays on its poster; asking again would only fail again.
    source.failed = true;
    source.queue.length = 0;
    notify();
  } finally {
    source.busy = false;
  }
}

/** Ask for a frame; answers from the cache at once, otherwise queues the decode and returns null. */
export function filmstripFrame(src: string, timeSec: number, heightPx: number): string | null {
  const key = frameKey(src, timeSec, heightPx);
  const cached = frames.get(key);
  if (cached !== undefined) return cached;
  if (!supported()) return null;
  const source = sourceFor(src);
  if (source.failed) return null;
  if (!source.queue.some((entry) => entry.key === key)) source.queue.push({ key, timeSec, heightPx });
  void drain(src, source);
  return null;
}

/** For tests: forget every decoded frame and source. */
export function resetFilmstrips(): void {
  frames.clear();
  sources.clear();
}

/**
 * The strip for one clip: as many frames as its width allows, each a data URL or null while it
 * is still being decoded. Re-renders as frames arrive; asks for nothing when the strip cannot
 * be drawn at all.
 */
export function useFilmstrip(args: {
  src: string | null;
  inSec: number;
  durationSec: number;
  widthPx: number;
  heightPx?: number;
}): Array<string | null> {
  const { src, inSec, durationSec, widthPx } = args;
  const heightPx = args.heightPx ?? FILMSTRIP_HEIGHT_PX;
  const [, bump] = useState(0);
  const count = src === null || !supported() ? 0 : filmstripFrameCount(widthPx, heightPx);
  const times = filmstripTimes(inSec, durationSec, count);
  useEffect(() => {
    if (times.length === 0) return;
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [times.length]);
  if (src === null || times.length === 0) return [];
  return times.map((timeSec) => filmstripFrame(src, timeSec, heightPx));
}
