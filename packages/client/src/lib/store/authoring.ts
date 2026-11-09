import { type ModelChoices, ulid } from "@arke-studio/contracts";
import { current, bridge, emitChange, send, useStore, useStoreSelector } from "./core.js";
import {
  discardedGenesis, emptyGenesis, type AuthoringActivity, type PendingPermission, type StoreState,
} from "./state.js";

// ---- authoring sessions (SPEC-005) ----------------------------------------

export function draftWithStudio(worldId: string, path: string, instruction: string, summary: string): void {
  send({ kind: "draft-with-studio", worldId, path, instruction, summary });
}

/** Continue a proposal's conversation — same session, same agent context (SPEC-005). */
export function continueStudio(worldId: string, path: string, proposalId: string, instruction: string): void {
  send({
    kind: "draft-with-studio",
    worldId,
    path,
    instruction,
    summary: "Continue the conversation",
    proposalId,
  });
}

export function useTranscripts(): Record<string, Array<{ role: "user" | "gate"; text: string; at: string }>> {
  return useStoreSelector(store => store.transcripts);
}

export function setupSkip(componentId: string): void {
  send({ kind: "setup-skip", componentId });
}

export function setupRetry(componentId: string): void {
  send({ kind: "setup-retry", componentId });
}

export function setupRepair(componentId: string, revision: string): void {
  send({ kind: "setup-repair", componentId, revision });
}

export function setupPause(componentId: string): void {
  send({ kind: "setup-pause", componentId });
}

export function setupResume(componentId: string): void {
  send({ kind: "setup-resume", componentId });
}

export function setupCancel(): void {
  send({ kind: "setup-cancel" });
}

/** Live progress wins; the snapshot covers a window that opened mid-download. */
export function useSetup(): import("@arke-studio/contracts").SetupStatus | null {
  const { setupStatus, state } = useStore();
  return setupStatus ?? state?.app.setup ?? null;
}

/** The findings snapshot, or null before the first replay arrives (SPEC-032 R-33). */
export function useDiagnostics(): import("@arke-studio/contracts").DiagnosticsSnapshot | null {
  return useStoreSelector(store => store.diagnostics);
}

/** Read-only refresh of the open world's app-root accounting evidence. */
export function refreshProductionSpend(worldId: string): void { send({ kind: "production-spend-refresh", worldId }); }

/** Ask for a fresh derivation when Diagnostics opens (SPEC-032 R-33). */
export function refreshDiagnostics(): void {
  send({ kind: "refresh-diagnostics" });
}
export function refreshSystemResources(): void {
  send({ kind: "refresh-system-resources" });
}

function genesisChatBusy(genesisId: string): boolean {
  const draft = current.genesis[genesisId];
  return !!draft?.chatPending || draft?.status === "running";
}
export function genesisChat(genesisId: string, text: string, modelId?: string): boolean {
  const draft = current.genesis[genesisId];
  if (!bridge || current.connection !== "open" || genesisChatBusy(genesisId) || draft?.decisionPending || draft?.readinessPending || draft?.founding || draft?.worldId) return false;
  discardedGenesis.delete(genesisId);
  const requestId = ulid();
  emitChange({ ...current, genesis: { ...current.genesis, [genesisId]: { ...emptyGenesis(), ...draft, writingModel: modelId, chatPending: true, chatSubmission: { requestId, text }, rejectedChat: undefined, chatError: undefined, detail: undefined } } });
  if (send({ kind: "genesis-chat", genesisId, requestId, text, ...(modelId ? { modelId } : {}) })) return true;
  emitChange({ ...current, genesis: { ...current.genesis, [genesisId]: { ...current.genesis[genesisId]!, chatPending: false } } });
  return false;
}

export function takeRejectedGenesisChat(genesisId: string): string | undefined {
  const draft = current.genesis[genesisId];
  const text = draft?.rejectedChat;
  if (draft && text !== undefined) emitChange({ ...current, genesis: { ...current.genesis, [genesisId]: { ...draft, rejectedChat: undefined } } });
  return text;
}

export function listGenesisDrafts(): void { send({ kind: "genesis-list" }); }
export function loadGenesisDraft(genesisId: string): void { if (discardedGenesis.has(genesisId)) return; send({ kind: "genesis-load", genesisId }); }
function genesisReviewRequest(genesisId: string): string {
  const requestId = ulid();
  emitChange({ ...current, genesis: { ...current.genesis, [genesisId]: { ...emptyGenesis(), ...current.genesis[genesisId], reviewRequestId: requestId, reviewPending: true }, }, buildPlans: { ...current.buildPlans, [genesisId]: {} } });
  return requestId;
}
export function reviewGenesisDraft(genesisId: string): void {
  if (genesisChatBusy(genesisId) || current.genesis[genesisId]?.founding || current.genesis[genesisId]?.worldId) return;
  send({ kind: "genesis-review", genesisId, requestId: genesisReviewRequest(genesisId) });
}
export function reviewGenesisImages(genesisId: string, models?: Partial<Record<import("@arke-studio/contracts").Capability, string>>): void {
  if (genesisChatBusy(genesisId)) return;
  send({ kind: "genesis-images", genesisId, ...(models ? { models } : {}) });
}
export function reviewGenesisVoices(genesisId: string): void { if (genesisChatBusy(genesisId)) return; send({ kind: "genesis-voices", genesisId }); }
function beginReadinessRequest(genesisId: string): boolean {
  if (!bridge || current.connection !== "open" || genesisChatBusy(genesisId) || (current.genesis[genesisId]?.decisionPending || current.genesis[genesisId]?.readinessPending || current.genesis[genesisId]?.reviewPending || current.genesis[genesisId]?.founding)) return false;
  emitChange({ ...current, genesis: { ...current.genesis, [genesisId]: { ...emptyGenesis(), ...current.genesis[genesisId], readinessPending: true } } });
  return true;
}
export function reviewGenesisReadiness(genesisId: string): void {
  if (beginReadinessRequest(genesisId)) send({ kind: "genesis-readiness", genesisId });
}
export function leaveGenesisFinding(genesisId: string, findingId: string, digest: string): void {
  if (!beginReadinessRequest(genesisId)) return;
  send({ kind: "genesis-readiness-leave", genesisId, requestId: ulid(), findingId, digest });
}
function beginGenesisDecision(genesisId: string, kind: "image" | "voice" | "import"): boolean {
  const draft = current.genesis[genesisId];
  if (!bridge || current.connection !== "open" || genesisChatBusy(genesisId) || draft?.decisionPending || draft?.readinessPending || draft?.reviewPending || draft?.founding || draft?.worldId) return false;
  emitChange({ ...current, genesis: { ...current.genesis, [genesisId]: { ...emptyGenesis(), ...draft, decisionPending: kind, readiness: undefined } } });
  return true;
}
export function generateGenesisVoice(genesisId: string, intentId: string, digest: string): void {
  if (!beginGenesisDecision(genesisId, "voice")) return;
  send({ kind: "genesis-voice-generate", genesisId, intentId, digest, requestId: ulid() });
}
export function decideGenesisVoice(genesisId: string, target: string, decision: "approve" | "reject" | "unassign", candidate?: import("@arke-studio/contracts").GenesisVoiceCandidate): void {
  if (!beginGenesisDecision(genesisId, "voice")) return;
  send({ kind: "genesis-voice-decide", genesisId, requestId: ulid(), target, decision,
    ...(candidate ? { candidateId: candidate.id, hash: candidate.hash } : {}) });
}
export function reviewGenesisImports(genesisId: string): void { if (genesisChatBusy(genesisId)) return; send({ kind: "genesis-imports", genesisId }); }
export function resolveGenesisImport(genesisId: string, resolution: import("@arke-studio/contracts").GenesisImportResolve): void {
  if (!beginGenesisDecision(genesisId, "import")) return;
  send({ kind: "genesis-import-resolve", genesisId, resolution });
}
export function generateGenesisImage(genesisId: string, intentId: string, digest: string, models?: Partial<Record<import("@arke-studio/contracts").Capability, string>>): void {
  if (!beginGenesisDecision(genesisId, "image")) return;
  send({ kind: "genesis-image-generate", genesisId, intentId, digest, requestId: ulid(), ...(models ? { models } : {}) });
}
export function decideGenesisImage(genesisId: string, target: string, decision: "approve" | "reject" | "unassign", candidate?: import("@arke-studio/contracts").GenesisImageCandidate): void {
  if (!beginGenesisDecision(genesisId, "image")) return;
  send({ kind: "genesis-image-decide", genesisId, requestId: ulid(), target, decision, ...(candidate ? { candidateId: candidate.id, hash: candidate.hash } : {}) });
}
export function proposeGenesisWorld(genesisId: string, draft: import("@arke-studio/contracts").GenesisDraft): void {
  send({ kind: "genesis-propose-world", genesisId, draft });
}
export function decideGenesisDraft(genesisId: string, choices: Array<{ key: string; digest: string }>, decision: "approve" | "reject"): void {
  const draft = current.genesis[genesisId];
  if (genesisChatBusy(genesisId) || draft?.decisionPending || draft?.readinessPending || draft?.reviewPending || draft?.founding || draft?.worldId) return;
  send({ kind: "genesis-decide", genesisId, choices: choices.slice(0, 300), decision, requestId: genesisReviewRequest(genesisId) });
}

export function genesisDiscard(genesisId: string): void {
  send({ kind: "genesis-discard", genesisId });
}

// ---- The founding build (SPEC-031) ----------------------------------------

export function planFoundingBuild(genesisId: string, requestId: string, look?: string, models?: ModelChoices, generateImages = true): void {
  // The same look the press will send: the review's master-look note is only true if it asks
  // the carry question against the words the world would actually be founded on (SPEC-031 R-54).
  // The same holds for the models: the review prices the build on the model the press will use.
  send({
    kind: "plan-founding-build",
    generateImages,
    genesisId,
    requestId,
    ...(look !== undefined ? { look } : {}),
    ...(models !== undefined ? { models } : {}),
  });
}

export function beginFoundingBuild(genesisId: string, requestId: string, look?: string, models?: ModelChoices, approvalDigest?: string, generateImages = true): void {
  send({
    kind: "begin-founding-build",
    generateImages,
    ...(approvalDigest ? { approvalDigest } : {}),
    genesisId,
    requestId,
    ...(look !== undefined ? { look } : {}),
    ...(models !== undefined ? { models } : {}),
  });
}

export function stopFoundingBuild(worldId: string): void {
  send({ kind: "stop-founding-build", worldId });
}

/** Run one item — or, with no key, everything runnable that has not landed (R-11, R-48). */
export function runBuildItem(worldId: string, itemKey?: string): void {
  send({ kind: "run-build-item", worldId, ...(itemKey !== undefined ? { itemKey } : {}), requestId: ulid() });
}

export function dismissBuildNotice(worldId: string): void {
  send({ kind: "dismiss-build-notice", worldId });
}

/** One picture of the look, from inside the conversation (SPEC-031 R-50) — a person pressed. */
export function generateLookPreview(genesisId: string, models?: ModelChoices): void {
  send({ kind: "generate-look-preview", genesisId, requestId: ulid(), ...(models !== undefined ? { models } : {}) });
}

/** What key art would carry and drop — asked when the dialog opens (SPEC-010 R-15). */
export function planKeyArt(worldId: string, opts: {modelId?:string;draftAlternative?:boolean} = {}): string {
  const requestId=ulid();send({ kind: "plan-key-art", worldId, requestId, ...opts });return requestId;
}

export function useKeyArtPlans(): StoreState["keyArtPlans"] {
  return useStoreSelector(store => store.keyArtPlans);
}

export function useBuildPlans(): StoreState["buildPlans"] {
  return useStoreSelector(store => store.buildPlans);
}

export function useGenesis(): StoreState["genesis"] {
  return useStoreSelector(store => store.genesis);
}

export function cancelAuthoring(worldId: string, proposalId: string): void {
  send({ kind: "authoring-cancel", worldId, proposalId });
}

export function replyToPermission(permissionId: string, decision: "once" | "always" | "reject"): void {
  send({ kind: "permission-reply", permissionId, decision });
}

export function useAuthoring(): Record<string, AuthoringActivity> {
  return useStoreSelector(store => store.authoring);
}

export function usePermissions(): Record<string, PendingPermission> {
  return useStoreSelector(store => store.permissions);
}
