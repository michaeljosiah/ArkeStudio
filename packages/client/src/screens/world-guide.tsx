import { useEffect, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import {
  guideChapterNumber,
  guideChapterOf,
  guideCounts,
  guideDocument,
  guideLiving,
  guideLoreChoosable,
  guideLoreText,
  guideProductionsOf,
  guideSections,
  type CanonEntry,
  type GuideDocument,
  type GuideKind,
  type GuideProductionChapters,
  type GuideRecord,
  type GuideRecordAfter,
  type GuideRecordEntry,
  type GuideRecordVoice,
  type GuideSheetKind,
  type GuideVoiceLine,
  type Sheet,
  type WorldBundle,
} from "@arke-studio/contracts";
import { characterPortraitPath, locationPortraitPath, Portrait } from "../components/portrait.js";
import { Button, Checkbox, IconButton, Select, Switch, cx } from "../components/ui.js";
import { EyeOff, PauseSolid, PlaySolid, Smartphone, X } from "../components/icons.js";
import { mediaUrl } from "../lib/media.js";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { listGuideVoiceLines, setGuideEntry, subscribeGuideVoiceLines } from "../lib/store.js";

/**
 * A world's Guide (design turn 234, SPEC-059 R-1 – R-8): what Arke Player may show of the world,
 * entry by entry and section by section, each from the start or after a chapter. Nothing is public
 * until the author turns it on; only settled canon has a switch; a voice line is chosen from the
 * character's own takes. The Player's page beside an entry, and Preview's whole guide, are read by
 * the same `guideDocument` the package is, so what is drawn here is what ships.
 */

type Open = { kind: GuideKind; id: string } | null;
type Choice = { public: boolean; after?: GuideRecordAfter };
type Save = (kind: GuideKind, id: string, entry: GuideRecordEntry | null) => void;

const SHEET_TYPE: Record<GuideSheetKind, Sheet["type"]> = { characters: "character", locations: "location", factions: "faction" };
const LORE_LABEL: Record<CanonEntry["type"], string> = { lore: "Lore", rule: "Rule", timeline: "Timeline", location: "Location", faction: "Faction", tone: "Tone", thread: "Thread" };
const KIND_LABEL: Record<GuideKind, string> = { characters: "Character", locations: "Place", factions: "Faction", lore: "Lore" };

const clock = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const picturePath = (world: WorldBundle, kind: GuideSheetKind, id: string) => (kind === "locations" ? locationPortraitPath(world, id) : characterPortraitPath(world, id));
const roleOf = (kind: GuideSheetKind, sheet: Sheet) => (kind === "characters" ? sheet.role : kind === "locations" ? sheet.region : "Faction") ?? "";
const sameLine = (line: GuideVoiceLine, voice: GuideRecordVoice) => line.production === voice.production && line.chapter === voice.chapter && line.block === voice.block && line.sentence === voice.sentence;

/** Choices sent but not yet back in the snapshot, so a switch moves under the finger. */
function withPending(record: GuideRecord, pending: ReadonlyMap<string, GuideRecordEntry | null>): GuideRecord {
  if (pending.size === 0) return record;
  const next: GuideRecord = { ...record, characters: { ...record.characters }, locations: { ...record.locations }, factions: { ...record.factions }, lore: { ...record.lore } };
  for (const [key, entry] of pending) {
    const [kind, id] = key.split(":") as [GuideKind, string];
    const into = next[kind] as Record<string, GuideRecordEntry>;
    if (entry === null) delete into[id];
    else into[id] = entry;
  }
  return next;
}

/** An entry or section from the start, or after a chapter: the key absent, never undefined on the wire. */
function shownAfter<T extends { after?: GuideRecordAfter }>(value: T, after: GuideRecordAfter | undefined): T {
  const { after: _was, ...rest } = value;
  return (after === undefined ? rest : { ...rest, after }) as T;
}

export function GuideScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const [open, setOpen] = useState<Open>(null);
  const [previewing, setPreviewing] = useState(false);
  const [pending, setPending] = useState<ReadonlyMap<string, GuideRecordEntry | null>>(new Map());
  const guide = world?.guide;
  useEffect(() => setPending(new Map()), [guide]);
  useEffect(() => {
    if (open === null && !previewing) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(null);
      setPreviewing(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, previewing]);
  if (!world || !worldId || !guide) return null;

  const living = (kind: GuideSheetKind) => guideLiving(world.sheets.filter((sheet) => sheet.type === SHEET_TYPE[kind]));
  const listed = { characters: living("characters"), locations: living("locations"), factions: living("factions") };
  const canon = guideLiving(world.canon);
  const record = withPending(guide, pending);
  const productions = guideProductionsOf(world.productions);
  const counts = guideCounts(record, { ...listed, canon });
  const save: Save = (kind, id, entry) => {
    setPending((was) => new Map(was).set(`${kind}:${id}`, entry));
    if (kind === "lore") setGuideEntry(worldId, { entryKind: "lore", id, entry: entry === null ? null : shownAfter<Choice>({ public: entry.public }, entry.after) });
    else setGuideEntry(worldId, { entryKind: kind, id, entry });
  };
  // Turned on for the first time, an entry brings its sections with it; turned off, it keeps them.
  const toggle = (kind: GuideKind, id: string, on: boolean) => {
    const was = record[kind][id] as GuideRecordEntry | undefined;
    const sheet = kind === "lore" ? undefined : listed[kind].find((candidate) => candidate.id === id);
    const sections = was?.sections ?? (on && sheet !== undefined ? Object.fromEntries(guideSections(sheet).map((section) => [section.heading, { public: true }])) : undefined);
    save(kind, id, { ...was, public: on, ...(sections !== undefined && kind !== "lore" ? { sections } : {}) });
  };
  const lore = [...canon].sort((a, b) => Number(guideLoreChoosable(b)) - Number(guideLoreChoosable(a)) || a.id.localeCompare(b.id));

  return (
    <div data-screen="guide" className="fy-guide">
      <div className="fy-guide-head">
        <div>
          <h1 className="fy-guide-title">Guide</h1>
          <div className="fy-guide-meta" data-testid="guide-counts">
            {counts.characters.public} of {counts.characters.of} characters · {counts.places.public} of {counts.places.of} places · {counts.lore.public} of {counts.lore.of} lore
            {counts.after > 0 ? ` · ${counts.after} after a chapter` : ""}
          </div>
        </div>
        <span className="fy-guide-grow" />
        <Button onClick={() => setPreviewing(true)} data-testid="guide-preview"><Smartphone /> Preview</Button>
      </div>
      <div className="fy-guide-cols">
        <div>
          <Group title="Characters" count={`${counts.characters.public} of ${counts.characters.of}`}>
            {listed.characters.map((sheet) => (
              <SheetRow key={sheet.id} world={world} kind="characters" sheet={sheet} entry={record.characters[sheet.id]} productions={productions} onToggle={(on) => toggle("characters", sheet.id, on)} onOpen={() => setOpen({ kind: "characters", id: sheet.id })} />
            ))}
          </Group>
          <Group title="Places" count={`${counts.places.public} of ${counts.places.of}`}>
            {(["locations", "factions"] as const).flatMap((kind) =>
              listed[kind].map((sheet) => (
                <SheetRow key={`${kind}:${sheet.id}`} world={world} kind={kind} sheet={sheet} entry={record[kind][sheet.id]} productions={productions} onToggle={(on) => toggle(kind, sheet.id, on)} onOpen={() => setOpen({ kind, id: sheet.id })} />
              )),
            )}
          </Group>
        </div>
        <div>
          <Group title="Lore" count={`${counts.lore.public} of ${counts.lore.of}`}>
            {lore.map((entry) => {
              const choosable = guideLoreChoosable(entry);
              const choice = record.lore[entry.id];
              const on = choosable && choice?.public === true;
              return (
                <div key={entry.id} className={cx("fy-guide-row", !on && "fy-guide-row--off", !choosable && "fy-guide-row--shut")} data-testid={`guide-row-${entry.id}`}>
                  <button type="button" className="fy-guide-row__open" disabled={!choosable} onClick={() => setOpen({ kind: "lore", id: entry.id })}>
                    <span className="fy-guide-id">{entry.id}</span>
                    <span className="fy-guide-who"><b>{entry.title}</b><span>{LORE_LABEL[entry.type]}{choosable ? "" : ` · ${entry.status}`}</span></span>
                    <span className="fy-guide-col fy-guide-col--shows">{on ? <Shows after={choice!.after} productions={productions} /> : choosable ? "—" : ""}</span>
                  </button>
                  {choosable ? <Switch checked={on} label={`${entry.title} public`} onChange={(next) => toggle("lore", entry.id, next)} /> : <span className="fy-guide-switch-gap" />}
                </div>
              );
            })}
          </Group>
        </div>
      </div>
      {open !== null && <EntryPanel world={world} worldId={worldId} open={open} record={record} productions={productions} save={save} toggle={toggle} onClose={() => setOpen(null)} />}
      {previewing && <GuidePreview world={world} record={record} productions={productions} listed={listed} canon={canon} onClose={() => setPreviewing(false)} />}
    </div>
  );
}

/** A sheet's picture, or its initials where it has none yet (234a). */
function Face({ world, kind, sheet, large = false }: { world: WorldBundle; kind: GuideSheetKind; sheet: Sheet; large?: boolean }) {
  const [shown, setShown] = useState(true);
  const initials = sheet.name.split(/\s+/).filter((word) => /^[A-Za-z]/.test(word) && !/^(the|of|a)$/i.test(word)).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || sheet.name.slice(0, 1).toUpperCase();
  return (
    <span className={cx("fy-guide-face", large && "fy-guide-face--lg")}>
      {shown ? <Portrait worldSlug={world.meta.slug} path={picturePath(world, kind, sheet.id)} label={sheet.name} radius={large ? 10 : 8} loading="lazy" onAvailabilityChange={setShown} /> : <span className="fy-guide-ini">{initials}</span>}
    </span>
  );
}

function Group({ title, count, children }: { title: string; count: string; children: ReactNode }) {
  return (
    <section className="fy-guide-group" aria-label={title}>
      <div className="fy-guide-gh"><span>{title}</span><span className="fy-guide-grow" /><span className="fy-guide-mono">{count}</span></div>
      {children}
    </section>
  );
}

function Shows({ after, productions }: { after: GuideRecordAfter | undefined; productions: readonly GuideProductionChapters[] }) {
  if (after === undefined) return <>From the start</>;
  const chapter = guideChapterOf(productions, after);
  return <span className="fy-guide-tag"><EyeOff size={12} />{chapter !== null ? `After Chapter ${chapter.number}` : "Chapter removed"}</span>;
}

function SheetRow({ world, kind, sheet, entry, productions, onToggle, onOpen }: { world: WorldBundle; kind: GuideSheetKind; sheet: Sheet; entry: GuideRecordEntry | undefined; productions: readonly GuideProductionChapters[]; onToggle: (on: boolean) => void; onOpen: () => void }) {
  const on = entry?.public === true;
  const sections = guideSections(sheet).filter((section) => entry?.sections?.[section.heading]?.public === true).map((section) => section.heading);
  const role = roleOf(kind, sheet);
  return (
    <div className={cx("fy-guide-row", !on && "fy-guide-row--off")} data-testid={`guide-row-${sheet.id}`}>
      <button type="button" className="fy-guide-row__open" onClick={onOpen}>
        <Face world={world} kind={kind} sheet={sheet} />
        <span className="fy-guide-who">
          <b>{sheet.name}</b>
          {/* On a phone the row has no columns (234d): its second line says when it shows. */}
          <span className="fy-guide-wide">{role}</span>
          <span className="fy-guide-narrow">{!on ? "Not public" : entry.after !== undefined ? <Shows after={entry.after} productions={productions} /> : role}</span>
        </span>
        <span className="fy-guide-col fy-guide-col--ink">{on && sections.length > 0 ? sections.join(" · ") : "—"}</span>
        {kind === "characters" && <span className="fy-guide-col fy-guide-col--voice">{on && entry.voice !== undefined ? `Voice ${entry.voice.seconds !== undefined ? clock(entry.voice.seconds) : ""}`.trim() : "—"}</span>}
        <span className="fy-guide-col fy-guide-col--shows">{on ? <Shows after={entry.after} productions={productions} /> : "—"}</span>
      </button>
      <Switch checked={on} label={`${sheet.name} public`} onChange={onToggle} />
    </div>
  );
}

/** Every chapter an `after` can name, labelled as a reader counts it. */
function chapterOptions(productions: readonly GuideProductionChapters[]) {
  return productions.flatMap((production) =>
    production.chapters.map((chapter) => ({
      value: `${production.id}/${chapter.id}`,
      label: `${productions.length > 1 ? `${production.title} · ` : ""}Chapter ${chapter.number}`,
      after: { production: production.id, chapter: chapter.id },
    })),
  );
}

/** A chapter picker whose first choice is From the start. */
function AfterSelect({ label, after, productions, onChange, startLabel = "From the start" }: { label: string; after: GuideRecordAfter | undefined; productions: readonly GuideProductionChapters[]; onChange: (after: GuideRecordAfter | undefined) => void; startLabel?: string }) {
  const options = chapterOptions(productions);
  const current = after === undefined ? "" : `${after.production}/${after.chapter}`;
  return (
    <Select label={label} value={current} wrapClassName="fy-guide-after" onChange={(event) => onChange(options.find((option) => option.value === event.target.value)?.after)}>
      <option value="">{startLabel}</option>
      {current !== "" && !options.some((option) => option.value === current) && <option value={current}>Chapter removed</option>}
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  );
}

function EntryPanel({ world, worldId, open, record, productions, save, toggle, onClose }: { world: WorldBundle; worldId: string; open: NonNullable<Open>; record: GuideRecord; productions: readonly GuideProductionChapters[]; save: Save; toggle: (kind: GuideKind, id: string, on: boolean) => void; onClose: () => void }) {
  const { kind, id } = open;
  const sheet = kind === "lore" ? undefined : world.sheets.find((candidate) => candidate.type === SHEET_TYPE[kind] && candidate.id === id);
  const canon = kind === "lore" ? world.canon.find((candidate) => candidate.id === id) : undefined;
  if (sheet === undefined && canon === undefined) return null;
  const entry = record[kind][id] as GuideRecordEntry | undefined;
  const on = entry?.public === true;
  const base: GuideRecordEntry = entry ?? { public: false };
  const put = (next: GuideRecordEntry) => save(kind, id, next);
  const name = sheet?.name ?? canon!.title;
  const firstChapter = chapterOptions(productions)[0]?.after;
  return (
    <div className="fy-guide-dim" onClick={onClose}>
      <aside className="fy-guide-panel" role="dialog" aria-label={name} onClick={(event) => event.stopPropagation()} data-testid="guide-entry">
        <div className="fy-guide-pane">
          <div className="fy-guide-pane__head">
            {sheet !== undefined && kind !== "lore" && <Face world={world} kind={kind} sheet={sheet} large />}
            <div className="fy-guide-grow">
              <div className="fy-guide-eb">{KIND_LABEL[kind]} · Guide</div>
              <div className="fy-guide-ttl">{name}</div>
            </div>
            <span className="fy-guide-public">Public</span>
            <Switch checked={on} label="Public" onChange={(next) => toggle(kind, id, next)} />
            <IconButton className="fy-guide-close" label="Close" onClick={onClose}><X /></IconButton>
          </div>
          <div className="fy-guide-line">
            <b>Shows</b>
            <div className="fy-guide-shows">
              <span className="fy-guide-seg" role="radiogroup" aria-label="Shows">
                <button type="button" role="radio" aria-checked={base.after === undefined} className={cx(base.after === undefined && "on")} onClick={() => put(shownAfter(base, undefined))}>From the start</button>
                <button type="button" role="radio" aria-checked={base.after !== undefined} className={cx(base.after !== undefined && "on")} disabled={firstChapter === undefined} onClick={() => base.after === undefined && put(shownAfter(base, firstChapter))}>After a chapter</button>
              </span>
              {base.after !== undefined && <AfterSelect label="Shows after" after={base.after} productions={productions} startLabel="From the start" onChange={(after) => put(shownAfter(base, after))} />}
            </div>
          </div>
          {sheet !== undefined && (
            <div className="fy-guide-line fy-guide-line--top">
              <b>Sections</b>
              <div className="fy-guide-grow fy-guide-sections">
                {guideSections(sheet).map((section) => {
                  const choice = base.sections?.[section.heading];
                  const shown = choice?.public === true;
                  const setSection = (next: { public: boolean; after?: GuideRecordAfter }) => put({ ...base, sections: { ...base.sections, [section.heading]: next } });
                  return (
                    <div key={section.heading} className={cx("fy-guide-sec", !shown && "fy-guide-sec--off")}>
                      <div className="fy-guide-sec__h">
                        <Checkbox label={section.heading} checked={shown} onChange={(event) => setSection(shownAfter<Choice>({ public: event.target.checked }, choice?.after))} />
                        <span className="fy-guide-grow" />
                        {shown && productions.length > 0 && <AfterSelect label={`${section.heading} shows`} after={choice?.after} productions={productions} onChange={(after) => setSection(shownAfter<Choice>({ public: true }, after))} />}
                      </div>
                      <p>{section.text}</p>
                    </div>
                  );
                })}
                {guideSections(sheet).length === 0 && <span className="fy-guide-muted">No sections</span>}
              </div>
            </div>
          )}
          {canon !== undefined && (
            <div className="fy-guide-line fy-guide-line--top">
              <b>Text</b>
              <p className="fy-guide-lore">{guideLoreText(canon.body) || "Nothing before its first amendment"}</p>
            </div>
          )}
          {kind === "characters" && sheet !== undefined && (
            <div className="fy-guide-line fy-guide-line--top">
              <b>Voice</b>
              <VoiceField world={world} worldId={worldId} sheet={sheet} voice={base.voice} onChange={(voice) => {
                const { voice: _was, ...rest } = base;
                put(voice === undefined ? rest : { ...rest, voice });
              }} />
            </div>
          )}
          <div className="fy-guide-foot"><span className="fy-guide-grow" /><Button onClick={onClose}>Close</Button></div>
        </div>
        <div className="fy-guide-prev">
          <div className="fy-guide-eb">Arke Player</div>
          <PlayerEntry world={world} kind={kind} sheet={sheet} canon={canon} entry={base} productions={productions} />
        </div>
      </aside>
    </div>
  );
}

/** Plays a line straight from its take: from where the sentence starts, for as long as it lasts. */
function useLinePlayer(worldSlug: string) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const play = (key: string, line: { file: string; start: number; seconds: number }) => {
    audio.current?.pause();
    if (playing === key) {
      setPlaying(null);
      return;
    }
    const element = new Audio(mediaUrl(worldSlug, line.file));
    audio.current = element;
    const end = line.start + line.seconds;
    element.addEventListener("loadedmetadata", () => {
      element.currentTime = line.start;
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

function VoiceField({ world, worldId, sheet, voice, onChange }: { world: WorldBundle; worldId: string; sheet: Sheet; voice: GuideRecordVoice | undefined; onChange: (voice: GuideRecordVoice | undefined) => void }) {
  const [lines, setLines] = useState<GuideVoiceLine[] | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const asked = useRef<string | null>(null);
  const player = useLinePlayer(world.meta.slug);
  useEffect(() => {
    setLines(null);
    const off = subscribeGuideVoiceLines((answer) => {
      if (answer.requestId !== asked.current) return;
      setLines(answer.lines);
      setRefused(answer.refused ?? null);
    });
    asked.current = listGuideVoiceLines(worldId, sheet.id);
    return off;
  }, [worldId, sheet.id]);
  if (lines === null) return <span className="fy-guide-muted">Reading…</span>;
  if (refused !== null) return <span className="fy-guide-muted">{refused}</span>;
  const current = voice !== undefined ? lines.find((line) => sameLine(line, voice)) : undefined;
  const key = (line: GuideVoiceLine) => `${line.production}/${line.chapter}/${line.block}/${line.sentence}`;
  const meta = (line: GuideVoiceLine) => `${line.productionTitle} · Chapter ${line.chapterNumber} · ${clock(line.seconds)}`;
  const playButton = (line: GuideVoiceLine) => (
    <button type="button" className="fy-guide-play" aria-label={player.playing === key(line) ? "Stop" : "Play"} onClick={() => player.play(key(line), line)}>
      {player.playing === key(line) ? <PauseSolid size={12} /> : <PlaySolid size={12} />}
    </button>
  );
  return (
    <div className="fy-guide-grow fy-guide-voices">
      {current !== undefined ? (
        <div className="fy-guide-voice">
          {playButton(current)}
          <div className="fy-guide-grow"><div>“{current.text}”</div><div className="fy-guide-mono">{meta(current)}</div></div>
          <Button onClick={() => setChoosing(!choosing)} aria-expanded={choosing}>Change</Button>
        </div>
      ) : (
        <div className="fy-guide-voice fy-guide-voice--none">
          <span className="fy-guide-grow fy-guide-muted">{voice !== undefined ? "That line is no longer read" : lines.length === 0 ? "No lines read" : "None"}</span>
          {lines.length > 0 && <Button onClick={() => setChoosing(!choosing)} aria-expanded={choosing}>{voice !== undefined ? "Change" : "Choose"}</Button>}
        </div>
      )}
      {choosing && (
        <div className="fy-guide-lines" data-testid="guide-voice-lines">
          {lines.map((line) => (
            <div key={key(line)} className={cx("fy-guide-voice", current !== undefined && sameLine(line, current) && "fy-guide-voice--on")}>
              {playButton(line)}
              <div className="fy-guide-grow"><div>“{line.text}”</div><div className="fy-guide-mono">{meta(line)}</div></div>
              <Button onClick={() => { onChange({ production: line.production, chapter: line.chapter, block: line.block, sentence: line.sentence, seconds: line.seconds }); setChoosing(false); }}>Use</Button>
            </div>
          ))}
          {voice !== undefined && <Button variant="ghost" onClick={() => { onChange(undefined); setChoosing(false); }}>No voice line</Button>}
        </div>
      )}
    </div>
  );
}

/** The Player's page for one entry (P11d, P11e, P11g), drawn from what the entry makes public now. */
function PlayerEntry({ world, kind, sheet, canon, entry, productions }: { world: WorldBundle; kind: GuideKind; sheet: Sheet | undefined; canon: CanonEntry | undefined; entry: GuideRecordEntry; productions: readonly GuideProductionChapters[] }) {
  const gate = (after: GuideRecordAfter | undefined) => {
    const chapter = guideChapterOf(productions, after);
    return chapter === null ? null : <div className="fy-guide-phone__gate"><EyeOff size={14} />After Chapter {chapter.number}</div>;
  };
  if (canon !== undefined) {
    return (
      <div className="fy-guide-phone">
        <div className="fy-guide-phone__tx fy-guide-phone__tx--lore">
          <div className="fy-guide-eb">{LORE_LABEL[canon.type]}</div>
          <b className="fy-guide-phone__title">{canon.title}</b>
          {entry.after !== undefined && gate(entry.after)}
          <p>{guideLoreText(canon.body)}</p>
        </div>
      </div>
    );
  }
  if (sheet === undefined || kind === "lore") return null;
  const sections = guideSections(sheet).filter((section) => entry.sections?.[section.heading]?.public === true);
  const role = kind === "characters" ? roleOf(kind, sheet) : "Place";
  return (
    <div className="fy-guide-phone">
      <div className="fy-guide-phone__hero">
        <Portrait worldSlug={world.meta.slug} path={picturePath(world, kind, sheet.id)} label={sheet.name} radius={0} />
        <div className="fy-guide-phone__fade" />
        <div className="fy-guide-phone__in"><b>{sheet.name}</b><span>{[role, world.meta.name].filter(Boolean).join(" · ")}</span></div>
      </div>
      <div className="fy-guide-phone__tx">
        {entry.after !== undefined && gate(entry.after)}
        {entry.voice?.seconds !== undefined && <span className="fy-guide-phone__voice"><PlaySolid size={11} />Voice · {clock(entry.voice.seconds)}</span>}
        {sections.map((section) => {
          const after = entry.sections?.[section.heading]?.after;
          return after !== undefined ? <div key={section.heading}>{gate(after)}</div> : (
            <div key={section.heading}><div className="fy-guide-eb">{section.heading}</div><p>{section.text}</p></div>
          );
        })}
        {!entry.public && <span className="fy-guide-muted">Not public</span>}
      </div>
    </div>
  );
}

/** The whole guide as Arke Player draws a world's page (P11c): what ships, and what waits. */
function GuidePreview({ world, record, productions, listed, canon, onClose }: { world: WorldBundle; record: GuideRecord; productions: readonly GuideProductionChapters[]; listed: Record<GuideSheetKind, Sheet[]>; canon: CanonEntry[]; onClose: () => void }) {
  // World paths stand in for the package's assets; the voice is drawn by its length only.
  const guide: GuideDocument | null = guideDocument(record, {
    ...listed,
    canon,
    productions,
    picture: (kind, sheet) => picturePath(world, kind, sheet.id),
    voice: (_sheet, voice) => (voice.seconds !== undefined ? { audio: "voice", text: "—", duration: Math.round(voice.seconds * 1000), production: voice.production, chapter: voice.chapter } : undefined),
  });
  const waits = (after: { production: string; chapter: string } | null | undefined) => (guide !== null ? guideChapterNumber(guide, after) : null);
  return (
    <div className="fy-guide-dim fy-guide-dim--center" onClick={onClose}>
      <div className="fy-guide-preview" role="dialog" aria-label="Preview" onClick={(event) => event.stopPropagation()} data-testid="guide-preview-sheet">
        <div className="fy-guide-preview__bar"><span className="fy-guide-eb">Arke Player · {world.meta.name}</span><span className="fy-guide-grow" /><IconButton label="Close" onClick={onClose}><X /></IconButton></div>
        <div className="fy-guide-phone fy-guide-phone--tall">
          {guide === null ? <div className="fy-guide-phone__tx"><span className="fy-guide-muted">Nothing public</span></div> : (
            <div className="fy-guide-phone__tx">
              {guide.characters.length > 0 && <>
                <div className="fy-guide-phone__sh">Characters <span>{guide.characters.length}</span></div>
                <div className="fy-guide-phone__hrow">
                  {guide.characters.map((entry) => {
                    const number = waits(entry.after);
                    return number !== null ? (
                      <div key={entry.id} className="fy-guide-pc fy-guide-pc--gated"><span className="fy-guide-pc__im"><EyeOff size={20} /></span><b>After Chapter {number}</b><span>Character</span></div>
                    ) : (
                      <div key={entry.id} className="fy-guide-pc"><span className="fy-guide-pc__im">{entry.portrait !== undefined && <Portrait worldSlug={world.meta.slug} path={entry.portrait} label={entry.name} radius={8} loading="lazy" />}</span><b>{entry.name}</b><span>{entry.role ?? ""}</span></div>
                    );
                  })}
                </div>
              </>}
              {guide.places.length > 0 && <>
                <div className="fy-guide-phone__sh">Places <span>{guide.places.length}</span></div>
                <div className="fy-guide-phone__hrow">
                  {guide.places.map((entry) => {
                    const number = waits(entry.after);
                    return (
                      <div key={entry.id} className={cx("fy-guide-pc fy-guide-pc--wide", number !== null && "fy-guide-pc--gated")}>
                        <span className="fy-guide-pc__im">{number !== null ? <EyeOff size={20} /> : entry.picture !== undefined && <Portrait worldSlug={world.meta.slug} path={entry.picture} label={entry.name} radius={8} loading="lazy" />}</span>
                        <b>{number !== null ? `After Chapter ${number}` : entry.name}</b>
                      </div>
                    );
                  })}
                </div>
              </>}
              {guide.lore.length > 0 && <>
                <div className="fy-guide-phone__sh">Lore <span>{guide.lore.length}</span></div>
                {guide.lore.map((entry) => {
                  const number = waits(entry.after);
                  return number !== null ? (
                    <div key={entry.id} className="fy-guide-lr"><EyeOff size={14} /><span className="fy-guide-grow fy-guide-muted">After Chapter {number}</span><span className="fy-guide-reveal">Reveal</span></div>
                  ) : (
                    <div key={entry.id} className="fy-guide-lr"><span className="fy-guide-grow"><span className="fy-guide-eb">{LORE_LABEL[entry.kind]}</span><b>{entry.title}</b></span></div>
                  );
                })}
              </>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
