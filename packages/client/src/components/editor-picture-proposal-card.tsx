import { useNavigate } from "react-router";
import { pictureAppearanceDelta, pictureVersionRef, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { usePictureReview } from "../lib/editor-picture-review.js";
import { useEffectReviewFreshness } from "../screens/editor-effect-review-freshness.js";

export function PictureProposalCard({ world, production, familyId, versionId }: { world: WorldBundle; production: ProductionBundle; familyId: string; versionId: string }) {
  const review = usePictureReview(world.meta.worldId, production), navigate = useNavigate();
  const family = production.pictureFamilies?.find(value => value.id === familyId), version = family?.versions.find(value => value.id === versionId);
  const current = production.timeline?.status === "ready" ? production.timeline.timeline : null;
  const freshness = useEffectReviewFreshness(production, world.artifacts, current, family?.status === "pending" ? version : undefined);
  if (!family || !version) return null;
  const ref = pictureVersionRef(family.id, version), delta = pictureAppearanceDelta(version.before, version.pictures);
  const stale = !current || current.revision !== version.baseRevision || !!freshness.staleReason, active = review.active?.version.id === version.id, pending = family.status === "pending";
  const canEdit = active && review.active?.comparison === "suggested" && !stale;
  const describe = (value: (typeof delta)[number]["after"]) => `${value?.visual?.blendMode ?? "normal"} · ${Math.round((value?.visual?.opacity ?? 1) * 100)}% opacity`;
  return <div className="xf-proposal">
    <p>{version.summary}</p><div className="xf-row"><b>{delta.length} changes</b><span>{family.status === "applied" ? family.receipt?.undoneAt ? "Undone" : "Applied" : family.status === "discarded" ? "Discarded" : active ? "Reviewing" : "Ready"}</span></div>
    <p className="xf-meta">Picture appearance · timing and sound unchanged</p>
    {version.sticky.length > 0 && <p className="xf-note">Adjusted by you · retained in revisions</p>}
    {version.origin === "release" && <p className="xf-note">Pending Release · review this version before Apply</p>}
    {version.conflicts.map((reason, index) => <p key={index} role="alert">{reason}</p>)}
    {stale && pending && <p role="status">{freshness.staleReason ?? "Current changed. Update and review again."}</p>}
    <details><summary>{delta.length} changes · Show details</summary>{delta.map(change => <div key={change.clipId} className="xf-join-result"><span>
      <b>{current?.tracks.flatMap(track => track.clips).find(clip => clip.id === change.clipId)?.source.label ?? change.clipId}</b><small>{describe(change.before)} → {describe(change.after)}</small>
      {JSON.stringify(change.before?.visual?.protection) !== JSON.stringify(change.after?.visual?.protection) && <small>Protection rules changed · review named rules in the Inspector</small>}
      {canEdit && <><button type="button" onClick={() => review.inspect(change.clipId)}>Inspect picture</button><button type="button" disabled={!!review.pending}
        onClick={() => review.operate({ kind: "keep", ref, clipId: change.clipId })}>Keep Current here</button></>}</span></div>)}
      {version.notes.map((note, index) => <p className="xf-meta" key={index}>{note}</p>)}</details>
    {pending && <div className="xf-proposal-actions">{stale ? <button type="button" disabled={!!review.pending} onClick={() => review.operate({ kind: "update", ref })}>Update proposal</button>
      : !active && <button type="button" className="xf-primary" disabled={!review.connected || freshness.checking || !!review.pending || !!version.conflicts.length}
        onClick={() => { review.operate({ kind: "review", ref }); navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/cut`); }}>Review in timeline</button>}
      <button type="button" disabled={!!review.pending} onClick={() => review.operate({ kind: "discard", ref })}>Discard proposal</button></div>}
    {review.pending && <p role="status">Preparing and checking this version…</p>}{review.error && <p role="status">{review.error}</p>}
  </div>;
}
