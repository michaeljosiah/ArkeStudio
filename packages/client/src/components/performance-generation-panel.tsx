import { useEffect, useRef, useState } from "react";
import { foldPerformanceBible, seedCadencePlan, mapCadence, normalizeSpeechText, formatMicroUsd, ulid, DELIVERIES, type CadencePlan, type PerformanceGenerationQuote,
  type WorldBundle, type SceneRecord, type Sheet, type ProductionBundle } from "@arke-studio/contracts";
import { useStore, send, subscribePerformanceResults, subscribeQueueResults } from "../lib/store.js";
import { Button } from "./ui.js";

export function PerformanceGenerationPanel({ world, worldId, production, scene, shotId, blockId, text, sheet }: {
  world?: WorldBundle; worldId: string; production: ProductionBundle; scene: SceneRecord; shotId: string; blockId?: string; text: string; sheet: Sheet;
}) {
  const { state } = useStore();
  const normalized = normalizeSpeechText(text);
  const models = state?.app.manifest?.models.filter(m => m.capability === "voice-tts" && m.provider === sheet.voice?.provider && m.cadence) ?? [];
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find(m => m.id === modelId) ?? models[0];
  const [hash, setHash] = useState("");
  const [delivery, setDelivery] = useState<CadencePlan["delivery"]>("measured"), [speed, setSpeed] = useState(1);
  const [cues, setCues] = useState<CadencePlan["cues"]>([]);
  const [quote, setQuote] = useState<PerformanceGenerationQuote | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const pending = useRef<string | null>(null), textArea = useRef<HTMLTextAreaElement | null>(null);
  const [span, setSpan] = useState({ from: 0, to: 0 });
  useEffect(() => {
    let active = true;
    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)).then(bytes => {
      if (active) setHash(`sha256:${Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("")}`);
    });
    return () => { active = false; };
  }, [normalized]);
  useEffect(() => { setQuote(null); }, [delivery, speed, cues, modelId, hash]);
  useEffect(() => subscribePerformanceResults(result => {
    if (result.requestId !== pending.current) return;
    pending.current = null; setBusy(false);
    if (result.quote) setQuote(result.quote);
    setNotice(result.reason ?? (result.status === "prepared" ? "Review the exact provider text and estimate before generating." : "Performance ready for review."));
  }), []);
  useEffect(() => subscribeQueueResults(result => {
    if (result.requestId !== pending.current) return;
    pending.current = null; setBusy(false); setQuote(null);
    setNotice(result.disposition === "accepted" ? "Performance queued. It will arrive unreviewed." : result.failures[0]?.reason ?? "Generation was not queued.");
  }), []);
  const plan: CadencePlan = { schemaVersion: 1, sourceTextHash: hash, delivery, speed, cues };
  let mapping: ReturnType<typeof mapCadence> | undefined, problem: string | undefined;
  try { if (hash && model) mapping = mapCadence(normalized, hash, plan, model); } catch (error) { problem = (error as Error).message; }
  const unsupported = mapping?.controls.filter(c => c.status === "unsupported") ?? [];
  const add = (cue: CadencePlan["cues"][number]) => setCues(current => [...current, cue].sort((a, b) =>
    (a.kind === "emphasis" ? a.span.from : a.at) - (b.kind === "emphasis" ? b.span.from : b.at)));
  const bible = world?.performanceBibles?.find(b => b.sheetId === sheet.id);
  const examples = bible && !bible.problem ? foldPerformanceBible(bible.events).flatMap(entry => {
    if (entry.action !== "designate" || entry.role === "identity") return [];
    const owner = world!.productions.find(p => p.meta.id === entry.productionId);
    const performance = owner?.performances.find(p => p.id === entry.performanceId && p.provenance.outputHash === entry.performanceHash);
    const review = owner?.performanceReview.reviews.filter(r => r.performanceId === entry.performanceId).at(-1);
    return performance && review?.decision === "accept" && review.ts === entry.acceptedReviewAt ? [{ entry, performance }] : [];
  }) : [];
  const jobs = state?.app.jobs.filter(j => j.worldId === worldId && j.target.kind === "performance-generation" &&
    (j.params.performanceGeneration as PerformanceGenerationQuote | undefined)?.target.shotId === shotId) ?? [];
  return <details><summary>Generate a TTS performance</summary>
    {!sheet.voice || !model ? <p>Assign a supported Kokoro or ElevenLabs voice to this character first.</p> : <>
      <fieldset disabled={busy}><legend>Cadence draft · {sheet.voice.label ?? sheet.voice.voiceId}</legend>
        <label>Model <select value={model.id} onChange={e => setModelId(e.target.value)}>{models.map(m => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select></label>{" "}
        <label>Delivery <select value={delivery} onChange={e => setDelivery(e.target.value as typeof delivery)}>{DELIVERIES.map(d => <option key={d}>{d}</option>)}</select></label>{" "}
        <label>Speed <input type="number" min={0.7} max={1.2} step={0.05} value={speed} onChange={e => setSpeed(Number(e.target.value))} /></label>
        {examples.length > 0 && <div aria-label="Performance bible cadence examples">{examples.map(({ entry, performance }) => <Button key={entry.slotId} disabled={!hash} onClick={() => {
          const source = performance.kind === "generated-tts" ? performance.cadencePlan : undefined;
          const seeded = seedCadencePlan(source, entry.delivery, hash);
          setDelivery(seeded.delivery); setSpeed(seeded.speed); setCues(seeded.cues); setQuote(null);
          setNotice(source?.sourceTextHash === hash ? "Cadence copied for the same wording. Review before generating." : "Delivery and speed copied. Place new cues for this line; old text offsets were not transferred.");
        }}>Use cadence from {entry.label}</Button>)}</div>}
        <p>Select text for emphasis, or place the caret where a pause or breath belongs.</p>
        <textarea ref={textArea} readOnly aria-label="Authored wording for cadence selection" value={normalized} style={{ width: "100%", minHeight: 80 }}
          onSelect={() => { const input = textArea.current; if (input) setSpan({ from: input.selectionStart, to: input.selectionEnd }); }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Button disabled={cues.length >= 40} onClick={() => add({ kind: "pause", at: span.from, length: "short" })}>Short pause</Button>
          <Button disabled={cues.length >= 40} onClick={() => add({ kind: "pause", at: span.from, length: "long" })}>Long pause</Button>
          <Button disabled={cues.length >= 40 || span.to <= span.from} onClick={() => add({ kind: "emphasis", span: { ...span, text: normalized.slice(span.from, span.to) }, level: "strong" })}>Emphasize selection</Button>
          <Button disabled={cues.length >= 40} onClick={() => add({ kind: "breath", at: span.from, action: "inhale" })}>Inhale</Button>
          <Button disabled={cues.length >= 40} onClick={() => add({ kind: "breath", at: span.from, action: "exhale" })}>Exhale</Button>
        </div>
        {cues.map((cue, index) => <p key={index}>{cue.kind} · position {cue.kind === "emphasis" ? `${cue.span.from}–${cue.span.to}` : cue.at}{" "}<Button variant="ghost" onClick={() => setCues(current => current.filter((_, i) => i !== index))}>Remove cue {index + 1}</Button></p>)}
        <label>Copy an existing cadence <select value="" onChange={e => { const record = production.performances.find(p => p.id === e.target.value);
          if (record?.kind === "generated-tts") { setDelivery(record.cadencePlan.delivery); setSpeed(record.cadencePlan.speed); setCues(record.cadencePlan.cues); } }}>
          <option value="">Choose explicitly…</option>{production.performances.filter(p => p.kind === "generated-tts" && p.target.shotId === shotId && p.target.blockId === blockId).map(p => <option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
      </fieldset>
      {problem && <p role="alert">{problem}</p>}
      {mapping && <><p>Provider wording · {mapping.providerText.length} characters</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{mapping.providerText}</pre>
        {mapping.controls.map((control, i) => <p key={i}>{control.control}{control.cueIndex === undefined ? "" : ` ${control.cueIndex + 1}`} · {control.status} · {control.reason ?? control.method}</p>)}</>}
      <p>Qualitative tags and emphasis are best-effort. No exact pause timing or word alignment is promised. Local generation is on device; cloud generation sends the provider wording and voice ID to ElevenLabs.</p>
      <Button disabled={busy || !mapping || Boolean(problem) || unsupported.length > 0} onClick={() => {
        pending.current = ulid(); setBusy(true); setQuote(null);
        if (!send({ kind: "prepare-performance-generation", requestId: pending.current, worldId, productionId: production.meta.id, sceneId: scene.id,
          shotId, ...(blockId ? { blockId } : {}), expectedSceneVersion: scene.version, expectedVoiceId: sheet.voice!.voiceId, modelId: model.id, cadencePlan: plan })) {
          setBusy(false); setNotice("The studio is disconnected.");
        }
      }}>Prepare exact estimate</Button>
      {quote && <div><p>{quote.voiceAssignment.label ?? quote.voiceAssignment.voiceId} · {quote.local ? "On-device Kokoro" : "ElevenLabs"} · {quote.mapping.providerText.length} characters · {formatMicroUsd(quote.estimatedMicroUsd)}</p>
        <pre style={{ whiteSpace: "pre-wrap" }}>{quote.mapping.providerText}</pre>
        <Button disabled={busy} onClick={() => { pending.current = ulid(); setBusy(true);
          if (!send({ kind: "generate-performance", requestId: pending.current, worldId, operationId: quote.operationId, confirmedMicroUsd: quote.estimatedMicroUsd })) { setBusy(false); setNotice("The studio is disconnected."); }
        }}>{quote.local ? "Generate locally" : "Confirm cloud generation"} · {formatMicroUsd(quote.estimatedMicroUsd)}</Button>
        {busy && <Button variant="ghost" onClick={() => send({ kind: "cancel-performance-generation", worldId, operationId: quote.operationId })}>Cancel generation</Button>}
      </div>}
    </>}
    <p role="status">{notice}</p>
    {jobs.map(job => <p key={job.id}>{job.status}{job.error ? ` · ${job.error}` : ""}{["queued", "submitting", "running"].includes(job.status) && <Button variant="ghost" onClick={() => send({ kind: "cancel-job", jobId: job.id })}>Cancel</Button>}</p>)}
  </details>;
}
