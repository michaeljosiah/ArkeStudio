import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AUDIOBOOK_DELIVERIES,
  AUDIOBOOK_TITLE_KEY,
  DEFAULT_NARRATOR,
  audiobookBlockState,
  audiobookBlocks,
  audiobookCounts,
  audiobookDirectionFor,
  audiobookHeading,
  audiobookSpeakerColours,
  audiobookSpeakerKey,
  retailLevel,
  billableCharacters,
  cadenceSupport,
  estimateMicroUsd,
  mapCadence,
  normalizeSpeechText,
  formatMicroUsd,
  legacyVoiceModel,
  narratorFor,
  supportsVoiceUse,
  voiceSourceFor,
  type ArtifactSidecar,
  type AudiobookBlock,
  type AudiobookBlockState,
  type AudiobookDirectionInput,
  type CadencePlan,
  type AudiobookReader,
  type AudiobookReading,
  type ChapterAudiobook,
  type ChapterSummary,
  type ChapterVoices,
  type ClonedVoice,
  type ManifestModel,
} from "@arke-studio/contracts";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";
import { Mic, Pin, Waveform } from "../components/icons.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { Button } from "../components/ui.js";
import { clearQueue, dismissPlayback, enqueueClip, jumpQueue, playClip, playbackSnapshot, usePlayback, useQueueAt } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import {
  acceptDirection,
  directChapter,
  dismissAudiobookRun,
  discardAudiobookTake,
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
}

/** The filter over the blocks (R-33): everyone, the narrator, or one speaker by key. */
export type AudiobookFilter = null | "narrator" | { speaker: string };

/** Whether a row passes the filter. */
export function inAudiobookFilter(row: Pick<BlockRow, "speakerKey">, filter: AudiobookFilter): boolean {
  if (filter === null) return true;
  if (filter === "narrator") return row.speakerKey === null;
  return row.speakerKey === filter.speaker;
}

const STATE_LABEL: Record<AudiobookBlockState, string> = { "not made": "not made", made: "made", stale: "stale", flagged: "flagged" };

function readerOf(voice: { provider: string; model?: string; voiceId: string; label?: string }, clonedVoices: readonly ClonedVoice[] | undefined): AudiobookReader | null {
  const model = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId, clonedVoices ?? []);
  if (model === null) return null;
  return { provider: voice.provider, model, voiceId: voice.voiceId, ...(voice.label !== undefined ? { label: voice.label } : {}) };
}

/** The blocks, their states and the counts, from the one rule both ends use. */
export function useChapterAudiobook(input: ChapterAudiobookInput) {
  const { worldId, prodId, chapter, body, cast, record, missing, reading, connection, locked } = input;
  const { state } = useStore();
  const world = state?.world ?? null;
  const catalogue = useStore().voiceCatalogue;
  const runs = useAudiobookRuns();
  const run = runs[`${worldId}/${prodId}/${chapter.id}`];
  const at = useQueueAt();
  const [selected, setSelected] = useState<string | null>(null);

  // The narrator as the coordinator chooses it (codex on PR 1180): a stored narrator whose
  // voice cannot speak now falls back the same way on both sides, or the client would judge
  // every take of the local fallback stale against a voice the run never used.
  const narrator = useMemo<AudiobookReader>(() => {
    const speakable = (catalogue ?? []).filter((voice) => supportsVoiceUse(voice, "narration") && voice.unavailableReason === undefined);
    const chosen = narratorFor(state?.app.narrator ?? null, speakable);
    return { provider: chosen.provider, model: chosen.model, voiceId: chosen.voiceId, label: chosen.label ?? DEFAULT_NARRATOR.label };
  }, [state?.app.narrator, catalogue]);
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
      return { block, state: audiobookBlockState(block, recordOrNull, assigned, hasArtifact), mark, markWarn, assigned, speaker, ...(language !== undefined ? { language } : {}), artifact, speakerKey, colour, recorded };
    });
  }, [derived.blocks, narrator, reading, world, recordOrNull, hasArtifact, catalogue, modelOf, colours]);
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
    () => audiobookCounts(derived.blocks, recordOrNull, (block) => rows.find((row) => row.block.key === block.key)?.assigned ?? narrator, hasArtifact),
    [derived.blocks, recordOrNull, rows, narrator, hasArtifact],
  );
  // What a press would spend, before the run asks: the cloud blocks not made, by the character
  // as the row bills it (SPEC-046 R-8) — bytes or doubled CJK for the readers that count so.
  // The cache is not consulted here, so the run's own price can only be lower.
  const estimate = useMemo(
    () =>
      rows.reduce((sum, row) => {
        if (row.state === "made" || row.speaker.provider === "kokoro") return sum;
        const model = modelOf(row.speaker);
        return model === null ? sum : sum + estimateMicroUsd(model, { characters: billableCharacters(model, row.block.text) });
      }, 0),
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
  const [upload, setUpload] = useState<{ destination: string; token: string } | null>(null);
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== run?.requestId) return;
        setUpload({ destination: confirmation.destinationLabel, token: confirmation.confirmationToken });
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
      return (
        <span className="fy-ab__control">
          <Button
            onClick={() => send({ confirmationToken: price.confirmationToken })}
            title="the words and the voice go to the provider · the text stays in Activity"
          >
            Confirm {price.characters.toLocaleString()} characters · {formatMicroUsd(price.estimatedMicroUsd)}
            {price.voices.map((voice) => ` · ${voice.label} · ${voice.provider}`).join("")}
          </Button>
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
            {estimate > 0 ? ` · ${formatMicroUsd(estimate)}` : ""}
          </Button>
        )}
      </span>
    );
  })();

  const note =
    record === "unreadable"
      ? "record unreadable · Read the chapter replaces it"
      : run?.state === "refused" || run?.state === "failed" || run?.state === "unavailable"
        ? `could not read · ${run.reason ?? "the run failed"}`
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
    /** The last write outside a run — a block's direction set or refused (R-9): the refusal is said on the panel. */
    lastRecord,
    uploadTake,
    uploadDialog,
  };
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

export function AudiobookBlocks({ rows, sounding, selected, onSelect, onPlayOne, slug, filter = null, choices, onPin }: {
  rows: BlockRow[];
  sounding: BlockRow | null;
  selected: string | null;
  onSelect: (key: string) => void;
  onPlayOne: (row: BlockRow) => void;
  slug: string | undefined;
  filter?: AudiobookFilter;
  /** Offered only while the cast is current and can be written (SPEC-012 R-62): who a block can be given to. */
  choices?: SpeakerChoices;
  /** A choice made for a block, or for words selected inside a narration block. */
  onPin?: (row: BlockRow, pick: SpeakerPick, selection?: { from: number; to: number }) => void;
}) {
  const [menu, setMenu] = useState<{ key: string; selection?: { from: number; to: number } } | null>(null);
  useEffect(() => {
    if (menu === null) return;
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);
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
            onClick={() => onSelect(row.block.key)}
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
                if (!pinnable || row.speakerKey !== null || row.block.paragraph < 0) return;
                const span = rawSelection(event.currentTarget);
                if (span === null) return;
                const words = row.block.text.slice(span.from, span.to);
                if (words.trim() === "" || words.length > 600) return;
                event.stopPropagation();
                setMenu({ key: row.block.key, selection: span });
              }}
            >
              {row.block.text}
            </span>
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
              {row.block.pinned === true && (
                <span className="fy-ab__pin" title="set by you" aria-label="set by you">
                  <Pin size={11} />
                </span>
              )}
              {row.artifact !== null &&
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
              />
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

/** A cue in the panel's words: `pause · long · after “works,”`. */
function cueLabel(text: string, cue: CadencePlan["cues"][number]): string {
  const around = (at: number) => `after “${text.slice(Math.max(0, at - 12), at).replace(/^\S*\s/, "")}”`;
  if (cue.kind === "pause") return `pause · ${cue.length} · ${around(cue.at)}`;
  if (cue.kind === "breath") return `${cue.action} · before “${text.slice(cue.at, cue.at + 12).replace(/\s\S*$/, "")}”`;
  return `emphasis · ${cue.level} · “${cue.span.text}”`;
}

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

/** The side in the Audiobook view: the block pressed, its direction, then its takes. */
export function AudiobookSide({ rows, selected, record, artifacts, slug, productionId, chapterId, chapterTitle, modelOf, onSetDirection, onMakeAgain, onUpload, refused, blockHost }: {
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
  /** The last write's refusal (R-9), said on the panel until the next write answers. */
  refused: string | null;
  /** The element the block's words are shown in, for a cue placed at the selection. */
  blockHost: (key: string) => HTMLElement | null;
}) {
  const row = rows.find((candidate) => candidate.block.key === selected) ?? null;
  const [phraseDraft, setPhraseDraft] = useState<string | null>(null);
  // Edits compose while the record's answer is on its way (codex on PR 1186): a delivery then
  // a speed pressed before the first write answers would otherwise both be built from the same
  // record, the second undoing the first. The pending plan is this panel's until the record
  // answers — with its own word, or with a refusal — or another block is chosen.
  const [pending, setPending] = useState<{ key: string; plan: AudiobookDirectionInput | null } | null>(null);
  useEffect(() => {
    setPhraseDraft(null);
    setPending(null);
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
  const readerLabel = `${row.speaker.label ?? row.speaker.voiceId} · ${row.speaker.provider}${row.speaker !== row.assigned ? " · stands in" : ""}`;
  // The direction that stands for these words, and what the reader that will speak does with
  // each control (R-9): read off that reader's row and the line's language, so a delivery the
  // row lacks is struck with the reason before it is pressed, and the plan's own report says
  // how each control went.
  const model = modelOf(row.speaker);
  const support = model === null ? null : cadenceSupport(model, row.language);
  const direction = audiobookDirectionFor(record, row.block);
  const held = pending !== null && pending.key === row.block.key ? pending.plan : direction === null ? null : { delivery: direction.plan.delivery, speed: direction.plan.speed, cues: direction.plan.cues, ...(direction.plan.phrase !== undefined ? { phrase: direction.plan.phrase } : {}) };
  const plan = direction?.plan ?? null;
  const text = normalizeSpeechText(row.block.text);
  const report = (() => {
    if (plan === null || model === null || pending !== null) return null;
    try {
      return reportLine(plan, mapCadence(row.block.text, plan.sourceTextHash, plan, model, row.language).controls);
    } catch {
      return null;
    }
  })();
  const base: AudiobookDirectionInput = held ?? { delivery: "measured", speed: 1, cues: [] };
  const send = (next: AudiobookDirectionInput | null) => {
    setPending({ key: row.block.key, plan: next });
    onSetDirection(row.block.key, next);
  };
  const write = (next: Partial<AudiobookDirectionInput>) => send({ ...base, ...next });
  const addCue = (kind: "pause" | "breath" | "emphasis") => {
    const span = selectedSpan(blockHost(row.block.key), row.block.text);
    if (span === null || (kind === "emphasis" && span.to <= span.from)) return;
    const cue: CadencePlan["cues"][number] =
      kind === "pause"
        ? { kind, at: span.to, length: "short" }
        : kind === "breath"
          ? { kind, at: span.from, action: "inhale" }
          : { kind, span: { from: span.from, to: span.to, text: text.slice(span.from, span.to) }, level: "moderate" };
    const cues = [...base.cues, cue].sort((a, b) => (a.kind === "emphasis" ? a.span.from : a.at) - (b.kind === "emphasis" ? b.span.from : b.at));
    write({ cues });
  };
  const phraseSupported = support !== null && support.phrase.status !== "unsupported";
  const commitPhrase = () => {
    if (phraseDraft === null) return;
    const trimmed = phraseDraft.trim();
    setPhraseDraft(null);
    if (trimmed === (base.phrase ?? "")) return;
    if (trimmed === "") {
      const { phrase: _gone, ...rest } = base;
      send(rest);
    } else write({ phrase: trimmed.slice(0, 60) });
  };
  const seg = (name: string, items: readonly { key: string; label: string; active: boolean; off: boolean; title: string; press: () => void }[]) => (
    <span className="fy-seg fy-ab__seg" role="group" aria-label={name}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`fy-seg__item${item.active ? " fy-seg__item--active" : ""}${item.off ? " fy-ab__seg-item--off" : ""}`}
          disabled={item.off}
          aria-pressed={item.active}
          title={item.title}
          onClick={item.press}
        >
          {item.label}
        </button>
      ))}
    </span>
  );
  return (
    <>
      <section className="fy-bible__panel" data-testid="audiobook-block">
        <h2 className="fy-bible__paneltitle fy-ch__paneltitle--row">
          {row.block.key === AUDIOBOOK_TITLE_KEY ? "Title" : `Block ${rows.indexOf(row) + 1}`} · {row.mark}
          <span className="fy-ch__panelpush" />
          <span className="fy-ch__who-where fy-mono">{readerLabel}</span>
        </h2>
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
      <section className="fy-bible__panel fy-ab__direction" data-testid="audiobook-direction">
        <div className="fy-ab__row">
          <span className="fy-ab__label">Delivery</span>
          {seg(
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
          <span className="fy-ab__label">Phrase</span>
          {phraseSupported ? (
            <input
              className="fy-ab__phrase fy-mono"
              value={phraseDraft ?? held?.phrase ?? ""}
              maxLength={60}
              aria-label="Phrase"
              onChange={(event) => setPhraseDraft(event.target.value)}
              onBlur={commitPhrase}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLInputElement).blur();
              }}
            />
          ) : (
            <span className="fy-ab__off fy-mono">{support === null ? "no reader" : supportWord(support.phrase)}</span>
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
        <div className="fy-ab__row">
          <span className="fy-ab__label">Cues</span>
          <span className="fy-ab__cues">
            {base.cues.map((cue, index) => (
              <span key={index} className="fy-ab__cue fy-mono">
                {cueLabel(text, cue)}
                <button type="button" className="fy-ab__cue-x" aria-label="Remove cue" onClick={() => write({ cues: base.cues.filter((_, at) => at !== index) })}>
                  ×
                </button>
              </span>
            ))}
            <span className="fy-ab__cue-add">
              {(["pause", "breath", "emphasis"] as const).map((kind) => {
                const word = support?.[kind];
                const off = word === undefined || word.status === "unsupported";
                return (
                  <button key={kind} type="button" className="fy-ch__derive" disabled={off} title={word === undefined ? "no reader" : off ? supportWord(word) : `${kind} at the words selected`} onClick={() => addCue(kind)}>
                    + {kind}
                  </button>
                );
              })}
            </span>
          </span>
        </div>
        {(report !== null || refused !== null) && (
          <p className={`fy-ch__stamp fy-mono${refused !== null ? " fy-ch__who-where--warn" : ""}`} data-testid="audiobook-report">
            {refused ?? report}
          </p>
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
                            {generation !== null ? `${generation.voiceLabel ?? generation.voiceId} · ${generation.provider}` : ""}
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
              {model !== null && row.speaker.provider !== "kokoro" ? ` · ${formatMicroUsd(estimateMicroUsd(model, { characters: billableCharacters(model, row.block.text) }))}` : ""}
            </Button>
          )}
          {onUpload !== undefined && (
            <Button variant="ghost" onClick={() => onUpload(row.block.key)} data-testid="audiobook-upload" title="a recording of these words, from a file">
              <Mic size={11} /> Upload
            </Button>
          )}
        </div>
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
