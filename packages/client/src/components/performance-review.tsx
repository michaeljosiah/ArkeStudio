import { useEffect, useRef, useState } from "react";
import { ulid, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { send, subscribePerformanceResults } from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";
import { playClip, playbackSnapshot } from "../lib/audio.js";
import { Button } from "./ui.js";

/** The native performance review, with the same review, selection and scene fences. */
export function PerformanceReviewControls({ world, production, performanceId }: {
  world: WorldBundle; production: ProductionBundle; performanceId: string;
}) {
  const performance = production.performances.find(value => value.id === performanceId);
  const scene = production.scenes.find(value => value.id === performance?.target.sceneId);
  const pending = useRef<string | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [heard, setHeard] = useState(false), [purging, setPurging] = useState(false);
  useEffect(() => subscribePerformanceResults(result => {
    if (result.requestId !== pending.current) return;
    pending.current = null; setBusy(false); setNotice(result.reason ?? result.status);
  }), []);
  if (!performance || !scene) return <p>This performance is unavailable.</p>;
  const common = { worldId: world.meta.worldId, productionId: production.meta.id, performanceId };
  const review = (decision: "accept" | "reject") => {
    const requestId = ulid(); pending.current = requestId; setBusy(true); setNotice("");
    if (!send({ kind: "review-performance", ...common, requestId, decision,
      expectedReviewHash: production.performanceReview.reviewHash, expectedSelectionHash: production.performanceReview.selectionHash,
      ...(decision === "accept" ? { select: true, expectedSceneVersion: scene.version } : {}) })) {
      pending.current = null; setBusy(false); setNotice("The studio is disconnected.");
    }
  };
  const purge = () => {
    const requestId = ulid(); pending.current = requestId; setBusy(true); setNotice("");
    if (!send({ kind: "purge-performance", ...common, requestId })) { pending.current = null; setBusy(false); setNotice("The studio is disconnected."); }
    setPurging(false);
  };
  const report = performance.provenance.qualityReport;
  const concerns = Object.values(report.checks).filter(check => ["warning", "hard-incompatibility", "unavailable"].includes(check.outcome));
  return <div className="fy-actioncard__commands">
    <p>{performance.kind === "generated-tts" ? performance.authoredText : "Recorded performance"}</p>
    <p>{performance.provenance.outputTechnical.durationSec === null ? "Unknown duration" : `${performance.provenance.outputTechnical.durationSec.toFixed(2)}s`} · Audio quality: {concerns.length ? concerns.map(check => `${check.code}: ${check.outcome}`).join(" · ") : "Measured"}</p>
    <div className="fy-actioncard__actions">
      <Button variant="ghost" disabled={busy} onClick={async () => {
        const id = `${world.meta.worldId}/${performance.id}/${performance.provenance.outputHash}`;
        await playClip({ id, url: mediaUrl(world.meta.slug, `productions/${production.meta.id}/performances/${performance.id}/${performance.file}`), title: "Generated performance" });
        setHeard(playbackSnapshot().clip?.id === id && playbackSnapshot().status === "playing");
      }}>Hear performance</Button>
      <Button variant="primary" disabled={busy || !heard} onClick={() => review("accept")}>Accept and choose</Button>
      <Button variant="ghost" disabled={busy} onClick={() => review("reject")}>Reject</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setPurging(true)}>Purge local media</Button>
    </div>
    {purging && <div role="group" aria-label="Confirm local performance purge"><p>Remove this local performance media? Provider history remains available.</p>
      <Button disabled={busy} onClick={purge}>Confirm purge</Button><Button variant="ghost" onClick={() => setPurging(false)}>Cancel</Button></div>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
