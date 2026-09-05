import { PerformanceTimingPanel } from "./performance-timing-panel.js";
import { PerformanceGenerationPanel } from "./performance-generation-panel.js";
import { useEffect, useRef, useState } from "react";
import { resolvePerformanceLine, performanceLineKey, orderedShots, estimateMicroUsd, formatMicroUsd, ulid, type PerformanceRecord, type VoiceAssignment, type WorldBundle, type ProductionBundle, type SceneRecord } from "@arke-studio/contracts";
import { playClip, dismissPlayback, playbackSnapshot } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { send, subscribePerformanceResults, subscribeQueueResults, convertPerformance, useStore } from "../lib/store.js";
import { Button } from "./ui.js";

const captureErrors: Record<string, string> = {
  NotAllowedError: "Microphone permission was denied.", NotFoundError: "No microphone is connected.",
  NotReadableError: "The microphone is busy or cannot be read.", OverconstrainedError: "This microphone cannot meet the capture settings.",
};

/** Design 115. Explicit capture actions; silence never stops or submits a performance. */
export function PerformancePanel({ world, production, scene, shotId }: {
  world: WorldBundle; production: ProductionBundle; scene: SceneRecord; shotId: string;
}) {
  const [blockId, setBlockId] = useState<string | undefined>();
  const line = resolvePerformanceLine(scene, shotId, blockId);
  const shot = orderedShots(scene).find(s => s.id === shotId);
  const blocks = scene.script?.blocks.filter(b => b.kind === "dialogue" && shot?.covers?.some(c => c.blockId === b.id)) ?? [];
  const sheet = line.ok ? world.sheets.find(s => s.id === line.speakerSheetId) : undefined;
  const [phase, setPhase] = useState<"idle" | "permission" | "recording" | "stopping" | "captured" | "staging" | "kept" | "error">("idle");
  const [notice, setNotice] = useState("");
  const [pins, setPins] = useState<Array<string | null>>([null, null]);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [basis, setBasis] = useState<"" | "self" | "authorized" | "licensed">("");
  const stream = useRef<MediaStream | null>(null), recorder = useRef<MediaRecorder | null>(null);
  const captureGeneration = useRef(0), preview = useRef<string | null>(null), pending = useRef<string | null>(null);
  const bridge = globalThis.window?.arke;
  const stopTracks = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; };
  const clearPreview = () => {
    if (preview.current) { if (playbackSnapshot().clip?.url === preview.current) dismissPlayback(); URL.revokeObjectURL(preview.current); preview.current = null; }
  };
  const discard = () => { captureGeneration.current++; if (recorder.current?.state === "recording") recorder.current.stop(); stopTracks(); clearPreview(); setBlob(null); setPhase("idle"); setNotice("Recording discarded."); };
  useEffect(() => () => { captureGeneration.current++; if (recorder.current?.state === "recording") recorder.current.stop(); stopTracks(); clearPreview(); }, []);
  useEffect(() => subscribePerformanceResults(result => {
    if (result.requestId !== pending.current) return;
    pending.current = null;
    setPhase(result.status === "kept" ? "kept" : "captured");
    setNotice(result.reason ?? "Performance kept locally. It has not been converted or selected.");
  }), []);
  const start = async () => {
    const generation = ++captureGeneration.current;
    clearPreview(); setBlob(null); setNotice(""); setPhase("permission");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Microphone recording is unavailable in this environment.");
      const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (generation !== captureGeneration.current) { media.getTracks().forEach(t => t.stop()); return; }
      stream.current = media;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("This browser has no supported audio recorder format.");
      const recording = new MediaRecorder(media, { mimeType }); recorder.current = recording;
      const chunks: Blob[] = []; let failed = false, capturedBytes = 0;
      const fail = (reason: string) => { if (generation !== captureGeneration.current || failed) return; failed = true; setNotice(reason); setPhase("error"); if (recording.state === "recording") recording.stop(); stopTracks(); };
      recording.ondataavailable = event => { capturedBytes += event.data.size; if (capturedBytes > 128 * 1024 * 1024) { fail("Recording exceeds the 128 MiB capture limit."); return; } if (event.data.size) chunks.push(event.data); };
      recording.addEventListener("error", () => fail("The audio recorder failed. Capture a fresh performance."));
      media.getTracks().forEach(track => { track.addEventListener("ended", () => { if (recording.state === "recording") fail("The microphone disconnected during recording."); }); });
      recording.onstop = () => {
        media.getTracks().forEach(t => t.stop()); if (stream.current === media) stream.current = null;
        if (failed || generation !== captureGeneration.current) return;
        const captured = new Blob(chunks, { type: recording.mimeType });
        if (!captured.size) { setPhase("error"); setNotice("The recording contains no audio bytes."); return; }
        setBlob(captured); setPhase("captured"); setNotice("Captured locally. Audition, then choose Keep or Discard.");
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
  const records = production.performances.filter(p => p.target.shotId === shotId && p.target.sceneId === scene.id && (!blockId || p.target.blockId === blockId));
  return <section aria-label="Recorded performance" style={{ padding: 16, borderTop: "1px solid var(--border)" }}>
    <h3>Recorded performance · shot {shot?.number}</h3>
    {blocks.length > 1 && <label>Authored line <select disabled={busy} value={blockId ?? ""} onChange={e => { discard(); setBlockId(e.target.value || undefined); }}>
      <option value="">Choose one dialogue block…</option>{blocks.map(b => <option key={b.id} value={b.id}>{b.speaker ?? "Unnamed speaker"}: {b.text}</option>)}</select></label>}
    {line.ok ? <><p>{sheet?.name ?? line.speakerSheetId} · {sheet?.voice ? `TTS assignment: ${sheet.voice.label ?? sheet.voice.voiceId}` : "No TTS assignment"}</p><blockquote>{line.text}</blockquote></> : <p>{line.reason}</p>}
    {line.ok && sheet && <PerformanceGenerationPanel key={`${scene.id}/${shotId}/${line.blockId ?? "legacy"}`} worldId={world.meta.worldId}
      production={production} scene={scene} shotId={shotId} blockId={line.blockId} text={line.text} sheet={sheet} />}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <Button disabled={busy || !line.ok} onClick={() => { void start(); }}>Start recording</Button>
      <Button disabled={phase !== "recording"} onClick={() => { setPhase("stopping"); recorder.current?.stop(); }}>Stop recording</Button>
      <Button variant="ghost" disabled={phase === "staging" || phase === "idle"} onClick={discard}>Discard</Button>
      {blob && <Button onClick={() => { if (!preview.current) preview.current = URL.createObjectURL(blob); void playClip({ id: `capture/${shotId}`, url: preview.current, title: `${sheet?.name ?? "Performance"} · scratch preview` }); }}>Hear capture</Button>}
    </div>
    <p role="status" aria-live="polite">{phase === "recording" ? "● RECORDING — microphone active. Press Stop when finished." : phase === "permission" ? "Requesting microphone permission…" : phase === "stopping" ? "Stopping microphone…" : notice}</p>
    {blob && phase !== "kept" && <><p>Keep makes this recording world content: it survives restart and is included in world exports until purged. Your authorization is provenance, not legal advice.</p><label>Permission to keep this recording <select value={basis} disabled={busy} onChange={e => setBasis(e.target.value as typeof basis)}>
      <option value="">Choose your authorization…</option><option value="self">I performed this recording</option><option value="authorized">The performer authorized this capture</option><option value="licensed">I am licensed to keep this recording</option></select></label>{" "}
      <Button disabled={busy || !basis || !bridge?.stagePerformanceAudio} onClick={async () => {
        if (!basis || !bridge?.stagePerformanceAudio) return;
        setPhase("staging");
        const generation = captureGeneration.current;
        try {
        const staged = await bridge.stagePerformanceAudio({ name: "performance", contentType: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
        if (generation !== captureGeneration.current) { if (staged.ok) await bridge.discardPerformanceAudio?.(staged.spoolId); return; }
        if (!staged.ok) { setPhase("captured"); setNotice(staged.reason); return; }
        const requestId = ulid(); pending.current = requestId;
        if (!send({ kind: "keep-performance-recording", worldId: world.meta.worldId, productionId: production.meta.id,
          sceneId: scene.id, shotId, ...(blockId ? { blockId } : {}), expectedSceneVersion: scene.version,
          requestId, spoolId: staged.spoolId, captureBasis: basis })) {
          await bridge.discardPerformanceAudio?.(staged.spoolId); pending.current = null; setPhase("captured"); setNotice("The studio disconnected. Your local preview remains available.");
        }
        } catch { if (generation === captureGeneration.current) { setPhase("captured"); setNotice("The desktop could not stage this recording. Your preview remains available for retry."); } }
      }}>Keep recording locally</Button></>}
    {!bridge?.stagePerformanceAudio && <p>Keeping a performance requires the desktop app. Browser capture supports local preview only.</p>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{pins.map((id, index) => {
      const pinned = records.find(r => r.id === id);
      return <Button key={index} disabled={!pinned} onClick={() => { if (pinned) void playClip({ id: pinned.id, url: mediaUrl(world.meta.slug, `productions/${production.meta.id}/performances/${pinned.id}/${pinned.file}`), title: `Performance ${index === 0 ? "A" : "B"}` }); }}>Hear {index === 0 ? "A" : "B"}</Button>;
    })}</div>
    {records.map(record => <div key={record.id} style={{ marginTop: 12 }}><Button onClick={() => { void playClip({ id: record.id,
      url: mediaUrl(world.meta.slug, `productions/${production.meta.id}/performances/${record.id}/${record.file}`), title: `${sheet?.name ?? "Performance"} · ${record.kind}` }); }}>Hear {record.kind}</Button>
      <p>{record.provenance.outputTechnical.durationSec?.toFixed(2)} seconds · {record.transcript?.status === "compared" ? `Transcript ${record.transcript.result}` : "Transcription unavailable"}</p>
      {record.kind === "generated-tts" && <details><summary>Frozen TTS performance</summary><blockquote>{record.authoredText}</blockquote><p>{record.voiceAssignment.label ?? record.voiceAssignment.voiceId} · {record.mapping.model} · {record.cadencePlan.delivery} · {formatMicroUsd(record.cost.estimatedMicroUsd)}</p></details>}
      {record.kind !== "scratch" && (record.voiceAssignment.voiceId !== sheet?.voice?.voiceId || record.voiceAssignment.provider !== sheet?.voice?.provider || record.voiceAssignment.assignedAtVersion !== sheet?.voice?.assignedAtVersion) && <p>Made with an earlier voice assignment. It remains playable; current selection is refused.</p>}
      {record.transcript?.status === "compared" && record.transcript.differences.map((d, i) => <p key={i}>{d.kind}: “{d.authored}” → “{d.observed}”</p>)}
      <p>{production.performanceReview.reviews.filter(r => r.performanceId === record.id).at(-1)?.decision ?? "Unreviewed"}{production.performanceReview.selections[performanceLineKey(record.target)]?.performanceId === record.id ? " · Selected for this line" : ""}{record.target.sceneVersion !== scene.version ? " · Earlier scene version" : ""}</p>
      {[0, 1].map(index => <Button key={index} variant="ghost" onClick={() => setPins(current => current.map((value, i) => i === index ? record.id : value))}>Pin {index === 0 ? "A" : "B"}</Button>)}
      {(["accept", "reject"] as const).map(decision => <Button key={decision} onClick={() => {
        pending.current = ulid();
        if (!send({ kind: "review-performance", requestId: pending.current, worldId: world.meta.worldId, productionId: production.meta.id,
          performanceId: record.id, decision, expectedReviewHash: production.performanceReview.reviewHash, expectedSelectionHash: production.performanceReview.selectionHash })) setNotice("The studio is disconnected.");
      }}>{decision === "accept" ? "Accept for this line" : "Reject"}</Button>)}
      <Button variant="ghost" onClick={() => { pending.current = ulid(); if (!send({ kind: "purge-performance", requestId: pending.current, worldId: world.meta.worldId, productionId: production.meta.id, performanceId: record.id })) setNotice("The studio is disconnected."); }}>Purge local recording</Button>
      {production.performanceReview.selections[performanceLineKey(record.target)]?.performanceId === record.id && <PerformanceTimingPanel key={record.id} world={world} production={production} performance={record} />}
      {record.kind === "scratch" && <PerformanceConversionControls record={record} voice={sheet?.voice} worldId={world.meta.worldId} />}
    </div>)}
  </section>;
}

function PerformanceConversionControls({ record, voice, worldId }: { record: PerformanceRecord; voice?: VoiceAssignment; worldId: string }) {
  const { state } = useStore();
  const model = state?.app.manifest?.models.find(m => m.id === "eleven_multilingual_sts_v2");
  const provider = state?.app.providers.find(p => p.id === "elevenlabs");
  const probe = provider?.probes.find(p => p.capability === "voice-conversion");
  const [basis, setBasis] = useState<"" | "self" | "authorized" | "licensed">("");
  const [wording, setWording] = useState(false), [speaker, setSpeaker] = useState(false), [warningsAccepted, setWarningsAccepted] = useState(false);
  const [retention, setRetention] = useState<"provider-history" | "zero-retention">("provider-history");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const pending = useRef<string | null>(null);
  const seconds = record.provenance.outputTechnical.durationSec;
  const warnings = Object.values(record.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code);
  const estimate = model && seconds ? estimateMicroUsd(model, { durationSec: seconds }) : null;
  const unavailable = voice?.provider !== "elevenlabs" ? "Conversion needs this character's accepted ElevenLabs TTS voice. Local conversion is unavailable." :
    !model || !provider?.configured || provider.validation !== "valid" || !probe?.available ? probe?.reason ?? "Validate ElevenLabs conversion access in Settings." :
    !seconds || seconds > 300 ? "The measured recording must be at most five minutes." : null;
  useEffect(() => subscribeQueueResults(result => {
    if (result.requestId !== pending.current) return;
    pending.current = null; setBusy(false);
    setNotice(result.disposition === "accepted" ? "Conversion queued. The scratch remains available; review the returned performance separately." : result.failures[0]?.reason ?? "Conversion was not queued.");
  }), []);
  const jobs = state?.app.jobs.filter(job => job.worldId === worldId && job.target.kind === "performance-conversion" &&
    (job.params.performanceConversion as { sourcePerformanceId?: string } | undefined)?.sourcePerformanceId === record.id) ?? [];
  return <details><summary>Convert to the character's voice</summary>
    {unavailable && <p>{unavailable}</p>}
    <p>ElevenLabs · {voice?.label ?? voice?.voiceId ?? "no assigned voice"} · {seconds?.toFixed(2)} seconds · {estimate === null ? "price unavailable" : formatMicroUsd(estimate)}. Voice Changer aims to preserve the performance's timing and delivery; audition the result.</p>
    <label><input type="checkbox" checked={wording} onChange={e => setWording(e.target.checked)} /> I reviewed the source wording against the authored line, including any mismatch or unavailable transcript.</label><br />
    <label><input type="checkbox" checked={speaker} onChange={e => setSpeaker(e.target.checked)} /> This recording contains one speaker.</label><br />
    {warnings.length > 0 && <><label><input type="checkbox" checked={warningsAccepted} onChange={e => setWarningsAccepted(e.target.checked)} /> I reviewed these QC warnings: {warnings.join(", ")}</label><br /></>}
    <label>Permission to upload for voice conversion <select value={basis} onChange={e => setBasis(e.target.value as typeof basis)}>
      <option value="">Choose authorization…</option><option value="self">I performed and authorize this conversion</option><option value="authorized">The performer authorized this conversion</option><option value="licensed">My license permits this conversion</option></select></label><br />
    <label>Provider retention <select value={retention} onChange={e => setRetention(e.target.value as typeof retention)}>
      <option value="provider-history">Provider history enabled</option>{probe?.zeroRetention === true && <option value="zero-retention">Zero retention · verified enterprise account</option>}</select></label>
    <p>The exact prepared recording and target voice ID are uploaded to ElevenLabs. Local Keep alone does not authorize this upload.</p>
    <Button disabled={busy || unavailable !== null || !basis || !wording || !speaker || (warnings.length > 0 && !warningsAccepted)} onClick={() => {
      if (!basis || !voice || estimate === null) return;
      setBusy(true); pending.current = convertPerformance({ worldId, productionId: record.target.productionId, performanceId: record.id,
        expectedHash: record.provenance.outputHash, expectedVoiceId: voice.voiceId, modelId: "eleven_multilingual_sts_v2", retention: probe?.zeroRetention === true ? retention : "provider-history",
        confirmedMicroUsd: estimate, cloudBasis: basis, warningCodes: warnings, singleSpeaker: speaker, wordingConfirmed: wording });
      if (!pending.current) { setBusy(false); setNotice("The studio is disconnected."); }
    }}>Convert performance · {estimate === null ? "unavailable" : formatMicroUsd(estimate)}</Button>
    <p role="status">{notice}</p>
    {jobs.map(job => <p key={job.id}>{job.status}{job.error ? ` · ${job.error}` : ""}{["queued", "submitting", "running"].includes(job.status) && <Button variant="ghost" onClick={() => send({ kind: "cancel-job", jobId: job.id })}>Cancel conversion</Button>}</p>)}
  </details>;
}
