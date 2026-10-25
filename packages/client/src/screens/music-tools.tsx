import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  estimateMicroUsd,
  MUSIC_DURATION_SEC,
  musicClock,
  musicLoudnessLabel,
  musicStanzas,
  musicTakesInstrumental,
  musicTakesLength,
  musicTrackArtifact,
  musicTrackLengthMs,
  type MusicJoin,
  type MusicRecord,
  type MusicTakeView,
  type MusicWaveform,
  type ProductionBundle,
  type WorldBundle,
} from "@arke-studio/contracts";
import { usableModels } from "../components/dispatch-bar.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { Check, PlaySolid, Plus, X } from "../components/icons.js";
import { ClipPlayButton } from "../components/player.js";
import { Button, Callout, cx, Input, Select } from "../components/ui.js";
import { Wave } from "../components/wave.js";
import { usePlayback } from "../lib/audio.js";
import { usd } from "../lib/format.js";
import { mediaUrl } from "../lib/media.js";
import {
  chooseMusicTake,
  editMusicTrack,
  makeMusicTakes,
  readMusicTakes,
  readMusicWaveform,
  setMusicSequence,
  subscribeMusicTakes,
  subscribeMusicWaveform,
  subscribeQueueResults,
  useStore,
} from "../lib/store.js";

/**
 * A track's composer and takes (238i), its editor (238j) and the album's sequence (238k),
 * SPEC-060 R-9 – R-13. The composer is the Bench's music engine inside the track: its takes are
 * Bench takes in the album's own session, priced by the Bench's quote. The editor and the sequence
 * write the record; the takes are never changed, and the export renders what they say.
 */

type Track = MusicRecord["tracks"][number];

// ---- Waveforms: read once a file, shared by every strip that draws it --------------------------

const waves = new Map<string, MusicWaveform>();
const pending = new Map<string, string>();
const wavesChanged = new Set<() => void>();
let listening = false;
function listenForWaves() {
  if (listening) return;
  listening = true;
  subscribeMusicWaveform((answer) => {
    const key = pending.get(answer.requestId);
    if (key === undefined) return;
    pending.delete(answer.requestId);
    // A file that could not be read keeps the drawn wave, and is asked for again next time it
    // is opened rather than never.
    if (answer.waveform !== null) waves.set(key, answer.waveform);
    for (const notify of wavesChanged) notify();
  });
}

export function useMusicWaveform(worldId: string, file: string | null): MusicWaveform | null {
  const connection = useStore().connection;
  const key = file === null ? null : `${worldId}/${file}`;
  const [, setTick] = useState(0);
  // Each strip asks once for its own file; the coordinator decodes a file once however many ask.
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    listenForWaves();
    const notify = () => setTick((tick) => tick + 1);
    wavesChanged.add(notify);
    return () => { wavesChanged.delete(notify); };
  }, []);
  useEffect(() => {
    if (connection !== "open") { askedFor.current = null; return; }
    if (key === null || file === null || waves.has(key) || askedFor.current === key) return;
    const requestId = readMusicWaveform(worldId, file);
    if (requestId === null) return;
    pending.set(requestId, key);
    askedFor.current = key;
  }, [key, file, worldId, connection]);
  return key === null ? null : waves.get(key) ?? null;
}

/** The loudest of each run of peaks, as `count` bars. */
function bucketed(peaks: readonly number[], count: number): number[] {
  if (peaks.length === 0) return [];
  return Array.from({ length: count }, (_, bucket) => {
    const from = Math.floor((bucket * peaks.length) / count);
    const to = Math.max(from + 1, Math.floor(((bucket + 1) * peaks.length) / count));
    let peak = 0;
    for (let index = from; index < to; index++) peak = Math.max(peak, peaks[index] ?? 0);
    return peak;
  });
}

/** A file's waveform as bars (238i – 238k): its own peaks once read, the drawn wave until then. */
export function Peaks({ worldId, file, seed, bars = 56, height = 30 }: { worldId: string; file: string | null; seed: string; bars?: number; height?: number }) {
  const wave = useMusicWaveform(worldId, file);
  if (wave === null || wave.peaks.length === 0) return <Wave seed={seed} width={bars * 5} height={height} stretch />;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${bars * 5} ${height}`} preserveAspectRatio="none" aria-hidden data-testid="music-peaks">
      <g fill="currentColor">
        {bucketed(wave.peaks, bars).map((peak, index) => {
          const bar = Math.max(2, peak * (height - 2));
          return <rect key={index} x={index * 5} y={(height - bar) / 2} width={3} height={bar} rx={1} />;
        })}
      </g>
    </svg>
  );
}

// ---- Times as the editor and the sequence type them ----------------------------------------------

/** `0:02`, `3:58`, or `0:02.5` where the tenth matters. */
export function clockOf(ms: number): string {
  const tenths = Math.round(ms / 100);
  const whole = Math.floor(tenths / 10), tenth = tenths % 10;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}${tenth === 0 ? "" : `.${tenth}`}`;
}

/** `3:58`, `2.5` or `2 s` back to ms; null when it reads as neither. */
export function msFromClock(text: string): number | null {
  const value = text.trim().replace(/\s*s$/, "");
  const clock = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(value);
  if (clock !== null) return Math.round((Number(clock[1]) * 60 + Number(clock[2])) * 1000);
  return /^\d+(?:\.\d+)?$/.test(value) ? Math.round(Number(value) * 1000) : null;
}

/** A time typed into a field, kept as typed until it is left; a time it cannot read goes back. */
function TimeField({ label, ms, onChange, seconds = false }: { label: string; ms: number; onChange: (ms: number) => void; seconds?: boolean }) {
  const shown = seconds ? `${Math.round(ms / 100) / 10} s` : clockOf(ms);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const next = msFromClock(text);
    if (next === null) setText(shown);
    else onChange(next);
  };
  return <Input aria-label={label} className="fy-music__time" value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

// ---- The composer and takes (238i) ---------------------------------------------------------------

const MAKING = new Set(["allocating", "queued", "submitting", "running", "needs-reconciliation"]);

/**
 * A track's composer (238i, R-9): its lyrics, a style sent as the brief, a length only where the
 * route keeps one, Vocal or Instrumental, Voice and Reference only where the route takes them,
 * and the route with its quote. Below, the track's takes, each with its waveform, play and
 * Choose; the chosen one is the track.
 */
export function TrackComposer({ world, production, track, lyrics, lyricsField, onLyricsUsed }: {
  world: WorldBundle;
  production: ProductionBundle;
  track: Track;
  lyrics: string;
  lyricsField: ReactNode;
  /** Words typed here are the track's before they are sung, so a take and its track agree. */
  onLyricsUsed: () => void;
}) {
  const worldId = world.meta.worldId;
  const productionId = production.meta.id;
  const { state, connection } = useStore();
  const routes = usableModels(state, "music");
  const artifact = musicTrackArtifact(track, world.artifacts);
  const generation = artifact?.generation;
  const made = generation !== undefined && "params" in generation && generation.source === "bench" && generation.params.kind === "music" ? generation : null;
  const [route, setRoute] = useState(() => {
    const same = made === null ? undefined : routes.find((model) => model.provider === made.provider && model.id === made.model);
    const first = same ?? routes[0];
    return first === undefined ? "" : `${first.provider}/${first.id}`;
  });
  const model = routes.find((candidate) => `${candidate.provider}/${candidate.id}` === route) ?? routes[0] ?? null;
  const [style, setStyle] = useState(made?.brief ?? "");
  const length = musicTrackLengthMs({ source: track.source }, world.artifacts);
  const [lengthMs, setLengthMs] = useState(() => Math.min(300_000, Math.max(3_000, Math.round((length ?? 180_000) / 1000) * 1000)));
  const [instrumental, setInstrumental] = useState(made !== null && made.params.kind === "music" && made.params.lyrics.trim() === "");
  const [count, setCount] = useState(3);
  const [making, setMaking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [takes, setTakes] = useState<MusicTakeView[]>([]);
  const takesLength = model !== null && musicTakesLength(model);
  const takesInstrumental = model !== null && musicTakesInstrumental(model);
  const singing = !(instrumental && takesInstrumental);

  // Every answer is the album's whole list, whoever asked: a take tagged after its press, or
  // landing while the composer is open, arrives after the press has had its own answer.
  useEffect(() => subscribeMusicTakes((answer) => {
    if (answer.worldId === worldId && answer.productionId === productionId) setTakes(answer.takes);
  }), [worldId, productionId]);
  useEffect(() => {
    if (connection === "open") readMusicTakes(worldId, productionId);
  }, [connection, worldId, productionId]);
  useEffect(() => subscribeQueueResults((result) => {
    if (result.requestId !== making) return;
    setMaking(null);
    if (result.failures.length > 0) setProblem(result.failures.map((failure) => failure.reason).join(" · "));
  }), [making]);
  useEffect(() => setChoosing(null), [track.source]);

  // A route's quote, as the Bench prices a song: at the length asked where the route keeps one,
  // else at the length the Bench prices every song at, which the route treats as a ceiling.
  const each = model === null ? null : estimateMicroUsd(model, { durationSec: takesLength ? lengthMs / 1000 : MUSIC_DURATION_SEC });
  const order = new Map(track.takes.map((take, index) => [take.takeId, index] as const));
  const mine = takes.filter((take) => take.trackId === track.id).sort((left, right) => (order.get(left.takeId) ?? 1e9) - (order.get(right.takeId) ?? 1e9));
  const make = () => {
    if (model === null) return;
    setProblem(null);
    if (singing) onLyricsUsed();
    const requestId = makeMusicTakes(worldId, productionId, track.id, {
      provider: model.provider,
      model: model.id,
      params: { kind: "music", count, lyrics: singing ? lyrics : "", ...(takesLength ? { lengthSec: Math.round(lengthMs / 1000) } : {}), ...(singing ? {} : { instrumental: true as const }) },
      brief: style.trim(),
    });
    if (requestId === null) setProblem("Not connected");
    else setMaking(requestId);
  };
  const ready = model !== null && style.trim() !== "" && (!singing || lyrics.trim() !== "") && making === null && connection === "open";

  return (
    <>
      <div className="fy-music-panel__kv" data-testid="music-composer">
        <span>Lyrics</span>
        {lyricsField}
        <span>Style</span>
        <Input aria-label="Style" value={style} maxLength={4_000} placeholder={track.title} onChange={(event) => setStyle(event.target.value)} />
        <span>{takesLength ? "Length" : "Sung"}</span>
        <span className="fy-music-panel__row">
          {takesLength && <TimeField label="Length" ms={lengthMs} onChange={(ms) => setLengthMs(Math.min(300_000, Math.max(3_000, Math.round(ms / 1000) * 1000)))} />}
          <span className="fy-music__seg" role="radiogroup" aria-label="Vocal or instrumental">
            <button type="button" role="radio" aria-checked={singing} className={cx(singing && "on")} onClick={() => setInstrumental(false)}>Vocal</button>
            <button type="button" role="radio" aria-checked={!singing} className={cx(!singing && "on")} disabled={!takesInstrumental} onClick={() => setInstrumental(true)}>Instrumental</button>
          </span>
        </span>
        <span>Voice</span>
        <Select label="Voice" disabled value=""><option value="">None</option></Select>
        <span>Reference</span>
        <Select label="Reference" disabled value=""><option value="">None</option></Select>
        <span>Route</span>
        <span className="fy-music-panel__row">
          <Select label="Route" wrapClassName="grow" value={model === null ? "" : `${model.provider}/${model.id}`} disabled={routes.length === 0} onChange={(event) => setRoute(event.target.value)}>
            {routes.length === 0 && <option value="">No music route</option>}
            {routes.map((candidate) => <option key={`${candidate.provider}/${candidate.id}`} value={`${candidate.provider}/${candidate.id}`}>{candidate.displayName}</option>)}
          </Select>
          <Select label="How many" value={String(count)} onChange={(event) => setCount(Number(event.target.value))}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          <Button variant="primary" disabled={!ready} onClick={make} data-testid="music-make">
            {making !== null ? "Making…" : `Make ${count}${each === null ? "" : ` · ${usd(each * count)}`}`}
          </Button>
        </span>
      </div>
      {problem !== null && <Callout tone="danger" title="Not made">{problem}</Callout>}
      <div className="fy-music-takes__head"><b>Takes</b><span className="fy-music__m">{mine.length}</span></div>
      <div className="fy-music-takes">
        {mine.map((take, index) => {
          const chosen = take.keptArtifactId !== undefined && artifact?.id === take.keptArtifactId;
          const ready = take.file !== undefined && !MAKING.has(take.status);
          return (
            <div key={take.takeId} className={cx("fy-music-take", chosen && "on")} data-testid="music-track-take">
              <div className="hd">
                Take {index + 1}
                <span className="fy-music__m">{take.durationMs !== undefined ? musicClock(take.durationMs) : ""}</span>
                <span className="grow" />
                {chosen && <span className="fy-music__tag"><Check size={12} />Track</span>}
              </div>
              {ready ? <Peaks worldId={worldId} file={take.file!} seed={take.takeId} bars={40} height={34} /> : (
                <div className={cx("fy-music-take__wait", !MAKING.has(take.status) && "bad")}>{MAKING.has(take.status) ? "Making…" : (take.error ?? "Not made")}</div>
              )}
              <div className="ft">
                <ClipPlayButton clip={ready ? { id: `music-take:${take.takeId}`, url: mediaUrl(world.meta.slug, take.file!), title: `${track.title} · Take ${index + 1}`, sub: production.meta.title } : null} small />
                <span className="grow" />
                {!chosen && ready && (
                  <Button size="sm" disabled={choosing !== null} onClick={() => { if (chooseMusicTake(worldId, productionId, track.id, take.sessionId, take.takeId)) setChoosing(take.takeId); }}>
                    {choosing === take.takeId ? "Choosing…" : "Choose"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---- The track editor (238j) ---------------------------------------------------------------------

type Section = { key: number; label: string; atMs: number };
type Handle = "start" | "end" | "in" | "out" | { section: number; moved: boolean; fromX: number };

/** A tick every so often, so the ruler holds about eight. */
function tickStep(totalMs: number): number {
  for (const step of [5_000, 10_000, 15_000, 30_000, 60_000, 120_000]) if (totalMs / step <= 9) return step;
  return 300_000;
}

/**
 * One light editor a track (238j, R-11): the take's waveform with trim and fade handles, the cut
 * hatched, the album's loudness, and section markers that can be added, moved and renamed, each
 * of the lyrics' stanzas under its section. Save writes the edit with the track; the take is
 * never touched, and the export renders the edit.
 */
export function TrackEditor({ world, production, record, track, number, onClose }: { world: WorldBundle; production: ProductionBundle; record: MusicRecord; track: Track; number: number; onClose: () => void }) {
  const worldId = world.meta.worldId;
  const artifact = musicTrackArtifact(track, world.artifacts);
  const file = artifact === undefined ? null : `artifacts/${artifact.file}`;
  const wave = useMusicWaveform(worldId, file);
  const sourceMs = artifact?.mediaInfo?.durationSec !== undefined ? Math.round(artifact.mediaInfo.durationSec * 1000) : wave?.durationMs ?? null;
  return (
    <EditorDialog open onClose={onClose} width={1240} labelledBy="music-edit" panelClassName="fy-music-dlg">
      {sourceMs === null || sourceMs <= 0 ? (
        <>
          <header className="fy-music-dlg__head">
            <h3 id="music-edit">Edit · {track.title}</h3>
            <span className="grow" />
            <button type="button" className="fy-music__ib" aria-label="Close" onClick={onClose}><X size={15} /></button>
          </header>
          <div className="fy-music-dlg__bd"><span className="fy-music__m">{artifact === undefined ? "Not on the shelf" : "Reading the take…"}</span></div>
        </>
      ) : (
        <EditorBody world={world} production={production} record={record} track={track} number={number} sourceMs={sourceMs} wave={wave} onClose={onClose} />
      )}
    </EditorDialog>
  );
}

function EditorBody({ world, production, record, track, number, sourceMs, wave, onClose }: { world: WorldBundle; production: ProductionBundle; record: MusicRecord; track: Track; number: number; sourceMs: number; wave: MusicWaveform | null; onClose: () => void }) {
  const worldId = world.meta.worldId;
  const minimum = Math.min(1_000, sourceMs);
  const [start, setStart] = useState(() => Math.min(track.trim?.startMs ?? 0, sourceMs - minimum));
  const [end, setEnd] = useState(() => Math.min(track.trim?.endMs ?? sourceMs, sourceMs));
  const [fadeIn, setFadeIn] = useState(track.fadeInMs ?? 0);
  const [fadeOut, setFadeOut] = useState(track.fadeOutMs ?? 0);
  const nextKey = useRef(0);
  const [sections, setSections] = useState<Section[]>(() => (track.sections ?? []).map((section) => ({ key: nextKey.current++, label: section.label, atMs: Math.min(section.atMs, sourceMs) })));
  const [renaming, setRenaming] = useState<number | null>(null);
  const [dragging, setDragging] = useState<Handle | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const playback = usePlayback();
  const plays = end - start;
  const fadeRoom = (other: number) => Math.max(0, Math.min(60_000, plays - other));
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const setTrim = (nextStart: number, nextEnd: number) => {
    const s = clamp(Math.round(nextStart), 0, sourceMs - minimum);
    const e = clamp(Math.round(nextEnd), s + minimum, sourceMs);
    setStart(s);
    setEnd(e);
    // Fades never outgrow what plays; the later one gives way first.
    const room = e - s;
    setFadeIn((value) => Math.min(value, room));
    setFadeOut((value) => Math.min(value, Math.max(0, room - Math.min(fadeIn, room))));
  };

  const msAt = (clientX: number) => {
    const box = area.current?.getBoundingClientRect();
    if (box === undefined || box.width <= 0) return 0;
    return clamp(Math.round(((clientX - box.left) / box.width) * sourceMs), 0, sourceMs);
  };
  useEffect(() => {
    if (dragging === null) return;
    const move = (event: PointerEvent) => {
      const at = msAt(event.clientX);
      if (dragging === "start") setTrim(at, end);
      else if (dragging === "end") setTrim(start, at);
      else if (dragging === "in") setFadeIn(clamp(at - start, 0, fadeRoom(fadeOut)));
      else if (dragging === "out") setFadeOut(clamp(end - at, 0, fadeRoom(fadeIn)));
      else if (Math.abs(event.clientX - dragging.fromX) > 3 || dragging.moved) {
        if (!dragging.moved) setDragging({ ...dragging, moved: true });
        setSections((current) => current.map((section) => (section.key === dragging.section ? { ...section, atMs: at } : section)));
      }
    };
    const up = () => {
      if (typeof dragging === "object" && !dragging.moved) setRenaming(dragging.section);
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  });

  const ordered = [...sections].sort((left, right) => left.atMs - right.atMs);
  const stanzas = musicStanzas(track.lyrics);
  // Each stanza sits under the next section whose name it carries; a section with none says —.
  const words = new Map<number, string[]>();
  let next = 0;
  for (const section of ordered) {
    const stanza = stanzas[next];
    if (stanza !== undefined && (stanza.label === null || stanza.label.toLowerCase() === section.label.toLowerCase())) {
      words.set(section.key, stanza.lines);
      next++;
    }
  }
  const share = (ms: number) => `${(ms / sourceMs) * 100}%`;
  const step = tickStep(sourceMs);
  const ticks = Array.from({ length: Math.floor(sourceMs / step) + 1 }, (_, index) => index * step);
  const bars = wave === null ? [] : bucketed(wave.peaks, 170);
  const addSection = () => {
    // At the playhead when this take is sounding; else halfway through the longest section.
    const here = playback.clip?.id === `music-edit:${track.id}` ? Math.round(playback.currentTime * 1000) : null;
    let at = here;
    if (at === null) {
      const edges = [0, ...ordered.map((section) => section.atMs), sourceMs];
      let best = 0;
      for (let index = 0; index + 1 < edges.length; index++) if (edges[index + 1]! - edges[index]! > edges[best + 1]! - edges[best]!) best = index;
      at = Math.round((edges[best]! + edges[best + 1]!) / 2);
    }
    const key = nextKey.current++;
    setSections((current) => [...current, { key, label: stanzas[ordered.length]?.label ?? "Section", atMs: clamp(at, 0, sourceMs) }]);
    setRenaming(key);
  };
  const rename = (key: number, label: string) => {
    setRenaming(null);
    setSections((current) => (label.trim() === "" ? current.filter((section) => section.key !== key) : current.map((section) => (section.key === key ? { ...section, label: label.trim().slice(0, 100) } : section))));
  };
  const save = () => {
    const whole = start === 0 && end === sourceMs;
    const sent = editMusicTrack(worldId, production.meta.id, track.id, {
      trim: whole ? null : { startMs: start, endMs: end },
      fadeInMs: Math.round(fadeIn),
      fadeOutMs: Math.round(fadeOut),
      sections: ordered.map((section) => ({ label: section.label, atMs: section.atMs })),
    });
    if (sent) onClose();
  };
  const clip = musicTrackArtifact(track, world.artifacts);

  return (
    <>
      <header className="fy-music-dlg__head">
        <h3 id="music-edit">Edit · {track.title}</h3>
        <small>Track {number} · {musicClock(sourceMs)} · plays {musicClock(plays)}</small>
        <span className="grow" />
        {clip !== undefined && <ClipPlayButton clip={{ id: `music-edit:${track.id}`, url: mediaUrl(world.meta.slug, `artifacts/${clip.file}`), title: track.title, sub: production.meta.title }} small />}
        <button type="button" className="fy-music__ib" aria-label="Close" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="fy-music-dlg__bd">
        <div className="fy-music-ed" data-testid="music-editor">
          <div className="fy-music-ed__ruler" aria-hidden="true">{ticks.map((ms) => <span key={ms} style={{ left: share(ms) }}>{musicClock(ms)}</span>)}</div>
          <div className="fy-music-ed__secs">
            {ordered.map((section, index) => {
              const until = ordered[index + 1]?.atMs ?? sourceMs;
              return renaming === section.key ? (
                <input
                  key={section.key}
                  autoFocus
                  aria-label="Section"
                  className="fy-music-ed__name"
                  style={{ left: share(section.atMs), width: `max(120px, calc(${share(until - section.atMs)} - 3px))` }}
                  defaultValue={section.label}
                  onBlur={(event) => rename(section.key, event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = section.label; event.currentTarget.blur(); } }}
                />
              ) : (
                <button
                  key={section.key}
                  type="button"
                  className="fy-music-ed__sec"
                  data-testid="music-section"
                  style={{ left: share(section.atMs), width: `calc(${share(until - section.atMs)} - 3px)` }}
                  onPointerDown={(event) => { event.preventDefault(); setDragging({ section: section.key, moved: false, fromX: event.clientX }); }}
                  onKeyDown={(event) => { if (event.key === "Enter") setRenaming(section.key); }}
                >
                  {section.label}
                </button>
              );
            })}
          </div>
          <div className="fy-music-ed__wave" ref={area}>
            <svg width="100%" height="100%" viewBox="0 0 850 120" preserveAspectRatio="none" aria-hidden>
              <g fill="currentColor">
                {bars.length > 0 ? bars.map((peak, index) => {
                  const bar = Math.max(2, peak * 112);
                  return <rect key={index} x={index * 5} y={(120 - bar) / 2} width={3} height={bar} rx={1} />;
                }) : null}
              </g>
            </svg>
            {bars.length === 0 && <span className="fy-music-ed__seed"><Wave seed={track.id} width={850} height={110} stretch /></span>}
            {ordered.map((section) => <span key={section.key} className="fy-music-ed__div" style={{ left: share(section.atMs) }} />)}
            <span className="fy-music-ed__cut" style={{ left: 0, width: share(start) }} />
            <span className="fy-music-ed__cut" style={{ left: share(end), right: 0 }} />
            <span className="fy-music-ed__fade" style={{ left: share(start), width: share(fadeIn) }} />
            <span className="fy-music-ed__fade out" style={{ left: share(end - fadeOut), width: share(fadeOut) }} />
            <span role="slider" tabIndex={0} aria-label="Trim start" aria-valuemin={0} aria-valuemax={sourceMs} aria-valuenow={start} className="fy-music-ed__trim" style={{ left: share(start) }} onPointerDown={(event) => { event.preventDefault(); setDragging("start"); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") setTrim(start + (event.key === "ArrowLeft" ? -100 : 100), end); }} />
            <span role="slider" tabIndex={0} aria-label="Trim end" aria-valuemin={0} aria-valuemax={sourceMs} aria-valuenow={end} className="fy-music-ed__trim" style={{ left: share(end) }} onPointerDown={(event) => { event.preventDefault(); setDragging("end"); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") setTrim(start, end + (event.key === "ArrowLeft" ? -100 : 100)); }} />
            <span role="slider" tabIndex={0} aria-label="Fade in" aria-valuemin={0} aria-valuemax={fadeRoom(fadeOut)} aria-valuenow={fadeIn} className="fy-music-ed__fh" style={{ left: share(start + fadeIn) }} onPointerDown={(event) => { event.preventDefault(); setDragging("in"); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") setFadeIn(clamp(fadeIn + (event.key === "ArrowLeft" ? -100 : 100), 0, fadeRoom(fadeOut))); }} />
            <span role="slider" tabIndex={0} aria-label="Fade out" aria-valuemin={0} aria-valuemax={fadeRoom(fadeIn)} aria-valuenow={fadeOut} className="fy-music-ed__fh" style={{ left: share(end - fadeOut) }} onPointerDown={(event) => { event.preventDefault(); setDragging("out"); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") setFadeOut(clamp(fadeOut + (event.key === "ArrowLeft" ? 100 : -100), 0, fadeRoom(fadeIn))); }} />
          </div>
          <div className="fy-music-ed__lines">
            {ordered.map((section, index) => {
              const until = ordered[index + 1]?.atMs ?? sourceMs;
              const lines = words.get(section.key);
              return <div key={section.key} className={cx(lines === undefined && "none")} style={{ left: share(section.atMs), width: share(until - section.atMs) }}>{lines === undefined ? "—" : lines.map((line, at) => <span key={at}>{line}<br /></span>)}</div>;
            })}
          </div>
        </div>
        <div className="fy-music-ed__ctrls">
          <label className="fy-music-ed__fl"><span>Trim</span><span className="fy-music-panel__row"><TimeField label="Trim start" ms={start} onChange={(ms) => setTrim(ms, end)} />–<TimeField label="Trim end" ms={end} onChange={(ms) => setTrim(start, ms)} /></span></label>
          <label className="fy-music-ed__fl"><span>Fade in</span><TimeField label="Fade in" ms={fadeIn} onChange={(ms) => setFadeIn(clamp(ms, 0, fadeRoom(fadeOut)))} /></label>
          <label className="fy-music-ed__fl"><span>Fade out</span><TimeField label="Fade out" ms={fadeOut} onChange={(ms) => setFadeOut(clamp(ms, 0, fadeRoom(fadeIn)))} /></label>
          <span className="fy-music-ed__fl"><span>Loudness</span><span className="fy-music-ed__ro" data-testid="music-edit-loudness">{musicLoudnessLabel(record.loudness)} · album</span></span>
          <Button onClick={addSection}><Plus size={13} />Section</Button>
          <Button disabled>Extend</Button>
          <Button disabled>Remake section</Button>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} data-testid="music-edit-save">Save</Button>
        </div>
      </div>
    </>
  );
}

// ---- The album's sequence (238k) -----------------------------------------------------------------

const LOUDNESS = [-23, -18, -16, -14, -12, -9];
type Join = MusicJoin | null;

/**
 * Sequence (238k, R-13): the tracks in order with their waveforms, and between each pair a Gap
 * or a Crossfade with its length. A crossfade adds no time: it is the one track's fade out and
 * the next one's fade in, back to back. Every change is the whole sequence, sent at once.
 */
export function MusicSequence({ world, production, record, onPlayFrom }: { world: WorldBundle; production: ProductionBundle; record: MusicRecord; onPlayFrom: (trackId: string) => void }) {
  const worldId = world.meta.worldId;
  const joinsOf = (from: MusicRecord) => new Map(from.tracks.map((track) => [track.id, track.next ?? null] as const));
  const [joins, setJoins] = useState(() => joinsOf(record));
  useEffect(() => setJoins(joinsOf(record)), [record]);
  const send = (next: Map<string, Join>) => {
    setJoins(next);
    setMusicSequence(worldId, production.meta.id, record.loudness, record.tracks.slice(0, -1).map((track) => ({ trackId: track.id, next: next.get(track.id) ?? null })));
  };
  const setJoin = (trackId: string, join: Join) => send(new Map(joins).set(trackId, join));
  return (
    <div data-testid="music-sequence">
      {record.tracks.map((track, index) => {
        const artifact = musicTrackArtifact(track, world.artifacts);
        const length = musicTrackLengthMs(track, world.artifacts);
        const join = joins.get(track.id) ?? null;
        const crossfade = join !== null && "crossfadeMs" in join;
        const ms = join === null ? 0 : "gapMs" in join ? join.gapMs : join.crossfadeMs;
        return (
          <div key={track.id}>
            <div className="fy-music-seq" data-testid="music-seq-track">
              <span className="n">{index + 1}</span>
              <b>{track.title}</b>
              <span className="fy-music-seq__wave"><Peaks worldId={worldId} file={artifact === undefined ? null : `artifacts/${artifact.file}`} seed={track.id} bars={44} height={26} /></span>
              <span className="len">{length === null ? "—" : musicClock(length)}</span>
              <button type="button" className="fy-music__ib" aria-label={`Play through from ${track.title}`} onClick={() => onPlayFrom(track.id)}><PlaySolid size={13} /></button>
            </div>
            {index < record.tracks.length - 1 && (
              <div className="fy-music-join" data-testid="music-join">
                <span className="fy-music__seg" role="radiogroup" aria-label={`After ${track.title}`}>
                  <button type="button" role="radio" aria-checked={!crossfade} className={cx(!crossfade && "on")} onClick={() => setJoin(track.id, ms > 0 ? { gapMs: Math.min(ms, 30_000) } : null)}>Gap</button>
                  <button type="button" role="radio" aria-checked={crossfade} className={cx(crossfade && "on")} onClick={() => setJoin(track.id, { crossfadeMs: Math.min(ms > 0 ? ms : 3_000, 15_000) })}>Crossfade</button>
                </span>
                <TimeField seconds label={crossfade ? "Crossfade" : "Gap"} ms={ms} onChange={(value) => {
                  const bounded = Math.max(0, Math.min(crossfade ? 15_000 : 30_000, Math.round(value / 100) * 100));
                  setJoin(track.id, crossfade ? { crossfadeMs: bounded } : bounded > 0 ? { gapMs: bounded } : null);
                }} />
                <span className="fy-music-join__line" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The album's one loudness target (238k): sent with the sequence as it is. */
export function LoudnessSelect({ world, production, record }: { world: WorldBundle; production: ProductionBundle; record: MusicRecord }) {
  const values = useMemo(() => [...new Set([...LOUDNESS, record.loudness])].sort((left, right) => left - right), [record.loudness]);
  return (
    <Select label="Loudness" value={String(record.loudness)} onChange={(event) => setMusicSequence(world.meta.worldId, production.meta.id, Number(event.target.value), record.tracks.slice(0, -1).map((track) => ({ trackId: track.id, next: track.next ?? null })))}>
      {values.map((value) => <option key={value} value={value}>Loudness {musicLoudnessLabel(value)}</option>)}
    </Select>
  );
}
