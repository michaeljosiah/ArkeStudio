import { useNavigate } from "react-router";
import { pictureJoins, sameTransitionPair, transitionDelta, transitionVersionRef, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { useTransitionReview } from "../lib/editor-transition-review.js";
import { useEffectReviewFreshness } from "../screens/editor-effect-review-freshness.js";

export function TransitionProposalCard({ world, production, familyId, versionId }: { world: WorldBundle; production: ProductionBundle; familyId: string; versionId: string }) {
  const review = useTransitionReview(world.meta.worldId, production), navigate = useNavigate();
  const family = production.transitionFamilies?.find(value => value.id === familyId), version = family?.versions.find(value => value.id === versionId);
  const freshness = useEffectReviewFreshness(production, world.artifacts, production.timeline?.status === "ready" ? production.timeline.timeline : null, family?.status === "pending" ? version : undefined);
  if (!family || !version) return null;
  const ref = transitionVersionRef(family.id, version), current = production.timeline?.status === "ready" ? production.timeline.timeline : null;
  const delta = transitionDelta(version.before, version.transitions), joins = current ? pictureJoins(current.tracks, () => true) : [];
  const label = (pair: NonNullable<(typeof delta)[number]["after"]>) => { const join = joins.find(join => sameTransitionPair(join, pair)); return join ? `${join.left.source.label} → ${join.right.source.label}` : `${pair.leftClipId} → ${pair.rightClipId}`; };
  const duration = (value: (typeof delta)[number]["after"]) => value ? `${(value.durationFrames / (current?.frameRate ?? 24)).toFixed(2)}s` : "Cut";
  const stale = !current || current.revision !== version.baseRevision || !!freshness.staleReason, active = review.active?.version.id === version.id, pending = family.status === "pending";
  const canEdit = active && review.active?.comparison === "suggested" && !stale;
  const enter = () => { review.operate({ kind: "review", ref }); navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/cut`); };
  return <div className="xf-proposal">
    <p>{version.summary}</p><div className="xf-row"><b>{delta.length} changes</b><span>{family.status === "applied" ? family.receipt?.undoneAt ? "Undone" : "Applied" : family.status === "discarded" ? "Discarded" : active ? "Reviewing" : "Ready"}</span></div>
    <p className="xf-meta">Fixed cuts · sound and total duration unchanged</p>
    {version.sticky.length > 0 && <p className="xf-note">Adjusted by you · retained in revisions</p>}
    {version.conflicts.map((reason, index) => <p key={index} role="alert">{reason}</p>)}
    {stale && pending && <p role="status">{freshness.staleReason ?? "A picture cut changed. Update and review again."}</p>}
    <details><summary>{delta.length} changes · Show details</summary>{delta.map(change => <div key={change.key} className="xf-join-result"><span><b>{label((change.after ?? change.before)!)}</b><small>{duration(change.before)} → {duration(change.after)}</small>
      {canEdit && <><button type="button" onClick={() => review.inspect((change.after ?? change.before)!)}>Inspect transition</button><button type="button" disabled={!!review.pending}
        onClick={() => { const value = (change.after ?? change.before)!; review.operate({ kind: "keep", ref, pair: { trackId: value.trackId, leftClipId: value.leftClipId, rightClipId: value.rightClipId } }); }}>Keep Current here</button></>}</span></div>)}
      {version.notes.map((note, index) => <p className="xf-meta" key={index}>{note}</p>)}</details>
    {pending && <div className="xf-proposal-actions">{stale ? <button type="button" disabled={!!review.pending} onClick={() => review.operate({ kind: "update", ref })}>Update proposal</button>
      : !active && <button type="button" className="xf-primary" disabled={!review.connected || freshness.checking || !!review.pending || !!version.conflicts.length} onClick={enter}>Review in timeline</button>}
      <button type="button" disabled={!!review.pending} onClick={() => review.operate({ kind: "discard", ref })}>Discard proposal</button></div>}
    {review.pending && <p role="status">Preparing and checking this version…</p>}
    {review.error && <p role="status">{review.error}</p>}
  </div>;
}
