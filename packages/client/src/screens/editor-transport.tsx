import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FrameRate,
} from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import { clock } from "../components/player.js";
import { formatTimecode } from "../lib/timeline-drag.js";
import { useTransport } from "../lib/playback-engine.js";
import {
  useMeasuredWidth,
  type EditorTool,
} from "./editor-timeline.js";

/**
 * The lane gutter: the width of every track's label column, and the zero of every position
 * measured across the canvas. The ruler, the playhead and `.fy-track__label` have to agree on it
 * or the times printed are not the times drawn, so it is stated once and shared.
 */
export const LANE_GUTTER_PX = 88;

/** Where the playhead sits for a fraction of the film, in the one expression all of them use. */
function lanePosition(fraction: number): string {
  return `calc(${LANE_GUTTER_PX}px + (100% - ${LANE_GUTTER_PX}px) * ${Math.min(1, Math.max(0, fraction))})`;
}

/** The second of the film a pointer is over, for a box whose lanes start at the gutter. */
function secondsAtPointer(clientX: number, box: DOMRect, totalSec: number): number | null {
  const laneWidth = box.width - LANE_GUTTER_PX;
  if (laneWidth <= 0 || totalSec <= 0) return null;
  const laneX = Math.max(0, Math.min(clientX - box.left - LANE_GUTTER_PX, laneWidth));
  return (laneX / laneWidth) * totalSec;
}

/**
 * Press and drag to seek, from any surface that spans the lanes.
 *
 * The ruler and the playhead are the same gesture on two elements and they have to agree to the
 * pixel, so the arithmetic lives once. `laneOf` names what the fraction is measured across: the
 * ruler is its own box, the playhead is one pixel wide and has to ask the track stack.
 */
export function seekDrag(opts: {
  totalSec: number;
  transport: Transport;
  laneOf: (target: HTMLElement) => HTMLElement | null;
  /** The ruler jumps to where it was pressed; the playhead is already under the hand. */
  seekOnPress: boolean;
}): (e: React.PointerEvent) => void {
  const { totalSec, transport, laneOf, seekOnPress } = opts;
  const { seek, setPlaying } = transport;
  return (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const lane = laneOf(el);
    if (lane === null) return;
    // Or the press selects text across the lanes, and a drag that started on a clip label ends
    // up dragging the label instead of the transport. It costs the click its own focus, which
    // the arrow keys need, so the element asks for what the default would have given it.
    e.preventDefault();
    el.dataset.pointerSeeking = "true";
    el.focus();
    el.setPointerCapture(e.pointerId);
    // Scrubbing while it runs fights the transport for the same value; stop, then seek.
    setPlaying(false);
    const to = (clientX: number) => {
      const at = secondsAtPointer(clientX, lane.getBoundingClientRect(), totalSec);
      if (at !== null) seek(at);
    };
    if (seekOnPress) to(e.clientX);
    const move = (ev: PointerEvent) => to(ev.clientX);
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
}

/** Arrow, Home and End on whichever of the two has focus: the same seek without a pointer. */
function seekKeys(transport: Transport, totalSec: number): (e: React.KeyboardEvent) => void {
  const { time, seek } = transport;
  return (e: React.KeyboardEvent) => {
    delete (e.currentTarget as HTMLElement).dataset.pointerSeeking;
    if (e.key === "ArrowRight") seek(time + 1);
    else if (e.key === "ArrowLeft") seek(time - 1);
    else if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(totalSec);
    else return;
    e.preventDefault();
  };
}

/** Label steps a person reads a timeline in; the first that leaves room for the text wins. */
const RULER_STEPS_SEC = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
/** Room for `mm:ss` and the air the design leaves around it. */
const RULER_LABEL_PX = 64;

/** Every second the ruler prints, at the design's regular interval rather than three fixed spots. */
export function rulerTicks(totalSec: number, laneWidthPx: number): number[] {
  if (totalSec <= 0 || laneWidthPx <= 0) return [];
  const step =
    RULER_STEPS_SEC.find((candidate) => (candidate / totalSec) * laneWidthPx >= RULER_LABEL_PX) ??
    RULER_STEPS_SEC[RULER_STEPS_SEC.length - 1]!;
  const ticks: number[] = [];
  for (let at = 0; at < totalSec; at += step) ticks.push(at);
  return ticks;
}

/**
 * Seek by dragging the ruler (24a's "1:26 / 2:40" made reachable).
 *
 * Proportional rather than pixels-per-second: the ruler spans the whole cut whatever the window
 * is doing, so the fraction of its width is the fraction of the film — the same arithmetic the
 * player dock already scrubs by.
 *
 * The times are printed where they are true. Three labels pushed apart by flex named zero, half
 * and the end, but drew them at the edges of their own text: the last sat a label's width short
 * of the end it named, and the middle landed wherever the other two left room. The design draws a
 * regular interval across the lanes and so does this, every label placed by the same expression
 * the playhead is, so a clip edge under the ruler's `0:20` is at twenty seconds.
 */
export function CutScrubber({ totalSec, frameRate, transport }: { totalSec: number; frameRate: FrameRate; transport: Transport }) {
  const { time } = transport;
  const ref = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(ref);
  const onPointerDown = seekDrag({ totalSec, transport, laneOf: (el) => el, seekOnPress: true });
  return (
    <div
      ref={ref}
      className="fy-timeline__ruler fy-scrub"
      onPointerDown={onPointerDown}
      onKeyDown={seekKeys(transport, totalSec)}
      onBlur={(event) => { delete event.currentTarget.dataset.pointerSeeking; }}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(totalSec)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={formatTimecode(time, frameRate)}
    >
      {rulerTicks(totalSec, width - LANE_GUTTER_PX).map((at) => (
        <span key={at} className="fy-timeline__tick" style={{ left: lanePosition(at / totalSec) }}>
          <span className="fy-mono">{clock(at)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * What a press on the track stack lands on, when it lands on something that owns the press.
 *
 * Clips are buttons, and so are the grips inside them and a lane's Mute and Solo, so one
 * `closest` covers most of it. The three that are not: a clip's menu is a `div`, the pinned
 * label gutter is not lane at all (a press there means no second of the film), and the new-lane
 * strip is a drop target. The playhead's own band answers as a slider.
 */
export const LANE_PRESS_OWNERS =
  "button, input, select, textarea, a, [role='slider'], .fy-clipmenu, .fy-track__label, .fy-track--new";

/**
 * How near an edge the playhead may run before the canvas pages after it.
 *
 * A margin and not the edge itself: a playhead parked exactly on the boundary would page again
 * on the next frame, and a person watching wants to see what is about to happen as well as what
 * just did.
 */
const FOLLOW_MARGIN_PX = 56;

/**
 * Keep the running playhead on screen.
 *
 * Only where there is somewhere to scroll. At 1x the whole film is already in view and the
 * canvas has no business moving; `scrollWidth > clientWidth` is the zoom question asked of the
 * element rather than of the state, so a narrow window at 1x is covered by the same test.
 *
 * A page, not a glide. Pinning the playhead mid-canvas slides the whole timeline under somebody
 * trying to read a clip, which is worse than an occasional jump — and a jump is what every
 * editor that offers both defaults to.
 *
 * The leading margin clears the gutter, and that is not a detail (Codex review). The lane labels
 * are sticky and opaque, so on a scrolled canvas the leftmost thing a person can actually see is
 * the gutter's right edge, not the canvas's. A margin measured from the canvas paged the playhead
 * to a position underneath the labels — and left it there, because the next frame found the
 * margin satisfied and the line stayed hidden until it ran off the other end.
 */
export function followPlayhead(
  // Structural, and not `HTMLElement`: these four numbers are the whole of what the decision
  // reads, and saying so is what lets the decision be tested without a layout engine.
  line: { offsetLeft: number },
  canvas: { scrollWidth: number; clientWidth: number; scrollLeft: number },
): void {
  if (canvas.scrollWidth <= canvas.clientWidth) return;
  const at = line.offsetLeft;
  // What is left once the gutter has taken its share; a margin at each end of the rest.
  const visible = Math.max(0, canvas.clientWidth - LANE_GUTTER_PX);
  const margin = Math.min(FOLLOW_MARGIN_PX, visible / 4);
  const lead = LANE_GUTTER_PX + margin;
  if (at >= canvas.scrollLeft + lead && at <= canvas.scrollLeft + canvas.clientWidth - margin) return;
  canvas.scrollLeft = Math.max(0, at - lead);
}

/**
 * The playhead, and the thing a hand actually grabs.
 *
 * It was a one-pixel line under `pointer-events: none`, so the only way to move the transport was
 * the ruler — a 24-pixel strip above the lanes, which is what "only the top of it drags" meant.
 * The line is the obvious target and is one now: an invisible band rides with it, wide enough to
 * hit without aiming, and the head at the top is inside that band rather than a 7-pixel dot of
 * its own. The band is the only part that takes a pointer and it is only ever where the playhead
 * is, so a clip anywhere else on the lane is untouched by it.
 */
export function CutPlayhead({ totalSec, frameRate, transport, tool }: { totalSec: number; frameRate: FrameRate; transport: Transport; tool: EditorTool }) {
  const { time, timeRef, playing } = transport;
  const line = useRef<HTMLDivElement>(null);
  /*
   * While it runs, the line is drawn on the frame clock and the canvas pages after it.
   *
   * `time` reaches React four times a second, which is right for the readout and wrong for the
   * playhead: a line advancing in quarter-second strides reads as a stutter against picture that
   * does not stutter. The position is written to the element from `timeRef` instead — the same
   * split the preview already uses to switch its source — and React's `time` stays what the
   * readout and the slider announce, because sixty ARIA updates a second help nobody.
   *
   * Nothing is restored on the way out. The element is React's again the moment the transport
   * stops, and `useTransport` flushes the true stop position before that paint.
   */
  useEffect(() => {
    const element = line.current;
    // The same guard `useTransport` keeps: a window without the frame clock leaves the playhead
    // on React's throttled value rather than throwing on the first frame.
    if (element === null || !playing || totalSec <= 0 || typeof requestAnimationFrame !== "function") return;
    const canvas = element.closest<HTMLElement>(".fy-timeline__canvas");
    let frame = 0;
    const loop = () => {
      element.style.left = lanePosition(timeRef.current / totalSec);
      if (canvas !== null) followPlayhead(element, canvas);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, totalSec, timeRef]);
  const onPointerDown = seekDrag({
    totalSec,
    transport,
    laneOf: (el) => el.closest<HTMLElement>(".fy-tracks"),
    // Pressing the playhead grabs it where it is; jumping to the centre of the band would move
    // the transport by a few frames for a press that was meant to hold it still.
    seekOnPress: false,
  });
  return (
    <div ref={line} className="fy-playhead" style={{ left: lanePosition(time / totalSec) }}>
      <span
        // Blade cuts where it is pressed and Hand scrolls from under it; both want the lane the
        // band is sitting on, and neither is asking to move the transport. The band stands aside
        // for them rather than swallowing the one press the playhead happens to be over.
        className={cx("fy-playhead__grab", tool !== "select" && "fy-playhead__grab--idle")}
        onPointerDown={onPointerDown}
        onKeyDown={seekKeys(transport, totalSec)}
        onBlur={(event) => { delete event.currentTarget.dataset.pointerSeeking; }}
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalSec)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={formatTimecode(time, frameRate)}
      />
    </div>
  );
}

export interface Transport {
  playing: boolean;
  time: number;
  timeRef: React.MutableRefObject<number>;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  seek: (seconds: number) => void;
}

/**
 * One clock for the screen (24a): the preview shows it and the timeline draws it, so it cannot
 * live inside either. `timeRef` is the hot value the frame loops read; `time` is what renders.
 */
export function useCutTransport(totalSec: number): Transport {
  const timeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  /*
   * A film can get shorter underneath the playhead (issue 453).
   *
   * On the story and song clocks the duration is authored and changes only when somebody edits
   * the story, but a media-only film is measured from its clips — trim the one that reaches
   * furthest, drag it earlier or delete it and the end moves back. `seek` clamps, and nothing was
   * calling `seek`: the viewer sat at `0:14 / 0:05` over no span at all, blank and stuck, until
   * the person happened to scrub or press play.
   */
  useEffect(() => {
    if (timeRef.current <= totalSec) return;
    timeRef.current = totalSec;
    setTime(totalSec);
  }, [totalSec]);
  const setPosition = useTransport({
    playing,
    durationSec: totalSec,
    timeRef,
    onTime: setTime,
    onEnded: () => setPlaying(false),
  });
  const seek = useCallback(
    (seconds: number) => {
      const at = Math.min(Math.max(0, seconds), totalSec);
      setPosition(at);
      setTime(at);
    },
    [totalSec, setPosition],
  );
  return { playing, time, timeRef, setPlaying, seek };
}
