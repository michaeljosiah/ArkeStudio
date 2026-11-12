// Hooks for tests and fixtures to set, read and drive the store without a socket (issue 2800).
import type { ClientState, DomainEvent, Frame } from "@arke-studio/contracts";
import { fold, handleFrame, current, emitChange, lastSeq, handleStatus } from "./core.js";
import type { StoreState, ConnectionStatus } from "./state.js";
import { pendingQueueRequests } from "./events.js";

/** Test hook: apply one event to a state, so a reducer can be pinned without a socket. */
export function __applyForTest(state: ClientState, event: DomainEvent): ClientState {
  return fold(state, event);
}

/**
 * Test hook: put one frame through the real socket path, so the store's own folding is what is
 * under test rather than a copy of it. Both halves of a proposal's gate live in here — the
 * snapshot seeds live runs, the events end them — and neither is reachable from `__applyForTest`,
 * which folds `ClientState` and never sees `gateNotices` or `authoring`.
 */
export function __handleFrameForTest(frame: Frame): void {
  handleFrame(JSON.stringify(frame));
}

/**
 * Test hook: inject a full state and mark the connection open. `extra` overrides the slots that
 * live beside the coordinator's snapshot — voice candidates, permissions and the like — which a
 * screen reads through useStore rather than useClientState.
 */
/** Test hook: read the folded store without a React render. */
export function __stateForTest(): StoreState {
  return current;
}

export function __setStateForTest(state: ClientState, extra: Partial<StoreState> = {}): void {
  emitChange({
    connection: "open",
    state,
    gateNotices: {},
    authoring: {},
    transcripts: {},
    genesis: {},
    buildPlans: {},
    keyArtPlans: {},
    setupStatus: null,
    diagnostics: null,
    recoveryCommandResults: {},
    recoveryActionResults: {},
    recoveryHistoryPages: {},
    reading: {},
  deriving: {},
    casting: {},
    audiobook: {},
    direction: {},
    illustration: {},
    audiobookRecords: {},
    beats: {},
    stagedTakes: {},
    speakerLines: {},
  narratorQuotes: {},
  heardLines: {},
  audiobookAsks: {},
    audiobookDoor: {},
    audiobookCredits: {},
    audiobookBook: {},
    audiobookNotes: {},
  manuscripts: {},
    archiveNote: null,
    permissions: {},
    askResults: {},
    canonSearches: {},
    canonRefs: {},
    sheetRefs: {},
    reconcileReport: null,
    voiceCandidates: {},
    voiceClips: {},
    voiceCloned: null,
    voiceCatalogue: null,
    voiceCatalogueHeld: null,
    voiceCatalogueErrors: [],
    cataloguePreview: null,
    voicePreviews: {},
    voiceAudio: {},
    voiceParts: {},
    dictation: {},
    worldChatRefusals: {},
    worldChatWrapUpRefusals: {},
    worldChatRipples: {},
    worldChatProgress: {},
    worldOpenProgress: null,
    voiceSidecar: null,
    voiceRuntimeTest: null,
    mainPhotoAcceptance: {},
    characterSheetAcceptance: {},
    locationViewUpload: {},
    exportsState: {},
    importReport: null,
    artifactNotices: [],
    attached: [],
    envCheck: null,
    diagnosticsBundle: null,
    providerCallsByJob: {},
    frameRunQuotes: {},
    frameRunStartResults: {},
    frameRunRequestEpoch: 0,
    rejoins: 0,
    // A line just sent stays held across a test's state changes, as it does across snapshots;
    // `__clearWorldChatHoldsForTest` starts a test without one.
    worldChatHolds: current.worldChatHolds,
    ...extra,
  });
}

/** Test hook: apply a validated domain event through the same frame fold as the transport. */
export function __applyEventForTest(event: DomainEvent): void {
  handleFrame(JSON.stringify({ kind: "event", seq: lastSeq + 1, event }));
}

export function __mainPhotoAcceptanceForTest() {
  return current.mainPhotoAcceptance;
}

export function __characterSheetAcceptanceForTest() {
  return current.characterSheetAcceptance;
}

export function __pendingQueueRequestsForTest(): string[] {
  return [...pendingQueueRequests.keys()];
}

export function __connectionStatusForTest(status: ConnectionStatus): void {
  handleStatus(status);
}
