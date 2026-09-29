import { formatFrames, type FrameRate } from "@arke-studio/contracts";
import { cx } from "../components/ui.js";

/**
 * The marks a gesture or a drag leaves on a lane while it is still in the air (issues 1034,
 * 1035): the chip at the pointer, the rectangle where a drop will land, and the words that say
 * what the drop will do. Shared by the sequence and the typed lanes so the two feel like one.
 */

/** Seconds as the chip states them: whole tenths, never a frame count a person has to divide. */
export function chipSeconds(frames: number, frameRate: FrameRate): string {
  return `${(frames / frameRate).toFixed(1)}s`;
}

/** The chip a gesture carries at the pointer: a timecode, and what the clip will run to. */
export function GestureChip({ x, frame, frameRate, detail, refused }: {
  x: number;
  frame: number;
  frameRate: FrameRate;
  detail?: string;
  refused?: boolean;
}) {
  return (
    <span className={cx("fy-dragchip", refused && "fy-dragchip--refused")} style={{ left: x }} data-testid="drag-chip" aria-hidden="true">
      <span className="fy-mono">{formatFrames(frame, frameRate)}</span>
      {detail !== undefined && <span className="fy-dragchip__detail">{detail}</span>}
    </span>
  );
}

/** Where a drop lands and what it does, said in the lane while the drag hovers. */
export function DropTarget({ frame, span, frameRate, widthFrames, label, refused }: {
  frame: number;
  span: number;
  frameRate: FrameRate;
  /** How long the landing clip is, when known; a default slot otherwise. */
  widthFrames: number | null;
  label: string;
  refused?: boolean;
}) {
  const width = widthFrames ?? Math.max(1, Math.round(span / 10));
  return (
    <>
      <span
        className={cx("fy-landing", refused && "fy-landing--refused")}
        style={{ left: `${(frame / span) * 100}%`, width: `${Math.max((width / span) * 100, 0.6)}%` }}
        data-testid="landing"
        aria-hidden="true"
      />
      <span className={cx("fy-droplabel", refused && "fy-droplabel--refused")} role="status">
        {refused ? label : `${label} at ${formatFrames(frame, frameRate)}`}
      </span>
    </>
  );
}
