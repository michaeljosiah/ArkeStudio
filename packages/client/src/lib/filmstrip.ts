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
 * source, time and height, so scrolling and re-rendering can reuse decoded frames.
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
/** How many frames the cache keeps; past this a quarter goes, oldest first, insertion order being age. */
const MAX_FRAMES = 2000;

/**
 * Make room in the cache: up to a quarter of `max` goes, oldest first, skipping every frame a
 * mounted strip still shows. An evicted frame is never asked for again — the hook asks once per
 * signature — so a strip that lost one to a long session's browsing stayed on its poster for
 * good. Active requests share the cache's budget, so any excess is unclaimed and can go.
 * Returns how many went.
 */
export function evictFrames(cache: Map<string, string>, stillWanted: (key: string) => boolean, max = MAX_FRAMES): number {
  const target = Math.floor(max / 4);
  let evicted = 0;
  for (const key of cache.keys()) {
    if (evicted >= target) break;
    if (stillWanted(key)) continue;
    cache.delete(key);
    evicted += 1;
  }
  return evicted;
}
/** Past this many waiting decodes a source's queue is pruned of the times no strip wants any more. */
const MAX_QUEUE = 24;

/**
 * A queue kept within `max` by dropping only what nobody wants: a live trim asks for new times
 * faster than they decode and the old ones go, but a wide clip at a deep zoom legitimately wants
 * more than the cap at once, and a wanted time dropped here was never asked for again — the
 * hook asks once per signature — so its column stayed on the poster for good.
 */
export function pruneQueue<T extends { key: string }>(queue: readonly T[], stillWanted: (key: string) => boolean, max = MAX_QUEUE): T[] {
  if (queue.length <= max) return [...queue];
  return queue.filter((entry) => stillWanted(entry.key));
}

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
/** The strips to wake when a source decodes a frame, by source; a frame of one clip is nothing to the others. */
const listeners = new Map<string, Set<() => void>>();
const sources = new Map<string, Source>();
/** The frames some mounted strip still wants, by key, with how many want them. A decode nobody wants any more is skipped. */
const wanted = new Map<string, number>();
/** Strips over the frame budget stay on their posters until another strip releases room. */
const waitingStrips = new Set<() => void>();
let admissionScheduled = false;
/** Frames asked of a source not made yet, because the cap was reached with every decoder busy. */
const pending = new Map<string, Source["queue"]>();

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

function notify(src: string): void {
  // Only the strips over this source: on a cut with many clips, waking every strip for every
  // frame made the first load cost clips times frames in renders, most of them for nothing.
  for (const listener of listeners.get(src) ?? []) listener();
}

/**
 * Which source to release so another can be made, or null when none may go. Only an idle source
 * nobody still wants frames from qualifies: one evicted mid-decode leaves its strips on their
 * posters, since nothing re-asks for a source that vanished under them. Oldest use goes first.
 */
export function evictableSource<T extends { busy: boolean; queue: ReadonlyArray<{ key: string }>; lastUsed: number }>(
  candidates: Iterable<readonly [string, T]>,
  stillWanted: (key: string) => boolean,
): string | null {
  let oldest: readonly [string, T] | null = null;
  for (const candidate of candidates) {
    if (candidate[1].busy || candidate[1].queue.some((entry) => stillWanted(entry.key))) continue;
    if (oldest === null || candidate[1].lastUsed < oldest[1].lastUsed) oldest = candidate;
  }
  return oldest === null ? null : oldest[0];
}

/** The decoder for `src`, or null when the cap is reached and every decoder is still at work. */
function sourceFor(src: string): Source | null {
  const existing = sources.get(src);
  if (existing !== undefined) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (sources.size >= MAX_SOURCES) {
    const evict = evictableSource(sources.entries(), (key) => wanted.has(key));
    // At the cap with every decoder busy, the new source waits its turn (`pending`) rather than
    // becoming a seventh decoder — and an eighth — on a cut with many distinct clips.
    if (evict === null) return null;
    const gone = sources.get(evict)!;
    gone.video.removeAttribute("src");
    try { gone.video.load(); } catch { /* releasing a decoder is best-effort */ }
    sources.delete(evict);
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
      // A time a strip asked for and has since moved past — the head of a clip under a live trim
      // asks for a new one at every pointer update — is not worth a seek.
      if (frames.has(next.key) || !wanted.has(next.key)) continue;
      await seekTo(source.video, next.timeSec);
      const canvas = document.createElement("canvas");
      const aspect = source.video.videoWidth > 0 && source.video.videoHeight > 0 ? source.video.videoWidth / source.video.videoHeight : DEFAULT_ASPECT;
      canvas.height = next.heightPx;
      canvas.width = Math.max(1, Math.round(next.heightPx * aspect));
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("canvas");
      context.drawImage(source.video, 0, 0, canvas.width, canvas.height);
      frames.set(next.key, canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      if (frames.size > MAX_FRAMES) evictFrames(frames, (candidate) => wanted.has(candidate));
      notify(src);
    }
  } catch {
    // A source that cannot be read stays on its poster; asking again would only fail again.
    source.failed = true;
    source.queue.length = 0;
    notify(src);
  } finally {
    source.busy = false;
    admitPending();
  }
}

/** Sources that waited at the cap take their turn as decoders go idle, in the order they asked. */
function admitPending(): void {
  // Deleting the entry in hand while a Map is iterated is defined behaviour; nothing here adds one.
  for (const [src, queue] of pending) {
    const live = queue.filter((entry) => wanted.has(entry.key) && !frames.has(entry.key));
    if (live.length === 0) {
      pending.delete(src);
      continue;
    }
    const source = sourceFor(src);
    if (source === null) return;
    pending.delete(src);
    for (const entry of live) if (!source.queue.some((queued) => queued.key === entry.key)) source.queue.push(entry);
    void drain(src, source);
  }
}

/** Ask for a frame; answers from the cache at once, otherwise queues the decode and returns null. */
export function filmstripFrame(src: string, timeSec: number, heightPx: number): string | null {
  const key = frameKey(src, timeSec, heightPx);
  const cached = frames.get(key);
  if (cached !== undefined) return cached;
  if (!supported()) return null;
  const source = sourceFor(src);
  if (source === null) {
    const waiting = pending.get(src) ?? [];
    if (!waiting.some((entry) => entry.key === key)) waiting.push({ key, timeSec, heightPx });
    pending.set(src, pruneQueue(waiting, (candidate) => wanted.has(candidate)));
    return null;
  }
  if (source.failed) return null;
  if (!source.queue.some((entry) => entry.key === key)) {
    source.queue.push({ key, timeSec, heightPx });
    if (source.queue.length > MAX_QUEUE) source.queue = pruneQueue(source.queue, (candidate) => wanted.has(candidate));
  }
  void drain(src, source);
  return null;
}

/** For tests: forget every decoded frame and source. */
export function resetFilmstrips(): void {
  frames.clear();
  sources.clear();
  wanted.clear();
  pending.clear();
  waitingStrips.clear();
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
  const count = src === null || !supported() ? 0 : Math.min(MAX_FRAMES, filmstripFrameCount(widthPx, heightPx));
  const times = filmstripTimes(inSec, durationSec, count);
  const keys = src === null ? [] : times.map((timeSec) => frameKey(src, timeSec, heightPx));
  const signature = keys.join("|");
  // The render reads the cache and nothing more; the asking happens in the effect, after the
  // strip has said which frames it wants, so a decode is never queued for a frame that is
  // unwanted by the time it runs.
  useEffect(() => {
    if (src === null || keys.length === 0) return;
    const claimed = new Set<string>();
    const ask = () => {
      let waiting = false;
      let added = false;
      keys.forEach((key, index) => {
        if (claimed.has(key)) return;
        if (!wanted.has(key) && wanted.size >= MAX_FRAMES) {
          waiting = true;
          return;
        }
        wanted.set(key, (wanted.get(key) ?? 0) + 1);
        claimed.add(key);
        added = true;
        filmstripFrame(src, times[index]!, heightPx);
      });
      if (waiting) waitingStrips.add(ask);
      else waitingStrips.delete(ask);
      if (added) bump((n) => n + 1);
    };
    const listener = () => bump((n) => n + 1);
    let waking = listeners.get(src);
    if (waking === undefined) {
      waking = new Set();
      listeners.set(src, waking);
    }
    waking.add(listener);
    ask();
    return () => {
      waitingStrips.delete(ask);
      waking.delete(listener);
      if (waking.size === 0) listeners.delete(src);
      for (const key of claimed) {
        const count = wanted.get(key) ?? 0;
        if (count <= 1) wanted.delete(key);
        else wanted.set(key, count - 1);
      }
      // Defer admission until all effect cleanups finish, so disappearing strips cannot claim
      // the room just released. A waiting strip asks again even though its signature is unchanged.
      if (waitingStrips.size > 0 && !admissionScheduled) {
        admissionScheduled = true;
        queueMicrotask(() => {
          admissionScheduled = false;
          for (const ask of waitingStrips) ask();
        });
      }
      // A strip gone may leave a decoder idle; whoever waited at the cap gets it.
      admitPending();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, heightPx, signature]);
  if (src === null || keys.length === 0) return [];
  return keys.map((key) => frames.get(key) ?? null);
}
