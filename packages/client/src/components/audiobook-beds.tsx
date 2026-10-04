import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  BED_DEFAULTS,
  SOUND_DEFAULT_LEVEL_DB,
  SOUNDS,
  formatRunningTime,
  formatTimingSeconds,
  type ArtifactSidecar,
  type BedInput,
  type ChapterAudiobook,
  type ChapterTiming,
  type ReactionInput,
  type Sound,
  type TimedBar,
  type WorldBundle,
} from "@arke-studio/contracts";
import { usableModels } from "./dispatch-bar.js";
import { setupForMode } from "../lib/composer-mode.js";
import { sendBenchCompose, sendBenchNewSession, useBench, useStore } from "../lib/store.js";
import { SecondsField } from "../screens/chapter-timing.js";
import { Button, Input, Textarea, cx } from "./ui.js";

/**
 * Beds, sounds and reactions on the blocks (design turn 187d, SPEC-047 R-83, R-84): in the
 * Audiobook view's block panel, a bed from this block to another under the voices — its level,
 * its fades, its duck — and a sound at this block's start, each chosen from the sounds the world
 * holds or generated through the Bench's music and sound routes, priced there as any generation;
 * and the reactions that play under this block, a sound from the cadence list or a few words in a
 * speaker's voice, read when the chapter is.
 */

export type SoundTab = "library" | "world" | "generated";
export const SOUND_TABS: ReadonlyArray<{ tab: SoundTab; label: string }> = [
  { tab: "library", label: "Library" },
  { tab: "world", label: "World" },
  { tab: "generated", label: "Generate" },
];

/**
 * The sounds on offer, by tab: what was brought into the world is its Library; what the Bench
 * made is Generate's; the rest the world made is World. Never an audiobook take.
 */
export function soundsByTab(world: Pick<WorldBundle, "artifacts">): Record<SoundTab, ArtifactSidecar[]> {
  const out: Record<SoundTab, ArtifactSidecar[]> = { library: [], world: [], generated: [] };
  for (const artifact of world.artifacts) {
    if (artifact.kind !== "audio" || artifact.retiredAt !== undefined || artifact.generation?.source === "audiobook") continue;
    if (artifact.origin.by === "user") out.library.push(artifact);
    else if (artifact.generation?.source === "bench") out.generated.push(artifact);
    else out.world.push(artifact);
  }
  for (const list of Object.values(out)) list.sort((a, b) => (a.created < b.created ? 1 : -1));
  return out;
}

const nameOf = (artifact: Pick<ArtifactSidecar, "file">) => artifact.file.split("/").pop()!;
const lengthOf = (artifact: Pick<ArtifactSidecar, "mediaInfo">) => {
  const seconds = artifact.mediaInfo?.durationSec;
  return seconds === undefined ? null : formatRunningTime(seconds);
};

interface BlockLike { block: { key: string; text: string }; mark: string; speakerKey: string | null }

/** The panel's sound picker: tabs, the sounds on each, and Generate through the Bench. */
function SoundPicker({ worldId, world, chosen, onChoose, brief }: { worldId: string; world: WorldBundle; chosen: string | null; onChoose: (file: string, origin: SoundTab) => void; brief: string }) {
  const [tab, setTab] = useState<SoundTab>("world");
  const [text, setText] = useState(brief);
  useEffect(() => setText(brief), [brief]);
  const offered = useMemo(() => soundsByTab(world), [world]);
  const store = useStore();
  const navigate = useNavigate();
  // Generate: a new Bench session in music mode with the brief written in, then the Bench, which
  // prices, confirms and files the sound as any generation; it is then chosen here under Generate.
  const bench = useBench();
  const pending = useRef<{ before: string | null; brief: string } | null>(null);
  useEffect(() => {
    const asked = pending.current;
    const session = bench?.session;
    if (asked === null || session === undefined || session.id === asked.before || bench?.worldId !== worldId) return;
    pending.current = null;
    const setup = setupForMode("music", undefined, usableModels(store.state, "music"));
    sendBenchCompose(worldId, session.id, { mode: "music", provider: setup.provider, model: setup.model, params: setup.params, brief: asked.brief });
    void navigate(`/w/${worldId}/artifacts/bench/${session.id}`);
  }, [bench, worldId, navigate, store.state]);
  const list = offered[tab];
  return (
    <>
      <nav className="fy-seg fy-ab__seg" aria-label="Sound from">
        {SOUND_TABS.map((item) => (
          <button key={item.tab} type="button" className={cx("fy-seg__item", tab === item.tab && "fy-seg__item--active")} aria-pressed={tab === item.tab} onClick={() => setTab(item.tab)}>
            {item.label}
          </button>
        ))}
      </nav>
      {tab === "generated" && (
        <div className="fy-ab__picgen">
          <Textarea aria-label="Sound" rows={2} value={text} onChange={(event) => setText(event.target.value)} />
          <Button
            variant="primary"
            disabled={store.connection !== "open"}
            data-testid="audiobook-sound-generate"
            onClick={() => {
              pending.current = { before: bench?.session.id ?? null, brief: text };
              sendBenchNewSession(worldId);
            }}
          >
            Generate
          </Button>
        </div>
      )}
      <div className="fy-tm__sounds" role="listbox" aria-label="Sounds">
        {list.map((artifact) => {
          const file = `artifacts/${artifact.file}`;
          return (
            <button key={artifact.id} type="button" role="option" aria-selected={chosen === file} className={cx("fy-tm__soundrow", chosen === file && "fy-tm__soundrow--on")} disabled={store.connection !== "open"} onClick={() => onChoose(file, tab)}>
              <span>{nameOf(artifact)}</span>
              <span className="fy-mono">{lengthOf(artifact) ?? ""}</span>
            </button>
          );
        })}
        {list.length === 0 && <span className="fy-mono fy-ab__card-line">none</span>}
      </div>
    </>
  );
}


/**
 * Bed (187d): the bed that starts on this block, or a new one from it; where it ends, its level
 * and its duck under voices, its fades; Remove and Done. The run it covers is said as data.
 */
export function BedPanel({ worldId, world, record, timing, rows, row, onBed, onSound, locked }: {
  worldId: string;
  world: WorldBundle;
  record: ChapterAudiobook | null;
  timing: ChapterTiming;
  rows: readonly BlockLike[];
  row: BlockLike;
  onBed: (key: string | null, bed: BedInput | null) => void;
  onSound: (key: string | null, sound: { block: string; source: { file: string; origin: SoundTab }; levelDb: number } | null) => void;
  locked: boolean;
}) {
  const key = row.block.key;
  const bedHere = Object.entries(record?.beds ?? {}).find(([, bed]) => bed.from.key === key) ?? null;
  const soundHere = Object.entries(record?.sounds ?? {}).find(([, sound]) => sound.block.key === key) ?? null;
  const [open, setOpen] = useState<"bed" | "sound" | null>(null);
  useEffect(() => setOpen(null), [key]);
  const index = rows.findIndex((candidate) => candidate.block.key === key);
  const timed = bedHere === null ? null : (timing.beds.find((bed) => bed.id === bedHere[0]) ?? null);
  const draft: BedInput = bedHere === null
    ? { from: key, to: rows[rows.length - 1]?.block.key ?? key, source: { file: "", origin: "world" }, levelDb: BED_DEFAULTS.levelDb, fadeInSec: BED_DEFAULTS.fadeInSec, fadeOutSec: BED_DEFAULTS.fadeOutSec, duckDb: BED_DEFAULTS.duckDb }
    : { from: bedHere[1].from.key, to: bedHere[1].to.key, source: { file: bedHere[1].source.file, origin: bedHere[1].source.origin }, levelDb: bedHere[1].levelDb, fadeInSec: bedHere[1].fadeInSec, fadeOutSec: bedHere[1].fadeOutSec, duckDb: bedHere[1].duckDb };
  const write = (change: Partial<BedInput>) => {
    const next = { ...draft, ...change };
    if (next.source.file === "") return;
    onBed(bedHere?.[0] ?? null, next);
  };
  const source = bedHere?.[1].source ?? null;
  const ends = rows.find((candidate) => candidate.block.key === draft.to);
  const words = (text: string) => (text.length > 28 ? `${text.slice(0, 26)}…` : text);
  return (
    <section className="fy-bible__panel fy-tm__bedpanel" data-testid="audiobook-bed">
      {open !== "bed" ? (
        <div className="fy-tm__row">
          <span className="fy-ab__label">Bed</span>
          <span className="fy-mono fy-tm__data">{bedHere === null ? "none" : `${source?.label ?? ""} · ${draft.from} to ${draft.to}${timed !== null ? ` · ${formatRunningTime(timed.seconds)}` : ""}`}</span>
          <span className="fy-ch__panelpush" />
          <button type="button" className="fy-abp__add" disabled={locked} onClick={() => setOpen("bed")} data-testid="audiobook-bed-open">{bedHere === null ? "Add" : "Edit"}</button>
        </div>
      ) : (
        <div className="fy-tm__side">
          <h3 className="fy-ab__card-title">Bed{source !== null ? ` · ${source.label}` : ""}</h3>
          <p className="fy-mono fy-tm__data">{draft.from} to {draft.to}{timed !== null ? ` · ${formatRunningTime(timed.seconds)}` : ""}{timed?.cut === "to" ? " · ended early · block removed" : ""}</p>
          <SoundPicker worldId={worldId} world={world} chosen={draft.source.file === "" ? null : draft.source.file} brief={`A bed under an audiobook scene: ${row.block.text.replace(/\s+/g, " ").trim()}`} onChoose={(file, origin) => write({ source: { file, origin } })} />
          {source !== null && <p className="fy-mono fy-tm__data">From {source.label}{source.seconds !== undefined ? ` · ${formatRunningTime(source.seconds)}` : ""}</p>}
          <div className="fy-tm__row">
            <span className="fy-ab__label">Level</span>
            <SecondsField label="Level" testId="bed-level" value={draft.levelDb} min={-40} max={0} disabled={locked || bedHere === null} onCommit={(levelDb) => write({ levelDb })} />
            <span className="fy-mono fy-tm__unit">dB · ducks</span>
            <SecondsField label="Duck" testId="bed-duck" value={draft.duckDb} min={0} max={30} disabled={locked || bedHere === null} onCommit={(duckDb) => write({ duckDb })} />
            <span className="fy-mono fy-tm__unit">dB under voices</span>
          </div>
          <div className="fy-tm__row">
            <span className="fy-ab__label">Fade</span>
            <SecondsField label="Fade in" testId="bed-fade-in" value={draft.fadeInSec} min={0} max={30} disabled={locked || bedHere === null} onCommit={(fadeInSec) => write({ fadeInSec })} />
            <SecondsField label="Fade out" testId="bed-fade-out" value={draft.fadeOutSec} min={0} max={30} disabled={locked || bedHere === null} onCommit={(fadeOutSec) => write({ fadeOutSec })} />
            <span className="fy-mono fy-tm__unit">in · out</span>
          </div>
          <div className="fy-tm__row">
            <span className="fy-ab__label">Ends</span>
            <select className="fy-ch__pick" aria-label="Ends" data-testid="bed-ends" value={draft.to} disabled={locked || bedHere === null} onChange={(event) => write({ to: event.target.value })}>
              {rows.slice(Math.max(0, index)).map((candidate) => (
                <option key={candidate.block.key} value={candidate.block.key}>{`${candidate.block.key} “${words(candidate.block.text)}”`}</option>
              ))}
            </select>
          </div>
          {ends !== undefined && bedHere !== null && <p className="fy-mono fy-tm__data">{formatTimingSeconds(draft.fadeInSec)} in · {formatTimingSeconds(draft.fadeOutSec)} out</p>}
          <div className="fy-tm__actions">
            {bedHere !== null && <Button variant="ghost" disabled={locked} onClick={() => onBed(bedHere[0], null)}>Remove</Button>}
            <Button variant="primary" onClick={() => setOpen(null)}>Done</Button>
          </div>
        </div>
      )}
      {open !== "sound" ? (
        <div className="fy-tm__row">
          <span className="fy-ab__label">Sound</span>
          <span className="fy-mono fy-tm__data">{soundHere === null ? "none" : `${soundHere[1].source.label} · ${soundHere[1].levelDb} dB`}{soundHere !== null && timing.lost.sounds.includes(soundHere[0]) ? " · block removed" : ""}</span>
          <span className="fy-ch__panelpush" />
          <button type="button" className="fy-abp__add" disabled={locked} onClick={() => setOpen("sound")} data-testid="audiobook-sound-open">{soundHere === null ? "Add" : "Edit"}</button>
        </div>
      ) : (
        <div className="fy-tm__side">
          <h3 className="fy-ab__card-title">Sound{soundHere !== null ? ` · ${soundHere[1].source.label}` : ""}</h3>
          <SoundPicker
            worldId={worldId}
            world={world}
            chosen={soundHere?.[1].source.file ?? null}
            brief={`A short sound effect: ${row.block.text.replace(/\s+/g, " ").trim()}`}
            onChoose={(file, origin) => onSound(soundHere?.[0] ?? null, { block: key, source: { file, origin }, levelDb: soundHere?.[1].levelDb ?? SOUND_DEFAULT_LEVEL_DB })}
          />
          {soundHere !== null && (
            <div className="fy-tm__row">
              <span className="fy-ab__label">Level</span>
              <SecondsField label="Sound level" testId="sound-level" value={soundHere[1].levelDb} min={-40} max={6} disabled={locked} onCommit={(levelDb) => onSound(soundHere[0], { block: key, source: { file: soundHere[1].source.file, origin: soundHere[1].source.origin }, levelDb })} />
              <span className="fy-mono fy-tm__unit">dB</span>
            </div>
          )}
          <div className="fy-tm__actions">
            {soundHere !== null && <Button variant="ghost" disabled={locked} onClick={() => onSound(soundHere[0], null)}>Remove</Button>}
            <Button variant="primary" onClick={() => setOpen(null)}>Done</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The reactions under a block (187a's `laughs under`, R-83): each listed with who says it and
 * where, and one added — a sound from the cadence list in a speaker's voice, or a few words.
 * Read when the chapter is, priced as any read; never in the manuscript.
 */
export function ReactionsPanel({ record, timing, row, speakers, onReaction, locked }: {
  record: ChapterAudiobook | null;
  timing: ChapterTiming;
  row: BlockLike;
  /** Who may react: the narrator and the chapter's speakers, by key, with their names. */
  speakers: ReadonlyArray<{ key: string; name: string }>;
  onReaction: (key: string | null, reaction: ReactionInput | null) => void;
  locked: boolean;
}) {
  const host = row.block.key;
  const here = Object.entries(record?.reactions ?? {}).filter(([, reaction]) => reaction.host.key === host);
  const [speaker, setSpeaker] = useState(speakers.find((candidate) => candidate.key !== row.speakerKey && candidate.key !== "narrator")?.key ?? "narrator");
  const [kind, setKind] = useState<"sound" | "words">("sound");
  const [sound, setSound] = useState<Sound>("laughs");
  const [words, setWords] = useState("");
  const [offset, setOffset] = useState(0);
  // The add form waits behind Add (design turn 194g: `Reactions · none · Add`), a block at a time.
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [host]);
  const barOf = (key: string): TimedBar | undefined => timing.bars.find((bar) => bar.key === key);
  const nameOf_ = (key: string) => speakers.find((candidate) => candidate.key === key)?.name ?? key;
  const add = () => {
    if (kind === "words" && words.trim() === "") return;
    onReaction(null, { host, speaker, ...(kind === "sound" ? { sound } : { words: words.trim() }), offset });
    setWords("");
  };
  return (
    <section className="fy-bible__panel fy-tm__reactions" data-testid="audiobook-reactions">
      <div className="fy-tm__row">
        <span className="fy-ab__label">Reactions</span>
        <span className="fy-mono fy-tm__data">{here.length === 0 ? "none" : `${here.length}`}</span>
        <span className="fy-ch__panelpush" />
        {!adding && (
          <button type="button" className="fy-abp__add" disabled={locked} onClick={() => setAdding(true)} data-testid="reaction-open">
            Add
          </button>
        )}
      </div>
      {here.map(([key, reaction]) => {
        const bar = barOf(key);
        return (
          <div key={key} className="fy-tm__row" data-testid="audiobook-reaction">
            <span className="fy-tm__reaction">{reaction.sound ?? `“${reaction.words}”`}</span>
            <span className="fy-mono fy-tm__data">{nameOf_(reaction.speaker)} · under · {formatTimingSeconds(reaction.offset)}{bar !== undefined && !bar.made ? " · not read" : ""}</span>
            <span className="fy-ch__panelpush" />
            <Button variant="ghost" size="sm" disabled={locked} onClick={() => onReaction(key, null)}>Remove</Button>
          </div>
        );
      })}
      {adding && <>
      <div className="fy-tm__row">
        <select className="fy-ch__pick" aria-label="Who" value={speaker} disabled={locked} onChange={(event) => setSpeaker(event.target.value)}>
          {speakers.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.name}</option>)}
        </select>
        <span className="fy-seg" role="radiogroup" aria-label="Reaction">
          <button type="button" role="radio" aria-checked={kind === "sound"} className={cx("fy-seg__item", kind === "sound" && "fy-seg__item--active")} onClick={() => setKind("sound")}>Sound</button>
          <button type="button" role="radio" aria-checked={kind === "words"} className={cx("fy-seg__item", kind === "words" && "fy-seg__item--active")} onClick={() => setKind("words")}>Words</button>
        </span>
      </div>
      {kind === "sound" ? (
        <span className="fy-ab__chips" role="radiogroup" aria-label="Sound">
          {SOUNDS.map((candidate) => (
            <span key={candidate} role="radio" tabIndex={0} aria-checked={sound === candidate} className={`fy-ab__chip fy-ab__chip--sound${sound === candidate ? " fy-ab__chip--on" : ""}`} onClick={() => setSound(candidate)} onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && setSound(candidate)}>
              {candidate}
            </span>
          ))}
        </span>
      ) : (
        <Input aria-label="Words" data-testid="reaction-words" maxLength={40} value={words} placeholder="mm" onChange={(event) => setWords(event.target.value)} />
      )}
      <div className="fy-tm__row">
        <span className="fy-ab__label">Under</span>
        <SecondsField label="Under" testId="reaction-offset" value={offset} min={0} max={600} disabled={locked} onCommit={setOffset} />
        <span className="fy-ch__panelpush" />
        <Button variant="ghost" onClick={() => setAdding(false)}>Done</Button>
        <Button variant="secondary" disabled={locked} onClick={add} data-testid="reaction-add">Add</Button>
      </div>
      </>}
    </section>
  );
}
