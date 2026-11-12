import { useEffect, useRef, useState } from "react";
import { STUDIO_ASSISTANT_LIMITS, StudioDictationContentTypeSchema } from "@arke-studio/contracts";
import type { StudioConversationClient } from "../lib/studio-assistant.js";
import { useStore, useVoiceSidecar } from "../lib/store.js";
import { stopReplyRead } from "../lib/reply-reads.js";
import { ComposerMicControl, whyDictationIsOff, type DictationPhase } from "./dictation.js";

interface Capture {
  control: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
}

/** Reuses the native microphone control, but never the shared dictation event/store. Closing
 * Studio discards this recording and revokes its text delivery, including a pending permission
 * prompt. Only an explicit stop (or the announced minute limit) requests local transcription. */
export function StudioDictation({ client, enabled, onPhase }: { client: StudioConversationClient; enabled: boolean; onPhase(phase: DictationPhase): void }) {
  const { state } = useStore(), sidecar = useVoiceSidecar();
  const [phase, setPhase] = useState<DictationPhase>("idle"), [trouble, setTrouble] = useState<string | null>(null);
  const active = useRef<Capture | null>(null), mounted = useRef(false);
  const off = whyDictationIsOff(sidecar, state?.app.voiceRuntime ?? null);
  const release = (capture: Capture) => {
    clearTimeout(capture.timer); capture.stream?.getTracks().forEach(track => track.stop());
  };
  const discard = () => {
    const capture = active.current; active.current = null;
    if (capture) {
      capture.control.abort(); release(capture);
      if (capture.recorder?.state !== "inactive") { try { capture.recorder?.stop(); } catch { /* Tracks already stopped. */ } }
    }
    if (mounted.current) setPhase("idle");
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; discard(); }; }, []);
  useEffect(() => { onPhase(phase); }, [phase, onPhase]);
  useEffect(() => { if (!enabled) discard(); }, [enabled]);
  const start = async () => {
    if (!enabled || off || active.current) return;
    const capture: Capture = { control: new AbortController() }; active.current = capture;
    const destination = client.dictationTarget();
    setTrouble(null); setPhase("requesting"); stopReplyRead();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); capture.stream = stream;
      if (!mounted.current || capture.control.signal.aborted || active.current !== capture) { release(capture); return; }
      const contentType = StudioDictationContentTypeSchema.options.find(type => MediaRecorder.isTypeSupported(type));
      if (!contentType) throw new Error("Unsupported recording format");
      const recorder = new MediaRecorder(stream, { mimeType: contentType }); capture.recorder = recorder;
      let chunks: Blob[] = [], bytes = 0;
      const fail = (message: string) => { if (active.current === capture) { discard(); setTrouble(message); } };
      recorder.ondataavailable = event => {
        if (capture.control.signal.aborted) return;
        bytes += event.data.size;
        if (bytes > STUDIO_ASSISTANT_LIMITS.dictationBytes) { chunks = []; fail("The recording is too large. Dictate a shorter passage."); return; }
        chunks.push(event.data);
      };
      recorder.addEventListener("error", () => fail("The recording could not be completed. Your typed draft is retained."));
      recorder.onstop = () => {
        release(capture);
        if (capture.control.signal.aborted || active.current !== capture) { chunks = []; return; }
        setPhase("transcribing");
        const audio = new Blob(chunks, { type: contentType }); chunks = [];
        void audio.arrayBuffer().then(async buffer => {
          if (capture.control.signal.aborted) return false;
          let binary = ""; for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
          return destination(btoa(binary), contentType, capture.control.signal);
        }).then(delivered => {
          if (active.current === capture && !capture.control.signal.aborted && !delivered) setTrouble("Dictation could not be added. Your typed draft is retained; try a shorter passage or check Local AI health.");
        }, () => {
          if (active.current === capture && !capture.control.signal.aborted) setTrouble("Dictation is unavailable. Your typed draft is retained.");
        }).finally(() => { if (active.current === capture) { active.current = null; if (mounted.current) setPhase("idle"); } });
      };
      recorder.start(250); setPhase("listening");
      capture.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, STUDIO_ASSISTANT_LIMITS.dictationMs);
    } catch (error) {
      if (capture.control.signal.aborted || active.current !== capture) { release(capture); return; }
      discard();
      setTrouble(error instanceof Error && error.name === "NotAllowedError" ? "Microphone access was denied. Grant access, then try again."
        : "The microphone could not be opened. Your typed draft is retained.");
    }
  };
  return <ComposerMicControl disabled={!enabled} control={{ phase, off, trouble: trouble ?? (phase === "listening" ? "Listening · stops after one minute" : null),
    toggle: () => { const capture = active.current; if (!capture) void start(); else if (capture.recorder?.state === "recording") capture.recorder.stop(); else if (!capture.recorder) discard(); } }} />;
}
