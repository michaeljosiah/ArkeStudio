import { estimateSpeechMicroUsd, freeCreditLeft, freePlanNote, speechPlanLabel, speechPriceCopy, speechPricePrefix } from "@arke-studio/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AUDIOBOOK_DELIVERIES,
  AUDIOBOOK_TITLE_KEY,
  CADENCE_NOTE_MAX,
  DEFAULT_NARRATOR,
  audiobookBlockState,
  audiobookBlocks,
  audiobookCounts,
  audiobookDirectionFor,
  audiobookHeading,
  audiobookNoteFor,
  audiobookRekeyed,
  audiobookRecordingKey,
  audiobookSpeakerColours,
  audiobookSpeakerKey,
  retailLevel,
  cadenceSupport,
  cueStart,
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
  type AudiobookDirectionInput,
  type CadencePlan,
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
import { DirectedText, MarkerMenu, VIEW_HASH, cueLabel, heldWords, markerLabel, viewPlan, type MarkerAt } from "../components/voice-direction.js";

// The marker and cue words moved to the shared direction module (design turn 181); kept here too
// for the callers and tests that name them from the audiobook.
export { cueLabel, markerLabel, type MarkerAt };
import { useMediaQuery } from "../lib/media-query.js";
import { ChevronDown, Mic, Pin, Play, Plus, Waveform } from "../components/icons.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { Button } from "../components/ui.js";
import { clearQueue, dismissPlayback, enqueueClip, jumpQueue, playClip, playbackSnapshot, usePlayback, useQueueAt } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import {
  acceptDirection,
  directChapter,
  dismissAudiobookRun,
  discardAudiobookLines,
  discardAudiobookTake,
  exportAudiobookScript,
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
  useAudiobookRuns,
  useDirectionRuns,
  useStore,
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
  connection: string;
  locked: boolean;
  /**
   * The press waits out the autosave (R-2): true when the read — or the direction, which reads
   * the same saved words (R-10) — may go now; false when the workspace has taken it, flushed the
   * draft, and will send it once the save lands.
   */
  beforeRead?: (intent: AudiobookIntent) => boolean;
}

/** What a press asks for once the save lands: the chapter, these blocks alone, a direction, or a card's acceptance. */
export type AudiobookIntent = { kind: "read"; blocks?: readonly string[] } | { kind: "direct" } | { kind: "accept" };

export interface BlockRow {
  block: AudiobookBlock;
  state: AudiobookBlockState;
  /** What the margin says: `title`, `narrator`, or the speaker's name. */
  mark: string;
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
  /** The speaker's colour, `--voice-N`, the same in every chapter; null for the narrator and a name no sheet carries. */
  colour: number | null;
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
export function directionView(text: string, input: AudiobookDirectionInput | null, model: ManifestModel, language?: string, note?: string): { held: HeldControl[]; sentAs: SentPart[] } | null {
  try {
    // The speaker's note leads every part on a row that takes it as a tag (R-45); on a row that
    // takes an instruction it rides beside the words, ahead of the block's own style, and on one
    // that takes neither it is held.
    const playing = note === undefined ? null : performanceNote(note, model, language);
    const lead = (part: SentPart): SentPart => {
      if (playing?.mode === "tag") return { ...part, text: `${playing.tag} ${part.text}` };
      if (playing?.mode === "instruction") return { ...part, style: part.style === undefined ? note! : `${note!} ${part.style}` };
      return part;
    };
    if (input === null) return { held: [], sentAs: [lead({ text: normalizeSpeechText(text) })] };
    const { plan: sent, held } = holdDirection(text, viewPlan(input), model, language);
    const sentAs = markerSegments(text, sent, model, language).map((segment) => {
      const mapped = mapCadence(segment.text, VIEW_HASH, { ...segment.plan, sourceTextHash: VIEW_HASH }, model, language);
      return lead({ text: mapped.providerText, ...(mapped.instructions !== undefined ? { style: mapped.instructions } : {}) });
    });
    return { held, sentAs };
  } catch {
    return null;
  }
}

/** The filter over the blocks (R-33): everyone, the narrator, or one speaker by key. */
export type AudiobookFilter = null | "narrator" | { speaker: string };

/** Whether a row passes the filter. */
export function inAudiobookFilter(row: Pick<BlockRow, "speakerKey">, filter: AudiobookFilter): boolean {
  if (filter === null) return true;
  if (filter === "narrator") return row.speakerKey === null;
  return row.speakerKey === filter.speaker;
}

const STATE_LABEL: Record<AudiobookBlockState, string> = { "not made": "not made", made: "made", stale: "stale", flagged: "flagged", awaiting: "awaiting recording" };

function readerOf(voice: { provider: string; model?: string; voiceId: string; label?: string }, clonedVoices: readonly ClonedVoice[] | undefined): AudiobookReader | null {
  const model = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId, clonedVoices ?? []);
  if (model === null) return null;
  return { provider: voice.provider, model, voiceId: voice.voiceId, ...(voice.label !== undefined ? { label: voice.label } : {}) };
}

/** The blocks, their states and the counts, from the one rule both ends use. */
export function useChapterAudiobook(input: ChapterAudiobookInput) {
  const { worldId, prodId, chapter, body, cast, record, missing, reading, connection, locked } = input;
  const recordedList = input.recorded;
  const recordedKeys = useMemo(() => new Set(recordedList ?? []), [recordedList]);
  const { state } = useStore();
  const world = state?.world ?? null;
  const catalogue = useStore().voiceCatalogue;
  const runs = useAudiobookRuns();
  const run = runs[`${worldId}/${prodId}/${chapter.id}`];
  const at = useQueueAt();
  const [selected, setSelected] = useState<string | null>(null);
  // The marker menu (R-42): the view's, so the page's `[` and the side's button open the same one.
  const [marker, setMarker] = useState<MarkerAt | null>(null);
  useEffect(() => setMarker(null), [chapter.id]);

  // The narrator as the coordinator chooses it (codex on PR 1180): a stored narrator whose
  // voice cannot speak now falls back the same way on both sides, or the client would judge
  // every take of the local fallback stale against a voice the run never used.
  // The book's own narrator when it has one that can speak now (R-46), by the coordinator's rule.
  // A cloned app narrator is its own world's (SPEC-046 R-37), and the catalogue marks a clone
  // whose recording is gone, so both fall back here as they do there.
  const bookNarrator = input.bookNarrator;
  const narrator = useMemo<AudiobookReader>(() => {
    const speakable = (catalogue ?? []).filter((voice) => supportsVoiceUse(voice, "narration") && voice.unavailableReason === undefined);
    const own = bookNarrator === undefined ? null : narratorFor(bookNarrator, speakable);
    const stored = state?.app.narrator ?? null;
    const chosen = own !== null && !own.fallback ? own : narratorFor(narratorAppliesTo(stored, worldId) ? stored : null, speakable);
    return { provider: chosen.provider, model: chosen.model, voiceId: chosen.voiceId, label: chosen.label ?? DEFAULT_NARRATOR.label };
  }, [state?.app.narrator, catalogue, bookNarrator, worldId]);
  const notes = input.notes;
  const models = state?.app.manifest?.models ?? [];
  const modelOf = useCallback(
    (reader: AudiobookReader): ManifestModel | null => models.find((m) => m.provider === reader.provider && m.id === reader.model && m.capability === "voice-tts") ?? null,
    [models],
  );
  const recordOrNull = record === "unreadable" ? null : record;
  const derived = useMemo(() => audiobookBlocks(body, cast, audiobookHeading(chapter.order, chapter.title)), [body, cast, chapter.order, chapter.title]);
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
    () => audiobookSpeakerColours(chapters ?? [], derived.blocks.flatMap((block) => (block.sheet !== undefined ? [block.sheet] : []))),
    [chapters, derived.blocks],
  );
  const rows = useMemo<BlockRow[]>(() => {
    return derived.blocks.map((block) => {
      let assigned = narrator;
      let mark = block.key === AUDIOBOOK_TITLE_KEY ? "title" : "narrator";
      let markWarn = false;
      // The speaker keeps its name in the margin; a retired character loses its voice (codex on
      // PR 1180): the coordinator plans with the active characters only, and a take it made in
      // the narrator's stead must read as made here too, not as stale against a retired voice.
      const sheet = block.sheet === undefined ? undefined : world?.sheets.find((candidate) => candidate.id === block.sheet);
      const active = sheet !== undefined && sheet.type === "character" && !sheet.retired;
      if (reading === "cast" && block.speaker !== undefined) {
        mark = sheet?.name ?? block.speaker;
        const reader = !active || sheet.voice === undefined ? null : readerOf(sheet.voice, world?.clonedVoices);
        if (reader === null) markWarn = true;
        else assigned = reader;
      } else if (block.speaker !== undefined) {
        mark = sheet?.name ?? block.speaker;
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
      const recorded = take?.source === "recorded";
      const byPerson = recordedKeys.has(audiobookRecordingKey(block));
      const direction = rowDirection(recordOrNull, block);
      const speakerModel = modelOf(speaker);
      const note = audiobookNoteFor({ reading, ...(notes !== undefined ? { notes: { ...notes } } : {}) }, block);
      const view = (direction === null && note === undefined) || speakerModel === null ? null : directionView(block.text, direction?.input ?? null, speakerModel, language, note);
      return {
        block,
        state: audiobookBlockState(block, recordOrNull, assigned, hasArtifact, byPerson, note),
        ...(note !== undefined ? { note } : {}),
        mark,
        markWarn,
        assigned,
        speaker,
        ...(language !== undefined ? { language } : {}),
        artifact,
        speakerKey,
        colour,
        recorded,
        byPerson,
        direction,
        held: view?.held ?? [],
        sentAs: view?.sentAs ?? null,
        byNarrator: speaker === narrator,
      };
    });
  }, [derived.blocks, narrator, reading, world, recordOrNull, hasArtifact, catalogue, modelOf, colours, recordedKeys, notes]);
  // The filter is the page's (R-33): not kept, and gone with the chapter.
  const [filter, setFilter] = useState<AudiobookFilter>(null);
  useEffect(() => setFilter(null), [chapter.id]);
  /** The filter row: everyone, the narrator, then each speaker in colour order and the names no sheet carries after. */
  const filters = useMemo(() => {
    const speakers = new Map<string, { key: string; label: string; colour: number | null; count: number }>();
    for (const row of rows) {
      if (row.speakerKey === null) continue;
      const held = speakers.get(row.speakerKey);
      if (held !== undefined) held.count += 1;
      else speakers.set(row.speakerKey, { key: row.speakerKey, label: row.mark, colour: row.colour, count: 1 });
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
  const counts = useMemo(
    () =>
      audiobookCounts(
        derived.blocks,
        recordOrNull,
        (block) => rows.find((row) => row.block.key === block.key)?.assigned ?? narrator,
        hasArtifact,
        (block) => recordedKeys.has(audiobookRecordingKey(block)),
      ),
    [derived.blocks, recordOrNull, rows, narrator, hasArtifact, recordedKeys],
  );
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

  // The player: the made takes in order, through the one queue the page read uses (R-20).
  // With a speaker chosen, Play plays that speaker's takes alone (R-33).
  const playable = useMemo(() => rows.filter((row) => row.state === "made" && row.artifact !== null && inAudiobookFilter(row, filter)), [rows, filter]);
  const queueId = `audiobook:${worldId}/${prodId}/${chapter.id}`;
  // A queue that has run dry rests on `ended` with `at` one past its last piece (codex on PR
  // 1180): that is not playing, and the head goes back to Play rather than `N+1 of N · Stop`.
  const playback = usePlayback();
  const playing = at !== null && at < playable.length && playback.status !== "ended" && playback.clip?.id === queueId;
  const play = useCallback(() => {
    if (world === null || playable.length === 0) return;
    clearQueue();
    dismissPlayback();
    playable.forEach((row, index) => {
      void enqueueClip({
        id: queueId,
        url: mediaUrl(world.meta.slug, `artifacts/${row.artifact!.file}`),
        title: `${chapter.title} · ${row.mark}`,
        sub: `audiobook · ${row.mark} · ${index + 1} of ${playable.length}`,
        part: index,
      });
    });
  }, [world, playable, queueId, chapter.title]);
  const stopPlaying = useCallback(() => {
    if (playbackSnapshot().clip?.id === queueId) dismissPlayback();
    clearQueue();
  }, [queueId]);
  useEffect(() => stopPlaying, [stopPlaying, chapter.id]);
  // A queue built for one filter is not another's: changing it stops what was playing.
  useEffect(() => stopPlaying, [stopPlaying, filter]);
  const sounding = playing && at !== null ? (playable[at] ?? null) : null;

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
  const ended = run !== undefined && run.state !== "reading" && run.state !== "priced";
  useEffect(() => {
    if (ended) {
      uploadAllowed.current = null;
      only.current = null;
    }
  }, [ended]);
  useEffect(() => {
    uploadAllowed.current = null;
    only.current = null;
  }, [chapter.id]);
  const send = useCallback(
    (options: { confirmationToken?: string; voiceUploadConfirmedFor?: string } = {}) => {
      const consent = options.voiceUploadConfirmedFor ?? uploadAllowed.current ?? undefined;
      const answers = {
        ...(options.confirmationToken !== undefined ? { confirmationToken: options.confirmationToken } : {}),
        ...(consent !== undefined ? { voiceUploadConfirmedFor: consent } : {}),
      };
      if (only.current !== null) readAudiobookBlocks(worldId, prodId, chapter.file, only.current, answers);
      else readAudiobookChapter(worldId, prodId, chapter.file, answers);
    },
    [worldId, prodId, chapter.file],
  );
  // What a press asks for goes out here, now or once the save lands (codex on PR 1186): the
  // workspace hands a deferred intent back through `resume`, so `Make again` kept past a save
  // still names its block, and every answer to a price or a consent carries it on.
  const resume = useCallback(
    (intent: AudiobookIntent) => {
      if (intent.kind === "direct") {
        directChapter(worldId, prodId, chapter.file);
        return;
      }
      if (intent.kind === "accept") {
        acceptDirection(worldId, prodId, chapter.id, chapter.file);
        return;
      }
      setUpload(null);
      uploadAllowed.current = null;
      only.current = intent.blocks ?? null;
      send();
    },
    [worldId, prodId, chapter.id, chapter.file, send],
  );
  const press = useCallback(
    (blocks: readonly string[] | null) => {
      if (locked || connection !== "open" || reading_) return;
      // Unsaved typing is not what is read (R-2): the press waits out the autosave, as the
      // chapter's other reads do, and the workspace sends it once the save lands.
      const intent: AudiobookIntent = { kind: "read", ...(blocks !== null ? { blocks } : {}) };
      if (input.beforeRead !== undefined && !input.beforeRead(intent)) return;
      resume(intent);
    },
    [locked, connection, reading_, input, resume],
  );
  const begin = useCallback(() => press(null), [press]);
  const makeAgain = useCallback((key: string) => press([key]), [press]);

  // `Direct this chapter` (R-10): the same saved words the read is made from, so the press
  // waits out the autosave the same way; the card is the run's result, held in the store.
  const directionRun = useDirectionRuns()[`${worldId}/${prodId}/${chapter.id}`];
  const directPress = useCallback(() => {
    if (locked || connection !== "open" || directionRun?.state === "directing" || directionRun?.state === "accepting") return;
    if (input.beforeRead !== undefined && !input.beforeRead({ kind: "direct" })) return;
    resume({ kind: "direct" });
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

  const head = (() => {
    if (upload !== null && run?.state !== "read") {
      return (
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
      const price = run.price;
      // The author confirms the estimate. `up to` stays only where every reader is priced by
      // the character, which a cache hit alone can lower; a token reader's estimate can be
      // passed, so it is `~`, and its service-limit cap is the dispatcher's guard, never shown
      // (SPEC-049 R-6) — said here as the maximum, it was $18.49 for about $0.40 of speech.
      return (
        <span className="fy-ab__control">
          <Button
            onClick={() => send({ confirmationToken: price.confirmationToken })}
            title="the words and the voice go to the provider · the text stays in Activity"
          >
            Confirm {price.characters.toLocaleString()} characters · {speechPricePrefix(models, price.voices.map((voice) => voice.provider))}{formatMicroUsd(price.estimatedMicroUsd)}
            {price.voices.map((voice) => ` · ${voice.label} · ${readerPlace(voice.provider)}`).join("")}
          </Button>
          {/* What a first read through a slot-keeping reader adds (SPEC-046 R-40), on the read
              that incurs it: not in the estimate, so said beside it. */}
          {price.notices.map((notice) => <span key={notice} className="fy-mono" data-testid="audiobook-notice">{notice}</span>)}
          <Button variant="ghost" onClick={() => dismissAudiobookRun(worldId, prodId, chapter.id)}>
            Cancel
          </Button>
        </span>
      );
    }
    if (reading_) {
      return (
        <span className="fy-ab__control">
          <span className="fy-mono">reading… {run.made} of {run.toMake}</span>
          <Button variant="ghost" onClick={() => stopAudiobook(worldId, prodId, chapter.file)}>
            Stop
          </Button>
        </span>
      );
    }
    return (
      <span className="fy-ab__control">
        {playing ? (
          <>
            <span className="fy-mono">
              {sounding?.mark ?? ""} · {(at ?? 0) + 1} of {playable.length}
            </span>
            <Button variant="ghost" disabled={at === null || at + 1 >= playable.length} onClick={() => jumpQueue((at ?? 0) + 1)}>
              Skip
            </Button>
            <Button variant="ghost" onClick={stopPlaying}>
              Stop
            </Button>
          </>
        ) : (
          playable.length > 0 && (
            <Button variant="ghost" onClick={play}>
              Play
            </Button>
          )
        )}
        {counts.toMake.length > 0 && (
          <Button variant="primary" disabled={locked || connection !== "open"} onClick={begin} data-testid="read-audiobook">
            Read the chapter · {counts.toMake.length} block{counts.toMake.length === 1 ? "" : "s"}
            {estimate > 0 ? ` · ${tokenPriced ? "~" : ""}${formatMicroUsd(estimate)}` : plan !== null ? ` · ${plan}` : ""}
          </Button>
        )}
      </span>
    );
  })();

  const note =
    record === "unreadable"
      ? "record unreadable · Read the chapter replaces it"
      : run?.state === "refused" || run?.state === "failed" || run?.state === "unavailable"
        ? freePlanNote(run.reason) ?? `could not read · ${run.reason ?? "the run failed"}`
        : run?.state === "stopped"
          ? "stopped · the takes made stand"
          : null;

  return {
    rows,
    counts,
    estimate,
    filter,
    setFilter,
    filters,
    head,
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
    accept,
    discard,
    setDirection,
    marker,
    setMarker,
    /** The last write outside a run — a block's direction set or refused (R-9): the refusal is said on the panel. */
    lastRecord,
    uploadTake,
    uploadDialog,
  };
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
export function ReadingMenu({ reading, narrator, disabled, onReading, onNarrator }: {
  reading: AudiobookReading;
  /** The narrator the book reads in, by name. */
  narrator: string;
  /** A run is going: the door's seg refuses a change then, and so does this. */
  disabled: boolean;
  onReading: (reading: AudiobookReading) => void;
  onNarrator: () => void;
}) {
  const [open, setOpen] = useState(false);
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
    <span className="fy-ab__reading">
      <button
        ref={button}
        type="button"
        className={`fy-ab__reading-press fy-mono${open ? " fy-ab__reading-press--open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Reading · the whole book"
        onClick={() => setOpen((was) => !was)}
        data-testid="audiobook-reading"
      >
        <span className="fy-ab__reading-k">{label}</span> · {narrator}
        <ChevronDown size={10} aria-hidden="true" />
      </button>
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

export function AudiobookBlocks({ rows, sounding, selected, onSelectionChange, onSelect, onPlayOne, slug, filter = null, choices, onPin, marker = null, onMarker, modelOf, onDirect }: {
  rows: BlockRow[];
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
}) {
  const coarse = useMediaQuery("(pointer: coarse)");
  const pressedSelection = useRef<BlockSelection | null>(null);
  const [menu, setMenu] = useState<{ key: string; selection?: { from: number; to: number } } | null>(null);
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
  return (
    <div className="fy-ab__blocks" data-testid="audiobook-blocks">
      {rows.map((row) => {
        // The margin names who speaks (R-33): a colour a speaker with a sheet, grey for the
        // narrator, a dashed dot for a name no sheet carries; a line is tinted, narration is not.
        const tone = row.speakerKey === null ? "narrator" : row.colour === null ? "none" : String(row.colour);
        return (
          <div
            key={row.block.key}
            className={`fy-ab__block fy-voice--${tone}${row.speakerKey !== null ? " fy-ab__block--line" : ""}${sounding?.block.key === row.block.key ? " fy-ab__block--sounding" : ""}${selected === row.block.key ? " fy-ab__block--selected" : ""}${inAudiobookFilter(row, filter) ? "" : " fy-ab__block--dim"}`}
            data-state={row.state}
            data-block={row.block.key}
            data-speaker={row.speakerKey ?? "narrator"}
            onPointerDown={() => { pressedSelection.current = audiobookSelection(rows); }}
            onClick={() => { onSelectionChange?.(audiobookSelection(rows) ?? pressedSelection.current); pressedSelection.current = null; onSelect(row.block.key); }}
          >
            {pinnable && row.block.paragraph >= 0 ? (
              <button
                type="button"
                className={`fy-ab__speaker fy-ab__speaker--press${menu?.key === row.block.key && menu.selection === undefined ? " fy-ab__speaker--open" : ""}`}
                title={row.markWarn ? `${row.mark} · narrator` : row.mark}
                aria-haspopup="menu"
                aria-expanded={menu?.key === row.block.key}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenu(menu?.key === row.block.key ? null : { key: row.block.key });
                }}
              >
                <i className="fy-ab__speaker-dot" aria-hidden="true" />
                <span className={`fy-ab__mark${row.markWarn ? " fy-ab__mark--warn" : ""}`}>{row.mark}</span>
              </button>
            ) : (
              <span className="fy-ab__speaker" title={row.markWarn ? `${row.mark} · narrator` : row.mark}>
                <i className="fy-ab__speaker-dot" aria-hidden="true" />
                <span className={`fy-ab__mark${row.markWarn ? " fy-ab__mark--warn" : ""}`}>{row.mark}</span>
              </span>
            )}
            <span
              className="fy-ab__text"
              onMouseUp={(event) => {
                // Words selected in narration can be made a line (SPEC-012 R-63): within one block,
                // between 1 and 600 characters; the menu opens for the selection.
                if (coarse || !pinnable || row.speakerKey !== null || row.block.paragraph < 0) return;
                const span = rawSelection(event.currentTarget);
                if (span === null) return;
                const words = row.block.text.slice(span.from, span.to);
                if (words.trim() === "" || words.length > 600) return;
                event.stopPropagation();
                setMenu({ key: row.block.key, selection: span });
              }}
            >
              <DirectedText
                raw={row.block.text}
                cues={row.direction?.input.cues ?? []}
                held={new Set(row.held.flatMap((control) => (control.cueIndex !== undefined ? [control.cueIndex] : [])))}
                {...(markable ? { onPlate: (index: number) => onMarker({ key: row.block.key, span: { from: 0, to: 0 }, edit: index }) } : {})}
              />
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
            <span className="fy-ab__marks">
              <span className="fy-ab__state-word">{row.state === "not made" ? "waiting" : STATE_LABEL[row.state]}</span>
              {row.block.pinned === true && (
                <span className="fy-ab__pin" title="set by you" aria-label="set by you">
                  <Pin size={11} />
                </span>
              )}
              {row.state === "awaiting" && (
                <span className="fy-ab__source" title="awaiting recording" aria-label="awaiting recording">
                  <Mic size={11} />
                </span>
              )}
              {row.artifact !== null && row.state !== "awaiting" &&
                (row.recorded ? (
                  <span className="fy-ab__source fy-ab__source--recorded" title="recorded" aria-label="recorded">
                    <Mic size={11} />
                  </span>
                ) : (
                  <span className="fy-ab__source" title="made by a voice" aria-label="made by a voice">
                    <Waveform size={11} />
                  </span>
                ))}
              <button
                type="button"
                className={`fy-ab__dot fy-ab__dot--${row.state.replace(" ", "-")}`}
                title={STATE_LABEL[row.state]}
                aria-label={`${STATE_LABEL[row.state]}${row.state === "made" && slug !== undefined ? " · play" : ""}`}
                disabled={row.state !== "made" || row.artifact === null}
                onClick={(event) => {
                  event.stopPropagation();
                  onPlayOne(row);
                }}
              ><Play size={16} aria-hidden="true" /></button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The row over the blocks (R-33): everyone, the narrator, each speaker with a count. Choosing one dims the rest. */
export function AudiobookFilterRow({ filters, filter, onFilter }: {
  filters: { everyone: number; narrator: number; speakers: { key: string; label: string; colour: number | null; count: number }[] };
  filter: AudiobookFilter;
  onFilter: (filter: AudiobookFilter) => void;
}) {
  if (filters.everyone === 0) return null;
  const chip = (key: string, label: string, count: number, on: boolean, next: AudiobookFilter, tone: string | null) => (
    <button
      key={key}
      type="button"
      className={`fy-ab__fchip${tone !== null ? ` fy-voice--${tone}` : ""}${on ? " fy-ab__fchip--on" : ""}`}
      aria-pressed={on}
      onClick={() => onFilter(on && next !== null ? null : next)}
    >
      {tone !== null && <i className="fy-ab__speaker-dot" aria-hidden="true" />}
      {label}
      <span className="fy-ab__fcount">{count}</span>
    </button>
  );
  return (
    <div className="fy-ab__filter" role="group" aria-label="Speakers" data-testid="audiobook-filter">
      {chip("everyone", "Everyone", filters.everyone, filter === null, null, null)}
      {filters.narrator > 0 && chip("narrator", "Narrator", filters.narrator, filter === "narrator", "narrator", "narrator")}
      {filters.speakers.map((who) =>
        chip(who.key, who.label, who.count, typeof filter === "object" && filter !== null && filter.speaker === who.key, { speaker: who.key }, who.colour === null ? "none" : String(who.colour)),
      )}
    </div>
  );
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

/** The plan's report in the panel's words: each control, then how this reader carries it. */
function reportLine(plan: CadencePlan, controls: ReturnType<typeof mapCadence>["controls"]): string {
  return controls
    .filter((control) => control.control !== "speed" || plan.speed !== 1)
    .map((control) => {
      const name = control.control === "delivery" ? plan.delivery : control.control;
      const how =
        control.status === "unsupported"
          ? (control.reason ?? "unsupported")
          : control.status === "best-effort"
            ? (control.method ?? "best-effort").replace(/ and declared settings$/, "").replace(/^audio /, "")
            : "mapped";
      return `${name} · ${how}`;
    })
    .join(" · ");
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
export function PerformedSpeaker({ worldId, productionId, chapterFile, speakerKey, name, lines, tone, note, noteHeld, line, model, slug, focused, onFocus }: {
  worldId: string;
  productionId: string;
  chapterFile: string;
  speakerKey: string;
  name: string;
  lines: number;
  tone: string;
  note?: string;
  noteHeld: boolean;
  /** The line Hear plays and Sent as shows. */
  line: BlockRow | null;
  model: ManifestModel | null;
  slug: string | undefined;
  focused: boolean;
  onFocus: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
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
        <span className="fy-ch__who-count fy-mono">
          {lines} line{lines === 1 ? "" : "s"}
        </span>
      </div>
      <div className="fy-ab__note">
        <input
          className="fy-ab__note-input"
          value={value}
          maxLength={60}
          placeholder="note"
          aria-label={`Note · ${name}`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
        />
        <span className="fy-ab__note-count fy-mono">{value.length}/60</span>
      </div>
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
export function AudiobookSide({ rows, selected, record, artifacts, slug, productionId, chapterId, chapterTitle, modelOf, onSetDirection, onMakeAgain, onUpload, onRecorded, onLines, onMarker, refused, blockHost, capturedSelection, choices, onPin, inSheet = false }: {
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
  const takes = artifacts
    .filter(
      (artifact) =>
        artifact.generation?.source === "audiobook" &&
        artifact.generation.productionId === productionId &&
        artifact.generation.chapterId === chapterId &&
        artifact.generation.block === row.block.key &&
        artifact.retiredAt === undefined,
    )
    .sort((a, b) => (a.created < b.created ? 1 : -1));
  // Who reads it, in words (turn 165): the voice and its role, never the provider's id — the
  // reader's provider and model are the Voices panel's to say, and the takes'.
  const readBy = [
    `read by ${row.speaker.label ?? row.speaker.voiceId}`,
    row.byNarrator || row.speakerKey === null ? "narrator" : row.mark,
    ...(row.speaker !== row.assigned ? ["stands in"] : row.byNarrator && row.note !== undefined ? ["performed"] : []),
  ].join(" · ");
  // The direction that stands for these words, and what the reader that will speak does with
  // each control (R-9): read off that reader's row and the line's language, so a delivery the
  // row lacks is struck with the reason before it is pressed, and the plan's own report says
  // how each control went.
  const model = modelOf(row.speaker);
  const support = model === null ? null : cadenceSupport(model, row.language);
  // The direction for these words, carried from earlier ones when the wording changed (R-43).
  const held = pending !== null && pending.key === row.block.key ? pending.plan : (row.direction?.input ?? null);
  const plan = row.direction === null ? null : viewPlan(row.direction.input);
  const text = normalizeSpeechText(row.block.text);
  const report = (() => {
    if (plan === null || model === null || pending !== null) return null;
    try {
      return reportLine(plan, mapCadence(row.block.text, plan.sourceTextHash, plan, model, row.language).controls.filter((control) => control.cueIndex === undefined));
    } catch {
      return null;
    }
  })();
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
  const addCue = (kind: "pause" | "breath" | "emphasis") => {
    const span = selectionSpan();
    if (span === null || (kind === "emphasis" && span.to <= span.from)) return;
    const cue: CadencePlan["cues"][number] =
      kind === "pause"
        ? { kind, at: span.to, length: "short" }
        : kind === "breath"
          ? { kind, at: span.from, action: "inhale" }
          : { kind, span: { from: span.from, to: span.to, text: text.slice(span.from, span.to) }, level: "moderate" };
    const cues = [...base.cues, cue].sort((a, b) => cueStart(a) - cueStart(b));
    write({ cues });
  };
  // The note (design turn 181e): to 300 on every reader. An instruction reader takes it whole; a
  // tag reader takes it as one tag to sixty and holds a longer one, struck under Sent as.
  const noteSupported = support !== null && support.note.status !== "unsupported";
  const noteMax = CADENCE_NOTE_MAX;
  const noteValue = phraseDraft ?? held?.note ?? "";
  const anySound = support !== null && Object.values(support.sounds).some((sound) => sound.status !== "unsupported");
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
  return (
    <>
      <section className="fy-bible__panel" data-testid="audiobook-block">
        {/* Turn 165: the block and who speaks it in sentence case, the reader under it in words —
            not two columns of letter-spaced capitals (issue 1324 §3). */}
        <h2 className="fy-ab__blocktitle" data-testid="audiobook-block-title">
          {row.block.key === AUDIOBOOK_TITLE_KEY ? "Title" : `Block ${rows.indexOf(row) + 1}`} · {row.speakerKey === null ? (row.block.key === AUDIOBOOK_TITLE_KEY ? chapterTitle : "Narration") : row.mark}
        </h2>
        <p className="fy-ab__readby fy-mono">{readBy}</p>
        <p className="fy-ch__stamp fy-mono">
          {[
            STATE_LABEL[row.state],
            `${row.block.text.length.toLocaleString()} characters`,
            ...(take !== undefined ? [take.format, `${take.parts} part${take.parts === 1 ? "" : "s"}`, take.costMicroUsd === null ? formatMicroUsd(take.estimatedMicroUsd) : formatMicroUsd(take.costMicroUsd)] : []),
            ...(take?.substituted !== undefined ? [`${take.substituted} · narrator`] : []),
            ...(take?.adopted !== undefined ? ["from the speech cache"] : []),
          ].join(" · ")}
        </p>
        {row.state === "flagged" && flag !== undefined && <div className="fy-ch__moved fy-ch__moved--line">{flag.reason}</div>}
      </section>
      {coarse && captured !== null && choices !== undefined && onPin !== undefined && row.speakerKey === null && row.block.paragraph >= 0 && captured.raw.to > captured.raw.from && captured.raw.to - captured.raw.from <= 600 && <div className="fy-ab__make-line">
        <Button onClick={() => setLineOpen(true)}>Make this a line</Button>
        {lineOpen && <SpeakerMenu row={row} choices={choices} onClose={() => setLineOpen(false)} onPick={pick => { onPin(row, pick, captured.raw); setLineOpen(false); }} />}
      </div>}
      <section className="fy-bible__panel fy-ab__direction" data-testid="audiobook-direction">
        {coarse && supportNotice && <p role="status" className="fy-mono">{supportNotice}</p>}
        <div className="fy-ab__row fy-ab__row--stack">
          <span className="fy-ab__label">Delivery</span>
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
        <div className="fy-ab__row">
          <span className="fy-ab__label">Note</span>
          {noteSupported ? (
            <>
              <input
                className="fy-ab__phrase"
                value={noteValue}
                maxLength={noteMax}
                aria-label="Note"
                aria-describedby={`fy-ab-note-${row.block.key}`}
                onChange={(event) => setPhraseDraft(event.target.value)}
                onBlur={commitPhrase}
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                }}
              />
              <span id={`fy-ab-note-${row.block.key}`} className="fy-ab__note-count fy-mono" data-testid="audiobook-note-count">{`${noteValue.length} / ${noteMax}`}</span>
            </>
          ) : (
            <span className="fy-ab__off fy-mono">{support === null ? "no reader" : supportWord(support.note)}</span>
          )}
        </div>
        <div className="fy-ab__row">
          <span className="fy-ab__label">Speed</span>
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
        <div className="fy-ab__row fy-ab__row--stack">
          <span className="fy-ab__label">Markers</span>
          <span className="fy-ab__cues" data-testid="audiobook-markers">
            {base.cues.length === 0 && <span className="fy-ab__off fy-mono">none</span>}
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
              <span className="fy-ab__off fy-mono" data-testid="audiobook-held">
                {[
                  ...(row.held.length > 0 ? [`${row.held.length} held · ${model?.displayName ?? "this reader"}`] : []),
                  ...((row.direction?.dropped ?? 0) > 0 ? [`${row.direction!.dropped} marker${row.direction!.dropped === 1 ? "" : "s"} dropped · words changed`] : []),
                ].join(" · ")}
              </span>
            )}
            <span className="fy-ab__cue-add">
              {onMarker !== undefined && (
                <button
                  type="button"
                  className="fy-ab__add"
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
                  <Plus size={10} aria-hidden="true" />
                  Marker
                </button>
              )}
              {(["pause", "breath", "emphasis"] as const).map((kind) => {
                const word = support?.[kind];
                const off = word === undefined || word.status === "unsupported";
                return (
                  <button
                    key={kind}
                    type="button"
                    className="fy-ab__add"
                    disabled={off}
                    aria-label={`Add ${kind}`}
                    title={word === undefined ? "no reader" : off ? supportWord(word) : `${kind} at the words selected`}
                    onClick={() => addCue(kind)}
                  >
                    <Plus size={10} aria-hidden="true" />
                    {kind[0]!.toUpperCase() + kind.slice(1)}
                  </button>
                );
              })}
              {/* `+ Sound` opens the marker menu on its Sound group alone (design turns 165, 181e),
                  where `+ Marker` opens it: beside the words on a wide window, in the sheet on a
                  narrow one. */}
              {onMarker !== undefined && (
                <button
                  type="button"
                  className="fy-ab__add"
                  disabled={!anySound}
                  aria-label="Add sound"
                  title={support === null ? "no reader" : anySound ? "sound at the words selected" : (Object.values(support.sounds)[0]?.reason ?? "no sounds")}
                  onClick={(event) => {
                    event.stopPropagation();
                    const span = selectionSpan();
                    const point = span === null ? text.length : span.to;
                    const at: MarkerAt = { key: row.block.key, span: { from: point, to: point }, only: "sound" };
                    if (inSheet) setMarkerMenu(at); else onMarker(at);
                  }}
                >
                  <Plus size={10} aria-hidden="true" />
                  Sound
                </button>
              )}
            </span>
          </span>
        </div>
        {markerMenu !== null && <MarkerMenu text={text} base={base} {...(row.language !== undefined ? { language: row.language } : {})} at={markerMenu} model={model} onClose={() => setMarkerMenu(null)} onApply={cues => { setMarkerMenu(null); send(cues === null ? null : { ...base, cues }); }} />}
        {(report !== null || refused !== null) && (
          <p className={`fy-ch__stamp fy-mono${refused !== null ? " fy-ch__who-where--warn" : ""}`} data-testid="audiobook-report">
            {refused ?? report}
          </p>
        )}
        {row.sentAs !== null && (
          <div className="fy-ab__row fy-ab__row--top">
            <span className="fy-ab__label">Sent as</span>
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
            </span>
          </div>
        )}
      </section>
      <section className="fy-bible__panel" data-testid="audiobook-takes">
        <h2 className="fy-bible__paneltitle fy-ch__paneltitle--row">
          Takes
          <span className="fy-ch__panelpush" />
          <span className="fy-mono">{takes.length}</span>
        </h2>
        {takes.length === 0 ? (
          <p className="fy-bible__empty">none yet</p>
        ) : (
          <ul className="fy-ch__who">
            {takes.map((artifact, index) => {
              const generation = artifact.generation?.source === "audiobook" ? artifact.generation : null;
              const chosen = take?.artifactId === artifact.id;
              return (
                <li key={artifact.id}>
                  <div className="fy-ch__who-head">
                    <button
                      type="button"
                      className="fy-ab__play"
                      aria-label={`Play take ${takes.length - index}`}
                      disabled={slug === undefined}
                      onClick={() => {
                        if (slug === undefined) return;
                        void playClip({ id: artifact.id, url: mediaUrl(slug, `artifacts/${artifact.file}`), title: `${chapterTitle} · ${row.mark}`, sub: `take ${takes.length - index}` });
                      }}
                    >
                      ▶
                    </button>
                    <span className="fy-ch__who-name">v{takes.length - index}</span>
                    <span className="fy-ch__who-where fy-mono">
                      {generation?.recording !== undefined
                        ? `recorded${generation.voiceLabel !== undefined ? ` · ${generation.voiceLabel}` : ""}`
                        : (
                          <>
                            {generation !== null ? `${generation.voiceLabel ?? generation.voiceId} · ${readerName(generation, modelOf(generation))}` : ""}
                            {generation?.delivery !== undefined ? ` · ${generation.delivery}` : ""}
                            {generation !== null ? ` · ${generation.costMicroUsd === null ? formatMicroUsd(generation.estimatedMicroUsd) : formatMicroUsd(generation.costMicroUsd)}` : ""}
                          </>
                        )}
                    </span>
                    <span className="fy-ch__who-count fy-mono">{chosen ? "✓" : ""}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="fy-ab__again">
          {takes.length > 0 && (
            <Button variant="ghost" onClick={() => onMakeAgain(row.block.key)} data-testid="audiobook-make-again">
              Make again
              {model !== null && row.speaker.provider !== "kokoro" ? ` · ${speechPriceCopy(model, estimateSpeechMicroUsd(model, row.block.text), creditLeft)}` : ""}
            </Button>
          )}
          {onUpload !== undefined && (
            <Button variant="ghost" onClick={() => onUpload(row.block.key)} data-testid="audiobook-upload" title="a recording of these words, from a file">
              <Mic size={11} /> Upload
            </Button>
          )}
        </div>
        {onRecorded !== undefined && (
          <label className="fy-ab__recorded" data-testid="audiobook-recorded">
            <input type="checkbox" checked={row.byPerson} onChange={() => onRecorded(audiobookRecordingKey(row.block), !row.byPerson)} />
            <span>{row.speakerKey === null ? "Narrator" : row.mark} · recorded by a person</span>
          </label>
        )}
        {onLines !== undefined && row.byPerson && (
          <div className="fy-ab__again">
            <Button variant="ghost" onClick={() => onLines(audiobookRecordingKey(row.block), row.speakerKey === null ? "Narrator" : row.mark)} data-testid="audiobook-lines">
              Lines…
            </Button>
          </div>
        )}
      </section>
    </>
  );
}

/**
 * The card `Direct this chapter` leaves in the dock (R-10): the model's own sentence or two,
 * the counts as data, and the whole accepted or discarded. Once accepted, the ✓ line, and the
 * dock's prompt becomes `Direct again`.
 */
export function DirectionCard({ run, chapterOrder, onAccept, onDiscard }: {
  run: NonNullable<ReturnType<typeof useDirectionRuns>[string]>;
  chapterOrder: number;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const label = `chapter ${String(chapterOrder).padStart(2, "0")}`;
  const version = run.chapterVersion !== undefined ? ` · direction v${run.chapterVersion}` : "";
  const proposed = run.state === "directed" || run.state === "accepting" || run.state === "accepted";
  return (
    <section className="fy-ab__card" data-testid="direction-card" data-state={run.state}>
      <h3 className="fy-ab__card-title">Direct this chapter</h3>
      {run.state === "directing" && <p className="fy-mono fy-ab__card-line">directing…</p>}
      {proposed && run.summary !== undefined && <p className="fy-ab__card-text">{run.summary}</p>}
      {proposed && (
        <p className="fy-mono fy-ab__card-line">
          {run.state === "accepted" ? "✓ directed" : run.state === "accepting" ? "accepting…" : "proposed"} · {label}
          {version} · {run.directed} block{run.directed === 1 ? "" : "s"} · {run.dropped} dropped · nothing spent
        </p>
      )}
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
  const [scope, setScope] = useState<"awaiting" | "all">("awaiting");
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [filesId, setFilesId] = useState<string | null>(null);
  const [untick, setUntick] = useState<ReadonlySet<string>>(new Set());
  const [performer, setPerformer] = useState("");
  const [basis, setBasis] = useState<"self" | "authorized" | "licensed" | null>(null);
  const script = scriptId === null ? undefined : all[scriptId];
  const files = filesId === null ? undefined : all[filesId];
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
      <div className="fy-rectake" data-testid="speaker-lines-dialog">
        <div className="fy-rectake__sect">
          <span className="fy-rectake__sect-title">Script</span>
          <span className="fy-rectake__push" />
          <span className="fy-seg" role="group" aria-label="Lines">
            {(["awaiting", "all"] as const).map((value) => (
              <button key={value} type="button" className={`fy-seg__item${scope === value ? " fy-seg__item--active" : ""}`} aria-pressed={scope === value} onClick={() => setScope(value)}>
                {value === "awaiting" ? "Awaiting" : "All"}
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
