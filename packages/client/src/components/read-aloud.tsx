import { useEffect, useRef, useState } from "react";
import { narratorLabelFor, type ProseReadSource } from "@arke-studio/contracts";
import { readProse, useStore, useVoiceAudio, useVoiceParts } from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";
import { clearQueue, enqueueClip, playClip, type Clip } from "../lib/audio.js";
import { TextActions } from "./player.js";
import { ReadAloudConfirmation } from "./read-aloud-confirmation.js";
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
 */
function useProseRead(source: ProseReadSource, title: string) {
  const { state } = useStore();
  const world = state?.world ?? null;
  const voiceAudio = useVoiceAudio();
  const partsByRequest = useVoiceParts();
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [request, setRequest] = useState<string | null>(null);
  const result = request === null ? undefined : voiceAudio[request];
  const slug = world?.meta.slug;
  // A cloned narrator's recording is asked about before the price (issue 1215); the answer rides
  // on every later frame of this read.
  const live = useRef<string | null>(null);
  live.current = request;
  const upload = useVoiceUploadAsk(() => live.current);
  // The app's narrator as this world will hear it (issue 1215): a cloned voice through a hosted
  // reader may be one, the local recipe's may not, and a clone is its own world's; a choice that
  // fails either rule is named as the shipped local voice it falls to, never as itself.
  const narratorLabel = narratorLabelFor(state?.app.narrator ?? null, world?.meta.worldId);
  const sub = `read aloud · ${narratorLabel}`;

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

  /** Fresh when nothing is passed; the same request again when a charge, or the vendor, has been confirmed. */
  const ask = (again?: { requestId: string; confirmationToken?: string }) => {
    const worldId = world?.meta.worldId;
    if (worldId === undefined) return;
    queued.current = 0;
    // A second read replaces the first outright: two voices over one another is never what
    // anybody meant.
    clearQueue();
    if (again === undefined) upload.drop();
    setRequest(readProse(worldId, source, again?.requestId, again?.confirmationToken, upload.allowed()));
  };

  /*
   * A cloud narrator is billed per character, so the number is stated before it is spent — the
   * same shape the sheet's read uses. The local default never reaches this branch.
   */
  const quote = `${request}:${result?.confirmationToken ?? ""}`;
  const preparing = request !== null && (result === undefined || (result.status === "confirmation-required" && submitted === quote));
  const note = preparing ? <span className="fy-textactions__note">Preparing audio…</span> : undefined;
  const confirmation = upload.asked !== null && request !== null ? (
    <RemoteVoiceUploadConfirmation
      destinationLabel={upload.asked.destination}
      destinationNotice={upload.asked.notice}
      onCancel={() => { upload.drop(); setRequest(null); }}
      onConfirm={() => { if (upload.answer() !== null) ask({ requestId: request }); }}
    />
  ) : result?.status === "confirmation-required" && submitted !== quote ? (
    <ReadAloudConfirmation title={title} result={result} onCancel={() => { upload.drop(); setRequest(null); }} onConfirm={confirmationToken => {
      if (request === null) return;
      setSubmitted(quote);
      ask({ requestId: request, confirmationToken });
    }} />
  ) : null;

  return {
    clip,
    onRead: () => ask(),
    note,
    confirmation,
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
  const { clip, onRead, note, error, confirmation } = useProseRead(source, title);
  if (text.trim() === "") return null;
  return (
    <>
      {confirmation}
      <TextActions clip={clip} onRead={onRead} copyText={text} readLabel="Read aloud" note={note} />
      {error !== null && <span className="fy-textactions__note">{error}</span>}
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
  const { clip, onRead, preparing, confirmation, error } = useProseRead(source, title);
  return (
    <>
    {confirmation}
    <button
      type="button"
      disabled={disabled === true || text.trim() === "" || preparing}
      title="Read aloud"
      onClick={() => {
        if (clip) void playClip(clip);
        else onRead();
      }}
    >
      {preparing ? "Preparing…" : "Listen"}
    </button>
    {error && <span className="fy-textactions__note">{error}</span>}
    </>
  );
}
