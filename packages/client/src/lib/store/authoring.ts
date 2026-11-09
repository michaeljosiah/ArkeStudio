import { type ModelChoices, ulid, type DomainEvent } from "@arke-studio/contracts";
import {
  current, bridge, emitChange, send, useStore, useStoreSelector, type FrameSlices, type Folded,
} from "./core.js";
import {
  discardedGenesis, emptyGenesis, type AuthoringActivity, type PendingPermission, type StoreState,
} from "./state.js";
import { gateRequests, gateAnswers, proposalResolutionListeners } from "./events.js";

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

/** handleFrame's arms for proposal.blocked … world.archive-refused, in their order (issue 2800). */
export function foldAuthoringEvent(slices: FrameSlices, event: DomainEvent): Folded {
  if (event.type === "proposal.blocked") {
    if (event.requestId !== undefined && gateRequests.has(event.requestId)) gateAnswers.add(event.requestId);
    slices.gateNotices = {
      ...slices.gateNotices,
      [event.proposalId]: {
        reason: event.reason,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        ...(event.authoritativeSignature !== undefined
          ? { authoritativeSignature: event.authoritativeSignature }
          : {}),
        ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
      },
    };
  } else if (event.type === "proposal.resolved") {
    for (const listener of proposalResolutionListeners) listener(event);
    slices.gateNotices = { ...slices.gateNotices };
    delete slices.gateNotices[event.proposalId];
    slices.authoring = { ...slices.authoring };
    delete slices.authoring[event.proposalId];
  } else if (event.type === "authoring.progress") {
    const existing = slices.authoring[event.proposalId] ?? { status: "running" as const, lines: [] };
    slices.authoring = {
      ...slices.authoring,
      [event.proposalId]: { ...existing, lines: [...existing.lines.slice(-19), event.line] },
    };
  } else if (event.type === "authoring.turn") {
    slices.transcripts = {
      ...slices.transcripts,
      [event.proposalId]: [
        ...(slices.transcripts[event.proposalId] ?? []),
        { role: event.role, text: event.text, at: event.at },
      ],
    };
  } else if (event.type === "setup.status") {
    slices.setupStatus = event.setup;
  } else if (event.type === "genesis.image-error") {
    slices.genesis = { ...slices.genesis, [event.genesisId]: { ...emptyGenesis(), ...slices.genesis[event.genesisId], imageError: event.detail, decisionPending: undefined } };
  } else if (event.type === "genesis.images") {
    slices.genesis = { ...slices.genesis, [event.genesisId]: { ...emptyGenesis(), ...slices.genesis[event.genesisId], images: event.images, imageError: undefined, readiness: undefined, decisionPending: slices.genesis[event.genesisId]?.decisionPending === "image" ? undefined : slices.genesis[event.genesisId]?.decisionPending } };
  } else if (event.type === "genesis.voices") {
    slices.genesis = { ...slices.genesis, [event.genesisId]: { ...emptyGenesis(), ...slices.genesis[event.genesisId], voices: event.voices, voiceError: undefined, readiness: undefined, decisionPending: slices.genesis[event.genesisId]?.decisionPending === "voice" ? undefined : slices.genesis[event.genesisId]?.decisionPending } };
  } else if (event.type === "genesis.readiness") {
    slices.genesis = { ...slices.genesis, [event.genesisId]: { ...emptyGenesis(), ...slices.genesis[event.genesisId], readiness: event.review, readinessError: undefined, readinessPending: false } };
  } else if (event.type === "genesis.import-error") {
    slices.genesis = { ...slices.genesis, [event.genesisId]: { ...emptyGenesis(), ...slices.genesis[event.genesisId], importError: event.detail, decisionPending: undefined } };
  } else if (event.type === "genesis.imports") {
    slices.genesis = { ...slices.genesis, [event.genesisId]: { ...emptyGenesis(), ...slices.genesis[event.genesisId], imports: event.imports, importError: undefined, readiness: undefined, decisionPending: slices.genesis[event.genesisId]?.decisionPending === "import" ? undefined : slices.genesis[event.genesisId]?.decisionPending } };
  } else if (event.type === "genesis.chat-result") {
    const draft = slices.genesis[event.genesisId];
    if (draft?.chatSubmission?.requestId === event.requestId) {
      slices.genesis = { ...slices.genesis, [event.genesisId]: { ...draft, chatPending: event.accepted ? draft.chatPending : false, chatSubmission: undefined,
        ...(!event.accepted ? { rejectedChat: draft.chatSubmission.text, chatError: event.detail } : {}),
      } };
    }
  } else if (event.type === "genesis.review-error") {
    const draft = slices.genesis[event.genesisId] ?? emptyGenesis();
    if (event.area !== "content" || draft.reviewRequestId === event.requestId) {
      slices.genesis = { ...slices.genesis, [event.genesisId]: { ...draft,
        ...(event.area === "content" ? { reviewError: event.detail, reviewPending: false } : event.area === "readiness" ? { readinessError: event.detail, readinessPending: false } : { voiceError: event.detail, decisionPending: draft.decisionPending === "voice" ? undefined : draft.decisionPending }),
      } };
    }
  } else if (event.type === "genesis.review") {
    if (slices.genesis[event.genesisId]?.reviewRequestId === event.requestId) {
      slices.genesis = { ...slices.genesis, [event.genesisId]: { ...emptyGenesis(), ...slices.genesis[event.genesisId], review: event.review, reviewError: undefined, reviewPending: false, readiness: undefined } };
    }
  } else if (event.type === "genesis.discarded") {
    discardedGenesis.add(event.genesisId);
    slices.genesis = { ...slices.genesis };
    delete slices.genesis[event.genesisId];
  } else if (event.type === "genesis.loaded") {
    if (discardedGenesis.has(event.genesisId)) return "drop";
    if ((event.revision ?? 0) < (slices.genesis[event.genesisId]?.revision ?? 0)) return "drop";
    const messages = new Map(event.turns.map(turn => [turn.id, turn]));
    for (const turn of slices.genesis[event.genesisId]?.turns ?? []) {
      if (turn.id && !messages.has(turn.id)) messages.set(turn.id, { ...turn, id: turn.id });
    }
    slices.genesis = { ...slices.genesis, [event.genesisId]: {
      ...emptyGenesis(), ...slices.genesis[event.genesisId],
      turns: [...messages.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)), blueprint: event.blueprint,
      revision: event.revision, attachments: event.attachments, status: event.status, conversationId: event.conversationId, readiness: undefined, readinessPending: false,
      founding: event.founding,
      formHandoff: event.formHandoff,
      frozenModels: event.frozenModels,
      frozenGenerateImages: event.frozenGenerateImages,
      review: undefined, reviewRequestId: ulid(), reviewPending: false,
      detail: event.detail,
      ...(event.worldId ? { worldId: event.worldId } : {}),
    } };
  } else if (event.type === "genesis.turn") {
    const g = slices.genesis[event.genesisId] ?? emptyGenesis();
    slices.genesis = {
      ...slices.genesis,
      [event.genesisId]: {
        ...g,
        turns: event.messageId && g.turns.some(t => t.id === event.messageId) ? g.turns :
          [...g.turns, { ...(event.messageId ? { id: event.messageId } : {}), role: event.role, text: event.text, at: event.at }],
      },
    };
  } else if (event.type === "genesis.blueprint") {
    const g = slices.genesis[event.genesisId] ?? emptyGenesis();
    slices.genesis = { ...slices.genesis, [event.genesisId]: { ...g, blueprint: event.blueprint, revision: event.revision, readiness: undefined, review: undefined, reviewRequestId: ulid() } };
  } else if (event.type === "world-image.plan") {
    slices.keyArtPlans = {
      ...slices.keyArtPlans,
      [event.worldId]: {
        requestId: event.requestId,
        prompt: event.prompt,
        promptReviewId:event.promptReviewId,modelId:event.modelId,fixedConstraints:event.fixedConstraints,candidate:event.candidate,review:event.review,reason:event.reason,sources:event.sources,
        carried: event.carried,
        dropped: event.dropped,
      },
    };
  } else if (event.type === "build.plan") {
    slices.buildPlans = {
      ...slices.buildPlans,
      [event.genesisId]: {
        ...slices.buildPlans[event.genesisId],
        [event.requestId]: {
          requestId: event.requestId,
          plan: event.plan,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      },
    };
  } else if (event.type === "genesis.status") {
    const g = slices.genesis[event.genesisId] ?? emptyGenesis();
    slices.genesis = {
      ...slices.genesis,
      [event.genesisId]: {
        ...g,
        status: event.status, chatPending: false,
        ...(event.status === "failed" ? { readinessPending: false, reviewPending: false, decisionPending: undefined } : {}),
        // The clock starts when the turn does; a settled turn takes its working line with it.
        runStartedAt: event.status === "running" ? event.at : g.runStartedAt,
        working: event.status === "running" ? g.working : null,
        detail: event.detail,
      },
    };
  } else if (event.type === "genesis.progress") {
    const g = slices.genesis[event.genesisId] ?? emptyGenesis();
    slices.genesis = { ...slices.genesis, [event.genesisId]: { ...g, working: event.label } };
  } else if (event.type === "genesis.attachment") {
    const g = slices.genesis[event.genesisId] ?? emptyGenesis();
    slices.genesis = {
      ...slices.genesis,
      [event.genesisId]:
        event.outcome === "waiting"
          ? {
              ...g,
              // The sandbox de-collides names, so a name is an identity here.
              attachments: [
                ...g.attachments.filter((a) => a.name !== event.name),
                { name: event.name, kind: event.kind },
              ],
            }
          : {
              ...g,
              refusals: [
                ...g.refusals.slice(-2),
                { name: event.name, reason: event.reason ?? "it would not go in" },
              ],
            },
    };
  } else if (event.type === "world.archived") {
    slices.archiveNote = {
      worldId: event.worldId,
      text: `${event.name} is in the archive folder, under ${event.folder}. Nothing was deleted.`,
      refused: false,
    };
  } else if (event.type === "world.archive-refused") {
    slices.archiveNote = { worldId: event.worldId, text: event.reason, refused: true };
  } else return "none";
  return "done";
}

/** handleFrame's arms for authoring.status … permission.settled, in their order (issue 2800). */
export function foldAuthoringStatusEvent(slices: FrameSlices, event: DomainEvent): Folded {
  if (event.type === "authoring.status") {
    const existing = slices.authoring[event.proposalId] ?? { status: event.status, lines: [] };
    slices.authoring = {
      ...slices.authoring,
      [event.proposalId]: {
        ...existing,
        status: event.status,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      },
    };
    // The run this refusal was about has ended, and the buttons it explains are live again.
    if (event.status !== "running" && slices.gateNotices[event.proposalId]?.reason === "drafting") {
      slices.gateNotices = { ...slices.gateNotices };
      delete slices.gateNotices[event.proposalId];
    }
  } else if (event.type === "permission.pending") {
    slices.permissions = {
      ...slices.permissions,
      [event.permissionId]: {
        description: event.description,
        actionClass: event.actionClass,
        rememberable: event.rememberable,
      },
    };
  } else if (event.type === "permission.settled") {
    slices.permissions = { ...slices.permissions };
    delete slices.permissions[event.permissionId];
  } else return "none";
  return "done";
}
