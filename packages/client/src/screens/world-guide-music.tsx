import { useEffect, useRef, useState } from "react";
import {
  guideThemeHolders,
  MAX_TEASER_CLIP_MS,
  musicClock,
  musicKindOf,
  musicTrackArtifact,
  musicTrackLengthMs,
  productionShape,
  type ArtifactSidecar,
  type GuideRecord,
  type GuideRecordTheme,
  type MusicRecord,
  type ProductionBundle,
  type Sheet,
  type WorldBundle,
} from "@arke-studio/contracts";
import { BodyLayer } from "../components/body-layer.js";
import { Check, MusicMark, PauseSolid, PlaySolid, Plus } from "../components/icons.js";
import { Select, cx } from "../components/ui.js";
import { Wave } from "../components/wave.js";
import { mediaUrl } from "../lib/media.js";

/**
 * The world's music as the Guide offers it (design turn 238f, 238g, SPEC-059 R-35, R-36): every
 * track of every music production, in its album's order, as a character's or place's theme and as
 * a song teaser's track. A choice is kept by its production and track, so one that is gone is
 * still the author's, marked, and out of the package.
 */

export interface MusicTrackChoice {
  production: ProductionBundle;
  track: MusicRecord["tracks"][number];
  number: number;
  /** As the album plays it, inside its trim; null until its take is measured. */
  lengthMs: number | null;
  cover: ArtifactSidecar | undefined;
}

export interface WorldAlbum {
  production: ProductionBundle;
  cover: ArtifactSidecar | undefined;
  tracks: MusicTrackChoice[];
}

export function worldMusic(world: WorldBundle): WorldAlbum[] {
  return world.productions
    .filter((production) => productionShape(production.meta).isMusic)
    .map((production) => {
      const record = production.music ?? null;
      const cover = record?.cover === undefined ? undefined : world.artifacts.find((artifact) => artifact.id === record.cover);
      return { production, cover, tracks: (record?.tracks ?? []).map((track, index) => ({ production, track, number: index + 1, lengthMs: musicTrackLengthMs(track, world.artifacts), cover })) };
    });
}

export const musicChoiceOf = (albums: readonly WorldAlbum[], theme: GuideRecordTheme): MusicTrackChoice | undefined =>
  albums.find((album) => album.production.meta.id === theme.production)?.tracks.find((choice) => choice.track.id === theme.track);

/** What a song card says of its track (238g): `Track 1 · 4:12`, `Single · 3:42`, `Soundtrack · 1:48`. */
export function trackWhat(choice: MusicTrackChoice): string {
  const kind = musicKindOf(choice.production.meta);
  const head = kind === "single" ? "Single" : kind === "soundtrack" ? "Soundtrack" : `Track ${choice.number}`;
  return choice.lengthMs === null ? head : `${head} · ${musicClock(choice.lengthMs)}`;
}

/** The sheets a record keys, for whose theme a track is. */
export const guideSheets = (world: WorldBundle): Record<"characters" | "locations" | "factions", Sheet[]> => ({
  characters: world.sheets.filter((sheet) => sheet.type === "character"),
  locations: world.sheets.filter((sheet) => sheet.type === "location"),
  factions: world.sheets.filter((sheet) => sheet.type === "faction"),
});

/** Whose theme a track is, by name (238c, 238e). */
export const themeNames = (world: WorldBundle, record: GuideRecord, theme: GuideRecordTheme): string[] =>
  guideThemeHolders(record, guideSheets(world), theme).map(({ sheet }) => sheet.name);

/** Plays a window of a file: from where it starts, for as long as it lasts. */
export function useWindowPlayer(worldSlug: string) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const play = (key: string, clip: { file: string; start: number; seconds: number }) => {
    audio.current?.pause();
    if (playing === key) {
      setPlaying(null);
      return;
    }
    const element = new Audio(mediaUrl(worldSlug, clip.file));
    audio.current = element;
    const end = clip.start + clip.seconds;
    element.addEventListener("loadedmetadata", () => {
      element.currentTime = clip.start;
      void element.play().catch(() => setPlaying(null));
    }, { once: true });
    element.addEventListener("timeupdate", () => {
      if (element.currentTime < end) return;
      element.pause();
      setPlaying((now) => (now === key ? null : now));
    });
    element.addEventListener("ended", () => setPlaying((now) => (now === key ? null : now)));
    setPlaying(key);
  };
  return { playing, play };
}

/**
 * A row's Theme (238f): the track's name, `+ Theme` where it has none, `Track removed` where its
 * track is gone. Opens the menu of the world's music, grouped by production.
 */
export function ThemeCell({ world, record, name, holder, theme, onChange }: { world: WorldBundle; record: GuideRecord; name: string; holder: string; theme: GuideRecordTheme | undefined; onChange: (theme: GuideRecordTheme | undefined) => void }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const albums = worldMusic(world);
  const found = theme === undefined ? undefined : musicChoiceOf(albums, theme);
  if (theme === undefined && albums.every((album) => album.tracks.length === 0)) return <span className="fy-guide-col fy-guide-col--theme">—</span>;
  return (
    <span className="fy-guide-col fy-guide-col--theme">
      <button
        ref={button}
        type="button"
        className={cx("fy-guide-theme", theme === undefined && "none", theme !== undefined && found === undefined && "gone")}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={`Theme · ${name}`}
        onClick={() => setAt(button.current?.getBoundingClientRect() ?? null)}
        data-testid={`guide-theme-${holder}`}
      >
        {theme === undefined ? <><Plus size={11} />Theme</> : found === undefined ? "Track removed" : <><MusicMark size={11} /><span>{found.track.title}</span></>}
      </button>
      {at !== null && (
        <ThemeMenu
          world={world}
          record={record}
          albums={albums}
          name={name}
          theme={theme}
          at={at}
          onPick={(next) => {
            setAt(null);
            onChange(next);
          }}
          onClose={() => setAt(null)}
        />
      )}
    </span>
  );
}

/** The Theme line of an entry's panel, where a phone sets it (234d has no columns). */
export function ThemeSelect({ world, theme, onChange }: { world: WorldBundle; theme: GuideRecordTheme | undefined; onChange: (theme: GuideRecordTheme | undefined) => void }) {
  const albums = worldMusic(world).filter((album) => album.tracks.length > 0);
  const value = theme === undefined ? "" : `${theme.production}/${theme.track}`;
  const found = theme === undefined ? undefined : musicChoiceOf(albums, theme);
  if (theme === undefined && albums.length === 0) return <span className="fy-guide-muted">No music in this world</span>;
  return (
    <Select
      label="Theme"
      value={value}
      wrapClassName="fy-guide-after"
      onChange={(event) => {
        const [production, track] = event.target.value.split("/");
        onChange(production && track ? { production, track } : undefined);
      }}
    >
      <option value="">None</option>
      {theme !== undefined && found === undefined && <option value={value}>Track removed</option>}
      {albums.map((album) => (
        <optgroup key={album.production.meta.id} label={album.production.meta.title}>
          {album.tracks.map((choice) => (
            <option key={choice.track.id} value={`${album.production.meta.id}/${choice.track.id}`}>
              {choice.lengthMs !== null ? `${choice.track.title} · ${musicClock(choice.lengthMs)}` : choice.track.title}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

const MENU_WIDTH = 300;
const MENU_HEIGHT = 360;

function ThemeMenu({ world, record, albums, name, theme, at, onPick, onClose }: { world: WorldBundle; record: GuideRecord; albums: readonly WorldAlbum[]; name: string; theme: GuideRecordTheme | undefined; at: DOMRect; onPick: (theme: GuideRecordTheme | undefined) => void; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [onClose]);
  // Under its pill, kept inside the window: drawn on the body, so no column clips it.
  const left = Math.max(8, Math.min(at.left, window.innerWidth - MENU_WIDTH - 8));
  const top = at.bottom + 4 + MENU_HEIGHT > window.innerHeight ? Math.max(8, at.top - 4 - MENU_HEIGHT) : at.bottom + 4;
  const isOn = (choice: MusicTrackChoice) => theme?.production === choice.production.meta.id && theme.track === choice.track.id;
  return (
    <BodyLayer>
      <div className="fy-guide-menu-dim" onClick={onClose} />
      <div className="fy-guide-menu" role="menu" aria-label={`Theme · ${name}`} style={{ left, top, width: MENU_WIDTH, maxHeight: MENU_HEIGHT }} data-testid="guide-theme-menu">
        <div className="fy-guide-menu__h">Theme · {name}</div>
        {albums.filter((album) => album.tracks.length > 0).map((album) => (
          <div key={album.production.meta.id} role="group" aria-label={album.production.meta.title}>
            <div className="fy-guide-menu__sec">
              {album.cover !== undefined ? <img src={mediaUrl(world.meta.slug, `artifacts/${album.cover.file}`)} alt="" /> : <span className="fy-guide-menu__mark"><MusicMark size={11} /></span>}
              <span>{album.production.meta.title}</span>
            </div>
            {album.tracks.map((choice) => {
              const on = isOn(choice);
              // Another entry's theme says whose, so a track is chosen knowingly twice.
              const others = themeNames(world, record, { production: choice.production.meta.id, track: choice.track.id }).filter((other) => other !== name);
              const meta = [choice.lengthMs !== null ? musicClock(choice.lengthMs) : null, ...others].filter(Boolean).join(" · ");
              return (
                <button key={choice.track.id} type="button" role="menuitemradio" aria-checked={on} className={cx("fy-guide-menu__it", on && "on")} onClick={() => onPick({ production: choice.production.meta.id, track: choice.track.id })}>
                  <span className="fy-guide-menu__ck">{on && <Check size={12} />}</span>
                  <span className="fy-guide-menu__t">{choice.track.title}</span>
                  <span className="fy-guide-menu__m">{meta}</span>
                </button>
              );
            })}
          </div>
        ))}
        <hr />
        <button type="button" role="menuitemradio" aria-checked={theme === undefined} className={cx("fy-guide-menu__it", theme === undefined && "on")} onClick={() => onPick(undefined)}>
          <span className="fy-guide-menu__ck">{theme === undefined && <Check size={12} />}</span>
          <span className="fy-guide-menu__t">None</span>
        </button>
      </div>
    </BodyLayer>
  );
}

/** `1:48`, `108`, `1:48.5`: a clock the author types, read as milliseconds; null when it is not one. */
export function readClock(text: string): number | null {
  const match = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (match === null) return null;
  const minutes = match[1] !== undefined ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  if (match[1] !== undefined && seconds >= 60) return null;
  return Math.round((minutes * 60 + seconds) * 1000);
}

/** A clock the author types: what they typed while they type it, the window's own once it is read. */
function ClockField({ label, ms, onCommit }: { label: string; ms: number; onCommit: (ms: number) => void }) {
  const [typing, setTyping] = useState<string | null>(null);
  const commit = (text: string) => {
    setTyping(null);
    const read = readClock(text);
    if (read !== null) onCommit(read);
  };
  return (
    <label className="fy-guide-excerpt__f">
      <span>{label}</span>
      <input value={typing ?? musicClock(ms)} aria-label={label} inputMode="numeric" onChange={(event) => setTyping(event.target.value)} onBlur={(event) => commit(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    </label>
  );
}

/** A window kept inside its track and the 30 seconds a song teaser may be (R-36). */
export function clampExcerpt(lengthMs: number | null, start: number, duration: number): { start: number; duration: number } {
  const span = lengthMs ?? Number.MAX_SAFE_INTEGER;
  const length = Math.max(1000, Math.min(duration, MAX_TEASER_CLIP_MS, span));
  return { start: Math.max(0, Math.min(start, span - length)), duration: Math.min(length, span) };
}

/**
 * A song teaser's Excerpt (238g): play, the track's waveform with the window on it, and its Start
 * and Length, at most 30 seconds. A click on the waveform centres the window there. It plays from
 * the track's own take, inside its trim, as the album does.
 */
export function SongExcerpt({ world, choice, start, duration, onChange }: { world: WorldBundle; choice: MusicTrackChoice; start: number; duration: number; onChange: (start: number, duration: number) => void }) {
  const player = useWindowPlayer(world.meta.slug);
  const artifact = musicTrackArtifact(choice.track, world.artifacts);
  const span = choice.lengthMs ?? Math.max(start + duration, MAX_TEASER_CLIP_MS);
  const set = (nextStart: number, nextDuration: number) => {
    const kept = clampExcerpt(choice.lengthMs, nextStart, nextDuration);
    onChange(kept.start, kept.duration);
  };
  const from = choice.track.trim?.startMs ?? 0;
  return (
    <div className="fy-guide-excerpt" data-testid="guide-song-excerpt">
      <b>Excerpt</b>
      <button
        type="button"
        className="fy-guide-play"
        aria-label={player.playing === "excerpt" ? "Stop" : "Play"}
        disabled={artifact === undefined}
        onClick={() => artifact !== undefined && player.play("excerpt", { file: `artifacts/${artifact.file}`, start: (from + start) / 1000, seconds: duration / 1000 })}
      >
        {player.playing === "excerpt" ? <PauseSolid size={12} /> : <PlaySolid size={12} />}
      </button>
      <span
        className="fy-guide-excerpt__track"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (box.width > 0) set(Math.round(((event.clientX - box.left) / box.width) * span - duration / 2), duration);
        }}
      >
        <Wave seed={choice.track.id} width={400} height={30} stretch />
        <span className="fy-guide-excerpt__win" style={{ left: `${(start / span) * 100}%`, width: `${(duration / span) * 100}%` }} />
      </span>
      <ClockField label="Start" ms={start} onCommit={(ms) => set(ms, duration)} />
      <ClockField label="Length" ms={duration} onCommit={(ms) => set(start, ms)} />
    </div>
  );
}
