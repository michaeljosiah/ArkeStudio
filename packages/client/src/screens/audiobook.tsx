import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import {
  CADENCE_NOTE_MAX,
  CADENCE_PHRASE_MAX,
  DEFAULT_NARRATOR,
  SPEECH_TOKEN_ESTIMATE,
  freePlanAskCopy,
  freePlanNote,
  formatMicroUsd,
  characterLabels,
  formatRunningTime,
  mainPhotoFor,
  narratorLabelFor,
  providerName,
  readerPlace,
  speechPricePrefix,
  type AudiobookCastMember,
  type AudiobookDoor,
  type AudiobookPriceLine,
  type AudiobookRow,
  type ManifestModel,
  type ProductionBundle,
  type WorldBundle,
} from "@arke-studio/contracts";
import { useMediaQuery } from "../lib/media-query.js";
import { mediaUrl } from "../lib/media.js";
import { NarratorDialog } from "./audiobook-narrator.js";
import { BookRequests, NoteRow, SpeakerNoteInput } from "./chapter-audiobook.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { ChevronLeft, ChevronRight, More, PlaySolid, Waveform, X } from "../components/icons.js";
import { Portrait } from "../components/portrait.js";
import { EmptyState } from "../components/layout.js";
import { AudiobookPlayerView, audiobookPlaceKey, bookHasTakes } from "../components/audiobook-player.js";
import { AudiobookExportSheet } from "../components/audiobook-export.js";
import { useDockHost } from "../components/player.js";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";
import { Button, cx } from "../components/ui.js";
import { useProduction } from "../lib/selectors.js";
import {
  dismissAudiobookBook,
  dismissAudiobookNote,
  draftAudiobookSpeakerNotes,
  openAudiobook,
  readAudiobookBook,
  requestVoiceCatalogue,
  setAudiobookReading,
  setAudiobookReadingNote,
  stopAudiobookBook,
  subscribeVoiceUploadConfirmations,
  useAudiobookAsks,
  useAudiobookBooks,
  useAudiobookDoors,
  useAudiobookNotes,
  useAudiobookRuns,
  useStore,
} from "../lib/store.js";

/**
 * The Audiobook page (design turn 199, SPEC-047): a show page, for listening. The world's key art
 * as a backdrop under the title and one meta line; `Continue · Chapter 1 · 12:40` (or `Listen`),
 * `Export`, `Read the book` while something is left to read, and ⋯; the cast as portraits; the
 * chapters as episodes. What sets the reading up — the reading, the narrator, the speakers' voices
 * and notes, the book note, the requests — is the Reading sheet behind ⋯, never the page. The
 * rows, voices and price are the coordinator's answer to `open-audiobook`, asked again whenever the
 * book changes under it (turn 146).
 */

type DoorProduction = { chapters: readonly { id: string; order: number; title: string; version: number; bodyHash?: string; retired?: boolean; audiobook?: unknown }[]; audiobook?: { narrator?: { provider: string; voiceId: string } } };
type DoorWorld = { sheets: readonly { id: string; voice?: { provider: string; voiceId: string } }[] };

/**
 * What the door's answer depends on, as one string: asked again when it moves. The chapters'
 * title and order are in it as their version and hash are (codex on PR 1187): a rename or a
 * reorder is frontmatter alone, and the spoken heading — and so a row and its price — follows
 * it. So are the readers (codex on PR 1187, round three): the app's narrator, every sheet's
 * voice, and whether the catalogue says each can speak now, since another window changing any
 * of them changes who reads, what stands in for whom, and what a press would spend. Only the
 * book's readers, and only as the last catalogue answered them: the whole catalogue, null
 * while asked again, moved this on every refresh, and the door was asked again each time
 * (UI audit A1). The chapters' runs ending, the record's writes, the book's run and its note
 * move the rows too — not a block at a time while a chapter is read, when the rows read the
 * run's own counts (codex on PR 1187).
 */
export function useAudiobookDoorStamp(worldId: string | undefined, prodId: string | undefined, production: DoorProduction | null, world: DoorWorld | null): string {
  const store = useStore();
  const narrator = store.state?.app.narrator ?? null;
  const catalogue = store.voiceCatalogueHeld;
  const book = store.audiobookBook[prodId ?? ""];
  const note = store.audiobookNotes[prodId ?? ""];
  if (production === null) return "";
  const prefix = `${worldId}/${prodId}/`;
  const sheets = world?.sheets ?? [];
  const readers = new Set(
    [narrator, production.audiobook?.narrator, DEFAULT_NARRATOR, ...sheets.map((sheet) => sheet.voice)]
      .filter((reader) => reader !== null && reader !== undefined)
      .map((reader) => `${reader.provider}\n${reader.voiceId}`),
  );
  return JSON.stringify([
    production.audiobook ?? null,
    production.chapters.map((c) => [c.id, c.order, c.title, c.version, c.bodyHash ?? "", c.retired === true, c.audiobook ?? null]),
    narrator,
    sheets.map((sheet) => [sheet.id, sheet.voice ?? null]),
    catalogue === null
      ? null
      : catalogue
          .filter((voice) => readers.has(`${voice.provider}\n${voice.voiceId}`))
          .map((voice) => [voice.provider, voice.model, voice.voiceId, voice.unavailableReason ?? null].join("\n"))
          .sort(),
    Object.entries(store.audiobook).filter(([key]) => key.startsWith(prefix)).map(([key, run]) => [key, run.state]),
    Object.entries(store.audiobookRecords).filter(([key]) => key.startsWith(prefix)).map(([, held]) => held.seq),
    book?.state ?? null,
    note?.seq ?? null,
  ]);
}

/**
 * The door asked for, by the rail and the page alike: both ask on the one stamp, so the store
 * sends one ask between them and holds a newer one until it is answered. Not asked while a
 * chapter is being read and a door is held — the rows read the run's counts; it is asked once
 * more as the run ends — and always when this window holds no door yet, as one that joins a
 * run going elsewhere does not (codex on PR 1187).
 */
export function useAudiobookDoorAsk(worldId: string | undefined, prodId: string | undefined, production: DoorProduction | null, world: DoorWorld | null, enabled = true): void {
  const connection = useStore().connection;
  const stamp = useAudiobookDoorStamp(worldId, prodId, production, world);
  const door = useAudiobookDoors()[prodId ?? ""]?.door ?? null;
  const chapterReading = useChapterReading(worldId, prodId);
  useEffect(() => {
    if (!enabled || !worldId || !prodId || production === null || connection !== "open" || (chapterReading && door !== null)) return;
    openAudiobook(worldId, prodId, stamp);
  }, [enabled, worldId, prodId, production === null, connection, chapterReading, door === null, stamp]);
}

/**
 * Whether the book, or any chapter of it, is being read in this window's sight: the seg holds
 * while it is, since a reading switched under a run would leave every take the run files
 * stale (codex on PR 1187).
 */
export function useAudiobookReading(worldId: string | undefined, prodId: string | undefined): boolean {
  const book = useAudiobookBooks()[prodId ?? ""];
  const chapter = useChapterReading(worldId, prodId);
  return book?.state === "reading" || chapter;
}

/**
 * Whether a chapter of the production is being read. While one is, the rows read the run's
 * own counts and the door is not asked again for every take that lands — each ask prepares
 * the whole book, and a long book read block by block would ask once a block (codex on PR
 * 1187); it is asked once more as each chapter's run ends, so a book read chapter by chapter
 * shows each chapter read as it is.
 */
export function useChapterReading(worldId: string | undefined, prodId: string | undefined): boolean {
  const runs = useAudiobookRuns();
  return Object.entries(runs).some(([key, run]) => key.startsWith(`${worldId}/${prodId}/`) && run.state === "reading");
}

// ---- what the page says, as data ---------------------------------------------------------------

/**
 * A chapter's length (rule 3): the made takes' running time, and the rest estimated from the
 * words at the narrator's rate. A chapter whose made takes are not all measured yet is
 * estimated whole, from its words.
 */
export function chapterSeconds(row: Pick<AudiobookRow, "planned" | "total" | "made" | "seconds">, words: number): number {
  if (row.planned) return 0;
  const rate = SPEECH_TOKEN_ESTIMATE.wordsPerMinute / 60;
  if (row.seconds === null || row.total === 0) return words / rate;
  return row.seconds + (words * (row.total - row.made)) / row.total / rate;
}

/** `23 min`, or `1 h 12 m` from an hour (186's `6 h 12 m left`). */
export function formatBookLength(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

/** A chapter titled only with its number is named once (192): `Chapter 1`, else `2 · Untitled`. */
export function chapterHeading(row: Pick<AudiobookRow, "order" | "title">): string {
  const own = /^chapter\s+0*(\d+)$/i.exec(row.title.trim());
  if (own !== null && Number(own[1]) === row.order) return `Chapter ${row.order}`;
  return `${row.order} · ${row.title.trim() === "" ? "Untitled" : row.title}`;
}

/**
 * One quiet word, only when the chapter is not simply ready (rule 7): `planned`, `not read`,
 * `80 to read`, `reading…`; the cast's trouble under Cast by its first words. Nothing for a
 * chapter read whole.
 */
export function chapterStateWord(row: AudiobookRow, reading: boolean): string | null {
  if (reading) return "reading…";
  if (row.planned) return "planned";
  if (row.castTrouble !== undefined) return row.castTrouble.split(" · ")[0]!;
  const left = row.stale + row.flagged + row.notMade;
  if (row.made === 0 && left > 0) return "not read";
  if (left > 0) return `${left} to read`;
  if ((row.awaiting ?? 0) > 0) return `${row.awaiting} awaiting`;
  return null;
}

/**
 * The reading's one warning word (rule 5): under Cast, the speakers with no voice, else those
 * whose voice cannot speak now, else the lines nobody is cast for — counted, never named on the
 * page. Named row by row in the Reading sheet.
 */
export function readingWarning(door: Pick<AudiobookDoor, "reading" | "voices" | "unattributed"> | null): string | null {
  if (door === null || door.reading !== "cast") return null;
  const speakers = door.voices.slice(1);
  const none = speakers.filter((voice) => voice.state === "no voice").length;
  if (none > 0) return `${none} no voice`;
  const unavailable = speakers.filter((voice) => voice.state === "voice unavailable").length;
  if (unavailable > 0) return `${unavailable} unavailable`;
  if (door.unattributed > 0) return `${door.unattributed} unattributed`;
  return null;
}

/** Where the player keeps this device's place in the book (R-71), as the player wrote it. */
export function keptPlace(worldId: string, productionId: string): { chapterId: string; at: number } | null {
  try {
    const kept = JSON.parse(window.localStorage.getItem(audiobookPlaceKey(worldId, productionId)) ?? "null") as { place?: { chapterId?: unknown; at?: unknown } } | null;
    const place = kept?.place;
    if (place === undefined || typeof place.chapterId !== "string") return null;
    return { chapterId: place.chapterId, at: typeof place.at === "number" && Number.isFinite(place.at) ? Math.max(0, place.at) : 0 };
  } catch {
    // No storage here, or a place nobody can read: Listen, as on a first visit.
    return null;
  }
}

/** A picture for a sheet: its main photo, else its first look. */
function sheetPicture(world: WorldBundle | null, sheetId: string, prefer: "photo" | "look"): string | null {
  const kit = world?.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  if (kit === undefined) return null;
  const photo = mainPhotoFor(kit)?.file ?? null;
  const look = kit.looks?.[0]?.file ?? null;
  const file = prefer === "look" ? (look ?? photo) : (photo ?? look);
  return file === null ? null : `references/${sheetId}/${file}`;
}

/**
 * The narrator's picture (rule 6): a voice designed from a sheet — the sheet whose voice it is —
 * shows that sheet's look, so the narrator and the character are not the same picture twice; a
 * catalogue voice shows the backdrop.
 */
function narratorPicture(world: WorldBundle | null, door: AudiobookDoor, production: ProductionBundle, appNarrator: { provider: string; voiceId: string } | null, art: string | null): string | null {
  const narrator = door.voices[0];
  const reader = narrator?.book === true ? production.audiobook?.narrator : (appNarrator ?? DEFAULT_NARRATOR);
  // A narrator the coordinator stood another voice in for is that other voice: no sheet's look.
  if (reader !== undefined && narrator?.voice?.provider === reader.provider) {
    const sheet = world?.sheets.find((candidate) => candidate.voice?.provider === reader.provider && candidate.voice.voiceId === reader.voiceId);
    if (sheet !== undefined) {
      const picture = sheetPicture(world, sheet.id, "look");
      if (picture !== null) return picture;
    }
  }
  return art;
}

function priceLineWords(line: AudiobookPriceLine, models: readonly ManifestModel[] | undefined): { who: string; how: string; cost: string; warn: boolean } {
  const cost = `${line.characters.toLocaleString()} · ${line.estimatedMicroUsd === 0 ? "free" : `${speechPricePrefix(models, [line.provider])}${formatMicroUsd(line.estimatedMicroUsd)}`}`;
  if (line.speaker !== undefined) {
    // The narrator stands in (R-12): said as the speaker, and — when that narrator is a cloud
    // voice — the vendor the speaker's words go to, named here as on every paid line (codex on PR 1187).
    return { who: line.speaker, how: `${line.substituted ?? "no voice"} · narrator${line.local ? "" : ` · ${readerPlace(line.provider, false)}`}`, cost, warn: true };
  }
  // The provider as a name and a place, never its id (turn 165): `Kokoro · this machine`.
  return { who: line.label, how: `${line.narrator === true ? "narrator · " : ""}${readerPlace(line.provider, line.local)}`, cost, warn: false };
}

const READINGS = [
  ["narrator", "Narrator"],
  ["performed", "Performed"],
  ["cast", "Cast"],
] as const;

export function AudiobookScreen() {
  const phone = useMediaQuery("(max-width: 599px)");
  const { prodId, worldId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const connection = useStore().connection;
  const held = useAudiobookDoors()[prodId ?? ""];
  const door = held?.door ?? null;
  const book = useAudiobookBooks()[prodId ?? ""];
  const note = useAudiobookNotes()[prodId ?? ""];
  const runs = useAudiobookRuns();
  const running = useAudiobookReading(worldId, prodId);
  useAudiobookDoorAsk(worldId, prodId, production, world);
  // The catalogue says who can speak now (turn 130's rule): asked for once the door is open,
  // and again as the engines come and go — the local runtime, the studio's ComfyUI — so a
  // voice gone unavailable, or back, moves the voices and the price (codex on PR 1187).
  // As they come and go, not as they are checked: each probe stamps its time, and asking the
  // catalogue on every probe asked every keyed vendor for its voices every few seconds.
  const app = useStore().state?.app;
  const engines = JSON.stringify([
    app?.runtime === null || app?.runtime === undefined ? null : { ...app.runtime, detectedAt: undefined },
    app?.comfyui === null || app?.comfyui === undefined ? null : { ...app.comfyui, checkedAt: undefined },
  ]);
  useEffect(() => {
    if (connection === "open") requestVoiceCatalogue(worldId);
  }, [connection, worldId, engines]);
  // The book's narrator (R-46, 165c): from the ⋯ menu, the narrator's card and the sheet's row.
  const [narrating, setNarrating] = useState(false);
  // Reading (199e): everything that sets the reading up, in one sheet.
  const [sheet, setSheet] = useState(false);
  const [menu, setMenu] = useState(false);
  const [barMenu, setBarMenu] = useState(false);
  // The player (186): `{}` opens the book where this device left it, a chapter starts there.
  const [listening, setListening] = useState<{ chapterId?: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  // A phone's bar over the page once the hero has scrolled away (199f).
  const [scrolled, setScrolled] = useState(false);
  const dock = useRef<HTMLDivElement>(null);
  const art = world?.keyArt ?? null;
  const slug = world?.meta.slug;
  const hasArt = art !== null && art !== "" && slug !== undefined;
  const rows: AudiobookRow[] = door?.rows ?? [];
  const place = worldId !== undefined && prodId !== undefined ? keptPlace(worldId, prodId) : null;
  // The docked player's picture: the chapter this device is in, else the book's first, else the cover.
  const dockFile = rows.find((row) => row.chapterId === place?.chapterId)?.picture ?? rows.find((row) => row.picture !== undefined)?.picture ?? (hasArt ? art : null);
  useDockHost(dock, dockFile !== null && slug !== undefined ? mediaUrl(slug, dockFile) : null, () => setListening({}));

  // A cloned voice's recording leaving the machine (SPEC-022, SPEC-046): asked under the book's request, the answer kept for the price's answer and spent with the run (codex on PR 1180).
  const [upload, setUpload] = useState<{ destination: string; token: string; notice?: string } | null>(null);
  const uploadAllowed = useRef<string | null>(null);
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== book?.requestId) return;
        setUpload({ destination: confirmation.destinationLabel, token: confirmation.confirmationToken, ...(confirmation.destinationNotice !== undefined ? { notice: confirmation.destinationNotice } : {}) });
      }),
    [book?.requestId],
  );
  const ended = book !== undefined && book.state !== "reading" && book.state !== "priced";
  useEffect(() => {
    if (ended) uploadAllowed.current = null;
  }, [ended]);
  useEffect(() => {
    uploadAllowed.current = null;
  }, [prodId]);
  const send = useCallback(
    (options: { confirmationToken?: string; voiceUploadConfirmedFor?: string } = {}) => {
      if (!worldId || !prodId) return;
      const consent = options.voiceUploadConfirmedFor ?? uploadAllowed.current ?? undefined;
      readAudiobookBook(worldId, prodId, {
        ...(options.confirmationToken !== undefined ? { confirmationToken: options.confirmationToken } : {}),
        ...(consent !== undefined ? { voiceUploadConfirmedFor: consent } : {}),
      });
    },
    [worldId, prodId],
  );
  const begin = () => {
    if (book?.state === "reading" || book?.state === "priced") return;
    setUpload(null);
    uploadAllowed.current = null;
    send();
  };

  if (!worldId || !prodId || production === null) return null;
  const title = production.meta.title;
  const chapters = production.chapters.filter((chapter) => !chapter.retired);
  const reading = door?.reading ?? production.audiobook?.reading ?? "narrator";
  const readingNow = book?.state === "reading";
  const price = door?.price ?? null;
  // `up to` while every reader is priced by the character; a token reader's share is an
  // estimate the read can pass, so the whole figure is `~` (SPEC-049 R-6).
  const priceWord = speechPricePrefix(app?.manifest?.models, (price?.voices ?? []).map((voice) => voice.provider));
  const cost = price === null || price.estimatedMicroUsd === 0 ? null : `${priceWord}${formatMicroUsd(price.estimatedMicroUsd)}`;
  const narratorName = door?.voices[0]?.name ?? null;
  const warning = readingWarning(door);
  const made = bookHasTakes(production);
  const left = price !== null && price.chapters > 0;
  const words = (chapterId: string) => chapters.find((chapter) => chapter.id === chapterId)?.words ?? 0;

  // Each chapter as the page states it: a row whose run has ended reads as its run ended until
  // the door answers again (codex on PR 1187) — every block not made was tried (R-16).
  const shown = rows.map((row) => {
    const run = runs[`${worldId}/${prodId}/${row.chapterId}`];
    const settled = run !== undefined && run.state !== "reading" && run.state !== "priced" && run.made + run.flagged > 0 && !row.planned && row.castTrouble === undefined
      ? { ...row, made: Math.min(row.total, row.made + run.made), stale: 0, flagged: run.flagged, notMade: Math.max(0, row.total - row.made - run.made - run.flagged) }
      : row;
    return { row: settled, reading: run?.state === "reading", run };
  });
  const bookSeconds = shown.reduce((sum, { row }) => sum + chapterSeconds(row, words(row.chapterId)), 0);
  // One meta line (rule 3): every chapter, planned ones included; the length; who reads it.
  const meta = [
    "Audiobook",
    `${door === null ? chapters.length : rows.length} chapter${(door === null ? chapters.length : rows.length) === 1 ? "" : "s"}`,
    ...(door !== null && bookSeconds > 0 ? [formatBookLength(bookSeconds)] : []),
    ...(narratorName !== null ? [`Read by ${narratorName}`] : []),
  ].join(" · ");

  // Continue (186's word and kept place) when this device holds a place in a chapter that plays.
  const placeRow = place === null ? undefined : rows.find((row) => row.chapterId === place.chapterId && row.made > 0);
  const listen = (chapterId?: string) => setListening(chapterId === undefined ? {} : { chapterId });
  const openChapter = (chapterId: string) => navigate(`/w/${worldId}/p/${prodId}/story/chapters/${encodeURIComponent(chapterId)}?view=audiobook`);

  const primary = made ? (
    <button
      type="button"
      className="fy-abshow__btn fy-abshow__btn--pri"
      disabled={connection !== "open"}
      onClick={() => listen(placeRow?.chapterId)}
      data-testid="audiobook-listen"
    >
      <PlaySolid size={16} />
      {placeRow !== undefined && place !== null ? (
        <>
          Continue <em>· Chapter {placeRow.order} · {formatRunningTime(place.at)}</em>
        </>
      ) : (
        "Listen"
      )}
    </button>
  ) : null;
  // Export (186e) once a block anywhere is made. What is whole is the listening plan's to say, by
  // the words (codex on PR 1498): a chapter the door calls stale after a narrator changed still
  // says its words, and still goes in — the sheet counts it.
  const exportPress = made ? (
    <button type="button" className="fy-abshow__btn" onClick={() => setExporting(true)} data-testid="audiobook-export-open">
      Export
    </button>
  ) : null;
  // Read the book's place (rule 4): the consent the vendor asks, the run while the book reads, or
  // the press while something is left — absent, not disabled, when nothing is.
  const readSlot: ReactNode = (() => {
    if (upload !== null && book?.state !== "read") {
      return (
        <div className="fy-abshow__consent" style={{ flexBasis: "100%" }}>
          <RemoteVoiceUploadConfirmation
            destinationLabel={upload.destination}
            destinationNotice={upload.notice}
            onCancel={() => {
              setUpload(null);
              uploadAllowed.current = null;
              dismissAudiobookBook(prodId);
            }}
            onConfirm={() => {
              uploadAllowed.current = upload.token;
              setUpload(null);
              send({ voiceUploadConfirmedFor: upload.token });
            }}
          />
        </div>
      );
    }
    if (readingNow) {
      return (
        <span className="fy-abshow__run" data-testid="audiobook-run">
          reading… {book.done} of {book.chapters} chapter{book.chapters === 1 ? "" : "s"}
          <button type="button" className="fy-abshow__btn" onClick={() => stopAudiobookBook(worldId, prodId)}>
            Stop
          </button>
        </span>
      );
    }
    if (!left) return null;
    return (
      <button
        type="button"
        className={cx("fy-abshow__btn", !made && "fy-abshow__btn--pri", phone && made && "fy-abshow__btn--grow")}
        disabled={connection !== "open" || book?.state === "priced"}
        onClick={begin}
        data-testid="read-book"
      >
        {!made && <PlaySolid size={16} />}
        Read the book
        {phone ? (cost !== null ? <em> · {cost}</em> : null) : <em> · {price.chapters} chapter{price.chapters === 1 ? "" : "s"}{cost !== null ? ` · ${cost}` : ""}</em>}
        {!phone && warning !== null && <span className="fy-abshow__w"> · {warning}</span>}
      </button>
    );
  })();
  const menuItems = [
    { label: "Reading", data: [READINGS.find(([value]) => value === reading)![1]], warn: warning, onPress: () => setSheet(true), testId: "menu-reading" },
    ...(narratorName !== null ? [{ label: "Narrator", data: [narratorName], warn: null, onPress: () => setNarrating(true), testId: "menu-narrator" }] : []),
    // A world with no art: its cover is made where the world's look is (190).
    ...(!hasArt ? [{ label: "Make a cover", data: [], warn: null, onPress: () => navigate(`/w/${worldId}/art-direction`), testId: "menu-cover" }] : []),
  ];
  const more = <MoreMenu open={menu} onOpen={setMenu} dot={phone && warning !== null} items={menuItems} />;
  // The presses in one wrapping row, never clipped (rule 2): desktop leads with the primary, then
  // Export, then Read the book; a phone puts the primary full width under the thumb.
  const presses = phone ? [primary, readSlot, exportPress, more] : [primary, exportPress, readSlot, more];

  const bookNote =
    book?.state === "stopped"
      ? "stopped · the takes made stand"
      : book?.state === "failed" || book?.state === "unavailable"
        ? freePlanNote(book.reason) ?? `could not read · ${book.reason ?? "the run failed"}`
        : book?.state === "read" && book.chaptersRefused > 0
          ? book.chaptersRefused === 1
            ? "1 chapter left to its row"
            : `${book.chaptersRefused} chapters left to their rows`
          : null;

  const narratorCard = door !== null && door.voices[0] !== undefined ? door.voices[0] : null;
  const cast: AudiobookCastMember[] = door?.cast ?? (door?.voices.slice(1).map((voice) => ({ ...(voice.sheet !== undefined ? { sheet: voice.sheet } : {}), name: voice.name })) ?? []);

  return (
    <div className="fy-prodmain fy-abshow" data-screen="audiobook">
      <div
        className="fy-abshow__page"
        // Past the title, the bar takes over the back press and ⋯.
        onScroll={phone ? (event) => setScrolled(event.currentTarget.scrollTop > 200) : undefined}
      >
        <section className={cx("fy-abshow__hero", !hasArt && "fy-abshow__hero--bare")} aria-label="Audiobook" data-art={hasArt ? "true" : "false"} data-testid="audiobook-hero">
          {hasArt && (
            <span className="fy-abshow__bd" aria-hidden="true">
              <Portrait worldSlug={slug} path={art} label="" radius={0} />
            </span>
          )}
          {phone && (
            <button type="button" className="fy-abshow__ptop" aria-label="Back" onClick={() => navigate(`/w/${worldId}/p/${prodId}`)}>
              <ChevronLeft size={20} stroke={1.9} />
            </button>
          )}
          <div className="fy-abshow__wrap">
            <h1 className="fy-abshow__title">{title}</h1>
            <div className="fy-abshow__meta" data-testid="audiobook-line">{meta}</div>
            <div className="fy-abshow__acts" data-testid="audiobook-presses">
              {presses.map((press, index) => (press === null ? null : <Fragment key={index}>{press}</Fragment>))}
            </div>
            {(bookNote !== null || note !== undefined) && (
              <div className="fy-abshow__note" data-testid="audiobook-note">
                {bookNote !== null && (
                  <span className={cx(book?.state !== "read" && "fy-abshow__warn")}>
                    {bookNote}
                    <button type="button" aria-label="Put away" onClick={() => dismissAudiobookBook(prodId)}>
                      ×
                    </button>
                  </span>
                )}
                {note !== undefined && (
                  <span>
                    {[...(note.held > 0 ? [`${note.held} held`] : []), ...(note.dropped > 0 ? [`${note.dropped} dropped`] : [])].join(" · ")} · {note.chapters} chapter{note.chapters === 1 ? "" : "s"}
                    <button type="button" aria-label="Put away" onClick={() => dismissAudiobookNote(prodId)}>
                      ×
                    </button>
                  </span>
                )}
              </div>
            )}
          </div>
        </section>
        <div className="fy-abshow__wrap fy-abshow__body">
          {narratorCard !== null && (
            <section aria-label="Cast">
              <h2 className="fy-abshow__h">Cast</h2>
              <CastRow>
                <CastCard
                  name={narratorCard.name}
                  role="Narrator"
                  slug={slug}
                  picture={narratorPicture(world, door!, production, app?.narrator ?? null, hasArt ? art : null)}
                  onPress={() => setNarrating(true)}
                />
                {cast.map((member) => (
                  <CastCard
                    key={member.sheet ?? `:${member.name}`}
                    name={member.name}
                    slug={slug}
                    picture={member.sheet === undefined ? null : sheetPicture(world, member.sheet, "photo")}
                    {...(member.sheet !== undefined ? { onPress: () => navigate(`/w/${worldId}/cast/${encodeURIComponent(member.sheet!)}`) } : {})}
                  />
                ))}
              </CastRow>
            </section>
          )}
          <section className="fy-abshow__chapters" aria-label="Chapters">
            <h2 className="fy-abshow__h">Chapters</h2>
            {rows.length > 0 ? (
              <div data-testid="audiobook-rows">
                {shown.map(({ row, reading: chapterReading, run }) => {
                  const state = chapterReading && run !== undefined ? `reading… ${run.made} of ${run.toMake}` : chapterStateWord(row, false);
                  const seconds = chapterSeconds(row, words(row.chapterId));
                  const synopsis = chapters.find((chapter) => chapter.id === row.chapterId)?.synopsis;
                  const playable = row.made > 0;
                  // Against the made takes' time, which is what plays; where that is not measured, the
                  // length the row says — the bar went missing beside "Continue · Chapter 1" when it was null.
                  const heardOf = row.seconds !== null && row.seconds > 0 ? row.seconds : seconds;
                  const heard = place !== null && place.chapterId === row.chapterId && heardOf > 0 ? Math.min(100, (place.at / heardOf) * 100) : null;
                  const thumb = row.planned ? null : (row.picture ?? (hasArt ? art : null));
                  const heading = chapterHeading(row);
                  return (
                    <div key={row.chapterId} className="fy-abshow__ep" data-testid="audiobook-row" data-state={state ?? "ready"}>
                      <button
                        type="button"
                        className="fy-abshow__ep-main"
                        aria-label={playable ? `Play ${heading}` : `Open ${heading}`}
                        onClick={() => (playable ? listen(row.chapterId) : openChapter(row.chapterId))}
                      >
                        {row.planned || thumb === null ? (
                          <span className={cx("fy-abshow__th", row.planned && "fy-abshow__th--none")} aria-hidden="true">{row.planned ? row.order : null}</span>
                        ) : (
                          <span className="fy-abshow__th" aria-hidden="true">
                            <Portrait worldSlug={slug} path={thumb} label="" radius={0} loading="lazy" />
                            {playable && <span className="fy-abshow__pl"><span><PlaySolid size={20} /></span></span>}
                            {heard !== null && <span className="fy-abshow__pb"><i style={{ width: `${heard}%` }} /></span>}
                          </span>
                        )}
                        <span className="fy-abshow__tx">
                          <span className="fy-abshow__nm">{heading}</span>
                          <span className="fy-abshow__m">
                            {seconds > 0 && <span className="fy-abshow__d">{formatBookLength(seconds)}</span>}
                            {state !== null && <span className="fy-abshow__st" data-testid="audiobook-row-state">{state}</span>}
                          </span>
                        </span>
                        {synopsis !== undefined && synopsis.trim() !== "" && <span className="fy-abshow__syn">{synopsis}</span>}
                      </button>
                      <button type="button" className="fy-abshow__go" aria-label={`Open ${heading}`} title="Open" onClick={() => openChapter(row.chapterId)} data-testid="audiobook-row-open">
                        <ChevronRight size={16} stroke={1.9} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState title={door === null ? (held?.refused ?? "Opening…") : "No chapters yet"} />
            )}
          </section>
        </div>
      </div>
      {phone && scrolled && (
        <div className="fy-abshow__pbar" data-testid="audiobook-pbar">
          <button type="button" aria-label="Back" onClick={() => navigate(`/w/${worldId}/p/${prodId}`)}>
            <ChevronLeft size={20} stroke={1.9} />
          </button>
          <span>{title}</span>
          <MoreMenu open={barMenu} onOpen={setBarMenu} dot={warning !== null} items={menuItems} bare />
        </div>
      )}
      {/* The player's place in the page's flow (rule 9): it docks here, under the page's scroll. */}
      <div ref={dock} className="fy-abshow__dock" />
      {sheet && (
        <ReadingSheet
          worldId={worldId}
          productionId={prodId}
          production={production}
          door={door}
          reading={reading}
          running={running}
          onNarrator={() => setNarrating(true)}
          {...(phone && world !== null ? { labels: characterLabels(world.sheets) } : {})}
          onClose={() => setSheet(false)}
        />
      )}
      {narrating && door !== null && (
        <NarratorDialog
          worldId={worldId}
          productionId={prodId}
          narratorLabel={door.voices[0]?.name ?? DEFAULT_NARRATOR.label}
          {...(production.audiobook?.narrator !== undefined ? { bookNarrator: production.audiobook.narrator } : {})}
          appLabel={narratorLabelFor(app?.narrator ?? null, world?.meta.worldId)}
          {...(app?.narrator ? { appProvider: app.narrator.provider } : {})}
          castProviders={door.voices.filter((voice) => voice.state === "reads" && voice.voice !== undefined).map((voice) => voice.voice!.provider)}
          trial={door.rows[0] !== undefined ? { chapterFile: door.rows[0].file, block: "title" } : null}
          slug={slug}
          data={meta}
          onClose={() => setNarrating(false)}
        />
      )}
      {listening !== null && <AudiobookPlayerView worldId={worldId} production={production} {...(listening.chapterId !== undefined ? { chapterId: listening.chapterId } : {})} onClose={() => setListening(null)} />}
      {exporting && <AudiobookExportSheet worldId={worldId} production={production} onClose={() => setExporting(false)} />}
      {book?.state === "priced" && book.price !== undefined && (
        <BookPriceSheet
          price={book.price}
          onClose={() => dismissAudiobookBook(prodId)}
          onConfirm={() => send({ confirmationToken: book.price!.confirmationToken })}
        />
      )}
    </div>
  );
}

/** The ⋯ press and its menu (199d): each entry its label, its data and, for Reading, the warning word. */
function MoreMenu({ open, onOpen, dot, items, bare = false }: {
  open: boolean;
  onOpen: (open: boolean) => void;
  dot: boolean;
  items: ReadonlyArray<{ label: string; data: readonly string[]; warn: string | null; onPress: () => void; testId: string }>;
  /** The phone's bar draws the press plain, on the page's colours. */
  bare?: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (box.current !== null && !box.current.contains(event.target as Node)) onOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open, onOpen]);
  return (
    <span ref={box} className="fy-abshow__more">
      <button
        type="button"
        className={cx(!bare && "fy-abshow__btn fy-abshow__btn--ic", !bare && open && "fy-abshow__btn--on")}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
        data-testid={bare ? "audiobook-bar-more" : "audiobook-more"}
      >
        <More size={18} stroke={2.4} />
        {dot && <i className="fy-abshow__dot" data-testid="audiobook-more-dot" />}
      </button>
      {open && (
        <div className="fy-abshow__menu" role="menu" aria-label="More">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              data-testid={item.testId}
              onClick={() => {
                onOpen(false);
                item.onPress();
              }}
            >
              <span>{item.label}</span>
              {item.data.map((value) => <em key={value}>{value}</em>)}
              {item.warn !== null && <em className="fy-abshow__w">{item.warn}</em>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** The cast's row: more cards than fit scroll sideways, with arrows on hover (rule 6). */
function CastRow({ children }: { children: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null);
  const step = (direction: 1 | -1) => {
    const element = strip.current;
    if (element !== null) element.scrollBy?.({ left: direction * element.clientWidth * 0.8, behavior: "smooth" });
  };
  return (
    <div className="fy-abshow__castwrap">
      <div ref={strip} className="fy-abshow__cast" data-testid="audiobook-cast">
        {children}
      </div>
      <button type="button" className="fy-abshow__arrow fy-abshow__arrow--prev" aria-label="Earlier in the cast" tabIndex={-1} onClick={() => step(-1)}>
        <ChevronLeft size={16} stroke={1.9} />
      </button>
      <button type="button" className="fy-abshow__arrow fy-abshow__arrow--next" aria-label="Later in the cast" tabIndex={-1} onClick={() => step(1)}>
        <ChevronRight size={16} stroke={1.9} />
      </button>
    </div>
  );
}

/** A portrait and a name, and nothing else (rule 6); the narrator's says so, with a voice mark. */
function CastCard({ name, role, slug, picture, onPress }: { name: string; role?: "Narrator"; slug: string | undefined; picture: string | null; onPress?: () => void }) {
  return (
    <button type="button" className={cx("fy-abshow__card", role !== undefined && "fy-abshow__card--narrator")} disabled={onPress === undefined} onClick={onPress} data-testid="audiobook-card">
      <span className="fy-abshow__card-im">
        {picture !== null ? <Portrait worldSlug={slug} path={picture} label="" radius={0} loading="lazy" /> : <span className="fy-abshow__ini" aria-hidden="true">{name.trim().charAt(0).toUpperCase()}</span>}
        {role !== undefined && (
          <span className="fy-abshow__wv" aria-hidden="true">
            <Waveform size={15} stroke={2} />
          </span>
        )}
      </span>
      <span className="fy-abshow__card-nm">{name}</span>
      {role !== undefined && <span className="fy-abshow__card-rl">{role}</span>}
    </button>
  );
}

/**
 * Reading (199e): exactly what the page used to hold, in 185d's row grammar — the reading, held
 * while a run goes; the narrator, a row to 165c; a row a speaker, under Cast their voice or `no
 * voice · narrator` in warning and under Performed their note (184c), each a press to their Voice
 * page with their blocks as data; the lines nobody is cast for; the book note under every reading,
 * since it is sent with every block; the requests where the reader groups (185d); Done.
 */
function ReadingSheet({ worldId, productionId, production, door, reading, running, labels, onNarrator, onClose }: {
  worldId: string;
  productionId: string;
  production: ProductionBundle;
  door: AudiobookDoor | null;
  reading: "narrator" | "performed" | "cast";
  running: boolean;
  /** On a phone a character goes by their short name in a row (R-127), the full name on its tooltip. */
  labels?: ReadonlyMap<string, { label: string; full: string }>;
  onNarrator: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const connection = useStore().connection;
  const held = connection !== "open" || running;
  const shell = useRef<HTMLDivElement>(null);
  const [askId, setAskId] = useState<string | null>(null);
  const ask = useAudiobookAsks()[askId ?? ""];
  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    const opener = element.ownerDocument.activeElement as HTMLElement | null;
    element.focus();
    return () => {
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
    };
  }, []);
  const narrator = door?.voices[0];
  const speakers = door?.voices.slice(1) ?? [];
  const named = (voice: { sheet?: string; name: string }) => (voice.sheet !== undefined ? labels?.get(voice.sheet)?.label : undefined) ?? voice.name;
  const voicePage = (sheet: string | undefined) => (sheet === undefined ? undefined : () => navigate(`/w/${worldId}/cast/${encodeURIComponent(sheet)}/voice`));
  const blocks = (count: number) => `${count} block${count === 1 ? "" : "s"}`;
  const noteSource = (key: string) => production.audiobook?.noteSources?.[key];
  const missing = reading === "performed" && speakers.some((voice) => voice.state === "narrator" && voice.note === undefined);
  const requests = door?.requests !== undefined
    ? {
        worldId,
        productionId,
        setting: door.requests,
        reader: door.voices[0]?.voice !== undefined ? providerName(door.voices[0].voice.provider) : "this reader",
        ...(door.price.requests !== undefined ? { counts: { requests: door.price.requests, perParagraph: door.price.perParagraph ?? door.price.cloudBlocks } } : {}),
      }
    : null;
  return (
    <>
      <div className="fy-abshow__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={shell}
        className="fy-abshow__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audiobook-reading-title"
        tabIndex={-1}
        data-testid="reading-sheet"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="fy-abshow__sheet-hd">
          <h3 id="audiobook-reading-title">Reading</h3>
          <button type="button" className="fy-abshow__x" aria-label="Close" onClick={onClose}>
            <X size={15} stroke={1.9} />
          </button>
        </div>
        <div className="fy-abshow__sheet-bdy">
          <div className="fy-abshow__kv">
            <b>Reading</b>
            <nav className="fy-seg" aria-label="Reading">
              {READINGS.map(([value, label]) => (
                <button key={value} type="button" className={cx("fy-seg__item", reading === value && "fy-seg__item--active")} disabled={running} onClick={() => setAudiobookReading(worldId, productionId, value)}>
                  {label}
                </button>
              ))}
            </nav>
          </div>
          {narrator !== undefined && (
            <button type="button" className="fy-abshow__sp fy-abshow__sp--key" data-testid="reading-narrator" onClick={onNarrator}>
              <b>Narrator</b>
              <span className="fy-abshow__v">
                {narrator.name}
                {narrator.voice !== undefined && <small>{[...(narrator.book === true ? ["this book"] : []), readerPlace(narrator.voice.provider, narrator.voice.local)].join(" · ")}</small>}
              </span>
              <span className="fy-abshow__mono">{blocks(narrator.blocks)}</span>
              <span className="fy-abshow__c"><ChevronRight size={16} stroke={1.9} /></span>
            </button>
          )}
          {(speakers.length > 0 || (door?.unattributed ?? 0) > 0) && (
            <>
              <div className="fy-abshow__lbl">
                <span>Speakers</span>
                <span className="fy-abshow__mono">{speakers.length}</span>
              </div>
              <div className="fy-abshow__speakers" data-testid="reading-speakers">
                {speakers.map((voice) => {
                  const key = voice.sheet ?? voice.name;
                  if (reading === "performed" && voice.state === "narrator") {
                    const source = noteSource(key);
                    const speaker = { key, name: voice.name, ...(voice.note !== undefined ? { note: voice.note } : {}) };
                    return (
                      <div key={key} className="fy-abshow__sp" data-testid="audiobook-voice" data-state={voice.state}>
                        <b title={voice.name}>{named(voice)}</b>
                        <span className="fy-abshow__v">
                          <SpeakerNoteInput worldId={worldId} productionId={productionId} speaker={speaker} disabled={held} />
                          <small className={cx(voice.noteHeld === true && "fy-abshow__w")}>
                            {voice.noteHeld === true ? "note · not on this reader" : `${voice.note?.length ?? 0} / ${CADENCE_PHRASE_MAX}${voice.note === undefined ? "" : source === "sheet" ? " · sheet" : " · you"}`}
                          </small>
                        </span>
                        <span className="fy-abshow__mono">{blocks(voice.blocks)}</span>
                        {voice.sheet !== undefined ? (
                          <button type="button" className="fy-abshow__c" aria-label={`Voice · ${voice.name}`} onClick={voicePage(voice.sheet)}>
                            <ChevronRight size={16} stroke={1.9} />
                          </button>
                        ) : (
                          <span className="fy-abshow__c" />
                        )}
                      </div>
                    );
                  }
                  const warn = voice.state === "no voice" || voice.state === "voice unavailable";
                  const value =
                    voice.state === "reads" && voice.voice !== undefined
                      ? voice.voice.label
                      : voice.state === "recorded"
                        ? `recorded${voice.awaiting !== undefined && voice.awaiting > 0 ? ` · ${voice.awaiting} awaiting` : ""}`
                        : voice.state === "narrator"
                          ? "narrator"
                          : `${voice.state} · narrator`;
                  const go = voicePage(voice.sheet);
                  const inside = (
                    <>
                      <b title={voice.name}>{named(voice)}</b>
                      <span className={cx("fy-abshow__v", warn && "fy-abshow__v--w")}>
                        {value}
                        {voice.state === "reads" && voice.voice !== undefined && <small>{readerPlace(voice.voice.provider, voice.voice.local)}</small>}
                      </span>
                      <span className="fy-abshow__mono">{blocks(voice.blocks)}</span>
                      <span className="fy-abshow__c">{go !== undefined && <ChevronRight size={16} stroke={1.9} />}</span>
                    </>
                  );
                  return go === undefined ? (
                    <div key={key} className="fy-abshow__sp" data-testid="audiobook-voice" data-state={voice.state}>{inside}</div>
                  ) : (
                    <button key={key} type="button" className="fy-abshow__sp" data-testid="audiobook-voice" data-state={voice.state} onClick={go}>{inside}</button>
                  );
                })}
                {door !== null && door.unattributed > 0 && reading !== "narrator" && (
                  <div className="fy-abshow__sp" data-testid="audiobook-voice" data-state="unattributed">
                    <b>unattributed</b>
                    <span className="fy-abshow__v fy-abshow__v--w">{door.unattributed} line{door.unattributed === 1 ? "" : "s"} · narrator</span>
                    <span className="fy-abshow__mono" />
                    <span className="fy-abshow__c" />
                  </div>
                )}
              </div>
              {reading === "performed" && (
                <div className="fy-abshow__draft">
                  <Button variant="ghost" size="sm" disabled={!missing || held || ask?.state === "working"} data-testid="draft-from-sheets" onClick={() => setAskId(draftAudiobookSpeakerNotes(worldId, productionId))}>
                    {ask?.state === "working" ? "drafting…" : "Draft from the sheets"}
                  </Button>
                  {ask?.state === "drafted" && <span>{ask.drafted} drafted</span>}
                  {ask?.state === "refused" && <span className="fy-ch__who-where--warn">{ask.refused}</span>}
                </div>
              )}
            </>
          )}
          <NoteRow label="Book note" value={production.audiobook?.note} max={CADENCE_NOTE_MAX} disabled={held} stacked area onCommit={(value) => setAudiobookReadingNote(worldId, productionId, value)} />
          {requests !== null && <BookRequests {...requests} />}
        </div>
        <div className="fy-abshow__sheet-ft">
          <Button variant="primary" size="sm" onClick={onClose} data-testid="reading-done">
            Done
          </Button>
        </div>
      </div>
    </>
  );
}

/**
 * The price, once (R-17, frame 146c): the chapters and characters the press would read, each
 * voice with what it reads and what it costs — the narrator's share free, a speaker with no
 * voice in warning — and where the words go. Confirm carries the figure.
 */
function BookPriceSheet({ price, onClose, onConfirm }: {
  price: Extract<import("@arke-studio/contracts").DomainEvent, { type: "audiobook.book-priced" }>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const vendors = [...new Set(price.voices.filter((line) => !line.local).map((line) => providerName(line.provider)))];
  // A book Google's free day cannot cover: the reads it needs against the day's, and how far it goes.
  const free = price.freePlan !== undefined ? freePlanAskCopy(price.freePlan) : null;
  const models = useStore().state?.app.manifest?.models;
  return (
    <EditorDialog open title="Read the book" subtitle={`${price.chapters} chapter${price.chapters === 1 ? "" : "s"} · ${price.characters.toLocaleString()} characters · ${price.cloudBlocks} cloud line${price.cloudBlocks === 1 ? "" : "s"}`} onClose={onClose} width={460} labelledBy="read-book-title">
      <div className="fy-exsheet" data-testid="read-book-sheet">
        <div className="fy-abdoor__lines">
          {price.voices.map((line, index) => {
            const words = priceLineWords(line, models);
            return (
              <div key={index} className={cx("fy-abdoor__line", words.warn && "fy-abdoor__line--warn")} data-testid="read-book-line">
                <span className="fy-abdoor__line-who">{words.who}</span>
                <span className="fy-abdoor__line-how fy-mono">{words.how}</span>
                <span className="fy-abdoor__line-cost fy-mono">{words.cost}</span>
              </div>
            );
          })}
        </div>
        {vendors.length > 0 && <div className="fy-ms__line">words and the voice to {vendors.join(", ")} · text in Activity</div>}
        {(price.notices ?? []).map((notice) => <div key={notice} className="fy-ms__line" data-testid="read-book-notice">{notice}</div>)}
        {free !== null && <div className="fy-ms__line fy-ch__who-where--warn" data-testid="read-book-free-plan">{free.line}</div>}
        {price.requests !== undefined && <div className="fy-ms__line" data-testid="read-book-requests">{price.requests} request{price.requests === 1 ? "" : "s"} · {price.perParagraph ?? price.cloudBlocks} per paragraph</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} data-testid="read-book-confirm">
            {free !== null && price.estimatedMicroUsd === 0 ? free.confirm : price.requests !== undefined ? `Confirm · ${price.requests} request${price.requests === 1 ? "" : "s"} · ${speechPricePrefix(models, price.voices.map((line) => line.provider))}${formatMicroUsd(price.estimatedMicroUsd)}` : `Confirm ${price.characters.toLocaleString()} characters · ${speechPricePrefix(models, price.voices.map((line) => line.provider))}${formatMicroUsd(price.estimatedMicroUsd)}`}
          </Button>
        </div>
      </div>
    </EditorDialog>
  );
}
