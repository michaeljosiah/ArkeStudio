import { useEffect, useMemo, useState } from "react";
import { productionFrameRate, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { effectReviewBase } from "../lib/editor-effect-review-base.js";
import { effectCardRef, effectProposalCardId, sameEffectProposalVersion } from "../lib/editor-effect-proposal-presentation.js";
import { useEffectProposalReview } from "../screens/editor-effect-review.js";
import { useEffectReviewFreshness } from "../screens/editor-effect-review-freshness.js";
import { EffectProposalCard } from "./editor-effect-proposal-card.js";

/** Connects the native human card to the single editor review controller, never generic Accept. */
export function ConnectedEffectProposalCard({ world, production, familyId, versionId }: {
  world: WorldBundle; production: ProductionBundle; familyId: string; versionId: string;
}) {
  const review = useEffectProposalReview(world.meta.worldId, production.meta.id);
  const [expanded, setExpanded] = useState(false);
  const base = useMemo(() => effectReviewBase(production, world.artifacts), [production, world.artifacts]);
  const family = production.effectFamilies?.find(value => value.id === familyId);
  const version = family?.versions.find(value => value.id === versionId);
  const exactRef = family && version ? effectCardRef(family, version) : null;
  const active = exactRef !== null && sameEffectProposalVersion(review.active?.ref, exactRef);
  const freshness = useEffectReviewFreshness(production, world.artifacts, base.timeline, family?.status === "pending" && (expanded || active) ? version : undefined);
  const focus = review.state.cardFocus;
  useEffect(() => {
    if (!focus || focus.ref.familyId !== familyId || focus.ref.versionId !== versionId) return;
    setExpanded(true);
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(`studio-card-${effectProposalCardId(focus.ref)}`);
      card?.scrollIntoView?.({ block: "nearest" }); card?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focus?.serial, familyId, versionId]);
  if (!family || !version) return <p role="status">This exact retained effects version is unavailable. Refresh the conversation.</p>;
  const pending = family.status === "pending";
  const ref = effectCardRef(family, version);
  const error = sameEffectProposalVersion(review.state.error?.ref, ref) ? review.state.error?.reason : undefined;
  const currentHash = production.timeline?.status === "ready" ? production.timeline.hash : undefined;
  const currentStale = pending && !!base.timeline && (base.timeline.revision !== version.dependencies.base.revision || (currentHash !== undefined && currentHash !== version.dependencies.base.timelineHash));
  const currentChanged = currentStale ? "Current changed · Update proposal and review the new version." : undefined;
  const dependencyStatus = pending ? freshness.checking ? "checking" : freshness.staleReason ? "stale" : undefined : undefined;
  return <div className="fy-effect-proposal"><EffectProposalCard key={version.id} family={family} version={version} timeline={base.timeline} frameRate={productionFrameRate(production.meta)}
    activeReview={review.active} busy={review.busy} readOnly={review.readOnly} currentStale={currentStale} dependencyStatus={dependencyStatus} statusReason={pending ? error ?? base.reason ?? currentChanged ?? freshness.staleReason ?? undefined : undefined}
    expanded={expanded} onExpandedChange={setExpanded} onReview={review.review} onIntent={review.intent}
    onInspect={review.inspect} onUpdate={review.update} onRetry={review.retry} onDiscard={review.discard} />
    {pending && review.busy && review.canEdit && sameEffectProposalVersion(review.state.pending?.operation.ref, ref) && <div className="fy-effect-proposal__actions"><button type="button" onClick={review.retryRequest}>Check response</button><span>Resends the same pending action.</span></div>}
  </div>;
}
