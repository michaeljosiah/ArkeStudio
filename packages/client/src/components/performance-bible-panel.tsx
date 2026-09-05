import { useEffect, useRef, useState } from "react";
import { foldPerformanceBible, recommendPerformanceBible, DELIVERIES, ulid, type WorldBundle, type Sheet } from "@arke-studio/contracts";
import { send, subscribeRehearsalResults } from "../lib/store.js";
import { playClip } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { Button } from "./ui.js";
export function PerformanceBiblePanel({ world, sheet }: { world: WorldBundle; sheet: Sheet }) {
  const bible = world.performanceBibles?.find(b => b.sheetId === sheet.id);
  let slots: ReturnType<typeof foldPerformanceBible> = [];
  try { slots = foldPerformanceBible(bible?.events ?? []); } catch { /* The scan problem remains visible. */ }
  const sources = world.productions.flatMap(production => production.performances.filter(p => p.target.speakerSheetId === sheet.id).map(performance => ({
    production, performance, review: production.performanceReview.reviews.filter(r => r.performanceId === performance.id).at(-1),
  }))).filter(source => source.review?.decision === "accept");
  const [sourceId, setSourceId] = useState(""), [slotId, setSlotId] = useState(""), [label, setLabel] = useState("");
  const [delivery, setDelivery] = useState<(typeof DELIVERIES)[number]>("measured");
  const [role, setRole] = useState<"cadence" | "identity" | "both">("cadence");
  const [basis, setBasis] = useState<"" | "self" | "authorized" | "licensed">("");
  const [single, setSingle] = useState(false), [noMusic, setNoMusic] = useState(false), [warningsAccepted, setWarningsAccepted] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const pending = useRef<string | null>(null);
  const source = sources.find(s => s.performance.id === sourceId);
  const warnings = source ? Object.values(source.performance.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code) : [];
  const previous = slots.find(s => s.slotId === slotId);
  const current = slots.filter(s => s.action === "designate");
  useEffect(() => subscribeRehearsalResults(result => { if (result.requestId !== pending.current) return; pending.current = null; setBusy(false); setNotice(result.reason); }), []);
  const eligible = current.filter(slot => {
    const candidate = sources.find(s => s.performance.id === slot.performanceId);
    return candidate && candidate.performance.provenance.outputHash === slot.performanceHash && (slot.role === "cadence" ||
      (candidate.performance.kind !== "scratch" && candidate.performance.voiceAssignment.voiceId === sheet.voice?.voiceId && candidate.performance.voiceAssignment.assignedAtVersion === sheet.voice?.assignedAtVersion));
  }).map(s => s.slotId);
  const recommendations = recommendPerformanceBible(bible?.events ?? [], delivery, eligible);
  return <details style={{ marginBlock: 16 }}><summary>Performance bible · {current.length} labelled examples</summary>
    <p>Approved delivery examples are separate from the TTS voice assignment, the designated video voice sample, and exact-line performance selections. They never replace authored dialogue.</p>
    {bible?.problem && <p role="alert">{bible.problem}</p>}
    {current.map(slot => { const candidate = sources.find(s => s.performance.id === slot.performanceId); return <div key={slot.slotId}>
      <p>{slot.label} · {slot.delivery} · {slot.role} · {eligible.includes(slot.slotId) ? "Source currently accepted; reference clearance is checked before use" : "Source unavailable, unaccepted or earlier identity"}</p>
      <Button disabled={!candidate} onClick={() => { if (candidate) void playClip({ id: candidate.performance.id, title: slot.label,
        url: mediaUrl(world.meta.slug, `productions/${slot.productionId}/performances/${slot.performanceId}/${candidate.performance.file}`) }); }}>Hear example</Button>
      <Button variant="ghost" onClick={() => { setSlotId(slot.slotId); setLabel(slot.label); setDelivery(slot.delivery); setRole(slot.role); }}>Replace this slot</Button>
      <Button variant="ghost" disabled={busy} onClick={() => { pending.current = ulid(); setBusy(true); if (!send({ kind: "clear-performance-bible", requestId: pending.current,
        worldId: world.meta.worldId, sheetId: sheet.id, slotId: slot.slotId, expectedHash: bible?.hash ?? null, expectedRevision: slot.revision })) { setBusy(false); setNotice("The studio is disconnected."); } }}>Clear slot</Button>
    </div>; })}
    <fieldset disabled={busy || Boolean(bible?.problem)}><legend>Designate an accepted performance</legend>
      <label>Slot ID <input value={slotId} onChange={e => setSlotId(e.target.value)} placeholder="warm-reassurance" /></label>{" "}
      <label>Label <input value={label} maxLength={80} onChange={e => setLabel(e.target.value)} /></label>{" "}
      <label>Delivery <select value={delivery} onChange={e => setDelivery(e.target.value as typeof delivery)}>{DELIVERIES.map(d => <option key={d}>{d}</option>)}</select></label>{" "}
      <label>Reference role <select value={role} onChange={e => setRole(e.target.value as typeof role)}><option value="cadence">Cadence</option><option value="identity">Identity</option><option value="both">Both</option></select></label>
      <label>Accepted source <select value={sourceId} onChange={e => { setSourceId(e.target.value); setSingle(false); setNoMusic(false); setWarningsAccepted(false); }}><option value="">Choose a performance…</option>{sources.map(s => <option key={s.performance.id} value={s.performance.id}>{s.production.meta.id} · {s.performance.kind} · {s.performance.id}</option>)}</select></label>
      {source?.performance.kind === "scratch" && role !== "cadence" && <p>A scratch recording can demonstrate cadence only.</p>}
      <label><input type="checkbox" checked={single} onChange={e => setSingle(e.target.checked)} /> One speaker</label>{" "}
      <label><input type="checkbox" checked={noMusic} onChange={e => setNoMusic(e.target.checked)} /> No music</label>
      {warnings.length > 0 && <label><input type="checkbox" checked={warningsAccepted} onChange={e => setWarningsAccepted(e.target.checked)} /> I reviewed QC warnings: {warnings.join(", ")}</label>}
      <label>Authorization for cloud reference reuse <select value={basis} onChange={e => setBasis(e.target.value as typeof basis)}><option value="">Choose authorization…</option><option value="self">I performed and authorize this use</option><option value="authorized">The performer authorized reference reuse</option><option value="licensed">My license permits reference reuse</option></select></label>
      <Button disabled={!source || !label.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slotId) || !basis || !single || !noMusic || (warnings.length > 0 && !warningsAccepted) || (source.performance.kind === "scratch" && role !== "cadence")} onClick={() => {
        if (!source?.review || !basis) return; pending.current = ulid(); setBusy(true);
        if (!send({ kind: "designate-performance-bible", requestId: pending.current, worldId: world.meta.worldId, sheetId: sheet.id, slotId, label: label.trim(), delivery, role,
          expectedHash: bible?.hash ?? null, expectedRevision: previous?.revision ?? 0, productionId: source.production.meta.id, performanceId: source.performance.id,
          expectedPerformanceHash: source.performance.provenance.outputHash, acceptedReviewAt: source.review.ts, cloudBasis: basis, warningCodes: warnings, singleSpeaker: single, noMusic })) { setBusy(false); setNotice("The studio is disconnected."); }
      }}>{previous ? "Replace slot" : "Designate example"}</Button>
    </fieldset>
    <p>Matching {delivery} examples: {recommendations.map(s => s.slotId).join(", ") || "None"}. Ties remain visible; no example is automatically selected. Current TTS models receive no bible audio reference.</p>
    <p role="status">{notice}</p>
  </details>;
}
