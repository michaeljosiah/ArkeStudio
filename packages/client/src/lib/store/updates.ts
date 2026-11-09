import {
  type ClientMessage, type ClientState, type ProviderCallRecord, ulid, type DomainEvent,
} from "@arke-studio/contracts";
import { send, type FrameSlices } from "./core.js";
import { useStore, useStoreSelector } from "./hooks.js";
import type { StoreState } from "./state.js";

// ---- SPEC-016: first run, updates, diagnostics -----------------------------

export function checkUpdates(): boolean {
  return send({ kind: "check-updates" });
}

/**
 * The update commands say whether they left: `send` drops a frame while the connection is not
 * open, and the launch announcement (design turn 152) must not close on a press that went
 * nowhere — the version would be marked announced and the download never asked for.
 */
export function downloadUpdate(): boolean {
  return send({ kind: "download-update" });
}

export function installUpdateAndRestart(): boolean {
  return send({ kind: "install-update-and-restart" });
}

export function installUpdateOnClose(): boolean {
  return send({ kind: "install-update-on-close" });
}

export function acknowledgeUpdate(): void {
  send({ kind: "acknowledge-update" });
}

export function generateDiagnostics(): void {
  send({ kind: "generate-diagnostics" });
}

/** The returned ID correlates a flushed receipt; sending does not establish persistence. */
export function setRecoveryMode(mode: import("@arke-studio/contracts").RecoveryMode): string | null {
  const requestId = ulid(); return send({ kind: "recovery-set-mode", requestId, mode }) ? requestId : null;
}
export function setRecoveryAdvanced(settings: import("@arke-studio/contracts").RecoveryAdvancedSettings): string | null {
  const requestId = ulid(); return send({ kind: "recovery-set-advanced", requestId, settings }) ? requestId : null;
}
export function reviewRecoveryAction(command: import("@arke-studio/contracts").RecoveryActionCommand["command"]): string | null {
  const requestId = ulid(); return send({ kind: "recovery-action", requestId, command }) ? requestId : null;
}
export function setRecoveryPreferences(preferences: { transientMuted?: boolean; desktopOptIn?: boolean }): string | null {
  const requestId = ulid(); return send({ kind: "recovery-set-preferences", requestId, preferences }) ? requestId : null;
}
export function controlRecoveryHistory(command: Extract<ClientMessage, { kind: "recovery-history-control" }>["command"]): string | null {
  const requestId = ulid(); return send({ kind: "recovery-history-control", requestId, command }) ? requestId : null;
}
export function readRecoveryHistory(query: import("@arke-studio/contracts").RecoveryHistoryQuery): string | null {
  const requestId = ulid(); return send({ kind: "recovery-history-read", requestId, query }) ? requestId : null;
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
  return useStoreSelector(store => store.state?.app.update ?? null);
}

export function useDiagnosticsBundle(): string | null {
  return useStoreSelector(store => store.diagnosticsBundle);
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
  return useStoreSelector(store => store.voiceSidecar);
}

export function useVoiceRuntimeTest(): StoreState["voiceRuntimeTest"] {
  return useStoreSelector(store => store.voiceRuntimeTest);
}

/** handleFrame's blocks for diagnostics.snapshot … provider-calls.ready, in their order (issue 2800). */
export function foldDiagnosticsEvent(slices: FrameSlices, event: DomainEvent): void {
  if (event.type === "diagnostics.snapshot") {
    slices.diagnostics = event.snapshot;
  }
  if (event.type === "env.check") {
    slices.envCheck = {
      pathBudgetOk: event.pathBudgetOk,
      pathBudgetDetail: event.pathBudgetDetail,
      diskFreeMb: event.diskFreeMb,
      nativeIndexOk: event.nativeIndexOk,
      nativeIndexDetail: event.nativeIndexDetail,
    };
  } else if (event.type === "diagnostics.ready") {
    slices.diagnosticsBundle = event.bundle;
  } else if (event.type === "provider-calls.ready") {
    slices.providerCallsByJob = { ...slices.providerCallsByJob, [event.jobId ?? "all"]: event.calls };
  }
}
