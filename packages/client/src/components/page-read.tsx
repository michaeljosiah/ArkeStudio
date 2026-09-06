import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_NARRATOR, formatMicroUsd, supportsVoiceUse, type ProseReadSource } from "@arke-studio/contracts";
import {
  clearQueue,
  dismissPlayback,
  enqueueClip,
  jumpQueue,
  playbackSnapshot,
  useQueueAt,
} from "../lib/audio.js";
import { readProsePage, subscribeVoiceUploadConfirmations, useStore, useVoiceAudio, useVoiceParts, stopProsePage } from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";
import { RemoteVoiceUploadConfirmation } from "./remote-voice-upload-confirmation.js";
import { Button } from "./ui.js";

/**
 * Reading a page, as opposed to reading a block (issue 859).
 *
 * One press reads this piece; one press reads this page in order. The second is not the first
 * repeated — it needs an order, a position, a way to step through it, and a price stated before
 * it starts. What it does not need is a way to work out the order for itself: the screen names
 * the blocks it reads and hands them over. Taking them from the page instead would make the
 * narration follow the layout and voice whatever decorative thing sat between two paragraphs.
 */
export interface PageReadBlock {
  heading: string;
  body: string;
}

export interface PageRead {
  /** A page read is running: preparing, sounding, priced or failed. */
  reading: boolean;
  /** Which block is sounding, or null before the first one lands. */
  at: number | null;
  count: number;
  failure: string | null;
  /** Present only while a charged read is waiting to be answered; `voices` names each cloud voice the words would go to. */
  cost: { characters: number; priced: string; voices: string[]; confirm: () => void } | null;
  /** Present while a cloned voice's recording waits for leave to go to a remote engine (turn 130). */
  upload: { destination: string; confirm: () => void } | null;
  begin: () => void;
  stop: () => void;
  skip: (direction: 1 | -1) => void;
}

export function usePageRead(input: {
  /**
   * Which page this is. A route element stays mounted when only its id changes, so moving from
   * one sheet to the next is leaving the page even though nothing unmounted.
   */
  pageId: string | undefined;
  /** What the dock calls the read; the block's own heading is added to it. */
  title: string;
  narratorLabel: string;
  worldSlug: string | undefined;
  /** The blocks this screen reads, in the order it reads them. Empty ones never get here. */
  blocks: readonly PageReadBlock[];
  /** Ask for the page. Called again with the token when a charged read is confirmed, and with the engine a cloned voice's recording may go to once that is allowed. */
  start: (requestId?: string, confirmationToken?: string, voiceUploadConfirmedFor?: string) => string;
  /** Tell the coordinator to stop making the page (codex, PR 879); absent, stopping is local. */
  cancel?: (requestId: string) => void;
  /** What the player calls a block's voice (turn 130); absent, the narrator's label. */
  voiceOf?: (index: number) => string;
}): PageRead {
  const { pageId, title, narratorLabel, worldSlug, blocks, start } = input;
  // Read through a ref so a caller's inline arrow does not change `stop`'s identity every render
  // — the effect below stops the read when `stop` changes, which would stop it constantly.
  const cancel = useRef(input.cancel);
  cancel.current = input.cancel;
  const [run, setRun] = useState<string | null>(null);
  /*
   * The read whose price has been answered. The newest event for a request stays
   * `confirmation-required` until the first block lands, so without this the page would go on
   * offering a Confirm button after it had already been pressed — and a second press on a
   * charged read is a second charge.
   */
  const [confirmed, setConfirmed] = useState<string | null>(null);
  /*
   * A cloned voice on the page needs its recording sent to a remote engine (codex on PR 914):
   * the coordinator asks once, by request, before anything is priced or queued; the answer is
   * kept for the run, because the price asked next is answered by the same frame.
   */
  const [upload, setUpload] = useState<{ destination: string; token: string } | null>(null);
  const uploadAllowed = useRef<string | null>(null);
  const voiceAudio = useVoiceAudio();
  const parts = useVoiceParts()[run ?? ""];
  const result = run ? voiceAudio[run] : undefined;
  const at = useQueueAt();
  const queued = useRef(0);
  const live = useRef<string | null>(null);
  live.current = run;

  /*
   * A page read stops when its page is left; a block read does not (issue 859).
   *
   * The queue is module-level and keyed by request, so nothing about leaving a screen would
   * otherwise reach it. The rule is by scale rather than by screen: a page read is *about* the
   * page, and a block read is a thing somebody asked for and can follow them.
   */
  const stop = useCallback(() => {
    const id = live.current;
    live.current = null;
    queued.current = 0;
    setRun(null);
    setConfirmed(null);
    setUpload(null);
    uploadAllowed.current = null;
    if (id === null) return;
    cancel.current?.(id);
    if (playbackSnapshot().clip?.id === id) dismissPlayback();
    clearQueue();
  }, []);
  useEffect(() => stop, [stop, pageId]);
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== live.current) return;
        setUpload({ destination: confirmation.destinationLabel, token: confirmation.confirmationToken });
      }),
    [],
  );

  const begin = useCallback(() => {
    clearQueue();
    dismissPlayback();
    queued.current = 0;
    uploadAllowed.current = null;
    const requestId = start();
    live.current = requestId;
    setRun(requestId);
    setConfirmed(null);
    setUpload(null);
  }, [start]);

  // Blocks land in whatever order they finish, so this counts what exists rather than how far
  // the array reaches: a cloud page whose second block returns first would otherwise never
  // notice the first one arriving.
  const landed = (parts ?? []).filter((file) => file !== undefined).length;
  useEffect(() => {
    if (run === null || !worldSlug) return;
    // Nothing sounds while a price is on the table: the page states its cost before it starts.
    if (result?.status === "confirmation-required") return;
    const files = parts ?? (result?.status === "ready" && result.file ? [result.file] : []);
    for (let i = queued.current; i < files.length; i += 1) {
      const file = files[i];
      if (file === undefined) return; // a gap means that block is still being made; wait for it
      const block = blocks[i];
      void enqueueClip({
        id: run,
        url: mediaUrl(worldSlug, file),
        title: block ? `${title} · ${block.heading}` : title,
        sub: `read aloud · ${input.voiceOf?.(i) ?? narratorLabel} · ${i + 1} of ${blocks.length}`,
        part: i,
      });
      queued.current = i + 1;
    }
  }, [run, landed, result?.status, result?.file, worldSlug, title, narratorLabel, blocks.length, input.voiceOf]);

  const token = result?.status === "confirmation-required" ? result.confirmationToken : undefined;
  return {
    reading: run !== null,
    at,
    count: blocks.length,
    failure: result?.status === "failed" ? (result.error ?? "Read aloud is unavailable.") : null,
    cost:
      run !== null && token !== undefined && confirmed !== run
        ? {
            characters: result?.characterCount ?? 0,
            priced: formatMicroUsd(result?.estimatedMicroUsd ?? 0),
            voices: (result?.voices ?? []).map((voice) => `${voice.label} · ${voice.provider}`),
            confirm: () => {
              setConfirmed(run);
              start(run, token, uploadAllowed.current ?? undefined);
            },
          }
        : null,
    upload:
      run !== null && upload !== null
        ? {
            destination: upload.destination,
            confirm: () => {
              uploadAllowed.current = upload.token;
              setUpload(null);
              start(run, undefined, upload.token);
            },
          }
        : null,
    begin,
    stop,
    skip: (direction) => {
      if (at !== null) jumpQueue(at + direction);
    },
  };
}

/**
 * The page read for a screen whose blocks are prose addresses rather than sheet sections.
 *
 * An overview's cards and a season's answers already carry a speaker each (issue 857); this is
 * the same list read through. The screen declares the blocks and their order and nothing else —
 * the narrator's name, the world it belongs to and the queueing are the same everywhere.
 */
export function useProsePageRead(input: {
  pageId: string | undefined;
  /** What the dock calls the read; the block's own heading is added to it. */
  title: string;
  blocks: readonly (PageReadBlock & { source: ProseReadSource })[];
  /**
   * What the frame carries instead of one address per block (turn 130): a voiced chapter is
   * named once and the coordinator expands it by the rule the blocks were declared with, so a
   * cast of four hundred lines never overflows the frame. The blocks still label and count.
   */
  sources?: readonly ProseReadSource[];
  /** What the player calls a block's voice: the speaker's name, or the narrator's. */
  voiceOf?: (index: number) => string;
}): PageRead {
  const { state } = useStore();
  const world = state?.world ?? null;
  // Never a cloned voice: the app's reading voice is not somebody's cloned identity, and a
  // narrator that fails that rule falls back to the shipped local one rather than being named.
  const narrator = state?.app.narrator ?? null;
  const narratorLabel =
    narrator && !supportsVoiceUse(narrator, "narration")
      ? DEFAULT_NARRATOR.label
      : (narrator?.label ?? narrator?.voiceId ?? DEFAULT_NARRATOR.label);
  return usePageRead({
    pageId: input.pageId,
    title: input.title,
    narratorLabel,
    worldSlug: world?.meta.slug,
    blocks: input.blocks,
    ...(input.voiceOf !== undefined ? { voiceOf: input.voiceOf } : {}),
    start: (requestId, confirmationToken, voiceUploadConfirmedFor) =>
      readProsePage(
        world?.meta.worldId ?? "",
        input.sources ?? input.blocks.map((block) => block.source),
        requestId,
        confirmationToken,
        voiceUploadConfirmedFor,
      ),
    cancel: (requestId) => stopProsePage(world?.meta.worldId ?? "", requestId),
  });
}

const ROW = { display: "inline-flex", alignItems: "center", gap: "var(--space-2)" } as const;

/** The page-scale control: one press to start, then position and movement while it reads. */
export function PageReadControl({ read, label }: { read: PageRead; label: string }) {
  if (!read.reading) return <Button onClick={read.begin}>{label}</Button>;
  if (read.upload) {
    return <RemoteVoiceUploadConfirmation destinationLabel={read.upload.destination} onCancel={read.stop} onConfirm={read.upload.confirm} />;
  }
  if (read.cost) {
    return (
      <span style={ROW}>
        <Button onClick={read.cost.confirm}>
          Confirm {read.cost.characters} characters · {read.cost.priced}
          {read.cost.voices.map((voice) => ` · ${voice}`).join("")}
        </Button>
        {/* What leaves the machine is said before it does (codex on turn 130): the words and the
            voice go to the provider, and the text stays in Activity, as a table read's does. */}
        <span className="fy-mono">the words and the voice go to the provider · the text stays in Activity</span>
        <Button variant="ghost" onClick={read.stop}>
          Cancel
        </Button>
      </span>
    );
  }
  if (read.failure) {
    return (
      <span style={ROW}>
        <span className="fy-mono">{read.failure}</span>
        <Button variant="ghost" onClick={read.stop}>
          Close
        </Button>
      </span>
    );
  }
  return (
    <span style={ROW}>
      <Button variant="ghost" disabled={read.at === null || read.at === 0} onClick={() => read.skip(-1)}>
        Back
      </Button>
      <span className="fy-mono">{read.at === null ? "Preparing…" : `${read.at + 1} of ${read.count}`}</span>
      <Button
        variant="ghost"
        disabled={read.at === null || read.at + 1 >= read.count}
        onClick={() => read.skip(1)}
      >
        Next
      </Button>
      <Button variant="ghost" onClick={read.stop}>
        Stop
      </Button>
    </span>
  );
}
