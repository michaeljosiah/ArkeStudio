import type { AccountPage, Capability, HarnessEngine, ProviderId } from "@arke-studio/contracts";
import { send } from "./core.js";

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

// ---- SPEC-030: vendor sign-in through the harness --------------------------

export function refreshVendorAuth(): void {
  send({ kind: "refresh-vendor-auth" });
}

/** Vendor and method ids are the harness's own strings (R-7); nothing here waits on the browser. */
export function beginVendorSignIn(vendor: string, method: string, answers?: Record<string, string>): void {
  send({ kind: "begin-vendor-sign-in", vendor, method, ...(answers ? { answers } : {}) });
}

/** Write-only, like set-credential: the code goes up once and nothing carries it back (R-1). */
export function submitVendorSignInCode(vendor: string, code: string): void {
  send({ kind: "submit-vendor-sign-in-code", vendor, code });
}

/** Write-only, like set-credential: the key goes up once and nothing carries it back (R-1). */
export function submitVendorKey(vendor: string, key: string, answers?: Record<string, string>): void {
  send({ kind: "submit-vendor-key", vendor, key, ...(answers ? { answers } : {}) });
}

export function cancelVendorSignIn(): void {
  send({ kind: "cancel-vendor-sign-in" });
}

// ---- The Arke account (design turn 151) ------------------------------------

/** A browser handoff, like vendor sign-in: nothing here waits on the browser or sees a password. */
export function signInAccount(): void {
  send({ kind: "account-sign-in" });
}

export function createAccount(): void {
  send({ kind: "account-create" });
}

/** Takes back a handoff still waiting on the browser, or clears the refusal a rejected one left. */
export function cancelAccountSignIn(): void {
  send({ kind: "account-cancel-sign-in" });
}

export function signOutAccount(): void {
  send({ kind: "account-sign-out" });
}

/** The doors that leave the app: the account's own pages, in the system browser. */
export function openAccountPage(page: AccountPage): void {
  send({ kind: "account-open", page });
}

export function removeVendorConnection(vendor: string, credential: string): void {
  send({ kind: "remove-vendor-connection", vendor, credential });
}

/** Configure one agent. null clears that half back to what shipped. */
export function setAgentConfig(agent: string, patch: { model?: string | null; brief?: string | null }): void {
  send({ kind: "set-agent-config", agent, ...patch });
}

/** Refresh the running harness's catalog; discovery progress and failures arrive in app state. */
export function listHarnessModels(): void {
  send({ kind: "list-harness-models" });
}

export function setRoutingDefault(capability: Capability, modelId: string): void {
  send({ kind: "set-routing-default", capability, modelId });
}

/**
 * Which model this production reaches for, per capability (SPEC-033 R-74). `null` clears it.
 *
 * A production field, written through the ordinary gate — not app settings, because production
 * ids are world-scoped and an installation-level store collides across two copies of a world.
 */
export function setProductionModel(
  worldId: string,
  productionId: string,
  capability: Capability,
  modelId: string | null,
  /** The effort kept with a language model (design turn 195), in the harness's own name. */
  variant?: string,
): void {
  send({ kind: "set-production-model", worldId, productionId, capability, modelId, ...(variant !== undefined ? { variant } : {}) });
}

/**
 * Which model this world's own work reaches for, per capability (design turn 153). `null` clears
 * it, which is how the world goes back to following Settings.
 */
export function setWorldModel(worldId: string, capability: Capability, modelId: string | null): void {
  send({ kind: "set-world-model", worldId, capability, modelId });
}

/** Offer a model, or stop offering it. Never edits routing — a stranded default is shown instead. */
/** Let the Studio read a page online when a conversation asks it to, or stop it. */
export function setResearchWeb(enabled: boolean): void {
  send({ kind: "set-research-web", enabled });
}
export function setImageInspection(enabled: boolean, provider?: string): void {
  send({ kind: "set-image-inspection", enabled, ...(provider ? { provider } : {}) });
}
export function setWorldImageInspection(worldId: string, enabled: boolean): void {
  send({ kind: "set-world-image-inspection", worldId, enabled });
}
/** One local recipe's sampling on this device (design turn 177); null returns it to Fast. */
export function setLocalSampling(recipeId: string, sampling: import("@arke-studio/contracts").SamplingSetting | null): void {
  send({ kind: "set-local-sampling", recipeId, sampling });
}
export function adapterCommand(command: import("@arke-studio/contracts").AdapterAction): void {
  send({ kind: "adapter-command", command });
}

export function setModelEnabled(modelId: string, enabled: boolean): void {
  send({ kind: "set-model-enabled", modelId, enabled });
}

export function setSpendThreshold(thresholdMicroUsd: number, periodDays: number, onePressMicroUsd?: number): void {
  send({ kind: "set-spend-threshold", thresholdMicroUsd, periodDays, ...(onePressMicroUsd !== undefined ? { onePressMicroUsd } : {}) });
}

export function detectRuntimes(): void {
  send({ kind: "detect-runtimes" });
}

export function checkOnboarding(): void { send({ kind: "check-onboarding" }); }
export function saveOnboarding(plan: import("@arke-studio/contracts").OnboardingPlan, action: "save" | "install" | "finish" = "save"): void {
  send({ kind: "save-onboarding", plan, action });
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

export function chooseCodexExecutable(): void {
  send({ kind: "choose-codex-executable" });
}

export function clearCodexExecutable(): void {
  send({ kind: "clear-codex-executable" });
}

export function setSpeechBackend(backend: "voxa" | "pipecat"): void { send({ kind: "set-speech-backend", backend }); }

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
