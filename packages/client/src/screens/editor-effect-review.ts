import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import { ulid, type EffectHumanIntent, type EffectReviewOperation, type EffectVersionRef } from "@arke-studio/contracts";
import { EffectReviewSession, parseEffectReviewSavedState, sameEffectVersion, type ActiveEffectReview,
  type EffectReviewComparison, type EffectReviewPosition } from "../lib/editor-effect-review-state.js";
import { effectReviewBase } from "../lib/editor-effect-review-base.js";
import { sendEffectProposalCommand, subscribeEffectProposalResults, useStore } from "../lib/store.js";
import { useEffectReviewFreshness } from "./editor-effect-review-freshness.js";
import { claimEditorReview, subscribeEditorReviewOwner } from "../lib/editor-review-ownership.js";

interface SessionEntry { worldId: string; productionId: string; session: EffectReviewSession }
const sessions = new Map<string, SessionEntry>();
subscribeEditorReviewOwner(event => { if (event.kind === "transitions") sessions.get(event.key)?.session.close(); });
const activations = new Set<(event: { worldId: string; productionId: string; active: ActiveEffectReview }) => void>();
let listening = false;
const emptySession = new EffectReviewSession();
const sessionKey = (worldId: string, productionId: string) => `${worldId}/${productionId}`;
const storageKey = (worldId: string, productionId: string) => `arke.effect-review.v1:${sessionKey(worldId, productionId)}`;
function stored(key: string) { try { return parseEffectReviewSavedState(window.sessionStorage.getItem(key)); } catch { return null; } }
function ensureResultListener(): void {
  if (listening) return;
  listening = true;
  // Remains subscribed across Card -> Cut navigation; only locally registered request IDs land.
  subscribeEffectProposalResults(result => sessions.get(sessionKey(result.worldId, result.productionId))?.session.receive(result));
}
function getSession(worldId: string, productionId: string): EffectReviewSession {
  const key = sessionKey(worldId, productionId), existing = sessions.get(key);
  if (existing) return existing.session;
  // Idle sessions remain recoverable from bounded per-window storage, without retaining world data.
  if (sessions.size >= 32) {
    for (const [oldKey, entry] of sessions) if (entry.session.canRelease()) { sessions.delete(oldKey); break; }
    if (sessions.size >= 32) return emptySession;
  }
  const savedKey = storageKey(worldId, productionId);
  const session = new EffectReviewSession(value => {
    try { if (value) window.sessionStorage.setItem(savedKey, JSON.stringify(value)); else window.sessionStorage.removeItem(savedKey); } catch { /* Storage is optional; the exact server version remains durable. */ }
  }, stored(savedKey), active => { claimEditorReview({ key, kind: "effects" }); for (const listener of activations) listener({ worldId, productionId, active }); });
  sessions.set(key, { worldId, productionId, session });
  return session;
}
export function subscribeEffectReviewActivations(listener: (event: { worldId: string; productionId: string; active: ActiveEffectReview }) => void): () => void {
  activations.add(listener); return () => activations.delete(listener);
}

/** One review owner shared by the chat cards and the actual Cut screen. */
export function useEffectProposalReview(worldId: string | undefined, productionId: string | undefined) {
  const studio = useStore();
  const session = useMemo(() => worldId && productionId ? getSession(worldId, productionId) : emptySession, [worldId, productionId]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const world = studio.state?.world;
  const production = world && world.meta.worldId === worldId ? world.productions.find(row => row.meta.id === productionId) : undefined;
  const families = production?.effectFamilies;
  const artifacts = studio.state?.world?.artifacts;
  const base = useMemo(() => production ? effectReviewBase(production, artifacts ?? []) : null, [production, artifacts]);
  const currentRevision = base?.timeline?.revision ?? null;
  const active = state.active;
  const freshness = useEffectReviewFreshness(production, artifacts, base?.timeline, active?.version);
  const refusal = active && state.error && sameEffectVersion(active.ref, state.error.ref) ? state.error.reason : null;
  const statusReason = refusal ?? base?.reason ?? freshness.staleReason ?? state.statusReason ?? (freshness.checking ? "Checking proposal freshness…" : null);
  useEffect(() => { ensureResultListener(); }, []);
  useEffect(() => { if (production) session.observe(families ?? [], currentRevision); }, [session, production, families, currentRevision]);
  // Ownership stays a coordinator check, just like Current authoring; connection is not write authority.
  const canEdit = !!worldId && !!productionId && session !== emptySession && studio.connection === "open";
  const submit = (operation: EffectReviewOperation): boolean => {
    if (!worldId || !productionId || !canEdit) return false;
    ensureResultListener();
    const requestId = ulid();
    if (!session.begin(requestId, operation)) return false;
    if (sendEffectProposalCommand(worldId, productionId, requestId, operation)) return true;
    session.refused(requestId, "Reconnect before changing this proposal."); return false;
  };
  const continuation = (ref: EffectVersionRef) => active && sameEffectVersion(active.ref, ref) &&
    active.version.decisionRevision === active.family.decisionRevision ? { reviewId: active.grant.id } : {};
  return { state, active, busy: state.pending !== null, canEdit, readOnly: !canEdit, freshness,
    canUndo: canEdit && !state.pending && state.canUndo, canRedo: canEdit && !state.pending && state.canRedo, statusReason,
    review: (ref: EffectVersionRef) => submit({ kind: "review", ref }),
    intent: (ref: EffectVersionRef, intent: EffectHumanIntent) => submit({ kind: "edit", ref, intent,
      ...(intent.kind === "release" ? {} : continuation(ref)) }),
    history: (direction: "undo" | "redo") => active ? submit({ kind: "history", ref: active.ref, direction, ...continuation(active.ref) }) : false,
    update: (ref: EffectVersionRef) => submit({ kind: "update", ref }),
    retry: (ref: EffectVersionRef) => submit({ kind: "retry", ref }),
    discard: (ref: EffectVersionRef) => submit({ kind: "discard", ref }),
    apply: () => active && !statusReason && !freshness.checking ? submit({ kind: "apply", ref: active.ref, reviewId: active.grant.id }) : false,
    compare: (comparison: EffectReviewComparison) => session.compare(comparison), close: () => session.close(),
    inspect: (ref: EffectVersionRef, effectId: string) => session.inspect(ref, effectId),
    backToProposal: () => session.backToProposal(), rememberPosition: (position: EffectReviewPosition) => session.rememberPosition(position),
    retryRequest: () => {
      const pending = session.getSnapshot().pending;
      return !!pending && !!worldId && !!productionId && canEdit && sendEffectProposalCommand(worldId, productionId, pending.requestId, pending.operation);
    },
  };
}

/** Mounted once by ProductionConversation; Show/arrival/restore do not navigate or own a transport. */
export function useEffectReviewNavigation(worldId?: string, productionId?: string): void {
  const navigate = useNavigate(), location = useLocation();
  useEffect(() => subscribeEffectReviewActivations(event => {
    if (!worldId || !productionId || event.worldId !== worldId || event.productionId !== productionId) return;
    const path = `/w/${encodeURIComponent(worldId)}/p/${encodeURIComponent(productionId)}/cut`;
    if (location.pathname !== path) void navigate(path);
  }), [worldId, productionId, location.pathname, navigate]);
}
