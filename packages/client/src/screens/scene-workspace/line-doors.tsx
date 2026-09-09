import { useEffect, useRef, useState } from "react";
import {
  formatMicroUsd,
  normalizeSpeechText,
  ulid,
  type CadencePlan,
  type ManifestModel,
  type PerformanceGenerationQuote,
  type ProductionBundle,
  type SceneRecord,
  type Sheet,
  type WorldBundle,
} from "@arke-studio/contracts";
import { Button } from "../../components/ui.js";
import { dismissPlayback, playClip, playbackSnapshot } from "../../lib/audio.js";
import { send, subscribePerformanceResults, subscribeQueueResults } from "../../lib/store.js";

/** One line the character speaks in the scene, as the dialog lists it (SPEC-044 R-16). */
export interface SpokenLine { id: string; shotId: string; blockId?: string; number: number; text: string }

/** `sha256:<hex>` of the text as authored — the hash a read's target carries. */
export async function textHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const captureErrors: Record<string, string> = {
  NotAllowedError: "Microphone permission was denied.", NotFoundError: "No microphone is connected.",
  NotReadableError: "The microphone is busy or cannot be read.", OverconstrainedError: "This microphone cannot meet the capture settings.",
};

function LineChoice({ lines, value, onChange, disabled }: { lines: SpokenLine[]; value: string; onChange: (id: string) => void; disabled: boolean }) {
  if (lines.length < 2) return null;
  return (
    <label className="fy-linedoor__line">
      <span>Line</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {lines.map((line) => <option key={line.id} value={line.id}>shot {line.number} · {line.text}</option>)}
      </select>
    </label>
  );
}

/**
 * Record a line (SPEC-044 R-14): the capture flow the performance panel carried, as a sheet over
 * the dialog. Explicit capture actions; silence never stops or submits a performance. What a
 * dispatch needs said about the audio — who performed it, one speaker, no music, whether it may
 * be sent to a cloud model — is asked here, once, and Keep selects (R-15).
 */
export function RecordLineSheet({ world, production, scene, sheet, lines, onClose }: {
  world: WorldBundle; production: ProductionBundle; scene: SceneRecord; sheet: Sheet; lines: SpokenLine[]; onClose: () => void;
}) {
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const line = lines.find((candidate) => candidate.id === lineId);
  const [phase, setPhase] = useState<"idle" | "permission" | "recording" | "stopping" | "captured" | "staging" | "kept" | "error">("idle");
  const [notice, setNotice] = useState("");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [basis, setBasis] = useState<"" | "self" | "authorized" | "licensed">("");
  const [oneSpeaker, setOneSpeaker] = useState(false);
  const [noMusic, setNoMusic] = useState(false);
  const [cloud, setCloud] = useState(false);
  const stream = useRef<MediaStream | null>(null), recorder = useRef<MediaRecorder | null>(null);
  const captureGeneration = useRef(0), preview = useRef<string | null>(null), pending = useRef<string | null>(null);
  const bridge = globalThis.window?.arke;
  const stopTracks = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  const clearPreview = () => {
    if (preview.current) { if (playbackSnapshot().clip?.url === preview.current) dismissPlayback(); URL.revokeObjectURL(preview.current); preview.current = null; }
  };
  const discard = () => { captureGeneration.current++; if (recorder.current?.state === "recording") recorder.current.stop(); stopTracks(); clearPreview(); setBlob(null); setPhase("idle"); setNotice(""); };
  useEffect(() => () => { captureGeneration.current++; if (recorder.current?.state === "recording") recorder.current.stop(); stopTracks(); clearPreview(); }, []);
  useEffect(() => subscribePerformanceResults((result) => {
    if (result.requestId !== pending.current) return;
    pending.current = null;
    if (result.status === "kept" && result.reason === undefined) { onClose(); return; }
    setPhase(result.status === "kept" ? "kept" : "captured");
    setNotice(result.reason ?? "The recording could not be kept.");
  }), [onClose]);
  const start = async () => {
    const generation = ++captureGeneration.current;
    clearPreview(); setBlob(null); setNotice(""); setPhase("permission");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Microphone recording is unavailable in this environment.");
      const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (generation !== captureGeneration.current) { media.getTracks().forEach((t) => t.stop()); return; }
      stream.current = media;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("This browser has no supported audio recorder format.");
      const recording = new MediaRecorder(media, { mimeType }); recorder.current = recording;
      const chunks: Blob[] = []; let failed = false, capturedBytes = 0;
      const fail = (reason: string) => { if (generation !== captureGeneration.current || failed) return; failed = true; setNotice(reason); setPhase("error"); if (recording.state === "recording") recording.stop(); };
      recording.ondataavailable = (event) => { capturedBytes += event.data.size; if (capturedBytes > 128 * 1024 * 1024) { fail("Recording exceeds the 128 MiB capture limit."); return; } if (event.data.size) chunks.push(event.data); };
      recording.addEventListener("error", () => fail("The audio recorder failed. Capture a fresh performance."));
      media.getTracks().forEach((track) => { track.addEventListener("ended", () => { if (recording.state === "recording") fail("The microphone disconnected during recording."); }); });
      recording.onstop = () => {
        media.getTracks().forEach((t) => t.stop()); if (stream.current === media) stream.current = null;
        if (failed || generation !== captureGeneration.current) return;
        const captured = new Blob(chunks, { type: recording.mimeType });
        if (!captured.size) { setPhase("error"); setNotice("The recording contains no audio bytes."); return; }
        setBlob(captured); setPhase("captured"); setNotice("");
      };
      recording.start(500); setPhase("recording");
    } catch (error) {
      if (generation !== captureGeneration.current) return;
      stopTracks();
      setPhase("error"); const failure = error as Error;
      setNotice(captureErrors[failure.name] ?? failure.message);
    }
  };
  const busy = ["permission", "recording", "stopping", "staging"].includes(phase);
  const keep = async () => {
    if (!blob || !basis || !line || !bridge?.stagePerformanceAudio) return;
    setPhase("staging");
    const generation = captureGeneration.current;
    try {
      const staged = await bridge.stagePerformanceAudio({ name: "performance", contentType: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
      if (generation !== captureGeneration.current) { if (staged.ok) await bridge.discardPerformanceAudio?.(staged.spoolId); return; }
      if (!staged.ok) { setPhase("captured"); setNotice(staged.reason); return; }
      const requestId = ulid(); pending.current = requestId;
      const attestations = [...(oneSpeaker ? ["single-speaker" as const] : []), ...(noMusic ? ["no-music" as const] : [])];
      if (!send({ kind: "keep-performance-recording", worldId: world.meta.worldId, productionId: production.meta.id,
        sceneId: scene.id, shotId: line.shotId, ...(line.blockId ? { blockId: line.blockId } : {}), expectedSceneVersion: scene.version,
        requestId, spoolId: staged.spoolId, captureBasis: basis, select: true,
        ...(attestations.length ? { attestations } : {}), ...(cloud ? { cloudBasis: basis } : {}) })) {
        await bridge.discardPerformanceAudio?.(staged.spoolId); pending.current = null; setPhase("captured"); setNotice("The studio disconnected. Your local preview remains available.");
      }
    } catch { if (generation === captureGeneration.current) { setPhase("captured"); setNotice("The desktop could not stage this recording. Your preview remains available for retry."); } }
  };
  return (
    <div className="fy-linedoor" role="dialog" aria-label="Record a line">
      <div className="fy-linedoor__head"><span>Record a line</span><button type="button" className="fy-linedoor__close" aria-label="Close" onClick={onClose}>×</button></div>
      <LineChoice lines={lines} value={lineId} disabled={busy || blob !== null} onChange={(id) => { discard(); setLineId(id); }} />
      {line ? <blockquote className="fy-linedoor__text">{line.text}</blockquote> : <p className="fy-linedoor__note">no line to read</p>}
      <div className="fy-linedoor__actions">
        <Button size="sm" disabled={busy || !line || blob !== null} onClick={() => { void start(); }}>Start</Button>
        <Button size="sm" disabled={phase !== "recording"} onClick={() => { setPhase("stopping"); recorder.current?.stop(); }}>Stop</Button>
        {blob && <Button size="sm" variant="ghost" onClick={() => { if (!preview.current) preview.current = URL.createObjectURL(blob); void playClip({ id: `capture/${line?.shotId ?? ""}`, url: preview.current, title: `${sheet.name} · take` }); }}>Play</Button>}
        {blob && <Button size="sm" variant="ghost" disabled={phase === "staging"} onClick={discard}>Discard</Button>}
      </div>
      <p role="status" aria-live="polite" className="fy-linedoor__note">
        {phase === "recording" ? "recording · press Stop when finished" : phase === "permission" ? "asking for the microphone" : phase === "staging" ? "keeping" : notice}
      </p>
      {blob && phase !== "kept" && (
        <div className="fy-linedoor__keep">
          <label>Who performed it
            <select value={basis} disabled={busy} onChange={(event) => setBasis(event.target.value as typeof basis)}>
              <option value="">choose</option>
              <option value="self">I did</option>
              <option value="authorized">the performer authorized this capture</option>
              <option value="licensed">it is licensed for this use</option>
            </select>
          </label>
          <label><input type="checkbox" checked={oneSpeaker} disabled={busy} onChange={(event) => setOneSpeaker(event.target.checked)} /> one speaker</label>
          <label><input type="checkbox" checked={noMusic} disabled={busy} onChange={(event) => setNoMusic(event.target.checked)} /> no music</label>
          <label><input type="checkbox" checked={cloud} disabled={busy} onChange={(event) => setCloud(event.target.checked)} /> may be sent to cloud models</label>
          <Button size="sm" variant="primary" disabled={busy || !basis || !bridge?.stagePerformanceAudio} onClick={() => { void keep(); }}>Keep</Button>
          {!bridge?.stagePerformanceAudio && <p className="fy-linedoor__note">Keeping a line needs the desktop app.</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Generate a line (SPEC-044 R-14): the quote-and-confirm flow the generation panel carried,
 * without its cadence editor — cadence belongs to the Voice page (R-16). The line arrives
 * unreviewed and takes its place on the Voice row as `new`.
 */
export function GenerateLineSheet({ world, production, scene, sheet, model, lines, onClose }: {
  world: WorldBundle; production: ProductionBundle; scene: SceneRecord; sheet: Sheet; model: ManifestModel; lines: SpokenLine[]; onClose: () => void;
}) {
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const line = lines.find((candidate) => candidate.id === lineId);
  const [hash, setHash] = useState("");
  const [quote, setQuote] = useState<PerformanceGenerationQuote | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const pending = useRef<string | null>(null);
  const normalized = normalizeSpeechText(line?.text ?? "");
  useEffect(() => {
    let active = true;
    setHash(""); setQuote(null);
    if (normalized) void textHash(normalized).then((value) => { if (active) setHash(value); });
    return () => { active = false; };
  }, [normalized]);
  useEffect(() => subscribePerformanceResults((result) => {
    if (result.requestId !== pending.current) return;
    pending.current = null; setBusy(false);
    if (result.quote) setQuote(result.quote);
    setNotice(result.reason ?? "");
  }), []);
  useEffect(() => subscribeQueueResults((result) => {
    if (result.requestId !== pending.current) return;
    pending.current = null; setBusy(false);
    if (result.disposition === "accepted") { onClose(); return; }
    setQuote(null); setNotice(result.failures[0]?.reason ?? "Generation was not queued.");
  }), [onClose]);
  const plan: CadencePlan = { schemaVersion: 1, sourceTextHash: hash, delivery: "measured", speed: 1, cues: [] };
  return (
    <div className="fy-linedoor" role="dialog" aria-label="Generate a line">
      <div className="fy-linedoor__head"><span>Generate a line</span><button type="button" className="fy-linedoor__close" aria-label="Close" onClick={onClose}>×</button></div>
      <LineChoice lines={lines} value={lineId} disabled={busy} onChange={setLineId} />
      {line ? <blockquote className="fy-linedoor__text">{line.text}</blockquote> : <p className="fy-linedoor__note">no line to read</p>}
      <p className="fy-linedoor__note">{sheet.voice?.label ?? sheet.voice?.voiceId} · {model.displayName}</p>
      {quote === null ? (
        <div className="fy-linedoor__actions">
          <Button size="sm" disabled={busy || !line || !hash || !sheet.voice} onClick={() => {
            if (!line || !sheet.voice) return;
            pending.current = ulid(); setBusy(true);
            if (!send({ kind: "prepare-performance-generation", requestId: pending.current, worldId: world.meta.worldId, productionId: production.meta.id, sceneId: scene.id,
              shotId: line.shotId, ...(line.blockId ? { blockId: line.blockId } : {}), expectedSceneVersion: scene.version, expectedVoiceId: sheet.voice.voiceId, modelId: model.id, cadencePlan: plan })) {
              setBusy(false); setNotice("The studio is disconnected.");
            }
          }}>Quote</Button>
        </div>
      ) : (
        <div className="fy-linedoor__keep">
          <pre className="fy-linedoor__wording">{quote.mapping.providerText}</pre>
          <div className="fy-linedoor__actions">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => {
              pending.current = ulid(); setBusy(true);
              if (!send({ kind: "generate-performance", requestId: pending.current, worldId: world.meta.worldId, operationId: quote.operationId, confirmedMicroUsd: quote.estimatedMicroUsd })) { setBusy(false); setNotice("The studio is disconnected."); }
            }}>Generate · {formatMicroUsd(quote.estimatedMicroUsd)}</Button>
            {busy && <Button size="sm" variant="ghost" onClick={() => send({ kind: "cancel-performance-generation", worldId: world.meta.worldId, operationId: quote.operationId })}>Cancel</Button>}
          </div>
        </div>
      )}
      <p role="status" className="fy-linedoor__note">{notice}</p>
    </div>
  );
}
