import {
  applyClientStateEvent, isRemoteHostCommand, RemoteCommandRefusalSchema, type ClientMessage,
  type ClientState, type DomainEvent, voiceJobFormat, voiceJobReadIdentity, type ProviderId,
} from "@arke-studio/contracts";
import { setMediaStateSource } from "../media.js";
import { devSession } from "../dev-session.js";
import { isRemoteSession, remoteSocketUrl, remoteSocketProtocols } from "../remote-session.js";
import { parseIncomingFrame, shareSnapshot } from "../frame-parser.js";
import { SnapshotPageBuffer } from "../snapshot-pages.js";
import type { ArkeBridge } from "../../arke-bridge.js";
import type { ConnectionStatus, AuthoringActivity, StoreState, WorldChatHold } from "./state.js";
import { initialStoreState } from "./initial-state.js";
import {
  emitEvent, pendingQueueRequests, lastTallProgress, guideDrafting, guideDraftingListeners,
  type HostOnlyRefusal, refuseInvalidCommand, gateRequests, gateAnswers, frameRunQuoteListeners,
  frameRunStartResultListeners, remoteRefusalListeners, studioAssistantReplyListeners, voiceConversationListeners,
} from "./events.js";
import { forgetDoorAsks } from "./audiobook-door.js";
import { askWorldChatSendStatus, sendResults, foldWorldChatEvent } from "./world-chat.js";
import { foldAuthoringEvent, foldAuthoringStatusEvent } from "./authoring.js";
import { foldManuscriptEvent, foldImportEvent } from "./manuscript.js";
import { foldAudiobookEvent } from "./audiobook-fold.js";
import { foldVoiceEvent, foldVoiceRuntimeEvent, foldVoiceCatalogueEvent } from "./voice.js";
import { foldReferenceEvent } from "./references.js";
import { foldResultEvent } from "./results.js";
import { foldDiagnosticsEvent } from "./updates.js";
import { foldExportEvent } from "./takes.js";
import { foldCanonEvent } from "./canon.js";

export let current: StoreState = initialStoreState();

export const listeners = new Set<() => void>();
export let bridge: ArkeBridge | null = null;
export let lastSeq = 0;
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

/** The store folds exactly what the coordinator's read model folds: one function (issue 2799). */
export function fold(state: ClientState, event: DomainEvent): ClientState {
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
// The store slices an event may change, held once per frame (issue 2800). They used to be local copies
// in handleFrame: those taken before the event's listeners ran are read before them still, the
// rest just after, and the domain folds below write them.
const EARLY_SLICES = [
  "gateNotices", "authoring", "transcripts", "genesis", "buildPlans", "keyArtPlans", "reading",
  "deriving", "casting", "audiobook", "direction", "illustration", "audiobookRecords", "beats",
  "stagedTakes", "speakerLines", "narratorQuotes", "heardLines", "audiobookAsks", "audiobookDoor",
  "audiobookCredits", "audiobookBook", "audiobookNotes", "manuscripts", "archiveNote",
  "setupStatus", "permissions", "frameRunQuotes", "frameRunStartResults",
] as const;
const LATE_SLICES = [
  "askResults", "canonSearches", "canonRefs", "sheetRefs", "reconcileReport", "voiceCandidates",
  "voiceClips", "voiceCloned", "voiceCatalogue", "voiceCatalogueHeld", "voiceCatalogueErrors",
  "cataloguePreview", "voicePreviews", "voiceAudio", "voiceParts", "dictation", "worldChatRefusals",
  "worldChatWrapUpRefusals", "worldChatRipples", "worldChatProgress", "worldOpenProgress",
  "voiceSidecar", "voiceRuntimeTest", "mainPhotoAcceptance", "characterSheetAcceptance",
  "locationViewUpload", "importReport", "artifactNotices", "attached", "envCheck",
  "diagnosticsBundle", "diagnostics", "providerCallsByJob", "exportsState",
] as const;
export type FrameSlices = Pick<StoreState, (typeof EARLY_SLICES)[number] | (typeof LATE_SLICES)[number]>;
/** What a domain fold made of an event: not its kind, taken, or a frame to drop unfolded. */
export type Folded = "none" | "done" | "drop";

function pick<K extends keyof StoreState>(state: StoreState, keys: readonly K[]): Pick<StoreState, K> {
  return Object.fromEntries(keys.map(key => [key, state[key]])) as Pick<StoreState, K>;
}

/** Runs domain folds in order until one takes the event, as the else-if chain they came from did. */
function foldFirst(slices: FrameSlices, event: DomainEvent, folds: readonly ((slices: FrameSlices, event: DomainEvent) => Folded)[]): Folded {
  for (const fold of folds) {
    const folded = fold(slices, event);
    if (folded !== "none") return folded;
  }
  return "none";
}


export function handleFrame(json: string): void {
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
  if (frame.kind === "voice-conversation") {
    for (const listener of voiceConversationListeners) { try { listener(frame); } catch { /* Transient audio cannot interrupt state folding. */ } }
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
    const early = pick(current, EARLY_SLICES);
    const event = frame.event;
    emitEvent(event);
    const slices: FrameSlices = { ...early, ...pick(current, LATE_SLICES) };
    foldResultEvent(slices, event);
    if (foldFirst(slices, event, [foldAuthoringEvent, foldManuscriptEvent, foldAudiobookEvent, foldAuthoringStatusEvent]) === "drop") return;
    if (event.type === "queue.reconciled") {
      slices.reconcileReport = event.report;
    }
    foldVoiceCatalogueEvent(slices, event);
    foldFirst(slices, event, [foldVoiceEvent, foldWorldChatEvent, foldVoiceRuntimeEvent, foldReferenceEvent]);
    foldImportEvent(slices, event);
    const recoveryCommandResults = event.type === "recovery.command-result"
      ? Object.fromEntries([...Object.entries(current.recoveryCommandResults).filter(([id]) => id !== event.result.requestId), [event.result.requestId, event.result] as const].slice(-32))
      : current.recoveryCommandResults;
    const recoveryActionResults = event.type === "recovery.action-result"
      ? Object.fromEntries([...Object.entries(current.recoveryActionResults).filter(([id]) => id !== event.result.requestId), [event.result.requestId, event.result] as const].slice(-32))
      : current.recoveryActionResults;
    const recoveryHistoryPages = event.type === "recovery.history-page"
      ? Object.fromEntries([...Object.entries(current.recoveryHistoryPages).filter(([id]) => id !== event.requestId), [event.requestId, event.page] as const].slice(-4))
      : current.recoveryHistoryPages;
    foldDiagnosticsEvent(slices, event);
    foldExportEvent(slices, event);
    foldCanonEvent(slices, event);
    emitChange({
      ...current, state: fold(current.state, event), ...slices,
      recoveryCommandResults, recoveryActionResults, recoveryHistoryPages,
    });
  }
}

export function handleStatus(status: ConnectionStatus): void {
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
setMediaStateSource(() => current.state);

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
