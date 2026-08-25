import { useEffect, useState } from "react";
import type { VoiceRuntimeStatus } from "@arke-studio/contracts";
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
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const sidecar = useVoiceSidecar();
  const { state } = useStore();
  const dictation = useDictation();
  const result = requestId ? dictation[requestId] : undefined;

  useEffect(() => {
    if (!result) return;
    if (result.text) onText(result.text);
    setTrouble(result.error);
    // Cleared either way: an error that never clears leaves the surface saying a failure from
    // ten minutes ago is happening now.
    setRequestId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const off = whyDictationIsOff(sidecar, state?.app.voiceRuntime ?? null);

  const start = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        // Released the moment capture ends: nothing in this app should hold a microphone open
        // one frame longer than it is being spoken into.
        stream.getTracks().forEach((t) => t.stop());
        const id = `dict-${Date.now()}`;
        setRequestId(id);
        void new Blob(chunks, { type: rec.mimeType }).arrayBuffer().then((buf) => {
          let binary = "";
          const bytes = new Uint8Array(buf);
          for (const b of bytes) binary += String.fromCharCode(b);
          transcribeDictation(id, btoa(binary), rec.mimeType || "audio/webm");
        });
      };
      rec.start();
      setTrouble(null);
      setRecorder(rec);
    } catch (err) {
      /*
       * A denied microphone used to do nothing at all — the button was pressed and the app sat
       * there. Which of these it is decides what the person does next, so each is named (R-14).
       */
      const name = err instanceof Error ? err.name : "";
      setTrouble(
        name === "NotAllowedError"
          ? "Arke was not allowed to use the microphone. Grant access, then try again."
          : name === "NotFoundError"
            ? "No microphone was found on this machine."
            : "The microphone could not be opened.",
      );
    }
  };

  return {
    phase: recorder ? "listening" : requestId ? "transcribing" : "idle",
    off,
    trouble,
    toggle: () => {
      if (off) return;
      if (recorder) {
        recorder.stop();
        setRecorder(null);
      } else {
        void start();
      }
    },
  };
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
}: {
  onText: (text: string) => void;
  disabled?: boolean;
}) {
  const ptt = usePushToTalk(onText);
  const say =
    ptt.trouble ??
    (ptt.off !== null ? `Dictation is off — ${ptt.off}` : ptt.phase === "listening" ? LISTENING : null);

  return (
    <>
      <button
        type="button"
        className="fy-cx__mic"
        data-listening={ptt.phase === "listening" ? "true" : undefined}
        disabled={disabled || ptt.off !== null}
        aria-label={ptt.phase === "listening" ? "Stop and transcribe" : "Dictate"}
        aria-pressed={ptt.phase === "listening"}
        title={
          ptt.off !== null
            ? `Dictation is off — ${ptt.off}`
            : "Speak instead of typing — transcribed on this machine, never sent to a provider"
        }
        onClick={ptt.toggle}
      >
        <Mic size={15} />
      </button>
      {ptt.phase === "transcribing" && <Loading inline label="transcribing locally…" />}
      {say && <span className="fy-cx__busy">{say}</span>}
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
