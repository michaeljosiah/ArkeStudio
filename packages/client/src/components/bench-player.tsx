import { useRef, useState } from "react";
import { PauseSolid, PlaySolid } from "./icons.js";
import { clock } from "./player.js";

/**
 * The wall's clip, with the design's own transport (142a) rather than the browser's: a play disc
 * while it rests, and a bar of play, the time, a track to seek on and the length. One element
 * owns the clip; the bar and the disc only ask it.
 *
 * Shared by the bench and the production's Generate workspace, which drew its own viewer — a
 * cropped still on a box whose fill was `--primary`, and so white in the dark theme — beside a
 * play disc nobody could press. A production take can be one segment of a longer pass, so the
 * player takes the segment's bounds: the clock, the track and playback all stay inside them.
 */
export function BenchPlayer({
  src,
  poster,
  segment,
}: {
  src: string;
  poster?: string;
  segment?: { inSec: number; outSec: number };
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const start = segment?.inSec ?? 0;
  const length = segment !== undefined ? Math.max(0, segment.outSec - segment.inSec) : duration;
  const elapsed = Math.min(length, Math.max(0, time - start));
  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) {
      if (segment !== undefined && (el.currentTime < segment.inSec || el.currentTime >= segment.outSec)) {
        el.currentTime = segment.inSec;
      }
      // Switching takes can interrupt a pending play; that is not a fault worth surfacing.
      void el.play().catch(() => undefined);
    } else el.pause();
  };
  const seek = (fraction: number) => {
    const el = video.current;
    if (!el || length === 0) return;
    el.currentTime = start + Math.min(1, Math.max(0, fraction)) * length;
  };
  return (
    <>
      <video
        ref={video}
        src={src}
        poster={poster}
        playsInline
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (segment !== undefined && el.currentTime >= segment.outSec) {
            el.pause();
            el.currentTime = segment.outSec;
          }
          setTime(el.currentTime);
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          setDuration(Number.isFinite(el.duration) ? el.duration : 0);
          if (segment !== undefined) el.currentTime = segment.inSec;
        }}
        onClick={toggle}
      />
      {!playing && (
        <button type="button" className="fy-bench__playdisc" aria-label="Play" onClick={toggle}>
          <PlaySolid size={22} />
        </button>
      )}
      <div className="fy-bench__transport" data-testid="bench-transport">
        <button type="button" className="fy-bench__transportplay" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
          {playing ? <PauseSolid size={11} /> : <PlaySolid size={11} />}
        </button>
        <span className="fy-bench__transporttime">{clock(elapsed)}</span>
        <div
          className="fy-bench__transporttrack"
          role="slider"
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(length)}
          aria-valuenow={Math.round(elapsed)}
          tabIndex={0}
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            seek((e.clientX - box.left) / box.width);
          }}
          onKeyDown={(e) => {
            if (length === 0) return;
            if (e.key === "ArrowRight") seek((elapsed + 1) / length);
            if (e.key === "ArrowLeft") seek((elapsed - 1) / length);
          }}
        >
          <span style={{ width: `${length > 0 ? (elapsed / length) * 100 : 0}%` }} />
        </div>
        <span className="fy-bench__transporttime fy-bench__transporttime--end">{clock(length)}</span>
      </div>
    </>
  );
}
