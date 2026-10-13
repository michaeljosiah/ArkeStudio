import { pictureAppearanceDelta, type ProductionBundle } from "@arke-studio/contracts";
import { usePictureReview } from "../lib/editor-picture-review.js";
export function PictureReviewBar({ worldId, production, onBack }: { worldId: string; production: ProductionBundle; onBack: () => void }) {
  const review = usePictureReview(worldId, production), active = review.active;
  if (!active) return null;
  const head = active.family.versions.find(value => value.id === active.family.headVersionId);
  const decisionsChanged = head && JSON.stringify(head.sticky) !== JSON.stringify(active.version.sticky);
  const reason = review.stale ?? (decisionsChanged ? "Your decisions changed. Review the latest version." : active.version.conflicts[0]) ??
    active.version.dependencies.issues[0]?.reason ?? review.error;
  return <div className="xf-review-bar" role="region" aria-label="Review picture appearance"><div className="xf-row"><b>Picture appearance · Version {active.version.number}</b>
    <div className="xf-row" role="group" aria-label="Compare picture appearance"><button type="button" aria-pressed={active.comparison === "current"} onClick={() => review.compare("current")}>Current</button>
      <button type="button" aria-pressed={active.comparison === "suggested"} onClick={() => review.compare("suggested")}>Suggested</button></div>
    <button type="button" onClick={onBack}>Back to proposal</button><button type="button" onClick={review.close}>Close review</button></div>
    <div className="xf-row"><span>{pictureAppearanceDelta(active.version.before, active.version.pictures).length} changes · Clip timing unchanged</span>
      <button type="button" disabled={!!review.pending || !active.family.undo.length} onClick={() => review.operate({ kind: "history", ref: active.ref, direction: "undo" })}>Undo adjustment</button>
      <button type="button" disabled={!!review.pending || !active.family.redo.length} onClick={() => review.operate({ kind: "history", ref: active.ref, direction: "redo" })}>Redo</button>
      {review.stale ? <button type="button" disabled={!!review.pending} onClick={() => review.operate({ kind: "update", ref: active.ref })}>Update proposal</button> :
      <button type="button" className="xf-primary" disabled={!review.connected || review.checking || !!review.pending || !!reason || !pictureAppearanceDelta(active.version.before, active.version.pictures).length || active.comparison !== "suggested"}
        onClick={() => { if (!review.checking && review.connected) review.operate({ kind: "apply", ref: active.ref, reviewId: active.reviewId }); }}>Apply reviewed version</button>}</div>
    {review.pending && <p role="status">Preparing and checking this version…</p>}
    {head && head.id !== active.version.id && <p>A new version is ready. <button type="button" onClick={onBack}>Review it in Arke</button></p>}{reason && <p role="status">{reason}</p>}
  </div>;
}
