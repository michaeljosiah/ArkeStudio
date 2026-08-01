import { useSyncExternalStore } from "react";
import {
  FrameSchema,
  type ClientMessage,
  type ClientState,
  type DomainEvent,
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

interface StoreState {
  connection: ConnectionStatus;
  state: ClientState | null;
  gateNotices: Record<string, GateNotice>;
}

let current: StoreState = { connection: "connecting", state: null, gateNotices: {} };
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
    if (frame.event.type === "proposal.blocked") {
      gateNotices = {
        ...gateNotices,
        [frame.event.proposalId]: {
          reason: frame.event.reason,
          ...(frame.event.detail !== undefined ? { detail: frame.event.detail } : {}),
          ...(frame.event.authoritativeSignature !== undefined
            ? { authoritativeSignature: frame.event.authoritativeSignature }
            : {}),
        },
      };
    } else if (frame.event.type === "proposal.resolved") {
      gateNotices = { ...gateNotices };
      delete gateNotices[frame.event.proposalId];
    }
    emitChange({ ...current, state: fold(current.state, frame.event), gateNotices });
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
  emitChange({ connection: "open", state, gateNotices: {} });
}
