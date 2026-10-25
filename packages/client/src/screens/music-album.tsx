import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  EMPTY_GUIDE_RECORD,
  keptMusic,
  MUSIC_AAC_KBPS,
  MUSIC_COVER_EDGE,
  MUSIC_IMPORT_EXTENSIONS,
  musicClock,
  musicKindOf,
  musicLoudnessLabel,
  musicSequenceLine,
  musicTakeLabel,
  musicTotalMs,
  musicTrackArtifact,
  musicTrackLengthMs,
  productionShape,
  ulid,
  type ArtifactSidecar,
  type MusicHeardRow,
  type MusicRecord,
  type ProductionBundle,
  type WorldBundle,
} from "@arke-studio/contracts";
import { EditorDialog } from "../components/editor-dialog.js";
import { Grip, ImageMark, More, MusicMark, PlaySolid, Plus, Search, Sparkle, Upload, X } from "../components/icons.js";
import { EmptyState, Screen } from "../components/layout.js";
import { PageSheet } from "../components/page-sheet.js";
import { ClipPlayButton } from "../components/player.js";
import { Button, Callout, cx } from "../components/ui.js";
import { Wave } from "../components/wave.js";
import { Folder, megabytes } from "../components/audiobook-video.js";
import { playClip, type Clip } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { useMediaQuery } from "../lib/media-query.js";
import { useProduction } from "../lib/selectors.js";
import {
  addMusicTrack,
  draftMusicLyrics,
  exportArkePlayer,
  importEditorMedia,
  openExportsFolder,
  readMusicHeardIn,
  removeMusicTrack,
  renderMusic,
  reorderMusicTracks,
  sendBenchNewSession,
  setMusicCover,
  subscribeArkePlayerExported,
  subscribeCommandFailures,
  subscribeMusicHeardIn,
  subscribeMusicLyricsDrafted,
  subscribeMusicRendered,
  subscribeQueueResults,
  updateMusicTrack,
  useStore,
  type ArkePlayerExported,
} from "../lib/store.js";
import { LoudnessSelect, MusicSequence, Peaks, TrackComposer, TrackEditor } from "./music-tools.js";
import { themeNames } from "./world-guide-music.js";

/**
 * A music production's page (design turn 238c – 238e and 238h, SPEC-060 R-5 – R-8, R-14 – R-17):
 * the square cover and what it is on the left, its tracks in order on the right. A track comes
 * from a kept take or an imported file (238d), opens beside the album (238e), and the album is
 * played whole by the export's own render (R-8) and exported as a package of its own (238h).
 * A track's Takes open its composer (238i), Edit its editor (238j), and Sequence the album's
 * joins and loudness (238k): those live in music-tools.
 */

const EMPTY: MusicRecord = { version: 1, loudness: -14, tracks: [] };
type Track = MusicRecord["tracks"][number];

const shelfOf = (world: WorldBundle, production: ProductionBundle) =>
  world.artifacts.filter((artifact) => artifact.retiredAt === undefined && (artifact.production === undefined || artifact.production === production.meta.id));

/** Where a track came from, as the From column says it (238c): its chosen take, or the file. */
function fromOf(track: Track, artifacts: readonly ArtifactSidecar[]): string {
  const artifact = musicTrackArtifact(track, artifacts);
  if (artifact === undefined) return "Not on the shelf";
  const take = musicTakeLabel(track, artifact);
  if (take !== null) return take;
  const kept = keptMusic([artifact])[0];
  if (kept !== undefined) return artifact.generation?.source === "sound" ? "Sound · audio drama" : "Bench take";
  return `File · ${artifact.file}`;
}

const heardLine = (rows: readonly MusicHeardRow[]) => (rows.length === 0 ? "—" : `${rows[0]!.productionTitle} · ${rows[0]!.label}${rows.length > 1 ? ` · +${rows.length - 1}` : ""}`);

export function MusicAlbumScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  if (!world || !production) return <Screen id="music-album"><EmptyState title="Opening production…" /></Screen>;
  // Keyed by both, so another album never inherits this one's open track, order or drafts.
  return <MusicAlbum key={`${world.meta.worldId}/${production.meta.id}`} world={world} production={production} />;
}

export function MusicAlbum({ world, production }: { world: WorldBundle; production: ProductionBundle }) {
  const worldId = world.meta.worldId;
  const productionId = production.meta.id;
  const record = production.music ?? EMPTY;
  const kind = musicKindOf(production.meta);
  const shape = productionShape(production.meta);
  const connection = useStore().connection;
  const phone = useMediaQuery("(max-width: 599px)");
  const artifacts = world.artifacts;
  const total = musicTotalMs(record, artifacts);
  const cover = record.cover === undefined ? undefined : artifacts.find((artifact) => artifact.id === record.cover);
  const scored = record.for === undefined ? null : world.productions.find((entry) => entry.meta.id === record.for) ?? null;
  const eyebrow = `${shape.displayLabel}${kind === "soundtrack" && scored !== null ? ` · ${scored.meta.title}` : ` · ${world.meta.name}`}`.toUpperCase();

  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [covering, setCovering] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [view, setView] = useState<"tracks" | "sequence">("tracks");
  // Drag reorders (238c): the order shown while a drop is on its way, then the record's own.
  const [order, setOrder] = useState<string[] | null>(null);
  const dragged = useRef<string | null>(null);
  const tracks = useMemo(() => {
    const byId = new Map(record.tracks.map((track) => [track.id, track] as const));
    const shown = order?.map((id) => byId.get(id)).filter((track): track is Track => track !== undefined);
    return shown !== undefined && shown.length === record.tracks.length ? shown : record.tracks;
  }, [record.tracks, order]);
  useEffect(() => setOrder(null), [record.tracks]);

  // Heard in (R-14): asked for again whenever the album's sources or the world's placements move.
  const [heard, setHeard] = useState<Record<string, MusicHeardRow[]>>({});
  const asked = useRef<string | null>(null);
  // Every placement Heard in reads, by what changes when it moves: a chapter's audiobook record,
  // an episode script, a cut, an edited timeline, a spine. Another window's edit arrives here.
  const heardKey = useMemo(() => JSON.stringify([
    record.tracks.map((track) => track.source),
    world.productions.filter((entry) => entry.meta.id !== productionId).map((entry) => [
      entry.meta.id,
      entry.chapters.map((chapter) => chapter.audiobook ?? null),
      entry.episodeScripts?.map((script) => script.hash) ?? null,
      entry.cut,
      entry.timeline?.status === "ready" ? entry.timeline.hash ?? entry.timeline.timeline.revision : entry.timeline?.status ?? null,
      entry.spine?.trackArtifactId ?? null,
    ]),
  ]), [record.tracks, world.productions, productionId]);
  useEffect(() => subscribeMusicHeardIn((answer) => {
    if (answer.requestId === asked.current) setHeard(answer.tracks);
  }), []);
  useEffect(() => {
    if (connection === "open") asked.current = readMusicHeardIn(worldId, productionId);
  }, [connection, worldId, productionId, heardKey]);

  // A write this page sent and the coordinator refused says why, here (R-3's Single, a moved album).
  useEffect(() => subscribeCommandFailures((event) => {
    if (event.command.startsWith("music-")) setProblem(event.reason);
  }), []);

  // Play all (R-8): the export's render, made once and cached, played whole; Play through
  // (238k) plays the same render from a track's start.
  const [rendering, setRendering] = useState<{ requestId: string; from: string | null } | null>(null);
  useEffect(() => subscribeMusicRendered((answer) => {
    if (rendering === null || answer.requestId !== rendering.requestId) return;
    setRendering(null);
    if (!answer.result.ok) { setProblem(answer.result.reason); return; }
    const { file, durationMs, starts } = answer.result;
    const at = starts.find((start) => start.trackId === rendering.from)?.atMs ?? 0;
    void playClip({
      id: `album:${productionId}:${file}:${at}`,
      url: mediaUrl(world.meta.slug, file),
      title: production.meta.title,
      sub: shape.displayLabel,
      ...(at > 0 ? { range: { inSec: at / 1000, outSec: durationMs / 1000 } } : {}),
    });
  }), [rendering, productionId, world.meta.slug, production.meta.title, shape.displayLabel]);
  const playFrom = (from: string | null) => {
    setProblem(null);
    const requestId = renderMusic(worldId, productionId);
    if (requestId !== null) setRendering({ requestId, from });
  };

  const clipOf = (track: Track): Clip | null => {
    const artifact = musicTrackArtifact(track, artifacts);
    return artifact === undefined ? null : { id: `track:${productionId}:${track.id}`, url: mediaUrl(world.meta.slug, `artifacts/${artifact.file}`), title: track.title, sub: production.meta.title };
  };
  const drop = (onto: string) => {
    const from = dragged.current;
    dragged.current = null;
    if (from === null || from === onto) return;
    const ids = tracks.map((track) => track.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(onto) + (tracks.findIndex((track) => track.id === from) < tracks.findIndex((track) => track.id === onto) ? 1 : 0), 0, from);
    setOrder(ids);
    reorderMusicTracks(worldId, productionId, ids);
  };
  const openTrack = tracks.find((track) => track.id === open) ?? null;

  return (
    <Screen id="music-album">
      <div className={cx("fy-music", openTrack !== null && "fy-music--open")}>
        <aside className="fy-music__side">
          <div className="fy-music__cover">
            {cover !== undefined ? <img src={mediaUrl(world.meta.slug, `artifacts/${cover.file}`)} alt="" /> : <MusicMark size={40} />}
          </div>
          <div className="fy-music__makecover">
            <Button onClick={() => setCovering(true)}><Sparkle size={13} />Make cover</Button>
            <span className="fy-music__m">1:1 · {MUSIC_COVER_EDGE} × {MUSIC_COVER_EDGE}</span>
          </div>
          <div>
            <div className="fy-music__eyebrow">{eyebrow}</div>
            <h1 className="fy-music__title">{production.meta.title}</h1>
            <div className="fy-music__m" data-testid="music-total">
              {record.tracks.length} track{record.tracks.length === 1 ? "" : "s"}{total !== null && record.tracks.length > 0 ? ` · ${musicClock(total)}` : ""}
            </div>
          </div>
          <div className="fy-music__acts">
            <Button variant="primary" disabled={record.tracks.length === 0 || rendering !== null || connection !== "open"} onClick={() => playFrom(null)}>
              {rendering !== null ? "Rendering…" : "Play all"}
            </Button>
            <Button disabled={record.tracks.length === 0} onClick={() => setExporting(true)}>Export</Button>
            <span className="fy-music__more">
              <button type="button" className="fy-music__ib" aria-label="More" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}><More size={15} /></button>
              {more && (
                <div className="fy-music__menu" role="menu">
                  <button type="button" role="menuitem" disabled={cover === undefined} onClick={() => { setMore(false); setMusicCover(worldId, productionId, null); }}>Remove cover</button>
                </div>
              )}
            </span>
          </div>
          {problem !== null && <Callout tone="danger" title="Not done">{problem}</Callout>}
        </aside>

        <section className="fy-music__group" aria-label="Tracks">
          <div className="fy-music__gh">
            <span className="fy-music__seg" role="radiogroup" aria-label="View">
              <button type="button" role="radio" aria-checked={view === "tracks"} className={cx(view === "tracks" && "on")} onClick={() => setView("tracks")}>Tracks</button>
              <button type="button" role="radio" aria-checked={view === "sequence"} className={cx(view === "sequence" && "on")} disabled={record.tracks.length === 0} onClick={() => { setOpen(null); setView("sequence"); }}>Sequence</button>
            </span>
            <span className="fy-music__m">{record.tracks.length}{total !== null && record.tracks.length > 0 ? ` · ${musicClock(total)}` : ""}</span>
            <span className="grow" />
            {view === "sequence" ? (
              <>
                <LoudnessSelect world={world} production={production} record={record} />
                <Button variant="primary" disabled={rendering !== null || connection !== "open"} onClick={() => playFrom(record.tracks[0]?.id ?? null)}><PlaySolid size={12} />{rendering !== null ? "Rendering…" : "Play through"}</Button>
              </>
            ) : (
              <Button onClick={() => setAdding(true)}><Plus size={13} />Add track</Button>
            )}
          </div>
          {view === "sequence" && record.tracks.length > 0 && <MusicSequence world={world} production={production} record={record} onPlayFrom={playFrom} />}
          {view === "tracks" && !phone && (
            <div className="fy-music__th" aria-hidden="true">
              <span className="grip" /><span className="n">#</span><span className="t">Title</span><span className="src">From</span><span className="heard">Heard in</span><span className="len">Length</span><span className="pl" />
            </div>
          )}
          {view === "tracks" && tracks.map((track, index) => {
            const length = musicTrackLengthMs(track, artifacts);
            const rows = heard[track.id] ?? [];
            // Whose theme it is in the Guide (238c, SPEC-059 R-35): the first by name, and how many more.
            const themes = themeNames(world, world.guide ?? EMPTY_GUIDE_RECORD, { production: productionId, track: track.id });
            return (
              <div
                key={track.id}
                className={cx("fy-music__tr", open === track.id && "on")}
                data-testid="music-track"
                draggable
                onDragStart={(event: DragEvent) => { dragged.current = track.id; event.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.preventDefault(); drop(track.id); }}
              >
                <span className="grip" aria-hidden="true"><Grip size={14} /></span>
                <span className="n">{index + 1}</span>
                <button type="button" className="t" onClick={() => setOpen(open === track.id ? null : track.id)}>
                  <b>{track.title}</b>
                  {themes.length > 0 && <span className="fy-music__theme">{themes[0]}’s theme{themes.length > 1 ? ` · +${themes.length - 1}` : ""}</span>}
                </button>
                {!phone && <span className="src">{fromOf(track, artifacts)}</span>}
                {!phone && <span className={cx("heard", rows.length === 0 && "none")}>{heardLine(rows)}</span>}
                <span className="len">{length === null ? "—" : musicClock(length)}</span>
                <span className="pl"><ClipPlayButton clip={clipOf(track)} small /></span>
              </div>
            );
          })}
          {view === "tracks" && <button type="button" className="fy-music__addrow" onClick={() => setAdding(true)}><Plus size={14} />Add track</button>}
        </section>

        {openTrack !== null && (
          <TrackPanel
            key={openTrack.id}
            world={world}
            production={production}
            record={record}
            track={openTrack}
            number={tracks.indexOf(openTrack) + 1}
            heard={heard[openTrack.id] ?? []}
            clip={clipOf(openTrack)}
            onClose={() => setOpen(null)}
          />
        )}
      </div>
      {adding && <AddTrackDialog world={world} production={production} record={record} onClose={() => setAdding(false)} />}
      {covering && <CoverDialog world={world} production={production} record={record} onClose={() => setCovering(false)} />}
      {exporting && <MusicExportSheet world={world} production={production} record={record} heard={heard} onClose={() => setExporting(false)} />}
    </Screen>
  );
}

/**
 * Add track (238d, R-6): the world's kept music takes from Bench, each with play, filtered by
 * Songs or Instrumental and searched; a take already on the album says which track and is dimmed.
 * Import a file takes WAV, MP3, M4A or FLAC, kept as the production's own.
 */
function AddTrackDialog({ world, production, record, onClose }: { world: WorldBundle; production: ProductionBundle; record: MusicRecord; onClose: () => void }) {
  const worldId = world.meta.worldId;
  // Kept music is the world's, whichever production made it: an audio drama's music cues too.
  const kept = keptMusic(world.artifacts);
  const [filter, setFilter] = useState<"kept" | "songs" | "instrumental">("kept");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A Single holds one track (R-3): a second makes it an Album, said on the button that does it.
  const single = musicKindOf(production.meta) === "single" && record.tracks.length >= 1;
  const onAlbum = new Map(record.tracks.flatMap((track, index) => ("artifactId" in track.source ? [[track.source.artifactId, index + 1] as const] : [])));
  const shown = kept.filter((entry) => (filter === "kept" || (filter === "songs") === entry.song) && entry.title.toLowerCase().includes(query.trim().toLowerCase()));
  const songs = kept.filter((entry) => entry.song).length;
  const picked = kept.find((entry) => entry.artifact.id === chosen) ?? null;
  useEffect(() => subscribeQueueResults((result) => {
    if (result.requestId !== importing) return;
    setImporting(null);
    if (result.failures.length > 0) setProblem(result.failures.map((failure) => failure.reason).join(" · "));
    else if (result.requestedCount > 0) onClose();
  }), [importing, onClose]);
  const importFile = () => {
    setProblem(null);
    const started = importEditorMedia(worldId, undefined, undefined, undefined, undefined, { productionId: production.meta.id, ...(single ? { makeAlbum: true } : {}) });
    if (started.requestId === null) setProblem(started.reason ?? "The file could not be imported.");
    else setImporting(started.requestId);
  };
  return (
    <EditorDialog open onClose={onClose} width={880} labelledBy="music-add-track" panelClassName="fy-music-dlg">
      <header className="fy-music-dlg__head">
        <h3 id="music-add-track">Add track</h3>
        <small>{production.meta.title} · {record.tracks.length} track{record.tracks.length === 1 ? "" : "s"}</small>
        <span className="grow" />
        <button type="button" className="fy-music__ib" aria-label="Close" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="fy-music-dlg__bd">
        <div className="fy-music-dlg__filters">
          {([["kept", `Kept ${kept.length}`], ["songs", `Songs ${songs}`], ["instrumental", `Instrumental ${kept.length - songs}`]] as const).map(([id, label]) => (
            <button key={id} type="button" className={cx("fy-music__chip", filter === id && "on")} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
          ))}
          <span className="grow" />
          <label className="fy-music__search"><Search size={13} /><input aria-label="Search the world's music" placeholder="Search the world's music" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </div>
        <div className="fy-music-dlg__tiles" role="radiogroup" aria-label="Kept music">
          {shown.map(({ artifact, title }) => {
            const track = onAlbum.get(artifact.id);
            const seconds = artifact.mediaInfo?.durationSec;
            return (
              <div key={artifact.id} className={cx("fy-music-tile", chosen === artifact.id && "on", track !== undefined && "no")} data-testid="music-take">
                <div className="art">
                  <Wave seed={artifact.id} width={150} height={30} />
                  <span className="play"><ClipPlayButton clip={{ id: `take:${artifact.id}`, url: mediaUrl(world.meta.slug, `artifacts/${artifact.file}`), title }} small /></span>
                  <button type="button" role="radio" aria-checked={chosen === artifact.id} aria-label={title} className="rad" disabled={track !== undefined} onClick={() => setChosen(artifact.id)} />
                </div>
                <button type="button" className="nm" disabled={track !== undefined} onClick={() => setChosen(artifact.id)}>
                  <b>{title}</b>
                  <small>{track !== undefined ? `Track ${track}` : [artifact.generation?.source === "sound" ? "Audio drama" : "Bench", seconds !== undefined ? musicClock(seconds * 1000) : null, `kept ${new Date(artifact.created).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`].filter(Boolean).join(" · ")}</small>
                </button>
              </div>
            );
          })}
          <button type="button" className="fy-music-tile dash" disabled={importing !== null} onClick={importFile} data-testid="music-import">
            <Upload size={16} />
            <b>{importing !== null ? "Importing…" : "Import a file"}</b>
            <small>{MUSIC_IMPORT_EXTENSIONS.map((extension) => extension.toUpperCase()).join(" · ")}</small>
          </button>
        </div>
        {problem !== null && <Callout tone="danger" title="Not added">{problem}</Callout>}
      </div>
      <footer className="fy-music-dlg__foot">
        <small>{picked !== null ? `${picked.title}${picked.artifact.mediaInfo !== undefined ? ` · ${musicClock(picked.artifact.mediaInfo.durationSec * 1000)}` : ""}` : ""}</small>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={picked === null} onClick={() => { if (picked !== null && addMusicTrack(worldId, production.meta.id, picked.artifact.id, single)) onClose(); }}>
          {single ? "Make album · add track" : "Add track"}
        </Button>
      </footer>
    </EditorDialog>
  );
}

/**
 * A track open beside the album (238e, R-7): its player, where it came from, its lyrics with
 * Draft with Arke, where it is heard and whose theme it is in the Guide (SPEC-059 R-35). Takes
 * widens it into the track's composer (238i); Edit opens the track editor (238j).
 */
function TrackPanel({ world, production, record, track, number, heard, clip, onClose }: { world: WorldBundle; production: ProductionBundle; record: MusicRecord; track: Track; number: number; heard: readonly MusicHeardRow[]; clip: Clip | null; onClose: () => void }) {
  const worldId = world.meta.worldId;
  const productionId = production.meta.id;
  const length = musicTrackLengthMs(track, world.artifacts);
  const themes = themeNames(world, world.guide ?? EMPTY_GUIDE_RECORD, { production: productionId, track: track.id });
  const [title, setTitle] = useState(track.title);
  const [lyrics, setLyrics] = useState(track.lyrics ?? "");
  const [drafting, setDrafting] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState(false);
  const artifact = musicTrackArtifact(track, world.artifacts);
  useEffect(() => { setLyrics(track.lyrics ?? ""); }, [track.lyrics]);
  useEffect(() => subscribeMusicLyricsDrafted((answer) => {
    if (answer.requestId !== drafting) return;
    setDrafting(null);
    if (answer.lyrics === null) setNote(answer.reason ?? "No draft this time");
    else { setLyrics(answer.lyrics); setNote(null); }
  }), [drafting]);
  const changed = lyrics !== (track.lyrics ?? "");
  const saveTitle = () => {
    const next = title.trim();
    if (next !== "" && next !== track.title) updateMusicTrack(worldId, productionId, track.id, { title: next });
    else setTitle(track.title);
  };
  const lyricsField = (
    <div className="fy-music-panel__lyrics">
      <textarea aria-label="Lyrics" rows={composing ? 6 : 8} value={lyrics} placeholder="[verse]" onChange={(event) => setLyrics(event.target.value)} />
      <span className="fy-music-panel__row">
        <Button disabled={drafting !== null} onClick={() => { setNote(null); setDrafting(draftMusicLyrics(worldId, productionId, track.id, `${track.title}, a track on ${production.meta.title}, from ${world.meta.name}`)); }}>
          {drafting !== null ? "Drafting…" : "Draft with Arke"}
        </Button>
        {changed && <Button variant="primary" onClick={() => updateMusicTrack(worldId, productionId, track.id, { lyrics })}>Save</Button>}
        {note !== null && <span className="fy-music__m">{note}</span>}
      </span>
    </div>
  );
  return (
    <aside className={cx("fy-music-panel", composing && "fy-music-panel--wide")} aria-label={`Track ${number}`} data-testid="music-panel">
      <header>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="fy-music__eyebrow">TRACK {number} · {production.meta.title.toUpperCase()}</div>
          <input className="fy-music-panel__title" aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} onBlur={saveTitle} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        </div>
        <button type="button" className="fy-music__ib" aria-label="Close" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="fy-music-panel__bd">
        {composing ? (
          <TrackComposer world={world} production={production} track={track} lyrics={lyrics} lyricsField={lyricsField} onLyricsUsed={() => { if (changed) updateMusicTrack(worldId, productionId, track.id, { lyrics }); }} />
        ) : (
          <>
          <div className="fy-music-panel__player">
            <ClipPlayButton clip={clip} />
            <span className="fy-music-panel__wave"><Peaks worldId={worldId} file={artifact === undefined ? null : `artifacts/${artifact.file}`} seed={track.id} bars={52} height={30} /></span>
            <span className="fy-music__m">{length === null ? "—" : musicClock(length)}</span>
          </div>
          <div className="fy-music-panel__kv">
            <span>From</span>
            <span className="fy-music-panel__from">{fromOf(track, world.artifacts)}<Button onClick={() => setComposing(true)} data-testid="music-takes">Takes</Button></span>
            <span>Lyrics</span>
            {lyricsField}
            <span>Heard in</span>
            <div className="fy-music-panel__heard" data-testid="music-heard">
              {heard.length === 0 ? <span className="fy-music__m">—</span> : heard.map((row) => (
                <Link key={`${row.production}/${row.chapter}/${row.at}`} className="fy-music-panel__link" to={`/w/${worldId}${row.open}`}>
                  {row.productionTitle} · {row.label}<span className="fy-music__m">at {musicClock(row.at)}</span>
                </Link>
              ))}
            </div>
            <span>Theme of</span>
            <span className={cx("fy-music-panel__themes", themes.length === 0 && "fy-music__m")} data-testid="music-theme-of">{themes.length === 0 ? "—" : themes.join(" · ")}</span>
          </div>
          </>
        )}
      </div>
      <footer>
        {composing && <Button variant="ghost" onClick={() => setComposing(false)}>Back</Button>}
        <Button disabled={artifact === undefined} onClick={() => setEditing(true)} data-testid="music-edit">Edit</Button>
        <span className="grow" />
        <Button variant="ghost" onClick={() => { if (removeMusicTrack(worldId, productionId, track.id)) onClose(); }}>Remove from album</Button>
      </footer>
      {editing && <TrackEditor world={world} production={production} record={record} track={track} number={number} onClose={() => setEditing(false)} />}
    </aside>
  );
}

/**
 * Make cover (238c, R-5): a square cover from the world's pictures, or made in Bench at 1:1,
 * 1024 × 1024, as Bench makes any picture; Arke's agents ask for that shape by the baseline.
 */
function CoverDialog({ world, production, record, onClose }: { world: WorldBundle; production: ProductionBundle; record: MusicRecord; onClose: () => void }) {
  const worldId = world.meta.worldId;
  const pictures = shelfOf(world, production).filter((artifact) => artifact.kind === "image");
  const [chosen, setChosen] = useState<string | null>(record.cover ?? null);
  return (
    <EditorDialog open onClose={onClose} width={760} labelledBy="music-cover" panelClassName="fy-music-dlg">
      <header className="fy-music-dlg__head">
        <h3 id="music-cover">Cover</h3>
        <small>1:1 · {MUSIC_COVER_EDGE} × {MUSIC_COVER_EDGE}</small>
        <span className="grow" />
        <button type="button" className="fy-music__ib" aria-label="Close" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="fy-music-dlg__bd">
        <div className="fy-music-dlg__covers" role="radiogroup" aria-label="Pictures">
          {pictures.map((artifact) => (
            <button key={artifact.id} type="button" role="radio" aria-checked={chosen === artifact.id} className={cx("fy-music-coverpick", chosen === artifact.id && "on")} onClick={() => setChosen(artifact.id)}>
              <img src={mediaUrl(world.meta.slug, `artifacts/${artifact.file}`)} alt="" />
            </button>
          ))}
          {pictures.length === 0 && <span className="fy-music__m"><ImageMark size={14} /> No pictures on the shelf yet</span>}
        </div>
      </div>
      <footer className="fy-music-dlg__foot">
        <Link className="ui-btn ui-btn--secondary ui-btn--default" to={`/w/${worldId}/artifacts/bench`} onClick={() => sendBenchNewSession(worldId, undefined, { aspect: "1:1", brief: `Cover for ${production.meta.title}, ${productionShape(production.meta).displayLabel.toLowerCase()} from ${world.meta.name}` })}><Sparkle size={13} />Make in Bench</Link>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={chosen === null || chosen === record.cover} onClick={() => { if (chosen !== null && setMusicCover(worldId, production.meta.id, chosen)) onClose(); }}>Use as cover</Button>
      </footer>
    </EditorDialog>
  );
}

// What the estimate assumes: AAC at 256 kb/s, a fitted cover, and how fast this machine renders.
const COVER_BYTES = 300_000;
const RENDER_SECONDS_PER_SECOND = 40;

/**
 * Export → Arke Player for a music production (238h, R-15 – R-17): the rows of what the package
 * holds, priced as a package, made on the desktop, read back and recorded in Publications.
 */
function MusicExportSheet({ world, production, record, heard, onClose }: { world: WorldBundle; production: ProductionBundle; record: MusicRecord; heard: Record<string, MusicHeardRow[]>; onClose: () => void }) {
  const worldId = world.meta.worldId;
  const connection = useStore().connection;
  const shape = productionShape(production.meta);
  const total = musicTotalMs(record, world.artifacts);
  const cover = record.cover === undefined ? undefined : world.artifacts.find((artifact) => artifact.id === record.cover);
  const withLyrics = record.tracks.filter((track) => track.lyrics?.trim()).length;
  const withSections = record.tracks.some((track) => (track.sections?.length ?? 0) > 0);
  const heardTracks = record.tracks.filter((track) => (heard[track.id]?.length ?? 0) > 0);
  const heardIn = [...new Set(heardTracks.flatMap((track) => heard[track.id]!.map((row) => row.productionTitle)))];
  const seconds = (total ?? 0) / 1000;
  const bytes = seconds * (MUSIC_AAC_KBPS * 1000) / 8 + (cover !== undefined ? COVER_BYTES : 0);
  const [making, setMaking] = useState<string | null>(null);
  const [result, setResult] = useState<ArkePlayerExported["result"] | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => subscribeArkePlayerExported((answer) => {
    if (answer.exportId !== making) return;
    setMaking(null);
    setResult(answer.result);
  }), [making]);
  const start = () => {
    const id = `ap_${ulid()}`;
    setResult(null);
    if (exportArkePlayer(worldId, production.meta.id, id, { book: false, motion: false }) !== null) setMaking(id);
  };
  const made = result?.ok === true ? result : null;
  const opt = (label: string, middle: ReactNode, tail?: string) => (
    <div className="fy-abv-opt"><b>{label}</b>{middle}<span className="grow" />{tail !== undefined && <i>{tail}</i>}</div>
  );
  const footer = (
    <div className="fy-abv-foot">
      <span className="grow" />
      {made !== null ? <button type="button" className="fy-abv-btn pri" onClick={onClose}>Done</button> : (
        <>
          <button type="button" className="fy-abv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="fy-abv-btn pri" disabled={making !== null || connection !== "open" || record.tracks.length === 0} onClick={start} data-testid="music-export-start">Make package</button>
        </>
      )}
    </div>
  );
  return (
    <PageSheet open onClose={onClose} title={`Export · ${production.meta.title}`} subtitle={`${shape.displayLabel} · ${record.tracks.length} track${record.tracks.length === 1 ? "" : "s"}${total !== null ? ` · ${musicClock(total)}` : ""}`} footer={footer} className="fy-abv-modal">
      <div className="fy-abv-sheet fy-music-export" data-testid="music-export">
        {made === null ? (
          <>
            <div className="fy-abv-opts">
              {opt("World", <>{world.keyArt ? <img src={mediaUrl(world.meta.slug, world.keyArt)} alt="" /> : null}<span>{world.meta.name}</span></>, "beside its edition")}
              {opt("Tracks", <span>{record.tracks.length}{total !== null ? ` · ${musicClock(total)}` : ""}</span>, `AAC · ${MUSIC_AAC_KBPS} kbps`)}
              {opt("Sequence", <span>{musicSequenceLine(record)}</span>, musicLoudnessLabel(record.loudness))}
              {opt("Cover", cover !== undefined ? <><img className="sq" src={mediaUrl(world.meta.slug, `artifacts/${cover.file}`)} alt="" /><span>1:1</span></> : <span>None</span>, cover !== undefined ? `${MUSIC_COVER_EDGE} × ${MUSIC_COVER_EDGE}` : undefined)}
              {opt("Lyrics", <span>{withLyrics} of {record.tracks.length} track{record.tracks.length === 1 ? "" : "s"}</span>, withSections ? "with sections" : undefined)}
              {opt("Heard in", <span>{heardTracks.length === 0 ? "—" : `${heardTracks.length} track${heardTracks.length === 1 ? "" : "s"}`}</span>, heardIn.length > 0 ? heardIn.join(" · ") : undefined)}
            </div>
            <div className="fy-abv-est" data-testid="music-export-estimate">
              <b>~{megabytes(bytes)} · ~{Math.max(1, Math.ceil(seconds / RENDER_SECONDS_PER_SECOND))} s on this machine</b>
              <span className="m">{record.tracks.length} track{record.tracks.length === 1 ? "" : "s"}{cover !== undefined ? " · 1 cover" : ""}</span>
            </div>
            {making !== null && <div className="fy-abv-note">Making package · follow it in Activity</div>}
            {result?.ok === false && result.blockers.map((blocker) => <div key={blocker} className="fy-abv-warn">{blocker}</div>)}
          </>
        ) : (
          <div className="fy-abv-made" data-testid="music-export-done">
            <div className="fy-abv-est">
              <b>1 package · {megabytes(made.bytes)}</b>
              <span className="m">{made.file}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="fy-abv-btn" onClick={() => openExportsFolder(worldId)}><Folder />Show in folder</button>
            </div>
            <div className="fy-abv-sha">
              <b>SHA-256</b>
              <code>{made.sha256}</code>
              <button type="button" className="fy-abv-btn" onClick={() => void navigator.clipboard?.writeText(made.sha256).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
            </div>
          </div>
        )}
      </div>
    </PageSheet>
  );
}
