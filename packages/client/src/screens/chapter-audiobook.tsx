import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AUDIOBOOK_TITLE_KEY,
  DEFAULT_NARRATOR,
  audiobookBlockState,
  audiobookBlocks,
  audiobookCounts,
  audiobookHeading,
  estimateMicroUsd,
  formatMicroUsd,
  legacyVoiceModel,
  narratorFor,
  supportsVoiceUse,
  type ArtifactSidecar,
  type AudiobookBlock,
  type AudiobookBlockState,
  type AudiobookReader,
  type AudiobookReading,
  type ChapterAudiobook,
  type ChapterSummary,
  type ChapterVoices,
  type ClonedVoice,
  type ManifestModel,
} from "@arke-studio/contracts";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";
import { Button } from "../components/ui.js";
import { clearQueue, dismissPlayback, enqueueClip, jumpQueue, playClip, playbackSnapshot, usePlayback, useQueueAt } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import {
  dismissAudiobookRun,
  readAudiobookChapter,
  stopAudiobook,
  subscribeVoiceUploadConfirmations,
  useAudiobookRuns,
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
  reading: AudiobookReading;
  connection: string;
  locked: boolean;
  /**
   * The press waits out the autosave (R-2): true when the read may go now; false when the
   * workspace has taken it, flushed the draft, and will send it once the save lands.
   */
  beforeRead?: () => boolean;
}

export interface BlockRow {
  block: AudiobookBlock;
  state: AudiobookBlockState;
  /** What the margin says: `title`, `narrator`, or the speaker's name. */
  mark: string;
  markWarn: boolean;
  assigned: AudiobookReader;
  artifact: ArtifactSidecar | null;
}

const STATE_LABEL: Record<AudiobookBlockState, string> = { "not made": "not made", made: "made", stale: "stale", flagged: "flagged" };

function readerOf(voice: { provider: string; model?: string; voiceId: string; label?: string }, clonedVoices: readonly ClonedVoice[] | undefined): AudiobookReader | null {
  const model = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId, clonedVoices ?? []);
  if (model === null) return null;
  return { provider: voice.provider, model, voiceId: voice.voiceId, ...(voice.label !== undefined ? { label: voice.label } : {}) };
}

/** The blocks, their states and the counts, from the one rule both ends use. */
export function useChapterAudiobook(input: ChapterAudiobookInput) {
  const { worldId, prodId, chapter, body, cast, record, reading, connection, locked } = input;
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
  const rows = useMemo<BlockRow[]>(() => {
    return derived.blocks.map((block) => {
      let assigned = narrator;
      let mark = block.key === AUDIOBOOK_TITLE_KEY ? "title" : "narrator";
      let markWarn = false;
      if (reading === "cast" && block.speaker !== undefined) {
        const sheet = block.sheet === undefined ? undefined : world?.sheets.find((candidate) => candidate.id === block.sheet);
        mark = sheet?.name ?? block.speaker;
        const reader = sheet?.voice === undefined ? null : readerOf(sheet.voice, world?.clonedVoices);
        if (reader === null) markWarn = true;
        else assigned = reader;
      } else if (block.speaker !== undefined) {
        const sheet = block.sheet === undefined ? undefined : world?.sheets.find((candidate) => candidate.id === block.sheet);
        mark = sheet?.name ?? block.speaker;
      }
      const take = recordOrNull?.takes[block.key];
      const artifact = take === undefined ? null : (world?.artifacts.find((candidate) => candidate.id === take.artifactId) ?? null);
      return { block, state: audiobookBlockState(block, recordOrNull, assigned), mark, markWarn, assigned, artifact };
    });
  }, [derived.blocks, narrator, reading, world, recordOrNull]);
  const counts = useMemo(() => audiobookCounts(derived.blocks, recordOrNull, (block) => rows.find((row) => row.block.key === block.key)?.assigned ?? narrator), [derived.blocks, recordOrNull, rows, narrator]);
  // What a press would spend, before the run asks: the cloud blocks not made, by the character.
  // The cache is not consulted here, so the run's own price can only be lower.
  const estimate = useMemo(
    () =>
      rows.reduce((sum, row) => {
        if (row.state === "made" || row.assigned.provider === "kokoro") return sum;
        const model = modelOf(row.assigned);
        return model === null ? sum : sum + estimateMicroUsd(model, { characters: row.block.text.length });
      }, 0),
    [rows, modelOf],
  );

  // The player: the made takes in order, through the one queue the page read uses (R-20).
  const playable = useMemo(() => rows.filter((row) => row.state === "made" && row.artifact !== null), [rows]);
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
  // The engine a cloned voice's recording was allowed to go to, kept for the rest of this
  // window's presses (codex on PR 1180): a cast with a cloned voice and a paid one is asked for
  // consent first and the price second, and the price's answer must carry the consent too, or
  // the restarted run asks for consent again and the two prompts chase each other for ever.
  const uploadAllowed = useRef<string | null>(null);
  const send = useCallback(
    (options: { confirmationToken?: string; voiceUploadConfirmedFor?: string } = {}) => {
      const consent = options.voiceUploadConfirmedFor ?? uploadAllowed.current ?? undefined;
      readAudiobookChapter(worldId, prodId, chapter.file, {
        ...(options.confirmationToken !== undefined ? { confirmationToken: options.confirmationToken } : {}),
        ...(consent !== undefined ? { voiceUploadConfirmedFor: consent } : {}),
      });
    },
    [worldId, prodId, chapter.file],
  );
  const begin = useCallback(() => {
    if (locked || connection !== "open" || reading_) return;
    // Unsaved typing is not what is read (R-2): the press waits out the autosave, as the
    // chapter's other reads do, and the workspace sends it once the save lands.
    if (input.beforeRead !== undefined && !input.beforeRead()) return;
    setUpload(null);
    send();
  }, [locked, connection, reading_, input, send]);

  const head = (() => {
    if (upload !== null && run?.state !== "read") {
      return (
        <RemoteVoiceUploadConfirmation
          destinationLabel={upload.destination}
          onCancel={() => {
            setUpload(null);
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

  return { rows, counts, estimate, head, note, selected, setSelected, sounding, playable, run, narrator };
}

/** The manuscript column in the Audiobook view: a row a block, the reader in the margin, the state as a dot. */
export function AudiobookBlocks({ rows, sounding, selected, onSelect, onPlayOne, slug }: {
  rows: BlockRow[];
  sounding: BlockRow | null;
  selected: string | null;
  onSelect: (key: string) => void;
  onPlayOne: (row: BlockRow) => void;
  slug: string | undefined;
}) {
  if (rows.length === 0) return <p className="fy-bible__empty">Nothing to read yet.</p>;
  return (
    <div className="fy-ab__blocks" data-testid="audiobook-blocks">
      {rows.map((row) => (
        <div
          key={row.block.key}
          className={`fy-ab__block${sounding?.block.key === row.block.key ? " fy-ab__block--sounding" : ""}${selected === row.block.key ? " fy-ab__block--selected" : ""}`}
          data-state={row.state}
          onClick={() => onSelect(row.block.key)}
        >
          <span className={`fy-ab__mark fy-mono${row.markWarn ? " fy-ab__mark--warn" : ""}${row.mark === "narrator" || row.mark === "title" ? " fy-ab__mark--faint" : ""}`}>{row.mark}</span>
          <span className="fy-ab__text">{row.block.text}</span>
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
        </div>
      ))}
    </div>
  );
}

/** The side in the Audiobook view: the block pressed, then its takes. */
export function AudiobookSide({ rows, selected, record, artifacts, slug, productionId, chapterId, chapterTitle }: {
  rows: BlockRow[];
  selected: string | null;
  record: ChapterAudiobook | null;
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  productionId: string;
  chapterId: string;
  chapterTitle: string;
}) {
  const row = rows.find((candidate) => candidate.block.key === selected) ?? null;
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
  const readerLabel = `${row.assigned.label ?? row.assigned.voiceId} · ${row.assigned.provider}`;
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
                      {generation !== null ? `${generation.voiceLabel ?? generation.voiceId} · ${generation.provider}` : ""}
                      {generation !== null ? ` · ${generation.costMicroUsd === null ? formatMicroUsd(generation.estimatedMicroUsd) : formatMicroUsd(generation.costMicroUsd)}` : ""}
                    </span>
                    <span className="fy-ch__who-count fy-mono">{chosen ? "✓" : ""}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
