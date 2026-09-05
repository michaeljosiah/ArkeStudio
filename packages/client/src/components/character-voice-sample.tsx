import { useEffect, useRef, useState } from "react";
import { estimateMicroUsd, supportsCharacterSpeakingVideo, ulid, type ClientMessage, type Sheet, type VoiceSampleReview, type WorldBundle } from "@arke-studio/contracts";
import { generateCharacterVoiceSample, send, sendAttachFilesCorrelated, subscribeQueueResults,
  subscribeVoiceSampleResults, useStore } from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";
import { playClip } from "../lib/audio.js";
import { Button } from "./ui.js";

/** Design 114: sample audio and TTS assignment have separate authorities and separate actions. */
export function CharacterVoiceSamplePanel({ world, sheet }: { world: WorldBundle; sheet: Sheet }) {
  const { state } = useStore();
  const sample = world.referenceKits.find(k => k.sheetId === sheet.id)?.designatedVoiceSample;
  const models = state?.app.manifest?.models.filter(supportsCharacterSpeakingVideo) ?? [];
  const [modelId, setModelId] = useState(""), [script, setScript] = useState("");
  const [durationSec, setDurationSec] = useState(8), [sourceId, setSourceId] = useState("");
  const [trim, setTrim] = useState(false), [inSec, setInSec] = useState(0), [outSec, setOutSec] = useState(8);
  const [review, setReview] = useState<VoiceSampleReview | null>(null);
  const [singleSpeaker, setSingleSpeaker] = useState(false), [noMusic, setNoMusic] = useState(false);
  const [ackWarnings, setAckWarnings] = useState(false);
  const [rightsBasis, setRightsBasis] = useState<"self" | "authorized" | "licensed" | "">("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const recoveryKey = `voice-sample-review/${world.meta.worldId}/${sheet.id}`;
  const [recovery, setRecovery] = useState(() => { try { return localStorage.getItem(recoveryKey); } catch { return null; } });
  const retainReview = (operationId: string | null) => { setRecovery(operationId); try { if (operationId) localStorage.setItem(recoveryKey, operationId); else localStorage.removeItem(recoveryKey); } catch { /* Session review remains usable without browser storage. */ } };
  const pending = useRef<string | null>(null), generation = useRef<string | null>(null);
  const kit = world.referenceKits.find(k => k.sheetId === sheet.id);
  const photo = kit?.mainPhoto?.file ?? kit?.anchor;
  const selectedArtifact = sourceId.startsWith("artifact:") ? world.artifacts.find(a => a.id === sourceId.slice(9)) : undefined;
  const model = models.find(m => m.id === modelId) ?? models[0];
  const estimate = model ? estimateMicroUsd(model, { durationSec, resolution: model.limits.resolutions?.[0] ?? "720p" }) : 0;
  const artifacts = world.artifacts.filter(a => ["audio", "video"].includes(a.kind) && !world.artifacts.some(other => other.supersedes === a.id));
  const warnings = review ? Object.values(review.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code) : [];
  useEffect(() => subscribeVoiceSampleResults(result => {
    if (result.requestId !== pending.current || result.worldId !== world.meta.worldId || result.sheetId !== sheet.id) return;
    pending.current = null; setBusy(false);
    if (result.review) { retainReview(result.review.operationId); setReview(result.review); setSingleSpeaker(false); setNoMusic(false); setAckWarnings(false); }
    else if (result.status === "assigned" || result.status === "cleared") { setReview(null); retainReview(null); }
    setNotice(result.reason ?? ({ prepared: "Prepared locally. Audition and review before assigning.", assigned: "Character voice reference assigned.",
      cleared: "Voice reference cleared. Source media is retained.", withdrawn: "Cloud reuse withdrawn. Future uploads are blocked; submitted work is unchanged.", refused: "Unable to complete this action." }[result.status]));
  }), [world.meta.worldId, sheet.id]);
  useEffect(() => subscribeQueueResults(result => {
    if (result.requestId !== generation.current) return;
    generation.current = null; setBusy(false);
    setNotice(result.disposition === "accepted" ? "Speaking sample queued. Its completed video will appear in the source list; generation never assigns it automatically." : "Generation was not queued. Check Activity for the reason.");
  }), []);
  const act = (message: ClientMessage) => {
    pending.current = "requestId" in message ? String(message.requestId) : null;
    setBusy(true); setNotice("");
    if (!send(message)) { pending.current = null; setBusy(false); setNotice("The studio is disconnected. Nothing was changed."); }
  };
  const hear = (file: string, title: string, range?: { inSec: number; outSec: number }) => { void playClip({ ...(range ? { range } : {}), id: `${world.meta.worldId}/${file}`, url: mediaUrl(world.meta.slug, file), title }); };
  const validRange = Number.isFinite(inSec) && Number.isFinite(outSec) && inSec >= 0 && outSec > inSec;
  return <section aria-label="Character voice reference" style={{ borderBottom: "1px solid var(--border)", padding: "20px 0", marginBottom: 20 }}>
    <h2 style={{ fontSize: 18 }}>Character voice reference</h2>
    <p>{sample ? "One assigned clip guides this character’s voice in compatible scene models." : "Assign a clip once to reuse this character’s voice in compatible scene models."}</p>
    {sample && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Button onClick={() => hear(`references/${sheet.id}/${sample.file}`, `${sheet.name} · assigned voice sample`)}>Hear assigned clip</Button>
      <Button variant="ghost" disabled={busy} onClick={() => act({ kind: "clear-character-voice-sample", worldId: world.meta.worldId, sheetId: sheet.id,
        requestId: ulid(), expectedHash: "schemaVersion" in sample ? sample.provenance.outputHash : sample.file })}>Clear sample</Button>
      {"schemaVersion" in sample && sample.acknowledgementId && <Button variant="ghost" disabled={busy} onClick={() => act({ kind: "withdraw-character-voice-sample",
        worldId: world.meta.worldId, sheetId: sheet.id, requestId: ulid(), expectedHash: sample.provenance.outputHash })}>Withdraw cloud reuse</Button>}
      {!("schemaVersion" in sample) && <><p>Legacy sample: review its audio before cloud reuse.</p><Button disabled={busy} onClick={() => act({ kind: "prepare-character-voice-sample", requestId: ulid(), worldId: world.meta.worldId, sheetId: sheet.id, source: { kind: "legacy-character-sample", sheetId: sheet.id } })}>Revalidate legacy sample</Button></>}
    </div>}
    <details style={{ marginTop: 12 }}><summary>Generate speaking sample</summary>
      <label style={{ display: "block", marginTop: 12 }}>Reference script
        <textarea aria-label="Reference script" value={script} maxLength={2000} onChange={e => setScript(e.target.value)} style={{ display: "block", width: "100%", minHeight: 80 }} />
      </label>
      <p>The character speaks these words in a clean, isolated voice. Later scenes use their own dialogue.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <label>Model <select value={model?.id ?? ""} onChange={e => setModelId(e.target.value)}>{models.map(m => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select></label>
        <label>Duration <select value={durationSec} onChange={e => setDurationSec(Number(e.target.value))}>{[5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n} seconds</option>)}</select></label>
      </div>
      {photo && <img alt={`${sheet.name} · accepted character imagery`} src={mediaUrl(world.meta.slug, `references/${sheet.id}/${photo}`)} style={{ width: 100, maxHeight: 140, objectFit: "contain" }} />}
      {!photo && <p>Accept a character photo before generating a speaking video.</p>}
      {models.length === 0 && <p>No verified speech-video route is currently available.</p>}
      <p>Uses the accepted character photo. Creates a video candidate with speech; audition before assigning.</p>
      <Button disabled={busy || !model || !script.trim() || !world.referenceKits.some(k => k.sheetId === sheet.id && (k.mainPhoto || k.anchor))}
        onClick={() => { if (!model) return; setBusy(true); generation.current = generateCharacterVoiceSample({ worldId: world.meta.worldId,
          sheetId: sheet.id, modelId: model.id, script, durationSec, confirmedMicroUsd: estimate });
          if (!generation.current) { setBusy(false); setNotice("The studio is disconnected."); } }}>Generate speaking video · ${(estimate / 1_000_000).toFixed(2)}</Button>
    </details>
    <div style={{ marginTop: 16 }}>
      <label>Audio or video source <select aria-label="Voice sample source" style={{ maxWidth: "100%" }} value={sourceId} onChange={e => { setSourceId(e.target.value); setReview(null); }}>
        <option value="">Choose a source…</option>
        {artifacts.map(a => <option key={a.id} value={`artifact:${a.id}`}>{a.file}{a.generation ? " · generated" : ""}</option>)}
        {world.productions.flatMap(p => p.takes.filter(t => (t.kind === "voice" || t.kind === "clip") && (t.media || t.segment)).map(t => <option key={t.id} value={`take:${p.meta.id}:${t.id}`}>{p.meta.id} · {t.id}</option>))}
      </select></label>
      {selectedArtifact && <Button onClick={() => hear(`artifacts/${selectedArtifact.file}`, `${sheet.name} · selected source`)}>Hear source</Button>}
      {selectedArtifact?.kind === "video" && <video aria-label="Speaking video picture preview" controls muted src={mediaUrl(world.meta.slug, `artifacts/${selectedArtifact.file}`)} style={{ display: "block", width: "100%", maxHeight: 240 }} />}
      <Button variant="ghost" onClick={() => sendAttachFilesCorrelated(world.meta.worldId, [sheet.id])}>Import audio or video</Button>
      <label style={{ display: "block" }}><input type="checkbox" checked={trim} onChange={e => setTrim(e.target.checked)} /> Extract a range</label>
      {(trim || sourceId.startsWith("take:")) && <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label>Start seconds <input type="number" min={0} step={0.1} value={inSec} onChange={e => { setInSec(Number(e.target.value)); setReview(null); }} /></label>
        <label>End seconds <input type="number" min={0} step={0.1} value={outSec} onChange={e => { setOutSec(Number(e.target.value)); setReview(null); }} /></label>
      </div>}
      <Button disabled={busy || !sourceId || ((trim || sourceId.startsWith("take:")) && !validRange)} onClick={() => {
        const parts = sourceId.split(":");
        const source = parts[0] === "artifact" ? { kind: "artifact" as const, artifactId: parts[1]!, ...(trim ? { range: { inSec, outSec } } : {}) }
          : { kind: "production-take" as const, productionId: parts[1]!, takeId: parts[2]!, range: { inSec, outSec } };
        act({ kind: "prepare-character-voice-sample", requestId: ulid(), worldId: world.meta.worldId, sheetId: sheet.id, source });
      }}>{busy ? "Working…" : "Prepare audio locally"}</Button>
    </div>
    {recovery && !review && <Button disabled={busy} onClick={() => act({ kind: "resume-character-voice-sample", requestId: ulid(), worldId: world.meta.worldId, sheetId: sheet.id, operationId: recovery })}>Resume prepared review</Button>}
    {review && <div style={{ marginTop: 16 }}>
      <Button onClick={() => hear(review.sourceFile, `${sheet.name} · original source`, (() => { const settings = review.provenance.preparation[0]?.settings; return typeof settings?.inSec === "number" && typeof settings.outSec === "number" ? { inSec: settings.inSec, outSec: settings.outSec } : undefined; })())}>Hear source</Button>{" "}
      <Button onClick={() => hear(review.preparedFile, `${sheet.name} · prepared sample`)}>Hear prepared clip</Button>
      <p>{review.provenance.outputTechnical.durationSec?.toFixed(2)} seconds · mono 48 kHz PCM WAV</p>
      <p>Speaker/music detection and loudness analysis are unavailable. These confirmations are your review, not automated findings.</p>
      {warnings.length > 0 && <label style={{ display: "block" }}><input type="checkbox" checked={ackWarnings} onChange={e => setAckWarnings(e.target.checked)} /> I reviewed these warnings: {warnings.join(", ")}</label>}
      <label style={{ display: "block" }}><input type="checkbox" checked={singleSpeaker} onChange={e => setSingleSpeaker(e.target.checked)} /> This clip contains one speaker.</label>
      <label style={{ display: "block" }}><input type="checkbox" checked={noMusic} onChange={e => setNoMusic(e.target.checked)} /> This clip contains no music.</label>
      <label style={{ display: "block", margin: "12px 0" }}>Cloud reference reuse <select value={rightsBasis} onChange={e => setRightsBasis(e.target.value as typeof rightsBasis)}>
        <option value="">Local-only assignment</option><option value="self">I performed this audio and authorize reference upload</option>
        <option value="authorized">I have authorization to upload this audio as a reference</option><option value="licensed">My license permits uploading this audio as a reference</option>
      </select></label>
      <Button disabled={busy || !singleSpeaker || !noMusic || (warnings.length > 0 && !ackWarnings)} onClick={() => act({ kind: "accept-character-voice-sample",
        worldId: world.meta.worldId, sheetId: sheet.id, requestId: ulid(), operationId: review.operationId, warningCodes: warnings,
        singleSpeaker, noMusic, rightsBasis: rightsBasis || null })}>Use as character voice reference</Button>{" "}
      <Button variant="ghost" onClick={() => { setReview(null); retainReview(null); }}>Cancel review</Button>
    </div>}
    <p role="status" aria-live="polite">{notice}</p>
  </section>;
}
