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
  type RankedVoice,
  type ReconcileAction,
  type ReferenceAngle,
} from "@arke-studio/contracts";
import type { ArkeBridge, AttachTarget } from "../arke-bridge.js";

/** A conversation nobody has said anything in yet. */
function emptyGenesis(): StoreState["genesis"][string] {
  return { turns: [], draft: null, status: null, attachments: [], refusals: [] };
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
  /** SPEC-011: audition results keyed provider/voiceId — cached files replay free. */
  voicePreviews: Record<string, { file: string | null; error: string | null }>;
  /** SPEC-011: dictation results by requestId — inserted as editable text, never submitted. */
  dictation: Record<string, { text: string | null; error: string | null }>;
  voiceSidecar: { state: "not-started" | "downloading" | "unavailable" | "ready"; detail: string } | null;
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
  /** SPEC-016: first-run environment verification, update lifecycle, diagnostics. */
  envCheck: {
    pathBudgetOk: boolean;
    pathBudgetDetail: string | null;
    diskFreeMb: number | null;
    nativeIndexOk: boolean;
    nativeIndexDetail: string | null;
  } | null;
  updateStatus: { status: "checking" | "available" | "none" | "downloading" | "downloaded" | "error"; version: string | null; detail: string | null } | null;
  diagnosticsBundle: string | null;
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
  voicePreviews: {},
  dictation: {},
  voiceSidecar: null,
  exportsState: {},
  importReport: null,
  artifactNotices: [],
  attached: [],
  envCheck: null,
  updateStatus: null,
  diagnosticsBundle: null,
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
    let transcripts = current.transcripts;
    let genesis = current.genesis;
    let reading = current.reading;
    let archiveNote = current.archiveNote;
    let setupStatus = current.setupStatus;
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
    } else if (event.type === "authoring.turn") {
      transcripts = {
        ...transcripts,
        [event.proposalId]: [...(transcripts[event.proposalId] ?? []), { role: event.role, text: event.text, at: event.at }],
      };
    } else if (event.type === "setup.status") {
      setupStatus = event.setup;
    } else if (event.type === "genesis.turn") {
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = {
        ...genesis,
        [event.genesisId]: { ...g, turns: [...g.turns, { role: event.role, text: event.text, at: event.at }] },
      };
    } else if (event.type === "genesis.draft") {
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = { ...genesis, [event.genesisId]: { ...g, draft: event.draft } };
    } else if (event.type === "genesis.status") {
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = {
        ...genesis,
        [event.genesisId]: { ...g, status: event.status, ...(event.detail !== undefined ? { detail: event.detail } : {}) },
      };
    } else if (event.type === "genesis.attachment") {
      const g = genesis[event.genesisId] ?? emptyGenesis();
      genesis = {
        ...genesis,
        [event.genesisId]:
          event.outcome === "waiting"
            ? {
                ...g,
                // The sandbox de-collides names, so a name is an identity here.
                attachments: [...g.attachments.filter((a) => a.name !== event.name), { name: event.name, kind: event.kind }],
              }
            : { ...g, refusals: [...g.refusals.slice(-2), { name: event.name, reason: event.reason ?? "it would not go in" }] },
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
      reading = { ...reading, [event.artifactId]: { file: event.file, state: "reading", found: 0, dropped: 0 } };
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
    let voicePreviews = current.voicePreviews;
    let dictation = current.dictation;
    let voiceSidecar = current.voiceSidecar;
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
    } else if (event.type === "dictation.result") {
      dictation = { ...dictation, [event.requestId]: { text: event.text, error: event.error } };
    } else if (event.type === "voice.sidecar") {
      voiceSidecar = { state: event.state, detail: event.detail };
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
        { sourcePath: event.sourcePath, outcome: event.outcome, reason: event.reason, sizeBytes: event.sizeBytes },
      ];
    }
    let envCheck = current.envCheck;
    let updateStatus = current.updateStatus;
    let diagnosticsBundle = current.diagnosticsBundle;
    if (event.type === "env.check") {
      envCheck = {
        pathBudgetOk: event.pathBudgetOk,
        pathBudgetDetail: event.pathBudgetDetail,
        diskFreeMb: event.diskFreeMb,
        nativeIndexOk: event.nativeIndexOk,
        nativeIndexDetail: event.nativeIndexDetail,
      };
    } else if (event.type === "update.status") {
      updateStatus = { status: event.status, version: event.version, detail: event.detail };
    } else if (event.type === "diagnostics.ready") {
      diagnosticsBundle = event.bundle;
    }
    let exportsState = current.exportsState;
    if (event.type === "export.progress") {
      exportsState = {
        ...exportsState,
        [event.exportId]: {
          productionId: event.productionId,
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
      voicePreviews,
      dictation,
      voiceSidecar,
      exportsState,
      importReport,
      artifactNotices,
      attached,
      envCheck,
      updateStatus,
      diagnosticsBundle,
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

export function send(msg: ClientMessage): void {
  bridge?.send(JSON.stringify(msg));
}

export function openWorld(worldId: string): void {
  send({ kind: "open-world", worldId });
}

export function createWorld(input: {
  name: string;
  logline?: string;
  tone?: string;
  genre?: string;
  /** Begun from a conversation: its attachments are filed into the world as it opens. */
  genesisId?: string;
}): void {
  send({ kind: "create-world", ...input });
}

/** Ask the host to open its picker and file whatever is chosen. No path passes through here. */
export function attachFiles(worldId: string, links?: string[]): void {
  send({ kind: "attach-files", worldId, ...(links !== undefined ? { links } : {}) });
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
 */
export function generateWorldImage(worldId: string): void {
  send({ kind: "generate-world-image", worldId });
}

export function useWorldImage(worldId: string): void {
  send({ kind: "use-world-image", worldId });
}

export function discardWorldImage(worldId: string): void {
  send({ kind: "discard-world-image", worldId });
}

/** Move a world out of the library. The folder survives in archive/ — this is not a delete. */
export function archiveWorld(worldId: string): void {
  send({ kind: "archive-world", worldId });
}

export function useArchiveNote(): StoreState["archiveNote"] {
  return useStore().archiveNote;
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
  send({ kind: "draft-with-studio", worldId, path, instruction, summary: "Continue the conversation", proposalId });
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
): void {
  send({ kind: "create-sheet-from-sentence", worldId, sheetType, name, sentence, ...(settle ? { settle } : {}) });
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

// ---- SPEC-011: voice -------------------------------------------------------

export function requestVoiceCandidates(worldId: string, sheetId: string): void {
  send({ kind: "voice-candidates", worldId, sheetId });
}

/** The client shows the stated cloud cost before this is sent (R-10). */
export function requestVoicePreview(worldId: string, sheetId: string, provider: string, voiceId: string): void {
  send({ kind: "voice-preview", worldId, sheetId, provider, voiceId });
}

export function transcribeDictation(requestId: string, audioBase64: string, contentType: string): void {
  send({ kind: "transcribe-dictation", requestId, audioBase64, contentType });
}

export function useVoiceCandidates(): Record<string, VoiceCandidatesState> {
  return useStore().voiceCandidates;
}

export function useVoicePreviews(): Record<string, { file: string | null; error: string | null }> {
  return useStore().voicePreviews;
}

export function useDictation(): Record<string, { text: string | null; error: string | null }> {
  return useStore().dictation;
}

// ---- SPEC-012: productions, scenes, boards, dispatch -----------------------

export function createProduction(worldId: string, title: string, format: "story" | "video" | "stills", logline?: string): void {
  send({ kind: "create-production", worldId, title, format, ...(logline !== undefined ? { logline } : {}) });
}

export function draftScene(worldId: string, productionId: string, brief: string): void {
  send({ kind: "draft-scene", worldId, productionId, brief });
}

export function stageSceneEdit(worldId: string, productionId: string, sceneFile: string, summary: string, scene: unknown): void {
  send({ kind: "stage-scene-edit", worldId, productionId, sceneFile, summary, scene });
}

export function createChapter(worldId: string, productionId: string, title: string, order: number): void {
  send({ kind: "create-chapter", worldId, productionId, title, order });
}

export function saveChapter(worldId: string, productionId: string, chapterFile: string, body: string): void {
  send({ kind: "save-chapter", worldId, productionId, chapterFile, body });
}

export function draftChapter(worldId: string, productionId: string, chapterFile: string, instruction: string): void {
  send({ kind: "draft-chapter", worldId, productionId, chapterFile, instruction });
}

export function reorderChapters(worldId: string, productionId: string, orderedFiles: string[]): void {
  send({ kind: "reorder-chapters", worldId, productionId, orderedFiles });
}

export function setPromptOverride(worldId: string, productionId: string, sceneFile: string, shotId: string, text: string | null): void {
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
): void {
  send({ kind: "dispatch-scene", worldId, productionId, sceneFile, mode, modelId, ...(resolution !== undefined ? { resolution } : {}) });
}

// ---- SPEC-013: takes, the cut, exports -------------------------------------

export function acceptTake(worldId: string, productionId: string, takeId: string, shotId: string): void {
  send({ kind: "accept-take", worldId, productionId, takeId, shotId });
}

/** A rejection requires the cited sheet and field (R-10). */
export function rejectTake(
  worldId: string,
  productionId: string,
  takeId: string,
  citation: { sheet: string; field: string; note?: string },
  shotId?: string,
): void {
  send({ kind: "reject-take", worldId, productionId, takeId, citation, ...(shotId !== undefined ? { shotId } : {}) });
}

export function saveAudioTracks(worldId: string, productionId: string, cut: unknown): void {
  send({ kind: "save-audio-tracks", worldId, productionId, cut });
}

export function exportCut(worldId: string, productionId: string, preset: "review-cut" | "master" | "social-excerpt"): void {
  send({ kind: "export-cut", worldId, productionId, preset });
}

export function cancelExport(worldId: string, exportId: string): void {
  send({ kind: "cancel-export", worldId, exportId });
}

export function exportWorld(worldId: string): void {
  send({ kind: "export-world", worldId });
}

export interface ExportState {
  productionId: string;
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
  opts: { links?: string[]; allowLarge?: boolean; supersedes?: string } = {},
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

export function resolveExtraction(worldId: string, artifactId: string, candidateHash: string, decision: "accept" | "reject"): void {
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

export function useArtifactNotices(): Array<{ sourcePath: string; outcome: string; reason: string; sizeBytes: number | null }> {
  return useStore().artifactNotices;
}

// ---- SPEC-016: first run, updates, diagnostics -----------------------------

export function checkUpdates(): void {
  send({ kind: "check-updates" });
}

export function downloadUpdate(): void {
  send({ kind: "download-update" });
}

export function generateDiagnostics(): void {
  send({ kind: "generate-diagnostics" });
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

export function useUpdateStatus(): {
  status: "checking" | "available" | "none" | "downloading" | "downloaded" | "error";
  version: string | null;
  detail: string | null;
} | null {
  return useStore().updateStatus;
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
    voicePreviews: {},
    dictation: {},
    voiceSidecar: null,
    exportsState: {},
    importReport: null,
    artifactNotices: [],
    attached: [],
    envCheck: null,
    updateStatus: null,
    diagnosticsBundle: null,
  });
}
