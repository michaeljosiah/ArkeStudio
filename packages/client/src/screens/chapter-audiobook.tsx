import { castStanding, chapterParagraphs, characterLabels, DEFAULT_GROUP_PACKING, estimateSpeechMicroUsd, expectedSpeechSeconds, packTurns, freeCreditLeft, freePlanAskCopy, freePlanNote, groupReads, localTranscriberAvailable, quoteGroupedSpeech, readBreaksFor, readsGrouped, speechPlanLabel, speechPriceCopy, speechPricePrefix, voiceDisplayLabel, type AudiobookSplitFlag, type BlockTurns } from "@arke-studio/contracts";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLocation } from "react-router";
import {
  AUDIOBOOK_DELIVERIES,
  AUDIOBOOK_TITLE_KEY,
  CADENCE_NOTE_MAX,
  audiobookBeatAt,
  audiobookActivityLive,
  audiobookActivityStage,
  audiobookBeatCount,
  CADENCE_PHRASE_MAX,
  NOTE_TAG_HOLD,
  hasReadingNotes,
  readingNotesLead,
  type AudiobookReadingNotes,
  type HeldReadingNote,
  DEFAULT_NARRATOR,
  audiobookBlockState,
  audiobookBlockOptions,
  audiobookBlocks,
  audiobookCounts,
  audiobookDirectionFor,
  audiobookHeading,
  audiobookNoteFor,
  sheetNarrations,
  audiobookRekeyed,
  audiobookRecordingKey,
  audiobookSeamLabel,
  audiobookSpeakerColours,
  audiobookSpeakerKey,
  audiobookTextHash,
  retailLevel,
  cadenceSupport,
  holdDirection,
  mapCadence,
  markerSegments,
  performanceNote,
  normalizeSpeechText,
  formatMicroUsd,
  legacyVoiceModel,
  narratorAppliesTo,
  narratorFor,
  readerName,
  readerPlace,
  supportsVoiceUse,
  voiceSourceFor,
  type ArtifactSidecar,
  type AudiobookBlock,
  type AudiobookBlockState,
  type AudiobookGap,
  type AudiobookDirectionInput,
  type HeldControl,
  type AudiobookReader,
  type AudiobookReading,
  type ChapterAudiobook,
  type ChapterSummary,
  type ChapterVoices,
  type ClonedVoice,
  type ManifestModel,
} from "@arke-studio/contracts";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";
import { DirectedText, type TurnBreak, MarkerMenu, VIEW_HASH, cueLabel, heldWords, markerLabel, viewPlan, type MarkerAt } from "../components/voice-direction.js";

// The marker and cue words moved to the shared direction module (design turn 181); kept here too
// for the callers and tests that name them from the audiobook.
export { cueLabel, markerLabel, type MarkerAt };
import { useMediaQuery } from "../lib/media-query.js";
import { ChevronDown, ChevronRight, GroupMark, LoaderCircle, Mic, More, PlaySolid, X } from "../components/icons.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { Button } from "../components/ui.js";
import { clearQueue, dismissPlayback, enqueueClip, jumpQueue, playClip, playbackSnapshot, usePlayback, useQueueAt } from "../lib/audio.js";
import { PictureChip, type PictureSpan } from "../components/audiobook-picture.js";
import { ProposedChip } from "../components/audiobook-illustrate.js";
import { mediaUrl } from "../lib/media.js";
import { reactionsToRead } from "@arke-studio/contracts";
import { barAt, chapterTimingOf, hasTiming, useMixPlayer } from "./chapter-timing.js";
import {
  acceptDirection,
  directChapter,
  dismissAudiobookRun,
  discardAudiobookLines,
  discardAudiobookTake,
  exportAudiobookScript,
  previewAudiobookScript,
  keepAudiobookLines,
  openExportsFolder,
  stageAudiobookLines,
  useSpeakerLines,
  useHeardLines,
  hearAudiobookLine,
  setAudiobookNote,
  dismissDirection,
  keepAudiobookTake,
  stageAudiobookTake,
  useStagedTakes,
  readAudiobookBlocks,
  readAudiobookChapter,
  requestVoiceCatalogue,
  setAudiobookBlock,
  stopAudiobook,
  subscribeVoiceUploadConfirmations,
  useAudiobookRecords,
  useAudiobookAsks,
  useAudiobookBooks,
  previewDirection,
  setAudiobookReadingNote,
  draftAudiobookSpeakerNotes,
  useAudiobookRuns,
  useDirectionRuns,
  useStore,
  keepAudiobookSplit,
  resetAudiobookSeams,
  setAudiobookSeam,
  setAudiobookRequests,
  groupChapterBeats,
  useBeatRuns,
  type ReadingVoice,
} from "../lib/store.js";

/**
 * The chapter's Audiobook view (design turn 146, SPEC-047 R-30): the saved prose as blocks,
 * each with its reader in the margin and a dot for its state, the head holding the player and
 * `Read the chapter`, and the side following the view — the block pressed and its takes. Nothing
 * here edits prose; the words are the saved record's, read the way the coordinator reads them.
 */

export interface ChapterAudiobookInput {
  worldId: string;
  prodId: string;
  chapter: ChapterSummary;
  /** The saved body — never the draft: a take is made from what is on disk (R-2). */
  body: string;
  cast: ChapterVoices | null;
  record: ChapterAudiobook | "unreadable" | null;
  /** The takes the record names that the coordinator found gone from the shelf when the chapter was opened. */
  missing?: readonly string[];
  reading: AudiobookReading;
  /** The book's recorded speakers (SPEC-047 R-37), by `audiobookRecordingKey`. */
  recorded?: readonly string[];
  /** How the narrator plays each character under `performed` (R-44), by `audiobookNoteKey`. */
  notes?: Readonly<Record<string, string>>;
  /** The book's own narrator (R-46); absent is the app's. */
  bookNarrator?: AudiobookReader;
  /** The book note and this chapter's note (design turn 184, R-53), which lead every block. */
  readingNotes?: AudiobookReadingNotes;
  /** The book reads a block a request (design turn 185d); absent is grouped where the reader can group. */
  requests?: "per-paragraph";
  connection: string;
  locked: boolean;
  /**
   * The press waits out the autosave (R-2): true when the read — or the direction, which reads
   * the same saved words (R-10) — may go now; false when the workspace has taken it, flushed the
   * draft, and will send it once the save lands.
   */
  beforeRead?: (intent: AudiobookIntent) => boolean;
  /** Listen is the head's primary (`listenLeads`): Direct and Read the chapter stand back beside it. */
  listenLeads?: boolean;
  /** Below 1100 (design turn 194, rule 15): Direct and illustrate is the toolbar's ⋯ and the read is held at the foot, so the head says each in its own part. */
  compact?: boolean;
  /**
   * Illustrate this chapter (design turn 191b), in the Direct and illustrate menu (194): its press,
   * whether it is working, whether a proposal is held (`Illustrate again`), the state the menu says
   * beside it, and — while it reads or makes — the count and Stop the toolbar shows in the menu's place.
   */
  illustrate?: { press: () => void; busy: boolean; again: boolean; state?: string; running?: { line: string; stop?: () => void } };
  /** The chapter's Looks (design turn 193a), in the same menu (194): opens the Looks sheet; `state` is what it says beside it. */
  looks?: { open: () => void; state?: string };
  /** On a phone (design turn 198, rule 10) the Blocks press and its Reset are in the toolbar's ⋯ menu. */
  seamsInMenu?: boolean;
  /**
   * The reading is the toolbar ⋯'s first item where the line has no room for its press (design
   * turn 203): `open` shows the reading menu, and `narrator` names the voice where the hook's own
   * reader has no label.
   */
  readingInMenu?: { open: () => void; narrator: string };
  /**
   * Casting from the view (design turn 198): the paragraphs edited since the cast (`changed`) or
   * the chapter, through the workspace's press, which waits out the autosave; busy while a cast runs.
   */
  casting?: { press: (scope?: "changed") => void; busy: boolean };
}

/** What a press asks for once the save lands: the chapter, these blocks alone, a direction, or a card's acceptance. */
export type AudiobookIntent = { kind: "read"; blocks?: readonly string[]; /** The paragraphs left to cast, cast first (design turn 198). */ castFirst?: boolean } | { kind: "direct"; also?: DirectAlso } | { kind: "accept" } | { kind: "open-direct" };

/** What the Direct sheet's `Also` asks for with the direction (design turn 184a, R-53, R-54). */
export interface DirectAlso {
  cast?: boolean;
  chapterNote?: boolean;
  speakerNotes?: boolean;
}

export interface BlockRow {
  block: AudiobookBlock;
  state: AudiobookBlockState;
  /** What the margin says: `title`, `narrator`, or what the speaker goes by — a character's short name (design turn 194, rule 12b). */
  mark: string;
  /** The speaker's full name, which pins, menus and tooltips use; the same as `mark` for the narrator, the title and a name no sheet carries. */
  full: string;
  markWarn: boolean;
  /** The reader the block is meant for — what its state is judged against (R-13). */
  assigned: AudiobookReader;
  /**
   * The reader that will actually speak it, by the run's rule (R-12; codex on PR 1186): the
   * assigned voice when the catalogue says it can speak now, the narrator otherwise — so the
   * panel offers what that reader can do, and prices what it costs.
   */
  speaker: AudiobookReader;
  /** The cloned voice's recording language, the line's (issue 1163); none for a catalogue voice. */
  language?: string;
  artifact: ArtifactSidecar | null;
  /** Who speaks the block by the cast (SPEC-047 R-33): the sheet, else the name; null for narration and the title. */
  speakerKey: string | null;
  /** The speakers a block holds when it is one reader's whole paragraph (design turn 190): the lines inside it, by key. */
  speakers?: ReadonlyArray<{ key: string; label: string; full: string; colour: number | null }>;
  /** The turns of a block of several, in order: where each begins in the block's words and who speaks it (design turn 190), drawn as rows. */
  turnMarks?: ReadonlyArray<TurnBreak>;
  /** The speaker's colour, `--voice-N`, the same in every chapter; null for the narrator and a name no sheet carries. */
  colour: number | null;
  /** An edited quote that kept its speaker (design turn 198): the dashed `kept` mark beside the name, until checked. */
  kept?: boolean;
  /**
   * Words in a paragraph edited since the cast that are neither cast nor kept (design turn 198,
   * rule 14): they wait for the paragraph's cast, so no speaker can be given to them yet.
   */
  waits?: boolean;
  /**
   * The beat the block is (design turn 201, rule 4): the name and speaker the director gave it,
   * its paragraphs and its length at the reading rate; absent on a block that is no named beat.
   */
  beat?: { name?: string; whose?: string; paragraphs: number; seconds: number };
  /** The kept take was recorded by a person (SPEC-047 R-34), not made by a voice. */
  recorded: boolean;
  /** The block's speaker is recorded by a person (R-37): made only by a recording. */
  byPerson: boolean;
  /**
   * The block's direction for its words now (R-43): the record's, or one written for earlier
   * words carried here by its anchors, with what could not be carried counted.
   */
  direction: { input: AudiobookDirectionInput; dropped: number } | null;
  /** What the reader that will speak cannot express, held rather than sent (R-47); by cue index where it is a cue. */
  held: HeldControl[];
  /** What that reader is sent (R-42): each part's text, tags in; null without a direction. */
  /** What the reader is sent, part by part: the words with its syntax in, and the style beside them (design turn 181e). */
  sentAs: SentPart[] | null;
  /** The speaker's note the line is played with under `performed` (R-44). */
  note?: string;
  /** The narrator reads it (turn 165's `read by … · narrator`): narration, a line under `narrator` or `performed`, or a stand-in. */
  byNarrator: boolean;
  /** The book note and the chapter note this reader cannot take (design turn 184d): struck under Sent as. */
  readingHeld: HeldReadingNote[];
  /**
   * The held proposal's direction for this block (design turn 184b, R-55), drawn dashed until
   * accepted, with what it would be sent as; null when no proposal is held, or it leaves the
   * block undirected.
   */
  proposed: { input: AudiobookDirectionInput; held: HeldControl[]; sentAs: SentPart[] | null; readingHeld: HeldReadingNote[] } | null;
  /**
   * The block as a grouped request takes it (design turn 185): the notes the chapter shares apart
   * from each part's own style — the coordinator's packing, so the requests counted here are its.
   */
  turns: Pick<BlockTurns, "shared" | "parts">;
  /** A grouped read's cut whose words did not match (design turn 185c), while its flag stands. */
  split: AudiobookSplitFlag | null;
}

/** The block's direction as it stands for its words (R-43): the record's, or carried from earlier words. */
export function rowDirection(record: ChapterAudiobook | null, block: Pick<AudiobookBlock, "key" | "text">): BlockRow["direction"] {
  const standing = audiobookDirectionFor(record, block);
  if (standing !== null) {
    const plan = standing.plan;
    return { input: { ...(plan.delivery !== undefined ? { delivery: plan.delivery } : {}), speed: plan.speed, cues: plan.cues, ...(plan.note !== undefined ? { note: plan.note } : {}) }, dropped: standing.dropped ?? 0 };
  }
  return audiobookRekeyed(record, block);
}

/**
 * What a reader does with a direction (R-42, R-47): the controls it holds and the text it is
 * sent, part by part — a marker it makes in parts is a part of its own. Null when the plan is
 * wrong for the words, which the coordinator refuses and says.
 */
export interface SentPart { text: string; style?: string }
export function directionView(
  text: string,
  input: AudiobookDirectionInput | null,
  model: ManifestModel,
  language?: string,
  note?: string,
  reading?: AudiobookReadingNotes,
): { held: HeldControl[]; sentAs: SentPart[]; readingHeld: HeldReadingNote[]; turns: Pick<BlockTurns, "shared" | "parts"> } | null {
  try {
    // The book note and the chapter note lead every part, before the speaker's note and the
    // block's own direction (design turn 184, R-53): sentences in the style on an instruction
    // row, a tag each on a tag row while short enough, held otherwise — as the coordinator sends.
    const context = reading === undefined ? { tags: [] as string[], held: [] as HeldReadingNote[] } : readingNotesLead(reading, model, language);
    // The speaker's note leads every part on a row that takes it as a tag (R-45); on a row that
    // takes an instruction it rides beside the words, ahead of the block's own style, and on one
    // that takes neither it is held.
    const playing = note === undefined ? null : performanceNote(note, model, language);
    const tags = [...context.tags, ...(playing?.mode === "tag" ? [playing.tag] : [])];
    const style = [...(context.instructions !== undefined ? [context.instructions] : []), ...(playing?.mode === "instruction" ? [note!] : [])].join(" ");
    const lead = (part: SentPart): SentPart => ({
      ...part,
      text: tags.length > 0 ? `${tags.join(" ")} ${part.text}` : part.text,
      ...(style !== "" ? { style: part.style === undefined ? style : `${style} ${part.style}` } : {}),
    });
    // Each part's own style apart from the chapter's shared notes (design turn 185), as the
    // coordinator packs a grouped request: the notes once, each turn its own after.
    const own = (part: SentPart) => [...(playing?.mode === "instruction" ? [note!] : []), ...(part.style !== undefined ? [part.style] : [])].join(" ");
    const turnsOf = (parts: SentPart[]): Pick<BlockTurns, "shared" | "parts"> => ({
      ...(context.instructions !== undefined ? { shared: context.instructions } : {}),
      parts: parts.map((part) => ({ text: tags.length > 0 ? `${tags.join(" ")} ${part.text}` : part.text, ...(own(part) !== "" ? { style: own(part) } : {}) })),
    });
    if (input === null) {
      const words = { text: normalizeSpeechText(text) };
      return { held: [], sentAs: [lead(words)], readingHeld: context.held, turns: turnsOf([words]) };
    }
    const { plan: sent, held } = holdDirection(text, viewPlan(input), model, language);
    const segments = markerSegments(text, sent, model, language).map((segment) => {
      const mapped = mapCadence(segment.text, VIEW_HASH, { ...segment.plan, sourceTextHash: VIEW_HASH }, model, language);
      return { text: mapped.providerText, ...(mapped.instructions !== undefined ? { style: mapped.instructions } : {}) };
    });
    return { held, sentAs: segments.map(lead), readingHeld: context.held, turns: turnsOf(segments) };
  } catch {
    return null;
  }
}

/** A held book or chapter note in Sent as's words (design turn 184d): `book note · 94 characters · Eleven v3 takes 60 as a tag`. */
export function readingHeldWords(held: HeldReadingNote, model: ManifestModel | null): string {
  const why = held.reason === NOTE_TAG_HOLD ? `${model?.displayName ?? "this reader"} takes ${CADENCE_PHRASE_MAX} as a tag` : "held";
  return `${held.which} note · ${held.length} characters · ${why}`;
}

/** The filter over the blocks (R-33): everyone, the narrator, or one speaker by key. */
export type AudiobookFilter = null | "narrator" | { speaker: string };

/** Whether a row passes the filter. */
export function inAudiobookFilter(row: Pick<BlockRow, "speakerKey" | "speakers">, filter: AudiobookFilter): boolean {
  if (filter === null) return true;
  if (filter === "narrator") return row.speakerKey === null;
  return row.speakerKey === filter.speaker || (row.speakers ?? []).some((speaker) => speaker.key === filter.speaker);
}

const STATE_LABEL: Record<AudiobookBlockState, string> = { "not made": "not made", made: "made", stale: "stale", flagged: "flagged", awaiting: "awaiting recording" };

function readerOf(voice: { provider: string; model?: string; voiceId: string; label?: string }, clonedVoices: readonly ClonedVoice[] | undefined): AudiobookReader | null {
  const model = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId, clonedVoices ?? []);
  if (model === null) return null;
  return { provider: voice.provider, model, voiceId: voice.voiceId, ...(voice.label !== undefined ? { label: voice.label } : {}) };
}

/**
 * Who narrates the chapter, by the coordinator's rule (`audiobookNarrator`) so the chapter and the
 * door name the same voice: the book's own reader when it can speak now, else the app's narrator
 * where it applies to this world, else the shipped voice. A book's reader resolves against the
 * world's voices only, never the app narrator's copy of another world's (SPEC-049 R-12).
 *
 * Until the catalogue answers, the choice is taken as stored. Judging it against no catalogue
 * named George over Ife's designed voice on every chapter surface — the Voices rail, the Timing
 * lanes, the block panel and the price — while the door, answered by the coordinator, said Ife.
 */
export function chapterNarrator(input: {
  bookNarrator?: AudiobookReader;
  stored: { provider: string; model?: string; voiceId: string; label?: string; worldId?: string } | null;
  worldId: string;
  catalogue: readonly ReadingVoice[] | null;
  names?: Parameters<typeof voiceDisplayLabel>[1];
}): AudiobookReader {
  const { bookNarrator, stored, worldId, catalogue, names } = input;
  const applies = stored !== null && narratorAppliesTo(stored, worldId) && supportsVoiceUse(stored, "narration") ? stored : null;
  const reader = (voice: { provider: string; model: string; voiceId: string; label?: string | undefined }): AudiobookReader =>
    ({ provider: voice.provider, model: voice.model, voiceId: voice.voiceId, label: voiceDisplayLabel(voice, names) });
  if (catalogue === null) {
    if (bookNarrator !== undefined) return reader(bookNarrator);
    const model = applies === null ? null : (applies.model ?? legacyVoiceModel(applies.provider, applies.voiceId));
    return applies !== null && model !== null ? reader({ ...applies, model }) : reader(DEFAULT_NARRATOR);
  }
  const speakable = catalogue.filter((voice) => supportsVoiceUse(voice, "narration") && voice.unavailableReason === undefined);
  const own = bookNarrator === undefined ? null : narratorFor(bookNarrator, speakable.filter((voice) => voice.narratorCopy !== true));
  return reader(own !== null && !own.fallback ? own : narratorFor(applies, speakable));
}

/** The blocks, their states and the counts, from the one rule both ends use. */
export function useChapterAudiobook(input: ChapterAudiobookInput) {
  const { worldId, prodId, chapter, body, cast, record, missing, reading, connection, locked } = input;
  const recordedList = input.recorded;
  const recordedKeys = useMemo(() => new Set(recordedList ?? []), [recordedList]);
  const { state } = useStore();
  const world = state?.world ?? null;
  // What each character goes by in a row, the filter and the panel title; the full name stays the tooltip (design turn 194, rule 12b).
  const labels = useMemo(() => characterLabels(world?.sheets ?? []), [world?.sheets]);
  const catalogue = useStore().voiceCatalogue;
  const runs = useAudiobookRuns();
  const run = runs[`${worldId}/${prodId}/${chapter.id}`];
  const activity = state?.app.audiobookActivity?.find(run => run.worldId === worldId && run.productionId === prodId && run.chapterId === chapter.id && audiobookActivityLive(run));
  const at = useQueueAt();
  const [selected, setSelected] = useState<string | null>(null);
  const location = useLocation();
  const requestedBlock = new URLSearchParams(location.search).get("block");
  const openedBlock = useRef<string | null>(null);
  // The marker menu (R-42): the view's, so the page's `[` and the side's button open the same one.
  const [marker, setMarker] = useState<MarkerAt | null>(null);
  useEffect(() => { setMarker(null); setSelected(null); }, [chapter.id]);
  useEffect(() => {
    const entry = `${location.key}/${requestedBlock}`;
    if (!requestedBlock || !body || openedBlock.current === entry) return;
    const frame = requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>("[data-block]")].find(element => element.dataset.block === requestedBlock);
      if (row) { openedBlock.current = entry; setSelected(requestedBlock); row.scrollIntoView({ block: "center" }); }
    });
    return () => cancelAnimationFrame(frame);
  }, [chapter.id, location.key, requestedBlock, body]);

  // The narrator as the coordinator chooses it (codex on PR 1180): a stored narrator whose
  // voice cannot speak now falls back the same way on both sides, or the client would judge
  // every take of the local fallback stale against a voice the run never used.
  // The book's own narrator when it has one that can speak now (R-46), by the coordinator's rule.
  // A cloned app narrator is its own world's (SPEC-046 R-37), and the catalogue marks a clone
  // whose recording is gone, so both fall back here as they do there.
  const bookNarrator = input.bookNarrator;
  const narrator = useMemo<AudiobookReader>(
    () => chapterNarrator({ ...(bookNarrator !== undefined ? { bookNarrator } : {}), stored: state?.app.narrator ?? null, worldId, catalogue, names: world ?? {} }),
    [state?.app.narrator, catalogue, bookNarrator, worldId, world],
  );
  const notes = input.notes;
  const readingNotes = input.readingNotes;
  // A held proposal is drawn on the blocks until it is accepted (design turn 184b): read here so
  // each row can carry its proposed direction and what that would be sent as.
  const heldRun = useDirectionRuns()[`${worldId}/${prodId}/${chapter.id}`];
  const proposal = heldRun !== undefined && (heldRun.state === "directed" || heldRun.state === "accepting") && heldRun.proposed !== undefined ? heldRun : null;
  const models = state?.app.manifest?.models ?? [];
  const modelOf = useCallback(
    (reader: AudiobookReader): ManifestModel | null => models.find((m) => m.provider === reader.provider && m.id === reader.model && m.capability === "voice-tts") ?? null,
    [models],
  );
  const recordOrNull = record === "unreadable" ? null : record;
  // A proposal that cast the lines first is drawn on the blocks its cast makes (codex on PR 1479):
  // the record's cast would split the paragraphs elsewhere and give the lines other readers.
  const blockCast = proposal?.castRecord ?? cast;
  // One reader, one block (design turn 190): the same blocks the coordinator plans, from the same rule.
  // The seams set by hand reshape them (design turn 198), read off the same record.
  const seamList = recordOrNull?.seams;
  const blockOptions = useMemo(() => audiobookBlockOptions({ reading, ...(recordedList !== undefined ? { recorded: [...recordedList] } : {}) }, seamList === undefined ? null : { seams: seamList }), [reading, recordedList, seamList]);
  const derived = useMemo(() => audiobookBlocks(body, blockCast, audiobookHeading(chapter.order, chapter.title), blockOptions), [body, blockCast, chapter.order, chapter.title, blockOptions]);
  // Where the cast stands against the saved words (design turn 198): the paragraphs an edit left
  // to cast, by their index now, and how many the chapter has — `Cast the chapter`'s count.
  const toCast = useMemo(() => (cast === null ? [] : castStanding(cast, body, chapter.bodyHash).toCast), [cast, body, chapter.bodyHash]);
  const paragraphCount = useMemo(() => chapterParagraphs(body).length, [body]);
  const waiting = useMemo(() => new Set(toCast), [toCast]);
  // A take the record names but the shelf no longer holds is not made (codex on PR 1180): the
  // coordinator plans the same way, so the block is made again rather than shown unplayable.
  // The sidecar this window can see for itself; the media it cannot, so the coordinator says
  // at open which takes it found gone (codex on PR 1183).
  const hasArtifact = useCallback(
    (artifactId: string) => !(missing ?? []).includes(artifactId) && (world?.artifacts.some((candidate) => candidate.id === artifactId && candidate.retiredAt === undefined) ?? false),
    [world, missing],
  );
  // One colour a speaker across the book (R-33): read from every chapter's cast stamp, this
  // chapter's own speakers numbered after them when its stamp has not caught up yet.
  const chapters = world?.productions.find((candidate) => candidate.meta.id === prodId)?.chapters;
  const colours = useMemo(
    () => audiobookSpeakerColours(chapters ?? [], derived.blocks.flatMap((block) => (block.rows ?? [block]).flatMap((turn) => (turn.sheet !== undefined ? [turn.sheet] : [])))),
    [chapters, derived.blocks],
  );
  const rows = useMemo<BlockRow[]>(() => {
    // The characters' own narration (design turn 200, R-166), as the coordinator plans with it.
    const narrations = reading === "performed" ? sheetNarrations(world?.sheets ?? []) : {};
    return derived.blocks.map((block) => {
      let assigned = narrator;
      let mark = block.key === AUDIOBOOK_TITLE_KEY ? "title" : "narrator";
      let markWarn = false;
      // The speaker keeps its name in the margin; a retired character loses its voice (codex on
      // PR 1180): the coordinator plans with the active characters only, and a take it made in
      // the narrator's stead must read as made here too, not as stale against a retired voice.
      const sheet = block.sheet === undefined ? undefined : world?.sheets.find((candidate) => candidate.id === block.sheet);
      const active = sheet !== undefined && sheet.type === "character" && !sheet.retired;
      let full = mark;
      const called = (named: typeof sheet, fallback: string) => (named === undefined ? fallback : (labels.get(named.id)?.label ?? named.name));
      if (reading === "cast" && block.speaker !== undefined) {
        mark = called(sheet, block.speaker);
        full = sheet?.name ?? block.speaker;
        const reader = !active || sheet.voice === undefined ? null : readerOf(sheet.voice, world?.clonedVoices);
        if (reader === null) markWarn = true;
        else assigned = reader;
      } else if (block.speaker !== undefined) {
        mark = called(sheet, block.speaker);
        full = sheet?.name ?? block.speaker;
      }
      const take = recordOrNull?.takes[block.key];
      const artifact = take === undefined ? null : (world?.artifacts.find((candidate) => candidate.id === take.artifactId) ?? null);
      // Who will speak (codex on PR 1186): the assigned voice only when the manifest knows its
      // model and the catalogue, once asked, says it can speak now and its clone is still in
      // the library; the narrator otherwise, whose row the panel then reads. A catalogue not
      // yet answered leaves the assignment standing rather than guessing at a fallback.
      const sameAsNarrator = assigned.provider === narrator.provider && assigned.model === narrator.model && assigned.voiceId === narrator.voiceId;
      const listed = catalogue === null ? undefined : catalogue.find((candidate) => candidate.provider === assigned.provider && candidate.model === assigned.model && candidate.voiceId === assigned.voiceId);
      const source = voiceSourceFor(world?.clonedVoices ?? [], assigned.provider, assigned.model, assigned.voiceId);
      const cannot = !sameAsNarrator && (modelOf(assigned) === null || (catalogue !== null && (listed === undefined || listed.unavailableReason !== undefined)) || source.kind === "missing-clone");
      const speaker = cannot ? narrator : assigned;
      const spokenSource = voiceSourceFor(world?.clonedVoices ?? [], speaker.provider, speaker.model, speaker.voiceId);
      const language = spokenSource.kind === "cloned" ? spokenSource.voice.language : undefined;
      const speakerKey = audiobookSpeakerKey(block);
      const colour = block.sheet === undefined ? null : (colours.get(block.sheet) ?? null);
      // Who speaks inside a block of several turns: each once, named as the cast names them.
      const inside = block.rows === undefined ? undefined : [...new Map(block.rows.flatMap((turn) => {
        const key = audiobookSpeakerKey(turn);
        if (key === null) return [];
        const sheetOf = turn.sheet === undefined ? undefined : world?.sheets.find((candidate) => candidate.id === turn.sheet);
        return [[key, { key, label: called(sheetOf, turn.speaker ?? key), full: sheetOf?.name ?? turn.speaker ?? key, colour: turn.sheet === undefined ? null : (colours.get(turn.sheet) ?? null) }] as const];
      })).values()];
      // The turns as rows (design turn 190): each found in the block's words in order, so the
      // rows draw at the offsets the words keep. One not found leaves the block a single row.
      const turnMarks = ((): TurnBreak[] | undefined => {
        if (block.rows === undefined) return undefined;
        const marks: TurnBreak[] = [];
        let from = 0;
        for (const turn of block.rows) {
          const found = block.text.indexOf(turn.text, from);
          if (found < 0) return undefined;
          const key = audiobookSpeakerKey(turn);
          const sheetOf = turn.sheet === undefined ? undefined : world?.sheets.find((candidate) => candidate.id === turn.sheet);
          const tone = key === null ? "narrator" : turn.sheet === undefined ? "none" : String(colours.get(turn.sheet) ?? "none");
          marks.push({ at: marks.length === 0 ? 0 : found, label: key === null ? "narrator" : called(sheetOf, turn.speaker ?? key), full: key === null ? "narrator" : (sheetOf?.name ?? turn.speaker ?? key), tone, ...(turn.kept === true ? { kept: true } : {}) });
          from = found + turn.text.length;
        }
        return marks;
      })();
      if (turnMarks !== undefined) {
        mark = turnMarks[0]!.label;
        full = turnMarks[0]!.full ?? mark;
      }
      const recorded = take?.source === "recorded";
      const byPerson = recordedKeys.has(audiobookRecordingKey(block));
      const named = audiobookBeatAt(recordOrNull?.beats, block);
      const direction = rowDirection(recordOrNull, block);
      const speakerModel = modelOf(speaker);
      const note = audiobookNoteFor({ reading, ...(notes !== undefined ? { notes: { ...notes } } : {}) }, block, narrations);
      const led = hasReadingNotes(readingNotes) ? readingNotes : undefined;
      const view = (direction === null && note === undefined && led === undefined) || speakerModel === null ? null : directionView(block.text, direction?.input ?? null, speakerModel, language, note, led);
      // Under the proposal: its direction, the speaker notes and the chapter note it drafted
      // where none stands, as the coordinator would send them once it is accepted.
      const proposedInput = proposal?.proposed?.[block.key];
      const proposedNote = note ?? (reading === "performed" && block.speaker !== undefined ? proposal?.speakerNotes?.[block.sheet ?? block.speaker] : undefined);
      const proposedReading = proposal?.chapterNote !== undefined ? { ...led, chapter: proposal.chapterNote } : led;
      const proposedView = proposedInput === undefined || speakerModel === null ? null : directionView(block.text, proposedInput, speakerModel, language, proposedNote, proposedReading);
      return {
        block,
        turns: view?.turns ?? { parts: [{ text: normalizeSpeechText(block.text) }] },
        split: recordOrNull?.flags[block.key]?.split ?? null,
        state: audiobookBlockState(block, recordOrNull, assigned, hasArtifact, byPerson, note, led),
        readingHeld: view?.readingHeld ?? [],
        proposed: proposedInput === undefined ? null : { input: proposedInput, held: proposedView?.held ?? [], sentAs: proposedView?.sentAs ?? null, readingHeld: proposedView?.readingHeld ?? [] },
        ...(note !== undefined ? { note } : {}),
        mark,
        full,
        markWarn,
        assigned,
        speaker,
        ...(language !== undefined ? { language } : {}),
        artifact,
        speakerKey,
        ...(inside !== undefined && inside.length > 0 ? { speakers: inside } : {}),
        ...(turnMarks !== undefined ? { turnMarks } : {}),
        colour,
        // The first turn's mark is the row's (design turn 198): a later turn's is drawn on its break.
        kept: turnMarks !== undefined ? turnMarks[0]!.kept === true : block.kept === true,
        waits: block.paragraph >= 0 && waiting.has(block.paragraph) && block.speaker === undefined && block.rows === undefined,
        ...(named !== null
          ? { beat: { ...(named.name !== undefined ? { name: named.name } : {}), ...(named.whose !== undefined ? { whose: (() => { const sheet = world?.sheets.find((candidate) => candidate.type === "character" && candidate.name === named.whose); return sheet === undefined ? named.whose : (labels.get(sheet.id)?.label ?? named.whose); })() } : {}), paragraphs: block.sources?.length ?? 1, seconds: expectedSpeechSeconds(block.text) } }
          : {}),
        recorded,
        byPerson,
        direction,
        held: view?.held ?? [],
        sentAs: view?.sentAs ?? null,
        byNarrator: speaker === narrator,
      };
    });
  }, [derived.blocks, narrator, reading, world, labels, recordOrNull, hasArtifact, catalogue, modelOf, colours, recordedKeys, notes, readingNotes, proposal, waiting]);
  // The filter is the page's (R-33): not kept, and gone with the chapter.
  const [filter, setFilter] = useState<AudiobookFilter>(null);
  useEffect(() => setFilter(null), [chapter.id]);
  /** The filter row: everyone, the narrator, then each speaker in colour order and the names no sheet carries after. */
  const filters = useMemo(() => {
    const speakers = new Map<string, { key: string; label: string; full: string; colour: number | null; count: number }>();
    for (const row of rows) {
      // A block of several turns counts each speaker in it once (design turn 190).
      for (const who of row.speakers ?? []) {
        const held = speakers.get(who.key);
        if (held !== undefined) held.count += 1;
        else speakers.set(who.key, { key: who.key, label: who.label, full: who.full, colour: who.colour, count: 1 });
      }
      if (row.speakerKey === null) continue;
      const held = speakers.get(row.speakerKey);
      if (held !== undefined) held.count += 1;
      else speakers.set(row.speakerKey, { key: row.speakerKey, label: row.mark, full: row.full, colour: row.colour, count: 1 });
    }
    return {
      everyone: rows.length,
      narrator: rows.filter((row) => row.speakerKey === null).length,
      speakers: [...speakers.values()].sort((a, b) => (a.colour ?? Infinity) - (b.colour ?? Infinity) || a.label.localeCompare(b.label)),
    };
  }, [rows]);
  // The catalogue says who can speak now (turn 130's rule): asked for once the view is open,
  // so the panel's readers are the run's.
  useEffect(() => {
    if (connection === "open") requestVoiceCatalogue(worldId);
  }, [connection, worldId]);
  const counts = useMemo(() => {
    const blocks = audiobookCounts(
      derived.blocks,
      recordOrNull,
      (block) => rows.find((row) => row.block.key === block.key)?.assigned ?? narrator,
      hasArtifact,
      (block) => recordedKeys.has(audiobookRecordingKey(block)),
      // The notes a block is led by name its take (R-45, R-53): the counts judge it as the row does.
      (block) => {
        const row = rows.find((candidate) => candidate.block.key === block.key);
        return { ...(row?.note !== undefined ? { note: row.note } : {}), ...(hasReadingNotes(readingNotes) ? { reading: readingNotes } : {}) };
      },
    );
    // Reactions are read when the chapter is (design turn 187, R-83): the press counts them with
    // the blocks, so it stands while one is left to read. The chapter's own totals stay its blocks'.
    return { ...blocks, toMake: [...blocks.toMake, ...reactionsToRead(recordOrNull, derived.blocks, hasArtifact)] };
  }, [derived.blocks, recordOrNull, rows, narrator, hasArtifact, recordedKeys, readingNotes]);
  // What a press would spend, before the run asks: the cloud blocks not made, by the character
  // as the row bills it (SPEC-046 R-8) — bytes or doubled CJK for the readers that count so.
  // The cache is not consulted here, so a character reader's run can only be lower. A token
  // reader's is an estimate either way, and the run prices its parts as compiled, each with its
  // style and lead-in, so the figure is marked `~` once one is in it (SPEC-049 R-6).
  // A free plan's or credit's read is named rather than priced (design turn 182): it asks
  // nothing, so a sum including it would be a price nobody is asked to pay.
  const { estimate, plan, tokenPriced } = useMemo(
    () =>
      rows.reduce<{ estimate: number; plan: string | null; tokenPriced: boolean }>((sum, row) => {
        if (row.state === "made" || row.state === "awaiting" || row.speaker.provider === "kokoro") return sum;
        const model = modelOf(row.speaker);
        if (model === null) return sum;
        const label = speechPlanLabel(model);
        return label !== null ? { ...sum, plan: sum.plan ?? label }
          : { ...sum, estimate: sum.estimate + estimateSpeechMicroUsd(model, row.block.text), tokenPriced: sum.tokenPriced || model.pricing.kind === "perToken" };
      }, { estimate: 0, plan: null, tokenPriced: false }),
    [rows, modelOf],
  );

  // The requests a press would make (design turn 185a): the coordinator's grouping, computed on
  // the same blocks — consecutive cloud blocks of one groupable reader, packed under the caps and
  // closed at natural breaks — so the button says `5 requests` before anything is asked. Grouping
  // is offered only where this machine can split, as the coordinator decides it.
  const providers = state?.app.providers;
  const requestsSetting = input.requests;
  const grouping = useMemo(() => {
    const transcriber = localTranscriberAvailable(providers ?? []);
    const toRead = (row: BlockRow) => row.state !== "made" && row.state !== "awaiting" && row.speaker.provider !== "kokoro" && modelOf(row.speaker) !== null;
    const grouped = (row: BlockRow) => {
      const model = modelOf(row.speaker);
      return model !== null && readsGrouped(model, transcriber, requestsSetting === undefined ? null : { requests: requestsSetting }) && model.limits.audioFormat === "wav"
        && voiceSourceFor(world?.clonedVoices ?? [], row.speaker.provider, row.speaker.model, row.speaker.voiceId).kind !== "cloned";
    };
    const breaks = readBreaksFor(rows.map((row) => ({ key: row.block.key, paragraph: row.block.paragraph, ...(row.block.speaker !== undefined ? { speaker: row.block.speaker } : {}) })), chapterParagraphs(body));
    const groups = groupReads(
      rows.map((row) => {
        if (!toRead(row) || !grouped(row)) return null;
        const breakAfter = breaks.get(row.block.key);
        return { key: row.block.key, reader: `${row.speaker.provider}/${row.speaker.model}/${row.speaker.voiceId}`, ...row.turns, ...(breakAfter !== undefined ? { breakAfter } : {}) };
      }),
      DEFAULT_GROUP_PACKING,
    ).filter((group) => group.keys.length >= 2);
    const groupOf = new Map(groups.flatMap((group) => group.keys.map((key) => [key, group] as const)));
    // Each request numbered in reading order, a block alone counted as one.
    let requests = 0;
    const numbered: Array<{ keys: string[]; seconds: number; request: number; estimatedMicroUsd: number }> = [];
    let perParagraph = 0;
    for (const row of rows) {
      if (!toRead(row)) continue;
      perParagraph += 1;
      const group = groupOf.get(row.block.key);
      if (group === undefined) {
        requests += 1;
        continue;
      }
      if (group.keys[0] !== row.block.key) continue;
      requests += 1;
      const model = modelOf(row.speaker)!;
      numbered.push({ keys: group.keys, seconds: group.seconds, request: requests, estimatedMicroUsd: speechPlanLabel(model) !== null ? 0 : quoteGroupedSpeech(model, group.turns).expectedMicroUsd });
    }
    return { groups: numbered, requests, perParagraph, groupOf: new Map(numbered.flatMap((group) => group.keys.map((key) => [key, group] as const))) };
  }, [rows, modelOf, providers, requestsSetting, body, world?.clonedVoices]);
  // A grouped request's estimate is its one quote: a lead-in and tail a request, not a block.
  const groupedEstimate = useMemo(() => {
    let estimate_ = 0;
    for (const row of rows) {
      const group = grouping.groupOf.get(row.block.key);
      if (group === undefined || row.state === "made" || row.state === "awaiting") continue;
      const model = modelOf(row.speaker);
      if (model === null || speechPlanLabel(model) !== null) continue;
      estimate_ -= estimateSpeechMicroUsd(model, row.block.text);
    }
    return estimate_ + grouping.groups.reduce((sum, group) => sum + group.estimatedMicroUsd, 0);
  }, [rows, modelOf, grouping]);
  const chapterEstimate = Math.max(0, estimate + groupedEstimate);

  // The player: the made takes in order, through the one queue the page read uses (R-20).
  // With a speaker chosen, Play plays that speaker's takes alone (R-33).
  const playable = useMemo(() => rows.filter((row) => row.state === "made" && row.artifact !== null && inAudiobookFilter(row, filter)), [rows, filter]);
  const queueId = `audiobook:${worldId}/${prodId}/${chapter.id}`;
  // A queue that has run dry rests on `ended` with `at` one past its last piece (codex on PR
  // 1180): that is not playing, and the head goes back to Play rather than `N+1 of N · Stop`.
  const playback = usePlayback();
  // Timing on the blocks (design turn 187, R-85): the chapter's clock as the Timing view draws it,
  // and as the mix plays it — a chapter with any timing is heard through the one mix, never as
  // takes joined back to back, so Play sounds the overlaps, trims and beds as they are set.
  const artifacts = world?.artifacts;
  const timing = useMemo(() => chapterTimingOf(rows, recordOrNull, artifacts ?? [], reading, "estimate", missing), [rows, recordOrNull, artifacts, reading, missing]);
  const mixed = useMemo(() => chapterTimingOf(rows, recordOrNull, artifacts ?? [], reading, "skip", missing), [rows, recordOrNull, artifacts, reading, missing]);
  const timed = hasTiming(recordOrNull);
  const mixPlayer = useMixPlayer({ worldId, prodId, chapterId: chapter.id, chapterFile: chapter.file, slug: world?.meta.slug ?? "", title: chapter.title, connection });
  const mixPlaying = mixPlayer.playing;
  const playing = (at !== null && at < playable.length && playback.status !== "ended" && playback.clip?.id === queueId) || mixPlaying;
  const play = useCallback(() => {
    if (world === null || playable.length === 0) return;
    clearQueue();
    dismissPlayback();
    // With a speaker chosen Play is that speaker's takes alone (R-33), which no mix is.
    if (timed && filter === null) {
      mixPlayer.play(0);
      return;
    }
    playable.forEach((row, index) => {
      void enqueueClip({
        id: queueId,
        url: mediaUrl(world.meta.slug, `artifacts/${row.artifact!.file}`),
        title: `${chapter.title} · ${row.mark}`,
        sub: `audiobook · ${row.mark} · ${index + 1} of ${playable.length}`,
        part: index,
      });
    });
  }, [world, playable, queueId, chapter.title, timed, filter, mixPlayer]);
  const mixClip = mixPlayer.clipId;
  const mixCancel = mixPlayer.cancel;
  const stopPlaying = useCallback(() => {
    const sounding_ = playbackSnapshot().clip?.id;
    if (sounding_ === queueId || sounding_ === mixClip) dismissPlayback();
    clearQueue();
    // A mix still rendering is not wanted any more either: its answer plays nothing.
    mixCancel();
  }, [queueId, mixClip, mixCancel]);
  useEffect(() => stopPlaying, [stopPlaying, chapter.id]);
  // A queue built for one filter is not another's: changing it stops what was playing.
  useEffect(() => stopPlaying, [stopPlaying, filter]);
  const mixAt = mixPlayer.at;
  const sounding = mixPlaying && mixAt !== null
    ? (() => {
        const bar = barAt(mixed, mixAt);
        return bar === null ? null : (rows.find((row) => row.block.key === (bar.kind === "reaction" ? (bar.under?.host ?? bar.key) : bar.key)) ?? null);
      })()
    : playing && at !== null ? (playable[at] ?? null) : null;

  // A cloned voice's recording leaving the machine (SPEC-022, SPEC-046): asked once, by the run's request.
  const [upload, setUpload] = useState<{ destination: string; token: string; notice?: string } | null>(null);
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== run?.requestId) return;
        // With what the vendor does with the clip (SPEC-046 R-17), as every other read shows it.
        setUpload({ destination: confirmation.destinationLabel, token: confirmation.confirmationToken, ...(confirmation.destinationNotice !== undefined ? { notice: confirmation.destinationNotice } : {}) });
      }),
    [run?.requestId],
  );

  const reading_ = run?.state === "reading";
  // The price confirmed and the run not yet heard from (2026-10-03): the coordinator prepares
  // the chapter before it says the run started, and for many seconds the Confirm button stood
  // as if unpressed, so the author pressed it again. Held to the run as it stood when pressed:
  // whatever the coordinator says next — a start, a progress, a refusal, a price asked again —
  // is a new run entry, and ends it.
  const [startingFrom, setStartingFrom] = useState<typeof run | null>(null);
  useEffect(() => setStartingFrom(null), [chapter.id]);
  const starting = startingFrom !== null && run === startingFrom;
  // The engine a cloned voice's recording was allowed to go to, kept across the one chain of
  // presses that answers a run's questions (codex on PR 1180, twice): a cast with a cloned voice
  // and a paid one is asked for consent first and the price second, and the price's answer must
  // carry the consent too, or the restarted run asks for consent again and the two prompts chase
  // each other for ever. It is the answer to one run's question, not this window's standing
  // permission: the run ending — read, stopped, failed, refused — the consent declined, a fresh
  // press or another chapter clears it, so a later read is asked again as the engine's
  // per-request rule says.
  const uploadAllowed = useRef<string | null>(null);
  // `Make again` reads these blocks alone (R-30), held across the same chain of answers as the
  // consent is, and cleared with it: the chapter's own press reads what is not made.
  const only = useRef<readonly string[] | null>(null);
  // The chapter's press casts the paragraphs left to cast first (design turn 198, rule 13), held
  // across the same chain of answers and cleared with it; the confirm's tick is the author's say.
  const castFirst = useRef(false);
  const [castTick, setCastTick] = useState(true);
  const ended = run !== undefined && run.state !== "reading" && run.state !== "priced";
  useEffect(() => {
    if (ended) {
      uploadAllowed.current = null;
      only.current = null;
      castFirst.current = false;
    }
  }, [ended]);
  useEffect(() => {
    uploadAllowed.current = null;
    only.current = null;
    castFirst.current = false;
  }, [chapter.id]);
  // Each price asked comes with the box ticked again, as Direct's sheet opens with it ticked.
  const askedToCast = run?.state === "priced" ? run.price?.toCast : undefined;
  useEffect(() => setCastTick(true), [askedToCast, run?.price?.confirmationToken]);
  const send = useCallback(
    (options: { confirmationToken?: string; voiceUploadConfirmedFor?: string } = {}): boolean => {
      const consent = options.voiceUploadConfirmedFor ?? uploadAllowed.current ?? undefined;
      const answers = {
        ...(options.confirmationToken !== undefined ? { confirmationToken: options.confirmationToken } : {}),
        ...(consent !== undefined ? { voiceUploadConfirmedFor: consent } : {}),
      };
      if (only.current !== null) return readAudiobookBlocks(worldId, prodId, chapter.file, only.current, answers);
      return readAudiobookChapter(worldId, prodId, chapter.file, { ...answers, ...(castFirst.current ? { castFirst: true } : {}) });
    },
    [worldId, prodId, chapter.file],
  );
  // What a press asks for goes out here, now or once the save lands (codex on PR 1186): the
  // workspace hands a deferred intent back through `resume`, so `Make again` kept past a save
  // still names its block, and every answer to a price or a consent carries it on.
  const resume = useCallback(
    (intent: AudiobookIntent) => {
      if (intent.kind === "open-direct") {
        setSelected(null);
        setDirectOpen(true);
        return;
      }
      if (intent.kind === "direct") {
        directChapter(worldId, prodId, chapter.file, intent.also);
        return;
      }
      if (intent.kind === "accept") {
        acceptDirection(worldId, prodId, chapter.id, chapter.file);
        return;
      }
      setUpload(null);
      uploadAllowed.current = null;
      only.current = intent.blocks ?? null;
      castFirst.current = intent.castFirst === true;
      send();
    },
    [worldId, prodId, chapter.id, chapter.file, send],
  );
  const press = useCallback(
    (blocks: readonly string[] | null) => {
      if (locked || connection !== "open" || reading_) return;
      // Unsaved typing is not what is read (R-2): the press waits out the autosave, as the
      // chapter's other reads do, and the workspace sends it once the save lands.
      // The chapter's read under a reading that needs the cast casts what is left first (design
      // turn 198): ticked by default in the confirm, and done at once where nothing is asked.
      const castingFirst = blocks === null && reading !== "narrator" && toCast.length > 0;
      const intent: AudiobookIntent = { kind: "read", ...(blocks !== null ? { blocks } : {}), ...(castingFirst ? { castFirst: true } : {}) };
      if (input.beforeRead !== undefined && !input.beforeRead(intent)) return;
      resume(intent);
    },
    [locked, connection, reading_, input, resume, reading, toCast.length],
  );
  const begin = useCallback(() => press(null), [press]);
  const makeAgain = useCallback((key: string) => press([key]), [press]);

  // `Direct this chapter` (R-10): the same saved words the read is made from, so the press
  // waits out the autosave the same way; the card is the run's result, held in the store.
  const directionRun = heldRun;
  // The dock's press opens the Direct sheet (design turn 184a): what the director reads, and
  // what else to ask for, before anything runs. The sheet's Direct is the press that sends.
  const [directOpen, setDirectOpen] = useState(false);
  useEffect(() => setDirectOpen(false), [chapter.id]);
  const directPress = useCallback(() => {
    if (locked || connection !== "open" || directionRun?.state === "directing" || directionRun?.state === "accepting") return;
    // The sheet reads the saved words (codex on PR 1479): unsaved typing is saved first, and the
    // sheet opens once it lands, so Reads describes the chapter Direct will send. It takes the
    // block panel's place, so a block pressed before is put down.
    const intent: AudiobookIntent = { kind: "open-direct" };
    if (input.beforeRead !== undefined && !input.beforeRead(intent)) return;
    resume(intent);
  }, [locked, connection, directionRun?.state, input, resume]);
  // A block pressed while the sheet is open takes the panel back.
  useEffect(() => {
    if (selected !== null) setDirectOpen(false);
  }, [selected]);
  const direct = useCallback((also: DirectAlso) => {
    if (locked || connection !== "open" || directionRun?.state === "directing" || directionRun?.state === "accepting") return;
    setDirectOpen(false);
    const intent: AudiobookIntent = { kind: "direct", also };
    if (input.beforeRead !== undefined && !input.beforeRead(intent)) return;
    resume(intent);
  }, [locked, connection, directionRun?.state, input, resume]);
  // Accepting waits out the autosave too (codex on PR 1186): a card accepted against words the
  // save is about to replace would be refused by the coordinator only if it saw them first.
  const accept = useCallback(() => {
    if (input.beforeRead !== undefined && !input.beforeRead({ kind: "accept" })) return;
    resume({ kind: "accept" });
  }, [input, resume]);
  // A direction stands only where its words still do (codex on PR 1186): the record keeps
  // entries keyed to earlier wording, and those are none to the dock's prompt.
  const directedBlocks = useMemo(() => rows.filter((row) => audiobookDirectionFor(recordOrNull, row.block) !== null).length, [rows, recordOrNull]);
  const discard = useCallback(() => dismissDirection(worldId, prodId, chapter.id, chapter.file), [worldId, prodId, chapter.id, chapter.file]);
  const setDirection = useCallback(
    (key: string, direction: AudiobookDirectionInput | null) => {
      if (locked || connection !== "open") return;
      setAudiobookBlock(worldId, prodId, chapter.file, key, direction);
    },
    [locked, connection, worldId, prodId, chapter.file],
  );
  const lastRecord = useAudiobookRecords()[`${worldId}/${prodId}/${chapter.id}`];

  // Block seams (design turn 198): Join and Split on a gap, Reset on them all, written on the
  // record and read nowhere else. Not while a read runs, as the notes cannot change then (194). A
  // block a seam change puts back in a shape it had, found made again with nothing to read, says
  // `made` in green until the author leaves the view: the made blocks are noted at the press and
  // compared once the record answers.
  const seamView = derived.seams;
  const seamLabel = audiobookSeamLabel(seamView);
  // Group by beats (design turn 201): while the director reads, the press says so and the chapter's
  // other presses that reshape or read it wait (rule 3), as they do for a direction.
  const beatRun = useBeatRuns()[`${worldId}/${prodId}/${chapter.id}`];
  const beatGrouping = beatRun?.state === "grouping";
  const seamsHeld = locked || connection !== "open" || reading_ || beatGrouping;
  const madeAtPress = useRef<{ made: ReadonlySet<string>; updatedAt: string | null } | null>(null);
  const [madeAgain, setMadeAgain] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    madeAtPress.current = null;
    setMadeAgain(new Set());
  }, [chapter.id]);
  const notePress = useCallback(() => {
    madeAtPress.current = { made: new Set(rows.filter((row) => row.state === "made").map(blockIdentity)), updatedAt: recordOrNull?.updatedAt ?? null };
  }, [rows, recordOrNull?.updatedAt]);
  useEffect(() => {
    const held = madeAtPress.current;
    if (held === null || (recordOrNull?.updatedAt ?? null) === held.updatedAt) return;
    madeAtPress.current = null;
    const again = rows.filter((row) => row.state === "made" && !held.made.has(blockIdentity(row))).map(blockIdentity);
    if (again.length > 0) setMadeAgain((was) => new Set([...was, ...again]));
  }, [rows, recordOrNull?.updatedAt]);
  useEffect(() => {
    if (lastRecord?.refused !== undefined) madeAtPress.current = null;
  }, [lastRecord?.seq, lastRecord?.refused]);
  const pressSeam = useCallback(
    (gap: AudiobookGap) => {
      if (seamsHeld || gap.anchor === undefined || (gap.press === "join" && gap.limit !== undefined)) return;
      notePress();
      setAudiobookSeam(worldId, prodId, chapter.file, gap.press, gap.anchor);
    },
    [seamsHeld, notePress, worldId, prodId, chapter.file],
  );
  const resetSeams = useCallback(() => {
    if (seamsHeld) return;
    notePress();
    resetAudiobookSeams(worldId, prodId, chapter.file);
  }, [seamsHeld, notePress, worldId, prodId, chapter.file]);
  // Under Cast each voice is read apart, so a beat could join nothing (rule 2): off, said there only.
  const groupOff = reading === "cast" ? "Cast · voices apart" : undefined;
  const groupBeats = useCallback(() => {
    if (seamsHeld || groupOff !== undefined) return;
    notePress();
    groupChapterBeats(worldId, prodId, chapter.file);
  }, [seamsHeld, groupOff, notePress, worldId, prodId, chapter.file]);
  // A take a person recorded (turn 155c): the host's picker opens for the block, the checks come
  // back as a dialog, and the keep answers as the block's record does.
  const [uploadId, setUploadId] = useState<string | null>(null);
  const staged = useStagedTakes()[uploadId ?? ""];
  useEffect(() => setUploadId(null), [chapter.id]);
  const uploadTake = useCallback(
    (key: string) => {
      if (locked || connection !== "open") return;
      if (uploadId !== null) discardAudiobookTake(worldId, uploadId);
      setUploadId(stageAudiobookTake(worldId, prodId, chapter.file, key));
    },
    [locked, connection, uploadId, worldId, prodId, chapter.file],
  );
  const closeUpload = useCallback(() => {
    if (uploadId !== null) discardAudiobookTake(worldId, uploadId);
    setUploadId(null);
  }, [uploadId, worldId]);
  const uploadRow = staged === undefined ? null : (rows.find((row) => row.block.key === staged.block) ?? null);
  const uploadDialog =
    uploadId !== null && staged !== undefined && staged.state !== "choosing" && uploadRow !== null ? (
      <RecordedTakeDialog
        staged={staged}
        row={uploadRow}
        onCancel={closeUpload}
        onReplace={() => uploadTake(uploadRow.block.key)}
        onKeep={(basis, performer) => keepAudiobookTake(worldId, uploadId, basis, performer)}
      />
    ) : null;
  // Kept: the store lets the entry go when the record answers, and the dialog with it.
  useEffect(() => {
    if (uploadId !== null && staged === undefined) setUploadId(null);
  }, [uploadId, staged]);

  // Only edited paragraphs need casting (design turn 198, rule 13): the two casts the toolbar's
  // press offers, the rail's Cast again and, below 1100, the head of the ⋯ menu.
  const casting = input.casting;
  const castItems: ToolMenuItem[] = casting === undefined || toCast.length === 0
    ? []
    : [
        { key: "cast-changed", label: `Cast ${toCast.length} paragraph${toCast.length === 1 ? "" : "s"}`, state: "", disabled: casting.busy || locked || connection !== "open", press: () => casting.press("changed"), testId: "cast-changed" },
        { key: "cast-chapter", label: "Cast the chapter", state: String(paragraphCount), disabled: casting.busy || locked || connection !== "open", press: () => casting.press(), testId: "cast-chapter" },
      ];
  const castPress = castItems.length === 0 ? null : <CastPress count={toCast.length} items={castItems} busy={casting?.busy === true} />;
  const directable = rows.length > 0 && proposal === null && directionRun?.state !== "directing";
  // The head in its two parts (design turn 194, rule 15): the Direct and illustrate menu and the
  // read's own control. Wide, they are one control on the toolbar line; below 1100 the menu is the
  // line's ⋯ and the read is held at the foot beside Listen. A state that takes the whole head — an
  // upload to confirm, a price to confirm, a read running — is the read's part and leaves no menu.
  const whole = (node: ReactNode) => ({ node, menu: null as ReactNode, read: node });
  const headParts = (() => {
    if (upload !== null && run?.state !== "read") {
      return whole(
        <RemoteVoiceUploadConfirmation
          destinationLabel={upload.destination}
          destinationNotice={upload.notice}
          onCancel={() => {
            setUpload(null);
            uploadAllowed.current = null;
            dismissAudiobookRun(worldId, prodId, chapter.id);
          }}
          onConfirm={() => {
            uploadAllowed.current = upload.token;
            setUpload(null);
            send({ voiceUploadConfirmedFor: upload.token });
          }}
        />
      );
    }
    if (run?.state === "priced" && run.price !== undefined) {
      // Every quote has one modal review; the toolbar never duplicates its spend control.
      return whole(<Button variant="primary" disabled data-testid="read-audiobook">Review read · {speechPricePrefix(models, run.price.voices.map((voice) => voice.provider))}{formatMicroUsd(run.price.estimatedMicroUsd)}</Button>);
    }
    if (reading_) {
      return whole(
        <span className="fy-ab__control fy-ab__read-progress">
          <span className="fy-mono" data-testid="audiobook-progress">
            {activity ? <><b>{audiobookActivityStage(activity).replace("Aligning locally", "Aligning")}</b><span className="fy-ab__read-saved">{activity.made} of {activity.toMake} blocks saved</span></> : run.requests !== undefined ? `reading… request ${Math.max(1, run.request ?? 1)} of ${run.requests} · ${run.made} of ${run.toMake}` : `reading… ${run.made} of ${run.toMake}`}
          </span>
          <Button variant="ghost" disabled={activity?.phase === "stopping"} onClick={() => stopAudiobook(worldId, prodId, chapter.file)}>
            {activity?.phase === "stopping" ? "Stopping…" : "Stop"}
          </Button>
        </span>
      );
    }
    // Direct, Illustrate this chapter and Looks are one menu (design turn 194, rule 3), each with
    // its state at the right; the presses and their handlers are the ones the head carried. While a
    // run directs or illustrates, its count — and Stop where the run has one — stands in the menu's
    // place, as the head did: a menu of things that cannot be pressed says nothing.
    const directing = directionRun?.state === "directing" || directionRun?.state === "accepting";
    const running = directing
      ? { line: directionRun?.state === "accepting" ? "accepting…" : "directing…" }
      : input.illustrate?.running;
    // On a phone the Blocks press is in this menu (design turn 198, rule 10): Reset, with what it puts back.
    const seamReset: ToolMenuItem[] = input.seamsInMenu === true && seamLabel !== null
      ? [{ key: "blocks-reset", label: "Reset", state: `Blocks · ${seamLabel}`, disabled: seamsHeld, press: resetSeams, testId: "audiobook-blocks-reset" }]
      : [];
    // Group by beats is the menu's first item there (design turn 201, rule 5), with its mark.
    const beatGroup: ToolMenuItem[] = input.seamsInMenu === true
      ? [{ key: "blocks-group", label: "Group by beats", mark: <GroupMark size={14} />, state: beatGrouping ? "grouping…" : (groupOff ?? `${rows.length} blocks`), disabled: seamsHeld || groupOff !== undefined, press: groupBeats, testId: "audiobook-blocks-group" }]
      : [];
    const menu = rows.length === 0 ? null : running !== undefined ? (
      <span className="fy-ab__control" data-testid="audiobook-run-line">
        <span className="fy-mono">{running.line}</span>
        {"stop" in running && running.stop !== undefined && (
          <button type="button" className="fy-ab__pill" onClick={running.stop} data-testid="audiobook-run-stop">
            Stop
          </button>
        )}
      </span>
    ) : (
      <ToolMenu
        label="Direct and illustrate"
        testId="direct-illustrate"
        icon={input.compact === true}
        // On a phone the lines to cast head the menu (design turn 198j), Reset beside them over Direct and illustrate.
        {...(input.seamsInMenu === true && castItems.length > 0 ? { lead: { head: paragraphsToCast(toCast.length), items: castItems, also: seamReset } } : {})}
        items={[
          ...(input.readingInMenu !== undefined
            ? [{ key: "reading", label: `${READINGS.find((r) => r.reading === input.reading)?.label ?? input.reading} · ${narrator.label ?? input.readingInMenu.narrator}`, state: "reading", disabled: false, press: input.readingInMenu.open, testId: "audiobook-reading-item" }]
            : []),
          ...beatGroup,
          {
            key: "direct",
            label: directedBlocks > 0 ? "Direct again" : "Direct this chapter",
            state: proposal !== null ? "proposed" : directedBlocks > 0 ? "directed" : "",
            // A held proposal answers the press until it is accepted or discarded (turn 184b).
            disabled: !directable || locked || connection !== "open" || beatGrouping,
            press: directPress,
            testId: "direct-audiobook",
          },
          ...(input.illustrate !== undefined
            ? [{
                key: "illustrate",
                label: input.illustrate.again ? "Illustrate again" : "Illustrate this chapter",
                state: input.illustrate.state ?? "",
                disabled: locked || connection !== "open" || input.illustrate.busy,
                press: input.illustrate.press,
                testId: "illustrate-chapter",
              }]
            : []),
          ...(input.looks !== undefined
            ? [{ key: "looks", label: "Looks", state: input.looks.state ?? "", disabled: connection !== "open", press: input.looks.open, testId: "audiobook-looks-open" }]
            : []),
          // On a phone the Blocks press is in this menu (design turn 198, rule 10): Reset, with what it puts back.
          ...(castItems.length === 0 ? seamReset : []),
        ]}
      />
    );
    // The read leads until a block is made and Listen takes the fill (turn 188). Short of room it
    // says `Read · price` (194, rule 1): the tails are their own boxes so the centre's container
    // query can drop them and keep the toolbar on one line.
    const read = counts.toMake.length > 0 ? (
      <button type="button" className={`fy-ab__pill${input.listenLeads === true ? "" : " fy-ab__pill--pri"}`} disabled={locked || connection !== "open" || beatGrouping} onClick={begin} data-testid="read-audiobook">
        <span>Read<span className="fy-ab__presstail"> the chapter</span></span>
        {SPOKEN_GAP}
        {(() => {
          const price = chapterEstimate > 0 ? `${tokenPriced ? "~" : ""}${formatMicroUsd(chapterEstimate)}` : plan;
          return (
            <em>
              <span className="fy-ab__presstail">· {counts.toMake.length} block{counts.toMake.length === 1 ? "" : "s"}{grouping.groups.length > 0 ? ` · ${grouping.requests} request${grouping.requests === 1 ? "" : "s"}` : ""}{price !== null ? " " : ""}</span>
              {price !== null ? `· ${price}` : ""}
            </em>
          );
        })()}
      </button>
    ) : null;
    return {
      node: (
        <span className="fy-ab__control">
          {menu}
          {read}
        </span>
      ),
      menu,
      read,
    };
  })();
  const head = headParts.node;

  // The chapter's Play, the mix as it will be heard (146's check), is the round press at the left of
  // the foot line (design turn 194, rule 4); while it plays the foot says the block and the time,
  // and the press stops it. Listen stays the book in the player.
  const footPlay = mixPlaying ? (
    <>
      <button type="button" className="fy-ab__footplay" onClick={stopPlaying} aria-label="Stop" data-testid="audiobook-stop">
        <span className="fy-ab__footplay-dot fy-ab__footplay-dot--stop" aria-hidden="true" />
      </button>
      <span className="fy-ab__footplay-at" data-testid="audiobook-mix-at">
        {sounding?.mark ?? ""} · {clock(mixAt ?? 0)}
      </span>
    </>
  ) : playing ? (
    <>
      <button type="button" className="fy-ab__footplay" onClick={stopPlaying} aria-label="Stop" data-testid="audiobook-stop">
        <span className="fy-ab__footplay-dot fy-ab__footplay-dot--stop" aria-hidden="true" />
      </button>
      <span className="fy-ab__footplay-at">
        {sounding?.mark ?? ""} · {(at ?? 0) + 1} of {playable.length}
      </span>
      <button type="button" className="fy-ab__footlink" disabled={at === null || at + 1 >= playable.length} onClick={() => jumpQueue((at ?? 0) + 1)}>
        Skip
      </button>
    </>
  ) : (
    <button type="button" className="fy-ab__footplay" onClick={play} disabled={playable.length === 0 || mixPlayer.pending} data-testid="audiobook-play">
      <span className="fy-ab__footplay-dot" aria-hidden="true">
        <PlaySolid size={10} />
      </span>
      {mixPlayer.pending ? "Mixing…" : "Play"}
    </button>
  );

  const note =
    record === "unreadable"
      ? "record unreadable · Read the chapter replaces it"
      : run?.state === "refused" || run?.state === "failed" || run?.state === "unavailable"
        ? freePlanNote(run.reason) ?? `could not read · ${run.reason ?? "the run failed"}`
        : run?.state === "stopped"
          ? "stopped · the takes made stand"
          : null;

  // The sheet a grouped read is confirmed in (design turn 185a): blocks, requests, a block a
  // request, Google's free day where it is known, the estimate.
  const readSheet = run?.state === "priced" && run.price !== undefined
    ? {
        token: run.price.confirmationToken,
        title: only.current?.length === 1 ? `Read ${blockReadTarget(only.current[0]!, rows)} · Chapter ${chapter.order}` : `Read Chapter ${chapter.order}`,
        blocks: run.toMake,
        characters: run.price.characters,
        free: run.price.estimatedMicroUsd === 0,
        notices: run.price.notices,
        destinations: run.price.voices.map((voice) => `${voice.label} · ${readerPlace(voice.provider)}`).join(" · "),
        requests: run.price.requests,
        perParagraph: run.price.perParagraph ?? run.toMake,
        voice: run.price.voices.map((voice) => voice.label).join(" · "),
        ...(run.price.freePlan !== undefined ? { freeDay: run.price.freePlan } : {}),
        estimate: `${speechPricePrefix(models, run.price.voices.map((voice) => voice.provider))}${formatMicroUsd(run.price.estimatedMicroUsd)}`,
        starting,
        ...(run.price.toCast !== undefined ? { castFirst: { count: run.price.toCast, on: castTick, set: setCastTick } } : {}),
        confirm: () => {
          if (run.price !== undefined && send({ confirmationToken: run.price.confirmationToken })) setStartingFrom(run);
        },
        cancel: () => dismissAudiobookRun(worldId, prodId, chapter.id),
      }
    : null;
  // Re-read with neighbours (design turn 185c): the block before, the block, the block after, one request.
  const reReadPrice = useCallback(
    (key: string): string | null => {
      const at = rows.findIndex((row) => row.block.key === key);
      const row = rows[at];
      const model = row === undefined ? null : modelOf(row.speaker);
      if (row === undefined || model === null) return null;
      const label = speechPlanLabel(model);
      if (label !== null) return label;
      const near = [rows[at - 1], row, rows[at + 1]].filter((candidate): candidate is BlockRow => candidate !== undefined && candidate.speaker.voiceId === row.speaker.voiceId && candidate.speaker.provider === row.speaker.provider);
      const turns = packTurnsFor(near);
      return `~${formatMicroUsd(quoteGroupedSpeech(model, turns).expectedMicroUsd)}`;
    },
    [rows, modelOf],
  );
  const keepSplit = useCallback(
    (key: string) => {
      if (locked || connection !== "open") return;
      keepAudiobookSplit(worldId, prodId, chapter.file, key);
    },
    [locked, connection, worldId, prodId, chapter.file],
  );
  // The margin's brackets (design turn 185a, 185b): the run's own requests while it reads and
  // after, the requests a press would make otherwise; each labelled in one mono line.
  const brackets = useMemo(() => {
    const state = new Map(rows.map((row) => [row.block.key, row.state]));
    const ran = run?.groups !== undefined && run.groups.length > 0 ? run.groups : null;
    const source = ran ?? grouping.groups.map((group) => group.keys);
    return source.map((keys, index) => {
      const numbered = grouping.groupOf.get(keys[0]!);
      // The run's own requests are numbered as it sent them; a press's, as the blocks fall.
      const number = ran !== null ? index + 1 : (numbered?.request ?? index + 1);
      const made = keys.filter((key) => state.get(key) === "made").length;
      const now = reading_ && run?.requestKeys?.[0] === keys[0];
      const label = now
        ? `request ${number} · reading`
        : made === keys.length
          ? `request ${number} · made · ${made} of ${keys.length}`
          : made > 0
            ? `request ${number} · ${made} of ${keys.length} made`
            : `request ${number} · ${keys.length} blocks${numbered !== undefined ? ` · ~${Math.max(1, Math.round(numbered.seconds / 60))} min` : ""}`;
      return { keys, label, now };
    });
  }, [rows, run, grouping, reading_]);

  return {
    rows,
    counts,
    estimate: chapterEstimate,
    grouping,
    readSheet,
    keepSplit,
    reReadPrice,
    brackets,
    filter,
    setFilter,
    filters,
    head,
    /** The head in two parts for below 1100 (design turn 194, rule 15): the menu as the toolbar's ⋯, the read to be held at the foot. */
    headMenu: headParts.menu,
    /** The paragraphs an edit left to cast (design turn 198), by index now; `2 paragraphs to cast ▾` and its two casts, for the toolbar and the rail. */
    toCast,
    paragraphCount,
    castItems,
    castPress,
    headRead: headParts.read,
    /** The foot line's Play (design turn 194, rule 4), and why the mix could not play where it could not. */
    footPlay,
    mixRefused: mixPlaying ? null : mixPlayer.refused,
    note,
    selected,
    setSelected,
    sounding,
    playable,
    run,
    narrator,
    modelOf,
    makeAgain,
    resume,
    directionRun,
    directedBlocks,
    directPress,
    directOpen,
    closeDirect: () => setDirectOpen(false),
    direct,
    accept,
    discard,
    setDirection,
    marker,
    setMarker,
    /** The last write outside a run — a block's direction set or refused (R-9): the refusal is said on the panel. */
    lastRecord,
    uploadTake,
    uploadDialog,
    /** The chapter's clock with its timing (design turn 187): the Timing view's bars and the block panel's values. */
    timing,
    /** The mix's clock: what Play hears, a block not made skipped. */
    mixed,
    timed,
    mixPlayer,
    /**
     * Block seams (design turn 198): every gap a press can change and why one cannot, the Blocks
     * press's data (null when no seam is set), Join or Split pressed, Reset, whether they wait on a
     * read, and the blocks made again at no cost since the view opened.
     */
    seams: { gaps: seamView.gaps, label: seamLabel, changed: seamView.changed, notRead: rows.filter((row) => row.block.shaped === true && row.state === "not made").length, press: pressSeam, reset: resetSeams, held: seamsHeld, madeAgain },
    /**
     * The Blocks press (design turn 201, rule 1): always in the toolbar once the chapter has
     * blocks, its data the block count, the seams' label, `N beats` or `grouping…`, and its menu's
     * Group by beats and Reset.
     */
    blocks: rows.length === 0 ? null : {
      label: beatGrouping ? "grouping…" : (() => {
        const beats = audiobookBeatCount(recordOrNull?.beats, rows.map((row) => row.block));
        return beats > 0 ? `${beats} beat${beats === 1 ? "" : "s"}` : (seamLabel ?? String(rows.length));
      })(),
      count: rows.length,
      changed: seamView.changed,
      resettable: (recordOrNull?.seams?.length ?? 0) > 0 || (recordOrNull?.beats?.length ?? 0) > 0,
      held: seamsHeld,
      grouping: beatGrouping,
      ...(groupOff !== undefined ? { groupOff } : {}),
      ...(beatRun !== undefined && beatRun.state !== "grouping" && beatRun.state !== "grouped" && beatRun.reason !== undefined ? { groupNote: beatRun.reason } : {}),
      onGroup: groupBeats,
      onReset: resetSeams,
    },
  };
}

/** One press's place among the gaps, for the confirm it may open. */
function seamKey(gap: Pick<AudiobookGap, "press" | "block" | "row">): string {
  return `${gap.press}:${gap.block}:${gap.row ?? ""}`;
}

/** A block as it was made: its key and its words, the two a take is found by. */
function blockIdentity(row: Pick<BlockRow, "block">): string {
  return `${row.block.key}\n${audiobookTextHash(row.block.text)}`;
}

/** The three readings as the head's menu offers them, each with its data (turn 165a). */
const READINGS: ReadonlyArray<{ reading: AudiobookReading; label: string; data: string }> = [
  { reading: "narrator", label: "Narrator", data: "one voice" },
  { reading: "performed", label: "Performed", data: "notes" },
  { reading: "cast", label: "Cast", data: "cast voices" },
];

/**
 * The reading in the chapter's head (design turn 165a): `Performed · Charon`, a menu of the three
 * readings — the book's, written as the door's seg writes it — and `Narrator…`. The build had no
 * reading on the chapter and no way into `Performed` from it (issue 1324 §3).
 */
export function ReadingMenu({ reading, narrator, disabled, onReading, onNarrator, external }: {
  /** Drawn without its own press, opened from the toolbar's ⋯ (design turn 203). */
  external?: { open: boolean; onClose: () => void };
  reading: AudiobookReading;
  /** The narrator the book reads in, by name. */
  narrator: string;
  /** A run is going: the door's seg refuses a change then, and so does this. */
  disabled: boolean;
  onReading: (reading: AudiobookReading) => void;
  onNarrator: () => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = external !== undefined ? external.open : ownOpen;
  const setOpen = (next: boolean | ((was: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(open) : next;
    if (external !== undefined) {
      if (!value) external.onClose();
    } else setOwnOpen(value);
  };
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const label = READINGS.find((r) => r.reading === reading)?.label ?? reading;
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const away = (event: MouseEvent) => {
      if (menu.current?.contains(event.target as Node) || button.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };
  return (
    <span className={external !== undefined ? "fy-ab__reading fy-ab__reading--external" : "fy-ab__reading"}>
      {external === undefined && <button
        ref={button}
        type="button"
        className={`fy-ab__reading-press fy-mono${open ? " fy-ab__reading-press--open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Reading · the whole book"
        onClick={() => setOpen((was) => !was)}
        data-testid="audiobook-reading"
      >
        <span className="fy-ab__reading-k">{label} ·</span> <b>{narrator}</b>
        <ChevronDown size={13} stroke={2} aria-hidden="true" />
      </button>}
      {open && (
        <div ref={menu} className="fy-ab__menu fy-ab__reading-menu" role="menu" aria-label="Reading" onKeyDown={onKey}>
          <p className="fy-ab__menu-eb">Reading · whole book</p>
          {READINGS.map((r) => (
            <button
              key={r.reading}
              type="button"
              role="menuitemradio"
              aria-checked={r.reading === reading}
              aria-disabled={disabled && r.reading !== reading}
              className={`fy-ab__menu-opt${r.reading === reading ? " fy-ab__menu-opt--on" : ""}`}
              onClick={() => {
                if (disabled || r.reading === reading) return close(true);
                onReading(r.reading);
                close(true);
              }}
            >
              <span className="fy-ab__menu-tick" aria-hidden="true">{r.reading === reading ? "✓" : ""}</span>
              <span className="fy-ab__menu-label">{r.label}</span>
              <span className="fy-ab__menu-meta">{r.data}</span>
            </button>
          ))}
          <div className="fy-ab__menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="fy-ab__menu-opt"
            onClick={() => {
              setOpen(false);
              onNarrator();
            }}
          >
            <span className="fy-ab__menu-tick" aria-hidden="true" />
            <span className="fy-ab__menu-label">Narrator…</span>
            <span className="fy-ab__menu-meta">{narrator}</span>
          </button>
        </div>
      )}
    </span>
  );
}

/** The manuscript column in the Audiobook view: a row a block, the reader in the margin, the state as a dot. */
/** Who a block can be given to (SPEC-012 R-63): the chapter's speakers first, then the rest of the cast. */
export interface SpeakerChoices {
  chapter: { key: string; label: string; sheet?: string; colour: number | null }[];
  cast: { sheet: string; label: string; voice: string | null; colour: number | null }[];
}

/** What a choice in the speaker menu writes: a speaker, narration, or the correction taken back. */
export type SpeakerPick = { speaker: string; sheet?: string } | { narration: true } | { clear: true };

/** The raw offsets of a selection inside a block's text, which holds the text alone. */
function rawSelection(host: HTMLElement): { from: number; to: number } | null {
  const selection = typeof window === "undefined" ? null : window.getSelection?.();
  if (selection === null || selection === undefined || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;
  const offset = (node: Node, at: number) => {
    const before = document.createRange();
    before.selectNodeContents(host);
    before.setEnd(node, at);
    return before.toString().length;
  };
  const a = offset(range.startContainer, range.startOffset);
  const b = offset(range.endContainer, range.endOffset);
  return a === b ? null : { from: Math.min(a, b), to: Math.max(a, b) };
}

/** The speaker menu (design turn 155b, SPEC-012 R-63): a search, this chapter's speakers, the rest of the cast. */
function SpeakerMenu({ row, choices, onPick, onClose }: {
  row: BlockRow;
  choices: SpeakerChoices;
  onPick: (pick: SpeakerPick) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const match = (label: string) => label.toLowerCase().includes(query.trim().toLowerCase());
  const typed = query.trim();
  const known = [...choices.chapter.map((who) => who.label), ...choices.cast.map((who) => who.label)].some((label) => label.toLowerCase() === typed.toLowerCase());
  const option = (key: string, label: string, tone: string, current: boolean, pick: SpeakerPick, meta?: string) => (
    <button key={key} type="button" role="menuitem" className="fy-ab__menu-opt" onClick={() => onPick(pick)}>
      <i className={`fy-ab__speaker-dot fy-voice--${tone}`} aria-hidden="true" />
      <span className="fy-ab__menu-label">{label}</span>
      {meta !== undefined && <span className="fy-ab__menu-meta">{meta}</span>}
      {current && <span className="fy-ab__menu-tick" aria-label="current">✓</span>}
    </button>
  );
  return (
    <div className="fy-ab__menu" role="menu" aria-label="Speaker" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.key === "Escape" && onClose()}>
      <input
        className="fy-ab__menu-search"
        placeholder="Speaker"
        aria-label="Speaker"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && typed !== "" && !known) onPick({ speaker: typed });
        }}
      />
      <div className="fy-ab__menu-eb">In this chapter</div>
      {match("Narration") && option("narration", "Narration", "narrator", row.speakerKey === null, { narration: true })}
      {choices.chapter.filter((who) => match(who.label)).map((who) =>
        option(`c:${who.key}`, who.label, who.sheet === undefined ? "none" : String(who.colour ?? "none"), row.speakerKey === who.key, { speaker: who.label, ...(who.sheet !== undefined ? { sheet: who.sheet } : {}) }),
      )}
      {choices.cast.some((who) => match(who.label)) && <div className="fy-ab__menu-eb">Cast</div>}
      {choices.cast.filter((who) => match(who.label)).map((who) =>
        option(`s:${who.sheet}`, who.label, who.colour === null ? "plain" : String(who.colour), false, { speaker: who.label, sheet: who.sheet }, who.voice ?? "no voice"),
      )}
      {typed !== "" && !known && option("typed", `“${typed}”`, "none", false, { speaker: typed }, "no sheet")}
      {row.block.pinned === true && (
        <>
          <div className="fy-ab__menu-sep" />
          <button type="button" role="menuitem" className="fy-ab__menu-opt" onClick={() => onPick({ clear: true })}>
            <span className="fy-ab__menu-label">Undo correction</span>
          </button>
        </>
      )}
    </div>
  );
}

export function AudiobookBlocks({ rows, sounding, selected, onSelectionChange, onSelect, onPlayOne, slug, filter = null, choices, onPin, marker = null, onMarker, modelOf, onDirect, brackets = [], onReRead, reReadPrice, pictures, seams, madeAgain }: {
  /**
   * Block seams (design turn 198): the gaps a fine pointer can press, a Join on the bracket line
   * between two blocks and a Split between two rows of one, drawn on hover. Absent while a read
   * runs, and on touch, where the block's sheet carries them.
   */
  seams?: { gaps: readonly AudiobookGap[]; onPress: (gap: AudiobookGap) => void };
  /** Blocks made again at no cost by a seam change (198g), by key and words: `made` in green. */
  madeAgain?: ReadonlySet<string>;
  /** What reading a block again with its neighbours would cost, as its button says it. */
  reReadPrice?: (key: string) => string | null;
  rows: BlockRow[];
  /** Each grouped request's blocks (design turn 185a, 185b), bracketed in the margin under a mono label; dark while it is read. */
  brackets?: ReadonlyArray<{ keys: readonly string[]; label: string; now: boolean }>;
  /** A flagged split read again with its neighbours, one request (design turn 185c). */
  onReRead?: (key: string) => void;
  sounding: BlockRow | null;
  selected: string | null;
  onSelect: (key: string) => void;
  onSelectionChange?: (selection: BlockSelection | null) => void;
  onPlayOne: (row: BlockRow) => void;
  slug: string | undefined;
  filter?: AudiobookFilter;
  /** Offered only while the cast is current and can be written (SPEC-012 R-62): who a block can be given to. */
  choices?: SpeakerChoices;
  /** A choice made for a block, or for words selected inside a narration block. */
  onPin?: (row: BlockRow, pick: SpeakerPick, selection?: { from: number; to: number }) => void;
  /** The marker menu, where it is open (R-42); the view's, so the side can open it too. */
  marker?: MarkerAt | null;
  onMarker?: (at: MarkerAt | null) => void;
  modelOf?: (reader: AudiobookReader) => ManifestModel | null;
  /** A block's direction written with its markers changed (R-42). */
  onDirect?: (key: string, direction: AudiobookDirectionInput | null) => void;
  /** The pictures set on blocks (design turn 186c): a chip in the margin with when each starts. */
  pictures?: { byKey: ReadonlyMap<string, PictureSpan>; estimated: boolean; /** Proposed by Arke and not yet accepted (191b): a dashed chip with a short title. */ proposed?: ReadonlyMap<string, { title: string }> };
}) {
  const coarse = useMediaQuery("(pointer: coarse)");
  const pressedSelection = useRef<BlockSelection | null>(null);
  const [menu, setMenu] = useState<{ key: string; selection?: { from: number; to: number } } | null>(null);
  // The join that would take a picture off, asking (design turn 198d); closed by Cancel, Escape or a press elsewhere.
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (confirming === null) return;
    const close = () => setConfirming(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", escape);
    };
  }, [confirming]);
  useEffect(() => {
    const changed = () => {
      const captured = audiobookSelection(rows);
      // A sheet takes focus; the captured selection remains the subject of its controls.
      if (captured !== null) onSelectionChange?.(captured);
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, [rows, onSelectionChange]);
  useEffect(() => {
    if (menu === null) return;
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);
  const markable = onMarker !== undefined && onDirect !== undefined;
  useEffect(() => {
    if (marker === null || onMarker === undefined) return;
    const close = () => onMarker(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [marker, onMarker]);
  // `[` places a marker (R-42): the view has no text to edit, so the key opens the menu at the
  // words selected, or at the caret, rather than typing a bracket.
  useEffect(() => {
    if (!markable) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "[" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const opened = markerAtSelection(rows);
      if (opened === null) return;
      event.preventDefault();
      onMarker(opened);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [markable, rows, onMarker]);
  if (rows.length === 0) return <p className="fy-bible__empty">Nothing to read yet.</p>;
  const pinnable = choices !== undefined && onPin !== undefined;
  // The seams a fine pointer finds on hover (design turn 198, rules 1 and 15): each Join on the
  // line above its block, each Split on the rule between two rows. Touch has the block's sheet.
  const hovers = seams !== undefined && !coarse;
  const joinAbove = new Map((hovers ? seams.gaps : []).filter((gap) => gap.press === "join").map((gap) => [gap.block, gap] as const));
  const splitsIn = (key: string) => (hovers ? seams.gaps : []).filter((gap) => gap.press === "split" && gap.block === key);
  const seamPress = (gap: AudiobookGap, row: BlockRow) => {
    const off = gap.press === "join" && gap.limit !== undefined;
    const word = gap.press === "join" ? "Join" : "Split";
    const id = seamKey(gap);
    // A join that would take a picture off its block asks once, in one plain line (rule 6, 198d):
    // the block above shows its own picture, so the one below comes off. Every other is at once.
    const above = rows[rows.indexOf(row) - 1];
    const losing = gap.press === "join" && above !== undefined && pictures?.byKey.has(above.block.key) === true && pictures.byKey.has(row.block.key);
    return (
      <span className={`fy-ab__seam${gap.press === "split" ? " fy-ab__seam--in" : ""}${off ? " fy-ab__seam--off" : ""}${confirming === id ? " fy-ab__seam--open" : ""}`} data-testid="audiobook-seam" onClick={(event) => event.stopPropagation()}>
        {/* The word is drawn from its data, never written in the page: a Split sits in the block's
            words, and a selection's offsets there must count the words alone. */}
        <button
          type="button"
          className="fy-ab__seam-press"
          aria-disabled={off}
          aria-label={off ? `${word} · ${gap.limit}` : word}
          data-label={off ? `${word} · ${gap.limit}` : word}
          data-testid={`audiobook-${gap.press}`}
          onClick={() => {
            if (off) return;
            if (losing) setConfirming(id);
            else seams!.onPress(gap);
          }}
        />
        {confirming === id && (
          <span className="fy-ab__seam-confirm" role="dialog" aria-label="Join" data-testid="audiobook-join-confirm">
            <span>Block {rows.indexOf(row) + 1}’s picture comes off. It stays in the world.</span>
            <span className="fy-ab__seam-confirm-foot">
              <Button variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => { setConfirming(null); seams!.onPress(gap); }}>Join</Button>
            </span>
          </span>
        )}
      </span>
    );
  };
  const renderRow = (row: BlockRow) => {
        // The margin names who speaks (R-33): a colour a speaker with a sheet, grey for the
        // narrator, a dashed dot for a name no sheet carries; a line is tinted, narration is not.
        const tone = row.turnMarks !== undefined ? row.turnMarks[0]!.tone : row.speakerKey === null ? "narrator" : row.colour === null ? "none" : String(row.colour);
        // A block of several turns draws them as rows under one bracket (design turn 190); its first row's name is the margin's.
        const laterTurns = row.turnMarks?.slice(1);
        // A grouped read's cut that did not match (design turn 185c): what was heard, under the block.
        const split = row.state === "flagged" && row.split !== null ? row.split : null;
        // A picture set on the block (turn 186c), or proposed by Arke and not yet accepted (191b).
        const picture = pictures?.byKey.get(row.block.key);
        const proposedPicture = picture === undefined ? pictures?.proposed?.get(row.block.key) : undefined;
        return (
          <Fragment key={row.block.key}>
          <div
            key={row.block.key}
            className={`fy-ab__block fy-voice--${tone}${row.speakerKey !== null ? " fy-ab__block--line" : ""}${laterTurns !== undefined ? " fy-ab__block--merged" : ""}${sounding?.block.key === row.block.key ? " fy-ab__block--sounding" : ""}${selected === row.block.key ? " fy-ab__block--selected" : ""}${inAudiobookFilter(row, filter) ? "" : " fy-ab__block--dim"}${row.proposed !== null ? " fy-ab__block--proposed" : ""}`}
            data-state={row.state}
            {...(row.proposed !== null ? { "data-proposed": "true" } : {})}
            data-block={row.block.key}
            data-speaker={row.speakerKey ?? "narrator"}
            onPointerDown={() => { pressedSelection.current = audiobookSelection(rows); }}
            onClick={() => { onSelectionChange?.(audiobookSelection(rows) ?? pressedSelection.current); pressedSelection.current = null; onSelect(row.block.key); }}
          >
            {/* A beat's head (design turn 201, rule 4): its name, then whose it is, its paragraphs and its length, in the text column. */}
            {row.beat !== undefined && (
              <span className="fy-ab__beathead" data-testid="audiobook-beat-head">
                {row.beat.name !== undefined && <b>{row.beat.name}</b>}
                <span>{[...(row.beat.whose !== undefined ? [row.beat.whose] : []), `${row.beat.paragraphs} paragraph${row.beat.paragraphs === 1 ? "" : "s"}`, clock(row.beat.seconds)].join(" · ")}</span>
              </span>
            )}
            {(() => {
              // A kept line keeps the menu (design turn 198, rule 14); words that wait for their
              // paragraph's cast do not, and say nothing about it.
              const kept = row.kept === true ? <em className="fy-ab__kept">kept</em> : null;
              const speaker = pinnable && row.block.paragraph >= 0 && row.turnMarks === undefined && row.waits !== true ? (
              <button
                type="button"
                className={`fy-ab__speaker fy-ab__speaker--press${menu?.key === row.block.key && menu.selection === undefined ? " fy-ab__speaker--open" : ""}`}
                title={row.markWarn ? `${row.full} · narrator` : row.full}
                aria-haspopup="menu"
                aria-expanded={menu?.key === row.block.key}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenu(menu?.key === row.block.key ? null : { key: row.block.key });
                }}
              >
                <i className="fy-ab__speaker-dot" aria-hidden="true" />
                <span className={`fy-ab__mark${row.markWarn ? " fy-ab__mark--warn" : ""}`}>{row.mark}</span>
                {kept}
              </button>
            ) : (
              <span className="fy-ab__speaker" title={row.markWarn ? `${row.full} · narrator` : row.full}>
                <i className="fy-ab__speaker-dot" aria-hidden="true" />
                <span className={`fy-ab__mark${row.markWarn ? " fy-ab__mark--warn" : ""}`}>{row.mark}</span>
                {kept}
              </span>
            );
              return speaker;
            })()}
            <span
              className={`fy-ab__text${row.proposed !== null ? " fy-ab__text--proposed" : ""}`}
              onMouseUp={(event) => {
                // Words selected in narration can be made a line (SPEC-012 R-63): within one block,
                // between 1 and 600 characters; the menu opens for the selection.
                if (coarse || !pinnable || row.speakerKey !== null || row.block.paragraph < 0 || row.waits === true) return;
                const span = rawSelection(event.currentTarget);
                if (span === null) return;
                const words = row.block.text.slice(span.from, span.to);
                if (words.trim() === "" || words.length > 600) return;
                event.stopPropagation();
                setMenu({ key: row.block.key, selection: span });
              }}
            >
              {/* A held proposal is drawn in the direction's place, dashed, until it is accepted (design turn 184b). */}
              {row.proposed !== null ? (
                <DirectedText raw={row.block.text} cues={row.proposed.input.cues} held={new Set(row.proposed.held.flatMap((control) => (control.cueIndex !== undefined ? [control.cueIndex] : [])))} {...(laterTurns !== undefined ? { turns: laterTurns } : {})} />
              ) : (
                <DirectedText
                  raw={row.block.text}
                  cues={row.direction?.input.cues ?? []}
                  held={new Set(row.held.flatMap((control) => (control.cueIndex !== undefined ? [control.cueIndex] : [])))}
                  {...(laterTurns !== undefined ? { turns: laterTurns } : {})}
                  {...(markable ? { onPlate: (index: number) => onMarker({ key: row.block.key, span: { from: 0, to: 0 }, edit: index }) } : {})}
                  {...(laterTurns !== undefined && hovers ? { gap: (index: number) => {
                    const gap = splitsIn(row.block.key).find((candidate) => candidate.row === index);
                    return gap === undefined ? null : seamPress(gap, row);
                  } } : {})}
                />
              )}
            </span>
            {marker?.key === row.block.key && markable && (
              <MarkerMenu
                text={normalizeSpeechText(row.block.text)}
                base={row.direction?.input ?? { delivery: "measured", speed: 1, cues: [] }}
                {...(row.language !== undefined ? { language: row.language } : {})}
                at={marker}
                model={modelOf?.(row.speaker) ?? null}
                onClose={() => onMarker(null)}
                onApply={(cues) => {
                  onMarker(null);
                  const base = row.direction?.input ?? { delivery: "measured" as const, speed: 1, cues: [] };
                  onDirect(row.block.key, cues === null ? null : { ...base, cues });
                }}
              />
            )}
            {menu?.key === row.block.key && choices !== undefined && onPin !== undefined && (
              <SpeakerMenu
                row={row}
                choices={choices}
                onClose={() => setMenu(null)}
                onPick={(pick) => {
                  setMenu(null);
                  onPin(row, pick, menu.selection);
                }}
              />
            )}
            {/* The row's end (design turn 194, rules 7 and 8): the picture chip, on the block's first
                turn where no later turn's name can meet it; a mark only where the author is needed —
                stale, flagged, waiting, awaiting recording — and nothing on a made block but the play
                a fine pointer finds on hover. On touch the row's press selects it and its sheet plays. */}
            <span className="fy-ab__marks">
              {picture !== undefined && slug !== undefined ? <PictureChip slug={slug} picture={picture} /> : proposedPicture !== undefined ? <ProposedChip title={proposedPicture.title} /> : null}
              {/* A block whose shape a seam changed is `not read` (design turn 198, rule 4); one put back
                  and found made again is `made` in green until the author leaves the view (198g). */}
              {row.state !== "made" && (
                <span className={`fy-ab__state fy-ab__state--${row.state.replace(" ", "-")}`} data-testid="audiobook-state">{row.state === "not made" ? (row.block.shaped === true ? "not read" : "waiting") : STATE_LABEL[row.state]}</span>
              )}
              {row.state === "made" && madeAgain?.has(blockIdentity(row)) === true && (
                <span className="fy-ab__state fy-ab__state--again" data-testid="audiobook-state">made</span>
              )}
              {row.state === "made" && row.artifact !== null && (
                <button
                  type="button"
                  className="fy-ab__rowplay"
                  aria-label="Play"
                  title="Play"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlayOne(row);
                  }}
                >
                  <PlaySolid size={9} />
                </button>
              )}
            </span>
            {joinAbove.has(row.block.key) && seamPress(joinAbove.get(row.block.key)!, row)}
          </div>
          {split !== null && (
            <div className="fy-ab__split" data-testid="audiobook-split">
              <span className="fy-ab__split-heard fy-mono">split did not match · “{split.heard}”</span>
              {onReRead !== undefined && (
                <Button variant="ghost" onClick={(event) => { event.stopPropagation(); onReRead(row.block.key); }}>
                  Re-read · 1 request{(reReadPrice?.(row.block.key) ?? null) !== null ? ` · ${reReadPrice!(row.block.key)}` : ""}
                </Button>
              )}
            </div>
          )}
          </Fragment>
        );
  };
  // Rows in their requests: a bracketed run of blocks under its label, every other block alone.
  const bracketOf = new Map(brackets.flatMap((bracket) => bracket.keys.map((key) => [key, bracket] as const)));
  const segments: Array<{ bracket: (typeof brackets)[number] | null; rows: BlockRow[] }> = [];
  for (const row of rows) {
    const bracket = bracketOf.get(row.block.key) ?? null;
    const last = segments[segments.length - 1];
    if (bracket !== null && last !== undefined && last.bracket === bracket) last.rows.push(row);
    else segments.push({ bracket, rows: [row] });
  }
  return (
    <div className="fy-ab__blocks" data-testid="audiobook-blocks">
      {segments.map((segment) =>
        segment.bracket === null ? (
          segment.rows.map(renderRow)
        ) : (
          <Fragment key={`request-${segment.rows[0]!.block.key}`}>
            <div className="fy-ab__request-label fy-mono" data-testid="audiobook-request">{segment.bracket.label}</div>
            <div className={`fy-ab__request${segment.bracket.now ? " fy-ab__request--now" : ""}`}>{segment.rows.map(renderRow)}</div>
          </Fragment>
        ),
      )}
    </div>
  );
}

/** The turns a run of rows would be sent as, packed as the coordinator packs a grouped request. */
function packTurnsFor(rows: readonly BlockRow[]) {
  return packTurns(rows.map((row) => ({ key: row.block.key, reader: "r", ...row.turns })), DEFAULT_GROUP_PACKING).map(({ keys: _keys, ...turn }) => turn);
}

/**
 * The sheet a grouped read is confirmed in (design turn 185a): the blocks and the requests, as
 * many as a block a request would make, Google's free day where it is known, and the estimate.
 */
export function ReadSheet({ sheet }: { sheet: NonNullable<ReturnType<typeof useChapterAudiobook>["readSheet"]> }) {
  const row = (label: string, value: string) => (
    <div className="fy-ab__read" key={label}>
      <b>{label}</b>
      <span>{value}</span>
    </div>
  );
  return (
    <section className="fy-bible__panel fy-ab__directsheet fy-ab__readsheet" data-testid="read-sheet" aria-label={sheet.title}>
      <div>
        <h3 className="fy-ab__card-title">{sheet.title}</h3>
        <p className="fy-mono fy-ab__card-line">{sheet.blocks} block{sheet.blocks === 1 ? "" : "s"}{sheet.requests !== undefined ? ` · ${sheet.requests} request${sheet.requests === 1 ? "" : "s"}` : ""}{sheet.voice !== "" ? ` · ${sheet.voice}` : ""}</p>
      </div>
      <div className="fy-ab__reads" data-testid="read-sheet-reads">
        {sheet.requests !== undefined ? <>
          {row("Requests", `${sheet.requests} · grouped`)}
          {row("Per paragraph", `${sheet.perParagraph} request${sheet.perParagraph === 1 ? "" : "s"}`)}
        </> : row("Characters", sheet.characters.toLocaleString())}
        {sheet.destinations !== "" && row("Readers", sheet.destinations)}
        {sheet.freeDay !== undefined && row("Google today", `${sheet.freeDay.allowed} a day · ${sheet.freeDay.allowed - sheet.freeDay.left} used`)}
        {row("Estimate", sheet.estimate)}
      </div>
      {sheet.freeDay !== undefined && <p className="fy-mono" data-testid="audiobook-free-plan">{freePlanAskCopy(sheet.freeDay).line}</p>}
      {sheet.notices.map((notice) => <p key={notice} className="fy-mono" data-testid="audiobook-notice">{notice}</p>)}
      {sheet.castFirst !== undefined && <CastFirstCheck count={sheet.castFirst.count} on={sheet.castFirst.on} onChange={sheet.castFirst.set} />}
      <div className="fy-ab__control fy-ab__directsheet-foot">
        <span className="fy-ch__panelpush" />
        <Button variant="ghost" onClick={sheet.cancel}>Cancel</Button>
        <Button variant="primary" data-testid="audiobook-confirm" disabled={sheet.starting || (sheet.castFirst !== undefined && !sheet.castFirst.on)} onClick={sheet.confirm}>
          {sheet.starting ? "starting…" : sheet.freeDay !== undefined && sheet.free ? freePlanAskCopy(sheet.freeDay).confirm : sheet.requests !== undefined ? `Confirm · ${sheet.requests} request${sheet.requests === 1 ? "" : "s"} · ${sheet.estimate}` : `Confirm ${sheet.characters.toLocaleString()} characters · ${sheet.estimate}`}
        </Button>
      </div>
    </section>
  );
}

/**
 * A toolbar press and what it opens under it (design turn 194): open on press, closed by Escape —
 * focus back on the press — or by a press outside both. The reading menu's own rule, shared by the
 * Direct and illustrate menu, the speaker filter and the notes.
 */
function usePopover() {
  const [open, setOpen] = useState(false);
  const press = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (panel.current?.contains(event.target as Node) || press.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    // Escape closes it wherever the focus is. The panel's own key handler only heard it from inside:
    // Notes opens without taking the focus, so its Escape went to the press and the sheet stayed
    // open (local.15). Captured, so only this goes — the block drawer or dock behind it stays.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      press.current?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) press.current?.focus();
  };
  const onKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return { open, setOpen, press, panel, close, onKey };
}

/**
 * The space between a press's label and its data. The pill's flex gap draws it (194's 6), and a
 * flex gap is no character: without this the press reads, and is announced, as `Notes2`.
 */
const SPOKEN_GAP = <span className="fy-sr-only"> </span>;

/** One item of a toolbar menu: the label, its state at the right in mono, and its press. */
export interface ToolMenuItem { key: string; label: string; state: string; disabled: boolean; press: () => void; testId?: string; /** A mark before the label (design turn 201): Group by beats' GroupMark. */ mark?: ReactNode }

/**
 * Direct and illustrate (design turn 194, rule 3): one press, its menu drawn with the reading
 * menu's primitive, each item saying where it stands. The items keep the head's handlers.
 */
export function ToolMenu({ label, items, testId, icon = false, lead }: {
  label: string;
  items: readonly ToolMenuItem[];
  testId?: string;
  /** Below 1100 (194, rule 15) the press is a ⋯ and the label is its name. */
  icon?: boolean;
  /**
   * Presses that head the menu (design turn 198j: the lines to cast, on a phone), under their own
   * heading and over a rule; the menu's own items are then one row, `label ›`, that opens them.
   */
  lead?: { head: string; items: readonly ToolMenuItem[]; /** Presses under the rule, before the menu's own row (part A's Reset). */ also?: readonly ToolMenuItem[] };
}) {
  const pop = usePopover();
  const [inner, setInner] = useState(false);
  useEffect(() => {
    if (!pop.open) setInner(false);
  }, [pop.open]);
  useEffect(() => {
    if (pop.open) pop.panel.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [pop.open, inner]);
  const leading = lead !== undefined && lead.items.length > 0 && !inner;
  if (leading) {
    return (
      <span className="fy-ab__tool">
        <button
          ref={pop.press}
          type="button"
          className={icon ? `fy-ab__ico${pop.open ? " fy-ab__ico--on" : ""}` : `fy-ab__pill${pop.open ? " fy-ab__pill--on" : ""}`}
          aria-haspopup="menu"
          aria-expanded={pop.open}
          {...(icon ? { "aria-label": label, title: label } : {})}
          onClick={() => pop.setOpen((was) => !was)}
          {...(testId !== undefined ? { "data-testid": testId } : {})}
        >
          {icon ? <More size={16} /> : <>{label}<ChevronDown size={13} stroke={2} aria-hidden="true" /></>}
        </button>
        {pop.open && (
          <div ref={pop.panel} className="fy-ab__menu fy-ab__toolmenu fy-ab__toolmenu--end fy-ab__toolmenu--lead" role="menu" aria-label={label} onKeyDown={pop.onKey}>
            <div className="fy-ab__menu-hd">{lead.head}</div>
            {lead.items.map((item) => <ToolMenuOption key={item.key} item={item} onDone={() => pop.close(false)} />)}
            <div className="fy-ab__menu-rule" role="separator" />
            {(lead.also ?? []).map((item) => <ToolMenuOption key={item.key} item={item} onDone={() => pop.close(false)} />)}
            <button type="button" role="menuitem" className="fy-ab__menu-opt" onClick={() => setInner(true)} data-testid={testId !== undefined ? `${testId}-items` : undefined}>
              <span className="fy-ab__menu-label">{label}</span>
              <ChevronRight size={13} stroke={2} aria-hidden="true" />
            </button>
          </div>
        )}
      </span>
    );
  }
  return (
    <span className="fy-ab__tool">
      <button
        ref={pop.press}
        type="button"
        className={icon ? `fy-ab__ico${pop.open ? " fy-ab__ico--on" : ""}` : `fy-ab__pill${pop.open ? " fy-ab__pill--on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        {...(icon ? { "aria-label": label, title: label } : {})}
        onClick={() => pop.setOpen((was) => !was)}
        {...(testId !== undefined ? { "data-testid": testId } : {})}
      >
        {icon ? (
          <More size={16} />
        ) : (
          <>
            {label}
            <ChevronDown size={13} stroke={2} aria-hidden="true" />
          </>
        )}
      </button>
      {pop.open && (
        <div ref={pop.panel} className="fy-ab__menu fy-ab__toolmenu fy-ab__toolmenu--end" role="menu" aria-label={label} onKeyDown={pop.onKey}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              aria-disabled={item.disabled}
              className="fy-ab__menu-opt"
              onClick={() => {
                if (item.disabled) return;
                pop.close(false);
                item.press();
              }}
              {...(item.testId !== undefined ? { "data-testid": item.testId } : {})}
            >
              {item.mark}
              <span className="fy-ab__menu-label">{item.label}</span>
              {item.state !== "" && <span className="fy-ab__menu-meta">{item.state}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** One item of a toolbar menu, as the toolbar's menus draw it: its label, its state at the right. */
function ToolMenuOption({ item, onDone }: { item: ToolMenuItem; onDone: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={item.disabled}
      className="fy-ab__menu-opt"
      onClick={() => {
        if (item.disabled) return;
        onDone();
        item.press();
      }}
      {...(item.testId !== undefined ? { "data-testid": item.testId } : {})}
    >
      {item.mark}
      <span className="fy-ab__menu-label">{item.label}</span>
      {item.state !== "" && <span className="fy-ab__menu-meta">{item.state}</span>}
    </button>
  );
}

/**
 * A press and the menu it opens (design turn 198): `2 paragraphs to cast ▾` on the toolbar, after
 * the speaker filter, with its stale dot, and the Voices rail's `Cast again` — both offering
 * `Cast 2 paragraphs` and `Cast the chapter` with its count of paragraphs.
 */
export function MenuPress({ label, items, testId, className, disabled = false, end = false }: { label: ReactNode; items: readonly ToolMenuItem[]; testId: string; className: string; disabled?: boolean; /** The menu's right edge under the press's, for a press at the window's edge. */ end?: boolean }) {
  const pop = usePopover();
  useEffect(() => {
    if (pop.open) pop.panel.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [pop.open]);
  return (
    <span className="fy-ab__tool">
      <button
        ref={pop.press}
        type="button"
        className={`${className}${pop.open ? ` ${className}--on` : ""}`}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        disabled={disabled}
        onClick={() => pop.setOpen((was) => !was)}
        data-testid={testId}
      >
        {label}
      </button>
      {pop.open && (
        <div ref={pop.panel} className={`fy-ab__menu fy-ab__toolmenu fy-ab__castmenu${end ? " fy-ab__toolmenu--end" : ""}`} role="menu" aria-label="Cast" onKeyDown={pop.onKey}>
          {items.map((item) => <ToolMenuOption key={item.key} item={item} onDone={() => pop.close(false)} />)}
        </div>
      )}
    </span>
  );
}

/** `2 paragraphs to cast ▾` (design turn 198h): the stale dot, the count, the menu's two casts. */
export function CastPress({ count, items, busy }: { count: number; items: readonly ToolMenuItem[]; busy: boolean }) {
  return (
    <MenuPress
      className="fy-ab__pill"
      testId="audiobook-cast"
      items={items}
      disabled={busy}
      label={busy ? "casting…" : <><i className="fy-ab__pill-dot" aria-hidden="true" />{paragraphsToCast(count)}<ChevronDown size={13} stroke={2} aria-hidden="true" /></>}
    />
  );
}

/** `2 paragraphs to cast`, one paragraph said once. */
export function paragraphsToCast(count: number): string {
  return `${count} paragraph${count === 1 ? "" : "s"} to cast`;
}

/** `Cast 2 paragraphs first`, ticked (design turn 198, rule 13), as Direct's `Cast the lines first`. */
function CastFirstCheck({ count, on, onChange }: { count: number; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="fy-ab__also" data-testid="audiobook-cast-first">
      <input type="checkbox" checked={on} onChange={() => onChange(!on)} />
      <span>Cast {count} paragraph{count === 1 ? "" : "s"} first</span>
    </label>
  );
}

/**
 * The speakers as one filter (design turn 194, rule 6; R-33): `Everyone · 122 ▾` opens the
 * speakers with their colour and count; choosing one names it on the press and dims the rest.
 */
export function AudiobookFilterMenu({ filters, filter, onFilter }: {
  filters: { everyone: number; narrator: number; speakers: { key: string; label: string; full?: string; colour: number | null; count: number }[] };
  filter: AudiobookFilter;
  onFilter: (filter: AudiobookFilter) => void;
}) {
  const pop = usePopover();
  useEffect(() => {
    if (pop.open) (pop.panel.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? pop.panel.current?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
  }, [pop.open]);
  if (filters.everyone === 0) return null;
  const options: Array<{ key: string; label: string; full?: string; count: number; on: boolean; next: AudiobookFilter; tone: string | null }> = [
    { key: "everyone", label: "Everyone", count: filters.everyone, on: filter === null, next: null, tone: null },
    ...(filters.narrator > 0 ? [{ key: "narrator", label: "Narrator", count: filters.narrator, on: filter === "narrator", next: "narrator" as const, tone: "narrator" }] : []),
    ...filters.speakers.map((who) => ({
      key: who.key,
      label: who.label,
      ...(who.full !== undefined && who.full !== who.label ? { full: who.full } : {}),
      count: who.count,
      on: typeof filter === "object" && filter !== null && filter.speaker === who.key,
      next: { speaker: who.key },
      tone: who.colour === null ? "none" : String(who.colour),
    })),
  ];
  const chosen = options.find((option) => option.on) ?? options[0]!;
  return (
    <span className="fy-ab__tool">
      <button
        ref={pop.press}
        type="button"
        className={`fy-ab__pill${pop.open ? " fy-ab__pill--on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        onClick={() => pop.setOpen((was) => !was)}
        {...(chosen.full !== undefined ? { title: chosen.full } : {})}
        data-testid="audiobook-filter"
      >
        {chosen.label}
        {SPOKEN_GAP}
        <em>{chosen.count}</em>
        <ChevronDown size={13} stroke={2} aria-hidden="true" />
      </button>
      {pop.open && (
        <div ref={pop.panel} className="fy-ab__menu fy-ab__toolmenu fy-ab__filtermenu" role="menu" aria-label="Speakers" onKeyDown={pop.onKey}>
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={option.on}
              className={`fy-ab__menu-opt${option.tone !== null ? ` fy-voice--${option.tone}` : ""}${option.on ? " fy-ab__menu-opt--on" : ""}`}
              {...(option.full !== undefined ? { title: option.full } : {})}
              onClick={() => {
                pop.close(true);
                if (!option.on) onFilter(option.next);
              }}
            >
              <i className={`fy-ab__speaker-dot${option.tone === null ? " fy-ab__speaker-dot--all" : ""}`} aria-hidden="true" />
              <span className="fy-ab__menu-label">{option.label}</span>
              <span className="fy-ab__menu-meta">{option.count}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * `Blocks · 122 ▾` (design turn 201, rule 1; amending 198, rule 10): after the speaker filter from
 * the start, the same press as its neighbours, its data the chapter's block count — or the seams'
 * label once one is set by hand, `30 beats` once the chapter is grouped, `grouping…` with a
 * spinning mark while the director reads. Its menu holds Group by beats, with its mark and the
 * block count, then Reset, which asks nothing: the old takes are found again.
 */
export function BlocksPress({ label, count, changed, resettable, held, grouping, groupOff, groupNote, onGroup, onReset }: {
  label: string;
  count: number;
  changed: number;
  /** A seam or a beat is set: Reset has something to put back. */
  resettable: boolean;
  held: boolean;
  grouping: boolean;
  /** Why Group by beats is off (`Cast · voices apart`), said as its data. */
  groupOff?: string;
  /** Why the last grouping did not group, said as its data until the next press. */
  groupNote?: string;
  onGroup: () => void;
  onReset: () => void;
}) {
  const pop = usePopover();
  useEffect(() => {
    if (pop.open) pop.panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [pop.open]);
  useEffect(() => {
    if (grouping) pop.close(false);
  }, [grouping]);
  const groupDisabled = held || groupOff !== undefined;
  return (
    <span className="fy-ab__tool">
      <button
        ref={pop.press}
        type="button"
        className={`fy-ab__pill${pop.open ? " fy-ab__pill--on" : ""}${grouping ? " fy-ab__pill--busy" : ""}`}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-disabled={grouping}
        onClick={() => {
          if (grouping) return;
          pop.setOpen((was) => !was);
        }}
        data-testid="audiobook-blocks-press"
      >
        {grouping && <span className="fy-ab__spin" aria-hidden="true"><LoaderCircle size={13} stroke={2} /></span>}
        Blocks
        {SPOKEN_GAP}
        <em>{label}</em>
        {!grouping && <ChevronDown size={13} stroke={2} aria-hidden="true" />}
      </button>
      {/* Anchored at the press's right edge, as Direct and illustrate's is: the press can end the line, and a menu
          opened rightward from there ran past the column and was cut off (0.5.67, 2026-10-08). */}
      {pop.open && (
        <div ref={pop.panel} className="fy-ab__menu fy-ab__toolmenu fy-ab__toolmenu--end fy-ab__blocksmenu" role="menu" aria-label="Blocks" onKeyDown={pop.onKey}>
          <button
            type="button"
            role="menuitem"
            aria-disabled={groupDisabled}
            className="fy-ab__menu-opt"
            onClick={() => {
              if (groupDisabled) return;
              pop.close(true);
              onGroup();
            }}
            data-testid="audiobook-blocks-group"
          >
            <GroupMark size={14} />
            <span className="fy-ab__menu-label">Group by beats</span>
            <span className="fy-ab__menu-meta">{groupOff ?? groupNote ?? `${count} block${count === 1 ? "" : "s"}`}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            aria-disabled={held || !resettable}
            className="fy-ab__menu-opt"
            onClick={() => {
              if (held || !resettable) return;
              pop.close(true);
              onReset();
            }}
            data-testid="audiobook-blocks-reset"
          >
            <span className="fy-ab__menu-label">Reset</span>
            <span className="fy-ab__menu-meta">{!resettable ? "none set" : changed > 0 ? `${changed} block${changed === 1 ? "" : "s"}` : label}</span>
          </button>
        </div>
      )}
    </span>
  );
}

/**
 * The block's seams on touch (design turn 198, rule 2; 198j): `Join next` and `Split` under the
 * sheet's head, one line of presses. Join next joins the block with the one after it. Split on a
 * block of two lines splits it at its one gap; on one of three or more it shows the block's lines
 * in the sheet with a Split at each gap between them. A press that would break a limit is drawn
 * off with its reason, as on the desktop; a join that takes a picture off asks, as there.
 */
export function useBlockSeamActs(input: {
  row: BlockRow | null;
  rows: readonly BlockRow[];
  gaps: readonly AudiobookGap[];
  /** A read runs, or the window is offline: the presses hold. */
  held: boolean;
  onPress: (gap: AudiobookGap) => void;
  /** The blocks that show a picture now, by key. */
  pictured?: ReadonlySet<string>;
}): { bar: ReactNode; lines: ReactNode | null } {
  const { row, rows, gaps, held, onPress, pictured } = input;
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const key = row?.block.key ?? null;
  useEffect(() => {
    setOpen(false);
    setAsking(false);
  }, [key, gaps]);
  if (row === null) return { bar: null, lines: null };
  const at = rows.indexOf(row);
  const next = rows[at + 1];
  const joinNext = next === undefined ? undefined : gaps.find((gap) => gap.press === "join" && gap.block === next.block.key);
  const splits = gaps.filter((gap) => gap.press === "split" && gap.block === row.block.key);
  if (joinNext === undefined && splits.length === 0) return { bar: null, lines: null };
  const joinOff = joinNext?.limit !== undefined;
  const losing = next !== undefined && pictured?.has(row.block.key) === true && pictured.has(next.block.key);
  const bar = (
    <>
      <div className="fy-abp__acts" data-testid="audiobook-seam-acts">
        {joinNext !== undefined && (
          <button
            type="button"
            className={`fy-ab__pill${joinOff ? " fy-ab__pill--off" : ""}`}
            disabled={held}
            aria-disabled={joinOff}
            onClick={() => {
              if (joinOff) return;
              if (losing) setAsking(true);
              else onPress(joinNext);
            }}
            data-testid="audiobook-join-next"
          >
            {joinOff ? `Join next · ${joinNext.limit}` : "Join next"}
          </button>
        )}
        {splits.length > 0 && (
          <button
            type="button"
            className={`fy-ab__pill${open ? " fy-ab__pill--on" : ""}`}
            disabled={held}
            aria-expanded={splits.length > 1 ? open : undefined}
            onClick={() => (splits.length === 1 ? onPress(splits[0]!) : setOpen((was) => !was))}
            data-testid="audiobook-split-sheet"
          >
            Split
          </button>
        )}
      </div>
      {asking && joinNext !== undefined && next !== undefined && (
        <div className="fy-ab__seam-confirm fy-ab__seam-confirm--sheet" role="dialog" aria-label="Join" data-testid="audiobook-join-confirm">
          <span>Block {at + 2}’s picture comes off. It stays in the world.</span>
          <span className="fy-ab__seam-confirm-foot">
            <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => { setAsking(false); onPress(joinNext); }}>Join</Button>
          </span>
        </div>
      )}
    </>
  );
  if (!open || splits.length < 2) return { bar, lines: null };
  // The block's lines, as the list draws them on a phone, with a Split at each gap between.
  const turns = row.block.rows ?? [{ text: row.block.text }];
  const lines = (
    <div className="fy-abp__lines" data-testid="audiobook-seam-lines">
      {turns.map((turn, index) => {
        const mark = row.turnMarks?.[index];
        const gap = splits.find((candidate) => candidate.row === index);
        return (
          <Fragment key={index}>
            <div className="fy-abp__line">
              <span className={`fy-abp__line-who fy-voice--${mark?.tone ?? "narrator"}`}>
                <i className="fy-ab__speaker-dot" aria-hidden="true" />
                {mark?.label ?? (turn.speaker ?? "narrator")}
              </span>
              <span className="fy-abp__line-text">{turn.text}</span>
            </div>
            {gap !== undefined && index < turns.length - 1 && (
              <span className="fy-ab__seam fy-ab__seam--sheet">
                <button type="button" className="fy-ab__seam-press" disabled={held} aria-label="Split" data-label="Split" onClick={() => onPress(gap)} data-testid="audiobook-split" />
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
  return { bar, lines };
}

/** One control's word on the panel (R-9): what this reader does with it, in one clause. */
function supportWord(support: { status: string; method?: string; reason?: string }): string {
  return support.status === "unsupported" ? (support.reason ?? "unsupported") : support.status === "best-effort" ? (support.method ?? "best-effort") : "mapped";
}

/** The seg's three speeds, the plan's own range narrowed to what a hand would choose. */
const SPEEDS = [0.9, 1, 1.1] as const;

/**
 * Where the window's selection sits in the block's words, as a span of the normalised text
 * (R-6): a cue is placed at the words the person chose, never typed in as a number. Null when
 * nothing of this block is selected.
 */
function selectedSpan(host: HTMLElement | null, raw: string): { from: number; to: number } | null {
  const selection = typeof window === "undefined" ? null : window.getSelection?.();
  if (host === null || selection === null || selection === undefined || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;
  const offset = (node: Node, at: number) => {
    const before = document.createRange();
    before.selectNodeContents(host);
    before.setEnd(node, at);
    return before.toString().length;
  };
  const fold = (prefix: string) => normalizeSpeechText(prefix).length + (/\s$/.test(prefix) && normalizeSpeechText(prefix) !== "" ? 1 : 0);
  const from = fold(raw.slice(0, offset(range.startContainer, range.startOffset)));
  const to = fold(raw.slice(0, offset(range.endContainer, range.endOffset)));
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

/**
 * The marker menu's place from the window's selection (R-42): the block the selection sits in,
 * and the normalised words selected, or the caret. Null when the selection is in no block.
 */
export function markerAtSelection(rows: readonly BlockRow[]): MarkerAt | null {
  const selection = typeof window === "undefined" ? null : window.getSelection?.();
  if (selection === null || selection === undefined || selection.rangeCount === 0) return null;
  const node = selection.getRangeAt(0).startContainer;
  const element = (node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null;
  const host = element?.closest?.("[data-block] .fy-ab__text") as HTMLElement | null;
  const key = host?.closest("[data-block]")?.getAttribute("data-block");
  const row = rows.find((candidate) => candidate.block.key === key);
  if (host === null || row === undefined) return null;
  const span = selectedSpan(host, row.block.text);
  return span === null ? null : { key: row.block.key, span };
}

/**
 * A speaker the narrator performs (design turn 155g, SPEC-047 R-44, R-45): the note on how the
 * narrator plays them, 60 characters, written when the field is left. The focused row adds
 * `Hear <name>` — the selected line if it is theirs, else their first in the chapter, as it
 * would be read, priced on the button for a cloud narrator — and what that line is sent as.
 */
export function PerformedSpeaker({ worldId, productionId, chapterFile, speakerKey, name, lines, tone, note, source, noteHeld, line, model, slug, focused, onFocus }: {
  worldId: string;
  productionId: string;
  chapterFile: string;
  speakerKey: string;
  name: string;
  lines: number;
  tone: string;
  note?: string;
  /** Where the note comes from (design turn 200, R-167): writing here always sets the book's own. */
  source?: "this book" | "character";
  noteHeld: boolean;
  /** The line Hear plays and Sent as shows. */
  line: BlockRow | null;
  model: ManifestModel | null;
  slug: string | undefined;
  focused: boolean;
  onFocus: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // The note field waits behind its press until there is a note (design turn 192): three empty
  // inputs under three speakers read as three things owed.
  const [noteOpen, setNoteOpen] = useState(false);
  const showNote = noteOpen || note !== undefined || draft !== null;
  const value = draft ?? note ?? "";
  const commit = () => {
    if (draft === null) return;
    const trimmed = draft.trim();
    setDraft(null);
    if (trimmed === (note ?? "")) return;
    setAudiobookNote(worldId, productionId, speakerKey, trimmed === "" ? null : trimmed.slice(0, 60));
  };
  const [hearId, setHearId] = useState<string | null>(null);
  const heard = useHeardLines()[hearId ?? ""];
  useEffect(() => {
    if (heard?.state !== "done" || slug === undefined) return;
    void playClip({ id: `hear-${hearId}`, url: mediaUrl(slug, heard.file), title: name, sub: note ?? "plain" });
  }, [heard?.state]);
  const sent = line?.sentAs?.map((part) => part.text).join(" ") ?? (line === null ? null : normalizeSpeechText(line.block.text));
  const tokenPriced = model?.pricing.kind === "perToken" && model.speechPlan !== "free-plan";
  const price = model === null || sent === null || tokenPriced ? 0 : estimateSpeechMicroUsd(model, sent);
  return (
    <li className={`fy-ab__performer${focused ? " fy-ab__performer--focused" : ""}`} onFocus={onFocus} onClick={onFocus} data-testid="performed-speaker">
      <div className="fy-ch__who-head">
        <span className="fy-ch__who-name">
          <i className={`fy-ab__speaker-dot fy-voice--${tone}`} aria-hidden="true" />
          <span>{name}</span>
        </span>
        {noteHeld && note !== undefined && <span className="fy-ch__who-where fy-mono fy-ch__who-where--warn">note · not on this reader</span>}
        {!showNote && (
          <button type="button" className="fy-ch__derive fy-ab__note-press" onClick={() => setNoteOpen(true)} data-testid="performed-note-press">
            Note
          </button>
        )}
        <span className="fy-ch__who-count fy-mono">
          {lines} line{lines === 1 ? "" : "s"}
        </span>
      </div>
      {showNote && (
        <div className="fy-ab__note">
          <input
            className="fy-ab__note-input"
            value={value}
            maxLength={60}
            placeholder="note"
            aria-label={`Note · ${name}`}
            autoFocus={noteOpen && note === undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              // Left empty, it folds back to its press; written, it stays open until the note
              // the store sends back takes over.
              if (value.trim() === "") setNoteOpen(false);
              commit();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
          />
          <span className="fy-ab__note-count fy-mono">{`${value.length}/60${source !== undefined ? ` · ${source}` : ""}`}</span>
        </div>
      )}
      {focused && line !== null && (
        <div className="fy-ab__note-more">
          <button
            type="button"
            className="fy-ch__derive"
            disabled={heard?.state === "working"}
            onClick={() => setHearId(hearAudiobookLine(worldId, productionId, chapterFile, line.block.key, undefined, heard?.state === "priced" ? heard.token : undefined))}
            data-testid="performed-hear"
          >
            Hear {name}
            {heard?.state === "priced" ? ` · ~${formatMicroUsd(heard.estimatedMicroUsd)} · ${heard.parts} part${heard.parts === 1 ? "" : "s"}` : speechPlanLabel(model) !== null ? ` · ${speechPlanLabel(model)}` : tokenPriced ? " · get price" : price > 0 ? ` · ${formatMicroUsd(price)}` : ""}
          </button>
          {heard?.state === "refused" && <span className="fy-ch__who-where fy-mono fy-ch__who-where--warn">{heard.refused}</span>}
          {sent !== null && <span className="fy-ab__sent fy-mono" data-testid="performed-sent-as">{sent}</span>}
        </div>
      )}
    </li>
  );
}

/** The side in the Audiobook view: the block pressed, its direction, then its takes. */
export function AudiobookSide({ rows, selected, record, artifacts, slug, productionId, chapterId, chapterTitle, modelOf, onSetDirection, onMakeAgain, onUpload, onRecorded, onLines, onMarker, refused, blockHost, capturedSelection, choices, onPin, inSheet = false, hear, onKeepSplit, reReadPrice }: {
  /** A grouped read's cut that did not match, kept as it is (design turn 185c). */
  onKeepSplit?: (key: string) => void;
  /** What reading the block again with its neighbours would cost, as the button says it. */
  reReadPrice?: (key: string) => string | null;
  /** Hear a block as the held proposal would send it (design turn 184b): the world and the chapter's file to ask under. */
  hear?: { worldId: string; chapterFile: string };
  rows: BlockRow[];
  selected: string | null;
  record: ChapterAudiobook | null;
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  productionId: string;
  chapterId: string;
  chapterTitle: string;
  modelOf: (reader: AudiobookReader) => ManifestModel | null;
  onSetDirection: (key: string, direction: AudiobookDirectionInput | null) => void;
  onMakeAgain: (key: string) => void;
  /** A recording for the block, from the host's picker (SPEC-047 R-35). */
  onUpload?: (key: string) => void;
  /** The block's speaker recorded by a person, or given back to their voice (R-37). */
  onRecorded?: (speaker: string, recorded: boolean) => void;
  /** A recorded speaker's lines out as a script and back as files (R-39). */
  onLines?: (speaker: string, label: string) => void;
  /** The marker menu opened at the words selected in the block (R-42). */
  onMarker?: (at: MarkerAt) => void;
  /** The last write's refusal (R-9), said on the panel until the next write answers. */
  refused: string | null;
  capturedSelection?: BlockSelection | null;
  inSheet?: boolean;
  choices?: SpeakerChoices;
  onPin?: (row: BlockRow, pick: SpeakerPick, selection?: { from: number; to: number }) => void;
  /** The element the block's words are shown in, for a cue placed at the selection. */
  blockHost: (key: string) => HTMLElement | null;
}) {
  const row = rows.find((candidate) => candidate.block.key === selected) ?? null;
  // A Make again past the month's free credit is priced again, and says so (design turn 182).
  const creditLeft = freeCreditLeft(useStore().state?.app.ledger ?? []);
  // A designed or cloned voice is said by its name, never its id (the door's Cast, 2026-10-03).
  const voiceNames = useStore().state?.world ?? {};
  const [supportNotice, setSupportNotice] = useState<string | null>(null);
  const [lineOpen, setLineOpen] = useState(false);
  const [markerMenu, setMarkerMenu] = useState<MarkerAt | null>(null);
  const coarse = useMediaQuery("(pointer: coarse)");
  const [phraseDraft, setPhraseDraft] = useState<string | null>(null);
  // Edits compose while the record's answer is on its way (codex on PR 1186): a delivery then
  // a speed pressed before the first write answers would otherwise both be built from the same
  // record, the second undoing the first. The pending plan is this panel's until the record
  // answers — with its own word, or with a refusal — or another block is chosen.
  const [pending, setPending] = useState<{ key: string; plan: AudiobookDirectionInput | null } | null>(null);
  useEffect(() => {
    setPhraseDraft(null);
    setPending(null);
    setLineOpen(false);
    setSupportNotice(null);
    setMarkerMenu(null);
  }, [selected]);
  useEffect(() => setPending(null), [record?.updatedAt, refused]);
  if (row === null) return null;
  const take = record?.takes[row.block.key];
  const flag = record?.flags[row.block.key];
  // This chapter's takes of this block (codex on PR 1180): every chapter has a `title` and a
  // `p0.0`, so the key alone would list another chapter's reading under this one's name.
  const takes = blockTakes(artifacts, productionId, chapterId, row.block.key, row.block.shaped === true ? row.block.text : undefined);
  // A block a seam shaped, not read yet (198c): no takes to list, and Make reads it alone.
  const unread = row.block.shaped === true && takes.length === 0;
  // The direction that stands for these words, and what the reader that will speak does with
  // each control (R-9): read off that reader's row and the line's language, so a delivery the
  // row lacks is struck with the reason before it is pressed, and the plan's own report says
  // how each control went.
  const model = modelOf(row.speaker);
  const support = model === null ? null : cadenceSupport(model, row.language);
  // The direction for these words, carried from earlier ones when the wording changed (R-43).
  const held = pending !== null && pending.key === row.block.key ? pending.plan : (row.direction?.input ?? null);
  const text = normalizeSpeechText(row.block.text);
  const heldCues = new Set(row.held.flatMap((control) => (control.cueIndex !== undefined ? [control.cueIndex] : [])));
  const base: AudiobookDirectionInput = held ?? { delivery: "measured", speed: 1, cues: [] };
  const send = (next: AudiobookDirectionInput | null) => {
    setPending({ key: row.block.key, plan: next });
    onSetDirection(row.block.key, next);
  };
  const write = (next: Partial<AudiobookDirectionInput>) => send({ ...base, ...next });
  // Both offsets and source words were captured before the sheet moved focus. A changed block
  // invalidates them rather than applying the old span to a newer version of its prose.
  const captured = capturedSelection?.key === row.block.key && capturedSelection.text === row.block.text ? capturedSelection : null;
  const selectionSpan = () => captured?.span ?? (coarse ? null : selectedSpan(blockHost(row.block.key), row.block.text));
  // The note (design turn 181e): to 300 on every reader. An instruction reader takes it whole; a
  // tag reader takes it as one tag to sixty and holds a longer one, struck under Sent as.
  const noteSupported = support !== null && support.note.status !== "unsupported";
  const noteMax = CADENCE_NOTE_MAX;
  const noteValue = phraseDraft ?? held?.note ?? "";
  const commitPhrase = () => {
    if (phraseDraft === null) return;
    const trimmed = phraseDraft.trim();
    setPhraseDraft(null);
    if (trimmed === (base.note ?? "")) return;
    if (trimmed === "") {
      const { note: _gone, ...rest } = base;
      send(rest);
    } else write({ note: trimmed.slice(0, noteMax) });
  };
  // Delivery is six chips, the chosen one filled (turn 165, 155e): a grey seg of six words wrapped
  // to two rows in the side's 250 (issue 1324 §3). One or none is chosen, so a radiogroup whose
  // chosen chip, pressed again, returns the block to no direction.
  const chips = (name: string, items: readonly { key: string; label: string; active: boolean; off: boolean; title: string; press: () => void }[]) => (
    <span className="fy-ab__chips" role="radiogroup" aria-label={name}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="radio"
          className={`fy-ab__chip${item.active ? " fy-ab__chip--on" : ""}${item.off ? " fy-ab__chip--off" : ""}`}
          disabled={item.off && !coarse}
          aria-disabled={item.off}
          aria-checked={item.active}
          title={item.title}
          onClick={() => item.off ? setSupportNotice(`${item.label} · ${item.title}`) : item.press()}
        >
          {item.label}
        </button>
      ))}
    </span>
  );
  const seg = (name: string, items: readonly { key: string; label: string; active: boolean; off: boolean; title: string; press: () => void }[]) => (
    <span className="fy-seg fy-ab__seg" role="group" aria-label={name}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`fy-seg__item${item.active ? " fy-seg__item--active" : ""}${item.off ? " fy-ab__seg-item--off" : ""}`}
          disabled={item.off && !coarse}
          aria-disabled={item.off}
          aria-pressed={item.active}
          title={item.title}
          onClick={() => item.off ? setSupportNotice(`${item.label} · ${item.title}`) : item.press()}
        >
          {item.label}
        </button>
      ))}
    </span>
  );
  // What Sent as is made of, named on its folded line (design turn 194g): a style beside the
  // words, and how many parts the reader is sent.
  const sentParts = row.sentAs === null ? [] : [
    ...(row.sentAs.some((part) => part.style !== undefined) ? ["style"] : []),
    `${row.sentAs.length} ${row.sentAs.length === 1 ? "part" : "parts"}`,
  ];
  const price = model !== null && row.speaker.provider !== "kokoro" ? speechPriceCopy(model, estimateSpeechMicroUsd(model, row.block.text), creditLeft) : null;
  // The Voice tab (design turn 194, rule 12; 194g): Delivery, Note, Speed and Markers as rows, the
  // takes each with its play, Sent as folded with its parts named, and Upload and Make again at
  // the foot. A held proposal is drawn in the direction's place until it is accepted (184b).
  return (
    <>
      {row.state === "flagged" && flag?.split !== undefined && (
        // A cut whose words did not match (design turn 185c): its place in the request, what was
        // heard beside the words, kept as it is or read again with its neighbours.
        <div className="fy-ab__splitpanel" data-testid="audiobook-split-panel">
          <p className="fy-mono fy-ab__card-line">grouped · {clock(flag.split.offsetSec)}–{clock(flag.split.offsetSec + flag.split.durationSec)}</p>
          <div className="fy-ab__reads">
            <div className="fy-ab__read"><b>Heard</b><span>{flag.split.heard === "" ? "nothing" : flag.split.heard}</span></div>
            <div className="fy-ab__read"><b>Words</b><span>{normalizeSpeechText(row.block.text)}</span></div>
          </div>
          <div className="fy-ab__control">
            <span className="fy-ch__panelpush" />
            {onKeepSplit !== undefined && <Button variant="ghost" data-testid="audiobook-keep-split" onClick={() => onKeepSplit(row.block.key)}>Keep</Button>}
            <Button variant="primary" data-testid="audiobook-reread" onClick={() => onMakeAgain(row.block.key)}>
              Re-read{reReadPrice?.(row.block.key) !== null && reReadPrice !== undefined ? ` · 1 request · ${reReadPrice(row.block.key)}` : ""}
            </Button>
          </div>
        </div>
      )}
      {coarse && captured !== null && choices !== undefined && onPin !== undefined && row.speakerKey === null && row.block.paragraph >= 0 && captured.raw.to > captured.raw.from && captured.raw.to - captured.raw.from <= 600 && <div className="fy-ab__make-line">
        <Button onClick={() => setLineOpen(true)}>Make this a line</Button>
        {lineOpen && <SpeakerMenu row={row} choices={choices} onClose={() => setLineOpen(false)} onPick={pick => { onPin(row, pick, captured.raw); setLineOpen(false); }} />}
      </div>}
      {row.proposed !== null ? (
        <ProposedBlock row={row} proposed={row.proposed} model={model} {...(hear !== undefined ? { hear: { ...hear, productionId, ...(row.block.key !== AUDIOBOOK_TITLE_KEY ? { number: rows.indexOf(row) + 1 } : {}) } } : {})} />
      ) : (
      <section className="fy-ab__direction" data-testid="audiobook-direction">
        {coarse && supportNotice && <p role="status" className="fy-mono">{supportNotice}</p>}
        <div className="fy-abp__sec">
          <span className="fy-abp__k">Delivery</span>
          {chips(
            "Delivery",
            AUDIOBOOK_DELIVERIES.map((delivery) => {
              const word = support?.deliveries[delivery];
              const active = held?.delivery === delivery;
              return {
                key: delivery,
                label: delivery,
                active,
                off: word === undefined || word.status === "unsupported",
                title: word === undefined ? "no reader" : supportWord(word),
                press: () => (active ? send(null) : write({ delivery })),
              };
            }),
          )}
        </div>
        <div className="fy-abp__kv">
          <span className="fy-abp__k">Note</span>
          {noteSupported ? (
            <>
              <input
                className="fy-abp__note"
                value={noteValue}
                maxLength={noteMax}
                placeholder="Add a note"
                aria-label="Note"
                aria-describedby={`fy-ab-note-${row.block.key}`}
                onChange={(event) => setPhraseDraft(event.target.value)}
                onBlur={commitPhrase}
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                }}
              />
              {noteValue !== "" && <span id={`fy-ab-note-${row.block.key}`} className="fy-abp__i" data-testid="audiobook-note-count">{`${noteValue.length} / ${noteMax}`}</span>}
            </>
          ) : (
            <span className="fy-abp__v fy-abp__v--off">{support === null ? "no reader" : supportWord(support.note)}</span>
          )}
        </div>
        <div className="fy-abp__kv">
          <span className="fy-abp__k">Speed</span>
          {seg(
            "Speed",
            SPEEDS.map((speed) => {
              const off = speed !== 1 && (support === null || support.speed.status === "unsupported");
              return {
                key: String(speed),
                label: speed.toFixed(1),
                active: (held?.speed ?? 1) === speed,
                off,
                title: off ? (support === null ? "no reader" : supportWord(support.speed)) : `${speed.toFixed(1)}×`,
                press: () => write({ speed }),
              };
            }),
          )}
        </div>
        <div className="fy-abp__kv fy-abp__kv--top">
          <span className="fy-abp__k">Markers</span>
          <span className="fy-ab__cues" data-testid="audiobook-markers">
            {base.cues.length === 0 && <span className="fy-abp__v fy-abp__v--off">none</span>}
            {base.cues.map((cue, index) => (
              <span key={index} className={`fy-ab__cue fy-mono${heldCues.has(index) ? " fy-ab__cue--held" : ""}`}>
                <span className={`fy-ab__mk${cue.kind === "delivery" ? "" : cue.kind === "sound" ? " fy-ab__mk--sound" : " fy-ab__mk--cue"}${heldCues.has(index) ? " fy-ab__mk--held" : ""}`} data-mk={markerLabel(cue)} aria-hidden="true" />
                {cueLabel(text, cue)}
                <button type="button" className="fy-ab__cue-x" aria-label="Remove marker" onClick={() => write({ cues: base.cues.filter((_, at) => at !== index) })}>
                  ×
                </button>
              </span>
            ))}
            {(row.held.length > 0 || (row.direction?.dropped ?? 0) > 0) && (
              <span className="fy-abp__v fy-abp__v--off" data-testid="audiobook-held">
                {[
                  ...(row.held.length > 0 ? [`${row.held.length} held · ${model?.displayName ?? "this reader"}`] : []),
                  ...((row.direction?.dropped ?? 0) > 0 ? [`${row.direction!.dropped} marker${row.direction!.dropped === 1 ? "" : "s"} dropped · words changed`] : []),
                ].join(" · ")}
              </span>
            )}
          </span>
          {/* Add opens the marker menu at the words selected (R-42), where the deliveries, the
              cues and the sounds are, each struck where this reader cannot make it. */}
          {onMarker !== undefined && (
            <button
              type="button"
              className="fy-abp__add"
              title="[ at the words selected"
              onClick={(event) => {
                event.stopPropagation();
                const span = selectionSpan();
                const at = { key: row.block.key, span: span ?? { from: 0, to: text.length } };
                if (inSheet) setMarkerMenu(at); else onMarker(at);
              }}
              data-testid="audiobook-marker-open"
              aria-label="Add marker"
            >
              Add
            </button>
          )}
        </div>
        {markerMenu !== null && <MarkerMenu text={text} base={base} {...(row.language !== undefined ? { language: row.language } : {})} at={markerMenu} model={model} onClose={() => setMarkerMenu(null)} onApply={cues => { setMarkerMenu(null); send(cues === null ? null : { ...base, cues }); }} />}
        {refused !== null && (
          <p className="fy-mono fy-ch__who-where--warn" data-testid="audiobook-report">
            {refused}
          </p>
        )}
      </section>
      )}
      {!unread && (
      <section className="fy-abp__sec fy-abp__takes" data-testid="audiobook-takes">
        <span className="fy-abp__k">Takes</span>
        {takes.length === 0 ? (
          <span className="fy-abp__v fy-abp__v--off fy-abp__none">none yet</span>
        ) : (
          takes.map((artifact, index) => {
            const generation = artifact.generation?.source === "audiobook" ? artifact.generation : null;
            const chosen = take?.artifactId === artifact.id;
            return (
              <div key={artifact.id} className="fy-abp__take">
                <button
                  type="button"
                  className="fy-ab__rowplay fy-abp__takeplay"
                  aria-label={`Play take ${takes.length - index}`}
                  disabled={slug === undefined}
                  onClick={() => {
                    if (slug === undefined) return;
                    void playClip({ id: artifact.id, url: mediaUrl(slug, `artifacts/${artifact.file}`), title: `${chapterTitle} · ${row.mark}`, sub: `take ${takes.length - index}` });
                  }}
                >
                  <PlaySolid size={9} />
                </button>
                <b>v{takes.length - index}</b>
                <span className="fy-abp__i">
                  {generation?.recording !== undefined || (chosen && take?.source === "recorded")
                    ? `recorded${generation?.voiceLabel !== undefined ? ` · ${generation.voiceLabel}` : ""}`
                    : (
                      <>
                        {generation !== null ? `${voiceDisplayLabel({ label: generation.voiceLabel, voiceId: generation.voiceId }, voiceNames)} · ${readerName(generation, modelOf(generation))}` : ""}
                        {generation?.delivery !== undefined ? ` · ${generation.delivery}` : ""}
                        {generation !== null ? ` · ${generation.costMicroUsd === null ? formatMicroUsd(generation.estimatedMicroUsd) : formatMicroUsd(generation.costMicroUsd)}` : ""}
                      </>
                    )}
                </span>
                <span className="fy-abp__i">{chosen ? "kept" : ""}</span>
              </div>
            );
          })
        )}
      </section>
      )}
      {/* Sent as, folded (rule 12): what the reader is sent, each part named, opened on a press. */}
      {row.proposed === null && row.sentAs !== null && (
        <details className="fy-abp__disc" data-testid="audiobook-sent">
          <summary>
            <ChevronRight size={12} stroke={2} />
            Sent as
            <span className="fy-ch__panelpush" />
            <span className="fy-abp__i">{sentParts.join(" · ")}</span>
          </summary>
          <span className="fy-ab__sentcol">
            {/* The style beside the words (design turn 181e), once for each that differs. */}
            {[...new Set(row.sentAs.flatMap((part) => (part.style !== undefined ? [part.style] : [])))].map((style) => (
              <span key={style} className="fy-ab__sent-style fy-mono" data-testid="audiobook-sent-style">
                <span className="fy-vd__sent-k">style</span> {style}
              </span>
            ))}
            <span className="fy-ab__sent fy-mono" data-testid="audiobook-sent-as">
              {row.sentAs.map((part, index) => (
                <span key={index}>{part.text}</span>
              ))}
            </span>
            {/* What the reader is not sent, named, as the Bench names it (design turn 181d). */}
            {row.held.length > 0 && row.direction !== null && (
              <span className="fy-ab__sent-style fy-vd__sent-held fy-mono" data-testid="audiobook-sent-held">
                <span className="fy-vd__sent-k">Held</span> {heldWords(viewPlan(row.direction.input), row.held).join(" · ")} — {model?.displayName ?? "this reader"}
              </span>
            )}
            {/* A book or chapter note this reader cannot take, struck and never spoken (design turn 184d). */}
            {row.readingHeld.map((held) => (
              <s key={held.which} className="fy-ab__sent-style fy-vd__sent-held fy-mono" data-testid="audiobook-reading-held">{readingHeldWords(held, model)}</s>
            ))}
          </span>
        </details>
      )}
      {/* Who records the speaker (R-37) and a recorded speaker's lines (R-39): set from the block, as built. */}
      {onRecorded !== undefined && (
        <label className="fy-ab__recorded" data-testid="audiobook-recorded">
          <input type="checkbox" checked={row.byPerson} onChange={() => onRecorded(audiobookRecordingKey(row.block), !row.byPerson)} />
          <span>{row.speakerKey === null ? "Narrator" : row.mark} · recorded by a person</span>
          {onLines !== undefined && row.byPerson && (
            <button type="button" className="fy-abp__add" onClick={(event) => { event.preventDefault(); onLines(audiobookRecordingKey(row.block), row.speakerKey === null ? "Narrator" : row.mark); }} data-testid="audiobook-lines">
              Lines…
            </button>
          )}
        </label>
      )}
      <div className="fy-abp__foot">
        {onUpload !== undefined && (
          <Button variant="outline" onClick={() => onUpload(row.block.key)} data-testid="audiobook-upload" title="a recording of these words, from a file">
            Upload
          </Button>
        )}
        <span className="fy-ch__panelpush" />
        {takes.length > 0 && (
          <Button variant="primary" onClick={() => onMakeAgain(row.block.key)} data-testid="audiobook-make-again">
            Reread {blockReadTarget(row.block.key, rows)}{price !== null ? ` · ${price}` : ""}
          </Button>
        )}
        {unread && (
          <Button variant="primary" onClick={() => onMakeAgain(row.block.key)} data-testid="audiobook-make">
            Read {blockReadTarget(row.block.key, rows)}{price !== null ? ` · ${price}` : ""}
          </Button>
        )}
      </div>
    </>
  );
}

/** The paid action names the same block as the panel, including the chapter title. */
function blockReadTarget(key: string, rows: readonly BlockRow[]): string {
  return key === AUDIOBOOK_TITLE_KEY ? "title" : `block ${rows.findIndex((row) => row.block.key === key) + 1}`;
}

/** The block panel's three tabs (design turn 194, rule 12). */
export type PanelTab = "picture" | "voice" | "timing";
const PANEL_TABS: ReadonlyArray<{ tab: PanelTab; label: string }> = [
  { tab: "picture", label: "Picture" },
  { tab: "voice", label: "Voice" },
  { tab: "timing", label: "Timing" },
];

/** This chapter's takes of a block, newest first: every chapter has a `title` and a `p0.0`, so the key alone would list another chapter's (codex on PR 1180). */
export function blockTakes(
  artifacts: readonly ArtifactSidecar[],
  productionId: string,
  chapterId: string,
  key: string,
  /** A block a seam shaped (design turn 198c): only its own words' takes, never another shape's under the same key. */
  words?: string,
): ArtifactSidecar[] {
  const hash = words === undefined ? null : audiobookTextHash(words);
  return artifacts
    .filter((artifact) => artifact.generation?.source === "audiobook" && artifact.generation.productionId === productionId && artifact.generation.chapterId === chapterId && artifact.generation.block === key && artifact.retiredAt === undefined && (hash === null || artifact.generation.textHash === hash))
    .sort((a, b) => (a.created < b.created ? 1 : -1));
}

/**
 * The block panel's head (194g): `Block 49 · Ife, narrator` — the block and who speaks in it, in
 * the order its turns run — and one mono line: the lines, the take's length, who reads it, and its
 * state; a flag's reason under it when there is one. The reader in words, never a provider's id
 * (turn 165).
 */
export function blockPanelHead(row: BlockRow, rows: readonly BlockRow[], record: ChapterAudiobook | null, chapterTitle: string, names: Parameters<typeof voiceDisplayLabel>[1]): { title: string; /** The title with every name in full, for its tooltip, where it differs. */ full?: string; sub: string; flag: string | null } {
  const who = row.turnMarks !== undefined ? [...new Set(row.turnMarks.map((turn) => turn.label))] : [row.speakerKey === null ? "narrator" : row.mark];
  const whoFull = row.turnMarks !== undefined ? [...new Set(row.turnMarks.map((turn) => turn.full ?? turn.label))] : [row.speakerKey === null ? "narrator" : row.full];
  // A beat is named for itself (design turn 201, rule 4), and counted in paragraphs, not lines.
  const named = row.beat?.name;
  const title = row.block.key === AUDIOBOOK_TITLE_KEY ? `Title · ${chapterTitle}` : `${named ?? `Block ${rows.indexOf(row) + 1}`} · ${who.join(", ")}`;
  const full = row.block.key === AUDIOBOOK_TITLE_KEY ? title : `${named ?? `Block ${rows.indexOf(row) + 1}`} · ${whoFull.join(", ")}`;
  const lines = row.turnMarks?.length ?? 1;
  const counted = row.beat !== undefined ? `${row.beat.paragraphs} paragraph${row.beat.paragraphs === 1 ? "" : "s"}` : `${lines} line${lines === 1 ? "" : "s"}`;
  const take = record?.takes[row.block.key];
  const seconds = row.state === "made" ? (row.artifact?.mediaInfo?.durationSec ?? take?.grouped?.durationSec ?? null) : null;
  // A block a seam shaped and not read yet says how long it will be, at the reading rate (198c).
  const reshaped = row.block.shaped === true && row.state === "not made";
  const sub = [
    counted,
    ...(seconds !== null ? [`${seconds.toFixed(1)} s`] : reshaped ? [`~${expectedSpeechSeconds(row.block.text).toFixed(1)} s`] : []),
    `read by ${voiceDisplayLabel(row.speaker, names)}`,
    ...(row.speaker !== row.assigned ? ["stands in"] : row.byNarrator && row.note !== undefined ? ["performed"] : []),
    ...(row.proposed !== null ? ["proposed"] : []),
    reshaped ? "not read" : STATE_LABEL[row.state],
  ].join(" · ");
  const flag = record?.flags[row.block.key];
  return { title, ...(full !== title ? { full } : {}), sub, flag: row.state === "flagged" && flag !== undefined && flag.split === undefined ? flag.reason : null };
}

/**
 * The block's panel (design turn 194, rules 11 and 12; 194g): its head, then Picture, Voice and
 * Timing as tabs, each with a short fact (`Picture 10:22`, `Voice v3`), the chosen tab's body
 * scrolling under them and its foot held at the panel's bottom. Where the panel is the raised sheet
 * (194h) this head is the sheet's: the sheet draws none of its own, and the title takes the focus
 * a sheet gives its heading on opening.
 */
export function BlockPanel({ head, tab, onTab, facts, onClose, children, acts = null, lines = null }: {
  head: { title: string; full?: string; sub: string; flag: string | null };
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  facts: Partial<Record<PanelTab, string>>;
  onClose: () => void;
  children: Record<PanelTab, ReactNode>;
  /** On touch, the block's seams under its head (design turn 198j): Join next and Split. */
  acts?: ReactNode;
  /** The block's lines with a Split at each gap, shown in the tabs' place while Split is open (198j). */
  lines?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="fy-abp" data-testid="audiobook-block-panel">
      <header className="fy-abp__head" data-testid="audiobook-block">
        <div className="fy-abp__title">
          <h2 data-testid="audiobook-block-title" tabIndex={-1} {...(head.full !== undefined ? { title: head.full } : {})}>{head.title}</h2>
          <button type="button" className="fy-abp__x" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <p className="fy-abp__sub">{head.sub}</p>
        {head.flag !== null && <p className="fy-abp__flag">{head.flag}</p>}
      </header>
      {acts}
      {lines !== null ? lines : (
      <>
      <div className="fy-abp__tabs" role="tablist" aria-label="Block">
        {PANEL_TABS.map((item) => (
          <button
            key={item.tab}
            type="button"
            role="tab"
            id={`${id}-${item.tab}`}
            aria-selected={tab === item.tab}
            aria-controls={`${id}-panel`}
            className={`fy-abp__tab${tab === item.tab ? " fy-abp__tab--on" : ""}`}
            onClick={() => onTab(item.tab)}
            data-testid={`audiobook-tab-${item.tab}`}
          >
            {item.label}
            {facts[item.tab] !== undefined && <em>{facts[item.tab]}</em>}
          </button>
        ))}
      </div>
      <div className="fy-abp__body" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {children[tab]}
      </div>
      </>
      )}
    </section>
  );
}

/**
 * The card `Direct this chapter` leaves in the dock (R-10): the model's own sentence or two,
 * the counts as data, and the whole accepted or discarded. Once accepted, the ✓ line, and the
 * dock's prompt becomes `Direct again`.
 */
export function DirectionCard({ run, chapterOrder, blocks, onAccept, onDiscard }: {
  run: NonNullable<ReturnType<typeof useDirectionRuns>[string]>;
  chapterOrder: number;
  /** The chapter's blocks, for the tally (design turn 184b): `122 blocks · 34 directed`. */
  blocks?: number;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const label = `chapter ${String(chapterOrder).padStart(2, "0")}`;
  const version = run.chapterVersion !== undefined ? ` · direction v${run.chapterVersion}` : "";
  const proposed = run.state === "directed" || run.state === "accepting" || run.state === "accepted";
  // Of the blocks addressed, those the proposal moves off the ordinary reading (design turn 184b).
  const moved = run.moved ?? 0;
  return (
    <section className="fy-ab__card" data-testid="direction-card" data-state={run.state}>
      <h3 className="fy-ab__card-title">Direct this chapter</h3>
      {run.state === "directing" && <p className="fy-mono fy-ab__card-line">directing…</p>}
      {proposed && run.summary !== undefined && <p className="fy-ab__card-text">{run.summary}</p>}
      {proposed && (
        <p className="fy-mono fy-ab__card-line">
          {run.state === "accepted" ? "✓ directed" : run.state === "accepting" ? "accepting…" : "proposed"} · {label}
          {version} · {blocks !== undefined ? `${blocks} blocks · ${moved} directed` : `${run.directed} block${run.directed === 1 ? "" : "s"}`}
          {run.cast !== undefined ? ` · ${run.cast.lines} line${run.cast.lines === 1 ? "" : "s"} cast` : ""}
          {run.chapterNote !== undefined ? " · chapter note" : ""}
          {run.speakerNotes !== undefined ? ` · ${Object.keys(run.speakerNotes).length} speaker note${Object.keys(run.speakerNotes).length === 1 ? "" : "s"}` : ""} · {run.dropped} dropped · nothing spent
        </p>
      )}
      {run.state === "directed" && run.chapterNote !== undefined && <p className="fy-ab__card-text" data-testid="direction-chapter-note"><span className="fy-vd__sent-k">Chapter note</span> {run.chapterNote}</p>}
      {run.state === "directed" && run.reason !== undefined && <p className="fy-mono fy-ch__who-where--warn">{run.reason}</p>}
      {run.state === "directed" && (
        <span className="fy-ab__control">
          <Button variant="primary" onClick={onAccept} data-testid="direction-accept">
            Accept
          </Button>
          <Button variant="ghost" onClick={onDiscard}>
            Discard
          </Button>
        </span>
      )}
      {(run.state === "failed" || run.state === "unavailable" || run.state === "stopped") && (
        <>
          <p className="fy-mono fy-ch__who-where--warn">{run.state === "stopped" ? "stopped · nothing written" : `could not direct · ${run.reason ?? "the run failed"}`}</p>
          <Button variant="ghost" onClick={onDiscard}>
            Put away
          </Button>
        </>
      )}
    </section>
  );
}

/** `0:03` — a short clip's place as a player shows it. */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/**
 * A block under the held proposal (design turn 184b, SPEC-047 R-55): its proposed direction as
 * data — the delivery, the note with its count, the markers dashed on the block — what it would
 * be sent as, with a book or chapter note the reader cannot take struck, and `Hear block`: one
 * read of the block exactly as it would be sent, priced, free or held as every read is.
 */
export function ProposedBlock({ row, proposed, model, hear }: {
  row: BlockRow;
  proposed: NonNullable<BlockRow["proposed"]>;
  model: ManifestModel | null;
  hear?: { worldId: string; productionId: string; chapterFile: string; number?: number };
}) {
  const [hearId, setHearId] = useState<string | null>(null);
  const heard = useHeardLines()[hearId ?? ""];
  const slug = useStore().state?.world?.meta.slug;
  const playback = usePlayback();
  useEffect(() => setHearId(null), [row.block.key]);
  useEffect(() => {
    if (heard?.state !== "done" || slug === undefined) return;
    void playClip({ id: `hear-${hearId}`, url: mediaUrl(slug, heard.file), title: row.mark, sub: "proposed" });
  }, [heard?.state]);
  const sent = proposed.sentAs?.map((part) => part.text).join(" ") ?? normalizeSpeechText(row.block.text);
  // The requests a read makes: the coordinator's count once it has quoted, the parts the markers make before (codex on PR 1479).
  const reads = heard?.state === "priced" ? heard.parts : (proposed.sentAs?.length ?? 1);
  const tokenPriced = model?.pricing.kind === "perToken" && model.speechPlan !== "free-plan";
  const plan = speechPlanLabel(model);
  const price = model === null || tokenPriced || plan !== null || row.speaker.provider === "kokoro" ? 0 : estimateSpeechMicroUsd(model, sent);
  const what = heard?.state === "priced" ? `~${formatMicroUsd(heard.estimatedMicroUsd)}` : plan ?? (row.speaker.provider === "kokoro" ? "free" : tokenPriced ? "get price" : formatMicroUsd(price));
  const playing = playback.clip?.id === `hear-${hearId}` && playback.status !== "ended" && playback.status !== "idle";
  const styles = [...new Set((proposed.sentAs ?? []).flatMap((part) => (part.style !== undefined ? [part.style] : [])))];
  return (
    <section className="fy-bible__panel fy-ab__direction" data-testid="audiobook-proposed">
      <div className="fy-ab__row fy-ab__row--stack">
        <span className="fy-ab__label">Delivery</span>
        <span className="fy-ab__chips" role="radiogroup" aria-label="Delivery">
          {AUDIOBOOK_DELIVERIES.map((delivery) => (
            <span key={delivery} role="radio" aria-checked={proposed.input.delivery === delivery} aria-disabled="true" className={`fy-ab__chip${proposed.input.delivery === delivery ? " fy-ab__chip--on" : ""}`}>
              {delivery}
            </span>
          ))}
        </span>
      </div>
      <div className="fy-ab__row fy-ab__row--top">
        <span className="fy-ab__label">Note</span>
        <span className="fy-ab__sentcol">
          <span className="fy-ab__sent-style">{proposed.input.note ?? "none"}</span>
        </span>
        <span className="fy-ab__note-count fy-mono">{`${proposed.input.note?.length ?? 0} / ${CADENCE_NOTE_MAX}`}</span>
      </div>
      <div className="fy-ab__row fy-ab__row--top">
        <span className="fy-ab__label">Sent as</span>
        <span className="fy-ab__sentcol">
          {styles.map((style) => (
            <span key={style} className="fy-ab__sent-style fy-mono" data-testid="proposed-sent-style">
              <span className="fy-vd__sent-k">style</span> {style}
            </span>
          ))}
          <span className="fy-ab__sent fy-mono" data-testid="proposed-sent-as">
            <span><span className="fy-vd__sent-k">text</span> {sent}</span>
          </span>
          {proposed.held.length > 0 && (
            <span className="fy-ab__sent-style fy-vd__sent-held fy-mono">
              <span className="fy-vd__sent-k">Held</span> {heldWords(viewPlan(proposed.input), proposed.held).join(" · ")} — {model?.displayName ?? "this reader"}
            </span>
          )}
          {proposed.readingHeld.map((held) => (
            <s key={held.which} className="fy-ab__sent-style fy-vd__sent-held fy-mono" data-testid="proposed-reading-held">{readingHeldWords(held, model)}</s>
          ))}
        </span>
      </div>
      {hear !== undefined && (
        <div className="fy-ab__hear" data-testid="proposed-hear-row">
          <button
            type="button"
            className="fy-ch__derive"
            disabled={heard?.state === "working"}
            data-testid="proposed-hear"
            onClick={() => setHearId(hearAudiobookLine(hear.worldId, hear.productionId, hear.chapterFile, row.block.key, undefined, heard?.state === "priced" ? heard.token : undefined, true))}
          >
            {playing ? "■ " : ""}Hear block{hear.number !== undefined ? ` ${hear.number}` : ""}
            {` · ${what} · ${reads} read${reads === 1 ? "" : "s"}`}
          </button>
          {playing && <span className="fy-mono">{clock(playback.currentTime)} / {clock(playback.duration)}</span>}
          {heard?.state === "working" && <span className="fy-mono">reading…</span>}
          {heard?.state === "refused" && <span className="fy-ch__who-where fy-mono fy-ch__who-where--warn">{heard.refused}</span>}
        </div>
      )}
    </section>
  );
}

/**
 * The book note and the chapter note (design turn 184, SPEC-047 R-53): two 36-high rows under
 * the narrator line, as turn 181's note — the label, the words, the count — written when the
 * field is left.
 */
/**
 * Whether the book, or any chapter of it, is being read (codex on PR 1479): the coordinator
 * refuses a note written meanwhile, production-wide, so every note field holds while it is
 * rather than taking typing that silently goes back.
 */
export function useProductionReading(worldId: string, productionId: string): boolean {
  const book = useAudiobookBooks()[productionId];
  const runs = useAudiobookRuns();
  return book?.state === "reading" || Object.entries(runs).some(([key, run]) => key.startsWith(`${worldId}/${productionId}/`) && run.state === "reading");
}

/**
 * The book note and the chapter note behind one press (design turn 194, rule 5): `Notes · 2`
 * counts the notes set, `Notes` alone when none is. It opens a 520 sheet under the press, the two
 * fields with their counts as built, each written when it is left; Escape or a press outside closes
 * it. The fields hold, and so does the press, offline or while the book is read (codex on PR 1479).
 */
export function NotesPress({ worldId, productionId, chapterFile, notes, disabled: off }: {
  worldId: string;
  productionId: string;
  chapterFile: string;
  notes: AudiobookReadingNotes;
  disabled: boolean;
}) {
  // Asked on every render: behind `off ||` the hook was skipped while offline, and the hooks after
  // it shifted the moment the connection came back.
  const reading = useProductionReading(worldId, productionId);
  const disabled = off || reading;
  const pop = usePopover();
  const set = [notes.book, notes.chapter].filter((note) => note !== undefined && note !== "").length;
  return (
    <span className="fy-ab__tool">
      <button
        ref={pop.press}
        type="button"
        className={`fy-ab__pill${pop.open ? " fy-ab__pill--on" : ""}`}
        aria-expanded={pop.open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => pop.setOpen((was) => !was)}
        data-testid="reading-notes-press"
      >
        Notes{set > 0 && <>{SPOKEN_GAP}<em>{set}</em></>}
      </button>
      {pop.open && (
        <div ref={pop.panel} className="fy-ab__notes" role="dialog" aria-label="Notes" data-testid="reading-notes" onKeyDown={pop.onKey}>
          <NoteRow label="Book note" value={notes.book} disabled={disabled} stacked area onCommit={(note) => setAudiobookReadingNote(worldId, productionId, note)} />
          <NoteRow label="Chapter note" value={notes.chapter} disabled={disabled} stacked area onCommit={(note) => setAudiobookReadingNote(worldId, productionId, note, chapterFile)} />
        </div>
      )}
    </span>
  );
}

/**
 * One note, label then field then count. `area` keeps that row but wraps the field to two lines:
 * a chapter note runs to 300 characters, and on one line it was cut off however wide the window
 * (turn 188). Enter still leaves the field, as it does on the single line.
 */
export function NoteRow({ label, value, disabled, onCommit, max = CADENCE_NOTE_MAX, multiline = false, area = false, stacked = false }: { label: string; value: string | undefined; disabled: boolean; onCommit: (note: string | null) => void; max?: number; multiline?: boolean; area?: boolean; /** The label and count over the field (194e's notes sheet). */ stacked?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value ?? "";
  const commit = () => {
    if (draft === null) return;
    const trimmed = draft.trim().slice(0, max);
    setDraft(null);
    if (trimmed === (value ?? "")) return;
    onCommit(trimmed === "" ? null : trimmed);
  };
  const props = {
    className: multiline ? "fy-ab__booknote-input" : area ? "fy-vd__note-input fy-vd__note-input--area" : "fy-vd__note-input",
    value: shown,
    maxLength: max,
    disabled,
    "aria-label": label,
    onBlur: commit,
  };
  return (
    <label className={`${multiline ? "fy-ab__booknote" : area ? "fy-vd__note fy-vd__note--area" : "fy-vd__note"}${stacked ? " fy-vd__note--stacked" : ""}`}>
      <span className="fy-vd__note-k">{label}</span>
      {multiline ? (
        <textarea {...props} rows={2} onChange={(event) => setDraft(event.target.value)} />
      ) : area ? (
        <textarea {...props} rows={2} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); (event.target as HTMLTextAreaElement).blur(); } }} />
      ) : (
        <input {...props} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
      )}
      <span className="fy-vd__note-count fy-mono">{`${shown.length} / ${max}`}</span>
    </label>
  );
}

/**
 * The Direct sheet (design turn 184a, SPEC-047 R-51, R-54): what the director reads, one row
 * each in a bordered list, label then value; what else to ask for; and `Direct`. Nothing spent:
 * the director is the writing service, and nothing it reads goes to a voice.
 */
export function DirectSheet({ worldId, productionId, chapterFile, chapterOrder, blocks, reading, chapterNote, onCancel, onDirect }: {
  worldId: string;
  productionId: string;
  chapterFile: string;
  chapterOrder: number;
  blocks: number;
  reading: AudiobookReading;
  /** A chapter note stands already: drafting one is not offered ticked. */
  chapterNote: boolean;
  onCancel: () => void;
  onDirect: (also: DirectAlso) => void;
}) {
  const [askId, setAskId] = useState<string | null>(null);
  const ask = useAudiobookAsks()[askId ?? ""];
  // Asked once the sheet opens, and again when the answer is gone — a reconnect replays none (codex on PR 1479).
  const asked = ask !== undefined;
  useEffect(() => {
    if (!asked) setAskId(previewDirection(worldId, productionId, chapterFile));
  }, [worldId, productionId, chapterFile, asked]);
  const reads = ask?.state === "reads" ? ask.reads : null;
  const castNeeded = reading !== "narrator" && reads?.cast !== undefined;
  const notesSet = reads?.speakerNotes;
  const allNotes = notesSet === undefined || (notesSet.of > 0 && notesSet.set === notesSet.of);
  const [cast, setCast] = useState(true);
  const [draftChapter, setDraftChapter] = useState(!chapterNote);
  const [draftSpeakers, setDraftSpeakers] = useState(true);
  // Cast first, the speakers are the cast's, unknown until it runs and none of them noted yet as
  // far as Reads can say: drafting their notes is offered, and the coordinator asks only for the
  // speakers its cast makes that have none (R-54). Unoffered, one run could not do all three.
  const castFirst = castNeeded && cast;
  const speakersNoted = !castFirst && allNotes;
  const pad = String(chapterOrder).padStart(2, "0");
  const row = (label: string, value: string, description?: string) => (
    <div className="fy-ab__read" key={label}>
      <b>{label}</b>
      <span title={description} aria-description={description}>{value}</span>
    </div>
  );
  const check = (label: string, on: boolean, set: (on: boolean) => void, data?: string, disabled = false) => (
    <label className="fy-ab__also">
      <input type="checkbox" checked={on && !disabled} disabled={disabled} onChange={(event) => set(event.target.checked)} />
      <span>{label}</span>
      {data !== undefined && <span className="fy-mono fy-ab__also-data">{data}</span>}
    </label>
  );
  return (
    <section className="fy-bible__panel fy-ab__directsheet" data-testid="direct-sheet" aria-label="Direct this chapter">
      <div>
        <h3 className="fy-ab__card-title">Direct this chapter</h3>
        <p className="fy-mono fy-ab__card-line">Chapter {pad} · {blocks} block{blocks === 1 ? "" : "s"}</p>
      </div>
      <span className="fy-ab__label">Reads</span>
      {ask?.state === "refused" ? (
        <p className="fy-mono fy-ch__who-where--warn">{ask.refused}</p>
      ) : reads === null ? (
        <p className="fy-mono">reading…</p>
      ) : (
        <div className="fy-ab__reads" data-testid="direct-reads">
          {row("Chapter", [reads.chapter.synopsis ? "synopsis" : "no synopsis", ...(reads.chapter.pov !== undefined ? [`point of view ${reads.chapter.pov}`] : []), `v${reads.chapter.version}`].join(" · "))}
          {row("Tone", reads.tone ?? "none")}
          {row("Speakers", reads.speakers.length === 0 ? "none" : `${reads.speakers.join(" · ")} — their sheets`)}
          {row("Narrator", reads.narrator.label, reads.narrator.description)}
          {row("Notes", [...(reads.notes.book ? ["book note"] : []), ...(reads.notes.chapter ? ["chapter note"] : []), `${reads.notes.speakers} speaker note${reads.notes.speakers === 1 ? "" : "s"}`].join(" · "))}
          {row("Before", reads.before === null ? "first chapter" : reads.before.blocks === 0 ? "nothing directed yet" : `chapter ${String(reads.before.order).padStart(2, "0")} · ${reads.before.blocks} directed`)}
        </div>
      )}
      <span className="fy-ab__label">Also</span>
      {castNeeded && check("Cast the lines first", cast, setCast, reads?.cast)}
      {check("Draft the chapter note", draftChapter, setDraftChapter)}
      {reading === "performed" && check("Draft speaker notes", draftSpeakers, setDraftSpeakers, castFirst || notesSet === undefined ? undefined : allNotes ? `all ${notesSet.of} set` : `${notesSet.of - notesSet.set} of ${notesSet.of} missing`, speakersNoted)}
      <div className="fy-ab__control fy-ab__directsheet-foot">
        <span className="fy-mono">nothing spent</span>
        <span className="fy-ch__panelpush" />
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="direct-sheet-direct"
          disabled={reads === null || (reading !== "narrator" && reads.cast !== undefined && !cast)}
          onClick={() => onDirect({ ...(castFirst ? { cast: true } : {}), ...(draftChapter ? { chapterNote: true } : {}), ...(reading === "performed" && draftSpeakers && !speakersNoted ? { speakerNotes: true } : {}) })}
        >
          Direct
        </Button>
      </div>
    </section>
  );
}

/**
 * The book's reading (design turn 184c, SPEC-047 R-53, R-54): the book note, and each speaker's
 * note with where it came from — `sheet` for one drafted from the speaker's sheet, `you` for the
 * author's — and `Draft from the sheets` for the speakers with none. An author's note is never
 * replaced.
 */
/**
 * The book's requests (design turn 185d): `Requests · Grouped · Per paragraph`, shown only where
 * the book's reader can group and this machine can split; grouped by default. With the book's
 * counts beside it: as many requests as `Read the book` would make, and a block a request.
 */
export function BookRequests({ worldId, productionId, setting, reader, counts }: {
  worldId: string;
  productionId: string;
  setting: "grouped" | "per-paragraph";
  /** `Gemini Flash`. */
  reader: string;
  counts?: { requests: number; perParagraph: number };
}) {
  const connection = useStore().connection;
  const held = connection !== "open" || useProductionReading(worldId, productionId);
  return (
    <div className="fy-ab__requests" data-testid="book-requests">
      <div className="fy-ab__requests-row">
        <span className="fy-vd__note-k">Requests</span>
        <span className="fy-ab__chips" role="radiogroup" aria-label="Requests">
          {(["grouped", "per-paragraph"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={setting === value}
              disabled={held}
              className={`fy-ab__chip${setting === value ? " fy-ab__chip--on" : ""}`}
              onClick={() => {
                if (setting !== value) setAudiobookRequests(worldId, productionId, value);
              }}
            >
              {value === "grouped" ? "Grouped" : "Per paragraph"}
            </button>
          ))}
        </span>
        <span className="fy-mono fy-vd__note-count">{reader} · up to ~5 min a request</span>
      </div>
      {counts !== undefined && (
        <div className="fy-ab__requests-row">
          <span className="fy-vd__note-k">Book</span>
          <span>{counts.requests} request{counts.requests === 1 ? "" : "s"}</span>
          <span className="fy-mono fy-vd__note-count">{counts.perParagraph} per paragraph</span>
        </div>
      )}
    </div>
  );
}

export function BookReadingPanel({ worldId, productionId, title, bookNote, speakers, onDone, requests }: {
  worldId: string;
  productionId: string;
  /** `Performed · Ife's voice`. */
  title: string;
  /** The book's requests, where its reader can group (design turn 185d). */
  requests?: Parameters<typeof BookRequests>[0];
  bookNote: string | undefined;
  speakers: ReadonlyArray<{ key: string; name: string; note?: string; source?: "sheet" }>;
  onDone: () => void;
}) {
  const connection = useStore().connection;
  const reading = useProductionReading(worldId, productionId);
  const held = connection !== "open" || reading;
  const [askId, setAskId] = useState<string | null>(null);
  const ask = useAudiobookAsks()[askId ?? ""];
  const missing = speakers.some((speaker) => speaker.note === undefined);
  return (
    <section className="fy-ab__bookreading" data-testid="book-reading" aria-label="The book's reading">
      <h3 className="fy-ab__card-title">{title}</h3>
      {requests !== undefined && <BookRequests {...requests} />}
      <NoteRow label="Book note" value={bookNote} disabled={held} multiline onCommit={(note) => setAudiobookReadingNote(worldId, productionId, note)} />
      <div className="fy-ab__bookreading-lbl">
        <span className="fy-vd__note-k">Speakers</span>
        {speakers.some((speaker) => speaker.source === "sheet") && <span className="fy-mono fy-vd__note-count">drafted from the sheets</span>}
      </div>
      {speakers.map((speaker) => (
        <div key={speaker.key} className="fy-ab__who" data-testid="book-reading-speaker">
          <b>{speaker.name}</b>
          <SpeakerNoteInput worldId={worldId} productionId={productionId} speaker={speaker} disabled={held} />
          <small className="fy-mono">{`${speaker.note?.length ?? 0} / ${CADENCE_PHRASE_MAX}${speaker.note === undefined ? "" : speaker.source === "sheet" ? " · sheet" : " · you"}`}</small>
        </div>
      ))}
      {ask?.state === "refused" && <p className="fy-mono fy-ch__who-where--warn">{ask.refused}</p>}
      {ask?.state === "drafted" && <p className="fy-mono">{ask.drafted} drafted</p>}
      <div className="fy-ab__control fy-ab__bookreading-foot">
        <Button
          variant="ghost"
          disabled={!missing || held || ask?.state === "working"}
          data-testid="draft-from-sheets"
          onClick={() => setAskId(draftAudiobookSpeakerNotes(worldId, productionId))}
        >
          {ask?.state === "working" ? "drafting…" : "Draft from the sheets"}
        </Button>
        <Button variant="primary" onClick={onDone}>Done</Button>
      </div>
    </section>
  );
}

export function SpeakerNoteInput({ worldId, productionId, speaker, disabled }: { worldId: string; productionId: string; speaker: { key: string; name: string; note?: string }; disabled: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? speaker.note ?? "";
  const commit = () => {
    if (draft === null) return;
    const trimmed = draft.trim().slice(0, CADENCE_PHRASE_MAX);
    setDraft(null);
    if (trimmed === (speaker.note ?? "")) return;
    setAudiobookNote(worldId, productionId, speaker.key, trimmed === "" ? null : trimmed);
  };
  return (
    <input
      className="fy-ab__note-input"
      value={value}
      maxLength={CADENCE_PHRASE_MAX}
      disabled={disabled}
      aria-label={`Note · ${speaker.name}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
    />
  );
}

/** A figure the checks measured, or a dash. */
const db = (value: number | null | undefined, unit: string) => (value === null || value === undefined ? "—" : `${value.toFixed(1).replace("-", "\u2212")} ${unit}`);

/**
 * Upload a take (design turn 155c, SPEC-047 R-35, R-36): the block's words in its speaker's
 * colour over the file and what it is, the checks as data — a warning never refuses — then the
 * performer and the rights, given once, and `Keep as take`.
 */
export function RecordedTakeDialog({ staged, row, onCancel, onReplace, onKeep }: {
  staged: import("../lib/store.js").StagedTake;
  row: BlockRow;
  onCancel: () => void;
  onReplace: () => void;
  onKeep: (basis: "self" | "authorized" | "licensed", performer?: string) => void;
}) {
  const [performer, setPerformer] = useState("");
  const [basis, setBasis] = useState<"self" | "authorized" | "licensed" | null>(null);
  const tone = row.speakerKey === null ? "narrator" : row.colour === null ? "none" : String(row.colour);
  const checks = staged.checks;
  // Level against Retail's figures (R-23, R-35): the foundation measures RMS and peak on every file.
  const level = checks === undefined ? null : retailLevel(checks);
  const noise = checks?.noiseFloor ?? "unavailable";
  const rows: { key: string; label: string; value: string; outcome: string }[] = [
    {
      key: "words",
      label: "Words",
      value: checks === undefined || checks.words === "unchecked" ? "unchecked" : checks.words === "match" ? "match" : `${checks.differences} differ`,
      outcome: checks === undefined || checks.words === "unchecked" ? "unavailable" : checks.words === "match" ? "pass" : "warning",
    },
    { key: "loudness", label: "Loudness", value: db(checks?.rmsDbfs, "dBFS"), outcome: level?.loudness ?? "unavailable" },
    { key: "peak", label: "Peak", value: db(checks?.samplePeakDbfs, "dBFS"), outcome: level?.peak ?? "unavailable" },
    { key: "noise", label: "Noise floor", value: noise === "unavailable" ? "—" : noise, outcome: noise },
  ];
  const source = checks;
  const technical = source === undefined ? "" : [
    source.durationSec !== null ? `${source.durationSec.toFixed(1)} s` : null,
    source.sampleRateHz !== null ? `${Math.round(source.sampleRateHz / 100) / 10} kHz` : null,
    source.channels === 1 ? "mono" : source.channels === 2 ? "stereo" : source.channels !== null ? `${source.channels} ch` : null,
  ].filter((part) => part !== null).join(" · ");
  const refused = staged.state === "refused" ? staged.refused : undefined;
  return (
    <EditorDialog open title="Upload a take" subtitle={`${row.mark} · ${row.block.key}`} onClose={onCancel} width={540}>
      <div className="fy-rectake" data-testid="recorded-take-dialog">
        <div className={`fy-rectake__quote fy-voice--${tone}`}>{row.block.text}</div>
        {refused !== undefined ? (
          <p className="fy-rectake__refused">{refused}</p>
        ) : (
          <>
            <div className="fy-rectake__file">
              <span className="fy-rectake__name">{staged.file ?? ""}</span>
              <span className="fy-mono fy-rectake__tech">{technical}</span>
              <Button variant="ghost" onClick={onReplace}>Replace</Button>
            </div>
            <div className="fy-rectake__checks" data-testid="recorded-take-checks">
              {rows.map((item) => (
                <div key={item.key} className={`fy-rectake__check fy-rectake__check--${item.outcome}`}>
                  <span className="fy-rectake__check-label">{item.label}</span>
                  <span className="fy-mono fy-rectake__check-value">{item.value}</span>
                </div>
              ))}
            </div>
            <div className="fy-rectake__who">
              <label className="fy-rectake__field">
                <span>Performer</span>
                <input className="fy-rectake__input" value={performer} maxLength={80} onChange={(event) => setPerformer(event.target.value)} />
              </label>
              <div className="fy-rectake__field">
                <span>Rights</span>
                <span className="fy-seg" role="group" aria-label="Rights">
                  {([["self", "My voice"], ["authorized", "Authorized"], ["licensed", "Licensed"]] as const).map(([value, label]) => (
                    <button key={value} type="button" className={`fy-seg__item${basis === value ? " fy-seg__item--active" : ""}`} aria-pressed={basis === value} onClick={() => setBasis(value)}>
                      {label}
                    </button>
                  ))}
                </span>
              </div>
            </div>
            {staged.refused !== undefined && <p className="fy-rectake__refused">{staged.refused}</p>}
          </>
        )}
        <div className="fy-rectake__foot">
          <span className="fy-mono fy-rectake__tech">{refused === undefined ? "wav · mono" : ""}</span>
          <span className="fy-rectake__push" />
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          {refused !== undefined ? (
            <Button variant="primary" onClick={onReplace}>Choose another</Button>
          ) : (
            <Button
              variant="primary"
              disabled={basis === null || staged.state === "keeping"}
              title={basis === null ? "say whose voice it is" : undefined}
              onClick={() => basis !== null && onKeep(basis, performer.trim() === "" ? undefined : performer.trim())}
              data-testid="recorded-take-keep"
            >
              Keep as take
            </Button>
          )}
        </div>
      </div>
    </EditorDialog>
  );
}

/**
 * A recorded speaker's lines out and back (design turn 155d, SPEC-047 R-39): the script as a PDF
 * — the lines awaiting, or all of them — and the files a performer sends back, each matched by
 * the id in its name and checked; what passes or warns is ticked, what is refused is not and
 * cannot be; the rights are given once for the batch.
 */
export function SpeakerLinesDialog({ worldId, productionId, speaker, label, tone, onClose }: {
  worldId: string;
  productionId: string;
  speaker: string;
  label: string;
  tone: string;
  onClose: () => void;
}) {
  const all = useSpeakerLines();
  const connection = useStore().connection;
  const [scope, setScope] = useState<"awaiting" | "all">("awaiting");
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [summaryId, setSummaryId] = useState<string | null>(null);
  const [filesId, setFilesId] = useState<string | null>(null);
  const [untick, setUntick] = useState<ReadonlySet<string>>(new Set());
  const [performer, setPerformer] = useState("");
  const [basis, setBasis] = useState<"self" | "authorized" | "licensed" | null>(null);
  const script = scriptId === null ? undefined : all[scriptId];
  const files = filesId === null ? undefined : all[filesId];
  const summary = summaryId === null ? undefined : all[summaryId];
  useEffect(() => {
    if (connection === "open") setSummaryId(previewAudiobookScript(worldId, productionId, speaker));
  }, [worldId, productionId, speaker, files?.kept, connection]);
  const hosted = typeof window !== "undefined" && window.arke?.openDataFolder !== undefined;
  const rows = files?.rows ?? [];
  const keepable = rows.filter((row) => row.refused === undefined && !untick.has(row.file));
  const refusedCount = rows.filter((row) => row.refused !== undefined).length;
  const close = () => {
    if (filesId !== null && files?.kept === undefined) discardAudiobookLines(worldId, filesId);
    onClose();
  };
  const addFiles = () => {
    if (filesId !== null && files?.kept === undefined) discardAudiobookLines(worldId, filesId);
    setUntick(new Set());
    setFilesId(stageAudiobookLines(worldId, productionId, speaker));
  };
  const check = (row: (typeof rows)[number]): { text: string; tone: string } => {
    if (row.refused !== undefined) return { text: row.refused, tone: "refused" };
    const level = retailLevel({ rmsDbfs: row.rmsDbfs ?? null, samplePeakDbfs: row.samplePeakDbfs ?? null });
    if (row.words === "differ") return { text: `${row.differences ?? 0} words differ`, tone: "warning" };
    if (level.loudness === "warning") return { text: "loudness outside retail", tone: "warning" };
    if (level.peak === "warning") return { text: "peak over retail", tone: "warning" };
    return { text: row.words === "match" ? "match" : "unchecked", tone: row.words === "match" ? "pass" : "unavailable" };
  };
  return (
    <EditorDialog open title={label} onClose={close} width={680}>
      <div className={`fy-rectake fy-rectake--lines fy-voice--${tone}`} data-testid="speaker-lines-dialog">
        <div className="fy-rectake__summary" role="status">
          <span className="fy-ab__speaker-dot" aria-hidden="true" />
          {summary?.state === "done" ? `${summary.lines} ${summary.lines === 1 ? "line" : "lines"} · ${summary.chapters} ${summary.chapters === 1 ? "chapter" : "chapters"} · ${summary.recorded} recorded · ${summary.awaiting} awaiting${summary.notCast ? ` · ${summary.notCast} chapters not cast` : ""}` : summary?.refused ?? "Loading lines…"}
        </div>
        <div className="fy-rectake__sect">
          <span className="fy-rectake__sect-title">Script</span>
          <span className="fy-rectake__push" />
          <span className="fy-seg" role="group" aria-label="Lines">
            {(["awaiting", "all"] as const).map((value) => (
              <button key={value} type="button" className={`fy-seg__item${scope === value ? " fy-seg__item--active" : ""}`} aria-pressed={scope === value} onClick={() => setScope(value)}>
                {value === "awaiting" ? `Awaiting${summary?.awaiting !== undefined ? ` ${summary.awaiting}` : ""}` : `All${summary?.lines !== undefined ? ` ${summary.lines}` : ""}`}
              </button>
            ))}
          </span>
          <Button variant="ghost" disabled={script?.state === "working"} onClick={() => setScriptId(exportAudiobookScript(worldId, productionId, speaker, label, scope))} data-testid="speaker-lines-export">
            Export
          </Button>
        </div>
        {script?.state === "done" && script.output !== undefined && (
          <div className="fy-rectake__file">
            <span className="fy-rectake__name">{script.output.split("/").pop()}</span>
            <span className="fy-mono fy-rectake__tech">
              {script.lines} line{script.lines === 1 ? "" : "s"}
              {script.notCast !== undefined && script.notCast > 0 ? ` · ${script.notCast} chapter${script.notCast === 1 ? "" : "s"} not cast` : ""}
            </span>
            {hosted && <Button variant="ghost" onClick={() => openExportsFolder(worldId)}>Show in folder</Button>}
          </div>
        )}
        {script?.state === "refused" && <p className="fy-rectake__refused">{script.refused}</p>}
        <div className="fy-rectake__sect">
          <span className="fy-rectake__sect-title">Recordings</span>
          <span className="fy-rectake__push" />
          <Button variant="ghost" disabled={files?.state === "working" || files?.state === "keeping"} onClick={addFiles} data-testid="speaker-lines-add">
            <Mic size={11} /> Add files
          </Button>
        </div>
        {files?.state === "refused" && <p className="fy-rectake__refused">{files.refused}</p>}
        {rows.length > 0 && (
          <div className="fy-rectake__table" data-testid="speaker-lines-rows">
            {rows.map((row) => {
              const verdict = check(row);
              const on = row.refused === undefined && !untick.has(row.file);
              return (
                <label key={row.file} className={`fy-rectake__tr${row.refused !== undefined ? " fy-rectake__tr--off" : ""}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={row.refused !== undefined || files?.kept !== undefined}
                    onChange={() => setUntick((held) => {
                      const next = new Set(held);
                      if (next.has(row.file)) next.delete(row.file);
                      else next.add(row.file);
                      return next;
                    })}
                  />
                  <span className="fy-mono fy-rectake__cell">{row.file}</span>
                  <span className="fy-rectake__cell">{row.quote ?? "—"}</span>
                  <span className={`fy-mono fy-rectake__verdict fy-rectake__verdict--${verdict.tone}`}>{verdict.text}</span>
                </label>
              );
            })}
          </div>
        )}
        {rows.length > 0 && files?.kept === undefined && (
          <div className={`fy-rectake__who fy-voice--${tone}`}>
            <label className="fy-rectake__field">
              <span>Performer</span>
              <input className="fy-rectake__input" value={performer} maxLength={80} onChange={(event) => setPerformer(event.target.value)} />
            </label>
            <div className="fy-rectake__field">
              <span>Rights</span>
              <span className="fy-seg" role="group" aria-label="Rights">
                {([["self", "My voice"], ["authorized", "Authorized"], ["licensed", "Licensed"]] as const).map(([value, text]) => (
                  <button key={value} type="button" className={`fy-seg__item${basis === value ? " fy-seg__item--active" : ""}`} aria-pressed={basis === value} onClick={() => setBasis(value)}>
                    {text}
                  </button>
                ))}
              </span>
            </div>
          </div>
        )}
        {files?.kept !== undefined && (
          <p className="fy-mono fy-rectake__tech" data-testid="speaker-lines-kept">
            kept {files.kept}
            {files.refused !== undefined ? ` · ${files.refused}` : ""}
          </p>
        )}
        <div className="fy-rectake__foot">
          <span className="fy-mono fy-rectake__tech">
            {rows.length > 0 ? `${rows.length} file${rows.length === 1 ? "" : "s"} · ${keepable.length} to keep · ${refusedCount} refused` : ""}
          </span>
          <span className="fy-rectake__push" />
          <Button variant="ghost" onClick={close}>{files?.kept !== undefined ? "Done" : "Cancel"}</Button>
          {files?.kept === undefined && (
            <Button
              variant="primary"
              disabled={filesId === null || keepable.length === 0 || basis === null || files?.state === "keeping"}
              title={basis === null ? "say whose voice it is" : undefined}
              onClick={() => filesId !== null && basis !== null && keepAudiobookLines(worldId, filesId, basis, keepable.map((row) => row.file), performer.trim() === "" ? undefined : performer.trim())}
              data-testid="speaker-lines-keep"
            >
              Keep {keepable.length} take{keepable.length === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      </div>
    </EditorDialog>
  );
}

/** Raw character offsets for casting and normalized speech offsets for cadence share one snapshot. */
export interface BlockSelection { key: string; text: string; raw: { from: number; to: number }; span: { from: number; to: number }; }
export function audiobookSelection(rows: readonly BlockRow[]): BlockSelection | null {
  const at = markerAtSelection(rows);
  if (at === null) return null;
  const row = rows.find(row => row.block.key === at.key);
  const selection = window.getSelection?.();
  const node = selection?.rangeCount ? selection.getRangeAt(0).startContainer : null;
  const host = (node?.nodeType === 1 ? node as Element : node?.parentElement)?.closest<HTMLElement>(".fy-ab__text");
  const raw = host ? rawSelection(host) : null;
  if (!row || raw === null) return null;
  return { key: at.key, text: row.block.text, raw, span: at.span };
}
