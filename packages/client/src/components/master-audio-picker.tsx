import { useEffect, useRef, useState } from "react";
import { AUDIO_TRACK_KINDS, basePictureTrack, masterAudioBinding, orderedShots, storyTimelineFingerprint, ulid, type MasterAudioReview,
  type ProductionBundle, type WorldBundle, type TimelineClipId } from "@arke-studio/contracts";
import { type MasterAudioChoice } from "../lib/scene-plan.js";
import { send, subscribePerformanceResults, subscribeTimelineRefusals } from "../lib/store.js";
import { playClip } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { Button } from "./ui.js";

export function MasterAudioPicker({ world, production, sceneId, value, onChange }: {
  world: WorldBundle; production: ProductionBundle; sceneId: string; value: MasterAudioChoice[]; onChange: (value: MasterAudioChoice[]) => void;
}) {
  const [review, setReview] = useState<MasterAudioReview | null>(null), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [warningsAccepted, setWarningsAccepted] = useState(false);
  const [basis, setBasis] = useState<"" | MasterAudioChoice["cloudBasis"]>("");
  const pending = useRef<string | null>(null);
  useEffect(() => subscribePerformanceResults(result => {
    if (result.requestId !== pending.current) return;
    pending.current = null; setBusy(false); setReview(result.masterAudioReference ?? null); setWarningsAccepted(false); setBasis("");
    setNotice(result.reason ?? "Exact master slice prepared. Audition and review before use.");
  }), []);
  useEffect(() => subscribeTimelineRefusals(event => { if (event.productionId === production.meta.id) setNotice(event.reason); }), [production.meta.id]);
  const state = production.timeline;
  if (state?.status !== "ready") return <p>Save a timeline with an audio clip to use master playback.</p>;
  const timeline = state.timeline;
  const scene = production.scenes.find(s => s.id === sceneId);
  const shots = new Set(scene ? orderedShots(scene).map(s => s.id) : []);
  const pictures = (basePictureTrack(timeline)?.clips ?? []).filter(c => c.source.kind === "shot" && shots.has(c.source.shotId));
  const music = timeline.tracks.flatMap(t => AUDIO_TRACK_KINDS.has(t.kind) ? t.clips.filter(c => c.source.kind === "artifact") : []);
  const warnings = review ? Object.values(review.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code) : [];
  const stale = review && review.binding.timelineHash !== state.hash;
  return <details style={{ overflowWrap: "anywhere" }}><summary>Master playback for performance shots</summary>
    <p>Choose an audio clip already placed on the timeline. Its exact shot slice guides visible motion; generated audio is off. The external soundtrack stays final, and synchronization is not guaranteed.</p>
    {!music.length && <p>Place the soundtrack artifact on an audio track in the editor first.</p>}
    {pictures.map(clip => {
      if (clip.source.kind !== "shot") return null;
      const shotId = clip.source.shotId;
      let binding: ReturnType<typeof masterAudioBinding> | undefined, problem = "";
      if (clip.performanceSourceClipId) { try { binding = masterAudioBinding(production, shotId); } catch (error) { problem = (error as Error).message; } }
      return <div key={clip.id}><label>{clip.source.label} · performance soundtrack <select value={clip.performanceSourceClipId ?? ""} onChange={e => {
        pending.current = null; setBusy(false); setReview(null); onChange(value.filter(choice => choice.binding.shotId !== shotId));
        if (!send({ kind: "timeline-command", worldId: world.meta.worldId, productionId: production.meta.id, baseRevision: timeline.revision,
          sourceFingerprint: storyTimelineFingerprint(production), commands: [{ kind: "set-performance-source", clipId: clip.id,
            sourceClipId: e.target.value ? e.target.value as TimelineClipId : null }] })) setNotice("The studio disconnected. The playback binding was not changed.");
      }}><option value="">Off</option>{clip.performanceSourceClipId && !music.some(c => c.id === clip.performanceSourceClipId) && <option value={clip.performanceSourceClipId}>Missing soundtrack clip</option>}
        {music.map(c => <option key={c.id} value={c.id}>{c.source.label} · {c.id}</option>)}</select></label>
        {problem && <p role="alert">{problem}</p>}
        {binding && <><p>{binding.artifactId} · physical {binding.range.inSec.toFixed(3)}–{binding.range.outSec.toFixed(3)} seconds · timeline revision {binding.timelineRevision}</p>
          <Button disabled={busy} onClick={() => {
            const requestId = ulid(); pending.current = requestId; setBusy(true); setReview(null); setNotice("Preparing exact master slice…");
            if (!send({ kind: "prepare-master-audio-reference", worldId: world.meta.worldId, productionId: production.meta.id, requestId, binding: binding! })) {
              pending.current = null; setBusy(false); setNotice("The studio disconnected. Prepare again after reconnecting.");
            }
          }}>Prepare exact slice</Button></>}
      </div>;
    })}
    {(busy || review) && <Button variant="ghost" onClick={() => { pending.current = null; setBusy(false); setReview(null); setNotice("Slice review cancelled; late results will be ignored."); }}>Cancel slice review</Button>}
    {review && <><p>{review.provenance.outputTechnical.durationSec} seconds · {review.provenance.outputTechnical.sizeBytes} bytes · {review.provenance.outputHash}</p>
      <p>Source hash: {review.provenance.source.sourceMediaHash}</p>
      <Button onClick={() => { void playClip({ id: review.operationId, title: "Prepared master slice", url: mediaUrl(world.meta.slug, review.preparedFile) }); }}>Hear exact slice</Button>
      {stale && <p role="alert">The timeline changed. Prepare the current slice again.</p>}
      {warnings.length > 0 && <label><input type="checkbox" checked={warningsAccepted} onChange={e => setWarningsAccepted(e.target.checked)} /> I reviewed these QC warnings: {warnings.join(", ")}</label>}
      <label>Permission to upload this soundtrack <select value={basis} onChange={e => setBasis(e.target.value as typeof basis)}>
        <option value="">Choose authorization…</option><option value="self">My soundtrack</option><option value="authorized">Authorized by the rights holder</option><option value="licensed">Licensed for upload</option></select></label>
      <Button disabled={!basis || !!stale || (warnings.length > 0 && !warningsAccepted)} onClick={() => {
        if (!basis) return;
        onChange([...value.filter(choice => choice.binding.shotId !== review.binding.shotId), { operationId: review.operationId, hash: review.provenance.outputHash,
          binding: review.binding, warningCodes: warnings, cloudBasis: basis, preview: review }]);
      }}>Use master slice for this dispatch</Button></>}
    <p role="status">{notice}</p>
    {value.map(choice => <p key={choice.binding.shotId}>{choice.binding.shotId} · performance-sync · {choice.hash}{" "}<Button variant="ghost" onClick={() => onChange(value.filter(c => c !== choice))}>Remove prepared reference</Button></p>)}
  </details>;
}
