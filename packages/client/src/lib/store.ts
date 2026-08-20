import { useSyncExternalStore } from "react";
import {
  FrameSchema,
  type AskCandidate,
  type AskResult,
  type BenchParams,
  type Capability,
  type ClientMessage,
  type ClientState,
  type DomainEvent,
  type Frame,
  type HarnessEngine,
  type Job,
  type ProviderCallRecord,
  ProviderIdSchema,
  type ProviderId,
  type SizeTier,
  type QueueCommand,
  type RankedVoice,
  type ReconcileAction,
  type WorldChatContext,
  type BenchMode,
  ulid,
} from "@arke-studio/contracts";
import type { ArkeBridge, AttachTarget } from "../arke-bridge.js";

/** A conversation nobody has said anything in yet. */
function emptyGenesis(): StoreState["genesis"][string] {
  return { turns: [], draft: null, status: null, working: null, runStartedAt: null, attachments: [], refusals: [] };
}

/**
 * The client store: one external store holding connection status and the coordinator's
 * ClientState. Frames are schema-validated at the boundary; events fold with the same rules
 * as the coordinator's read model. View state (tabs, panels) stays in components.
 */

export type ConnectionStatus = "connecting" | "open" | "closed";

/** The last blocked-accept notice per proposal (SPEC-004): why it did not land, and what to offer. */
export interface GateNotice {
  reason:
    | "stale"
    | "needs-reconfirm"
    | "no-op"
    | "pending-review"
    | "unresolved-conflicts"
    | "target-retired"
    | "invalid"
    /** #70 SS11.4.1: an in-place edit whose outcome is unknown, so accepting is not offered. */
    | "draft-unresolved"
    /** Issue 239: a turn is writing into the proposal, so it is not settled enough to act on. */
    | "drafting";
  detail?: string;
  authoritativeSignature?: string;
}

/** Live authoring activity per proposal (SPEC-005 R-13, R-15). */
export interface AuthoringActivity {
  status: "running" | "completed" | "cancelled" | "timeout" | "budget-exceeded" | "failed";
  detail?: string;
  lines: string[];
}

/** A harness backstop prompt awaiting the user (SPEC-005 R-16). */
export interface PendingPermission {
  description: string;
  actionClass: string;
}

export interface CanonSearchState {
  searched: number;
  floorCleared: boolean;
  candidates: AskCandidate[];
}

export interface CanonRefsState {
  citedBy: {
    sheets: Array<{ id: string; atVersion: number | null }>;
    entries: string[];
    productions: string[];
  };
  ripples: Array<{ kind: string; summary: string; targets: string[] }>;
}

interface StoreState {
  connection: ConnectionStatus;
  state: ClientState | null;
  gateNotices: Record<string, GateNotice>;
  authoring: Record<string, AuthoringActivity>;
  /** Conversation over a proposal (SPEC-005): user instructions and gate replies, in order. */
  transcripts: Record<string, Array<{ role: "user" | "gate"; text: string; at: string }>>;
  /** Local-runtime setup progress — the whole picture, newest wins. */
  setupStatus: import("@arke-studio/contracts").SetupStatus | null;
  /** Genesis conversations: sandboxed world-shaping before any world exists. */
  genesis: Record<
    string,
    {
      turns: Array<{ role: "user" | "gate"; text: string; at: string }>;
      draft: import("@arke-studio/contracts").GenesisDraft | null;
      status: "running" | "completed" | "cancelled" | "timeout" | "budget-exceeded" | "failed" | null;
      detail?: string;
      /** The turn in flight, one verb at a time — cleared when the turn settles. */
      working: string | null;
      /** When the running turn began, for the working line's elapsed clock. */
      runStartedAt: string | null;
      /** Waiting in the sandbox: filed into the world the moment it exists. */
      attachments: Array<{ name: string; kind: import("@arke-studio/contracts").ArtifactKind }>;
      /** What would not go in, and why — said on a chip rather than swallowed. */
      refusals: Array<{ name: string; reason: string }>;
    }
  >;
  /**
   * Reading a document for facts, keyed by artifact. What the offer under the composer shows —
   * and the reason it can say "nothing in it" rather than going quiet and looking broken.
   */
  reading: Record<
    string,
    {
      file: string;
      state: "reading" | "found" | "nothing" | "no-text" | "stopped" | "unavailable" | "failed";
      found: number;
      dropped: number;
      reason?: string;
    }
  >;
  /** The last word on archiving a world — said once, then dismissed. */
  archiveNote: { worldId: string; text: string; refused: boolean } | null;
  permissions: Record<string, PendingPermission>;
  askResults: Record<string, AskResult>;
  canonSearches: Record<string, CanonSearchState>;
  canonRefs: Record<string, CanonRefsState>;
  sheetRefs: Record<string, SheetRefsState>;
  /** The last start-up reconciliation report (SPEC-009 R-18) — transient, newest wins. */
  reconcileReport: ReconcileAction[] | null;
  /** SPEC-011: ranked voice candidates per sheet, with the honest overlap framing. */
  voiceCandidates: Record<string, VoiceCandidatesState>;
  /** Every voice the world can read with (design 70) — unranked, and not per sheet. */
  voiceCatalogue: ReadingVoice[] | null;
  /** SPEC-011: audition results keyed provider/voiceId — cached files replay free. */
  voicePreviews: Record<string, { file: string | null; error: string | null }>;
  voiceAudio: Record<string, Extract<DomainEvent, { type: "voice.audio" }>>;
  /** SPEC-011: dictation results by requestId — inserted as editable text, never submitted. */
  dictation: Record<string, { text: string | null; error: string | null }>;
  /**
   * SPEC-022 T-10: clips staged for a clone, by requestId. A name and a length, never a path —
   * the coordinator holds where it went, and hands back only what 74c draws.
   */
  voiceClips: Record<string, StagedClip>;
  /** SPEC-022 T-10: the outcome of the last clone — the voice it made, or why it made none. */
  voiceCloned: { voiceId: string | null; label: string | null; reason: string | null } | null;
  /**
   * Files World Chat would not take, by conversation (#70 §13.2).
   *
   * Kept here rather than in the workspace because nothing was written: a refused file has no
   * durable home, so if this does not hold it the reason is lost the moment it arrives.
   */
  worldChatRefusals: Record<string, Array<{ name: string; reason: string }>>;
  /**
   * A wrap-up that was refused, by conversation (#70 §11.3).
   *
   * Here for the same reason as a refused file: a refused wrap-up writes nothing, so the workspace
   * that arrives afterwards is identical to the one before and cannot carry the reason. One at a
   * time, not a list — the next attempt replaces it, and there is only ever one button to answer.
   *
   * It carries the id of the attempt it answers. The reason is worth showing whoever is looking,
   * but only the window that made that attempt may act on it: these events reach every client,
   * and a second window's refusal must not end the first window's wait.
   */
  worldChatWrapUpRefusals: Record<string, { requestId: string; detail: string }>;
  /**
   * What the studio is doing right now, by conversation (#70 §15.3).
   *
   * Transient: it is cleared when the turn ends, and nothing is lost if it never arrives — the
   * spinner falls back to its resting word. Kept out of the workspace because the workspace is a
   * projection of the durable log, and this is deliberately not durable.
   */
  worldChatProgress: Record<string, { label: string; at: string }>;
  voiceSidecar: { state: "not-started" | "downloading" | "unavailable" | "ready"; detail: string } | null;
  voiceRuntimeTest: {
    requestId: string;
    status: "testing" | "ready" | "failed";
    detail: string;
    audioBase64: string | null;
  } | null;
  /** Last main-photo accept result by sheet; null status means the command is in flight. */
  mainPhotoAcceptance: Record<
    string,
    { status: "accepted" | "failed" | null; reason?: string; candidateRetained: boolean }
  >;
  /** Last hand-carried character sheet result by sheet; null status means the picker is open. */
  characterSheetAcceptance: Record<string, { status: "accepted" | "failed" | null; reason?: string }>;
  /**
   * Last hand-carried location view result by sheet; null status means the picker is open (issue 243).
   * "landed" and not "accepted": the upload leaves an unreviewed candidate, and naming it is a
   * separate press.
   */
  locationViewUpload: Record<string, { status: "landed" | "failed" | null; reason?: string }>;
  /** SPEC-013: export lifecycle by exportId. */
  exportsState: Record<string, ExportState>;
  /** SPEC-015: the last import report and filing notices — transient. */
  importReport: ImportReportState | null;
  artifactNotices: Array<{ sourcePath: string; outcome: string; reason: string; sizeBytes: number | null }>;
  /** Filed by attaching to a chat, newest last — what the composer shows as chips. */
  attached: Array<{
    worldId: string;
    artifactId: string;
    file: string;
    kind: import("@arke-studio/contracts").ArtifactKind;
  }>;
  /** SPEC-016: first-run environment verification and diagnostics. */
  envCheck: {
    pathBudgetOk: boolean;
    pathBudgetDetail: string | null;
    diskFreeMb: number | null;
    nativeIndexOk: boolean;
    nativeIndexDetail: string | null;
  } | null;
  diagnosticsBundle: string | null;
  providerCallsByJob: Record<string, ProviderCallRecord[]>;
}

export interface VoiceCandidatesState {
  extracted: string[];
  ranked: RankedVoice[];
  previewLine: { text: string; source: "own-line" | "drafted" | "stock" };
  cloudPreviewMicroUsd: number | null;
}

let current: StoreState = {
  connection: "connecting",
  state: null,
  gateNotices: {},
  authoring: {},
  transcripts: {},
  genesis: {},
  setupStatus: null,
  reading: {},
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
  voicePreviews: {},
  voiceAudio: {},
  dictation: {},
  worldChatRefusals: {},
  worldChatWrapUpRefusals: {},
  worldChatProgress: {},
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
};

export type QueueEnqueueResult = Extract<DomainEvent, { type: "queue.enqueue-result" }> & {
  characterName?: string;
};
const pendingQueueRequests = new Map<string, { command: QueueCommand; characterName?: string }>();
const queueResultListeners = new Set<(result: QueueEnqueueResult) => void>();
const jobReadyListeners = new Set<(job: Job) => void>();

/** A correlated filing request's answer (issue 305): ordered artifact ids, by requestId. */
export type FiledBatch = Extract<DomainEvent, { type: "artifact.filed-batch" }>;
const filedBatchListeners = new Set<(batch: FiledBatch) => void>();
export type BriefEnhanced = Extract<DomainEvent, { type: "bench.brief-enhanced" }>;
const briefEnhancedListeners = new Set<(answer: BriefEnhanced) => void>();
export function subscribeBriefEnhanced(listener: (answer: BriefEnhanced) => void): () => void {
  briefEnhancedListeners.add(listener);
  return () => briefEnhancedListeners.delete(listener);
}

export type LyricsDrafted = Extract<DomainEvent, { type: "bench.lyrics-drafted" }>;
const lyricsDraftedListeners = new Set<(answer: LyricsDrafted) => void>();
export function subscribeLyricsDrafted(listener: (answer: LyricsDrafted) => void): () => void {
  lyricsDraftedListeners.add(listener);
  return () => lyricsDraftedListeners.delete(listener);
}

export function subscribeFiledBatch(listener: (batch: FiledBatch) => void): () => void {
  filedBatchListeners.add(listener);
  return () => filedBatchListeners.delete(listener);
}

export function subscribeQueueResults(listener: (result: QueueEnqueueResult) => void): () => void {
  queueResultListeners.add(listener);
  return () => queueResultListeners.delete(listener);
}

/** The correlated answer to one create-production request (issue 384), by requestId. */
export type ProductionCreateResult = Extract<DomainEvent, { type: "production.create-result" }>;
const productionCreateListeners = new Set<(result: ProductionCreateResult) => void>();
export function subscribeProductionCreateResults(listener: (result: ProductionCreateResult) => void): () => void {
  productionCreateListeners.add(listener);
  return () => productionCreateListeners.delete(listener);
}

export type PlanResult = Extract<DomainEvent, { type: "production.plan-result" }>;
export type PlanStateEvent = Extract<DomainEvent, { type: "production.plan-state" }>;
const planResultListeners = new Set<(result: PlanResult) => void>();
const planStateListeners = new Set<(event: PlanStateEvent) => void>();

export type RoutingFindingsEvent = Extract<DomainEvent, { type: "production.routing-findings" }>;
export type InteractiveExportEvent = Extract<DomainEvent, { type: "production.interactive-export-result" }>;
const routingFindingsListeners = new Set<(event: RoutingFindingsEvent) => void>();
const interactiveExportListeners = new Set<(event: InteractiveExportEvent) => void>();
export function subscribeRoutingFindings(listener: (event: RoutingFindingsEvent) => void): () => void {
  routingFindingsListeners.add(listener);
  return () => routingFindingsListeners.delete(listener);
}
export function subscribeInteractiveExports(listener: (event: InteractiveExportEvent) => void): () => void {
  interactiveExportListeners.add(listener);
  return () => interactiveExportListeners.delete(listener);
}
export function subscribePlanResults(listener: (result: PlanResult) => void): () => void {
  planResultListeners.add(listener);
  return () => planResultListeners.delete(listener);
}
export function subscribePlanStates(listener: (event: PlanStateEvent) => void): () => void {
  planStateListeners.add(listener);
  return () => planStateListeners.delete(listener);
}

export function subscribeJobReady(listener: (job: Job) => void): () => void {
  jobReadyListeners.add(listener);
  return () => jobReadyListeners.delete(listener);
}

function queueRequest(command: QueueCommand, characterName?: string): string {
  const requestId = ulid();
  if (current.connection === "open") {
    pendingQueueRequests.set(requestId, { command, ...(characterName ? { characterName } : {}) });
  }
  return requestId;
}
const listeners = new Set<() => void>();
let bridge: ArkeBridge | null = null;
let lastSeq = 0;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function emitChange(next: StoreState): void {
  current = next;
  for (const l of listeners) l();
}

/** Test hook: apply one event to a state, so a reducer can be pinned without a socket. */
export function __applyForTest(state: ClientState, event: DomainEvent): ClientState {
  return fold(state, event);
}

function fold(state: ClientState, event: DomainEvent): ClientState {
  switch (event.type) {
    case "health.changed":
      return {
        ...state,
        app: {
          ...state.app,
          health: {
            ...state.app.health,
            [event.component]: {
              status: event.status,
              ...(event.reason !== undefined ? { reason: event.reason } : {}),
            },
          },
        },
      };
    case "job.updated": {
      const jobs = [...state.app.jobs];
      const i = jobs.findIndex((j) => j.id === event.job.id);
      if (i === -1) jobs.push(event.job);
      else jobs[i] = event.job;
      return { ...state, app: { ...state.app, jobs } };
    }
    case "job.deleted":
      // The row leaves Activity; its ledger entry stays, so spend does not move.
      return { ...state, app: { ...state.app, jobs: state.app.jobs.filter((j) => j.id !== event.jobId) } };
    case "ledger.appended":
      return { ...state, app: { ...state.app, ledger: [...state.app.ledger, event.entry] } };
    case "provider.status":
      return { ...state, app: { ...state.app, providers: event.providers } };
    case "routing.changed":
      return { ...state, app: { ...state.app, routing: { defaults: event.routing, faults: event.faults } } };
    case "presets.changed":
      return { ...state, app: { ...state.app, presets: event.presets } };
    case "models.changed":
      // Faults travel with availability because they are the same act: switching a model off can
      // strand the default that points at it, and the two arriving separately would show a
      // studio that briefly claims a routing it cannot honour.
      return {
        ...state,
        app: {
          ...state.app,
          models: event.models,
          routing: { ...state.app.routing, faults: event.faults },
        },
      };
    case "spend.status":
      return { ...state, app: { ...state.app, spend: event.spend } };
    case "background-notifications.changed":
      return { ...state, app: { ...state.app, backgroundNotifications: event.preference } };
    case "appearance.changed":
      return { ...state, app: { ...state.app, appearance: { theme: event.preference } } };
    case "narrator.changed":
      return { ...state, app: { ...state.app, narrator: event.voice } };
    case "runtime.status":
      return { ...state, app: { ...state.app, runtime: event.runtime } };
    case "harness.status":
      return { ...state, app: { ...state.app, harness: event.harness } };
    case "voice.sidecar":
      return event.runtime === undefined
        ? state
        : { ...state, app: { ...state.app, voiceRuntime: event.runtime } };
    case "manifest.drift":
      return { ...state, app: { ...state.app, drift: event.reports } };
    case "queue.status": {
      const queues = [...state.app.queues];
      const i = queues.findIndex((q) => q.provider === event.queue.provider);
      if (i === -1) queues.push(event.queue);
      else queues[i] = event.queue;
      return { ...state, app: { ...state.app, queues } };
    }
    case "update.status":
      return { ...state, app: { ...state.app, update: event.update } };
    case "entity.changed":
      if (!state.world || state.world.meta.worldId !== event.worldId) return state;
      return { ...state, world: { ...state.world, changes: [...state.world.changes, event.change] } };
    case "canon.revision.advanced":
      if (!state.world || state.world.meta.worldId !== event.worldId) return state;
      return {
        ...state,
        world: { ...state.world, meta: { ...state.world.meta, canonRevision: event.revision } },
      };
    case "take.recorded":
    case "review.recorded":
    case "selection.changed": {
      if (!state.world || state.world.meta.worldId !== event.worldId) return state;
      const productions = state.world.productions.map((p) => {
        if (p.meta.id !== event.productionId) return p;
        if (event.type === "take.recorded") return { ...p, takes: [...p.takes, event.take] };
        if (event.type === "review.recorded") return { ...p, reviews: [...p.reviews, event.review] };
        return { ...p, selections: { ...p.selections, [event.shotId]: event.selection } };
      });
      return { ...state, world: { ...state.world, productions } };
    }
    default:
      return state;
  }
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

function handleFrame(json: string): void {
  let frame;
  try {
    frame = FrameSchema.parse(JSON.parse(json));
  } catch {
    // A frame that fails its schema is a coordinator/client version skew — drop loudly.
    console.error("[arke] dropped malformed frame");
    return;
  }
  lastSeq = frame.seq;
  if (frame.kind === "snapshot") {
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
    const authoring = seedLiveRuns(current.authoring, frame.state.authoringRuns);
    const durableVoiceAudio: StoreState["voiceAudio"] = {};
    for (const job of frame.state.app.jobs) {
      if (job.target.kind !== "voice-preview" || typeof job.params["requestId"] !== "string") continue;
          const requestId = job.params["requestId"] as string;
          if (job.status !== "succeeded" || !job.landedFiles?.[0]) {
            if (job.status !== "failed" && job.status !== "cancelled" && job.status !== "needs-reconciliation") continue;
            durableVoiceAudio[requestId] = {
              at: job.updatedAt, type: "voice.audio" as const, requestId, worldId: job.worldId,
              sheetId: String(job.params["sheetId"]), sheetVersion: Number(job.params["sheetVersion"]),
              purpose: job.params["purpose"] === "sheet-section" ? "sheet-section" as const : "candidate-preview" as const,
              ...(job.params["sectionHeading"] ? { sectionHeading: String(job.params["sectionHeading"]) } : {}),
              provider: "elevenlabs" as const, model: job.model, voiceId: String(job.params["voiceId"]),
              status: "failed" as const, file: null, cached: false,
              characterCount: Number(job.params["characterCount"] ?? 0), estimatedMicroUsd: job.estimatedMicroUsd,
              error: "Voice synthesis needs attention in Activity.",
            };
            continue;
          }
          durableVoiceAudio[requestId] = {
            at: job.updatedAt, type: "voice.audio" as const, requestId,
            worldId: job.worldId, sheetId: String(job.params["sheetId"]),
            sheetVersion: Number(job.params["sheetVersion"]),
            purpose: job.params["purpose"] === "sheet-section" ? "sheet-section" as const : "candidate-preview" as const,
            ...(job.params["sectionHeading"] ? { sectionHeading: String(job.params["sectionHeading"]) } : {}),
            provider: "elevenlabs" as const, model: job.model, voiceId: String(job.params["voiceId"]),
            status: "ready" as const, file: job.landedFiles[0], cached: true,
            characterCount: Number(job.params["characterCount"] ?? 0), estimatedMicroUsd: job.estimatedMicroUsd,
          };
    }
    emitChange({
      ...current,
      state: frame.state,
      gateNotices,
      authoring,
      sheetRefs: changedWorld ? {} : current.sheetRefs,
      voiceCandidates: changedWorld ? {} : current.voiceCandidates,
      voiceClips: changedWorld ? {} : current.voiceClips,
      voiceCloned: changedWorld ? null : current.voiceCloned,
      voiceCatalogue: changedWorld ? null : current.voiceCatalogue,
      voicePreviews: changedWorld ? {} : current.voicePreviews,
      voiceAudio: { ...(changedWorld ? {} : current.voiceAudio), ...durableVoiceAudio },
      // Both are keyed by sheet slug alone, and slugs recur across worlds: a failure left over
      // from one world would otherwise surface under the same-named character in the next one
      // (PR 241 review). They describe an action just taken here, so they do not outlive it.
      // No "#" before that number anywhere under src/: the hard-coded-colour rule reads it as a
      // three-digit hex and fails the token test.
      mainPhotoAcceptance: changedWorld ? {} : current.mainPhotoAcceptance,
      characterSheetAcceptance: changedWorld ? {} : current.characterSheetAcceptance,
      locationViewUpload: changedWorld ? {} : current.locationViewUpload,
    });
  } else if (current.state) {
    let gateNotices = current.gateNotices;
    let authoring = current.authoring;
    let transcripts = current.transcripts;
    let genesis = current.genesis;
    let reading = current.reading;
    let archiveNote = current.archiveNote;
    let setupStatus = current.setupStatus;
    let permissions = current.permissions;
    const event = frame.event;
    if (event.type === "queue.enqueue-result") {
      const expected = pendingQueueRequests.get(event.requestId);
      if (expected?.command === event.command) {
        pendingQueueRequests.delete(event.requestId);
        const result = { ...event, ...(expected.characterName ? { characterName: expected.characterName } : {}) };
        for (const listener of queueResultListeners) listener(result);
      }
    }
    if (event.type === "job.ready") {
      for (const listener of jobReadyListeners) listener(event.job);
    }
    if (event.type === "production.create-result") {
      for (const listener of productionCreateListeners) listener(event);
    }
    if (event.type === "production.plan-result") {
      for (const listener of planResultListeners) listener(event);
    }
    if (event.type === "production.plan-state") {
      for (const listener of planStateListeners) listener(event);
    }
    if (event.type === "production.routing-findings") {
      for (const listener of routingFindingsListeners) listener(event);
    }
    if (event.type === "production.interactive-export-result") {
      for (const listener of interactiveExportListeners) listener(event);
    }
    if (event.type === "bench.brief-enhanced") {
      for (const listener of briefEnhancedListeners) listener(event);
    }
    if (event.type === "bench.lyrics-drafted") {
      for (const listener of lyricsDraftedListeners) listener(event);
    }
    if (event.type === "artifact.filed-batch") {
      for (const listener of filedBatchListeners) listener(event);
    }
    if (event.type === "proposal.blocked") {
      gateNotices = {
        ...gateNotices,
        [event.proposalId]: {
          reason: event.reason,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          ...(event.authoritativeSignature !== undefined
            ? { authoritativeSignature: event.authoritativeSignature }
            : {}),
        },
      };
    } else if (event.type === "proposal.resolved") {
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
    } else if (event.type === "genesis.turn") {
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = {
        ...genesis,
        [event.genesisId]: {
          ...g,
          turns: [...g.turns, { role: event.role, text: event.text, at: event.at }],
        },
      };
    } else if (event.type === "genesis.draft") {
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = { ...genesis, [event.genesisId]: { ...g, draft: event.draft } };
    } else if (event.type === "genesis.status") {
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = {
        ...genesis,
        [event.genesisId]: {
          ...g,
          status: event.status,
          // The clock starts when the turn does; a settled turn takes its working line with it.
          runStartedAt: event.status === "running" ? event.at : g.runStartedAt,
          working: event.status === "running" ? g.working : null,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
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
        [event.permissionId]: { description: event.description, actionClass: event.actionClass },
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
    let voicePreviews = current.voicePreviews;
    let voiceAudio = current.voiceAudio;
    let dictation = current.dictation;
    let worldChatRefusals = current.worldChatRefusals;
    let worldChatWrapUpRefusals = current.worldChatWrapUpRefusals;
    let worldChatProgress = current.worldChatProgress;
    let voiceSidecar = current.voiceSidecar;
    let voiceRuntimeTest = current.voiceRuntimeTest;
    let mainPhotoAcceptance = current.mainPhotoAcceptance;
    let characterSheetAcceptance = current.characterSheetAcceptance;
    let locationViewUpload = current.locationViewUpload;
    if (event.type === "voice.catalogue") {
      voiceCatalogue = event.voices;
    }
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
        },
      };
    } else if (event.type === "voice.preview") {
      voicePreviews = {
        ...voicePreviews,
        [`${event.provider}/${event.voiceId}`]: { file: event.file, error: event.error },
      };
    } else if (event.type === "voice.audio") {
      voiceAudio = { ...voiceAudio, [event.requestId]: event };
    } else if (event.type === "dictation.result") {
      dictation = { ...dictation, [event.requestId]: { text: event.text, error: event.error } };
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
    } else if (event.type === "world-chat.progress") {
      worldChatProgress = {
        ...worldChatProgress,
        [event.conversationId]: { label: event.label, at: event.at },
      };
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
        },
      ];
    }
    let envCheck = current.envCheck;
    let diagnosticsBundle = current.diagnosticsBundle;
    let providerCallsByJob = current.providerCallsByJob;
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
          productionId: event.productionId,
          ...(event.episodeId !== undefined ? { episodeId: event.episodeId } : {}),
          status: event.status,
          percent: event.percent,
          output: event.output,
          error: event.error,
        },
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
    } else if (event.type === "canon.refs") {
      canonRefs = { ...canonRefs, [event.entryId]: { citedBy: event.citedBy, ripples: event.ripples } };
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
      setupStatus,
      reading,
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
      voicePreviews,
      voiceAudio,
      dictation,
      worldChatRefusals,
      worldChatWrapUpRefusals,
      worldChatProgress,
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
      providerCallsByJob,
    });
  }
}

function handleStatus(status: ConnectionStatus): void {
  if (status !== "open") pendingQueueRequests.clear();
  emitChange({ ...current, connection: status });
  if (status === "open") {
    reconnectAttempts = 0;
    send({ kind: "hello", lastSeq });
  }
  if (status === "closed") {
    const delay = Math.min(10_000, 500 * 2 ** reconnectAttempts++);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => bridge?.connect(), delay);
  }
}

/** Dev fallback: the same bridge surface over a plain WebSocket to the dev coordinator. */
function devBridge(url: string): ArkeBridge {
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
      socket = new WebSocket(url);
      socket.addEventListener("open", () => onStatus?.("open"));
      socket.addEventListener("close", () => {
        socket = null;
        onStatus?.("closed");
      });
      socket.addEventListener("message", (e) => {
        if (typeof e.data === "string") onFrame?.(e.data);
      });
    },
    send(json) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(json);
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
  bridge = window.arke ?? devBridge(devUrl);
  bridge.subscribe(handleFrame, handleStatus);
  bridge.connect();
}

export function send(msg: ClientMessage): boolean {
  if (!bridge || current.connection !== "open") return false;
  bridge.send(JSON.stringify(msg));
  return true;
}

export function openWorld(worldId: string): void {
  send({ kind: "open-world", worldId });
}

export function createWorld(input: {
  name: string;
  logline?: string;
  tone?: string;
  genre?: string;
  /** The look chosen at genesis, recorded as world look v1. Absent when it was deferred. */
  artDirection?: string;
  /** Begun from a conversation: its attachments are filed into the world as it opens. */
  genesisId?: string;
}): void {
  send({ kind: "create-world", ...input });
}

/** Ask the host to open its picker and file whatever is chosen. No path passes through here. */
export function attachFiles(worldId: string, links?: string[], production?: string | null): void {
  send({
    kind: "attach-files",
    worldId,
    ...(links !== undefined ? { links } : {}),
    ...(production !== undefined ? { production } : {}),
  });
}

/**
 * Can this session take a dropped or pasted file? Only the desktop host can — it is the one
 * that can turn a File into somewhere on disk. A browser session says nothing and offers
 * nothing, rather than showing a drop target that would quietly do nothing.
 */
export function hostCanAttach(): boolean {
  return typeof bridge?.attachDropped === "function" && typeof bridge?.attachBytes === "function";
}

/** An extension for bytes that arrived with none — from what the clipboard said they are. */
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/pdf": "pdf",
};

function nameFor(file: File): string {
  if (file.name) return file.name;
  return `pasted.${EXT_BY_TYPE[file.type] ?? "bin"}`;
}

/**
 * File what was dropped or pasted. Those with a path behind them go by path; the rest — a
 * clipboard screenshot, a drag out of a web page — are handed over as bytes. Resolves with a
 * reason when something could not be taken, so the composer can say so on the chip rather
 * than swallowing it.
 */
export async function attachHostFiles(
  target: AttachTarget,
  files: readonly File[],
): Promise<ReadonlyArray<{ name: string; reason: string }>> {
  const host = bridge;
  if (!host?.attachDropped || !host.attachBytes) {
    return files.map((f) => ({ name: nameFor(f), reason: "attaching needs the desktop app" }));
  }
  const trouble: Array<{ name: string; reason: string }> = [];
  let unresolved: number[] = [];
  try {
    unresolved = host.attachDropped(target, files).unresolved;
  } catch {
    unresolved = files.map((_, i) => i);
  }
  for (const index of unresolved) {
    const file = files[index];
    if (!file) continue;
    try {
      const outcome = await host.attachBytes(target, nameFor(file), new Uint8Array(await file.arrayBuffer()));
      if (!outcome.ok) trouble.push({ name: nameFor(file), reason: outcome.reason });
    } catch {
      trouble.push({ name: nameFor(file), reason: "it could not be read" });
    }
  }
  return trouble;
}

/** A paste too long to be a message becomes a note in the world instead of filling the box. */
export async function attachHostText(
  target: AttachTarget,
  text: string,
  name: string,
): Promise<ReadonlyArray<{ name: string; reason: string }>> {
  const host = bridge;
  if (!host?.attachBytes) return [{ name, reason: "attaching needs the desktop app" }];
  try {
    const outcome = await host.attachBytes(target, name, new TextEncoder().encode(text));
    return outcome.ok ? [] : [{ name, reason: outcome.reason }];
  } catch {
    return [{ name, reason: "it could not be written" }];
  }
}

/** Ask the host's picker for files to hand to a conversation that has no world yet. */
export function genesisAttachFiles(genesisId: string): void {
  send({ kind: "genesis-attach-files", genesisId });
}

/**
 * The world's key image, from its own name, logline and tone. An ordinary image job: estimated
 * before it runs, in the ledger, cancellable from Activity like anything else that spends.
 *
 * A prompt is sent only when the author changed one (design 64). Sending the box's contents
 * unconditionally would look identical from here and mean something different at the other end:
 * the coordinator reads a present prompt as "the author has decided", and would then skip the
 * art-director rewrite for every generation whose box was merely opened and closed.
 */
export function generateWorldImage(worldId: string, opts: { modelId?: string; prompt?: string } = {}): void {
  send({
    kind: "generate-world-image",
    worldId,
    requestId: queueRequest("generate-world-image"),
    ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
  });
}

/** Or bring your own key art: the host opens the picker, and the renderer never sees the bytes. */
export function uploadWorldImage(worldId: string): void {
  send({ kind: "upload-world-image", worldId, requestId: queueRequest("upload-world-image") });
}

/** Keep one of the candidates. `file` names which, world-relative — absent means the only one. */
export function useWorldImage(worldId: string, file?: string): void {
  send({ kind: "use-world-image", worldId, ...(file !== undefined ? { file } : {}) });
}

export function discardWorldImage(worldId: string): void {
  send({ kind: "discard-world-image", worldId });
}

/**
 * The world look as a picture. The prompt defaults to the look's own description, so the image
 * and the words it illustrates are written from the same sentence — and can be replaced for one
 * generation from the dialog, where the words are still the author's rather than a model's.
 */
export function generateMasterLook(
  worldId: string,
  options: {
    modelId?: string | undefined;
    prompt?: string | undefined;
    tier?: SizeTier | undefined;
    aspect?: string | undefined;
    /** How many previews to make, 1-4. Absent is one. */
    count?: number | undefined;
  } = {},
): void {
  send({
    kind: "generate-master-look",
    worldId,
    requestId: queueRequest("generate-master-look"),
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
    ...(options.aspect !== undefined ? { aspect: options.aspect } : {}),
    ...(options.count !== undefined ? { count: options.count } : {}),
  });
}

/** Or bring your own: the host opens the picker, and the renderer never touches the bytes. */
export function uploadMasterLook(worldId: string): void {
  send({ kind: "upload-master-look", worldId, requestId: queueRequest("upload-master-look") });
}

/**
 * Stage an image for a generation to look at (design 67). Same picker, same one-way street: the
 * renderer asks, and learns from the snapshot that a reference is now attached.
 */
export function pickStagedReference(worldId: string, key: string): void {
  send({
    kind: "pick-staged-reference",
    worldId,
    key,
    requestId: queueRequest("pick-staged-reference"),
  });
}

/** Take it away again — that generation is made from words alone. */
export function clearStagedReference(worldId: string, key: string): void {
  send({ kind: "clear-staged-reference", worldId, key });
}

/** Accepting is a look change: the image lands as the next version's master look. */
export function useMasterLook(worldId: string, file?: string): void {
  send({ kind: "use-master-look", worldId, ...(file !== undefined ? { file } : {}) });
}

export function discardMasterLook(worldId: string): void {
  send({ kind: "discard-master-look", worldId });
}

/** Move a world out of the library. The folder survives in archive/ — this is not a delete. */
export function archiveWorld(worldId: string): void {
  send({ kind: "archive-world", worldId });
}

export function useArchiveNote(): StoreState["archiveNote"] {
  return useStore().archiveNote;
}

/** Copy the sample world this build carries into the library (SPEC-016 R-6). */
export function installSampleWorld(): void {
  send({ kind: "install-sample-world" });
}

/**
 * Whether there is a sample world to install, and how the last attempt went. Read off the
 * snapshot rather than folded from events: the answer is settled at start-up, so a Settings
 * pane opened much later still gets it.
 */
export function useSampleWorld(): ClientState["app"]["sampleWorld"] | null {
  return useStore().state?.app.sampleWorld ?? null;
}

export function reconcileExternalEdit(worldId: string, path: string): void {
  send({ kind: "reconcile-external-edit", worldId, path });
}

// ---- the accept gate (SPEC-004) -------------------------------------------

export function stageSheetEdit(
  worldId: string,
  path: string,
  summary: string,
  sections: Array<{ heading: string; body: string }>,
  /** Characters only: the new `role`, or "" to clear it. Omit to leave it untouched. */
  role?: string,
): void {
  send({ kind: "stage-sheet-edit", worldId, path, summary, sections, ...(role !== undefined ? { role } : {}) });
}

export function stageArtDirectionChange(
  worldId: string,
  description: string,
  masterLook?: string | null,
): void {
  send({
    kind: "stage-art-direction-change",
    worldId,
    description,
    ...(masterLook !== undefined ? { masterLook } : {}),
  });
}

/**
 * The human's own action (the assign-voice rule): applies at once, versioned, never staged.
 * Returns whether the command was actually sent — a disconnected studio must not read as a
 * change made, or the caller navigates away over a lost edit.
 */
export function setArtDirection(worldId: string, description: string, masterLook?: string | null): boolean {
  return send({
    kind: "set-art-direction",
    worldId,
    description,
    ...(masterLook !== undefined ? { masterLook } : {}),
  });
}

export function acceptProposal(worldId: string, proposalId: string, confirmRipples?: string): void {
  send({
    kind: "proposal-accept",
    worldId,
    proposalId,
    ...(confirmRipples !== undefined ? { confirmRipples } : {}),
  });
}

export function discardProposal(worldId: string, proposalId: string): void {
  send({ kind: "proposal-discard", worldId, proposalId });
}

export function rebaseProposal(worldId: string, proposalId: string): void {
  send({ kind: "proposal-rebase", worldId, proposalId });
}

export function resolveProposalConflict(
  worldId: string,
  proposalId: string,
  path: string,
  field: string,
  choice: "mine" | "theirs",
): void {
  send({ kind: "proposal-resolve-conflict", worldId, proposalId, path, field, choice });
}

export function markProposalSeen(worldId: string, proposalId: string): void {
  send({ kind: "proposal-mark-seen", worldId, proposalId });
}

export function useGateNotices(): Record<string, GateNotice> {
  return useStore().gateNotices;
}

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
  return useStore().transcripts;
}

export function setupSkip(componentId: string): void {
  send({ kind: "setup-skip", componentId });
}

export function setupRetry(componentId: string): void {
  send({ kind: "setup-retry", componentId });
}

export function setupCancel(): void {
  send({ kind: "setup-cancel" });
}

/** Live progress wins; the snapshot covers a window that opened mid-download. */
export function useSetup(): import("@arke-studio/contracts").SetupStatus | null {
  const { setupStatus, state } = useStore();
  return setupStatus ?? state?.app.setup ?? null;
}

export function genesisChat(genesisId: string, text: string): void {
  send({ kind: "genesis-chat", genesisId, text });
}

export function genesisDiscard(genesisId: string): void {
  send({ kind: "genesis-discard", genesisId });
}

export function useGenesis(): StoreState["genesis"] {
  return useStore().genesis;
}

export function cancelAuthoring(worldId: string, proposalId: string): void {
  send({ kind: "authoring-cancel", worldId, proposalId });
}

export function replyToPermission(permissionId: string, decision: "once" | "always" | "reject"): void {
  send({ kind: "permission-reply", permissionId, decision });
}

export function useAuthoring(): Record<string, AuthoringActivity> {
  return useStore().authoring;
}

export function usePermissions(): Record<string, PendingPermission> {
  return useStore().permissions;
}

// ---- canon (SPEC-006) ------------------------------------------------------

export function askCanon(worldId: string, askId: string, question: string): void {
  send({ kind: "canon-ask", worldId, askId, question });
}

export function searchCanonList(worldId: string, searchId: string, query: string): void {
  send({ kind: "canon-search", worldId, searchId, query });
}

export function requestCanonRefs(worldId: string, entryId: string): void {
  send({ kind: "canon-refs", worldId, entryId });
}

export function stageCanonEntry(
  worldId: string,
  entryType: "rule" | "lore" | "location" | "faction" | "timeline" | "tone",
  title: string,
  statement: string,
): void {
  send({ kind: "stage-canon-entry", worldId, entryType, title, statement });
}

export function stageCanonAmendment(worldId: string, entryId: string, statement: string): void {
  send({ kind: "stage-canon-amendment", worldId, entryId, statement });
}

export function openThread(worldId: string, title: string, question: string, candidates: string[]): void {
  send({ kind: "open-thread", worldId, title, question, candidates });
}

export function settleThread(
  worldId: string,
  entryId: string,
  resolvedType: "rule" | "lore" | "location" | "faction" | "timeline" | "tone",
  statement: string,
): void {
  send({ kind: "settle-thread", worldId, entryId, resolvedType, statement });
}

export function retireEntity(worldId: string, path: string): void {
  send({ kind: "retire-entity", worldId, path });
}

export function useAskResults(): Record<string, AskResult> {
  return useStore().askResults;
}

export function useCanonSearches(): Record<string, CanonSearchState> {
  return useStore().canonSearches;
}

export function useCanonRefs(): Record<string, CanonRefsState> {
  return useStore().canonRefs;
}

// ---- sheets (SPEC-007) -----------------------------------------------------

export interface SheetRefsState {
  tiles: number;
  productions: string[];
  artifacts: string[];
  scenes: string[];
  takesByVersion: Record<string, number>;
  incomingLinks: string[];
}

export function createSheetFromSentence(
  worldId: string,
  sheetType: "character" | "location" | "faction",
  name: string,
  sentence: string,
  /** Settle it as drafted, without asking — see the frame. Beginning a world sets this. */
  settle = false,
  /** Creating from inside a production files a guest of it rather than world cast (SPEC-020). */
  production?: string,
): void {
  send({
    kind: "create-sheet-from-sentence",
    worldId,
    sheetType,
    name,
    sentence,
    ...(settle ? { settle } : {}),
    ...(production !== undefined ? { production } : {}),
  });
}

/** SPEC-020 R-14: clear the guest's owner. No file moves and no citation breaks. */
export function promoteGuest(worldId: string, path: string): void {
  send({ kind: "promote-guest", worldId, path });
}

export function duplicateSheet(worldId: string, path: string, newName: string): void {
  send({ kind: "duplicate-sheet", worldId, path, newName });
}

export function setSheetStatus(worldId: string, path: string, status: "sketch" | "locked"): void {
  send({ kind: "set-sheet-status", worldId, path, status });
}

export function renameSheet(worldId: string, path: string, name: string): void {
  send({ kind: "rename-sheet", worldId, path, name });
}

export function assignVoice(
  worldId: string,
  path: string,
  // Any provider the catalogue can offer, which since SPEC-022 includes a cloned voice on
  // `comfyui`. The wire takes a plain string; this stays a provider id so a typo cannot reach it.
  voice: { provider: ProviderId; voiceId: string; label?: string } | null,
): void {
  send({ kind: "assign-voice", worldId, path, voice });
}

/**
 * A catalogue provider as an id this build can actually spell.
 *
 * `VoiceCandidate.provider` is an open string on purpose — it is a read path, and a coordinator
 * that learns a new provider should not have its events dropped by an older renderer. That makes
 * narrowing the caller's job, and a candidate naming a provider this build has never heard of is
 * a row that cannot be previewed or assigned rather than a crash.
 */
export function providerIdOf(provider: string): ProviderId | null {
  const parsed = ProviderIdSchema.safeParse(provider);
  return parsed.success ? parsed.data : null;
}

export function requestSheetRefs(worldId: string, sheetId: string): void {
  send({ kind: "sheet-refs", worldId, sheetId });
}

export function useSheetRefs(): Record<string, SheetRefsState> {
  return useStore().sheetRefs;
}

// ---- SPEC-008: providers, routing, spend, runtimes -------------------------

/** Write-only (R-5): the key goes up once; no frame ever carries it back. */
export function setCredential(provider: ProviderId, key: string): void {
  send({ kind: "set-credential", provider, key });
}

export function clearCredential(provider: ProviderId): void {
  send({ kind: "clear-credential", provider });
}

export function validateProvider(provider: ProviderId): void {
  send({ kind: "validate-provider", provider });
}

/**
 * Providers whose credential lives in a tool we drive (issue 137). Signing in opens a browser
 * and finishes minutes later, so nothing here waits: the row follows the emitted tool status.
 */
export function signInProviderTool(provider: ProviderId): void {
  send({ kind: "sign-in-provider-tool", provider });
}

export function cancelProviderToolSignIn(provider: ProviderId): void {
  send({ kind: "cancel-provider-tool-sign-in", provider });
}

export function refreshProviderTool(provider: ProviderId): void {
  send({ kind: "refresh-provider-tool", provider });
}

/** Which account the provider bills. null hands billing back to the personal context. */
export function selectProviderWorkspace(provider: ProviderId, workspaceId: string | null): void {
  send({ kind: "select-provider-workspace", provider, workspaceId });
}

/** Configure one agent. null clears that half back to what shipped. */
export function setAgentConfig(agent: string, patch: { model?: string | null; brief?: string | null }): void {
  send({ kind: "set-agent-config", agent, ...patch });
}

/** Ask the harness what it can run. Nothing happens if it is not up — the list stays empty. */
export function listHarnessModels(): void {
  send({ kind: "list-harness-models" });
}

export function setRoutingDefault(capability: Capability, modelId: string): void {
  send({ kind: "set-routing-default", capability, modelId });
}

/** Offer a model, or stop offering it. Never edits routing — a stranded default is shown instead. */
export function setModelEnabled(modelId: string, enabled: boolean): void {
  send({ kind: "set-model-enabled", modelId, enabled });
}

export function setSpendThreshold(thresholdMicroUsd: number, periodDays: number): void {
  send({ kind: "set-spend-threshold", thresholdMicroUsd, periodDays });
}

export function detectRuntimes(): void {
  send({ kind: "detect-runtimes" });
}

/** Look for the harnesses this machine has. Cheap — discovery only, never a live turn. */
export function detectHarnesses(): void {
  send({ kind: "detect-harnesses" });
}

/**
 * Ask for an engine. The coordinator refuses one it cannot find and answers with the current
 * truth either way, so the screen never has to guess whether the choice took.
 */
export function setHarnessEngine(engine: HarnessEngine): void {
  send({ kind: "set-harness-engine", engine });
}

/** Point Arke at a Claude Code the PATH does not carry. The host owns the file dialog. */
export function chooseClaudeExecutable(): void {
  send({ kind: "choose-claude-executable" });
}

/** Forget the chosen path and go back to whatever PATH offers. */
export function clearClaudeExecutable(): void {
  send({ kind: "clear-claude-executable" });
}

export function chooseVoxaExecutable(): void {
  send({ kind: "choose-voxa-executable" });
}

export function clearVoxaExecutable(): void {
  send({ kind: "clear-voxa-executable" });
}

export function useBundledVoxa(): void {
  send({ kind: "use-bundled-voxa" });
}

export function restartVoxa(): void {
  send({ kind: "restart-voxa" });
}

export function repairVoiceModels(): void {
  send({ kind: "repair-voice-models" });
}

// ---- SPEC-021: the ComfyUI engine ------------------------------------------

export function chooseComfyUiPath(): void {
  send({ kind: "choose-comfyui-path" });
}

export function chooseComfyUiModelsDir(): void {
  send({ kind: "choose-comfyui-models-dir" });
}

export function clearComfyUiModelsDir(): void {
  send({ kind: "clear-comfyui-models-dir" });
}

export function setComfyUiUrl(url: string): void {
  send({ kind: "set-comfyui-url", url });
}

export function clearComfyUiEngine(): void {
  send({ kind: "clear-comfyui-engine" });
}

export function useDetectedComfyUi(location: string): void {
  send({ kind: "use-detected-comfyui", location });
}

export function refreshComfyUi(): void {
  send({ kind: "comfyui-refresh" });
}

export function verifyComfyUiRecipe(recipeId: string): void {
  send({ kind: "comfyui-verify-recipe", recipeId });
}

export function openModelFolder(): void {
  send({ kind: "open-model-folder" });
}

export function testLocalVoice(): string {
  const requestId = ulid();
  send({ kind: "test-local-voice", requestId });
  return requestId;
}

export function setBackgroundNotifications(preference: ClientState["app"]["backgroundNotifications"]): void {
  send({ kind: "set-background-notifications", preference });
}

// ---- SPEC-009: the job queue -----------------------------------------------

export function cancelJob(jobId: string): void {
  send({ kind: "cancel-job", jobId });
}

export function retryJobFinalization(jobId: string): void {
  send({ kind: "retry-job-finalization", jobId });
}

/** Drop a finished job from Activity's history. The ledger entry and landed files stay. */
export function deleteJob(jobId: string): void {
  send({ kind: "delete-job", jobId });
}

/** Resolve a held (needs-reconciliation) job: accept the duplicate risk, or abandon. */
export function resolveHeldJob(jobId: string, decision: "resubmit" | "discard"): void {
  send({ kind: "resolve-held-job", jobId, decision });
}

/** Resume a paused provider queue — this message is the explicit confirmation (D7). */
export function resumeQueue(provider: string): void {
  send({ kind: "queue-resume", provider });
}

export function useReconcileReport(): ReconcileAction[] | null {
  return useStore().reconcileReport;
}

// ---- SPEC-010/017: reference kits ------------------------------------------

export function chooseAnchor(
  worldId: string,
  sheetId: string,
  selection: { source: "take"; takeId: string } | { source: "candidate"; file: string },
): void {
  emitChange({
    ...current,
    mainPhotoAcceptance: {
      ...current.mainPhotoAcceptance,
      [sheetId]: { status: null, candidateRetained: true },
    },
  });
  send({ kind: "choose-anchor", worldId, sheetId, selection });
}

export function useMainPhotoAcceptance() {
  return useStore().mainPhotoAcceptance;
}

export function clearMainPhotoAcceptance(sheetId: string): void {
  const mainPhotoAcceptance = { ...current.mainPhotoAcceptance };
  delete mainPhotoAcceptance[sheetId];
  emitChange({ ...current, mainPhotoAcceptance });
}

export function importMainPhotoCandidate(worldId: string, sheetId: string): void {
  send({ kind: "import-main-photo-candidate", worldId, sheetId });
}

/**
 * Bring the whole main photo in from a file, no generation involved.
 *
 * In flight from the press until the coordinator answers. The dialog is modal while it is open,
 * but it closes long before the work is done — up to 50 MB still to read, copy and commit — and
 * the window is live again for all of it. A second press in that gap opens a competing import of
 * the same sheet, and the two accepts race (PR review). This is only safe to set because a
 * cancelled dialog now reports "cancelled": without that ending, the button would have had no way
 * back from a dialog somebody simply closed.
 */
export function importMainPhoto(worldId: string, sheetId: string): void {
  if (current.mainPhotoAcceptance[sheetId]?.status === null) return;
  emitChange({
    ...current,
    mainPhotoAcceptance: {
      ...current.mainPhotoAcceptance,
      [sheetId]: { status: null, candidateRetained: false },
    },
  });
  if (!send({ kind: "import-main-photo", worldId, sheetId })) clearMainPhotoAcceptance(sheetId);
}

export function importCharacterSheet(worldId: string, sheetId: string): void {
  if (current.characterSheetAcceptance[sheetId]?.status === null) return;
  emitChange({
    ...current,
    characterSheetAcceptance: { ...current.characterSheetAcceptance, [sheetId]: { status: null } },
  });
  if (!send({ kind: "import-character-sheet", worldId, sheetId })) clearCharacterSheetAcceptance(sheetId);
}

export function useCharacterSheetAcceptance() {
  return useStore().characterSheetAcceptance;
}

export function clearCharacterSheetAcceptance(sheetId: string): void {
  const characterSheetAcceptance = { ...current.characterSheetAcceptance };
  delete characterSheetAcceptance[sheetId];
  emitChange({ ...current, characterSheetAcceptance });
}

export function generateMainPhoto(
  worldId: string,
  sheetId: string,
  prompt: string,
  count: number,
  identityReferences: string[],
  choice: { modelId?: string; tier?: SizeTier } = {},
): void {
  send({
    kind: "generate-main-photo",
    ...(choice.modelId !== undefined ? { modelId: choice.modelId } : {}),
    ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    worldId,
    sheetId,
    prompt,
    count,
    identityReferences,
    requestId: queueRequest("generate-main-photo"),
  });
}

export function generateCharacterSheet(
  worldId: string,
  sheetId: string,
  styleOverride?: string,
  characterName?: string,
  choice: { modelId?: string; tier?: SizeTier } = {},
): string | null {
  const requestId = queueRequest("generate-character-sheet", characterName);
  const sent = send({
    kind: "generate-character-sheet",
    ...(choice.modelId !== undefined ? { modelId: choice.modelId } : {}),
    ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    worldId,
    sheetId,
    requestId,
    ...(styleOverride ? { styleOverride } : {}),
  });
  if (!sent) {
    pendingQueueRequests.delete(requestId);
    return null;
  }
  return requestId;
}

export function acceptCharacterSheet(worldId: string, sheetId: string, takeId: string): void {
  send({ kind: "accept-character-sheet", worldId, sheetId, takeId });
}

// ---- Location views (issue 243) -------------------------------------------------

export function generateLocationView(
  worldId: string,
  sheetId: string,
  input: { name: string; prompt?: string; count: number; establishing?: boolean },
  choice: { modelId?: string; tier?: SizeTier } = {},
): string | null {
  const requestId = queueRequest("generate-location-view", input.name);
  const sent = send({
    kind: "generate-location-view",
    ...(choice.modelId !== undefined ? { modelId: choice.modelId } : {}),
    ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    worldId,
    sheetId,
    name: input.name,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    count: input.count,
    ...(input.establishing !== undefined ? { establishing: input.establishing } : {}),
    requestId,
  });
  if (!sent) {
    pendingQueueRequests.delete(requestId);
    return null;
  }
  return requestId;
}

/**
 * `replaceExistingName` is the confirmation, not a convenience: without it a colliding name
 * refuses, because superseding an angle somebody still wants is a loss they would only notice
 * later, in a shot.
 */
export function acceptLocationView(
  worldId: string,
  sheetId: string,
  takeId: string,
  input: { name: string; establishing?: boolean; replaceExistingName?: boolean },
): void {
  send({
    kind: "accept-location-view",
    worldId,
    sheetId,
    takeId,
    name: input.name,
    ...(input.establishing !== undefined ? { establishing: input.establishing } : {}),
    ...(input.replaceExistingName !== undefined ? { replaceExistingName: input.replaceExistingName } : {}),
  });
}

/** Opens the host picker. Lands an unreviewed candidate; naming it is the separate accept. */
export function importLocationViewCandidate(worldId: string, sheetId: string): void {
  if (current.locationViewUpload[sheetId]?.status === null) return;
  emitChange({
    ...current,
    locationViewUpload: { ...current.locationViewUpload, [sheetId]: { status: null } },
  });
  if (!send({ kind: "import-location-view-candidate", worldId, sheetId })) {
    clearLocationViewUpload(sheetId);
  }
}

export function useLocationViewUpload() {
  return useStore().locationViewUpload;
}

export function clearLocationViewUpload(sheetId: string): void {
  const locationViewUpload = { ...current.locationViewUpload };
  delete locationViewUpload[sheetId];
  emitChange({ ...current, locationViewUpload });
}

export function generateCharacterLooks(
  worldId: string,
  sheetId: string,
  lookKind: "costume" | "pose-expression" | "condition-age",
  mode: "stay-close" | "push-it",
  prompt: string,
  count: number,
  choice: { modelId?: string; tier?: SizeTier } = {},
): void {
  send({
    kind: "generate-character-looks",
    ...(choice.modelId !== undefined ? { modelId: choice.modelId } : {}),
    ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    worldId,
    sheetId,
    lookKind,
    mode,
    prompt,
    count,
    requestId: queueRequest("generate-character-looks"),
  });
}

export function acceptCharacterLook(worldId: string, sheetId: string, takeId: string): void {
  send({ kind: "accept-character-look", worldId, sheetId, takeId });
}

export function rejectReferenceTake(worldId: string, takeId: string, field: string, note?: string): void {
  send({
    kind: "reject-reference-take",
    worldId,
    takeId,
    field,
    ...(note ? { note } : {}),
  });
}

export function promoteCharacterLook(worldId: string, sheetId: string, lookId: string): void {
  send({ kind: "promote-character-look", worldId, sheetId, lookId });
}

export function attachCharacterLook(
  worldId: string,
  sheetId: string,
  lookId: string,
  scope:
    | { kind: "production"; productionId: string }
    | { kind: "scene"; productionId: string; sceneId: string }
    | null,
): void {
  send({ kind: "attach-character-look", worldId, sheetId, lookId, scope });
}

export function setStyleOverride(worldId: string, sheetId: string, style: string | null): void {
  send({ kind: "set-style-override", worldId, sheetId, style });
}

// ---- SPEC-011: voice -------------------------------------------------------

/** One row of the reading catalogue: a voice, and whom the world already gives it to. */
export type ReadingVoice = Extract<DomainEvent, { type: "voice.catalogue" }>["voices"][number];

/**
 * The plain catalogue for the bench. Not `requestVoiceCandidates`, which ranks the same voices
 * against a character's written voice — the wrong question for one that is only reading.
 */
/** Choose who narrates; null returns to the shipped local voice, which costs nothing. */
export function setNarrator(voice: { provider: string; voiceId: string; label?: string } | null): void {
  send({ kind: "set-narrator", voice });
}

export function requestVoiceCatalogue(worldId?: string): void {
  send({ kind: "voice-catalogue", ...(worldId ? { worldId } : {}) });
}

/**
 * Speak a shot's line (SPEC-011 R-14). No voice argument: it is the speaker's own, read from
 * their sheet at dispatch, so a retake keeps it by construction.
 */
export function requestVoiceLine(input: {
  worldId: string;
  productionId: string;
  shotId: string;
  delivery?: string;
}): string {
  const requestId = ulid();
  send({
    kind: "voice-line",
    requestId,
    worldId: input.worldId,
    productionId: input.productionId,
    shotId: input.shotId,
    ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
  });
  return requestId;
}

export function requestVoiceCandidates(worldId: string, sheetId: string): void {
  send({ kind: "voice-candidates", worldId, sheetId });
}

/** The client shows the stated cloud cost before this is sent (R-10). */
export function requestVoicePreview(
  worldId: string,
  sheetId: string,
  /** A provider id. The closed pair here outlived the wire's, and hid cloned voices (SPEC-022). */
  provider: ProviderId,
  voiceId: string,
): string {
  const requestId = queueRequest("voice-preview");
  send({
    kind: "voice-preview",
    worldId,
    sheetId,
    provider,
    voiceId,
    requestId,
  });
  return requestId;
}

export function readSheetSection(
  worldId: string,
  sheetId: string,
  sectionHeading: "Essence" | "Appearance",
  requestId = queueRequest("read-sheet-section"),
  confirmationToken?: string,
): string {
  send({ kind: "read-sheet-section", worldId, sheetId, sectionHeading, requestId, ...(confirmationToken ? { confirmationToken } : {}) });
  return requestId;
}


export function transcribeDictation(requestId: string, audioBase64: string, contentType: string): void {
  send({ kind: "transcribe-dictation", requestId, audioBase64, contentType });
}

/** A clip staged for a clone: what 74c can draw about it, and nothing about where it lives. */
export interface StagedClip {
  /** Null when the clip was refused, or when the host's picker was simply cancelled. */
  clipId: string | null;
  fileName: string | null;
  seconds: number | null;
  reason: string | null;
}

/**
 * Ask for a clip to clone from (SPEC-022 T-10).
 *
 * Passing no recording means the host opens its own file picker; the renderer never learns what
 * was chosen beyond its name. A recording is sent as bytes because the renderer genuinely holds
 * those — and as WAV, because that is what the library accepts and it refuses the rest by magic
 * number rather than by extension.
 */
export function stageVoiceClip(
  worldId: string,
  recording?: { audioBase64: string; contentType: string },
): string {
  const requestId = `clip-${crypto.randomUUID()}`;
  send({
    kind: "stage-voice-clip",
    worldId,
    requestId,
    source: recording ? { from: "recorded", ...recording } : { from: "chosen" },
  });
  return requestId;
}

/** Cancelling the dialog: the temp file should not outlive the screen that made it. */
export function discardVoiceClip(clipId: string): void {
  send({ kind: "discard-voice-clip", clipId });
}

/**
 * Make the voice (SPEC-022 T-10). `consent` is not a parameter: the frame is `z.literal(true)`,
 * so there is no shape of this call that carries an unconsented clone, and the tick on 74c gates
 * the button rather than being passed along as data that could be forgotten.
 */
export function cloneVoice(input: {
  worldId: string;
  clipId: string;
  name: string;
  description: string;
  sheetId?: string;
}): void {
  send({
    kind: "clone-voice",
    worldId: input.worldId,
    clipId: input.clipId,
    name: input.name,
    description: input.description,
    consent: true,
    ...(input.sheetId !== undefined ? { sheetId: input.sheetId } : {}),
  });
}

export function useVoiceClips(): Record<string, StagedClip> {
  return useStore().voiceClips;
}

export function useVoiceCloned(): { voiceId: string | null; label: string | null; reason: string | null } | null {
  return useStore().voiceCloned;
}

export function useVoiceCandidates(): Record<string, VoiceCandidatesState> {
  return useStore().voiceCandidates;
}

export function useVoicePreviews(): Record<string, { file: string | null; error: string | null }> {
  return useStore().voicePreviews;
}

export function useVoiceAudio(): Record<string, Extract<DomainEvent, { type: "voice.audio" }>> {
  return useStore().voiceAudio;
}

export function useDictation(): Record<string, { text: string | null; error: string | null }> {
  return useStore().dictation;
}

// ---- SPEC-012: productions, scenes, boards, dispatch -----------------------

export function createProduction(
  worldId: string,
  input: {
    title: string;
    /** The audience-facing medium (SPEC-023 R-1) — step one of the dialog. */
    medium: "story" | "video" | "interactive-video";
    /** The named format beneath it (SPEC-023 R-2), sent only when it says something. */
    productionKind?: string;
    seriesTitle?: string;
    aspect?: string;
    defaults?: {
      episodeCount?: number;
      episodeSecondsMin?: number;
      episodeSecondsMax?: number;
      hookWindowSec?: number;
      episodeEnding?: string;
      exportPreset?: string;
    };
    logline?: string;
  },
): string {
  // Returns the requestId so the dialog can correlate the production.create-result: pending
  // until it arrives, navigating only on success, showing the named failure in place (issue 384).
  const requestId = ulid();
  send({ kind: "create-production", worldId, requestId, ...input });
  return requestId;
}

/** Stage the structured overview through the gate — nothing is written live (issue 385). */
export function proposeStoryOverview(
  worldId: string,
  productionId: string,
  overview: {
    logline?: string;
    spine?: string;
    targetLength?: string;
    acts?: Array<{ title: string; summary?: string }>;
  },
): void {
  send({ kind: "propose-story-overview", worldId, productionId, ...overview });
}

/** Have the studio draft the overview into a staged proposal (issue 385). */
export function draftStoryOverview(worldId: string, productionId: string, instruction: string): void {
  send({ kind: "draft-story-overview", worldId, productionId, instruction });
}

/** Stage the season record through the gate — nothing is written live (issue 397). */
export function proposeSeason(
  worldId: string,
  productionId: string,
  season: {
    question?: string;
    ending?: string;
    direction?: string;
    arcs?: Array<{ id: string; title: string; note?: string; setup?: string; turn?: string; payoff?: string }>;
  },
): void {
  send({ kind: "propose-season", worldId, productionId, ...season });
}

/** Stage one episode — a create mints identity from the title; an amend names its id (issue 397). */
export function proposeEpisode(
  worldId: string,
  productionId: string,
  episode: {
    episodeId?: string;
    title?: string;
    order?: number;
    promise?: { opens?: string; turn?: string; closes?: string };
    scenes?: string[];
  },
): void {
  send({ kind: "propose-episode", worldId, productionId, ...episode });
}

/** Reorder episodes by stable id — order fields rewrite, nothing renames (issue 397). */
export function reorderEpisodes(worldId: string, productionId: string, orderedIds: string[]): void {
  send({ kind: "reorder-episodes", worldId, productionId, orderedIds });
}

export function draftScene(worldId: string, productionId: string, brief: string): void {
  send({ kind: "draft-scene", worldId, productionId, brief });
}

export function stageSceneEdit(
  worldId: string,
  productionId: string,
  sceneFile: string,
  summary: string,
  scene: unknown,
): void {
  send({ kind: "stage-scene-edit", worldId, productionId, sceneFile, summary, scene });
}

/**
 * Save the bible (SPEC-022). No proposal, no accept — it saves where it stands.
 *
 * `baseVersion` is the version the editor loaded. Passing it is what makes an ungated file safe
 * to share between three writers: this screen, the Studio mid-conversation, and a text editor
 * outside the app. A save written against a version that has since moved is refused, not merged.
 */
export function saveBible(worldId: string, text: string, baseVersion?: number): void {
  send({ kind: "save-bible", worldId, text, ...(baseVersion !== undefined ? { baseVersion } : {}) });
}

/** Undo, at whatever depth: v<n> returns as a new version and the ones after it stay in history. */
export function restoreBible(worldId: string, version: number): void {
  send({ kind: "restore-bible", worldId, version });
}

export function createChapter(worldId: string, productionId: string, title: string, order: number): void {
  send({ kind: "create-chapter", worldId, productionId, title, order });
}

export function saveChapter(worldId: string, productionId: string, chapterFile: string, body: string): void {
  send({ kind: "save-chapter", worldId, productionId, chapterFile, body });
}

export function draftChapter(
  worldId: string,
  productionId: string,
  chapterFile: string,
  instruction: string,
): void {
  send({ kind: "draft-chapter", worldId, productionId, chapterFile, instruction });
}

export function reorderChapters(worldId: string, productionId: string, orderedFiles: string[]): void {
  send({ kind: "reorder-chapters", worldId, productionId, orderedFiles });
}

/** Reorder scenes by stable id — order fields rewrite, nothing renames (issue 387). */
export function reorderScenes(worldId: string, productionId: string, orderedIds: string[]): void {
  send({ kind: "reorder-scenes", worldId, productionId, orderedIds });
}

/** Change the aspect a production delivers in (issue 389) — validated and normalized server-side. */
export function setProductionAspect(worldId: string, productionId: string, aspect: string): void {
  send({ kind: "set-production-aspect", worldId, productionId, aspect });
}

/**
 * Dispatch a scene under a durable plan (SPEC-024): the aggregate is written and authorized
 * before any pass reaches a provider. Returns the requestId the plan-result answers to.
 */
export function dispatchScenePlanned(
  worldId: string,
  productionId: string,
  sceneFile: string,
  mode: "per-shot" | "whole-scene",
  modelId: string,
  policy: "review-gated" | "pre-authorized",
  resolution?: string,
  tier?: SizeTier,
): string {
  const requestId = ulid();
  send({
    kind: "dispatch-scene-planned",
    requestId,
    worldId,
    productionId,
    sceneFile,
    mode,
    modelId,
    policy,
    ...(resolution !== undefined ? { resolution } : {}),
    ...(tier !== undefined ? { tier } : {}),
  });
  return requestId;
}

/** The visible act a review-gated plan requires before its next pass (SPEC-024 R-16). */
export function planContinue(worldId: string, productionId: string, planId: string, passIndex: number): void {
  send({ kind: "plan-continue", worldId, productionId, planId, passIndex });
}

/** The fresh act that covers an estimate the authorization did not (SPEC-024 R-17). */
export function planReconfirm(worldId: string, productionId: string, planId: string, passIndex: number): void {
  send({ kind: "plan-reconfirm", worldId, productionId, planId, passIndex });
}

/** Stop all future materialisation; landed work is untouched (SPEC-024 R-25). */
export function planCancel(worldId: string, productionId: string, planId: string): void {
  send({ kind: "plan-cancel", worldId, productionId, planId });
}

/** Ask for the folded states of a production's plans — also the restart reconciliation. */
export function listPlans(worldId: string, productionId: string): void {
  send({ kind: "list-plans", worldId, productionId });
}

/** Save the routing record (epic 401): the strict parse server-side is the no-state gate. */
export function saveRouting(worldId: string, productionId: string, routing: unknown): void {
  send({ kind: "save-routing", worldId, productionId, routing });
}

/** One preview traversal, appended durably (epic 401, brief §4). */
export function recordTraversal(
  worldId: string,
  productionId: string,
  choiceId: string,
  from: string,
  to: string,
  route: string[],
): void {
  send({ kind: "record-traversal", worldId, productionId, choiceId, from, to, route });
}

/** Ask for the named routing findings (epic 401) — evidence, never a score. */
export function listRoutingFindings(worldId: string, productionId: string): void {
  send({ kind: "list-routing-findings", worldId, productionId });
}

/** Promote a branch outcome to canon — explicit, gated, with the route named (brief §7). */
export function proposeBranchCanon(
  worldId: string,
  productionId: string,
  sceneId: string,
  route: string[],
  title: string,
  body: string,
): void {
  send({ kind: "propose-branch-canon", worldId, productionId, sceneId, route, title, body });
}

/** Export the self-hostable package (brief §6); refused while blocking findings stand. */
export function exportInteractive(worldId: string, productionId: string): void {
  send({ kind: "export-interactive", worldId, productionId });
}

export function setPromptOverride(
  worldId: string,
  productionId: string,
  sceneFile: string,
  shotId: string,
  text: string | null,
): void {
  send({ kind: "set-prompt-override", worldId, productionId, sceneFile, shotId, text });
}

export function compileSceneBoard(worldId: string, productionId: string, sceneFile: string): void {
  send({ kind: "compile-scene-board", worldId, productionId, sceneFile });
}

export function exportSceneBoard(worldId: string, productionId: string, sceneFile: string): void {
  send({ kind: "export-scene-board", worldId, productionId, sceneFile });
}

export function dispatchScene(
  worldId: string,
  productionId: string,
  sceneFile: string,
  mode: "per-shot" | "whole-scene",
  modelId: string,
  resolution?: string,
  tier?: SizeTier,
): void {
  send({
    kind: "dispatch-scene",
    worldId,
    productionId,
    sceneFile,
    mode,
    modelId,
    requestId: queueRequest("dispatch-scene"),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(tier !== undefined ? { tier } : {}),
  });
}

// ---- SPEC-013: takes, the cut, exports -------------------------------------

export function acceptTake(worldId: string, productionId: string, takeId: string, shotId: string): void {
  send({ kind: "accept-take", worldId, productionId, takeId, shotId });
}

/**
 * Where a shot starts inside its selected media (R-8, issue 253) — the only authored edit the cut
 * offers, and trim-from-the-in-point only. The coordinator refuses a shot with no accepted take
 * and a trim that would leave nothing; the refusal lands in the app log, not on the wire.
 */
export function setShotTrim(worldId: string, productionId: string, shotId: string, trimInSec: number): void {
  send({ kind: "set-trim", worldId, productionId, shotId, trimInSec });
}

/** File new artifacts into the world: the host picks, the renderer never sees the bytes (82a). */
export function uploadArtifacts(worldId: string): void {
  send({ kind: "upload-artifacts", worldId, requestId: queueRequest("upload-artifacts") });
}

/**
 * Overlays (82a): the one stored position on the cut. Placing, moving and removing are one act —
 * where a thing sits — and none of them touch the artifact, which is only ever cited.
 */
export function placeOverlay(worldId: string, productionId: string, artifactId: string, startSec: number, endSec: number): void {
  send({ kind: "place-overlay", worldId, productionId, artifactId, startSec, endSec });
}

export function moveOverlay(worldId: string, productionId: string, overlayId: string, startSec: number, endSec: number): void {
  send({ kind: "move-overlay", worldId, productionId, overlayId, startSec, endSec });
}

export function removeOverlay(worldId: string, productionId: string, overlayId: string): void {
  send({ kind: "remove-overlay", worldId, productionId, overlayId });
}

/** A rejection requires the cited sheet and field (R-10). */
export function rejectTake(
  worldId: string,
  productionId: string,
  takeId: string,
  citation: { sheet: string; field: string; note?: string },
  shotId?: string,
): void {
  send({
    kind: "reject-take",
    worldId,
    productionId,
    takeId,
    citation,
    ...(shotId !== undefined ? { shotId } : {}),
  });
}

export function saveAudioTracks(worldId: string, productionId: string, cut: unknown): void {
  send({ kind: "save-audio-tracks", worldId, productionId, cut });
}

export function exportCut(
  worldId: string,
  productionId: string,
  preset: "review-cut" | "master" | "social-excerpt",
  episodeId?: string,
): void {
  send({ kind: "export-cut", worldId, productionId, preset, ...(episodeId !== undefined ? { episodeId } : {}) });
}

export function cancelExport(worldId: string, exportId: string): void {
  send({ kind: "cancel-export", worldId, exportId });
}

export function exportWorld(worldId: string): void {
  send({ kind: "export-world", worldId });
}

export interface ExportState {
  productionId: string;
  /** Set when the export is one episode's deliverable (issue 396). */
  episodeId?: string;
  status: "running" | "done" | "cancelled" | "failed";
  percent: number;
  output: string | null;
  error: string | null;
}

export function useExports(): Record<string, ExportState> {
  return useStore().exportsState;
}

// ---- SPEC-015: artifacts ---------------------------------------------------

export function fileArtifactMsg(
  worldId: string,
  sourcePath: string,
  /**
   * `production` carries SPEC-020 ownership: a slug files it to that production, `null` says the
   * world explicitly — which is what re-homes an already-scoped artifact when filing dedups —
   * and omitting it leaves whatever ownership the artifact had.
   */
  opts: { links?: string[]; allowLarge?: boolean; supersedes?: string; production?: string | null } = {},
): void {
  send({ kind: "file-artifact", worldId, sourcePath, ...opts });
}

export function importFolder(worldId: string, sourcePath: string): void {
  send({ kind: "import-folder", worldId, sourcePath });
}

export function extractArtifact(worldId: string, artifactId: string): void {
  send({ kind: "extract-artifact", worldId, artifactId });
}

export function stopExtraction(worldId: string, artifactId: string): void {
  send({ kind: "stop-extraction", worldId, artifactId });
}

/** How the reading of each document is going — the offer under the composer reads this. */
export function useReading(): StoreState["reading"] {
  return useStore().reading;
}

export function resolveExtraction(
  worldId: string,
  artifactId: string,
  candidateHash: string,
  decision: "accept" | "reject",
): void {
  send({ kind: "resolve-extraction", worldId, artifactId, candidateHash, decision });
}

export interface ImportReportState {
  filed: Array<{ name: string; kind: string }>;
  deduplicated: string[];
  excluded: Array<{ name: string; reason: string }>;
  needsConsent: Array<{ name: string; sizeBytes: number }>;
}

export function useImportReport(): ImportReportState | null {
  return useStore().importReport;
}

export function useArtifactNotices(): Array<{
  sourcePath: string;
  outcome: string;
  reason: string;
  sizeBytes: number | null;
}> {
  return useStore().artifactNotices;
}

// ---- SPEC-016: first run, updates, diagnostics -----------------------------

export function checkUpdates(): void {
  send({ kind: "check-updates" });
}

export function downloadUpdate(): void {
  send({ kind: "download-update" });
}

export function installUpdateAndRestart(): void {
  send({ kind: "install-update-and-restart" });
}

export function installUpdateOnClose(): void {
  send({ kind: "install-update-on-close" });
}

export function acknowledgeUpdate(): void {
  send({ kind: "acknowledge-update" });
}

export function generateDiagnostics(): void {
  send({ kind: "generate-diagnostics" });
}

export function listProviderCalls(jobId: string | null): void {
  send({ kind: "list-provider-calls", jobId });
}

export function useProviderCalls(jobId: string | null): ProviderCallRecord[] | null {
  return useStore().providerCallsByJob[jobId ?? "all"] ?? null;
}

export function openDataFolder(): void {
  send({ kind: "open-data-folder" });
}

export function useEnvCheck(): StoreEnvCheck | null {
  // The event only reaches clients already connected when start-up ran; the snapshot carries
  // it for everyone else — including the packaged app's window, which loads afterwards.
  const { envCheck, state } = useStore();
  return envCheck ?? state?.app.env ?? null;
}

export type StoreEnvCheck = {
  pathBudgetOk: boolean;
  pathBudgetDetail: string | null;
  diskFreeMb: number | null;
  nativeIndexOk: boolean;
  nativeIndexDetail: string | null;
};

export function useUpdateStatus(): ClientState["app"]["update"] | null {
  return useStore().state?.app.update ?? null;
}

export function useDiagnosticsBundle(): string | null {
  return useStore().diagnosticsBundle;
}

export function recordReview(
  worldId: string,
  productionId: string,
  takeId: string,
  decision: "accept" | "reject",
  shotId?: string,
  citation?: { sheet: string; field?: string; note?: string },
): void {
  send({
    kind: "record-review",
    worldId,
    productionId,
    takeId,
    decision,
    ...(shotId !== undefined ? { shotId } : {}),
    ...(citation !== undefined ? { citation } : {}),
  });
}

export function useVoiceSidecar(): {
  state: "not-started" | "downloading" | "unavailable" | "ready";
  detail: string;
} | null {
  return useStore().voiceSidecar;
}

export function useVoiceRuntimeTest(): StoreState["voiceRuntimeTest"] {
  return useStore().voiceRuntimeTest;
}

const getSnapshot = (): StoreState => current;
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useClientState(): ClientState | null {
  return useStore().state;
}

export function useWorld(): ClientState["world"] {
  return useStore().state?.world ?? null;
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
    setupStatus: null,
    reading: {},
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
    voicePreviews: {},
    voiceAudio: {},
    dictation: {},
    worldChatRefusals: {},
    worldChatWrapUpRefusals: {},
    worldChatProgress: {},
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

/**
 * Open one conversation's workspace, or release the open one.
 *
 * Null closes it. The client holds one conversation at a time on purpose: a creator reads one at
 * a time, and keeping every transcript a session has visited would make the app cost more the
 * longer it stays open.
 */
export function openWorldChat(worldId: string, conversationId: string | null): void {
  send({ kind: "world-chat-open", worldId, conversationId });
}

export function createWorldChat(
  worldId: string,
  title: string,
  requestId: string,
  entryContext?: WorldChatContext,
): void {
  send({ kind: "world-chat-create", worldId, title, requestId, ...(entryContext ? { entryContext } : {}) });
}

/** Say something in a conversation, and take a turn. */
export function sendWorldChat(
  worldId: string,
  conversationId: string,
  text: string,
  attachmentIds: string[] = [],
): void {
  send({
    kind: "world-chat-send",
    worldId,
    requestId: crypto.randomUUID(),
    conversationId,
    text,
    attachmentIds,
  });
}

/** Stop the turn in flight. */
export function cancelWorldChat(worldId: string, conversationId: string): void {
  send({ kind: "world-chat-cancel", worldId, conversationId });
}

/**
 * Run a failed turn again. No second message: they already said it once, and retyping it to
 * recover from our timeout would be the app charging them for its own failure.
 */
export function retryWorldChatTurn(worldId: string, conversationId: string, turnId: string): void {
  send({ kind: "world-chat-retry-turn", worldId, requestId: crypto.randomUUID(), conversationId, turnId });
}

/**
 * Write one point into the world, from the rail it is shown on.
 *
 * Returns the attempt's id, or null when nothing was transmitted — the rail waits on the answer
 * to this, and a command that never left has no answer coming.
 *
 * `expectedRevision` is the revision the rail is showing. A point corrected by talking since is
 * refused rather than written as it was.
 */
export function saveWorldChatPoint(
  worldId: string,
  conversationId: string,
  candidateId: string,
  expectedRevision: number,
  /** What the rail was showing for this point's atomic group, if it has one. */
  groupMembers: ReadonlyArray<{ candidateId: string; revision: number }> = [],
): string | null {
  const requestId = crypto.randomUUID();
  const sent = send({
    kind: "world-chat-save-point",
    worldId,
    requestId,
    conversationId,
    candidateId,
    expectedCandidateRevision: expectedRevision,
    ...(groupMembers.length > 0 ? { expectedGroupRevisions: [...groupMembers] } : {}),
  });
  // A decision replaces the last refusal rather than standing beside it — the reason on screen has
  // to belong to the press just made, and a stale one over a point that then wrote is a lie.
  if (sent && current.worldChatWrapUpRefusals[conversationId] !== undefined) {
    const cleared = { ...current.worldChatWrapUpRefusals };
    delete cleared[conversationId];
    emitChange({ ...current, worldChatWrapUpRefusals: cleared });
  }
  return sent ? requestId : null;
}

/** Drop one point. It is not written, and it stops being offered. */
export function rejectWorldChatPoint(
  worldId: string,
  conversationId: string,
  candidateId: string,
  expectedRevision: number,
  /** As for a save: rejecting a grouped point drops its siblings, so it names them too. */
  groupMembers: ReadonlyArray<{ candidateId: string; revision: number }> = [],
): boolean {
  const sent = send({
    kind: "world-chat-reject-point",
    worldId,
    requestId: crypto.randomUUID(),
    conversationId,
    candidateId,
    expectedCandidateRevision: expectedRevision,
    ...(groupMembers.length > 0 ? { expectedGroupRevisions: [...groupMembers] } : {}),
  });
  // As for a save: a decision that went out replaces the last refusal rather than standing under
  // it, or the rail keeps explaining a failure beneath a point that has just been dealt with.
  if (sent && current.worldChatWrapUpRefusals[conversationId] !== undefined) {
    const cleared = { ...current.worldChatWrapUpRefusals };
    delete cleared[conversationId];
    emitChange({ ...current, worldChatWrapUpRefusals: cleared });
  }
  return sent;
}

/**
 * Turn the conversation into proposals and close it.
 *
 * Returns the id of the attempt, or null when the command did not go out at all. The screen waits
 * on the answer to this: a command that was never transmitted has nothing to wait for, and an
 * answer that names a different attempt belongs to another window.
 */
export function wrapUpWorldChat(
  worldId: string,
  conversationId: string,
  expectedConversationSeq: number,
): string | null {
  const requestId = crypto.randomUUID();
  const sent = send({
    kind: "world-chat-wrap-up",
    worldId,
    requestId,
    conversationId,
    expectedConversationSeq,
  });
  // A fresh attempt clears the last refusal rather than standing beside it, but only once one has
  // actually gone: a press that transmitted nothing has no answer coming to replace it, and
  // taking the old reason away would leave the screen saying nothing about either.
  if (sent && current.worldChatWrapUpRefusals[conversationId] !== undefined) {
    const cleared = { ...current.worldChatWrapUpRefusals };
    delete cleared[conversationId];
    emitChange({ ...current, worldChatWrapUpRefusals: cleared });
  }
  return sent ? requestId : null;
}

/**
 * Delete a conversation permanently (R-50).
 *
 * The coordinator rechecks whether anything still depends on it and refuses if so, which is why
 * this returns nothing to wait on: the row it came from is redrawn either way, still carrying the
 * reason if there is one.
 */
export function deleteWorldChat(worldId: string, conversationId: string): void {
  send({ kind: "world-chat-delete", worldId, requestId: crypto.randomUUID(), conversationId });
}

/** Ask the host's picker for documents to hand to this conversation, privately. */
export function worldChatAttachFiles(worldId: string, conversationId: string): void {
  send({ kind: "world-chat-attach-files", worldId, conversationId });
}

/**
 * Where a dropped or pasted file goes: this conversation, not the world.
 *
 * Handed to the host rather than sent from here, because resolving a File to a path is the one
 * thing the renderer must not do — see attachHostFiles.
 */
export function worldChatAttachTarget(worldId: string, conversationId: string): AttachTarget {
  return { kind: "world-chat-attach", worldId, conversationId };
}

/** What this conversation would not take, so the composer can say so on a chip. */
export function useWorldChatRefusals(conversationId: string | undefined): Array<{ name: string; reason: string }> {
  const refusals = useStore().worldChatRefusals;
  return conversationId ? (refusals[conversationId] ?? []) : [];
}

/** Why the last wrap-up did not happen, and which attempt it answers. */
export function useWorldChatWrapUpRefusal(
  conversationId: string | undefined,
): { requestId: string; detail: string } | null {
  const refusals = useStore().worldChatWrapUpRefusals;
  return conversationId ? (refusals[conversationId] ?? null) : null;
}

/**
 * What the studio is doing this second, or null when it is not doing anything.
 *
 * `since` discards a label left over from the previous turn. Progress is transient and keyed by
 * conversation, so without it the last word of one turn — usually "Writing" — is what the next
 * turn shows for its first couple of seconds, describing work that finished a minute ago.
 */
export function useWorldChatProgress(
  conversationId: string | undefined,
  since: string | null,
): string | null {
  const progress = useStore().worldChatProgress;
  const entry = conversationId ? progress[conversationId] : undefined;
  if (!entry) return null;
  if (since !== null && entry.at < since) return null;
  return entry.label;
}

/** Shelve a conversation. Reversible, and loses nothing. */
/** The mode changes initiative, never acceptance authority (SPEC-023 R-21). */
export function setWorldChatInitiative(
  worldId: string,
  conversationId: string,
  initiative: "assist" | "collaborate" | "develop",
): void {
  send({ kind: "world-chat-set-initiative", worldId, conversationId, initiative });
}

export function archiveWorldChat(worldId: string, conversationId: string): void {
  send({ kind: "world-chat-archive", worldId, conversationId });
}

/** Take it back off the shelf. */
export function unarchiveWorldChat(worldId: string, conversationId: string): void {
  send({ kind: "world-chat-unarchive", worldId, conversationId });
}

/** Return a proposal to the conversation it came from, and reopen it. */
export function sendProposalBack(worldId: string, proposalId: string): void {
  send({ kind: "proposal-send-back", worldId, proposalId });
}

// ---------------------------------------------------------------------------
// The bench (issue 305)
// ---------------------------------------------------------------------------

export function useBench(): ClientState["bench"] {
  return useStore().state?.bench ?? null;
}

export function sendBenchOpen(worldId: string, sessionId?: string): void {
  send({ kind: "bench-open", worldId, ...(sessionId !== undefined ? { sessionId } : {}) } as ClientMessage);
}

export function sendBenchNewSession(worldId: string): void {
  send({ kind: "bench-new-session", worldId });
}

export function sendBenchClose(worldId: string): void {
  send({ kind: "bench-close", worldId });
}

export function sendBenchTitle(worldId: string, sessionId: string, title: string | null): void {
  send({ kind: "bench-set-title", worldId, sessionId, requestId: ulid(), title } as ClientMessage);
}

export function sendBenchCompose(
  worldId: string,
  sessionId: string,
  composer: {
    mode: BenchMode;
    provider: string;
    model: string;
    params: Extract<ClientMessage, { kind: "bench-compose" }>["params"];
    brief: string;
  },
): void {
  send({ kind: "bench-compose", worldId, sessionId, requestId: ulid(), ...composer } as ClientMessage);
}

export function sendBenchAddReference(
  worldId: string,
  sessionId: string,
  picks: ReadonlyArray<{
    pick:
      | { source: "artifact"; artifactId: string }
      | { source: "take"; takeId: string }
      | { source: "world-file"; path: string };
    replace?: string;
  }>,
  lane?: "reference" | "keyframe",
): void {
  if (picks.length === 0) return;
  send({
    kind: "bench-add-reference",
    worldId,
    sessionId,
    requestId: ulid(),
    picks: picks.map((p) => ({ source: p.pick, ...(p.replace !== undefined ? { replace: p.replace } : {}) })),
    ...(lane !== undefined ? { lane } : {}),
  } as ClientMessage);
}

export function sendBenchEnhanceBrief(input: {
  worldId: string;
  sessionId: string;
  brief: string;
  provider: string;
  model: string;
}): string | null {
  const requestId = ulid();
  const sent = send({ kind: "bench-enhance-brief", requestId, ...input } as ClientMessage);
  return sent ? requestId : null;
}

/**
 * "Write for me" (design turn 73). The answer arrives as an event and opens a dialog; nothing
 * here writes into the composer, which is the whole point of the control.
 */
export function sendBenchDraftLyrics(input: {
  worldId: string;
  sessionId: string;
  description: string;
  style?: string;
  provider: string;
  model: string;
}): string | null {
  const requestId = ulid();
  const sent = send({ kind: "bench-draft-lyrics", requestId, ...input } as ClientMessage);
  return sent ? requestId : null;
}

export function sendBenchPresetSave(input: {
  name: string;
  mode: BenchMode;
  provider: string;
  model: string;
  params: BenchParams;
  brief?: string;
}): void {
  send({
    kind: "bench-preset-save",
    requestId: ulid(),
    name: input.name,
    mode: input.mode,
    provider: input.provider,
    model: input.model,
    params: input.params,
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
  } as ClientMessage);
}

export function sendBenchPresetDelete(presetId: string): void {
  send({ kind: "bench-preset-delete", requestId: ulid(), presetId } as ClientMessage);
}

export function sendBenchRemoveReference(
  worldId: string,
  sessionId: string,
  token: string,
  lane?: "reference" | "keyframe",
): void {
  send({
    kind: "bench-remove-reference",
    worldId,
    sessionId,
    requestId: ulid(),
    token,
    ...(lane !== undefined ? { lane } : {}),
  } as ClientMessage);
}

/** Returns the requestId the artifact.filed-batch answer will carry. */
export function sendBenchUploadReferences(
  worldId: string,
  sessionId: string,
  lane?: "reference" | "keyframe",
): string {
  const requestId = ulid();
  send({
    kind: "bench-upload-references",
    worldId,
    sessionId,
    requestId,
    ...(lane !== undefined ? { lane } : {}),
  } as ClientMessage);
  return requestId;
}

/** Returns the requestId so the screen can correlate the queue.enqueue-result. */
export function sendBenchDispatch(worldId: string, sessionId: string): string {
  const requestId = queueRequest("bench-dispatch");
  send({ kind: "bench-dispatch", worldId, sessionId, requestId } as ClientMessage);
  return requestId;
}

export function sendBenchRerun(worldId: string, sessionId: string, takeId: string): string {
  const requestId = queueRequest("bench-rerun");
  send({ kind: "bench-rerun", worldId, sessionId, requestId, takeId } as ClientMessage);
  return requestId;
}

export function sendBenchKeep(worldId: string, sessionId: string, takeId: string): void {
  send({ kind: "bench-keep", worldId, sessionId, requestId: ulid(), takeId } as ClientMessage);
}

export function sendBenchDiscard(worldId: string, sessionId: string, takeId: string): void {
  send({ kind: "bench-discard", worldId, sessionId, requestId: ulid(), takeId } as ClientMessage);
}

export function sendBenchClearView(worldId: string, sessionId: string, takeId: string): void {
  send({ kind: "bench-clear-view", worldId, sessionId, requestId: ulid(), takeId } as ClientMessage);
}

export function sendBenchSelectTake(worldId: string, sessionId: string, takeId: string): void {
  send({ kind: "bench-select-take", worldId, sessionId, requestId: ulid(), takeId } as ClientMessage);
}

export function sendStageArtifactReference(worldId: string, key: string, artifactId: string): void {
  send({ kind: "stage-artifact-reference", worldId, key, artifactId } as ClientMessage);
}

/** Returns the requestId the artifact.filed-batch answer will carry. */
export function sendAttachFilesCorrelated(worldId: string, links?: string[]): string {
  const requestId = ulid();
  send({ kind: "attach-files-correlated", worldId, requestId, ...(links !== undefined ? { links } : {}) } as ClientMessage);
  return requestId;
}
