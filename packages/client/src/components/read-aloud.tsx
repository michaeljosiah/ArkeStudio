import { useCallback, useEffect, useId, useRef, useState } from "react";
import { freePlanStop, narratorLabelFor, speechPlanLabel, type ProseReadSource } from "@arke-studio/contracts";
import { readProse, stopProsePage, useStore, useVoiceAudio, useVoiceParts } from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";
import { clearQueue, dismissPlayback, enqueueClip, playbackSnapshot, playClip, usePlayback, type Clip } from "../lib/audio.js";
import { claimRead, releaseRead } from "../lib/reply-reads.js";
import { useMediaQuery } from "../lib/media-query.js";
import { clock, TextActions } from "./player.js";
import { Copy, Speaker } from "./icons.js";
import { cx } from "./ui.js";
import { ReadAloudConfirmation } from "./read-aloud-confirmation.js";
import { FreePlanStop } from "./free-plan-stop.js";
import { RemoteVoiceUploadConfirmation, useVoiceUploadAsk } from "./remote-voice-upload-confirmation.js";

/**
 * Read-aloud, for every screen that shows prose (issue 857).
 *
 * The control existed on two screens and the reasoning for it was general: a third voice role
 * that narrates the app's own text, free on this machine by default. What it reached was the
 * bible and a character's two lead paragraphs — not a canon entry, a shot's script, a season's
 * answer or Arke's replies, which is most of what somebody sits and reads during a session.
 *
 * So the twenty lines each of those two screens had written out are here instead, once. A screen
 * says what to read and what to call it; everything after that — the narrator's name, the
 * streamed pieces of a long read, the cost of a cloud voice, the failure — is the same
 * everywhere, and was the reason nobody added the third copy.
 *
 * `reply` marks a chat reply's read (design turn 183): it stops when the chat is left, and the
 * composer can stop it — sending, or speaking to it — where a passage somebody asked for on
 * the bible follows them round the app.
 */
function useProseRead(source: ProseReadSource, title: string, reply = false) {
  const { state } = useStore();
  const world = state?.world ?? null;
  const voiceAudio = useVoiceAudio();
  const partsByRequest = useVoiceParts();
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [request, setRequest] = useState<string | null>(null);
  const result = request === null ? undefined : voiceAudio[request];
  const slug = world?.meta.slug;
  const worldId = world?.meta.worldId;
  // A cloned narrator's recording is asked about before the price (issue 1215); the answer rides
  // on every later frame of this read.
  const live = useRef<string | null>(null);
  live.current = request;
  const upload = useVoiceUploadAsk(() => live.current);
  // The app's narrator as this world will hear it (SPEC-046 R-37): a cloned voice through a
  // hosted reader may be one, and a clone is its own world's; a choice that cannot narrate here
  // is named as the shipped local voice it falls to, never as itself — and once the read lands,
  // the voice that read it is what is named.
  const narratorLabel = narratorLabelFor(state?.app.narrator ?? null, worldId, result?.status === "ready" ? result : undefined);
  // Where a price would show, the reader names its plan (design turn 182): `· free plan`.
  const model = state?.app.manifest?.models.find((candidate) => candidate.provider === (result?.provider ?? state.app.narrator?.provider) && candidate.id === (result?.model ?? state.app.narrator?.model));
  const plan = speechPlanLabel(model);
  const sub = `read aloud · ${narratorLabel}${plan !== null ? ` · ${plan}` : ""}`;
  // A reply's player names where the voice runs when it costs nothing there (design 183c):
  // `George · this machine`, beside a cloud plan's `Ife's voice · free plan`.
  const local = (result?.provider ?? state?.app.narrator?.provider ?? "kokoro") === "kokoro" || model?.pricing.kind === "unmetered";
  const reader = `${narratorLabel}${plan !== null ? ` · ${plan}` : local ? " · this machine" : ""}`;

  /*
   * A long read arrives in pieces, because local synthesis runs at about the speed of speech and
   * holding the first word until the last one exists is a silence as long as the reading. Each
   * piece is queued as it lands and the first starts immediately; a short read still arrives
   * whole and takes the single-clip path below, unchanged. Cloud pieces (issue 1208) land in
   * whatever order the reader finishes them, so the effect follows how many exist rather than
   * how far the array reaches: a later piece landing first fills the array to its final length,
   * and the earlier one filling the gap behind it would otherwise change nothing the effect
   * watches (codex on PR 1210).
   */
  const parts = partsByRequest[request ?? ""] ?? [];
  const landed = parts.filter((file) => file !== undefined).length;
  const queued = useRef(0);
  useEffect(() => {
    if (request === null || slug === undefined) return;
    for (let i = queued.current; i < parts.length; i += 1) {
      const file = parts[i];
      if (file === undefined) return; // a gap means the piece is still being made; wait for it
      void enqueueClip({ id: request, url: mediaUrl(slug, file), title, sub, part: i });
      queued.current = i + 1;
    }
  }, [request, landed, slug, title, sub]);

  // What was asked for plays the moment it lands, rather than making somebody press twice.
  useEffect(() => {
    if (parts.length > 0) return; // a streamed read is already sounding
    if (request !== null && result?.status === "ready" && result.file && slug !== undefined) {
      void playClip({ id: result.requestId, url: mediaUrl(slug, result.file), title, sub });
    }
  }, [request, result?.requestId, result?.status, result?.file, parts.length, slug, title, sub]);

  const clip: Clip | null =
    result?.status === "ready" && result.file && slug !== undefined
      ? { id: result.requestId, url: mediaUrl(slug, result.file), title, sub }
      : null;

  /*
   * Stopping is more than silencing the clip (design turn 183): the request is dropped so no
   * later piece is queued, and the coordinator is told so it stops making pieces — and cancels
   * the queued jobs of a cloud read — that nobody will hear. Held in a ref so the claim made by
   * the next read, and the unmount below, always reach the current request.
   */
  const key = useId();
  const stopRef = useRef<() => void>(() => {});
  stopRef.current = () => {
    const id = live.current;
    live.current = null;
    queued.current = 0;
    upload.drop();
    setRequest(null);
    releaseRead(key);
    if (id === null) return;
    if (worldId !== undefined && !(result?.status === "ready" && (result.parts === undefined || landed >= result.parts))) stopProsePage(worldId, id);
    if (playbackSnapshot().clip?.id === id) {
      dismissPlayback();
      clearQueue();
    }
  };
  const stop = useCallback(() => stopRef.current(), []);
  // A reply's read is about the chat it is in: leaving the chat stops it (design turn 183). A
  // passage's read is something somebody asked for and can follow them, as it always has.
  useEffect(() => () => { if (reply && live.current !== null) stopRef.current(); }, [reply]);

  /** Fresh when nothing is passed; the same request again when a charge, or the vendor, has been confirmed. */
  // `shipped` reads in the shipped narrator for this read only: what a free plan's limit offers
  // (design turn 182). It rides every later frame of the same read.
  const shipped = useRef(false);
  const ask = (again?: { requestId: string; confirmationToken?: string }, inShipped?: boolean) => {
    if (worldId === undefined) return;
    // One read at a time across the app: whoever was reading stops outright, not just its clip.
    claimRead(key, stop, reply);
    queued.current = 0;
    // A second read replaces the first outright: two voices over one another is never what
    // anybody meant.
    clearQueue();
    if (again === undefined) {
      upload.drop();
      shipped.current = inShipped === true;
    }
    const requestId = readProse(worldId, source, again?.requestId, again?.confirmationToken, upload.allowed(), shipped.current || undefined);
    live.current = requestId;
    setRequest(requestId);
  };

  /*
   * A cloud narrator is billed per character, so the number is stated before it is spent — the
   * same shape the sheet's read uses. The local default never reaches this branch.
   */
  const quote = `${request}:${result?.confirmationToken ?? ""}`;
  const preparing = request !== null && (result === undefined || (result.status === "confirmation-required" && submitted === quote));
  const note = preparing ? <span className="fy-textactions__note">Preparing audio…</span> : undefined;
  const asking = upload.asked !== null && request !== null ? "upload" : result?.status === "confirmation-required" && submitted !== quote ? "price" : null;
  const confirmation = asking === "upload" ? (
    <RemoteVoiceUploadConfirmation
      destinationLabel={upload.asked!.destination}
      destinationNotice={upload.asked!.notice}
      onCancel={stop}
      onConfirm={() => { if (upload.answer() !== null && request !== null) ask({ requestId: request }); }}
    />
  ) : asking === "price" && result !== undefined ? (
    <ReadAloudConfirmation title={title} result={result} onCancel={stop} onConfirm={confirmationToken => {
      if (request === null) return;
      setSubmitted(quote);
      ask({ requestId: request, confirmationToken });
    }} />
  ) : null;

  return {
    clip,
    request,
    reader,
    /** Every piece the read will have has landed: when the player rests, the read is over. */
    settled: result?.status === "ready" && (result.parts === undefined || landed >= result.parts),
    onRead: () => ask(),
    onReadShipped: () => ask(undefined, true),
    /** Play a read already made, from this session, without asking the coordinator again. */
    replay: (made: Clip) => {
      claimRead(key, stop, reply);
      void playClip(made);
    },
    stop,
    note,
    confirmation,
    asking: asking !== null,
    preparing,
    error: result?.status === "failed" ? (result.error ?? "Read aloud is unavailable.") : null,
  };
}

/**
 * The hover affordance under a block of prose (design 3a). Wrap the prose and this in
 * `.fy-texthost`, exactly as a sheet section does.
 */
export function ReadAloud({
  source,
  title,
  text,
}: {
  source: ProseReadSource;
  /** What the dock calls it while it plays. */
  title: string;
  /** The words on screen — copied by the second button, and what makes an empty block silent. */
  text: string;
}) {
  const { clip, onRead, onReadShipped, note, error, confirmation, replay } = useProseRead(source, title);
  if (text.trim() === "") return null;
  return (
    <>
      {confirmation}
      <TextActions clip={clip} onRead={onRead} onReplay={replay} copyText={text} readLabel="Read aloud" note={note} />
      {error !== null && (freePlanStop(error) !== null
        ? <FreePlanStop error={error} onDefaultNarrator={onReadShipped} />
        : <span className="fy-textactions__note">{error}</span>)}
    </>
  );
}

/**
 * Listen on one of Arke's replies (design turn 183), in every chat that draws a transcript.
 *
 * Not the hover speaker a passage carries: a reply is read the way it is answered, so the row is
 * there under every reply at the weight of Copy, and on a phone — where nothing hovers — it is
 * the reply's own action row. While it reads, the player sits under the reply it is reading
 * rather than only in the dock: in a thread of twenty replies the dock says something is
 * sounding, and only this says which. The address is the conversation and the message; the
 * words on screen are copied, never spoken.
 *
 * `auto` is Read replies (turn 183): the reply that has just finished reads itself, once.
 */
export function ReplyRead({
  conversationId,
  messageId,
  text,
  auto = false,
}: {
  conversationId: string;
  messageId: string;
  text: string;
  auto?: boolean;
}) {
  const phone = useMediaQuery("(max-width: 599px)");
  const read = useProseRead({ of: "reply", conversationId: conversationId as never, messageId: messageId as never }, "Arke", true);
  const playback = usePlayback();
  /** Which press started the read under way, or null when none is: the label says it. */
  const [mode, setMode] = useState<"listen" | "auto" | null>(null);
  const sounded = useRef(false);
  const mine = read.request !== null && playback.clip?.id === read.request;

  // The row rests again when the read is over: its last piece played out, a failure, a Stop
  // from anywhere (the composer, the next read), or another sound taking the player over. A
  // read that loses the player — the dock dismissed, another clip played — is stopped, not only
  // relabelled (codex on PR 1473): its request would otherwise stay live, and the next piece to
  // land would start the old reply again over whatever replaced it.
  useEffect(() => {
    if (mode === null) return;
    if (read.request === null || read.error !== null) { setMode(null); return; }
    if (mine) {
      sounded.current = true;
      if (playback.status === "ended" && read.settled) setMode(null);
      else if (playback.status === "error") { read.stop(); setMode(null); }
      return;
    }
    if (sounded.current) { read.stop(); setMode(null); }
  }, [mode, mine, playback.status, read.request, read.settled, read.error]);

  const start = (how: "listen" | "auto") => {
    sounded.current = false;
    setMode(how);
    // A read already made this session replays from here, without another call.
    if (read.clip !== null) read.replay(read.clip);
    else read.onRead();
  };
  const autoDone = useRef(false);
  useEffect(() => {
    if (!auto || autoDone.current) return;
    autoDone.current = true;
    start("auto");
  }, [auto]);

  if (text.trim() === "") return null;
  // A read waiting on its price or its upload question is under way too (codex on PR 1473): the
  // button says so, and pressing it cancels, as it stops one that is sounding.
  const active = mode !== null || read.asking;
  const playing = active && !read.asking;
  const label = active ? (mode === "auto" ? "Reading" : "Listening") : "Listen";
  const listen = (
    <button
      type="button"
      className={cx("fy-replyacts__btn", active && "fy-replyacts__btn--on")}
      aria-label={phone ? (active ? "Stop reading" : "Listen") : undefined}
      aria-pressed={active}
      onClick={() => {
        if (active) { read.stop(); setMode(null); }
        else start("listen");
      }}
    >
      <Speaker size={phone ? 16 : 13} />
      {!phone && <span>{label}</span>}
    </button>
  );
  const copy = (
    <button
      type="button"
      className="fy-replyacts__btn"
      aria-label={phone ? "Copy" : undefined}
      onClick={() => void navigator.clipboard?.writeText(text)}
    >
      {phone ? <Copy size={16} /> : "Copy"}
    </button>
  );
  const time = mine ? clock(playback.currentTime) : "0:00";
  return (
    <>
      <div className="fy-replyacts" data-phone={phone ? "true" : undefined}>
        {listen}
        {copy}
        {/* The transcript is a polite live region; a clock that ticks every frame is not news. */}
        {phone && playing && <span className="fy-mono fy-replyacts__reader" aria-live="off">{`${read.reader} · ${time}`}</span>}
      </div>
      {read.confirmation}
      {!phone && playing && (
        <div className="fy-replyplay" role="group" aria-label="Reading this reply" aria-live="off">
          <button type="button" className="fy-replyplay__stop" aria-label="Stop" onClick={() => { read.stop(); setMode(null); }}>
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" /></svg>
          </button>
          <span className="fy-replyplay__mid">
            <span className="fy-mono">{read.reader}</span>
            <span className="fy-replyplay__bar"><i style={{ width: `${mine && playback.duration > 0 ? Math.min(100, (playback.currentTime / playback.duration) * 100) : 0}%` }} /></span>
          </span>
          <span className="fy-mono">{mine ? `${time} / ${clock(playback.duration)}` : time}</span>
        </div>
      )}
      {read.error !== null && (freePlanStop(read.error) !== null
        ? <FreePlanStop error={read.error} onDefaultNarrator={() => { sounded.current = false; setMode("listen"); read.onReadShipped(); }} />
        : <span className="fy-textactions__note">{read.error}</span>)}
    </>
  );
}

/**
 * The same read as a plain button, for a row of controls rather than a paragraph.
 *
 * A shot's script is edited in place — the row is a text area — and the hover speaker that works
 * beside a finished paragraph fights the caret there. So the same control appears where the
 * row's other buttons are, which is the call the bible made for the same reason.
 */
export function ReadAloudButton({
  source,
  title,
  text,
  disabled,
}: {
  source: ProseReadSource;
  title: string;
  text: string;
  disabled?: boolean;
}) {
  const { clip, onRead, onReadShipped, preparing, confirmation, error, replay } = useProseRead(source, title);
  return (
    <>
    {confirmation}
    <button
      type="button"
      disabled={disabled === true || text.trim() === "" || preparing}
      title="Read aloud"
      onClick={() => {
        if (clip) replay(clip);
        else onRead();
      }}
    >
      {preparing ? "Preparing…" : "Listen"}
    </button>
    {error && (freePlanStop(error) !== null
      ? <FreePlanStop error={error} onDefaultNarrator={onReadShipped} />
      : <span className="fy-textactions__note">{error}</span>)}
    </>
  );
}
