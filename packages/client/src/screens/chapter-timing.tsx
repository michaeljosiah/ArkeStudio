import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  audiobookTextHash,
  formatTimingSeconds,
  hasTiming,
  reactionText,
  timeChapter,
  TIMING_ESTIMATED_CPS,
  TIMING_NUDGE_MAX_SEC,
  TIMING_START_MAX_SEC,
  TIMING_START_MIN_SEC,
  TIMING_TRIM_MAX_SEC,
  type ArtifactSidecar,
  type AudiobookReading,
  type BlockTimingInput,
  type ChapterAudiobook,
  type ChapterTiming,
  type TimedBar,
  type TimingInputBlock,
  type TimingInputReaction,
  type TimingTake,
} from "@arke-studio/contracts";
import { Button } from "../components/ui.js";
import { PlaySolid } from "../components/icons.js";
import { playClip, usePlayback } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { renderAudiobookMix, subscribeAudiobookMix } from "../lib/store.js";
import { SecondsField, round2, clamp } from "../components/fields.js";

/** Shared chapter clocks, mix playback and manual block timing for Audio Studio. */

/** What a row of the Audiobook view brings: the block, its margin's name, its reader, its take's artifact. */
export interface TimingRowLike {
  block: { key: string; text: string; speaker?: string; sheet?: string };
  mark: string;
  speakerKey: string | null;
  speaker: { label?: string; voiceId: string };
  artifact: ArtifactSidecar | null;
}

/** A take as the clock reads it: the player's rule — its words are the block's and it is on the shelf (186). */
function takeOf(record: ChapterAudiobook | null, key: string, text: string, artifact: ArtifactSidecar | null, missing: readonly string[] = []): TimingTake | undefined {
  const take = record?.takes[key];
  if (take === undefined || artifact === null || artifact.id !== take.artifactId || artifact.retiredAt !== undefined || missing.includes(take.artifactId)) return undefined;
  if (take.textHash !== audiobookTextHash(text)) return undefined;
  const measured = artifact.mediaInfo?.durationSec;
  const seconds = measured !== undefined && measured > 0 ? measured : (take.grouped?.durationSec ?? Math.max(1, text.length / TIMING_ESTIMATED_CPS));
  return {
    artifactId: take.artifactId,
    file: `artifacts/${artifact.file}`,
    seconds,
    ...(take.grouped !== undefined ? { grouped: { request: take.grouped.request, offsetSec: take.grouped.offsetSec, durationSec: take.grouped.durationSec } } : {}),
  };
}

export function timingInputs(rows: readonly TimingRowLike[], record: ChapterAudiobook | null, artifacts: readonly ArtifactSidecar[], missing: readonly string[] = []): { blocks: TimingInputBlock[]; reactions: TimingInputReaction[] } {
  const blocks = rows.map((row): TimingInputBlock => {
    const take = takeOf(record, row.block.key, row.block.text, row.artifact, missing);
    return { key: row.block.key, text: row.block.text, lane: row.speakerKey ?? "narration", ...(take !== undefined ? { take } : {}) };
  });
  const reactions = Object.entries(record?.reactions ?? {}).map(([key, reaction]): TimingInputReaction => {
    const take = record?.takes[key];
    const artifact = take === undefined ? null : (artifacts.find((candidate) => candidate.id === take.artifactId) ?? null);
    const timed = take === undefined || artifact === null ? undefined : takeOf(record, key, reactionText(reaction), artifact, missing);
    return { key, lane: reaction.speaker === "narrator" ? "narration" : reaction.speaker, ...(timed !== undefined ? { take: timed } : {}) };
  });
  return { blocks, reactions };
}

/** The chapter's clock as Audio Studio draws it: a block not read yet at the reading rate. */
export function chapterTimingOf(rows: readonly TimingRowLike[], record: ChapterAudiobook | null, artifacts: readonly ArtifactSidecar[], reading: AudiobookReading, unmade: "skip" | "estimate" = "estimate", missing: readonly string[] = []): ChapterTiming {
  const { blocks, reactions } = timingInputs(rows, record, artifacts, missing);
  return timeChapter({ blocks, reactions, record: record ?? {}, reading, unmade });
}

export interface TimingLane {
  id: string;
  name: string;
  /** Who reads it, as data. */
  sub: string;
}

/** Narration first, then each speaker in the order they first speak (R-88). */
export function timingLanes(rows: readonly TimingRowLike[]): TimingLane[] {
  const narrator = rows.find((row) => row.speakerKey === null);
  const lanes: TimingLane[] = [{ id: "narration", name: "Narration", sub: narrator?.speaker.label ?? "narrator" }];
  for (const row of rows) {
    if (row.speakerKey === null || lanes.some((lane) => lane.id === row.speakerKey)) continue;
    lanes.push({ id: row.speakerKey, name: row.mark, sub: row.speaker.label ?? row.mark });
  }
  return lanes;
}

/**
 * The chapter heard with its timing (R-85): the coordinator renders the mix, or a window of it,
 * and the answer plays through the one element the app plays everything through.
 */
export function useMixPlayer(input: { worldId: string; prodId: string; chapterId: string; chapterFile: string; slug: string; title: string; connection: string }) {
  const { worldId, prodId, chapterId, chapterFile, slug, title, connection } = input;
  const clipId = `audiobook-mix:${worldId}/${prodId}/${chapterId}`;
  const asked = useRef<{ requestId: string; from: number; to: number | null; window: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => subscribeAudiobookMix((answer) => {
    const ask = asked.current;
    if (ask === null || answer.requestId !== ask.requestId) return;
    asked.current = null;
    setPending(false);
    if (answer.mix === null) {
      setRefused(answer.refused ?? "could not mix");
      return;
    }
    const mix = answer.mix;
    setOffset(mix.from);
    const inSec = Math.max(0, ask.from - mix.from);
    const outSec = ask.to === null ? mix.seconds : Math.min(mix.seconds, ask.to - mix.from);
    void playClip({
      id: clipId,
      url: mediaUrl(slug, mix.file),
      title,
      sub: ask.window ? "audiobook · with neighbours" : "audiobook · timing",
      ...(inSec > 0 || ask.to !== null ? { range: { inSec, outSec } } : {}),
    });
  }), [clipId, slug, title]);
  /** From `from` on the chapter's clock, to `to` or the end; a window renders only that much. */
  const play = useCallback(
    (from = 0, to: number | null = null, window = false) => {
      setRefused(null);
      const requestId = renderAudiobookMix(worldId, prodId, chapterFile, window && to !== null ? { from, to } : undefined);
      if (requestId === null) return;
      asked.current = { requestId, from, to, window };
      setPending(true);
    },
    [worldId, prodId, chapterFile],
  );
  /**
   * A render asked for and no longer wanted — the chapter left, the filter changed, Stop pressed
   * (codex on PR 1500): its answer, when it comes, plays nothing.
   */
  const cancel = useCallback(() => {
    asked.current = null;
    setPending(false);
  }, []);
  // An answer is not replayed after a reconnect, so a request the transport dropped is let go.
  useEffect(() => {
    if (connection !== "open") cancel();
  }, [connection, cancel]);
  useEffect(() => cancel, [cancel, chapterId]);
  const playback = usePlayback();
  const mine = playback.clip?.id === clipId;
  // Paused is still this chapter's (codex on PR 1500): the head offers Stop, and the dock resumes
  // it where it was, rather than Play rendering from the start again.
  const playing = mine && (playback.status === "playing" || playback.status === "loading" || playback.status === "paused" || playback.status === "blocked");
  /** Where the mix is on the chapter's clock while it plays. */
  const at = mine && playback.status !== "idle" ? offset + playback.currentTime : null;
  return { play, cancel, pending, refused, playing, at, clipId };
}

/** The bar the clock is in at `t`: the block, or a reaction, sounding then. */
export function barAt(timing: ChapterTiming, t: number): TimedBar | null {
  const sounding = timing.bars.filter((bar) => bar.made && bar.at <= t && t < bar.at + bar.seconds);
  return sounding.find((bar) => bar.kind === "block" && bar.under === null) ?? sounding[0] ?? null;
}

/**
 * A time on the view's clock — where a block not read yet is drawn at the reading rate — as the
 * mix's clock, which skips it (186's rule), and back: by the block the time falls in.
 */
export function betweenClocks(from: ChapterTiming, to: ChapterTiming, t: number): number {
  const bars = from.bars.filter((bar) => bar.kind === "block" && bar.under === null).sort((a, b) => a.at - b.at);
  const target = new Map(to.bars.filter((bar) => bar.kind === "block").map((bar) => [bar.key, bar]));
  // Where the other clock stands: the end of the last block both hold that is behind `t`.
  let standing = 0;
  for (const bar of bars) {
    const there = target.get(bar.key);
    if (t >= bar.at + bar.seconds) {
      if (there !== undefined) standing = there.at + there.seconds;
      continue;
    }
    // In a block the other clock skips, or the pause before it — which the other clock skips
    // too — it lands where that clock stands (codex on PR 1506), never back at the chapter's head.
    if (there === undefined) return standing;
    // In the pause before a block both hold, as far before it on the other clock (codex on PR
    // 1500): a playhead in authored silence stays in it rather than jumping to the next block.
    return Math.max(standing, there.at + (t - bar.at));
  }
  return to.seconds;
}

/**
 * Peaks of a take for the waveform (187c), read in the browser where it can decode audio; none
 * otherwise, and the take is drawn as a flat line.
 */
function usePeaks(url: string | null, count = 120): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    setPeaks(null);
    const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (url === null || Context === undefined || typeof fetch === "undefined") return;
    let live = true;
    void (async () => {
      try {
        const bytes = await (await fetch(url)).arrayBuffer();
        const context = new Context();
        const buffer = await context.decodeAudioData(bytes);
        void context.close();
        const data = buffer.getChannelData(0);
        const size = Math.max(1, Math.floor(data.length / count));
        const out: number[] = [];
        for (let i = 0; i < count; i++) {
          let peak = 0;
          for (let j = i * size; j < Math.min(data.length, (i + 1) * size); j++) peak = Math.max(peak, Math.abs(data[j]!));
          out.push(peak);
        }
        if (live) setPeaks(out);
      } catch {
        // Undecodable here: drawn flat.
      }
    })();
    return () => {
      live = false;
    };
  }, [url, count]);
  return peaks;
}

/**
 * Seconds as a step control (194g): − the value +, a tenth a press, the value typed in as before;
 * the record answers each write, as the field's own does.
 */
function SecondsStep({ label, value, min, max, disabled, onCommit, testId, revision }: { label: string; value: number; min: number; max: number; disabled?: boolean; onCommit: (seconds: number) => void; testId?: string; revision?: number }) {
  const step = (by: number) => {
    const next = round2(clamp(value + by, min, max));
    if (next !== round2(value)) onCommit(next);
  };
  return (
    <span className="fy-abp__step">
      <button type="button" aria-label={`${label} · less`} disabled={disabled || value <= min} onClick={() => step(-0.1)}>
        −
      </button>
      <span className="fy-abp__stepval">
        <SecondsField revision={revision} label={label} {...(testId !== undefined ? { testId } : {})} value={value} min={min} max={max} {...(disabled !== undefined ? { disabled } : {})} onCommit={onCommit} />
        s
      </span>
      <button type="button" aria-label={`${label} · more`} disabled={disabled || value >= max} onClick={() => step(0.1)}>
        +
      </button>
    </span>
  );
}

/**
 * The block panel's Timing tab (187c; design turn 194, rule 12, 194g): Starts, Pause after, Plays
 * after or under, the trim on the take's waveform with its handles, a grouped cut's nudge, then the
 * block's reactions and bed (`children`), and Play with neighbours and Open in Timing at the foot —
 * the same values as the Timing view's (R-81).
 */
export function BlockTimingPanel({ bar, timing, slug, onTiming, onPlayWindow, locked, grouped, revision, children, onOpenTiming }: {
  bar: TimedBar | null;
  timing: ChapterTiming;
  slug: string;
  onTiming: (key: string, input: BlockTimingInput) => void;
  onPlayWindow: (from: number, to: number) => void;
  locked: boolean;
  /** `request 1` when the take was cut from a grouped request. */
  grouped: string | null;
  revision?: number;
  /** The block's reactions and bed, drawn between its timing and the foot. */
  children?: ReactNode;
  /** Opens the chapter's Timing view on the block. */
  onOpenTiming?: () => void;
}) {
  const file = bar !== null && bar.made ? (bar.segments.find((segment) => segment.from === 0 || segment.from === (bar.trim?.head ?? 0))?.file ?? bar.segments[0]?.file ?? null) : null;
  const peaks = usePeaks(file === null ? null : mediaUrl(slug, file));
  const wave = useRef<HTMLDivElement | null>(null);
  const [handle, setHandle] = useState<{ which: "head" | "tail"; x: number; dx: number } | null>(null);
  if (bar === null || bar.kind !== "block") return null;
  const trim = bar.trim ?? { head: 0, tail: 0 };
  const whole = bar.seconds + trim.head + trim.tail;
  const before = timing.bars.filter((candidate) => candidate.kind === "block" && candidate.under === null && candidate.index < bar.index).sort((a, b) => b.index - a.index)[0];
  const neighbours = () => {
    const blocks = timing.bars.filter((candidate) => candidate.kind === "block" && candidate.made).sort((a, b) => a.at - b.at);
    const at = blocks.findIndex((candidate) => candidate.key === bar.key);
    const previous = blocks[at - 1];
    const after = blocks[at + 1];
    onPlayWindow(previous?.at ?? bar.at, after !== undefined ? after.at + after.seconds : bar.at + bar.seconds);
  };
  const widthOf = () => wave.current?.getBoundingClientRect?.().width ?? 0;
  // The pointer is held by the handle until it is let go (codex on PR 1500): a trim is undone by
  // dragging out past the waveform's edge, where the waveform would never hear the release.
  const grab = (event: ReactPointerEvent, which: "head" | "tail") => {
    event.stopPropagation();
    (event.currentTarget as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(event.pointerId);
    setHandle({ which, x: event.clientX, dx: 0 });
  };
  const release = () => {
    if (handle === null) return;
    const span = widthOf();
    const seconds = span > 0 ? (handle.dx / span) * whole : 0;
    setHandle(null);
    if (Math.abs(handle.dx) < 2) return;
    const head = handle.which === "head" ? clamp(trim.head + seconds, 0, TIMING_TRIM_MAX_SEC) : trim.head;
    const tail = handle.which === "tail" ? clamp(trim.tail - seconds, 0, TIMING_TRIM_MAX_SEC) : trim.tail;
    onTiming(bar.key, { trim: { head: round2(head), tail: round2(tail) } });
  };
  const headPct = whole > 0 ? (trim.head / whole) * 100 : 0;
  const tailPct = whole > 0 ? (trim.tail / whole) * 100 : 0;
  return (
    <>
      <section className="fy-tm__block" data-testid="block-timing" aria-label="Timing">
        {grouped !== null && <p className="fy-abp__i fy-tm__data">grouped · {grouped}</p>}
        <div className="fy-abp__kv">
          <span className="fy-abp__k">Starts</span>
          {bar.under !== null ? (
            <span className="fy-abp__v">under the line before · {formatTimingSeconds(bar.under.offset)}</span>
          ) : bar.locked.start ? (
            <span className="fy-abp__v">{formatTimingSeconds(bar.start)} · the reader's</span>
          ) : (
            <>
              <span className="fy-abp__v">{bar.index === 0 ? "at the chapter's start" : bar.start < 0 ? "over the line before" : "after the line before"}</span>
              <SecondsStep revision={revision} label="Starts" testId="block-start" value={bar.start} min={TIMING_START_MIN_SEC} max={TIMING_START_MAX_SEC} disabled={locked || bar.index === 0} onCommit={(start) => onTiming(bar.key, { start })} />
            </>
          )}
        </div>
        <div className="fy-abp__kv">
          <span className="fy-abp__k">Pause after</span>
          {bar.pauseAfter === null ? (
            <span className="fy-abp__v fy-abp__v--off">—</span>
          ) : bar.locked.pauseAfter ? (
            <span className="fy-abp__v">{formatTimingSeconds(bar.pauseAfter)} · the reader's</span>
          ) : (
            <>
              <span className="fy-abp__v" />
              <SecondsStep revision={revision} label="Pause after" testId="block-pause" value={bar.pauseAfter} min={TIMING_START_MIN_SEC} max={TIMING_START_MAX_SEC} disabled={locked} onCommit={(pauseAfter) => onTiming(bar.key, { pauseAfter })} />
            </>
          )}
        </div>
        <div className="fy-abp__kv">
          <span className="fy-abp__k">Plays</span>
          <span className="fy-ab__chips fy-abp__plays" role="radiogroup" aria-label="Plays">
            <button type="button" role="radio" aria-checked={bar.under === null} className={`fy-ab__chip${bar.under === null ? " fy-ab__chip--on" : ""}`} disabled={locked} onClick={() => bar.under !== null && onTiming(bar.key, { under: null })}>after</button>
            <button
              type="button"
              role="radio"
              aria-checked={bar.under !== null}
              className={`fy-ab__chip${bar.under !== null ? " fy-ab__chip--on" : ""}`}
              disabled={locked || (bar.under === null && before === undefined)}
              onClick={() => bar.under === null && before !== undefined && onTiming(bar.key, { under: { host: before.key, offset: 0 } })}
            >
              under
            </button>
          </span>
        </div>
        <div className="fy-abp__sec">
          <span className="fy-abp__k">Trim</span>
          {bar.made ? (
            <>
              <div className="fy-tm__wave" ref={wave} data-testid="block-wave" onPointerMove={(event) => handle !== null && setHandle({ ...handle, dx: event.clientX - handle.x })} onPointerUp={release} onPointerCancel={() => setHandle(null)}>
                <svg viewBox="0 0 120 40" preserveAspectRatio="none" aria-hidden="true">
                  {(peaks ?? Array.from({ length: 120 }, () => 0.05)).map((peak, index) => (
                    <rect key={index} x={index} y={20 - Math.max(0.5, peak * 19)} width={0.7} height={Math.max(1, peak * 38)} />
                  ))}
                </svg>
                <span className="fy-tm__trimmed" style={{ left: 0, width: `${headPct}%` }} />
                <span className="fy-tm__trimmed" style={{ right: 0, width: `${tailPct}%` }} />
                <span className="fy-tm__handle" data-testid="wave-head" style={{ left: `${headPct}%` }} onPointerDown={(event) => !locked && grab(event, "head")} />
                <span className="fy-tm__handle" data-testid="wave-tail" style={{ right: `${tailPct}%` }} onPointerDown={(event) => !locked && grab(event, "tail")} />
              </div>
              <span className="fy-abp__waveaxis fy-abp__i">
                <span>head {formatTimingSeconds(trim.head)}</span>
                <span>{formatTimingSeconds(bar.seconds)}</span>
                <span>tail {formatTimingSeconds(trim.tail)}</span>
              </span>
            </>
          ) : (
            <span className="fy-abp__v fy-abp__v--off">not read</span>
          )}
        </div>
        {bar.nudgeable && (
          <div className="fy-abp__kv">
            <span className="fy-abp__k">Cut</span>
            <SecondsField revision={revision} label="Cut" testId="block-nudge" value={bar.nudge} min={-TIMING_NUDGE_MAX_SEC} max={TIMING_NUDGE_MAX_SEC} disabled={locked} onCommit={(nudge) => onTiming(bar.key, { nudge })} />
            <span className="fy-abp__i">{bar.nudge !== 0 ? `${formatTimingSeconds(bar.nudge, true)} nudged · ` : ""}grouped split</span>
          </div>
        )}
      </section>
      {children}
      <div className="fy-abp__foot">
        <Button variant="outline" disabled={!bar.made} onClick={neighbours} data-testid="block-play-neighbours">
          <PlaySolid size={10} />
          Play with neighbours
        </Button>
        <span className="fy-ch__panelpush" />
        {onOpenTiming !== undefined && (
          <Button variant="outline" onClick={onOpenTiming} data-testid="block-open-timing">
            Open in Audio Studio
          </Button>
        )}
      </div>
    </>
  );
}

export { hasTiming };
