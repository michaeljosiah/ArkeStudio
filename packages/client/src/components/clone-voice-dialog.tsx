import { useEffect, useMemo, useRef, useState } from "react";
import { extractVoiceAttributes } from "@arke-studio/contracts";
import {
  cloneVoice,
  discardVoiceClip,
  stageVoiceClip,
  useVoiceCloned,
  useVoiceClips,
  type StagedClip,
} from "../lib/store.js";
import { MAX_RECORDING_BASE64, recordingToWav, toBase64 } from "../lib/wav.js";
import { Input, Textarea, cx } from "./ui.js";
import { Folder, Mic, Waveform, X } from "./icons.js";

/**
 * Making a voice from a clip (design 74c, 74d).
 *
 * Two screens rather than one, and the order is the point: the clip is chosen and accepted before
 * a name is typed. A single screen would take a name, a description and a recording together and
 * then refuse the lot over the recording — so staging settles the clip first, and 74d is only ever
 * reached with a clip that is already known to be good.
 *
 * The recording is never a reference. 70e took both reference lanes out of voice mode because a
 * text-to-speech route carries neither, and that stands: this clip is the voice's identity, chosen
 * once when the voice is made, not a thing a shot cites at generate time.
 *
 * The two screens are drawn by `ClipStep` and `NameStep`, which hold nothing — everything they
 * show arrives as a prop, so each can be rendered and read on its own.
 */
export function CloneVoiceDialog({
  open,
  worldId,
  sheetId,
  onClose,
  onCloned,
}: {
  open: boolean;
  worldId: string;
  /** The sheet being cast when this was opened — provenance on the voice, never ownership. */
  sheetId?: string;
  onClose: () => void;
  onCloned?: (voiceId: string) => void;
}) {
  const clips = useVoiceClips();
  const cloned = useVoiceCloned();
  const [step, setStep] = useState<"clip" | "name">("clip");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const staged: StagedClip | null = (requestId ? clips[requestId] : undefined) ?? null;
  const clipId = staged?.clipId ?? null;
  // Read by `abandon`, which must not be rebuilt on every keystroke just to see the current clip.
  const clipRef = useRef<string | null>(null);
  clipRef.current = clipId;

  useEffect(() => {
    if (!open) return;
    setStep("clip");
    setRequestId(null);
    setConsent(false);
    setName("");
    setDescription("");
    setSaving(false);
    setTrouble(null);
    setElapsed(0);
  }, [open]);

  // A running timer, so a recording states its own length while it is being made rather than only
  // once it is staged. 74c draws the figure either way.
  useEffect(() => {
    if (!recorder) return;
    const started = Date.now();
    const tick = setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => clearInterval(tick);
  }, [recorder]);

  /*
   * The clone's answer: a voice, or the words the library refused in. Never a generic failure.
   *
   * `voiceCloned` holds the LAST clone's outcome, so it is already populated when a second save
   * begins. Waiting for the value to change rather than merely to exist is what stops a retry
   * from being answered instantly with the refusal it is retrying.
   */
  const answered = useRef(cloned);
  useEffect(() => {
    if (!saving) {
      answered.current = cloned;
      return;
    }
    if (!cloned || cloned === answered.current) return;
    answered.current = cloned;
    setSaving(false);
    if (cloned.voiceId) {
      onCloned?.(cloned.voiceId);
      onClose();
    } else {
      setTrouble(cloned.reason ?? "That clip could not become a voice.");
    }
  }, [saving, cloned, onCloned, onClose]);

  if (!open) return null;

  const abandon = (): void => {
    // The temp file should not outlive the screen that made it.
    if (clipRef.current) discardVoiceClip(clipRef.current);
    if (recorder?.state === "recording") recorder.stop();
    onClose();
  };

  const startRecording = async (): Promise<void> => {
    setTrouble(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (event) => chunks.push(event.data);
      rec.onstop = () => {
        // Released the moment capture ends: nothing in this app should hold a microphone open one
        // frame longer than it is being spoken into.
        stream.getTracks().forEach((track) => track.stop());
        setRecorder(null);
        setPreparing(true);
        void recordingToWav(new Blob(chunks, { type: rec.mimeType }))
          .then((wav) => {
            const audioBase64 = toBase64(wav);
            if (audioBase64.length > MAX_RECORDING_BASE64) {
              setTrouble("that recording is too long to send — about a minute is the most this can carry");
              return;
            }
            setRequestId(stageVoiceClip(worldId, { audioBase64, contentType: "audio/wav" }));
          })
          .catch(() => setTrouble("that recording could not be read back"))
          .finally(() => setPreparing(false));
      };
      rec.start();
      setElapsed(0);
      setRecorder(rec);
    } catch (error) {
      /*
       * Which of these it is decides what the person does next, so each is named rather than the
       * button simply doing nothing — the same reason dictation names them (SPEC-018 R-14).
       */
      const kind = error instanceof Error ? error.name : "";
      setTrouble(
        kind === "NotAllowedError"
          ? "Arke was not allowed to use the microphone. Grant access, then try again."
          : kind === "NotFoundError"
            ? "No microphone was found. Choose a file instead."
            : "The microphone could not be started. Choose a file instead.",
      );
    }
  };

  return (
    <>
      <div className="fy-bench__scrim" onClick={abandon} />
      <div className="fy-clone" role="dialog" aria-label="Clone a voice" data-testid="clone-voice">
        <div className="fy-voices__head">
          <strong className="fy-voices__title">Clone a voice</strong>
          <span style={{ flex: 1 }} />
          <button type="button" className="fy-bench__footicon" aria-label="Close" onClick={abandon}>
            <X size={12} />
          </button>
        </div>
        {step === "clip" ? (
          <ClipStep
            staged={staged}
            consent={consent}
            recording={recorder !== null}
            preparing={preparing}
            elapsed={elapsed}
            trouble={trouble}
            onConsent={setConsent}
            onRecord={() => (recorder ? recorder.stop() : void startRecording())}
            onChoose={() => {
              setTrouble(null);
              // No path crosses this line: the host opens its own dialog and keeps what it
              // returns, and the answer names the clip without saying where it is (SPEC-001 R-9).
              setRequestId(stageVoiceClip(worldId));
            }}
            onCancel={abandon}
            onNext={() => setStep("name")}
          />
        ) : (
          <NameStep
            name={name}
            description={description}
            saving={saving}
            ready={clipId !== null}
            trouble={trouble}
            onName={setName}
            onDescription={setDescription}
            onBack={() => setStep("clip")}
            onSave={() => {
              if (!clipId) return;
              setTrouble(null);
              setSaving(true);
              cloneVoice({
                worldId,
                clipId,
                name: name.trim(),
                description: description.trim(),
                ...(sheetId !== undefined ? { sheetId } : {}),
              });
            }}
          />
        )}
      </div>
    </>
  );
}

/** 74c — the clip, recorded or chosen, and the one thing the app owes anybody about cloning. */
export function ClipStep({
  staged,
  consent,
  recording,
  preparing,
  elapsed,
  trouble,
  onConsent,
  onRecord,
  onChoose,
  onCancel,
  onNext,
}: {
  staged: StagedClip | null;
  consent: boolean;
  recording: boolean;
  preparing: boolean;
  elapsed: number;
  trouble: string | null;
  onConsent: (value: boolean) => void;
  onRecord: () => void;
  onChoose: () => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  return (
    <div className="fy-clone__body">
      <div className="fy-clone__sources">
        <button
          type="button"
          className={cx("fy-clone__source", recording && "fy-clone__source--on")}
          data-testid="clone-record"
          disabled={preparing}
          onClick={onRecord}
        >
          <Mic size={16} />
          {recording ? "Stop" : "Record"}
        </button>
        <button
          type="button"
          className="fy-clone__source"
          data-testid="clone-choose"
          disabled={recording || preparing}
          onClick={onChoose}
        >
          <Folder size={16} />
          Choose a file
        </button>
        <span className="fy-clone__elapsed" data-testid="clone-elapsed">
          {recording ? formatSeconds(elapsed) : staged?.seconds != null ? formatSeconds(staged.seconds) : ""}
        </span>
      </div>

      {/* What is staged, by name. Never where it came from. */}
      {preparing && <p className="fy-clone__note">Reading the recording…</p>}
      {!preparing && staged?.clipId && (
        <p className="fy-clone__clip" data-testid="clone-clip">
          <Waveform size={12} />
          {staged.fileName}
        </p>
      )}
      {(trouble ?? staged?.reason) && (
        <p className="fy-clone__trouble" data-testid="clone-trouble">
          {trouble ?? staged?.reason}
        </p>
      )}

      <p className="fy-clone__hint">wav · mp3 · 3 seconds or more</p>

      {/* Consent is a checkbox, not a paragraph: the model cannot tell whether the speaker in a
          clip agreed to be cloned, and neither can the app. Stated once, here, on the screen where
          the clip is chosen — never repeated on the picker, the bench, or a take. */}
      <label className="fy-clone__consent">
        <input
          type="checkbox"
          checked={consent}
          data-testid="clone-consent"
          onChange={(event) => onConsent(event.target.checked)}
        />
        The person speaking agreed to have their voice cloned.
      </label>
      <p className="fy-clone__note">files as an artifact</p>

      <div className="fy-voices__foot">
        <span style={{ flex: 1 }} />
        <button type="button" className="fy-bench__chip" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="fy-voices__use"
          data-testid="clone-next"
          // Both gates, on one button. Past it on consent alone is 74d with nothing to clone from.
          disabled={!staged?.clipId || !consent}
          onClick={onNext}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/** 74d — naming it, where the description is what the picker will rank the voice by. */
export function NameStep({
  name,
  description,
  saving,
  ready,
  trouble,
  onName,
  onDescription,
  onBack,
  onSave,
}: {
  name: string;
  description: string;
  saving: boolean;
  /** Whether a clip is still staged behind this screen. */
  ready: boolean;
  trouble: string | null;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onBack: () => void;
  onSave: () => void;
}) {
  // The words the picker will actually match on, extracted as they are typed — the same function
  // that reads a sheet's written voice, so what is shown here is what is matched there.
  const attributes = useMemo(() => extractVoiceAttributes(description), [description]);
  return (
    <div className="fy-clone__body">
      <label className="fy-clone__field">
        <span className="fy-clone__label">Name</span>
        <Input value={name} data-testid="clone-name" placeholder="Harbour glass" onChange={(e) => onName(e.target.value)} />
      </label>
      <label className="fy-clone__field">
        <span className="fy-clone__label">
          Description
          {/* Why it is required, as data on the label rather than as an explaining sentence: a
              cloned clip arrives with no provider metadata, and rankVoices puts a candidate with
              no attributes last — so a voice cloned FOR a character would sink below every preset
              when ranked against her. */}
          <em className="fy-clone__labelnote">ranked against written voice</em>
        </span>
        <Textarea
          value={description}
          rows={3}
          data-testid="clone-description"
          placeholder="Low, dry, unhurried. Coastal."
          onChange={(e) => onDescription(e.target.value)}
        />
      </label>
      {attributes.length > 0 && (
        <p className="fy-clone__attrs" data-testid="clone-attrs">
          {attributes.map((word) => (
            <span key={word} className="fy-pill">
              {word}
            </span>
          ))}
        </p>
      )}
      <p className="fy-clone__note">available to every character in this world</p>
      {trouble && (
        <p className="fy-clone__trouble" data-testid="clone-trouble">
          {trouble}
        </p>
      )}

      <div className="fy-voices__foot">
        <span style={{ flex: 1 }} />
        <button type="button" className="fy-bench__chip" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="fy-voices__use"
          data-testid="clone-save"
          disabled={saving || !ready || name.trim().length === 0 || description.trim().length === 0}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save voice"}
        </button>
      </div>
    </div>
  );
}

/** `0:09`, the way 74c writes it. */
function formatSeconds(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export default CloneVoiceDialog;
