import { useEffect, useState } from "react";
import { proposedSectionLabel, ulid, type ProductionSpine, type SongSections } from "@arke-studio/contracts";
import { MusicMark } from "../components/icons.js";
import { clock } from "../components/player.js";
import { parseSongTime, sectionsCommand, songTimeText, wantsSections } from "../lib/song.js";
import { requestSongSections, sendSpineCommand, useConnection, useSpineAskPending } from "../lib/store.js";

/**
 * The song's sections, proposed (issue 3099).
 *
 * A music video's scenes follow its song's sections, and the author had to time them in another
 * program: nothing in the Studio said where the song changes. The coordinator now measures the
 * master track, and this offers what it found the moment a song has no sections marked. They are
 * where the sound changes, so they are numbered and never named. Nothing is on the spine until
 * the press, which sends them as the one spine command a person's own marks go through.
 */

/** What the Studio measured of the song, asked for while it has no sections marked. */
function useSongSections(worldId: string, productionId: string, spine: ProductionSpine | null): SongSections | null {
  const connection = useConnection();
  // A new track is a new song, and a reconnect asks again: an answer cut off with the socket is not replayed.
  const key = wantsSections(spine) && connection === "open" ? `${worldId}/${productionId}/${spine.trackArtifactId}` : null;
  const [found, setFound] = useState<{ key: string; song: SongSections } | null>(null);
  useEffect(() => {
    if (key === null) return;
    const control = new AbortController();
    void requestSongSections(worldId, productionId, control.signal).then((result) => {
      if (result?.status === "measured" && !control.signal.aborted) setFound({ key, song: result.song });
    });
    return () => control.abort();
  }, [key, worldId, productionId]);
  return found !== null && found.key === key && found.song.trackArtifactId === spine?.trackArtifactId ? found.song : null;
}

interface Row { atSec: number; text: string }

/**
 * A proposed start as its field shows it: the song's clock to the millisecond, as a spine card
 * reads a time. The field read `0:22` for a start at 22.9, so typing `0:23` moved it a tenth of a
 * second and looked like a whole one (codex on PR 3134). The start is what its text reads back
 * as, so what is seen is what is marked; the line of times above stays in whole seconds.
 */
function proposedStart(sec: number): Row {
  const text = songTimeText(sec);
  return { atSec: parseSongTime(text) ?? sec, text };
}

export function SongSectionsNotice({ worldId, productionId, spine, onSeek }: {
  worldId: string;
  productionId: string;
  spine: ProductionSpine | null;
  /** Move the playhead, so a proposed start can be heard before it is kept. */
  onSeek: (sec: number) => void;
}) {
  const song = useSongSections(worldId, productionId, spine);
  const pending = useSpineAskPending(worldId, productionId);
  const [hidden, setHidden] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // The person's own changes to the proposal, kept for the song they were made on.
  const [edits, setEdits] = useState<{ trackArtifactId: string; rows: Row[] } | null>(null);
  if (song === null || spine === null || song.startsSec.length < 2 || hidden === song.trackArtifactId) return null;

  const rows: Row[] = edits?.trackArtifactId === song.trackArtifactId ? edits.rows
    : song.startsSec.map(proposedStart);
  const change = (next: Row[]) => setEdits({ trackArtifactId: song.trackArtifactId, rows: next });
  // A time as the song shows it, inside the song, and not another section's.
  const valid = (row: Row, index: number) => parseSongTime(row.text) !== null && row.atSec < song.durationSec &&
    rows.findIndex((other) => other.atSec === row.atSec) === index;
  const ready = rows.length >= 2 && rows.every(valid);
  const count = `${rows.length} section${rows.length === 1 ? "" : "s"}`;
  const mark = () => {
    const next = sectionsCommand(spine, rows.map((row) => row.atSec), () => `mk_${ulid()}`);
    sendSpineCommand(worldId, productionId, next.baseRevision, next.command);
  };

  return (
    <div className="fy-cutnotice" data-testid="sections-notice">
      <span className="fy-cutnotice__mark" aria-hidden="true"><MusicMark size={12} /></span>
      <strong>{`${count} found.`}</strong>
      {!open && <span className="fy-cutnotice__hint fy-songsections__times">{rows.map((row) => clock(row.atSec)).join(" · ")}</span>}
      <span className="fy-h1row__push" />
      <button type="button" aria-expanded={open} aria-controls="song-sections" onClick={() => setOpen((was) => !was)}>Change</button>
      <button type="button" disabled={pending || !ready} onClick={mark}>{`Mark ${count}`}</button>
      <button type="button" className="fy-cutnotice__hide" aria-label="Hide" onClick={() => setHidden(song.trackArtifactId)}>&times;</button>
      {open && (
        <ul className="fy-cutnotice__did fy-songsections" id="song-sections">
          {rows.map((row, index) => {
            const name = proposedSectionLabel(index);
            return (
              // By place: a row has no identity but its order, and a removed one takes its place with it.
              <li key={index}>
                <button type="button" onClick={() => onSeek(row.atSec)}>{name}</button>
                {index === 0 ? <span>{row.text}</span> : (
                  <>
                    <input
                      type="text" aria-label={`${name} starts`} aria-invalid={!valid(row, index)} value={row.text}
                      onChange={(event) => {
                        const text = event.target.value;
                        const atSec = parseSongTime(text);
                        change(rows.map((one, at) => (at === index ? { text, atSec: atSec ?? one.atSec } : one)));
                      }}
                    />
                    <button type="button" className="fy-cutnotice__hide" aria-label={`Remove ${name}`} onClick={() => change(rows.filter((_, at) => at !== index))}>&times;</button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
