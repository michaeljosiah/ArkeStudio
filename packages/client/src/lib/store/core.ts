import {
  applyClientStateEvent, isRemoteHostCommand, RemoteCommandRefusalSchema, type ClientMessage,
  type ClientState, type DomainEvent, type Frame, voiceJobFormat, voiceJobReadIdentity,
  voiceTargetKey, type ProviderId, ulid,
} from "@arke-studio/contracts";
import { setMediaStateSource } from "../media.js";
import { devSession } from "../dev-session.js";
import { isRemoteSession, remoteSocketUrl, remoteSocketProtocols } from "../remote-session.js";
import { useRef, useSyncExternalStore } from "react";
import { parseIncomingFrame, shareSnapshot } from "../frame-parser.js";
import { SnapshotPageBuffer } from "../snapshot-pages.js";
import type { ArkeBridge } from "../../arke-bridge.js";
import {
  discardedGenesis, emptyGenesis, type ConnectionStatus, type AuthoringActivity, type StoreState,
  type WorldChatHold,
} from "./state.js";
import {
  emitEvent, pendingQueueRequests, queueResultListeners, voiceUploadConfirmationListeners,
  jobReadyListeners, audiobookTallProgressListeners, lastTallProgress,
  audiobookVideoExportedListeners, guideDrafting, guideDraftingListeners, noteGuideDrafting,
  forgetGuideDrafting, browserUploadResults, takeReviewPreparedListeners,
  audiobookActivityListeners, commandFailureListeners, type HostOnlyRefusal, refuseInvalidCommand,
  worldChatCreateListeners, chapterCreateListeners, chapterVersionListeners, dramaEditionListeners,
  dramaSourceListeners, sceneCreateListeners, proposalResolutionListeners, gateRequests,
  gateAnswers, type WorldChatSendResult, inputResultListeners, sendResultListeners,
  frameRunQuoteListeners, frameRunStartResultListeners, frameRunStartKey, recoveryNoticeListeners,
  seenRecoveryNotices, remoteRefusalListeners, studioAssistantReplyListeners, promptToolsListeners,
  mediaMeasurementListeners,
} from "./events.js";
import { issuedSceneCreates, issuedChapterCreates } from "./productions.js";
import { audioHeardListeners } from "./audiobook.js";
import { forgetDoorAsks, landDoorAnswer } from "./audiobook-door.js";
import { askWorldChatSendStatus } from "./world-chat.js";

export let current: StoreState = {
  connection: "connecting",
  state: null,
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
  worldChatHolds: {},
};
/**
 * The last answers, by request id, kept past the moment they arrive (codex on PR 1232): a screen
 * that was not listening when its answer came — the dock put away and brought back — still finds
 * it. A handful is plenty; nobody is waiting on an old send.
 */
export let sendResults = new Map<string, WorldChatSendResult>();

const listeners = new Set<() => void>();
export let bridge: ArkeBridge | null = null;
let lastSeq = 0;
/**
 * True from a hello until the snapshot that answers it: that snapshot is a window rejoining,
 * whose runs may have ended while it was away; every other snapshot is a refresh on a
 * connection that has missed nothing.
 */
let rejoining = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let helloFallbackTimer: ReturnType<typeof setTimeout> | null = null;

const worldListeners = new Set<(worldId: string | null) => void>();
/**
 * Told when the open world changes or closes — not on a snapshot of the same world. For what a
 * screen keeps beyond itself that belongs to one world's session and must not outlive it.
 */
export function onWorldChange(listener: (worldId: string | null) => void): () => void {
  worldListeners.add(listener);
  return () => worldListeners.delete(listener);
}

/** Ends the holds whose line has been answered and shown; after a rejoin, asks where each stands. */
function settleHolds(next: StoreState): StoreState {
  let holds: Record<string, WorldChatHold> | null = null;
  for (const [conversationId, hold] of Object.entries(next.worldChatHolds)) {
    const workspace = next.state?.worldChat?.conversationId === conversationId ? next.state.worldChat : null;
    const seq = workspace?.seq ?? null;
    const running = workspace?.runStatus === "running";
    const result = sendResults.get(hold.requestId);
    const answer = result?.admitted;
    let settled: WorldChatHold | null = hold;
    if (answer === false) settled = null;
    else if (hold.takenAt !== undefined) settled = running || seq !== hold.takenAt ? null : hold;
    // Taken, and asked after a rejoin that brought the turn whole — the line already in the
    // thread (codex on PR 1232) — the hold has nothing left to wait for. The thread is searched
    // for the turn the answer names, not for the words: the same words said again in another
    // window are another turn. A thread that has only moved may have moved for another window's
    // edit, so otherwise the turn itself is awaited.
    else if (answer === true) {
      const shown = hold.asked === true && result?.turnId !== undefined
        && (workspace?.messages ?? []).some((m) => m.role === "user" && m.turnId === result.turnId);
      settled = running || shown ? null : { ...hold, takenAt: seq };
    }
    else if (next.rejoins !== hold.rejoins && next.connection === "open") {
      // Asked once per rejoin, after this change has landed.
      settled = { ...hold, rejoins: next.rejoins, asked: true };
      queueMicrotask(() => askWorldChatSendStatus(hold.worldId, conversationId, hold.requestId));
    }
    if (settled === hold) continue;
    holds ??= { ...next.worldChatHolds };
    if (settled === null) delete holds[conversationId];
    else holds[conversationId] = settled;
  }
  return holds === null ? next : { ...next, worldChatHolds: holds };
}

export function emitChange(next: StoreState): void {
  const was = current.state?.world?.meta.worldId ?? null;
  const now = next.state?.world?.meta.worldId ?? null;
  // A line held for a world that has since closed has nothing left to wait for (codex on PR
  // 1232): its answer belongs to that world's session, and coming back to it is no rejoin, so
  // it would never be asked after.
  if (now !== was && Object.values(next.worldChatHolds).some((hold) => hold.worldId !== now)) {
    next = { ...next, worldChatHolds: Object.fromEntries(Object.entries(next.worldChatHolds).filter(([, hold]) => hold.worldId === now)) };
  }
  next = settleHolds(next);
  current = next;
  if (now !== was) {
    gateRequests.clear();
    gateAnswers.clear();
    for (const l of worldListeners) l(now);
  }
  for (const l of listeners) l();
}

/** Test hook: apply one event to a state, so a reducer can be pinned without a socket. */
export function __applyForTest(state: ClientState, event: DomainEvent): ClientState {
  return fold(state, event);
}

/** The store folds exactly what the coordinator's read model folds: one function (issue 2799). */
function fold(state: ClientState, event: DomainEvent): ClientState {
  return applyClientStateEvent(state, event) ?? state;
}

/**
 * Fold the snapshot's live authoring runs into what this client has seen (issue 239).
 *
 * `authoring` is otherwise built only from events, so a client that reloads while the studio is
 * drafting comes back with nothing for a run that is still going — and reads that absence as a
 * settled proposal, offering Accept and Discard over files an agent is still writing.
 *
 * Seeding only, deliberately. A proposal the snapshot leaves out is one nothing is writing into
 * now, but *how* an unseen run ended is not something a snapshot can say; inventing an ending
 * would be the same false claim in the other direction. Entries already held keep their progress
 * lines — it is the same run, joined further along — but never an earlier turn's `detail`, which
 * described that turn and not this one.
 */
export function seedLiveRuns(
  activity: Record<string, AuthoringActivity>,
  runs: readonly string[],
): Record<string, AuthoringActivity> {
  if (runs.length === 0) return activity;
  const next = { ...activity };
  for (const proposalId of runs) {
    const existing = next[proposalId];
    if (existing?.status === "running") continue;
    next[proposalId] = { status: "running", lines: existing?.lines ?? [] };
  }
  return next;
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
const snapshotPages = new SnapshotPageBuffer();
// The last snapshot barrier this window applied, the collections it left, and whether the
// reconnect in flight presented it (issue 2798). A resumed delivery sends only the rows changed
// since that barrier, so its pages build on the collections the barrier left, not on what events
// have done to them since: a row an event added and the coordinator later dropped would otherwise
// survive the reconnect (codex on PR 2859). Any recovery asks for a full delivery instead.
let resumeToken: string | null = null;
let resumeBase: { artifacts: NonNullable<ClientState["world"]>["artifacts"]; jobs: ClientState["app"]["jobs"]; ledger: ClientState["app"]["ledger"] } | null = null;
let resuming = false;
function fullHello(): void {
  resumeToken = null;
  resumeBase = null;
  resuming = false;
  send({ kind: "hello", lastSeq, retainHistory: true, pagedSnapshots: true, resumable: true });
}
/** The base a delivery's pages build on: none after a reconnect unless it resumed, then the barrier's collections. */
function pageBase(): ClientState | null {
  if (!rejoining) return current.state;
  if (!resuming || !resumeBase || !current.state) return null;
  return { ...current.state, world: current.state.world ? { ...current.state.world, artifacts: resumeBase.artifacts } : null,
    app: { ...current.state.app, jobs: resumeBase.jobs, ledger: resumeBase.ledger } };
}

function handleFrame(json: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { console.error("[arke] dropped malformed frame"); return; }
  // Gateway refusals have no coordinator sequence: they neither advance nor reset replay state.
  try {
    const refusal = RemoteCommandRefusalSchema.safeParse(parsed);
    if (refusal.success) {
      if (refusal.data.refused === "invalid") refuseInvalidCommand(refusal.data);
      else for (const listener of remoteRefusalListeners) listener(refusal.data);
      return;
    }
  } catch { /* The normal frame parser reports malformed input below. */ }

  let frame;
  try {
    frame = parseIncomingFrame(parsed);
  } catch {
    // A frame that fails its schema is a coordinator/client version skew — drop loudly.
    console.error("[arke] dropped malformed frame");
    return;
  }
  lastSeq = frame.seq;
  if (frame.kind === "snapshot-page") {
    try { snapshotPages.append(frame.snapshot, frame.page, pageBase()); }
    catch { snapshotPages.clear(); fullHello(); }
    return;
  }
  if (frame.kind === "studio-assistant") {
    for (const listener of studioAssistantReplyListeners) {
      try { listener(frame); } catch { /* A private panel cannot interrupt shared state folding. */ }
    }
    return;
  }
  if (frame.kind === "snapshot") {
    if (frame.collectionSnapshot !== undefined && !snapshotPages.finish(frame.collectionSnapshot, frame.state, pageBase())) {
      fullHello(); return;
    }
    if (frame.collectionSnapshot === undefined) snapshotPages.clear();
    else {
      resumeToken = frame.resume ?? null; resuming = false;
      resumeBase = { artifacts: frame.state.world?.artifacts ?? [], jobs: frame.state.app.jobs, ledger: frame.state.app.ledger };
    }
    if (frame.retainedHistory?.length) {
      if (!current.state || rejoining) { fullHello(); return; }
      if (frame.retainedHistory.includes("jobs")) frame.state.app.jobs = current.state.app.jobs;
      if (frame.retainedHistory.includes("ledger")) frame.state.app.ledger = current.state.app.ledger;
    }
    frame.state = shareSnapshot(current.state, frame.state);
    if (helloFallbackTimer) clearTimeout(helloFallbackTimer);
    helloFallbackTimer = null;
    frameRunQuoteListeners.clear();
    frameRunStartResultListeners.clear();
    // Prune notices for proposals the snapshot no longer carries — and "the studio is still
    // drafting" for any run the snapshot says has since ended. That refusal describes the run
    // rather than the proposal, so unlike its siblings it must not wait for a resolution to
    // clear: left standing it contradicts the Accept it is sitting beside (review of PR 371).
    const openIds = new Set((frame.state.world?.proposals ?? []).map((p) => p.proposal.id));
    const liveRuns = new Set<string>(frame.state.authoringRuns);
    const gateNotices = Object.fromEntries(
      Object.entries(current.gateNotices).filter(
        ([id, notice]) => openIds.has(id) && (notice.reason !== "drafting" || liveRuns.has(id)),
      ),
    );
    const changedWorld = current.state?.world?.meta.worldId !== frame.state.world?.meta.worldId;
    const rejoined = rejoining;
    rejoining = false;
    // Only hello gets a replay. Refreshes have missed no events; clearing live state here
    // would hide permissions and Stop controls until another progress event happened.
    if (rejoined) lastTallProgress.clear();
    if (changedWorld || rejoined) forgetDoorAsks();
    const authoring = seedLiveRuns(current.authoring, frame.state.authoringRuns);
    const durableVoiceAudio: StoreState["voiceAudio"] = {};
    for (const job of frame.state.app.jobs) {
      if (job.target.kind !== "voice-preview" || typeof job.params["requestId"] !== "string") continue;
      const requestId = job.params["requestId"] as string;
      if (job.status !== "succeeded" || !job.landedFiles?.[0]) {
        if (job.status !== "failed" && job.status !== "cancelled" && job.status !== "needs-reconciliation")
          continue;
        durableVoiceAudio[requestId] = {
          at: job.updatedAt,
          type: "voice.audio" as const,
          requestId,
          worldId: job.worldId,
          ...voiceJobReadIdentity(job),
          sheetVersion: Number(job.params["sheetVersion"]),
          ...(job.params["sectionHeading"] ? { sectionHeading: String(job.params["sectionHeading"]) } : {}),
          provider: job.provider as ProviderId,
          model: job.model,
          voiceId: String(job.params["voiceId"]),
          format: voiceJobFormat(job),
          status: "failed" as const,
          file: null,
          cached: false,
          characterCount: Number(job.params["characterCount"] ?? 0),
          estimatedMicroUsd: job.estimatedMicroUsd,
          error: "Voice synthesis needs attention in Activity.",
        };
        continue;
      }
      durableVoiceAudio[requestId] = {
        at: job.updatedAt,
        type: "voice.audio" as const,
        requestId,
        worldId: job.worldId,
        ...voiceJobReadIdentity(job),
        sheetVersion: Number(job.params["sheetVersion"]),
        ...(job.params["sectionHeading"] ? { sectionHeading: String(job.params["sectionHeading"]) } : {}),
        provider: job.provider as ProviderId,
        model: job.model,
        voiceId: String(job.params["voiceId"]),
        format: voiceJobFormat(job),
        status: "ready" as const,
        file: job.landedFiles[0],
        cached: true,
        characterCount: Number(job.params["characterCount"] ?? 0),
        estimatedMicroUsd: job.estimatedMicroUsd,
      };
    }
    emitChange({
      ...current,
      state: frame.state,
      gateNotices,
      authoring,
      permissions: rejoined ? {} : current.permissions,
      // Keyed by entry id alone, and canon ids restart at CANON-001 in every world: the previous
      // world's entry would otherwise supply the history, citations and ripples for the
      // same-numbered entry in the next one, until its own answer arrived to replace them.
      canonRefs: changedWorld ? {} : current.canonRefs,
      sheetRefs: changedWorld ? {} : current.sheetRefs,
      voiceCandidates: changedWorld ? {} : current.voiceCandidates,
      voiceClips: changedWorld ? {} : current.voiceClips,
      voiceCloned: changedWorld ? null : current.voiceCloned,
      voiceCatalogue: changedWorld ? null : current.voiceCatalogue,
      voiceCatalogueHeld: changedWorld ? null : current.voiceCatalogueHeld,
      voicePreviews: changedWorld ? {} : current.voicePreviews,
      voiceAudio: { ...(changedWorld ? {} : current.voiceAudio), ...durableVoiceAudio },
      voiceParts: changedWorld ? {} : current.voiceParts,
      // A snapshot carrying the world has ended its open, whatever event was missed on the way,
      // and a window that rejoined is told again by the replay if the open is still going.
      worldOpenProgress: rejoined || frame.state.world?.meta.worldId === current.worldOpenProgress?.worldId ? null : current.worldOpenProgress,
      // These run maps include world id in their keys. Keep live events across navigation;
      // only a reconnect may have missed an ending and needs to rebuild from hello's replay.
      deriving: rejoined ? {} : Object.fromEntries(Object.entries(current.deriving).filter(([, run]) => run.state === "deriving")),
      casting: rejoined ? {} : Object.fromEntries(Object.entries(current.casting).filter(([, run]) => run.state === "casting")),
      // The audiobook's runs (turn 146) carry what the replay cannot: the counts, and a price
      // waiting on its answer. A refresh follows every take that lands, on a connection that
      // has missed nothing, so a refresh keeps them — reset, the replayed start put `reading… 0
      // of 0` over the head and closed the price sheet (the door's live check on slice 3). A
      // window that rejoined starts from the replay, which says what is still going and nothing
      // of what ended while it was away.
      audiobook: rejoined ? {} : current.audiobook,
      // A card answered — proposed, accepted, failed — is this window's to put away (turn 146):
      // a snapshot follows every accept, and would otherwise take the ✓ line with it. Only a
      // reconnect drops a derivation still going, since hello's replay restores it when it is.
      direction: rejoined ? Object.fromEntries(Object.entries(current.direction).filter(([, held]) => held.state !== "directing")) : current.direction,
      // A replay restores a proposal held or a run going; what ended while this window was away is not kept.
      illustration: rejoined ? {} : current.illustration,
      audiobookRecords: changedWorld ? {} : current.audiobookRecords,
      // As a direction: reconnect alone drops a grouping before hello's replay restores it.
      beats: rejoined ? Object.fromEntries(Object.entries(current.beats).filter(([, held]) => held.state !== "grouping")) : current.beats,
      stagedTakes: changedWorld ? {} : current.stagedTakes,
      speakerLines: changedWorld ? {} : current.speakerLines,
      narratorQuotes: changedWorld ? {} : current.narratorQuotes,
      heardLines: changedWorld ? {} : current.heardLines,
      // A reconnect replays no answer to a question in flight (codex on PR 1479): the asker asks again.
      audiobookAsks: changedWorld || rejoined ? {} : current.audiobookAsks,
      audiobookDoor: changedWorld ? {} : current.audiobookDoor,
      audiobookCredits: changedWorld ? {} : current.audiobookCredits,
      // Book state uses production id alone, unlike the world-keyed chapter runs above.
      audiobookBook: changedWorld || rejoined ? {} : current.audiobookBook,
      audiobookNotes: changedWorld ? {} : current.audiobookNotes,
      // Both are keyed by sheet slug alone, and slugs recur across worlds: a failure left over
      // from one world would otherwise surface under the same-named character in the next one
      // (PR 241 review). They describe an action just taken here, so they do not outlive it.
      // No "#" before that number anywhere under src/: the hard-coded-colour rule reads it as a
      // three-digit hex and fails the token test.
      mainPhotoAcceptance: changedWorld ? {} : current.mainPhotoAcceptance,
      characterSheetAcceptance: changedWorld ? {} : current.characterSheetAcceptance,
      locationViewUpload: changedWorld ? {} : current.locationViewUpload,
      // Quotes authorize the exact snapshot used to compile them. A snapshot supersedes that
      // read even in the same world, so no quote survives reconnect or refresh.
      frameRunQuotes: {},
      frameRunStartResults: {},
      frameRunRequestEpoch: current.frameRunRequestEpoch + 1,
      rejoins: current.rejoins + (rejoined ? 1 : 0),
    });
  } else if (current.state) {
    let gateNotices = current.gateNotices;
    let authoring = current.authoring;
    let transcripts = current.transcripts;
    let genesis = current.genesis;
    let buildPlans = current.buildPlans;
    let keyArtPlans = current.keyArtPlans;
    let reading = current.reading;
    let deriving = current.deriving;
    let casting = current.casting;
    let audiobook = current.audiobook;
    let direction = current.direction;
    let illustration = current.illustration;
    let audiobookRecords = current.audiobookRecords;
    let beats = current.beats;
    let stagedTakes = current.stagedTakes;
    let speakerLines = current.speakerLines;
    let narratorQuotes = current.narratorQuotes;
    let heardLines = current.heardLines;
    let audiobookAsks = current.audiobookAsks;
    let audiobookDoor = current.audiobookDoor;
    let audiobookCredits = current.audiobookCredits;
    let audiobookBook = current.audiobookBook;
    let audiobookNotes = current.audiobookNotes;
    let manuscripts = current.manuscripts;
    let archiveNote = current.archiveNote;
    let setupStatus = current.setupStatus;
    let permissions = current.permissions;
    const event = frame.event;
    let frameRunQuotes = current.frameRunQuotes;
    let frameRunStartResults = current.frameRunStartResults;
    emitEvent(event);
    if (event.type === "command.failed") {
      if (event.requestId) pendingQueueRequests.delete(event.requestId);
      if (event.command === "make-audiobook-picture" && event.requestId && audiobookAsks[event.requestId]?.state === "working") {
        audiobookAsks = { ...audiobookAsks, [event.requestId]: { state: "failed", reason: event.reason } };
      }
      // A Draft refused before it ran (a world no longer open) sends no last word of its own; the
      // page stops saying Drafting with the refusal on the toaster (issue 2796).
      if (event.command === "draft-guide-description" && event.requestId) forgetGuideDrafting(event.requestId);
      for (const listener of commandFailureListeners) listener(event);
    }
    if (event.type === "queue.enqueue-result") {
      const expected = pendingQueueRequests.get(event.requestId);
      if (expected?.command === event.command) {
        pendingQueueRequests.delete(event.requestId);
        const result = {
          ...event,
          ...(expected.characterName ? { characterName: expected.characterName } : {}),
        };
        for (const listener of queueResultListeners) listener(result);
      }
    }
    if (event.type === "voice.upload-confirmation-required") {
      const expected = pendingQueueRequests.get(event.requestId);
      // The question is a pause in the request, not its end (SPEC-046 R-39): a page with a
      // cloned narrator and a cloned speaker is asked twice under one id, and the answer re-sends
      // the same id without registering it again. The entry goes with the enqueue result, or
      // with the connection.
      if (expected?.command === event.command) {
        for (const listener of voiceUploadConfirmationListeners) listener(event);
      }
    }
    if (event.type === "audiobook.activity") for (const listener of audiobookActivityListeners) listener(event.run);
    if (event.type === "job.ready") {
      for (const listener of jobReadyListeners) listener(event.job);
    }
    if (event.type === "recovery.notice") {
      const key = `${event.notice.incidentId}:${event.notice.at}:${event.notice.reason}`;
      if (!seenRecoveryNotices.has(key)) {
        seenRecoveryNotices.add(key);
        if (seenRecoveryNotices.size > 256) seenRecoveryNotices.delete(seenRecoveryNotices.values().next().value!);
        const history = current.state?.app.recoveryHistory;
        if (history?.audit === "available" && !history.preferences.transientMuted) {
          for (const listener of recoveryNoticeListeners) try { listener(event.notice, history); } catch { /* Alert delivery cannot interrupt state folding. */ }
        }
      }
    }
    if (event.type === "chapter.create-result") {
      for (const listener of chapterCreateListeners) listener(event);
      issuedChapterCreates.delete(event.requestId);
    }
    if (event.type === "prompt-tools.result") for (const listener of promptToolsListeners) listener(event);
    if (event.type === "media.measured") for (const listener of mediaMeasurementListeners) listener(event);
    if (event.type === "chapter.version-result") {
      for (const listener of chapterVersionListeners) listener(event);
    }
    if (event.type === "drama.source") {
      for (const listener of dramaSourceListeners) listener(event);
    }
    if (event.type === "drama.edition" || event.type === "drama.editions") {
      for (const listener of dramaEditionListeners) listener(event.type === "drama.edition"
        ? { requestId: event.requestId, editions: event.edition ? [event.edition] : [], ...(event.refused ? { refused: event.refused } : {}) }
        : { requestId: event.requestId, editions: event.editions, ...(event.mixes ? { mixes: event.mixes } : {}) });
    }
    if (event.type === "scene.create-result") {
      for (const listener of sceneCreateListeners) listener(event);
      // Forgotten after the listeners have asked, so a late duplicate reads as someone else's.
      issuedSceneCreates.delete(event.requestId);
    }
    if (event.type === "production.frame-run-quote") {
      const listeners = frameRunQuoteListeners.get(event.quote.requestId);
      frameRunQuoteListeners.delete(event.quote.requestId);
      if (listeners !== undefined) {
        frameRunQuotes = { ...frameRunQuotes, [event.quote.requestId]: event.quote };
        for (const listener of listeners) listener(event);
      }
    }
    if (event.type === "production.frame-run-start-result") {
      const key = frameRunStartKey(event.requestId, event.quoteId);
      const listeners = frameRunStartResultListeners.get(key);
      frameRunStartResultListeners.delete(key);
      if (listeners !== undefined) {
        frameRunStartResults = { ...frameRunStartResults, [key]: event };
        for (const listener of listeners) listener(event);
        // The listener consumes this one-shot result. Remove it from the pending fold rather
        // than relying on clearFrameRunStartResult, whose emit happens before this frame's final
        // emit and would otherwise be overwritten by the cached local value below.
        delete frameRunStartResults[key];
      }
    }
    if (event.type === "audiobook.tall-progress") {
      lastTallProgress.set(`${event.worldId}/${event.productionId}`, event);
      for (const listener of audiobookTallProgressListeners) listener(event);
    }
    if (event.type === "audiobook.video-exported") {
      for (const listener of audiobookVideoExportedListeners) listener(event);
    }
    if (event.type === "guide.drafting") noteGuideDrafting(event);
    if (event.type === "audio-studio.heard") for (const listener of audioHeardListeners) listener(event);
    if (event.type === "conversation-action.take-review-prepared") {
      for (const listener of takeReviewPreparedListeners) listener(event);
    }
    if (event.type === "proposal.blocked") {
      if (event.requestId !== undefined && gateRequests.has(event.requestId)) gateAnswers.add(event.requestId);
      gateNotices = {
        ...gateNotices,
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
      gateNotices = { ...gateNotices };
      delete gateNotices[event.proposalId];
      authoring = { ...authoring };
      delete authoring[event.proposalId];
    } else if (event.type === "authoring.progress") {
      const existing = authoring[event.proposalId] ?? { status: "running" as const, lines: [] };
      authoring = {
        ...authoring,
        [event.proposalId]: { ...existing, lines: [...existing.lines.slice(-19), event.line] },
      };
    } else if (event.type === "authoring.turn") {
      transcripts = {
        ...transcripts,
        [event.proposalId]: [
          ...(transcripts[event.proposalId] ?? []),
          { role: event.role, text: event.text, at: event.at },
        ],
      };
    } else if (event.type === "setup.status") {
      setupStatus = event.setup;
    } else if (event.type === "genesis.image-error") {
      genesis = { ...genesis, [event.genesisId]: { ...emptyGenesis(), ...genesis[event.genesisId], imageError: event.detail, decisionPending: undefined } };
    } else if (event.type === "genesis.images") {
      genesis = { ...genesis, [event.genesisId]: { ...emptyGenesis(), ...genesis[event.genesisId], images: event.images, imageError: undefined, readiness: undefined, decisionPending: genesis[event.genesisId]?.decisionPending === "image" ? undefined : genesis[event.genesisId]?.decisionPending } };
    } else if (event.type === "genesis.voices") {
      genesis = { ...genesis, [event.genesisId]: { ...emptyGenesis(), ...genesis[event.genesisId], voices: event.voices, voiceError: undefined, readiness: undefined, decisionPending: genesis[event.genesisId]?.decisionPending === "voice" ? undefined : genesis[event.genesisId]?.decisionPending } };
    } else if (event.type === "genesis.readiness") {
      genesis = { ...genesis, [event.genesisId]: { ...emptyGenesis(), ...genesis[event.genesisId], readiness: event.review, readinessError: undefined, readinessPending: false } };
    } else if (event.type === "genesis.import-error") {
      genesis = { ...genesis, [event.genesisId]: { ...emptyGenesis(), ...genesis[event.genesisId], importError: event.detail, decisionPending: undefined } };
    } else if (event.type === "genesis.imports") {
      genesis = { ...genesis, [event.genesisId]: { ...emptyGenesis(), ...genesis[event.genesisId], imports: event.imports, importError: undefined, readiness: undefined, decisionPending: genesis[event.genesisId]?.decisionPending === "import" ? undefined : genesis[event.genesisId]?.decisionPending } };
    } else if (event.type === "genesis.chat-result") {
      const draft = genesis[event.genesisId];
      if (draft?.chatSubmission?.requestId === event.requestId) {
        genesis = { ...genesis, [event.genesisId]: { ...draft, chatPending: event.accepted ? draft.chatPending : false, chatSubmission: undefined,
          ...(!event.accepted ? { rejectedChat: draft.chatSubmission.text, chatError: event.detail } : {}),
        } };
      }
    } else if (event.type === "genesis.review-error") {
      const draft = genesis[event.genesisId] ?? emptyGenesis();
      if (event.area !== "content" || draft.reviewRequestId === event.requestId) {
        genesis = { ...genesis, [event.genesisId]: { ...draft,
          ...(event.area === "content" ? { reviewError: event.detail, reviewPending: false } : event.area === "readiness" ? { readinessError: event.detail, readinessPending: false } : { voiceError: event.detail, decisionPending: draft.decisionPending === "voice" ? undefined : draft.decisionPending }),
        } };
      }
    } else if (event.type === "genesis.review") {
      if (genesis[event.genesisId]?.reviewRequestId === event.requestId) {
        genesis = { ...genesis, [event.genesisId]: { ...emptyGenesis(), ...genesis[event.genesisId], review: event.review, reviewError: undefined, reviewPending: false, readiness: undefined } };
      }
    } else if (event.type === "genesis.discarded") {
      discardedGenesis.add(event.genesisId);
      genesis = { ...genesis };
      delete genesis[event.genesisId];
    } else if (event.type === "genesis.loaded") {
      if (discardedGenesis.has(event.genesisId)) return;
      if ((event.revision ?? 0) < (genesis[event.genesisId]?.revision ?? 0)) return;
      const messages = new Map(event.turns.map(turn => [turn.id, turn]));
      for (const turn of genesis[event.genesisId]?.turns ?? []) {
        if (turn.id && !messages.has(turn.id)) messages.set(turn.id, { ...turn, id: turn.id });
      }
      genesis = { ...genesis, [event.genesisId]: {
        ...emptyGenesis(), ...genesis[event.genesisId],
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
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = {
        ...genesis,
        [event.genesisId]: {
          ...g,
          turns: event.messageId && g.turns.some(t => t.id === event.messageId) ? g.turns :
            [...g.turns, { ...(event.messageId ? { id: event.messageId } : {}), role: event.role, text: event.text, at: event.at }],
        },
      };
    } else if (event.type === "genesis.blueprint") {
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = { ...genesis, [event.genesisId]: { ...g, blueprint: event.blueprint, revision: event.revision, readiness: undefined, review: undefined, reviewRequestId: ulid() } };
    } else if (event.type === "world-image.plan") {
      keyArtPlans = {
        ...keyArtPlans,
        [event.worldId]: {
          requestId: event.requestId,
          prompt: event.prompt,
          promptReviewId:event.promptReviewId,modelId:event.modelId,fixedConstraints:event.fixedConstraints,candidate:event.candidate,review:event.review,reason:event.reason,sources:event.sources,
          carried: event.carried,
          dropped: event.dropped,
        },
      };
    } else if (event.type === "build.plan") {
      buildPlans = {
        ...buildPlans,
        [event.genesisId]: {
          ...buildPlans[event.genesisId],
          [event.requestId]: {
            requestId: event.requestId,
            plan: event.plan,
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
          },
        },
      };
    } else if (event.type === "genesis.status") {
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = {
        ...genesis,
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
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = { ...genesis, [event.genesisId]: { ...g, working: event.label } };
    } else if (event.type === "genesis.attachment") {
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = {
        ...genesis,
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
      archiveNote = {
        worldId: event.worldId,
        text: `${event.name} is in the archive folder, under ${event.folder}. Nothing was deleted.`,
        refused: false,
      };
    } else if (event.type === "world.archive-refused") {
      archiveNote = { worldId: event.worldId, text: event.reason, refused: true };
    } else if (event.type === "extraction.started") {
      reading = {
        ...reading,
        [event.artifactId]: { file: event.file, state: "reading", found: 0, dropped: 0 },
      };
    } else if (event.type === "extraction.finished") {
      reading = {
        ...reading,
        [event.artifactId]: {
          file: event.file,
          state: event.outcome === "found" ? "found" : event.outcome,
          found: event.found,
          dropped: event.dropped,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      };
    } else if (event.type === "continuity.started") {
      deriving = {
        ...deriving,
        [`${event.worldId}/${event.productionId}/${event.chapterId}`]: { state: "deriving", placed: 0, dropped: 0, omitted: 0, cut: 0 },
      };
    } else if (event.type === "continuity.finished") {
      deriving = {
        ...deriving,
        [`${event.worldId}/${event.productionId}/${event.chapterId}`]: {
          state: event.outcome,
          placed: event.placed,
          dropped: event.dropped,
          omitted: event.omitted,
          cut: event.cut,
          ...(event.record !== undefined ? { record: event.record } : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      };
    } else if (event.type === "manuscript.read-result") {
      manuscripts = {
        ...manuscripts,
        [event.requestId]:
          event.cancelled === true
            ? { state: "cancelled" }
            : event.reason !== undefined
            ? { state: "refused", ...(event.fileName !== undefined ? { fileName: event.fileName } : {}), reason: event.reason }
            : {
                state: "read",
                fileName: event.fileName ?? "",
                words: event.words ?? 0,
                chapters: event.chapters ?? [],
                ...(event.headingLevel !== undefined ? { headingLevel: event.headingLevel } : {}),
                leftOut: event.leftOut ?? 0,
                levels: event.levels ?? [],
                notes: event.notes ?? 0,
                links: event.links ?? 0,
                after: event.after ?? 0,
              },
      };
    } else if (event.type === "manuscript.import-result") {
      const held = manuscripts[event.requestId] ?? { state: "read" as const };
      manuscripts = {
        ...manuscripts,
        [event.requestId]:
          event.reason !== undefined
            ? { ...held, state: "failed", reason: event.reason }
            : { ...held, state: "imported", created: event.created ?? 0, ...(event.after !== undefined ? { after: event.after } : {}) },
      };
    } else if (event.type === "voices.started") {
      casting = {
        ...casting,
        [`${event.worldId}/${event.productionId}/${event.chapterId}`]: { state: "casting", lines: 0, dropped: 0, omitted: 0 },
      };
    } else if (event.type === "voices.record") {
      // A pin written or refused (turn 155): the record as it stands now, which the chapter takes
      // as it takes a finished cast's, or the refusal beside whatever the cast was.
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      const held = casting[key];
      casting = {
        ...casting,
        [key]:
          event.record !== undefined
            ? { state: "cast", lines: event.record.lines.length, dropped: event.record.dropped, omitted: event.record.omitted, record: event.record }
            : { ...(held ?? { state: "cast" as const, lines: 0, dropped: 0, omitted: 0 }), pinRefused: event.refused ?? "refused" },
      };
    } else if (event.type === "voices.finished") {
      casting = {
        ...casting,
        [`${event.worldId}/${event.productionId}/${event.chapterId}`]: {
          state: event.outcome,
          lines: event.lines,
          dropped: event.dropped,
          omitted: event.omitted,
          ...(event.record !== undefined ? { record: event.record } : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      };
    } else if (event.type === "audiobook.started") {
      // A replayed start tells a reconnecting window which run can be stopped. Keep progress
      // already observed if an older host also replays it on ordinary refreshes.
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      if (event.replayed !== true || audiobook[key] === undefined) {
        audiobook = {
          ...audiobook,
          [key]: {
            state: "reading", requestId: event.requestId, toMake: event.toMake, blocks: event.blocks, made: event.made ?? 0, flagged: 0,
            ...(event.requests !== undefined ? { requests: event.requests, groups: event.groups ?? [], request: event.request ?? 0 } : {}),
          },
        };
      }
      // The run's request is minted by the coordinator, so it is registered here rather than
      // at send time: a cloned voice's upload consent is routed by request (codex on PR 1180),
      // and without this entry the consent would be dropped on the floor and the run would
      // wait for an answer no window could give. A chapter read under the book carries the
      // book's request, whose command is registered already and stands (codex on PR 1187).
      if (!pendingQueueRequests.has(event.requestId)) pendingQueueRequests.set(event.requestId, { command: "read-audiobook-chapter" });
    } else if (event.type === "audiobook.priced") {
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      const held = audiobook[key] ?? { toMake: 0, blocks: 0, made: 0, flagged: 0 };
      audiobook = {
        ...audiobook,
        [key]: { ...held, state: "priced", price: { ...(event.previews !== undefined ? { previews: event.previews } : {}), characters: event.characters, estimatedMicroUsd: event.estimatedMicroUsd, confirmationToken: event.confirmationToken, voices: event.voices, notices: event.notices ?? [], ...(event.freePlan !== undefined ? { freePlan: event.freePlan } : {}), ...(event.requests !== undefined ? { requests: event.requests } : {}), ...(event.perParagraph !== undefined ? { perParagraph: event.perParagraph } : {}), ...(event.groupingUnavailable === true ? { groupingUnavailable: true } : {}), ...(event.toCast !== undefined ? { toCast: event.toCast } : {}) } },
      };
    } else if (event.type === "audiobook.request") {
      // A grouped request begins (design turn 185b): the margin darkens its bracket.
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      const held = audiobook[key];
      if (held !== undefined) audiobook = { ...audiobook, [key]: { ...held, request: event.index, requests: event.of, requestKeys: event.keys } };
    } else if (event.type === "audiobook.progress") {
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      const held = audiobook[key] ?? { state: "reading" as const, toMake: event.toMake, blocks: 0, made: 0, flagged: 0 };
      audiobook = {
        ...audiobook,
        [key]: {
          ...held,
          state: "reading",
          toMake: event.toMake,
          made: event.made,
          flagged: held.flagged + (event.outcome === "flagged" ? 1 : 0),
          last: { block: event.block, outcome: event.outcome, ...(event.reason !== undefined ? { reason: event.reason } : {}) },
        },
      };
    } else if (event.type === "audiobook.finished") {
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      const held = audiobook[key] ?? { toMake: 0, blocks: 0, made: 0, flagged: 0 };
      audiobook = {
        ...audiobook,
        [key]: {
          ...held,
          state: event.outcome,
          made: event.made,
          flagged: event.flagged,
          price: undefined,
          ...(event.record !== undefined ? { record: event.record } : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      };
    } else if (event.type === "audiobook.script") {
      if (speakerLines[event.requestId] !== undefined) {
        speakerLines = {
          ...speakerLines,
          [event.requestId]:
            event.refused !== undefined
              ? { kind: speakerLines[event.requestId]!.kind, state: "refused", refused: event.refused }
              : { kind: speakerLines[event.requestId]!.kind, state: "done", chapters: event.chapters, recorded: event.recorded, awaiting: event.awaiting, ...(event.output !== undefined ? { output: event.output } : {}), ...(event.lines !== undefined ? { lines: event.lines } : {}), ...(event.notCast !== undefined ? { notCast: event.notCast } : {}) },
        };
      }
    } else if (event.type === "audiobook.lines-staged") {
      if (speakerLines[event.requestId] !== undefined) {
        speakerLines = {
          ...speakerLines,
          [event.requestId]: event.refused !== undefined ? { kind: "files", state: "refused", refused: event.refused } : { kind: "files", state: "done", rows: event.rows },
        };
      }
    } else if (event.type === "audiobook.narrator-quote") {
      if (narratorQuotes[event.requestId] !== undefined) {
        narratorQuotes = {
          ...narratorQuotes,
          [event.requestId]:
            event.refused !== undefined
              ? { state: "refused", refused: event.refused }
              : { state: "done", stale: event.stale ?? 0, held: event.held ?? 0, directed: event.directed ?? 0, estimatedMicroUsd: event.estimatedMicroUsd ?? 0, kept: event.kept ?? 0 },
        };
      }
    } else if (event.type === "audiobook.heard") {
      if (heardLines[event.requestId] !== undefined) {
        heardLines = { ...heardLines, [event.requestId]: event.file !== undefined ? { state: "done", file: event.file } : event.quote !== undefined ? { state: "priced", ...event.quote } : { state: "refused", refused: event.refused ?? "could not hear it" } };
      }
    } else if (event.type === "direction.reads") {
      if (audiobookAsks[event.requestId] !== undefined) {
        audiobookAsks = { ...audiobookAsks, [event.requestId]: event.reads !== undefined ? { state: "reads", reads: event.reads } : { state: "refused", refused: event.refused ?? "could not read the book" } };
      }
    } else if (event.type === "illustration.started") {
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      // Older hosts also replay on refresh: a window already making pictures keeps its progress.
      if (illustration[key]?.state !== "making") illustration = { ...illustration, [key]: { state: "reading", skipped: [], without: [] } };
    } else if (event.type === "illustration.finished") {
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      const before = illustration[key];
      if (event.outcome === "proposed" && event.proposal !== undefined) {
        // What is left after a run keeps the author's skips for the rows still in it, and how the run ended.
        const present = new Set(event.proposal.rows.map((row) => row.block));
        const shown = new Map((before?.proposal?.rows ?? []).map((row) => [row.block, new Set(row.disagrees ?? [])]));
        illustration = {
          ...illustration,
          [key]: {
            state: "proposed",
            proposal: event.proposal,
            skipped: (before?.skipped ?? []).filter((block) => present.has(block)),
            // A row refused again is held again: consent to try it was for the run that just ended (codex on PR 1559).
            // So is one the run found a look disagreeing on that it never showed: the consent was not to that (codex on PR 1868).
            without: (event.proposal.refreshed === true && event.proposal.proposalId !== before?.proposal?.proposalId ? [] : before?.without ?? []).filter((block) => {
              const row = event.proposal!.rows.find((candidate) => candidate.block === block);
              return row !== undefined && row.refused === undefined && (row.disagrees ?? []).every((who) => shown.get(block)?.has(who) === true);
            }),
            ...((before?.state === "done" || before?.state === "stopped") && before.progress !== undefined ? { progress: before.progress } : {}),
          },
        };
      } else {
        illustration = { ...illustration, [key]: { state: event.outcome === "proposed" ? "failed" : event.outcome, skipped: [], without: [], ...(event.reason !== undefined ? { reason: event.reason } : {}) } };
      }
    } else if (event.type === "illustration.progress") {
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      const before = illustration[key];
      if (event.refused !== undefined) {
        // Refused before it began: the proposal stands, with the clause that says why.
        if (before !== undefined) illustration = { ...illustration, [key]: { ...before, state: before.proposal !== undefined ? "proposed" : before.state, refreshing: false, reason: event.refused } };
      } else {
        illustration = {
          ...illustration,
          [key]: {
            state: event.progress.state,
            ...(before?.proposal !== undefined ? { proposal: before.proposal } : {}),
            skipped: before?.skipped ?? [],
            without: before?.without ?? [],
            progress: event.progress,
          },
        };
      }
    } else if (event.type === "audiobook.looks") {
      if (audiobookAsks[event.requestId] !== undefined) audiobookAsks = { ...audiobookAsks, [event.requestId]: { state: "looks", usage: event.usage, ...(event.coverage === undefined ? {} : { coverage: event.coverage }) } };
    } else if (event.type === "audiobook.picture-suggestion") {
      if (audiobookAsks[event.requestId] !== undefined) {
        audiobookAsks = { ...audiobookAsks, [event.requestId]: event.suggestion !== undefined ? { state: "suggested", suggestion: event.suggestion } : { state: "refused", refused: event.refused ?? "no picture suggested" } };
      }
    } else if (event.type === "audiobook.picture-prompt") {
      if (audiobookAsks[event.requestId] !== undefined) {
        audiobookAsks = { ...audiobookAsks, [event.requestId]: event.prompt !== undefined ? { state: "prompt", prompt: event.prompt } : { state: "refused", refused: event.refused ?? "the prompt was not updated" } };
      }
    } else if (event.type === "audiobook.picture-made") {
      // A picture on its block carries the record it stands in, taken as any record write is: a window that has it
      // from this event alone shows the chip and the panel without waiting for a reopen.
      if (event.record !== undefined) {
        const recordKey = `${event.worldId}/${event.productionId}/${event.chapterId}`;
        audiobookRecords = { ...audiobookRecords, [recordKey]: { seq: (audiobookRecords[recordKey]?.seq ?? 0) + 1, requestId: event.requestId, record: event.record } };
      }
      if (audiobookAsks[event.requestId] !== undefined && event.state !== "making") {
        audiobookAsks = { ...audiobookAsks, [event.requestId]: event.state === "made" ? { state: "made", ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}) } : { state: "failed", reason: event.reason ?? "the picture was not made", ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}) } };
      }
    } else if (event.type === "audiobook.speaker-notes") {
      if (audiobookAsks[event.requestId] !== undefined) {
        audiobookAsks = { ...audiobookAsks, [event.requestId]: event.refused !== undefined ? { state: "refused", refused: event.refused } : { state: "drafted", drafted: event.drafted } };
      }
    } else if (event.type === "audiobook.lines-kept") {
      const held = speakerLines[event.requestId];
      if (held !== undefined) {
        speakerLines = { ...speakerLines, [event.requestId]: { ...held, state: "done", kept: event.kept, ...(event.refused !== undefined ? { refused: event.refused } : {}) } };
      }
    } else if (event.type === "audiobook.take-staged") {
      const held = stagedTakes[event.requestId];
      if (held !== undefined) {
        stagedTakes = {
          ...stagedTakes,
          [event.requestId]:
            event.refused !== undefined
              ? { ...held, state: "refused", refused: event.refused }
              : {
                  ...held,
                  state: "staged",
                  ...(event.file !== undefined ? { file: event.file } : {}),
                  checks: {
                    durationSec: event.durationSec ?? null,
                    sampleRateHz: event.sampleRateHz ?? null,
                    channels: event.channels ?? null,
                    rmsDbfs: event.rmsDbfs ?? null,
                    samplePeakDbfs: event.samplePeakDbfs ?? null,
                    noiseFloor: event.noiseFloor ?? "unavailable",
                    words: event.words ?? "unchecked",
                    differences: event.differences ?? 0,
                  },
                },
        };
      }
    } else if (event.type === "audiobook.record") {
      // A recording kept, or refused at the keep (turn 155c): its own answer, by its request id.
      if (event.requestId !== undefined && stagedTakes[event.requestId] !== undefined) {
        const { [event.requestId]: kept, ...rest } = stagedTakes;
        stagedTakes = event.record !== undefined ? rest : { ...rest, [event.requestId]: { ...kept!, state: "staged", refused: event.refused ?? "refused" } };
      }
      // A write outside a run (turn 146): the record, or why nothing was written. A card being
      // accepted takes the answer as its own — accepted, or refused and held for another try.
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      const seq = (audiobookRecords[key]?.seq ?? 0) + 1;
      audiobookRecords = { ...audiobookRecords, [key]: { seq, ...(event.requestId !== undefined ? { requestId: event.requestId } : {}), ...(event.record !== undefined ? { record: event.record } : {}), ...(event.refused !== undefined ? { refused: event.refused } : {}) } };
      // Only its own answer (codex on PR 1186): another window's block write lands as the same
      // event, and would otherwise mark the card accepted while the acceptance itself is still
      // on its way to a refusal it could no longer show.
      const card = direction[key];
      if (card?.state === "accepting" && event.requestId !== undefined && event.requestId === card.requestId) {
        direction = {
          ...direction,
          [key]: event.record !== undefined
            ? { ...card, state: "accepted", dropped: card.dropped + (event.dropped ?? 0), proposed: undefined, requestId: undefined }
            : { ...card, state: "directed", requestId: undefined, ...(event.refused !== undefined ? { reason: event.refused } : {}) },
        };
      }
    } else if (event.type === "audiobook.door") {
      // Any answer newer than the one shown, and only for the world that is open: an older
      // answer is older news, and one for a world since closed would repopulate a same-named
      // production in the next (codex on PR 1187).
      if (landDoorAnswer(event.worldId, event.productionId, event.requestId) && current.state?.world?.meta.worldId === event.worldId) {
        audiobookDoor = { ...audiobookDoor, [event.productionId]: { door: event.door, requestId: event.requestId, ...(event.refused !== undefined ? { refused: event.refused } : {}) } };
      }
    } else if (event.type === "audiobook.credits") {
      // Only for the world that is open: productions recur by name across worlds. A refusal keeps
      // the credits last shown, with its clause beside them.
      if (current.state?.world?.meta.worldId === event.worldId) {
        const held = audiobookCredits[event.productionId]?.credits ?? null;
        audiobookCredits = { ...audiobookCredits, [event.productionId]: { credits: event.credits ?? held, ...(event.refused !== undefined ? { refused: event.refused } : {}) } };
      }
    } else if (event.type === "audiobook.book-started") {
      // The book's state is keyed by production, and productions recur by name across worlds:
      // a run's late word from a world since closed is not this world's (codex on PR 1187).
      if (current.state?.world?.meta.worldId === event.worldId) {
        // A replayed start carries the counts the book has reached: a window that holds the
        // run keeps what it knows, and one that rejoined takes them.
        if (event.replayed !== true || audiobookBook[event.productionId] === undefined) {
          audiobookBook = {
            ...audiobookBook,
            [event.productionId]: { state: "reading", requestId: event.requestId, chapters: event.chapters, blocks: event.blocks, done: event.done ?? 0, chaptersRead: 0, chaptersRefused: 0, made: 0, flagged: 0 },
          };
        }
        // The book's request is the coordinator's (SPEC-047 R-17): a cloned voice's consent is
        // routed by it, so it is registered here as the chapter's is.
        pendingQueueRequests.set(event.requestId, { command: "read-audiobook-book" });
      }
    } else if (event.type === "audiobook.book-priced") {
      if (current.state?.world?.meta.worldId === event.worldId) {
        const held = audiobookBook[event.productionId] ?? { chapters: event.chapters, blocks: event.blocks, done: 0, chaptersRead: 0, chaptersRefused: 0, made: 0, flagged: 0 };
        audiobookBook = { ...audiobookBook, [event.productionId]: { ...held, state: "priced", price: event } };
      }
    } else if (event.type === "audiobook.book-progress") {
      if (current.state?.world?.meta.worldId === event.worldId) {
        const held = audiobookBook[event.productionId] ?? { chapters: event.chapters, blocks: 0, done: 0, chaptersRead: 0, chaptersRefused: 0, made: 0, flagged: 0 };
        audiobookBook = { ...audiobookBook, [event.productionId]: { ...held, state: "reading", done: event.done, chapters: event.chapters } };
      }
    } else if (event.type === "audiobook.book-finished") {
      if (current.state?.world?.meta.worldId === event.worldId) {
        const held = audiobookBook[event.productionId] ?? { chapters: 0, blocks: 0, done: 0, chaptersRead: 0, chaptersRefused: 0, made: 0, flagged: 0 };
        audiobookBook = {
          ...audiobookBook,
          [event.productionId]: {
            ...held,
            state: event.outcome,
            price: undefined,
            chaptersRead: event.chaptersRead,
            chaptersRefused: event.chaptersRefused,
            made: event.made,
            flagged: event.flagged,
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
          },
        };
      }
    } else if (event.type === "audiobook.conformed") {
      if (current.state?.world?.meta.worldId === event.worldId) {
        audiobookNotes = { ...audiobookNotes, [event.productionId]: { dropped: event.dropped, held: event.held ?? 0, chapters: event.chapters, seq: (audiobookNotes[event.productionId]?.seq ?? 0) + 1 } };
      }
    } else if (event.type === "audiobook.beats") {
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      beats = {
        ...beats,
        [key]: {
          state: event.outcome,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
          ...(event.before !== undefined ? { before: event.before } : {}),
          ...(event.after !== undefined ? { after: event.after } : {}),
        },
      };
    } else if (event.type === "direction.started") {
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      // Older hosts also replay on refresh: a window already directing keeps its progress.
      if (direction[key]?.state !== "directing" && direction[key]?.state !== "accepting") direction = { ...direction, [key]: { state: "directing", directed: 0, dropped: 0 } };
    } else if (event.type === "direction.finished") {
      const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      const before = direction[key];
      // A held proposal replay must not re-arm its Accept while its write is pending or after
      // that write was acknowledged. Only a genuinely new proposal replaces that decision.
      const decided = event.proposalId !== undefined && event.proposalId === before?.proposalId
        && (before.state === "accepting" || before.state === "accepted");
      if (!decided) {
        direction = {
          ...direction,
          [key]: {
            state: event.outcome,
            directed: event.directed,
            dropped: event.dropped,
            ...(event.summary !== undefined ? { summary: event.summary } : {}),
            ...(event.proposed !== undefined ? { proposed: event.proposed } : {}),
            ...(event.hash !== undefined ? { hash: event.hash } : {}),
            ...(event.chapterVersion !== undefined ? { chapterVersion: event.chapterVersion } : {}),
            ...(event.cast !== undefined ? { cast: event.cast } : {}),
            ...(event.castRecord !== undefined ? { castRecord: event.castRecord } : {}),
            ...(event.proposalId !== undefined ? { proposalId: event.proposalId } : {}),
            ...(event.proposed !== undefined ? { moved: Object.values(event.proposed).filter((input) => (input.delivery !== undefined && input.delivery !== "measured") || input.note !== undefined || input.speed !== 1 || input.cues.length > 0).length } : {}),
            ...(event.speakerNotes !== undefined ? { speakerNotes: event.speakerNotes } : {}),
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
          },
        };
      }
    } else if (event.type === "authoring.status") {
      const existing = authoring[event.proposalId] ?? { status: event.status, lines: [] };
      authoring = {
        ...authoring,
        [event.proposalId]: {
          ...existing,
          status: event.status,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        },
      };
      // The run this refusal was about has ended, and the buttons it explains are live again.
      if (event.status !== "running" && gateNotices[event.proposalId]?.reason === "drafting") {
        gateNotices = { ...gateNotices };
        delete gateNotices[event.proposalId];
      }
    } else if (event.type === "permission.pending") {
      permissions = {
        ...permissions,
        [event.permissionId]: {
          description: event.description,
          actionClass: event.actionClass,
          rememberable: event.rememberable,
        },
      };
    } else if (event.type === "permission.settled") {
      permissions = { ...permissions };
      delete permissions[event.permissionId];
    }
    let askResults = current.askResults;
    let canonSearches = current.canonSearches;
    let canonRefs = current.canonRefs;
    let sheetRefs = current.sheetRefs;
    let reconcileReport = current.reconcileReport;
    if (event.type === "queue.reconciled") {
      reconcileReport = event.report;
    }
    let voiceCandidates = current.voiceCandidates;
    let voiceClips = current.voiceClips;
    let voiceCloned = current.voiceCloned;
    let voiceCatalogue = current.voiceCatalogue;
    let voiceCatalogueHeld = current.voiceCatalogueHeld;
    let voiceCatalogueErrors = current.voiceCatalogueErrors;
    let cataloguePreview = current.cataloguePreview;
    let voicePreviews = current.voicePreviews;
    let voiceAudio = current.voiceAudio;
    let voiceParts = current.voiceParts;
    let dictation = current.dictation;
    let worldChatRefusals = current.worldChatRefusals;
    let worldChatWrapUpRefusals = current.worldChatWrapUpRefusals;
    let worldChatRipples = current.worldChatRipples;
    let worldChatProgress = current.worldChatProgress;
    let worldOpenProgress = current.worldOpenProgress;
    let voiceSidecar = current.voiceSidecar;
    let voiceRuntimeTest = current.voiceRuntimeTest;
    let mainPhotoAcceptance = current.mainPhotoAcceptance;
    let characterSheetAcceptance = current.characterSheetAcceptance;
    let locationViewUpload = current.locationViewUpload;
    if (event.type === "voice.catalogue") {
      voiceCatalogue = event.voices;
      voiceCatalogueHeld = event.voices;
      voiceCatalogueErrors = event.errors ?? [];
    }
    if (event.type === "voice.catalogue-preview") cataloguePreview = event;
    if (event.type === "voice.clip-staged") {
      voiceClips = {
        ...voiceClips,
        [event.requestId]: {
          clipId: event.clipId,
          fileName: event.fileName,
          seconds: event.seconds,
          reason: event.reason,
        },
      };
    }
    if (event.type === "voice.cloned") {
      voiceCloned = { voiceId: event.voiceId, label: event.label, reason: event.reason };
    }
    if (event.type === "voice.candidates") {
      voiceCandidates = {
        ...voiceCandidates,
        [event.sheetId]: {
          extracted: event.extracted,
          ranked: event.ranked,
          previewLine: event.previewLine,
          cloudPreviewMicroUsd: event.cloudPreviewMicroUsd,
          previewMicroUsdByVoice: event.previewMicroUsdByVoice,
          previewQuoteByVoice: event.previewQuoteByVoice,
          notices: event.notices,
        },
      };
    } else if (event.type === "voice.preview") {
      voicePreviews = {
        ...voicePreviews,
        [voiceTargetKey(event)]: { file: event.file, error: event.error },
      };
    } else if (event.type === "voice.audio") {
      /*
       * A long read arrives as several of these under one requestId (2026-08-24). Keyed by
       * request, each would overwrite the last and a screen would only ever see the final piece —
       * so the pieces are collected alongside, in the order the coordinator made them.
       *
       * The keyed entry still holds the newest event, because that is what every existing caller
       * reads for status, cost and errors, and none of them know about parts.
       */
      voiceAudio = { ...voiceAudio, [event.requestId]: event };
      if (event.part !== undefined && event.file) {
        const already = voiceParts[event.requestId] ?? [];
        const next = already.slice();
        next[event.part] = event.file;
        voiceParts = { ...voiceParts, [event.requestId]: next };
      }
    } else if (event.type === "dictation.result") {
      dictation = { ...dictation, [event.requestId]: { text: event.text, error: event.error } };
    } else if (event.type === "world-chat.create-result") {
      for (const listener of worldChatCreateListeners) listener(event);
    } else if (event.type === "world-chat.input-result") {
      const workspace = current.state?.worldChat;
      if (event.queue && current.state?.world?.meta.worldId === event.worldId && workspace?.conversationId === event.conversationId &&
        event.queue.revision >= (workspace.inputQueue?.revision ?? 0)) {
        emitChange({ ...current, state: { ...current.state!, worldChat: { ...workspace, inputQueue: event.queue } } });
      }
      for (const listener of inputResultListeners) listener(event);
    } else if (event.type === "world-chat.send-result") {
      sendResults = new Map([...sendResults, [event.requestId, event] as const].slice(-50));
      for (const listener of sendResultListeners) listener(event);
    } else if (event.type === "world-chat.upload-result") {
      browserUploadResults.get(event.requestId)?.(event.reason);
    } else if (event.type === "world-chat.attachment-refused") {
      // The last few only: a refusal is news for a moment, not a list to work through — the same
      // rule the composer applies to the ones it raises itself.
      worldChatRefusals = {
        ...worldChatRefusals,
        [event.conversationId]: [
          ...(worldChatRefusals[event.conversationId] ?? []).slice(-2),
          { name: event.name, reason: event.reason },
        ],
      };
    } else if (event.type === "world-chat.wrap-up-refused") {
      worldChatWrapUpRefusals = {
        ...worldChatWrapUpRefusals,
        [event.conversationId]: { requestId: event.requestId, detail: event.detail },
      };
    } else if (event.type === "world-chat.ripples") {
      worldChatRipples = {
        ...worldChatRipples,
        [event.conversationId]: { requestId: event.requestId, items: event.items },
      };
    } else if (event.type === "world-chat.progress") {
      worldChatProgress = {
        ...worldChatProgress,
        [event.conversationId]: { label: event.label, at: event.at },
      };
    } else if (event.type === "world.open-progress") {
      worldOpenProgress = {
        worldId: event.worldId,
        phase: event.phase,
        ...(event.done !== undefined ? { done: event.done } : {}),
        ...(event.total !== undefined ? { total: event.total } : {}),
      };
    } else if (event.type === "world.opened" || event.type === "world.open-failed") {
      if (worldOpenProgress?.worldId === event.worldId) worldOpenProgress = null;
    } else if (event.type === "voice.sidecar") {
      voiceSidecar = { state: event.state, detail: event.detail };
    } else if (event.type === "voice.runtime-test") {
      voiceRuntimeTest = {
        requestId: event.requestId,
        status: event.status,
        detail: event.detail,
        audioBase64: event.audioBase64,
      };
    } else if (event.type === "main-photo.acceptance") {
      // A cancelled dialog leaves no trace: it releases the button and says nothing, because
      // there is nothing to say about a choice the user declined to make.
      mainPhotoAcceptance = { ...mainPhotoAcceptance };
      if (event.status === "cancelled") delete mainPhotoAcceptance[event.sheetId];
      else {
        mainPhotoAcceptance[event.sheetId] = {
          status: event.status,
          ...(event.reason ? { reason: event.reason } : {}),
          candidateRetained: event.candidateRetained,
        };
      }
    } else if (event.type === "character-sheet.acceptance") {
      characterSheetAcceptance = { ...characterSheetAcceptance };
      if (event.status === "cancelled") delete characterSheetAcceptance[event.sheetId];
      else {
        characterSheetAcceptance[event.sheetId] = {
          status: event.status,
          ...(event.reason ? { reason: event.reason } : {}),
        };
      }
    } else if (event.type === "location-view.upload") {
      locationViewUpload = { ...locationViewUpload };
      if (event.status === "cancelled") delete locationViewUpload[event.sheetId];
      else {
        locationViewUpload[event.sheetId] = {
          status: event.status,
          ...(event.reason ? { reason: event.reason } : {}),
        };
      }
    }
    let importReport = current.importReport;
    let artifactNotices = current.artifactNotices;
    let attached = current.attached;
    if (event.type === "import.report") {
      importReport = {
        filed: event.filed,
        deduplicated: event.deduplicated,
        excluded: event.excluded,
        needsConsent: event.needsConsent,
      };
    } else if (event.type === "artifact.attached") {
      // Filing the same bytes twice is one artifact — so is its chip.
      attached = [
        ...attached.filter((a) => a.artifactId !== event.artifactId),
        { worldId: event.worldId, artifactId: event.artifactId, file: event.file, kind: event.kind },
      ];
    } else if (event.type === "artifact.notice") {
      artifactNotices = [
        ...artifactNotices.slice(-9),
        {
          sourcePath: event.sourcePath,
          outcome: event.outcome,
          reason: event.reason,
          sizeBytes: event.sizeBytes,
          ...(event.production !== undefined ? { production: event.production } : {}),
        },
      ];
    }
    let envCheck = current.envCheck;
    let diagnosticsBundle = current.diagnosticsBundle;
    let diagnostics = current.diagnostics;
    const recoveryCommandResults = event.type === "recovery.command-result"
      ? Object.fromEntries([...Object.entries(current.recoveryCommandResults).filter(([id]) => id !== event.result.requestId), [event.result.requestId, event.result] as const].slice(-32))
      : current.recoveryCommandResults;
    const recoveryActionResults = event.type === "recovery.action-result"
      ? Object.fromEntries([...Object.entries(current.recoveryActionResults).filter(([id]) => id !== event.result.requestId), [event.result.requestId, event.result] as const].slice(-32))
      : current.recoveryActionResults;
    const recoveryHistoryPages = event.type === "recovery.history-page"
      ? Object.fromEntries([...Object.entries(current.recoveryHistoryPages).filter(([id]) => id !== event.requestId), [event.requestId, event.page] as const].slice(-4))
      : current.recoveryHistoryPages;
    let providerCallsByJob = current.providerCallsByJob;
    if (event.type === "diagnostics.snapshot") {
      diagnostics = event.snapshot;
    }
    if (event.type === "env.check") {
      envCheck = {
        pathBudgetOk: event.pathBudgetOk,
        pathBudgetDetail: event.pathBudgetDetail,
        diskFreeMb: event.diskFreeMb,
        nativeIndexOk: event.nativeIndexOk,
        nativeIndexDetail: event.nativeIndexDetail,
      };
    } else if (event.type === "diagnostics.ready") {
      diagnosticsBundle = event.bundle;
    } else if (event.type === "provider-calls.ready") {
      providerCallsByJob = { ...providerCallsByJob, [event.jobId ?? "all"]: event.calls };
    }
    let exportsState = current.exportsState;
    if (event.type === "export.progress") {
      exportsState = {
        ...exportsState,
        [event.exportId]: {
          worldId: event.worldId,
          productionId: event.productionId,
          ...(event.episodeId !== undefined ? { episodeId: event.episodeId } : {}),
          status: event.status,
          percent: event.percent,
          output: event.output,
          ...(event.sidecar !== undefined ? { sidecar: event.sidecar } : {}),
          ...(event.deliveryKind !== undefined ? { deliveryKind: event.deliveryKind } : {}),
          ...(event.video !== undefined ? { video: event.video } : {}),
          ...(event.label !== undefined ? { label: event.label } : {}),
          ...(event.step !== undefined ? { step: event.step } : {}),
          ...(exportsState[event.exportId]?.made !== undefined ? { made: exportsState[event.exportId]!.made! } : {}),
          error: event.error,
        },
      };
    } else if (event.type === "audiobook.video-exported" && event.result.ok) {
      // The files an audiobook video made (design turn 197e), for its finished row in Activity.
      const held = exportsState[event.exportId];
      exportsState = {
        ...exportsState,
        [event.exportId]: { ...(held ?? { worldId: event.worldId, productionId: event.productionId, status: "done" as const, percent: 100, output: null, error: null }), deliveryKind: "audiobook-video", made: { dir: event.result.dir, files: event.result.files, ...(event.result.scope !== undefined ? { scope: event.result.scope } : {}), ...(event.result.chapterIds !== undefined ? { chapterIds: event.result.chapterIds } : {}) } },
      };
    }
    if (event.type === "canon.answer") {
      askResults = { ...askResults, [event.askId]: event.result };
    } else if (event.type === "canon.search") {
      canonSearches = {
        ...canonSearches,
        [event.searchId]: {
          searched: event.searched,
          floorCleared: event.floorCleared,
          candidates: event.candidates,
        },
      };
    } else if (event.type === "canon.refs" && event.worldId === current.state.world?.meta.worldId) {
      // Checked against the open world, as sheet.refs is: the answer is computed asynchronously
      // now that it reads the change log, so one for a world just switched away from can still
      // land here — and it would land on a live entry sharing its number (PR 540 review).
      //
      // Two for the same entry can also be in flight — the entry re-asks when canon moves — and
      // arrival order is not the order they were computed in. The one describing the later
      // revision wins, so an answer overtaken in flight cannot put the history back as it was.
      const held = canonRefs[event.entryId];
      if (held === undefined || event.canonRevision >= held.canonRevision) {
        canonRefs = {
          ...canonRefs,
          [event.entryId]: {
            citedBy: event.citedBy,
            history: event.history,
            historyTruncated: event.historyTruncated,
            canonRevision: event.canonRevision,
            ripples: event.ripples,
          },
        };
      }
    } else if (event.type === "sheet.refs" && event.worldId === current.state.world?.meta.worldId) {
      sheetRefs = {
        ...sheetRefs,
        [event.sheetId]: {
          tiles: event.tiles,
          productions: event.productions,
          artifacts: event.artifacts,
          scenes: event.scenes,
          takesByVersion: event.takesByVersion,
          incomingLinks: event.incomingLinks,
        },
      };
    }
    emitChange({
      ...current,
      state: fold(current.state, event),
      gateNotices,
      authoring,
      transcripts,
      genesis,
      buildPlans,
      keyArtPlans,
      setupStatus,
      reading,
      deriving,
      casting,
      audiobook,
      direction,
      illustration,
      audiobookRecords,
      beats,
      stagedTakes,
      speakerLines,
      narratorQuotes,
      heardLines,
      audiobookAsks,
      audiobookDoor,
      audiobookCredits,
      audiobookBook,
      audiobookNotes,
      manuscripts,
      archiveNote,
      permissions,
      askResults,
      canonSearches,
      canonRefs,
      sheetRefs,
      reconcileReport,
      voiceCandidates,
      voiceClips,
      voiceCloned,
      voiceCatalogue,
      voiceCatalogueHeld,
      voiceCatalogueErrors,
      cataloguePreview,
      voicePreviews,
      voiceAudio,
      voiceParts,
      dictation,
      worldChatRefusals,
      worldChatWrapUpRefusals,
      worldChatRipples,
      worldChatProgress,
      worldOpenProgress,
      voiceSidecar,
      voiceRuntimeTest,
      mainPhotoAcceptance,
      characterSheetAcceptance,
      locationViewUpload,
      exportsState,
      importReport,
      artifactNotices,
      attached,
      envCheck,
      diagnosticsBundle,
      diagnostics,
      recoveryCommandResults,
      recoveryActionResults,
      recoveryHistoryPages,
      providerCallsByJob,
      frameRunQuotes,
      frameRunStartResults,
    });
  }
}

function handleStatus(status: ConnectionStatus): void {
  snapshotPages.clear();
  // A run's last word may be lost with the socket. What it was is forgotten here, and a run still
  // going is told again by the coordinator when the window rejoins (codex on PR 2849).
  if (status !== "open" && guideDrafting.size > 0) {
    guideDrafting.clear();
    for (const listener of guideDraftingListeners) listener();
  }
  if (helloFallbackTimer) clearTimeout(helloFallbackTimer);
  helloFallbackTimer = null;
  if (status !== "open") pendingQueueRequests.clear();
  emitChange({ ...current, connection: status, ...(status !== "open" ? { genesis: Object.fromEntries(Object.entries(current.genesis).map(([id, draft]) => [id, { ...draft, chatPending: false, readinessPending: false, reviewPending: false, decisionPending: undefined }])) } : {}) });
  if (status === "open") {
    reconnectAttempts = 0;
    rejoining = true;
    // A window that still holds the collections of its last barrier presents it (issue 2798).
    resuming = resumeToken !== null && resumeBase !== null && current.state !== null;
    send({ kind: "hello", lastSeq, retainHistory: true, pagedSnapshots: true, resumable: true, ...(resuming && resumeToken !== null ? { resume: resumeToken } : {}) });
    // An older strict coordinator drops the new hello field without closing the socket.
    // One legacy hello restores startup after renderer HMR or a mixed-version restart.
    helloFallbackTimer = setTimeout(() => {
      helloFallbackTimer = null;
      if (current.connection === "open" && rejoining) send({ kind: "hello", lastSeq });
    }, 15_000);
    unref(helloFallbackTimer);
  }
  if (status === "closed") {
    const delay = Math.min(10_000, 500 * 2 ** reconnectAttempts++);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => bridge?.connect(), delay);
    unref(reconnectTimer);
  }
}

/**
 * Neither timer is a reason to keep a process alive. A page never exits on a timer, so this
 * changes nothing in the app; under Node it let twenty client test files finish instead of
 * sitting idle for up to 15 seconds after their last test (issue 2788). Browsers return a number.
 */
function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Try the connection again now rather than at the next backoff step. The launch surface's
 * "Try again" (design turn 158): someone on a phone who has just woken their computer should not
 * sit out a ten-second backoff to find out it worked.
 */
export function reconnectNow(): void {
  if (current.connection === "open" || current.connection === "connecting") return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempts = 0;
  bridge?.connect();
}

/** Dev fallback: the same bridge surface over a plain WebSocket to the dev coordinator. */
export function devBridge(url: string): ArkeBridge {
  let socket: WebSocket | null = null;
  let onFrame: ((json: string) => void) | null = null;
  let onStatus: ((s: ConnectionStatus) => void) | null = null;
  return {
    appVersion: "0.1.0-dev",
    platform: "browser",
    connect() {
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))
        return;
      onStatus?.("connecting");
      const connecting = new WebSocket(url, remoteSocketProtocols(url));
      socket = connecting;
      // Mobile network changes can leave the handshake pending for minutes. Release this
      // attempt so the store's backoff can reconnect, ignoring any late events from it.
      const timer = setTimeout(() => {
        if (socket !== connecting) return;
        socket = null;
        connecting.close();
        onStatus?.("closed");
      }, 10_000);
      connecting.addEventListener("open", () => {
        clearTimeout(timer);
        if (socket === connecting) onStatus?.("open");
      });
      connecting.addEventListener("close", (event) => {
        clearTimeout(timer);
        if (socket !== connecting) return;
        socket = null;
        if (isRemoteSession() && event.code === 1008 && event.reason === "session authentication required") {
          window.location.reload();
          return;
        }
        onStatus?.(event.code === 1008 && event.reason === "session authentication required" ? "auth-refused" : "closed");
      });
      connecting.addEventListener("message", (e) => {
        if (socket === connecting && typeof e.data === "string") onFrame?.(e.data);
      });
    },
    send(json) {
      if (socket?.readyState === WebSocket.OPEN) {
        const message = JSON.parse(json) as { kind?: string };
        socket.send(message.kind === "hello" ? JSON.stringify({ ...message, token: devSession()?.token }) : json);
      }
    },
    subscribe(frameCb, statusCb) {
      onFrame = frameCb;
      onStatus = statusCb;
    },
  };
}

/** Connect on app start. Preload bridge in Electron; dev WebSocket in a plain browser. */
export function initStore(): void {
  if (bridge) return;
  const devUrl = (import.meta.env?.VITE_ARKE_WS as string | undefined) ?? "ws://127.0.0.1:8791";
  bridge = window.arke ?? devBridge(remoteSocketUrl() ?? devUrl);
  bridge.subscribe(handleFrame, handleStatus);
  bridge.connect();
}

export function send(msg: ClientMessage): boolean {
  if (isRemoteSession() && isRemoteHostCommand(msg)) {
    if ("requestId" in msg && typeof msg.requestId === "string") pendingQueueRequests.delete(msg.requestId);
    const refusal = RemoteCommandRefusalSchema.parse({ kind: "command-refused", refused: "host-only", command: msg.kind }) as HostOnlyRefusal;
    for (const listener of remoteRefusalListeners) listener(refusal);
    return false;
  }
  if (!bridge || current.connection !== "open") return false;
  bridge.send(JSON.stringify(msg));
  return true;
}

const getSnapshot = (): StoreState => current;
setMediaStateSource(() => current.state);
export const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Select a stable slice; inline selectors and custom equality are both supported. */
export function useStoreSelector<T>(selector: (state: StoreState) => T, equals: (left: T, right: T) => boolean = Object.is): T {
  const cache = useRef<{ state: StoreState; selector: typeof selector; equals: typeof equals; value: T } | null>(null);
  const selected = () => {
    const held = cache.current;
    if (held?.state === current && held.selector === selector && held.equals === equals) return held.value;
    const value = selector(current);
    cache.current = { state: current, selector, equals, value: held && equals(held.value, value) ? held.value : value };
    return cache.current.value;
  };
  return useSyncExternalStore(subscribe, selected, selected);
}

export function shallowEqual<T extends object>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]));
}

export function useClientState(): ClientState | null {
  return useStoreSelector(store => store.state);
}

export function useWorld(): ClientState["world"] {
  return useStoreSelector(store => store.state?.world ?? null);
}

/**
 * The connection alone. Shared hooks that read it through `useStore()` subscribed the shell and
 * both layouts to every store change, so one unrelated event re-rendered most of the screen
 * (issue 2783).
 */
export function useConnection(): ConnectionStatus {
  return useStoreSelector(store => store.connection);
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

/** Test hook: install the real send boundary without opening a WebSocket. */
export function __setBridgeForTest(next: ArkeBridge | null): void {
  bridge = next;
  // Another transport: nothing asked over the last one will be answered over this one.
  forgetDoorAsks();
}

/** Test hook: no line held from an earlier test. */
export function __clearWorldChatHoldsForTest(): void {
  current = { ...current, worldChatHolds: {} };
}
