import { useConversationPresentation, useConversationState } from "./global-chat-context.js";
import { useEffect, useId, useRef, useState } from "react";
import type { VoiceRuntimeStatus } from "@arke-studio/contracts";
import { BodyTip, focusIsVisible } from "./body-tip.js";
import { Mic } from "./icons.js";
import { Loading } from "./loading.js";
import { Button } from "./ui.js";
import { transcribeDictation, useDictation, useStore, useVoiceSidecar } from "../lib/store.js";

/**
 * Speaking instead of typing (SPEC-011 R-17, SPEC-018 R-1).
 *
 * Audio is captured here, transcribed on loopback by whisper.cpp, and inserted as **editable
 * text that is never submitted**. That last part is the whole safety story: a mis-transcribed
 * sentence that sent itself would be a proposal nobody meant, and a world is made of exactly the
 * proper nouns transcription gets wrong — Maren Kest, the Ebb Council, the Drowned Quarter are
 * strings Whisper has never seen. The edit step is what makes the mode tolerable (SPEC-018 R-5).
 *
 * Nothing new leaves the machine (SPEC-018 R-15). The transcription URL is loopback, and the
 * captured audio is dropped as soon as it has been transcribed (R-13) — the transcript is the
 * artefact, the recording is a buffer.
 *
 * **Click to start, click to stop — not hold-to-talk, and that is a deliberate departure from
 * SPEC-018 R-4.** The spec rejected silence detection because worldbuilding is full of long
 * pauses: people stop mid-sentence to decide whether the drowned god sings or sleeps. That
 * argument cuts against holding a key through those pauses just as hard as it cuts against a VAD
 * guillotining them, and hold-to-speak has to work from the keyboard too (R-17), which is the
 * control most likely to end up mouse-only by accident. Click-toggle is one control that already
 * works for both pointer and keyboard. Worth revisiting if accidental captures turn up in use.
 */

/**
 * Why dictation cannot be used at all, or null when it can — named rather than collapsed into
 * "voice is unavailable" (SPEC-018 R-14, D9).
 *
 * The order is most-specific-first: a missing model is a truer answer than "the sidecar is not
 * ready", because it tells the person what to actually do about it. `unknown` is optimistic,
 * matching the app's behaviour before any voice status has arrived — a button that refuses
 * because nothing has reported in yet would be wrong more often than right.
 */
export function whyDictationIsOff(
  sidecar: { state: string; detail: string } | null,
  runtime: VoiceRuntimeStatus | null,
): string | null {
  const whisper = runtime?.engineStatus.whisper;
  if (whisper) {
    if (whisper.state === "ready") return null;
    if (whisper.state === "downloading") return "the dictation model is still downloading";
    if (whisper.state === "missing") return "the dictation model has not been downloaded yet";
    if (whisper.state === "verification-failed") {
      return whisper.detail ?? "the dictation model failed verification";
    }
    if (whisper.state === "unavailable") return whisper.detail ?? "the dictation model is unavailable";
  }
  if (sidecar && sidecar.state !== "ready") return sidecar.detail;
  return null;
}

export type DictationPhase = "idle" | "listening" | "transcribing";

interface PushToTalk {
  phase: DictationPhase;
  /** Why it cannot be used at all, or null. Stated before anything is pressed. */
  off: string | null;
  /** What went wrong on the last attempt, or null. Replaced by the next one. */
  trouble: string | null;
  toggle: () => void;
}

/**
 * The capture state machine, shared by both presentations so there is one of it.
 *
 * Kept out of the composer itself: the composer is a presentational component whose every
 * capability arrives as a prop, and this one needs the store. Living in a child that only mounts
 * when dictation is asked for keeps that true.
 */
function usePushToTalk(onText: (text: string) => void): PushToTalk {
  const presentation = useConversationPresentation();
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [trouble, setTrouble] = useConversationState<string | null>("dictationTrouble", null);
  const capture = useRef<{ recorder: MediaRecorder; stop(): void } | null>(null);
  const epoch = useRef(0), mounted = useRef(true), deliver = useRef(onText);
  deliver.current = onText;
  const sidecar = useVoiceSidecar(), { state, connection } = useStore(), dictation = useDictation();
  const result = requestId ? dictation[requestId] : undefined;
  useEffect(() => {
    if (!result) return;
    if (result.text && !presentation) onText(result.text);
    setTrouble(result.error); setRequestId(null);
  }, [result]);
  useEffect(() => {
    if (connection === "open" || !requestId) return;
    setRequestId(null);
    setTrouble("The connection ended before dictation returned. Your typed draft is retained; dictate again.");
  }, [connection, requestId]);
  useEffect(() => {
    presentation?.owner.phase(recorder ? "listening" : requestId ? "transcribing" : "idle");
  }, [recorder, requestId, presentation?.owner]);
  const stop = () => { epoch.current += 1; capture.current?.stop(); };
  const stopping = useRef(stop); stopping.current = stop;
  const lastStop = useRef(presentation?.stopCapture);
  useEffect(() => {
    if (lastStop.current !== presentation?.stopCapture) stopping.current();
    lastStop.current = presentation?.stopCapture;
  }, [presentation?.stopCapture]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopping.current(); };
  }, []);
  const off = whyDictationIsOff(sidecar, state?.app.voiceRuntime ?? null);
  const start = async () => {
    const mine = ++epoch.current;
    let acquired: MediaStream | null = null;
    // Capture its destination now; later page navigation cannot move the transcript.
    const destination = presentation, onCapturedText = deliver.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      acquired = stream;
      if (!mounted.current || mine !== epoch.current) { stream.getTracks().forEach(t => t.stop()); return; }
      const rec = new MediaRecorder(stream), chunks: Blob[] = [];
      let id: string | null = null;
      const release = () => stream.getTracks().forEach(t => t.stop());
      rec.ondataavailable = event => chunks.push(event.data);
      rec.onstop = () => {
        release(); capture.current = null;
        if (!id) return;
        void new Blob(chunks, { type: rec.mimeType }).arrayBuffer().then(buffer => {
          let binary = ""; for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
          if (!transcribeDictation(id!, btoa(binary), rec.mimeType || "audio/webm")) throw Error("Reconnect before transcribing. Typing still works.");
        }).catch(error => {
          const reason = error instanceof Error ? error.message : "The recording could not be transcribed. Typing still works.";
          destination?.owner.deliverDictation(id!, { error: reason });
          if (mounted.current) { setTrouble(reason); setRequestId(null); }
        });
      };
      capture.current = { recorder: rec, stop: () => {
        if (rec.state === "inactive") { release(); return; }
        id = crypto.randomUUID();
        if (destination) destination.owner.queueDictation(destination.key, id, onCapturedText);
        if (mounted.current) { setRequestId(id); setRecorder(null); }
        rec.stop(); release();
      } };
      rec.start(); setTrouble(null); setRecorder(rec);
    } catch (error) {
      acquired?.getTracks().forEach(track => track.stop());
      if (!mounted.current || mine !== epoch.current) return;
      const name = error instanceof Error ? error.name : "";
      setTrouble(name === "NotAllowedError" ? "Arke was not allowed to use the microphone. Grant access, then try again."
        : name === "NotFoundError" ? "No microphone was found on this machine." : "The microphone could not be opened.");
    }
  };
  return { phase: recorder ? "listening" : requestId ? "transcribing" : "idle", off, trouble,
    toggle: () => { if (off || requestId) return; if (recorder) stop(); else void start(); } };
}

/**
 * Listening, in a word (SPEC-018 R-16).
 *
 * Listening and transcribing must be told apart without motion and without colour alone: the app
 * flattens animation entirely under `prefers-reduced-motion`, so anything carried by movement
 * resolves to the same still shape for the users least able to guess at the difference.
 * Transcribing already carries its own written state through the house loader; this is the other.
 */
const LISTENING = "listening — click to stop";

/**
 * The composer's microphone: an icon in the control bar, beside attach.
 *
 * Its state words go in the bar's existing left slot rather than beneath the composer, so
 * dictating does not change the height of the box being dictated into.
 */
export function ComposerMic({
  onText,
  disabled = false,
  onListen,
}: {
  onText: (text: string) => void;
  disabled?: boolean;
  /** Called as listening starts: a reply being read stops, rather than being dictated (turn 183). */
  onListen?: () => void;
}) {
  const ptt = usePushToTalk(onText);
  const [tip, setTip] = useState<HTMLElement | null>(null);
  const describedBy = useId();
  // Why dictation is off is the mic's tip, never words in the row. Said there, it was a flex item
  // squeezed to a word a line in the 302 production dock: four lines climbing over the editor, and
  // the model chips pushed under send (local.16). What happened on a press, and listening, are
  // still said beside it; they are news, and short.
  const about = ptt.off !== null
    ? `Dictation is off — ${ptt.off}`
    : "Speak instead of typing — transcribed on this machine, never sent to a provider";
  const say = ptt.trouble ?? (ptt.phase === "listening" ? LISTENING : null);
  const off = ptt.off !== null;

  return (
    <>
      <button
        type="button"
        className="fy-cx__mic"
        data-listening={ptt.phase === "listening" ? "true" : undefined}
        // Off for a reason is aria-disabled, not disabled: a disabled button takes no focus and,
        // in Chromium, no pointer events, so its tip could reach nobody.
        disabled={disabled}
        aria-disabled={off && !disabled ? true : undefined}
        aria-label={ptt.phase === "listening" ? "Stop and transcribe" : "Dictate"}
        aria-pressed={ptt.phase === "listening"}
        aria-describedby={describedBy}
        onMouseEnter={(event) => setTip(event.currentTarget)}
        onMouseLeave={() => setTip(null)}
        onFocus={(event) => { if (focusIsVisible(event.currentTarget)) setTip(event.currentTarget); }}
        onBlur={() => setTip(null)}
        onClick={() => {
          if (off) return;
          if (ptt.phase !== "listening") onListen?.();
          ptt.toggle();
        }}
      >
        <Mic size={15} />
      </button>
      <span id={describedBy} hidden>{about}</span>
      {tip !== null && <BodyTip anchor={tip}>{about}</BodyTip>}
      {ptt.phase === "transcribing" && <Loading inline label="transcribing locally…" />}
      {say && <span className="fy-cx__busy" title={say}>{say}</span>}
    </>
  );
}

/**
 * The standalone button, for surfaces whose input is a plain textarea rather than the composer.
 */
export function DictationButton({ onText }: { onText: (text: string) => void }) {
  const ptt = usePushToTalk(onText);
  const say = ptt.trouble ?? (ptt.off !== null ? `Dictation is off — ${ptt.off}` : null);

  return (
    <span style={{ display: "inline-flex", gap: "var(--space-2)", alignItems: "center" }}>
      <Button
        variant="ghost"
        disabled={ptt.off !== null}
        aria-pressed={ptt.phase === "listening"}
        title={
          ptt.off !== null
            ? `Dictation is off — ${ptt.off}`
            : "Audio is transcribed locally and never sent to a provider"
        }
        onClick={ptt.toggle}
      >
        {ptt.phase === "listening" ? "Stop · transcribe" : "🎤 Dictate"}
      </Button>
      {ptt.phase === "transcribing" && <Loading inline label="transcribing locally…" />}
      {say && <span className="scr-field__hint">{say}</span>}
    </span>
  );
}
