import { type PerformanceAudioChoice } from "../lib/scene-plan.js";
import { send, subscribePerformanceResults } from "../lib/store.js";
import { useEffect, useRef, useState } from "react";
import { ulid, type PreparedPerformanceAudioReview, type PerformanceAudioRequest, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { playClip } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { Button } from "./ui.js";

export function PerformanceAudioPicker({ world, production, sceneId, value, onChange }: {
  world: WorldBundle; production: ProductionBundle; sceneId: string;
  value: PerformanceAudioChoice[]; onChange: (value: PerformanceAudioChoice[]) => void;
}) {
  const [id, setId] = useState("");
  const [rangeIn, setRangeIn] = useState("0"), [rangeOut, setRangeOut] = useState("");
  const [prepared, setPrepared] = useState<PreparedPerformanceAudioReview | null>(null);
  const [notice, setNotice] = useState(""), [preparing, setPreparing] = useState(false);
  const pending = useRef<string | null>(null);
  useEffect(() => subscribePerformanceResults(result => {
    if (result.requestId !== pending.current) return;
    pending.current = null; setPreparing(false);
    setPrepared(result.audioReference ?? null); setNotice(result.reason ?? "Trim prepared. Audition and review its QC before use.");
    setSingle(false); setNoMusic(false); setWarningsAccepted(false);
  }), []);
  const invalidate = () => { pending.current = null; setPreparing(false); setPrepared(null); setWarningsAccepted(false); };
  const [intent, setIntent] = useState<PerformanceAudioRequest["intent"]>("voice-reference");
  const [basis, setBasis] = useState<"" | PerformanceAudioRequest["cloudBasis"]>("");
  const [single, setSingle] = useState(false), [noMusic, setNoMusic] = useState(false), [warningsAccepted, setWarningsAccepted] = useState(false);
  const records = production.performances.filter(p => p.target.sceneId === sceneId &&
    production.performanceReview.reviews.filter(r => r.performanceId === p.id).at(-1)?.decision === "accept");
  const performance = records.find(p => p.id === id);
  const asset = prepared ?? performance;
  const warnings = asset ? Object.values(asset.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code) : [];
  return <details style={{ overflowWrap: "anywhere" }}><summary>Use accepted performances for this dispatch</summary>
    <p>Each choice replaces that character's assigned sample in the covered shot. Use the whole accepted clip or explicitly prepare a trim.</p>
    <label>Accepted performance <select value={id} onChange={e => { setId(e.target.value); invalidate(); setNotice(""); setRangeIn("0"); setRangeOut(""); setSingle(false); setNoMusic(false); setWarningsAccepted(false); }}>
      <option value="">Choose a performance…</option>{records.map(p => <option key={p.id} value={p.id}>{p.target.speakerSheetId} · {p.id}</option>)}
    </select></label>
    {performance && <><p>{asset!.provenance.outputTechnical.durationSec ?? "Unmeasured"} seconds · {asset!.provenance.outputTechnical.sizeBytes} bytes · {asset!.provenance.outputHash}</p>
      <Button onClick={() => { void playClip({ id: performance.id, title: "Accepted performance", url: mediaUrl(world.meta.slug,
        `productions/${production.meta.id}/performances/${performance.id}/${performance.file}`) }); }}>Hear full clip</Button>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <label>Source in (seconds) <input type="number" min="0" step="0.001" value={rangeIn} onChange={e => { invalidate(); setRangeIn(e.target.value); }} /></label>
        <label>Source out (seconds) <input type="number" min="0" step="0.001" value={rangeOut} onChange={e => { invalidate(); setRangeOut(e.target.value); }} /></label>
        <Button disabled={preparing || !rangeOut || !Number.isFinite(Number(rangeIn)) || !Number.isFinite(Number(rangeOut)) || Number(rangeIn) < 0 || Number(rangeOut) <= Number(rangeIn)} onClick={() => {
          const requestId = ulid(); pending.current = requestId; setPreparing(true); setPrepared(null); setNotice("Preparing trim…");
          if (!send({ kind: "prepare-performance-audio-reference", worldId: world.meta.worldId, productionId: production.meta.id,
            requestId, performanceId: performance.id, expectedHash: performance.provenance.outputHash,
            range: { inSec: Number(rangeIn), outSec: Number(rangeOut) } })) { invalidate(); setNotice("The studio disconnected. Prepare again after reconnecting."); }
        }}>Prepare trim</Button>
        {(preparing || prepared) && <Button variant="ghost" onClick={() => { invalidate(); setRangeIn("0"); setRangeOut(""); setNotice("Trim review cancelled; late results will be ignored."); }}>Use full clip</Button>}
        {prepared && <Button onClick={() => { void playClip({ id: prepared.operationId, title: "Prepared performance trim", url: mediaUrl(world.meta.slug, prepared.preparedFile) }); }}>Hear prepared trim</Button>}
      </div><p role="status">{notice}</p>
      <label>Audio use <select value={intent} onChange={e => setIntent(e.target.value as typeof intent)}>
        <option value="voice-reference">voice-reference</option><option value="performance-sync">performance-sync</option></select></label>
      <p>{intent === "voice-reference" ? "Voice guidance for new scene words. Generated audio is embedded in the video; wording, timing and identity are not guaranteed."
        : "Visible motion follows the supplied performance as guidance. Generated audio is disabled. Keep this external performance as the final audio; synchronization is not guaranteed."}</p>
      <label><input type="checkbox" checked={single} onChange={e => setSingle(e.target.checked)} /> One speaker</label>{" "}
      <label><input type="checkbox" checked={noMusic} onChange={e => setNoMusic(e.target.checked)} /> No music</label>
      {warnings.length > 0 && <label><input type="checkbox" checked={warningsAccepted} onChange={e => setWarningsAccepted(e.target.checked)} /> I reviewed these QC warnings: {warnings.join(", ")}</label>}
      <label>Cloud reference permission <select value={basis} onChange={e => setBasis(e.target.value as typeof basis)}>
        <option value="">Choose authorization…</option><option value="self">My performance</option><option value="authorized">Performer authorized upload</option><option value="licensed">Licensed for upload</option></select></label>
      <Button disabled={preparing || (!!rangeOut && !prepared) || !basis || !single || !noMusic || (warnings.length > 0 && !warningsAccepted) || value.some(r => r.performanceId === id)} onClick={() => {
        if (!basis) return;
        const review = production.performanceReview.reviews.filter(r => r.performanceId === id).at(-1)!;
        onChange([...value, { ...(prepared ? { prepared: { operationId: prepared.operationId, hash: prepared.provenance.outputHash }, preview: prepared } : {}), performanceId: id, hash: performance.provenance.outputHash, acceptedReviewAt: review.ts, intent,
          warningCodes: warnings, singleSpeaker: true, noMusic: true, cloudBasis: basis }]);
      }}>Use for this dispatch</Button></>}
    {value.map(request => <p key={request.performanceId}>{request.performanceId} · {request.intent} · {request.hash}{" "}
      <Button variant="ghost" onClick={() => onChange(value.filter(r => r !== request))}>Remove reference</Button></p>)}
  </details>;
}
