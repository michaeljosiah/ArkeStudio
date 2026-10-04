import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  audiobookTextHash,
  formatRunningTime,
  formatTimingSeconds,
  applyTimingProposal,
  hasTiming,
  proposalCounts,
  type TimingProposal,
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
import { acceptAudiobookTiming, proposeAudiobookTiming, renderAudiobookMix, setAudiobookTiming, subscribeAudiobookMix, subscribeAudiobookTimingProposal, useAudiobookRecords } from "../lib/store.js";

/**
 * Timing (design turn 187, SPEC-047 R-80..R-88): the chapter's third view beside Manuscript and
 * Audiobook — a lane a voice, the blocks as bars in time, a ruler and a playhead — and the same
 * values in the Audiobook view's block panel. Nothing here keeps timing of its own: the bars are
 * the record's timing laid on the clock by the one rule the coordinator mixes by (`timeChapter`),
 * and every drag or field is one `set-audiobook-timing` write the record answers.
 */

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

/** The chapter's clock as the Timing view draws it: a block not read yet at the reading rate. */
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

const ZOOMS = [10, 20, 40, 80, 160] as const;
const TICKS = [1, 2, 4, 5, 10, 15, 30, 60, 120, 300, 600];
const round2 = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type Drag = { key: string; mode: "move" | "head" | "tail" | "pause"; x: number; y: number; dx: number; dy: number };

/**
 * The Timing view (187a): lanes of 64 with a 120-wide name column, bars of 40 with their words and
 * a mono line, reactions 28 high in italic, overlaps hatched, a ruler, a playhead; zoom and scroll.
 * Dragging a bar moves its start (or, under another, its offset); its edges trim the take; the
 * grip after it sets the pause after it; dropping it over a bar in another lane plays it under.
 */
export function TimingView({ timing, lanes, rows, selected, onSelect, onTiming, playhead, onPlayhead, locked, reactionLabels, proposed }: {
  timing: ChapterTiming;
  lanes: readonly TimingLane[];
  rows: readonly TimingRowLike[];
  selected: string | null;
  onSelect: (key: string) => void;
  onTiming: (key: string, input: BlockTimingInput) => void;
  playhead: number;
  onPlayhead: (seconds: number) => void;
  locked: boolean;
  /** What each reaction says, by its key: drawn on its bar in italic (R-88). */
  reactionLabels?: Readonly<Record<string, string>>;
  /** Bars and beds Arke proposes (187b): drawn dashed until the proposal is accepted whole. */
  proposed?: ReadonlySet<string>;
}) {
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(40);
  const [drag, setDrag] = useState<Drag | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pps = zoom;
  const laneIndex = useMemo(() => new Map(lanes.map((lane, index) => [lane.id, index])), [lanes]);
  const bedLane = lanes.length;
  const width = Math.max(600, Math.ceil((timing.seconds + 4) * pps));
  const tick = TICKS.find((step) => step * pps >= 90) ?? 600;
  const rowOf = useMemo(() => new Map(rows.map((row) => [row.block.key, row])), [rows]);

  // It opens on the selected block (R-88): scrolled so the bar is in view.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || selected === null) return;
    const bar = timing.bars.find((candidate) => candidate.key === selected);
    const node = scroller.current;
    if (bar === undefined || node === null) return;
    opened.current = true;
    node.scrollLeft = Math.max(0, bar.at * pps - 80);
  }, [selected, timing.bars, pps]);

  const begin = (event: ReactPointerEvent, key: string, mode: Drag["mode"]) => {
    if (locked || event.button !== 0) return;
    event.stopPropagation();
    (event.currentTarget as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(event.pointerId);
    setDrag({ key, mode, x: event.clientX, y: event.clientY, dx: 0, dy: 0 });
    onSelect(selectable(key));
  };
  // A reaction is listed on its host (R-83): pressing it selects that block, which both views know (codex on PR 1500).
  const selectable = (key: string): string => {
    const bar = timing.bars.find((candidate) => candidate.key === key);
    return bar?.kind === "reaction" && bar.under !== null ? bar.under.host : key;
  };
  const move = (event: ReactPointerEvent) => {
    if (drag === null) return;
    setDrag({ ...drag, dx: event.clientX - drag.x, dy: event.clientY - drag.y });
  };
  const end = () => {
    if (drag === null) return;
    const held = drag;
    setDrag(null);
    const bar = timing.bars.find((candidate) => candidate.key === held.key);
    if (bar === undefined || bar.kind !== "block") return;
    const seconds = held.dx / pps;
    if (Math.abs(held.dx) < 3 && Math.abs(held.dy) < 8) return;
    if (held.mode === "move") {
      // Dropped over a bar in another lane: plays under it, from where it was dropped (R-88).
      const own = laneIndex.get(bar.lane) ?? 0;
      const lane = own + Math.round(held.dy / 64);
      if (lane !== own && lane >= 0 && lane < lanes.length) {
        const t = bar.at + seconds;
        const host = timing.bars.find((candidate) => candidate.kind === "block" && candidate.key !== bar.key && laneIndex.get(candidate.lane) === lane && candidate.at <= t && t < candidate.at + candidate.seconds);
        if (host !== undefined) {
          onTiming(bar.key, { under: { host: host.key, offset: round2(Math.max(0, t - host.at)) } });
          return;
        }
      }
      if (bar.under !== null) {
        onTiming(bar.key, { under: { host: bar.under.host, offset: round2(Math.max(0, bar.under.offset + seconds)) } });
        return;
      }
      // The chapter's first block starts the chapter (codex on PR 1500): it has no start to drag,
      // as the side's Starts is closed for it.
      const first = timing.bars.filter((candidate) => candidate.kind === "block" && candidate.under === null).reduce((low, candidate) => Math.min(low, candidate.index), Infinity);
      if (bar.locked.start || bar.index === first) return;
      onTiming(bar.key, { start: round2(clamp(bar.start + seconds, TIMING_START_MIN_SEC, TIMING_START_MAX_SEC)) });
      return;
    }
    if (held.mode === "pause") {
      if (bar.pauseAfter === null || bar.locked.pauseAfter) return;
      onTiming(bar.key, { pauseAfter: round2(clamp(bar.pauseAfter + seconds, TIMING_START_MIN_SEC, TIMING_START_MAX_SEC)) });
      return;
    }
    if (!bar.made) return;
    const trim = bar.trim ?? { head: 0, tail: 0 };
    const head = held.mode === "head" ? clamp(trim.head + seconds, 0, TIMING_TRIM_MAX_SEC) : trim.head;
    const tail = held.mode === "tail" ? clamp(trim.tail - seconds, 0, TIMING_TRIM_MAX_SEC) : trim.tail;
    onTiming(bar.key, { trim: { head: round2(head), tail: round2(tail) } });
  };

  const shown = (bar: TimedBar): { left: number; width: number; top: number } => {
    let at = bar.at;
    let seconds = bar.seconds;
    let dy = 0;
    if (drag !== null && drag.key === bar.key) {
      const delta = drag.dx / pps;
      if (drag.mode === "move") {
        at += delta;
        dy = drag.dy;
      } else if (drag.mode === "head") {
        at += delta;
        seconds -= delta;
      } else if (drag.mode === "tail") seconds += delta;
    }
    const lane = bar.kind === "reaction" ? (laneIndex.get(bar.lane) ?? 0) : (laneIndex.get(bar.lane) ?? 0);
    const top = lane * 64 + (bar.kind === "reaction" ? 30 : 12) + dy;
    return { left: Math.max(0, at) * pps, width: Math.max(4, seconds * pps), top };
  };

  const line = (bar: TimedBar): string => {
    const parts = [bar.key === "title" ? "title" : bar.kind === "reaction" ? "" : bar.key];
    if (!bar.made) parts.push("not read");
    else parts.push(formatTimingSeconds(bar.seconds));
    if (bar.under !== null) parts.push("under");
    else if (bar.start < 0) parts.push(`starts ${formatTimingSeconds(bar.start)}`);
    else if (bar.start > 0 && bar.index > 0) parts.push(`p ${formatTimingSeconds(bar.start)}`);
    return parts.filter((part) => part !== "").join(" · ");
  };

  return (
    <section className="fy-tm" data-testid="timing-view" aria-label="Timing">
      <div className="fy-tm__tools">
        <span className="fy-mono">{formatRunningTime(timing.seconds)}{timing.estimated ? " · estimated" : ""}</span>
        {timing.overlaps.length > 0 && <span className="fy-mono">{timing.overlaps.length} overlap{timing.overlaps.length === 1 ? "" : "s"}</span>}
        <span className="fy-tm__push" />
        <Button variant="ghost" size="sm" aria-label="Zoom out" disabled={zoom === ZOOMS[0]} onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)]!)}>−</Button>
        <Button variant="ghost" size="sm" aria-label="Zoom in" disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)]!)}>+</Button>
      </div>
      <div className="fy-tm__frame">
        <div className="fy-tm__names" aria-hidden="true">
          <div className="fy-tm__ruler-pad" />
          {lanes.map((lane) => (
            <div key={lane.id} className="fy-tm__name">
              {lane.name}
              <small>{lane.sub}</small>
            </div>
          ))}
          <div className="fy-tm__name">
            Beds &amp; sounds
            <small>{timing.beds.length + timing.sounds.length === 0 ? "none" : [timing.beds.length > 0 ? `${timing.beds.length} bed${timing.beds.length === 1 ? "" : "s"}` : "", timing.sounds.length > 0 ? `${timing.sounds.length} sound${timing.sounds.length === 1 ? "" : "s"}` : ""].filter((part) => part !== "").join(" · ")}</small>
          </div>
        </div>
        <div className="fy-tm__scroll" ref={scroller} data-testid="timing-scroll">
          <div className="fy-tm__track" style={{ width }} onPointerMove={move} onPointerUp={end} onPointerCancel={() => setDrag(null)}>
            <div
              className="fy-tm__ruler"
              data-testid="timing-ruler"
              onPointerDown={(event) => {
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect?.();
                if (rect !== undefined) onPlayhead(Math.max(0, (event.clientX - rect.left) / pps));
              }}
            >
              {Array.from({ length: Math.floor(timing.seconds / tick) + 2 }, (_, index) => (
                <span key={index} style={{ left: index * tick * pps }}>{formatRunningTime(index * tick)}</span>
              ))}
            </div>
            <div className="fy-tm__lanes" style={{ height: (bedLane + 1) * 64 }}>
              {[...lanes, null].map((lane, index) => <div key={lane?.id ?? "beds"} className="fy-tm__lane" style={{ top: index * 64 }} />)}
              {timing.overlaps.map((span) => (
                <div key={`${span.from}`} className="fy-tm__overlap" data-testid="timing-overlap" style={{ left: span.from * pps, width: Math.max(2, (span.to - span.from) * pps) }} />
              ))}
              {timing.beds.map((bed) => (
                <div key={bed.id} className={proposed?.has(bed.id) === true ? "fy-tm__bed fy-tm__bed--proposed" : "fy-tm__bed"} data-testid="timing-bed" style={{ left: bed.at * pps, width: Math.max(4, bed.seconds * pps), top: bedLane * 64 + 12 }}>
                  {bed.source.label} · {bed.levelDb} dB{bed.duckDb > 0 ? " · ducks under voices" : ""}
                </div>
              ))}
              {timing.sounds.map((sound) => (
                <div key={sound.id} className="fy-tm__sound" style={{ left: sound.at * pps, top: bedLane * 64 + 34 }}>{sound.source.label}</div>
              ))}
              {timing.bars.map((bar) => {
                const place = shown(bar);
                const row = rowOf.get(bar.key);
                const words = bar.kind === "reaction" ? `${reactionLabels?.[bar.key] ?? bar.key} under` : (row?.block.text ?? bar.key);
                const reaction = bar.kind === "reaction";
                return (
                  <div
                    key={bar.key}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected === bar.key}
                    aria-label={`${row?.mark ?? "reaction"} · ${bar.key}`}
                    data-testid="timing-bar"
                    data-key={bar.key}
                    className={[
                      "fy-tm__bar",
                      reaction ? "fy-tm__bar--reaction" : "",
                      bar.made ? "" : "fy-tm__bar--unread",
                      bar.overlaps ? "fy-tm__bar--overlap" : "",
                      proposed?.has(bar.key) === true ? "fy-tm__bar--proposed" : "",
                      selected === bar.key ? "fy-tm__bar--on" : "",
                    ].filter((name) => name !== "").join(" ")}
                    style={{ left: place.left, width: place.width, top: place.top }}
                    onPointerDown={(event) => begin(event, bar.key, "move")}
                    onClick={() => onSelect(selectable(bar.key))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") onSelect(selectable(bar.key));
                    }}
                  >
                    {!reaction && bar.made && <span className="fy-tm__edge fy-tm__edge--head" data-testid="timing-head" onPointerDown={(event) => begin(event, bar.key, "head")} />}
                    <span className="fy-tm__words">{words}</span>
                    {!reaction && <span className="fy-tm__line fy-mono">{line(bar)}</span>}
                    {!reaction && bar.made && <span className="fy-tm__edge fy-tm__edge--tail" data-testid="timing-tail" onPointerDown={(event) => begin(event, bar.key, "tail")} />}
                  </div>
                );
              })}
              {timing.bars.filter((bar) => bar.kind === "block" && bar.pauseAfter !== null && !bar.locked.pauseAfter).map((bar) => (
                <span
                  key={`gap-${bar.key}`}
                  className="fy-tm__gap"
                  data-testid="timing-gap"
                  data-key={bar.key}
                  title="Pause after"
                  style={{ left: (bar.at + bar.seconds + Math.max(0, bar.pauseAfter ?? 0) / 2) * pps - 4 + (drag?.key === bar.key && drag.mode === "pause" ? drag.dx : 0), top: (laneIndex.get(bar.lane) ?? 0) * 64 + 24 }}
                  onPointerDown={(event) => begin(event, bar.key, "pause")}
                />
              ))}
              <div className="fy-tm__playhead" data-testid="timing-playhead" style={{ left: playhead * pps }} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Reset as the panel shows the block (codex on PR 1500): its own timing and the Pause after it,
 * which is kept on the next block's start — or the pause the field shows would stay.
 */
function resetOf(bar: TimedBar): BlockTimingInput {
  return { reset: true, ...(bar.pauseAfter !== null && !bar.locked.pauseAfter ? { pauseAfter: null } : {}) };
}

/** A seconds field that writes on Enter or when it is left, never on each key. */
export function SecondsField({ label, value, min, max, disabled, onCommit, testId, revision }: { label: string; value: number; min: number; max: number; disabled?: boolean; onCommit: (seconds: number) => void; testId?: string; revision?: number }) {
  const [text, setText] = useState(value.toFixed(2));
  const field = useRef<HTMLInputElement | null>(null);
  // Typed into and not yet committed: what an answer to another write must not overwrite.
  const editing = useRef(false);
  // Put back to the record's value whenever an answer lands (codex on PR 1500): a refused write
  // leaves the value as it was, and the field must not keep showing what was refused.
  // An answer to another write leaves a field being typed in alone (codex on PR 1506): only one not
  // in hand is put back, which a committed field is once it has been left.
  useEffect(() => {
    if (editing.current && field.current !== null && typeof document !== "undefined" && document.activeElement === field.current) return;
    setText(value.toFixed(2));
  }, [value, revision]);
  // Read from the field itself at the commit: what is in it is what was meant, whatever the last
  // change event carried.
  const commit = (typed: string) => {
    editing.current = false;
    const parsed = Number(typed.replace("−", "-"));
    if (!Number.isFinite(parsed)) {
      setText(value.toFixed(2));
      return;
    }
    const next = round2(clamp(parsed, min, max));
    setText(next.toFixed(2));
    if (next !== round2(value)) onCommit(next);
  };
  return (
    <input
      ref={field}
      className="fy-tm__field fy-mono"
      type="number"
      step={0.01}
      min={min}
      max={max}
      aria-label={label}
      data-testid={testId}
      value={text}
      disabled={disabled}
      onChange={(event) => {
        editing.current = true;
        setText(event.target.value);
      }}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(event.currentTarget.value);
      }}
    />
  );
}

/**
 * The Timing view's side (187a): the bar selected, its Starts, Pause after, Trim, Plays after ·
 * under, who set it, Reset and Play from here. Under Performed a grouped request's inside is the
 * reader's (R-85), and says so where a field would be.
 */
export function TimingSide({ bar, row, timing, rows, onTiming, onPlayFrom, refused, locked, revision }: {
  bar: TimedBar | null;
  row: TimingRowLike | null;
  timing: ChapterTiming;
  rows: readonly TimingRowLike[];
  onTiming: (key: string, input: BlockTimingInput) => void;
  onPlayFrom: (seconds: number) => void;
  refused: string | null;
  locked: boolean;
  /** Moves with every answer to a timing write, so a refused value is put back. */
  revision?: number;
}) {
  if (bar === null || row === null) return null;
  const before = timing.bars.filter((candidate) => candidate.kind === "block" && candidate.under === null && candidate.index < bar.index).sort((a, b) => b.index - a.index)[0];
  const beforeMark = before === undefined ? null : (rows.find((candidate) => candidate.block.key === before.key)?.mark ?? null);
  const hostMark = bar.under === null ? null : (rows.find((candidate) => candidate.block.key === bar.under!.host)?.mark ?? bar.under.host);
  const words = row.block.text.length > 48 ? `${row.block.text.slice(0, 46)}…` : row.block.text;
  const key = bar.key;
  return (
    <section className="fy-bible__panel fy-tm__side" data-testid="timing-side" aria-label="Timing">
      <h3 className="fy-ab__card-title">{row.mark} · {key}</h3>
      <p className="fy-mono fy-tm__data">{words} · {bar.made ? formatTimingSeconds(bar.seconds) : "not read"}</p>
      <div className="fy-tm__row">
        <span className="fy-ab__label">Starts</span>
        {bar.under !== null ? (
          <span className="fy-mono">under {hostMark} · {formatTimingSeconds(bar.under.offset)}</span>
        ) : bar.locked.start ? (
          <span className="fy-mono" data-testid="timing-start-locked">{formatTimingSeconds(bar.start)} · the reader's</span>
        ) : (
          <>
            <SecondsField revision={revision} label="Starts" testId="timing-start" value={bar.start} min={TIMING_START_MIN_SEC} max={TIMING_START_MAX_SEC} disabled={locked || bar.index === 0} onCommit={(start) => onTiming(key, { start })} />
            {bar.start < 0 && beforeMark !== null && <span className="fy-mono">cuts in on {beforeMark}</span>}
          </>
        )}
      </div>
      <div className="fy-tm__row">
        <span className="fy-ab__label">Pause after</span>
        {bar.pauseAfter === null ? (
          <span className="fy-mono">—</span>
        ) : bar.locked.pauseAfter ? (
          <span className="fy-mono" data-testid="timing-pause-locked">{formatTimingSeconds(bar.pauseAfter)} · the reader's</span>
        ) : (
          <SecondsField revision={revision} label="Pause after" testId="timing-pause" value={bar.pauseAfter} min={TIMING_START_MIN_SEC} max={TIMING_START_MAX_SEC} disabled={locked} onCommit={(pauseAfter) => onTiming(key, { pauseAfter })} />
        )}
      </div>
      <TrimRow bar={bar} locked={locked} onTiming={onTiming} revision={revision} />
      <div className="fy-tm__row">
        <span className="fy-ab__label">Plays</span>
        <span className="fy-seg" role="radiogroup" aria-label="Plays">
          <button type="button" role="radio" aria-checked={bar.under === null} className={`fy-seg__item${bar.under === null ? " fy-seg__item--active" : ""}`} disabled={locked} onClick={() => bar.under !== null && onTiming(key, { under: null })}>After</button>
          <button
            type="button"
            role="radio"
            aria-checked={bar.under !== null}
            className={`fy-seg__item${bar.under !== null ? " fy-seg__item--active" : ""}`}
            disabled={locked || (bar.under === null && before === undefined)}
            onClick={() => bar.under === null && before !== undefined && onTiming(key, { under: { host: before.key, offset: 0 } })}
          >
            Under
          </button>
        </span>
      </div>
      <div className="fy-tm__row">
        <span className="fy-ab__label">Set by</span>
        <span className="fy-mono">{bar.by === "arke" ? "Arke" : bar.by === "author" || bar.trim !== null ? "you" : "—"}</span>
      </div>
      {(bar.trim !== null || bar.trimDropped) && <p className="fy-mono fy-tm__data">{bar.trimDropped ? "new take · trim reset" : "take kept · trim resets on a new take"}</p>}
      {refused !== null && <p className="fy-mono fy-ch__who-where--warn" data-testid="timing-refused">{refused}</p>}
      <div className="fy-tm__actions">
        <Button variant="ghost" disabled={locked} onClick={() => onTiming(key, resetOf(bar))} data-testid="timing-reset">Reset</Button>
        <Button variant="secondary" onClick={() => onPlayFrom(bar.at)} data-testid="timing-play-here">Play from here</Button>
      </div>
    </section>
  );
}

/** Trim as two seconds, head and tail; a block with no take has nothing to trim. */
function TrimRow({ bar, locked, onTiming, revision }: { bar: TimedBar; locked: boolean; onTiming: (key: string, input: BlockTimingInput) => void; revision?: number }) {
  const trim = bar.trim ?? { head: 0, tail: 0 };
  return (
    <div className="fy-tm__row">
      <span className="fy-ab__label">Trim</span>
      {bar.made ? (
        <>
          <SecondsField revision={revision} label="Trim head" testId="timing-trim-head" value={trim.head} min={0} max={TIMING_TRIM_MAX_SEC} disabled={locked} onCommit={(head) => onTiming(bar.key, { trim: { head, tail: trim.tail } })} />
          <SecondsField revision={revision} label="Trim tail" testId="timing-trim-tail" value={trim.tail} min={0} max={TIMING_TRIM_MAX_SEC} disabled={locked} onCommit={(tail) => onTiming(bar.key, { trim: { head: trim.head, tail } })} />
          <span className="fy-mono fy-tm__unit">head · tail</span>
        </>
      ) : (
        <span className="fy-mono">not read</span>
      )}
    </div>
  );
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
            Open in Timing
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * Propose timing (design turn 187b, R-86): asked of the coordinator, held here until accepted
 * whole or discarded, and drawn on the view dashed — the record as it would stand, by the same
 * rule the coordinator writes it with. A new chapter or the transport dropping lets it go.
 */
export function useTimingProposal(input: { worldId: string; prodId: string; chapterId: string; chapterFile: string; connection: string }) {
  const { worldId, prodId, chapterId, chapterFile, connection } = input;
  const asked = useRef<string | null>(null);
  const [proposal, setProposal] = useState<TimingProposal | null>(null);
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const accepting = useRef<string | null>(null);
  useEffect(() => subscribeAudiobookTimingProposal((answer) => {
    if (answer.requestId !== asked.current) return;
    asked.current = null;
    setPending(false);
    if (answer.proposal === null) setRefused(answer.refused ?? "could not propose");
    else setProposal(answer.proposal);
  }), []);
  const records = useAudiobookRecords();
  const answer = records[`${worldId}/${prodId}/${chapterId}`];
  // The acceptance's own answer: the record, which ends the proposal, or a refusal said on the card.
  useEffect(() => {
    if (accepting.current === null || answer === undefined) return;
    accepting.current = null;
    if (answer.refused !== undefined) setRefused(answer.refused);
    else setProposal(null);
  }, [answer]);
  const reset = useCallback(() => {
    asked.current = null;
    accepting.current = null;
    setProposal(null);
    setPending(false);
    setRefused(null);
  }, []);
  useEffect(() => reset(), [reset, chapterId]);
  useEffect(() => {
    if (connection !== "open") reset();
  }, [connection, reset]);
  const propose = useCallback(() => {
    setRefused(null);
    const requestId = proposeAudiobookTiming(worldId, prodId, chapterFile);
    if (requestId === null) return;
    asked.current = requestId;
    setPending(true);
  }, [worldId, prodId, chapterFile]);
  const accept = useCallback(() => {
    if (proposal === null) return;
    accepting.current = acceptAudiobookTiming(worldId, prodId, chapterFile, proposal);
  }, [worldId, prodId, chapterFile, proposal]);
  return { proposal, pending, refused, propose, accept, discard: reset };
}

/** The record with the proposal in it, and which bars and beds that adds or moves: what the view draws dashed. */
export function proposedView(record: ChapterAudiobook | null, proposal: TimingProposal | null, blocks: readonly { key: string; text: string }[]): { record: ChapterAudiobook | null; proposed: Set<string> } {
  if (record === null || proposal === null) return { record, proposed: new Set() };
  const next = applyTimingProposal(record, proposal, blocks, record.updatedAt);
  const added = (after: Record<string, unknown> | undefined, before: Record<string, unknown> | undefined) => Object.keys(after ?? {}).filter((key) => before?.[key] === undefined);
  const moved = Object.keys(proposal.starts).filter((key) => next.timing?.[key]?.by === "arke" && next.timing[key] !== record.timing?.[key]);
  return { record: next, proposed: new Set([...moved, ...added(next.reactions, record.reactions), ...added(next.beds, record.beds)]) };
}

/** The proposal's card (187b): what it changes, as data, what it read, and Accept or Discard, whole. */
export function TimingProposalCard({ proposal, onAccept, onDiscard, refused, locked }: { proposal: TimingProposal; onAccept: () => void; onDiscard: () => void; refused: string | null; locked: boolean }) {
  const counts = proposalCounts(proposal);
  return (
    <section className="fy-bible__panel fy-tm__proposal" data-testid="timing-proposal" aria-label="Proposed timing">
      <p className="fy-mono fy-tm__data" data-testid="timing-proposal-counts">
        {[
          `proposed · ${counts.changes} change${counts.changes === 1 ? "" : "s"}`,
          `${counts.overlaps} overlap${counts.overlaps === 1 ? "" : "s"}`,
          `${counts.reactions} reaction${counts.reactions === 1 ? "" : "s"}`,
          `${counts.pauses} pause${counts.pauses === 1 ? "" : "s"}`,
          ...(counts.beds > 0 ? [`${counts.beds} bed${counts.beds === 1 ? "" : "s"}`] : []),
          `0 of yours changed${counts.kept > 0 ? ` · ${counts.kept} kept` : ""}`,
        ].join(" · ")}
      </p>
      <div className="fy-ab__reads">
        {proposal.heard > 0 && (
          <div className="fy-ab__read">
            <b>Heard</b>
            <span>word times · this machine</span>
          </div>
        )}
        <div className="fy-ab__read">
          <b>Reads</b>
          <span>the words, the direction, the cast</span>
        </div>
      </div>
      {refused !== null && <p className="fy-mono fy-ch__who-where--warn">{refused}</p>}
      <div className="fy-tm__actions">
        <Button variant="ghost" onClick={onDiscard} data-testid="timing-proposal-discard">Discard</Button>
        <Button variant="primary" disabled={locked || counts.changes === 0} onClick={onAccept} data-testid="timing-proposal-accept">Accept</Button>
      </div>
    </section>
  );
}

/** One block's timing written: answered as the record, or refused on the panel. */
export function writeTiming(worldId: string, prodId: string, chapterFile: string): (key: string, input: BlockTimingInput) => void {
  return (key, input) => {
    setAudiobookTiming(worldId, prodId, chapterFile, key, input);
  };
}

export { hasTiming };
