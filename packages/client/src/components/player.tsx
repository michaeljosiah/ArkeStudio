import { useCallback, type ReactNode } from "react";
import { Copy, PauseSolid, PlaySolid, Speaker, X } from "./icons.js";
import { cx } from "./ui.js";
import { dismissPlayback, playClip, seekTo, togglePlayback, usePlayback, type Clip } from "../lib/audio.js";

/** "0:03", "1:07" — the dock's own clock, tabular so it does not jitter as it counts. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The player dock (design 25c). Mounted once for the whole app, outside the routes, so a clip
 * outlives the row it was started from. Every trace of progress lives here — rows never draw it.
 */
export function PlayerDock() {
  const playback = usePlayback();
  const { clip, status, currentTime, duration } = playback;

  const scrub = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (duration <= 0) return;
      const box = event.currentTarget.getBoundingClientRect();
      seekTo(((event.clientX - box.left) / box.width) * duration);
    },
    [duration],
  );

  // Arrows seek, space toggles — within the dock only. There is no global hotkey: every screen
  // here has text inputs, and stealing space from them costs more than the shortcut is worth.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowRight") {
        seekTo(currentTime + 5);
      } else if (event.key === "ArrowLeft") {
        seekTo(currentTime - 5);
      } else if (event.key === " " || event.key === "Enter") {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          togglePlayback();
        }
        return;
      } else {
        return;
      }
      event.preventDefault();
    },
    [currentTime],
  );

  if (!clip) return null;
  const playing = status === "playing";
  const known = duration > 0;

  return (
    <div className="fy-dock" role="region" aria-label="Audio player" onKeyDown={onKeyDown} tabIndex={-1}>
      <button
        type="button"
        className="fy-clipbtn"
        aria-label={playing ? `Pause ${clip.title}` : `Play ${clip.title}`}
        onClick={togglePlayback}
      >
        {playing ? <PauseSolid /> : <PlaySolid />}
      </button>
      <div className="fy-dock__label">
        <div className="fy-dock__title" title={clip.title}>
          {clip.title}
        </div>
        {clip.sub && (
          <div className="fy-dock__sub" title={clip.sub}>
            {clip.sub}
          </div>
        )}
      </div>
      {status === "error" ? (
        <div className="fy-dock__error">{playback.error}</div>
      ) : (
        <>
          <button
            type="button"
            className="fy-dock__scrub"
            disabled={!known}
            aria-label="Seek"
            role="slider"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(currentTime)}
            aria-valuetext={`${clock(currentTime)} of ${clock(duration)}`}
            onClick={scrub}
          >
            <span className="fy-dock__track">
              <span
                className="fy-dock__fill"
                style={{ width: known ? `${Math.min(100, (currentTime / duration) * 100)}%` : "0%" }}
              />
            </span>
          </button>
          <span className="fy-dock__time">
            {clock(currentTime)} / {known ? clock(duration) : "–:––"}
          </span>
        </>
      )}
      <button type="button" className="fy-dock__dismiss" aria-label="Dismiss the player" onClick={dismissPlayback}>
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * The round transport on an audio row. A row with nothing to play renders nothing at all —
 * a decorative circle that cannot sound is a promise the screen does not keep.
 */
export function ClipPlayButton({
  clip,
  small,
  large,
  busy,
  /** Generate the clip. Only pass it where generating is free and immediate — the button
      exists at all because something can sound, not to advertise that something might. */
  onStart,
  label,
}: {
  clip: Clip | null;
  small?: boolean;
  large?: boolean;
  busy?: boolean;
  onStart?: () => void;
  label?: string;
}) {
  const playback = usePlayback();
  if (!clip && !busy && !onStart) return null;
  const current = clip !== null && playback.clip?.id === clip.id;
  const playing = current && playback.status === "playing";
  const name = clip ? (playing ? `Pause ${clip.title}` : `Play ${clip.title}`) : busy ? "Preparing audio" : (label ?? "Play");
  return (
    <button
      type="button"
      className={cx("fy-clipbtn", small && "fy-clipbtn--sm", large && "fy-clipbtn--lg")}
      disabled={busy || (!clip && !onStart)}
      aria-label={name}
      title={name}
      onClick={() => {
        if (!clip) {
          onStart?.();
          return;
        }
        if (current) togglePlayback();
        else void playClip(clip);
      }}
    >
      {playing ? <PauseSolid /> : <PlaySolid />}
    </button>
  );
}

/**
 * Actions under a block of text (design 3a). Hidden until the text is hovered or something in
 * it holds focus, and kept visible while its clip is the loaded one so the sound can be traced
 * back to the text that made it. Wrap the text and this in `.fy-texthost`.
 */
export function TextActions({
  clip,
  onRead,
  copyText,
  readLabel = "Read aloud",
  note,
}: {
  /** Null while the read has not been generated yet — the speaker still starts it. */
  clip: Clip | null;
  onRead: () => void;
  copyText: string;
  readLabel?: string;
  /** Replaces the buttons while a decision is pending, e.g. a charged read's cost. */
  note?: ReactNode;
}) {
  const playback = usePlayback();
  const live = clip !== null && playback.clip?.id === clip.id;
  if (note) return <div className="fy-textactions fy-textactions--live">{note}</div>;
  return (
    <div className={cx("fy-textactions", live && "fy-textactions--live")}>
      <button
        type="button"
        className={cx("fy-textactions__btn", live && "fy-textactions__btn--live")}
        aria-label={readLabel}
        title={readLabel}
        onClick={() => {
          if (clip) void playClip(clip);
          else onRead();
        }}
      >
        <Speaker size={13} />
      </button>
      <button
        type="button"
        className="fy-textactions__btn"
        aria-label="Copy"
        title="Copy"
        onClick={() => void navigator.clipboard?.writeText(copyText)}
      >
        <Copy size={13} />
      </button>
    </div>
  );
}
