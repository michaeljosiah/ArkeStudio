import { type ClientState, type ReconcileAction, ulid } from "@arke-studio/contracts";
import { send, useStoreSelector } from "./core.js";

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

export function setOllamaUrl(url: string): void { send({ kind: "set-ollama-url", url }); }
export function useManagedOllama(): void { send({ kind: "clear-ollama-engine" }); }
export function refreshOllama(): void { send({ kind: "ollama-refresh" }); }
export function updateOllamaRuntime(): void { send({ kind: "ollama-update-runtime" }); }

export function useDetectedComfyUi(location: string): void {
  send({ kind: "use-detected-comfyui", location });
}

export function refreshComfyUi(): void {
  send({ kind: "comfyui-refresh" });
}

/**
 * Start a component and everything it declares it needs (SPEC-028 R-5, SPEC-033 R-40).
 * `setupRetry` starts one; this starts the chain, so the figure on the button is the figure that
 * lands on disk.
 */
export function setupInstall(componentId: string): void {
  send({ kind: "setup-install", componentId });
}

/** Give the disk back, and hear what went and what would not (SPEC-033 R-43, R-45). */
export function setupRemove(componentId: string): void {
  send({ kind: "setup-remove", componentId });
}

/** Stop the engine and resolve the selection again — the only thing that helps a bad start. */
export function restartComfyUi(): void {
  send({ kind: "comfyui-restart" });
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

/** The Inbox was looked at: the coordinator stamps the instant the bell's dot measures against (SPEC-014 R-25). */
export function markInboxSeen(): void {
  send({ kind: "mark-inbox-seen" });
}

/** These file problems have been told, and raise no notice again (design turn 268). */
export function settleFileProblems(worldId: string, paths: readonly string[]): void {
  send({ kind: "settle-file-problems", worldId, paths: [...paths] });
}

/** What's new was read up to this bundled release (SPEC-014 R-25). */
export function markWhatsNewSeen(version: string): void {
  send({ kind: "mark-whats-new-seen", version });
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
  return useStoreSelector(store => store.reconcileReport);
}

/** The Logs control on a spawned engine's row (SPEC-033 R-70; issue 585): the host opens the file. */
export function openEngineLog(engine: "comfyui" | "voxa" | "ollama"): void {
  send({ kind: "open-engine-log", engine });
}

/** Replace the Arke-managed ComfyUI tree with the pinned version — an explicit choice, never automatic (SPEC-021 R-20). */
export function updateComfyUiRuntime(): void {
  send({ kind: "comfyui-update-runtime" });
}
