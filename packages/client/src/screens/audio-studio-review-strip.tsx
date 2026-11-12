import type { MouseEvent } from "react";
import { Button, cx } from "../components/ui.js";

/** A note on the strip, at the time it rests on: a heard interval's start, or its line's place. */
export type ReviewPin = { key: string; n: number; at: number; title: string };

/** m:ss.s, as a heard interval is said (230o): a tenth of a second is what a listener can point at. */
export function heardClock(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}

/** Where listening should go on from: the start of the first stretch not yet heard, or null when all is. */
export function firstUnheard(heard: ReadonlyArray<readonly [number, number]>, seconds: number): number | null {
  let at = 0;
  for (const [from, to] of [...heard].sort((a, b) => a[0] - b[0])) {
    if (from > at + 0.5) return at;
    at = Math.max(at, to);
  }
  return at < seconds - 0.5 ? at : null;
}

/**
 * The review strip above an episode's timeline (design turn 230o, issue 1882): the whole episode
 * at once, its scenes as segments, what has been heard solid and what has not hatched, each note
 * pinned where it rests, and the stretch the timeline shows framed. Pressing it moves the playhead.
 */
export function AudioStudioReviewStrip({ seconds, coverage, scenes, heard, pins, view, open, onSeek, onOpen, onHearRest, hearDisabled }: {
  seconds: number; coverage: string;
  scenes: ReadonlyArray<{ key: string; n: number; title: string; from: number; to: number; on: boolean }>;
  heard: ReadonlyArray<readonly [number, number]>; pins: readonly ReviewPin[];
  view: readonly [number, number] | null; open: string | null;
  onSeek: (seconds: number) => void; onOpen: (key: string) => void; onHearRest: (from: number) => void; hearDisabled: boolean;
}) {
  const total = Math.max(seconds, 0.001), at = (value: number) => `${Math.max(0, Math.min(100, value / total * 100))}%`;
  const width = (from: number, to: number) => `${Math.max(0, Math.min(100, (to - from) / total * 100))}%`;
  const rest = firstUnheard(heard, seconds);
  const seek = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(seconds, (event.clientX - box.left) / Math.max(1, box.width) * seconds)));
  };
  return (
    <div className="fy-review-strip" role="region" aria-label="Review">
      <b>Review</b><small data-testid="strip-coverage">{coverage}</small>
      <div className="fy-review-strip__overview">
        <div className="fy-review-strip__bar" onClick={seek}>
          {scenes.map((scene) => (
            <span key={scene.key} className={cx("fy-review-strip__scene", scene.on && "fy-review-strip__scene--on")} style={{ left: at(scene.from), width: width(scene.from, scene.to) }}
              title={`${scene.n} · ${scene.title}`}>{scene.n}</span>
          ))}
          {view && <span className="fy-review-strip__window" style={{ left: at(view[0]), width: width(view[0], view[1]) }} aria-hidden />}
        </div>
        <div className="fy-review-strip__heard" aria-hidden>{heard.map(([from, to]) => <i key={`${from}-${to}`} style={{ left: at(from), width: width(from, to) }} />)}</div>
        {pins.map((pin) => (
          <button key={pin.key} type="button" className={cx("fy-review-strip__pin", open === pin.key && "fy-review-strip__pin--open")} style={{ left: at(pin.at) }}
            aria-label={`Note ${pin.n}: ${pin.title}`} title={pin.title} onClick={() => onOpen(pin.key)}>{pin.n}</button>
        ))}
      </div>
      {pins.length > 0 && <span className="fy-review-strip__count">{pins.length} note{pins.length === 1 ? "" : "s"}</span>}
      {rest !== null && <Button size="sm" disabled={hearDisabled} onClick={() => onHearRest(rest)}>{heard.length > 0 ? "Hear the rest" : "Hear it"}</Button>}
    </div>
  );
}
