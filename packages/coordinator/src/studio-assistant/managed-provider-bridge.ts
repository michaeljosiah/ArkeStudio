import { createHash } from "node:crypto";
import type { OllamaEngineService } from "../local-ai/ollama.js";
import { ManagedOllamaTransport } from "../local-ai/managed-ollama-transport.js";
import type { windowsConnectionOrigin } from "../local-ai/windows-connection-origin.js";
import { StudioProviderBridge } from "./provider-bridge.js";
import { isSupervisedProcessCleanupConfirmed } from "../supervisor.js";

/** Trusted composition of the existing managed Ollama owner and private native bridge.
 * No personal URL or caller-selected upstream can acquire this capability. The original
 * writer destination and remaining native activation gates are still required separately. */
export class ManagedStudioProviderBridge {
  private readonly bridge: StudioProviderBridge;
  private readonly transport: ManagedOllamaTransport;
  private readonly owner: NonNullable<ReturnType<OllamaEngineService["captureManagedOrigin"]>>;
  private opening: Promise<{ baseURL: string; apiKey: string; identity: string }> | null = null;
  private sealed = false;
  private readonly admission = new AbortController();
  private qualifying = false;
  private qualified = false;
  constructor(private readonly service: OllamaEngineService, options: { model: string; requestBody: string; verify?: typeof windowsConnectionOrigin; timeoutMs?: number; shutdownMs?: number }) {
    const owner = service.captureManagedOrigin();
    if (!owner?.current()) throw new Error("The managed private provider is unavailable.");
    this.owner = owner;
    this.transport = new ManagedOllamaTransport({ origin: owner.process, current: owner.current, verify: options.verify,
      timeoutMs: options.timeoutMs, shutdownMs: options.shutdownMs });
    this.bridge = new StudioProviderBridge({ upstream: owner.baseUrl + "/v1", requestBody: options.requestBody, model: options.model,
      fetch: this.transport.fetch, timeoutMs: options.timeoutMs, shutdownMs: options.shutdownMs });
  }
  start(signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<{ baseURL: string; apiKey: string; identity: string }> {
    if (this.sealed) return Promise.reject(new Error("The managed private provider is stopped."));
    return this.opening ??= (async () => {
      this.qualifying = true;
      try {
        const admission = AbortSignal.any([signal, this.admission.signal]);
        const owner = await this.service.qualifyManagedOrigin(admission);
        if (!owner || owner.process.identity !== this.owner.process.identity || this.sealed || signal.aborted || !this.owner.current()) throw new Error("The managed private provider content could not be verified.");
        const response = await this.transport.fetch(this.owner.baseUrl + "/api/status", { signal: admission });
        const status = await response.json() as { cloud?: { disabled?: unknown; source?: unknown } } | null;
        if (status?.cloud?.disabled !== true || !["env", "both"].includes(String(status.cloud.source)) || admission.aborted || this.sealed || !this.owner.current()) {
          throw new Error("The managed private provider could not verify local-only inference.");
        }
        this.qualified = true;
      } finally { this.qualifying = false; }
      await this.transport.prepareMetadata();
      const route = await this.bridge.start();
      if (this.sealed || signal.aborted || !this.owner.current()) { await this.stop(); throw new Error("The managed private provider changed."); }
      return Object.freeze({ ...route, identity: createHash("sha256").update(JSON.stringify([this.owner.process.identity, "local-only-env-v1", route.identity])).digest("hex") });
    })();
  }
  approve(): boolean { return this.qualified && this.owner.current() && this.bridge.approve(); }
  seal(): void { this.sealed = true; this.admission.abort(); this.bridge.seal(); this.transport.seal(); }
  busy(): boolean { return this.qualifying || this.bridge.busy() || this.transport.busy(); }
  /** Original managed native owner, including its tracked descendants; never HTTP health/Stop. */
  ownerStopped(): boolean { return isSupervisedProcessCleanupConfirmed(this.owner.process); }
  async stop(): Promise<boolean> {
    this.seal();
    const results = await Promise.allSettled([this.bridge.stop(), this.transport.stop()]);
    return !this.qualifying && results.every(row => row.status === "fulfilled" && row.value === true);
  }
}
