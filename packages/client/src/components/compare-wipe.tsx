import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { BenchTransport } from "./bench-player.js";
import { ChevronsLeftRight } from "./icons.js";

/**
 * A before and an after over one frame, split by a line (design turn 273, issue 2402). It knows
 * nothing of takes: the host gives it two pictures or two clips, their labels and the after's
 * frame, and hears back when either will not load.
 *
 * Both layers are `cover` in one box at the after's aspect. An upscale is cover-and-centre-crop,
 * so this is what lines the source up with what was made from it.
 *
 * For clips the after is the clock. The transport plays, pauses and seeks it; the before only
 * follows, by nudging its rate, so neither side stutters. Seeking the follower on every
 * `timeupdate` was the other way, and at four times a second it visibly jumps. The rule and its
 * numbers follow openfield's Mirror compare (MIT); the code is this file's own.
 */

export interface CompareSide {
  src: string;
  kind: "image" | "video";
  /** Data only, such as `Take 19 · 864×480`; the view has no caption. */
  label: string;
  segment?: { inSec: number; outSec: number };
}

export type CompareScale = "fit" | "pixels";

/** The handle's key steps, in percent of the frame (273): Left/Right 2, with Shift 10. */
const STEP = 2;
const BIG_STEP = 10;

export const FOLLOW_RATE_MIN = 0.85;
export const FOLLOW_RATE_MAX = 1.15;
/** Past this much drift the follower seeks rather than races to catch up. */
export const FOLLOW_SEEK_SEC = 0.3;
const FOLLOW_GAIN = 0.8;
/** A paused frame is for judging detail, so there the follower lands on the leader's frame. */
const PAUSED_MATCH_SEC = 1 / 60;

const clampPct = (value: number) => Math.min(100, Math.max(0, value));

/** How the follower answers a drift, the leader's time less its own: a rate inside the band, or a seek. */
export function followStep(drift: number): { seek: true } | { seek: false; rate: number } {
  if (Math.abs(drift) > FOLLOW_SEEK_SEC) return { seek: true };
  return { seek: false, rate: Math.min(FOLLOW_RATE_MAX, Math.max(FOLLOW_RATE_MIN, 1 + drift * FOLLOW_GAIN)) };
}

/** Pixels: the after at its native width over the box it is drawn in, never smaller than Fit. */
export function pixelsScale(nativeWidth: number, boxWidth: number): number {
  return boxWidth > 0 ? Math.max(1, nativeWidth / boxWidth) : 1;
}

/** Where a key moves the handle, or null when the key is not the handle's. */
export function handleKey(at: number, key: string, shift: boolean): number | null {
  const step = shift ? BIG_STEP : STEP;
  if (key === "ArrowLeft") return clampPct(at - step);
  if (key === "ArrowRight") return clampPct(at + step);
  if (key === "Home") return 0;
  if (key === "End") return 100;
  return null;
}

export function CompareWipe({
  before,
  after,
  width,
  height,
  scale = "fit",
  onFail,
}: {
  before: CompareSide;
  after: CompareSide;
  /** The after's frame: its aspect is the box's, its width is what Pixels scales to. */
  width: number;
  height: number;
  scale?: CompareScale;
  onFail?: (side: "before" | "after") => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const leader = useRef<HTMLVideoElement>(null);
  const follower = useRef<HTMLVideoElement>(null);
  const dragging = useRef<number | null>(null);
  const [at, setAt] = useState(50);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  const [boxWidth, setBoxWidth] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setBoxWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const clips = before.kind === "video" && after.kind === "video";
  const start = after.segment?.inSec ?? 0;
  const length = after.segment !== undefined ? Math.max(0, after.segment.outSec - after.segment.inSec) : duration;
  const elapsed = Math.min(length, Math.max(0, time - start));

  // One step of the follower's clock. A segment on either side maps one take's span onto the other.
  const follow = () => {
    const lead = leader.current;
    const next = follower.current;
    if (!lead || !next || next.readyState < 1) return;
    const target = (before.segment?.inSec ?? 0) + (lead.currentTime - start);
    const drift = target - next.currentTime;
    if (lead.paused) {
      if (!next.paused) next.pause();
      if (Math.abs(drift) > PAUSED_MATCH_SEC) next.currentTime = target;
      return;
    }
    if (next.paused) void next.play().catch(() => {});
    const step = followStep(drift);
    if (step.seek) {
      next.currentTime = target;
      next.playbackRate = 1;
    } else next.playbackRate = step.rate;
  };
  const followLatest = useRef(follow);
  followLatest.current = follow;
  // The loop runs only while the leader plays; a pause, a seek or the end settles it once.
  useEffect(() => {
    if (!clips || !playing) return;
    let frame = 0;
    const tick = () => {
      followLatest.current();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    };
  }, [clips, playing]);

  const toggle = () => {
    const el = leader.current;
    if (!el) return;
    if (el.paused) {
      const segment = after.segment;
      if (segment !== undefined && (el.currentTime < segment.inSec || el.currentTime >= segment.outSec)) el.currentTime = segment.inSec;
      void el.play().catch((error: unknown) => {
        if (!(error instanceof Error && error.name === "AbortError")) onFail?.("after");
      });
    } else el.pause();
  };
  const seek = (fraction: number) => {
    const el = leader.current;
    if (!el || length === 0) return;
    el.currentTime = start + Math.min(1, Math.max(0, fraction)) * length;
  };

  const fraction = (event: PointerEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return { x: clampPct(((event.clientX - rect.left) / rect.width) * 100), y: clampPct(((event.clientY - rect.top) / rect.height) * 100) };
  };
  const grab = (event: PointerEvent) => {
    dragging.current = event.pointerId;
    box.current?.setPointerCapture?.(event.pointerId);
    const point = fraction(event);
    if (point) setAt(point.x);
  };
  const release = (event: PointerEvent) => {
    if (dragging.current !== event.pointerId) return;
    dragging.current = null;
    box.current?.releasePointerCapture?.(event.pointerId);
  };

  const zoom: CSSProperties | undefined =
    scale === "pixels" ? { transform: `scale(${pixelsScale(width, boxWidth)})`, transformOrigin: `${origin.x}% ${origin.y}%` } : undefined;
  const media = (side: CompareSide, which: "before" | "after") =>
    side.kind === "video" ? (
      which === "after" ? (
        <video
          ref={leader}
          src={side.src}
          style={zoom}
          muted
          playsInline
          preload="auto"
          onPlay={() => { setPlaying(true); follow(); }}
          onPause={() => { setPlaying(false); follow(); }}
          onEnded={() => { setPlaying(false); follow(); }}
          onSeeked={follow}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            if (after.segment !== undefined && el.currentTime >= after.segment.outSec) {
              el.pause();
              el.currentTime = after.segment.outSec;
            }
            setTime(el.currentTime);
            // A window in the background gets no animation frames; the clip's own clock still
            // ticks, and a rate nudge from it never seeks short of the drift limit.
            follow();
          }}
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            setDuration(Number.isFinite(el.duration) ? el.duration : 0);
            if (after.segment !== undefined) el.currentTime = after.segment.inSec;
          }}
          onError={() => onFail?.("after")}
        />
      ) : (
        <video ref={follower} src={side.src} style={zoom} muted playsInline preload="auto" onLoadedMetadata={follow} onError={() => onFail?.("before")} />
      )
    ) : (
      <img src={side.src} alt="" style={zoom} onError={() => onFail?.(which)} />
    );

  return (
    <div
      ref={box}
      className="fy-compare"
      data-testid="compare-wipe"
      data-scale={scale}
      // One number, as the crop preview's aspect is: `1920 / 1080` dropped into `100cqw / …`
      // divides by both and drew the box 66px tall.
      style={{ "--compare-aspect": width / height } as CSSProperties}
      // A mouse drags from anywhere on the frame. A finger starts only on the grip, so the page
      // still scrolls over the picture on a phone.
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") grab(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current === event.pointerId) {
          const point = fraction(event);
          if (point) setAt(point.x);
        } else if (scale === "pixels" && event.pointerType === "mouse") {
          const point = fraction(event);
          if (point) setOrigin(point);
        }
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div className="fy-compare__layer">{media(after, "after")}</div>
      <div className="fy-compare__layer" style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }}>{media(before, "before")}</div>
      <span className="fy-bench__overlaychip fy-compare__label fy-compare__label--before">{before.label}</span>
      <span className="fy-bench__overlaychip fy-compare__label fy-compare__label--after">{after.label}</span>
      <div
        className="fy-compare__handle"
        style={{ left: `${at}%` }}
        role="slider"
        tabIndex={0}
        aria-label="Compare"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(at)}
        onKeyDown={(event) => {
          const next = handleKey(at, event.key, event.shiftKey);
          if (next === null) return;
          event.preventDefault();
          setAt(next);
        }}
      >
        <span
          className="fy-compare__grip"
          onPointerDown={(event) => {
            event.stopPropagation();
            grab(event);
          }}
        >
          <ChevronsLeftRight size={16} />
        </span>
      </div>
      {after.kind === "video" && (
        // The bar's own presses are not drags of the line.
        <div onPointerDown={(event) => event.stopPropagation()}>
          <BenchTransport playing={playing} elapsed={elapsed} length={length} onToggle={toggle} onSeek={seek} />
        </div>
      )}
    </div>
  );
}
