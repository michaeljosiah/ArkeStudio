import { useSyncExternalStore } from "react";
import {
  FrameSchema,
  type AskCandidate,
  type AskResult,
  type Capability,
  type ClientMessage,
  type ClientState,
  type DomainEvent,
  type ProviderId,
  type ReconcileAction,
  type ReferenceAngle,
} from "@arke-studio/contracts";
import type { ArkeBridge } from "../arke-bridge.js";

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
    | "target-retired";
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
  permissions: Record<string, PendingPermission>;
  askResults: Record<string, AskResult>;
  canonSearches: Record<string, CanonSearchState>;
  canonRefs: Record<string, CanonRefsState>;
  sheetRefs: Record<string, SheetRefsState>;
  /** The last start-up reconciliation report (SPEC-009 R-18) — transient, newest wins. */
  reconcileReport: ReconcileAction[] | null;
}

let current: StoreState = {
  connection: "connecting",
  state: null,
  gateNotices: {},
  authoring: {},
  permissions: {},
  askResults: {},
  canonSearches: {},
  canonRefs: {},
  sheetRefs: {},
  reconcileReport: null,
};
const listeners = new Set<() => void>();
let bridge: ArkeBridge | null = null;
let lastSeq = 0;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function emitChange(next: StoreState): void {
  current = next;
  for (const l of listeners) l();
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
    case "ledger.appended":
      return { ...state, app: { ...state.app, ledger: [...state.app.ledger, event.entry] } };
    case "provider.status":
      return { ...state, app: { ...state.app, providers: event.providers } };
    case "routing.changed":
      return { ...state, app: { ...state.app, routing: { defaults: event.routing, faults: event.faults } } };
    case "spend.status":
      return { ...state, app: { ...state.app, spend: event.spend } };
    case "runtime.status":
      return { ...state, app: { ...state.app, runtime: event.runtime } };
    case "manifest.drift":
      return { ...state, app: { ...state.app, drift: event.reports } };
    case "queue.status": {
      const queues = [...state.app.queues];
      const i = queues.findIndex((q) => q.provider === event.queue.provider);
      if (i === -1) queues.push(event.queue);
      else queues[i] = event.queue;
      return { ...state, app: { ...state.app, queues } };
    }
    case "entity.changed":
      if (!state.world || state.world.meta.worldId !== event.worldId) return state;
      return { ...state, world: { ...state.world, changes: [...state.world.changes, event.change] } };
    case "canon.revision.advanced":
      if (!state.world || state.world.meta.worldId !== event.worldId) return state;
      return {
        ...state,
        world: { ...state.world, meta: { ...state.world.meta, canonRevision: event.revision } },
      };
    case "world.stale":
      if (!state.world || state.world.meta.worldId !== event.worldId) return state;
      return { ...state, world: { ...state.world, stale: true } };
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
    // Prune notices for proposals the snapshot no longer carries.
    const openIds = new Set((frame.state.world?.proposals ?? []).map((p) => p.proposal.id));
    const gateNotices = Object.fromEntries(
      Object.entries(current.gateNotices).filter(([id]) => openIds.has(id)),
    );
    emitChange({ ...current, state: frame.state, gateNotices });
  } else if (current.state) {
    let gateNotices = current.gateNotices;
    let authoring = current.authoring;
    let permissions = current.permissions;
    const event = frame.event;
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
    } else if (event.type === "sheet.refs") {
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
      permissions,
      askResults,
      canonSearches,
      canonRefs,
      sheetRefs,
      reconcileReport,
    });
  }
}

function handleStatus(status: ConnectionStatus): void {
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
      socket.onopen = () => onStatus?.("open");
      socket.onclose = () => {
        socket = null;
        onStatus?.("closed");
      };
      socket.onmessage = (e) => {
        if (typeof e.data === "string") onFrame?.(e.data);
      };
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

export function send(msg: ClientMessage): void {
  bridge?.send(JSON.stringify(msg));
}

export function openWorld(worldId: string): void {
  send({ kind: "open-world", worldId });
}

export function createWorld(input: { name: string; logline?: string; tone?: string; genre?: string }): void {
  send({ kind: "create-world", ...input });
}

export function reloadWorld(worldId: string): void {
  send({ kind: "reload-world", worldId });
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
): void {
  send({ kind: "stage-sheet-edit", worldId, path, summary, sections });
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
): void {
  send({ kind: "create-sheet-from-sentence", worldId, sheetType, name, sentence });
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
  voice: { provider: string; voiceId: string; label?: string } | null,
): void {
  send({ kind: "assign-voice", worldId, path, voice });
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

export function setRoutingDefault(capability: Capability, modelId: string): void {
  send({ kind: "set-routing-default", capability, modelId });
}

export function setSpendThreshold(thresholdMicroUsd: number, periodDays: number): void {
  send({ kind: "set-spend-threshold", thresholdMicroUsd, periodDays });
}

export function detectRuntimes(): void {
  send({ kind: "detect-runtimes" });
}

// ---- SPEC-009: the job queue -----------------------------------------------

export function cancelJob(jobId: string): void {
  send({ kind: "cancel-job", jobId });
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

// ---- SPEC-010: reference kits ----------------------------------------------

export function establishLook(worldId: string, sheetId: string, count: number): void {
  send({ kind: "establish-look", worldId, sheetId, count });
}

export function chooseAnchor(worldId: string, sheetId: string, file: string): void {
  send({ kind: "choose-anchor", worldId, sheetId, file });
}

export function lockTile(worldId: string, sheetId: string, angle: ReferenceAngle, name?: string): void {
  send({ kind: "lock-tile", worldId, sheetId, angle, ...(name !== undefined ? { name } : {}) });
}

export function generateMissingTiles(worldId: string, sheetId: string, group: "head" | "body"): void {
  send({ kind: "generate-missing-tiles", worldId, sheetId, group });
}

export function regenerateTile(worldId: string, sheetId: string, angle: ReferenceAngle): void {
  send({ kind: "regenerate-tile", worldId, sheetId, angle });
}

export function compileGrid(worldId: string, sheetId: string): void {
  send({ kind: "compile-grid", worldId, sheetId });
}

export function designateCompilation(worldId: string, sheetId: string, file: string): void {
  send({ kind: "designate-compilation", worldId, sheetId, file });
}

export function setStyleOverride(worldId: string, sheetId: string, style: string | null): void {
  send({ kind: "set-style-override", worldId, sheetId, style });
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

/** Test hook: inject a full state and mark the connection open. */
export function __setStateForTest(state: ClientState): void {
  emitChange({
    connection: "open",
    state,
    gateNotices: {},
    authoring: {},
    permissions: {},
    askResults: {},
    canonSearches: {},
    canonRefs: {},
    sheetRefs: {},
    reconcileReport: null,
  });
}
