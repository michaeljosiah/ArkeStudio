import { useState } from "react";
import { type PerformanceAudioRequest, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { playClip } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { Button } from "./ui.js";

export function PerformanceAudioPicker({ world, production, sceneId, value, onChange }: {
  world: WorldBundle; production: ProductionBundle; sceneId: string;
  value: PerformanceAudioRequest[]; onChange: (value: PerformanceAudioRequest[]) => void;
}) {
  const [id, setId] = useState("");
  const [intent, setIntent] = useState<PerformanceAudioRequest["intent"]>("voice-reference");
  const [basis, setBasis] = useState<"" | PerformanceAudioRequest["cloudBasis"]>("");
  const [single, setSingle] = useState(false), [noMusic, setNoMusic] = useState(false), [warningsAccepted, setWarningsAccepted] = useState(false);
  const records = production.performances.filter(p => p.target.sceneId === sceneId &&
    production.performanceReview.reviews.filter(r => r.performanceId === p.id).at(-1)?.decision === "accept");
  const performance = records.find(p => p.id === id);
  const warnings = performance ? Object.values(performance.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code) : [];
  return <details style={{ overflowWrap: "anywhere" }}><summary>Use accepted performances for this dispatch</summary>
    <p>Each choice replaces that character's assigned sample in the covered shot. The whole accepted clip is used.</p>
    <label>Accepted performance <select value={id} onChange={e => { setId(e.target.value); setSingle(false); setNoMusic(false); setWarningsAccepted(false); }}>
      <option value="">Choose a performance…</option>{records.map(p => <option key={p.id} value={p.id}>{p.target.speakerSheetId} · {p.id}</option>)}
    </select></label>
    {performance && <><p>{performance.provenance.outputTechnical.durationSec ?? "Unmeasured"} seconds · {performance.provenance.outputTechnical.sizeBytes} bytes · {performance.provenance.outputHash}</p>
      <Button onClick={() => { void playClip({ id: performance.id, title: "Accepted performance", url: mediaUrl(world.meta.slug,
        `productions/${production.meta.id}/performances/${performance.id}/${performance.file}`) }); }}>Hear full clip</Button>
      <label>Audio use <select value={intent} onChange={e => setIntent(e.target.value as typeof intent)}>
        <option value="voice-reference">voice-reference</option><option value="performance-sync">performance-sync</option></select></label>
      <p>{intent === "voice-reference" ? "Voice guidance for new scene words. Generated audio is embedded in the video; wording, timing and identity are not guaranteed."
        : "Visible motion follows the supplied performance as guidance. Generated audio is disabled. Keep this external performance as the final audio; synchronization is not guaranteed."}</p>
      <label><input type="checkbox" checked={single} onChange={e => setSingle(e.target.checked)} /> One speaker</label>{" "}
      <label><input type="checkbox" checked={noMusic} onChange={e => setNoMusic(e.target.checked)} /> No music</label>
      {warnings.length > 0 && <label><input type="checkbox" checked={warningsAccepted} onChange={e => setWarningsAccepted(e.target.checked)} /> I reviewed these QC warnings: {warnings.join(", ")}</label>}
      <label>Cloud reference permission <select value={basis} onChange={e => setBasis(e.target.value as typeof basis)}>
        <option value="">Choose authorization…</option><option value="self">My performance</option><option value="authorized">Performer authorized upload</option><option value="licensed">Licensed for upload</option></select></label>
      <Button disabled={!basis || !single || !noMusic || (warnings.length > 0 && !warningsAccepted) || value.some(r => r.performanceId === id)} onClick={() => {
        if (!basis) return;
        const review = production.performanceReview.reviews.filter(r => r.performanceId === id).at(-1)!;
        onChange([...value, { performanceId: id, hash: performance.provenance.outputHash, acceptedReviewAt: review.ts, intent,
          warningCodes: warnings, singleSpeaker: true, noMusic: true, cloudBasis: basis }]);
      }}>Use for this dispatch</Button></>}
    {value.map(request => <p key={request.performanceId}>{request.performanceId} · {request.intent} · {request.hash}{" "}
      <Button variant="ghost" onClick={() => onChange(value.filter(r => r !== request))}>Remove reference</Button></p>)}
  </details>;
}
