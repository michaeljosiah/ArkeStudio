import { useEffect, useMemo, useState } from "react";
import type { ArtifactSidecar, EffectProposalVersion, TransitionProposalVersion, ProductionBundle, ProductionTimeline } from "@arke-studio/contracts";
import { cachedEffectReviewFreshness, checkEffectReviewFreshness, type PreparedEffectReviewFreshness } from "../lib/editor-effect-review-freshness.js";

export interface EffectReviewFreshness { checking: boolean; staleReason: string | null }

/** The exact candidate and current source resolution own a digest result, never just its version ID. */
export function useEffectReviewFreshness(production: ProductionBundle | null | undefined, artifacts: readonly ArtifactSidecar[] | undefined,
  base: ProductionTimeline | null | undefined, version?: EffectProposalVersion | TransitionProposalVersion,
  check: (prepared: PreparedEffectReviewFreshness) => Promise<string | null> = checkEffectReviewFreshness): EffectReviewFreshness {
  const prepared = useMemo(() => version && production && base
    ? cachedEffectReviewFreshness({ production, artifacts: artifacts ?? [], base, version }) : null,
  [production, artifacts, base, version]);
  const [result, setResult] = useState<{ prepared: PreparedEffectReviewFreshness; staleReason: string | null } | null>(null);
  useEffect(() => {
    if (!prepared || prepared.immediateReason) return;
    let abandoned = false;
    void check(prepared).then(staleReason => { if (!abandoned) setResult({ prepared, staleReason }); }, error => {
      if (!abandoned) setResult({ prepared, staleReason: error instanceof Error ? `Could not check proposal freshness: ${error.message}` : "Could not check proposal freshness." });
    });
    return () => { abandoned = true; };
  }, [prepared, check]);
  if (!version) return { checking: false, staleReason: null };
  if (!prepared) return { checking: false, staleReason: "Current production is unavailable for this proposal." };
  if (prepared.immediateReason) return { checking: false, staleReason: prepared.immediateReason };
  return result?.prepared === prepared ? { checking: false, staleReason: result.staleReason } : { checking: true, staleReason: null };
}
