import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ulid, TransitionVersionRefSchema, transitionVersionRef, type ProductionBundle, type ProductionTimeline, type TransitionReviewOperation, type TransitionVersionRef } from "@arke-studio/contracts";
import { send, subscribeTransitionProposalResults, useStore } from "./store.js";
import { claimEditorReview, subscribeEditorReviewOwner } from "./editor-review-ownership.js";
import { useEffectReviewFreshness } from "../screens/editor-effect-review-freshness.js";

type Review = { ref: TransitionVersionRef; reviewId: string; comparison: "current" | "suggested"; fallback?: TransitionVersionRef };
type State = { active: Review | null; pending: string | null; error: string | null };
const empty: State = { active: null, pending: null, error: null }, states = new Map<string, State>(), listeners = new Set<() => void>();
const requests = new Map<string, { key: string; operation: TransitionReviewOperation; timeout: ReturnType<typeof setTimeout>; closed?: boolean }>();
function state(key: string): State {
  let value = states.get(key);
  if (!value) { let active: Review | null = null;
    try { const saved = JSON.parse(sessionStorage.getItem(`transition-review:${key}`) ?? "null"), ref = TransitionVersionRefSchema.safeParse(saved?.ref);
      if (ref.success && typeof saved.reviewId === "string" && saved.reviewId.length <= 128 && (saved.comparison === "current" || saved.comparison === "suggested"))
        active = { ref: ref.data, reviewId: saved.reviewId, comparison: saved.comparison }; } catch { /* Storage is optional; durable proposals live in the world. */ }
    value = { ...empty, active }; states.set(key, value); }
  return value;
}
function update(key: string, patch: Partial<State>) {
  const next = { ...state(key), ...patch }; states.set(key, next);
  try { sessionStorage.setItem(`transition-review:${key}`, JSON.stringify(next.active)); } catch { /* Optional view memory. */ }
  for (const listener of listeners) listener();
}
subscribeTransitionProposalResults(result => {
  const request = requests.get(result.requestId); if (!request) return;
  requests.delete(result.requestId); clearTimeout(request.timeout);
  if (request.closed) { update(request.key, { pending: null }); return; }
  if (result.outcome === "refused") { update(request.key, { pending: null, error: result.reason ?? "Could not update transitions" }); return; }
  if (result.outcome === "applied" || result.outcome === "discarded") { update(request.key, { pending: null, error: null, active: null }); return; }
  const previous = state(request.key).active;
  if (result.reviewId && request.operation.kind === "review") claimEditorReview({ key: request.key, kind: "transitions" });
  if (result.reviewId) update(request.key, { pending: null, error: null, active: { ref: result.ref, reviewId: result.reviewId,
    comparison: request.operation.kind === "review" ? "suggested" : previous?.comparison ?? "suggested", fallback: previous?.ref } });
  else update(request.key, { pending: null, error: "A new version is ready. Choose Review in timeline before applying it." });
});
subscribeEditorReviewOwner(event => { if (event.kind === "effects" && states.has(event.key)) update(event.key, { active: null, error: null }); });

/** Arrival updates the world snapshot only. This controller activates versions solely on human review results. */
export function useTransitionReview(worldId: string | undefined, production: ProductionBundle | null | undefined) {
  const studio = useStore();
  const key = `${worldId ?? ""}/${production?.meta.id ?? ""}`;
  const local = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state(key), () => empty);
  const family = production?.transitionFamilies?.find(value => value.id === local.active?.ref.familyId);
  const version = family?.versions.find(value => value.id === local.active?.ref.versionId && value.candidateHash === local.active.ref.candidateHash)
    ?? family?.versions.find(value => value.id === local.active?.fallback?.versionId && value.candidateHash === local.active.fallback.candidateHash);
  useEffect(() => { if (family && family.status !== "pending" && local.active) update(key, { active: null }); }, [family?.status, key]);
  const active = local.active && family?.status === "pending" && version ? { ...local.active, family, version, ref: transitionVersionRef(family.id, version) } : null;
  const freshness = useEffectReviewFreshness(production, studio.state?.world?.artifacts, production?.timeline?.status === "ready" ? production.timeline.timeline : null, active?.version);
  const stale = freshness.staleReason;
  const operate = (operation: TransitionReviewOperation) => {
    if (!worldId || !production || local.pending) return;
    const requestId = `tr_${ulid()}`;
    if (!send({ kind: "editor-transition-proposal", worldId, productionId: production.meta.id, requestId, operation })) { update(key, { error: "Reconnect before reviewing transitions" }); return; }
    const timeout = setTimeout(() => { if (requests.delete(requestId)) update(key, { pending: null, error: "The request has not answered. Reconnect and review the retained version." }); }, 45000);
    requests.set(requestId, { key, operation, timeout }); update(key, { pending: requestId, error: null });
  };
  const timeline = useMemo((): ProductionTimeline | null => {
    if (!active || stale || active.comparison !== "suggested" || production?.timeline?.status !== "ready") return null;
    return { ...production.timeline.timeline, transitions: active.version.transitions, history: { undo: [], redo: [] } };
  }, [active?.version, active?.comparison, production?.timeline, stale]);
  return { ...local, active, stale, checking: freshness.checking, connected: studio.connection === "open", timeline, operate,
    close: () => { for (const request of requests.values()) if (request.key === key) request.closed = true; update(key, { active: null, error: null }); },
    compare: (comparison: "current" | "suggested") => { if (local.active) update(key, { active: { ...local.active, comparison } }); },
    inspect: (pair: import("@arke-studio/contracts").TransitionPair) => window.dispatchEvent(new CustomEvent("arke-inspect-transition", { detail: { key, pair } })),
  };
}
