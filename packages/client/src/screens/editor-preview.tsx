import { useCallback, useEffect, useRef, useState } from "react";
import {
  trimCeilingSec,
  cueAtSec,
  type SubtitleStyle,
} from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import {
  PauseSolid,
  Play,
} from "../components/icons.js";
import { clock } from "../components/player.js";
import { mediaUrl } from "../lib/media.js";
import { useScrubDrag } from "../lib/timeline-drag.js";
import { onMediaReady, syncMediaElement } from "../lib/playback-engine.js";
import { mediaTimeFor, videoTimeFor, spanAt, type PlaybackSpan } from "../lib/cut-playback.js";
import {
  setShotTrim,
} from "../lib/store.js";
import { type Transport } from "./editor-transport.js";

// ---- Cut (24a) -------------------------------------------------------------

/** A tenth of a second: editorial rather than per-frame, and it lands on a frame at 10/20/30fps. */
const TRIM_STEP_SEC = 0.1;

export function CutPreview({
  slug,
  spans,
  totalSec,
  soundSec = 0,
  restartToken,
  transport,
  cueStyle = null,
  cueAt = null,
}: {
  slug: string | undefined;
  spans: PlaybackSpan[];
  totalSec: number;
  /** How far placed sound reaches, so a film with no picture is not reported as nothing. */
  soundSec?: number;
  restartToken: number;
  transport: Transport;
  /** The saved subtitle style, worn in full so the preview and the burn-in agree (SPEC-038 R-26). */
  cueStyle?: SubtitleStyle | null;
  /** The cue at a film second, read on the frame clock like the picture (round three). */
  cueAt?: ((sec: number) => ReturnType<typeof cueAtSec>) | null;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const { playing, time, timeRef, setPlaying, seek } = transport;
  /*
   * Subtitles change on the same frame loop as the picture: `time` reaches React four times a
   * second, which would open and close every cue up to a quarter second late against the sound
   * it captions. The lookup travels through a ref so the loops never restart for it, and the
   * state only moves when the cue does.
   */
  const cueAtRef = useRef(cueAt);
  cueAtRef.current = cueAt;
  const [liveCue, setLiveCue] = useState<ReturnType<typeof cueAtSec>>(() => cueAt?.(timeRef.current) ?? null);
  const syncCue = useCallback((at: number) => {
    const next = cueAtRef.current?.(at) ?? null;
    setLiveCue((previous) => (previous?.id === next?.id && previous?.text === next?.text ? previous : next));
  }, []);
  useEffect(() => {
    syncCue(timeRef.current);
  }, [cueAt, syncCue, timeRef]);

  // "Watch from top" (24a): rewind and run, without remounting the element and refetching media.
  useEffect(() => {
    if (restartToken === 0) return;
    seek(0);
    setPlaying(true);
  }, [restartToken]);

  const srcFor = (span: PlaybackSpan | null) => (span?.path && slug ? mediaUrl(slug, span.path) : null);
  /*
   * A still needs an element that decodes images (issue 453).
   *
   * Everything the story and the song clocks produce is footage, so one `<video>` was always
   * enough. A placed clip can be a plate or a board, and a browser does not decode a PNG as
   * video — handing one to the video element shows nothing while the export holds that frame for
   * the whole placement. So the two are separated at the source: the video never receives a
   * still, and the still is drawn over it by an `<img>` wearing the same class.
   */
  // An overlay with a base under it keeps the base video playing beneath it (rounds eight and
  // nine): the base element plays the base, a still is drawn by the image, and a video overlay
  // plays in its own element on top — the composition the export makes.
  const videoSrcFor = (span: PlaybackSpan | null) =>
    span?.under !== undefined && slug ? mediaUrl(slug, span.under.path) : span?.still ? null : srcFor(span);
  const overlayVideoSrcFor = (span: PlaybackSpan | null) => (span !== null && !span.still && span.under !== undefined ? srcFor(span) : null);
  const overlayVideo = useRef<HTMLVideoElement>(null);
  const syncOverlayVideo = useCallback(
    (span: PlaybackSpan | null, at: number, playingNow: boolean, nowMs: number) => {
      const el = overlayVideo.current;
      if (el === null) return;
      const src = overlayVideoSrcFor(span);
      syncMediaElement(el, { src, targetSec: span ? mediaTimeFor(span, at) : 0, playing: playingNow, nowMs });
      el.style.opacity = src === null ? "0" : "1";
    },
    [slug],
  );

  /*
   * The still is painted off the frame clock too, for the reason the video already is.
   *
   * `time` reaches React four times a second; the video source is switched every frame from
   * `timeRef`. Selecting the still from the throttled value would leave the old plate covering a
   * video that had already started, or the old video showing under a plate that had already
   * begun — a quarter second of the wrong picture at every boundary between the two, which is
   * exactly the mistake the video loop exists to avoid.
   */
  const stillLayer = useRef<HTMLSpanElement>(null);
  const paintStill = useCallback((span: PlaybackSpan | null) => {
    const layer = stillLayer.current;
    const el = video.current;
    const src = span?.still && slug && span.path ? mediaUrl(slug, span.path) : null;
    if (layer !== null) {
      let img = layer.querySelector("img");
      if (src === null) {
        img?.remove();
      } else {
        if (img === null) {
          img = layer.ownerDocument.createElement("img");
          img.className = "fy-cutviewer__video";
          img.alt = "";
          img.src = src;
          layer.append(img);
        }
        // Assigning an identical src would restart the decode every frame.
        if (img.getAttribute("src") !== src) img.setAttribute("src", src);
      }
    }
    if (el !== null) el.style.opacity = videoSrcFor(span) === null ? "0" : "1";
  }, [slug]);

  /*
   * The sync runs on its own frame loop off `timeRef`, not off `time`.
   *
   * The transport reports to React four times a second, which is right for the clock and wrong
   * for the picture: a shot boundary could be up to 250ms late, which is a quarter second of the
   * previous shot playing under the next one's label. The ref is current every frame.
   */
  useEffect(() => {
    const el = video.current;
    if (el === null || !playing) return;
    let frame = 0;
    onMediaReady(el, () => {});
    const loop = (ts: number) => {
      const at = timeRef.current;
      const span = spanAt(spans, at);
      syncMediaElement(el, {
        src: videoSrcFor(span),
        targetSec: span ? videoTimeFor(span, at) : 0,
        playing: true,
        nowMs: ts,
      });
      paintStill(span);
      syncOverlayVideo(span, at, true, ts);
      syncCue(at);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, spans, slug, paintStill, syncCue, syncOverlayVideo]);

  // Paused: one sync, so a seek lands on the right frame without a loop running. A source that
  // was not ready when it was asked calls back through onMediaReady, since nothing else will.
  useEffect(() => {
    const el = video.current;
    if (el === null || playing) return;
    const push = () => {
      const at = timeRef.current;
      const span = spanAt(spans, at);
      syncMediaElement(el, {
        src: videoSrcFor(span),
        targetSec: span ? videoTimeFor(span, at) : 0,
        playing: false,
        nowMs: 0,
      });
      paintStill(span);
      syncOverlayVideo(span, at, false, 0);
      syncCue(at);
    };
    onMediaReady(el, push);
    if (overlayVideo.current !== null) onMediaReady(overlayVideo.current, push);
    push();
  }, [playing, time, spans, slug, timeRef, paintStill, syncCue, syncOverlayVideo]);

  const current = spanAt(spans, time);
  /*
   * A film can run on sound alone (issue 453). Its length counts placed sound, so an audio-only
   * production has a real runtime and no picture at any second of it — and "nothing here yet" is
   * then simply false, said to somebody who has placed something and can see it on a lane.
   */
  const soundOnly = soundSec > 0 && spans.length === 0;
  const showingVideo = videoSrcFor(current);
  const showingStill = current?.still ? srcFor(current) : null;
  const showing = showingVideo ?? showingStill;

  return (
    <div className="fy-cutviewer">
      <video
        ref={video}
        className="fy-cutviewer__video"
        playsInline
        muted
        style={{ opacity: showingVideo === null ? 0 : 1 }}
      />
      {/* A video overlay over the base: its own element, synced on the same frame clock (round nine). */}
      <video
        ref={overlayVideo}
        className="fy-cutviewer__video"
        playsInline
        muted
        style={{ opacity: overlayVideoSrcFor(current) === null ? 0 : 1 }}
      />
      {/*
        * The frame loop owns the layer's image so it can appear at a picture boundary without
        * waiting for the throttled transport render, and disappear when there is no still source.
        */}
      <span ref={stillLayer} />
      {showing === null && (
        <span className="fy-cutviewer__empty">
          {current ? current.label : soundOnly ? "sound only" : "nothing here yet"}
        </span>
      )}
      {liveCue !== null && (
        <span
          className={cx("fy-cutviewer__cue", cueStyle?.background === "box" && "fy-cutviewer__cue--box")}
          data-cue={liveCue.id}
          aria-live="off"
          // The saved style, every field of it, so the preview and the burn-in agree (round
          // three): colour, a size and margin relative to the picture, and the decoration.
          style={
            cueStyle === null
              ? undefined
              : {
                  color: cueStyle.color,
                  fontSize: `${(cueStyle.relativeSize * 100).toFixed(2)}cqh`,
                  bottom: `${(cueStyle.bottomMargin * 100).toFixed(2)}%`,
                  textShadow: cueStyle.background === "outline" ? "0 0 3px var(--neutral-950), 0 0 6px var(--neutral-950)" : "none",
                }
          }
        >
          {liveCue.text}
        </span>
      )}
      <button
        type="button"
        className="fy-playbtn"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          if (!playing && timeRef.current >= totalSec) seek(0);
          setPlaying((p) => !p);
        }}
      >
        {playing ? <PauseSolid size={22} /> : <Play size={22} />}
      </button>
      <span className="fy-viewer__tag">
        {clock(time)} / {clock(totalSec)}
        {current ? ` · ${current.label}` : ""}
      </span>
    </div>
  );
}

/**
 * The one authored edit, shared by both clocks (80a, 81a).
 *
 * What differs between them is the figures — the song fixes a window and the story authors a
 * slot — so those arrive as text and everything else is identical, which is what "switching
 * between a short film and a music video must not move a single row" means in practice.
 */
export function TrimStrip({
  worldId,
  prodId,
  shotId,
  heading,
  title,
  figures,
  trim,
  ceiling,
}: {
  worldId: string;
  prodId: string;
  shotId: string;
  heading: string;
  title: string;
  figures: string;
  trim: number;
  ceiling: ReturnType<typeof trimCeilingSec> | null;
}) {
  // Something must survive the trim, so the last whole step before the ceiling is the ceiling here.
  const maxTrim =
    ceiling?.ok && ceiling.ceilingSec !== undefined
      ? Math.max(0, ceiling.ceilingSec - TRIM_STEP_SEC)
      : undefined;
  const trimmable = ceiling?.ok === true;
  const commit = (next: number) => {
    if (next !== trim) setShotTrim(worldId, prodId, shotId, next);
  };
  const stepTrim = (delta: number) => {
    const wanted = Math.round((trim + delta) * 1000) / 1000;
    commit(Math.max(0, maxTrim === undefined ? wanted : Math.min(wanted, maxTrim)));
  };
  /*
   * Dragging the figure is the gesture; the steppers stay for precision and for a keyboard.
   * `pixelsPerSecond` is deliberately coarse -- the strip is not a timeline, so a drag across it
   * is worth a few seconds rather than the whole cut.
   */
  const drag = useScrubDrag({
    value: trim,
    pixelsPerSecond: 40,
    min: 0,
    ...(maxTrim !== undefined ? { max: maxTrim } : {}),
    onCommit: commit,
  });
  return (
    <div className="fy-cutsel">
      <span className="fy-mono">{heading}</span>
      <span className="fy-cutsel__label">{title}</span>
      <span className="fy-h1row__push" />
      <span className="fy-mono">{figures}</span>
      <span className="fy-trim">
        <span className="fy-trim__label">TRIM IN</span>
        <button
          type="button"
          className="fy-trim__step"
          disabled={!trimmable || trim <= 0}
          aria-label="less trim"
          onClick={() => stepTrim(-TRIM_STEP_SEC)}
        >
          −
        </button>
        <span
          className={cx(
            "fy-trim__value",
            trimmable && "fy-trim__value--drag",
            drag.dragging && "fy-trim__value--dragging",
          )}
          onPointerDown={trimmable ? drag.onPointerDown : undefined}
          role={trimmable ? "slider" : undefined}
          aria-label={trimmable ? "trim in" : undefined}
          aria-valuenow={drag.display}
          aria-valuemin={0}
          {...(maxTrim !== undefined ? { "aria-valuemax": maxTrim } : {})}
        >
          {drag.display.toFixed(1)}s
        </span>
        <button
          type="button"
          className="fy-trim__step"
          disabled={!trimmable || (maxTrim !== undefined && trim >= maxTrim)}
          aria-label="more trim"
          onClick={() => stepTrim(TRIM_STEP_SEC)}
        >
          +
        </button>
      </span>
    </div>
  );
}
