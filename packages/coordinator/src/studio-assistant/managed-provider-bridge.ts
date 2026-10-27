import { createHash } from "node:crypto";
import type { OllamaEngineService } from "../local-ai/ollama.js";
import { ManagedOllamaTransport } from "../local-ai/managed-ollama-transport.js";
import type { windowsConnectionOrigin } from "../local-ai/windows-connection-origin.js";
import { StudioProviderBridge } from "./provider-bridge.js";

/** Trusted composition of the existing managed Ollama owner and private native bridge.
 * No personal URL or caller-selected upstream can acquire this capability. The original
 * writer destination and remaining native activation gates are still required separately. */
export class ManagedStudioProviderBridge {
  private readonly bridge: StudioProviderBridge;
  private readonly transport: ManagedOllamaTransport;
  private readonly owner: NonNullable<ReturnType<OllamaEngineService["captureManagedOrigin"]>>;
  private opening: Promise<{ baseURL: string; apiKey: string; identity: string }> | null = null;
  constructor(service: OllamaEngineService, options: { model: string; requestBody: string; verify?: typeof windowsConnectionOrigin; timeoutMs?: number; shutdownMs?: number }) {
    const owner = service.captureManagedOrigin();
    if (!owner?.current()) throw new Error("The managed private provider is unavailable.");
    this.owner = owner;
    this.transport = new ManagedOllamaTransport({ origin: owner.process, current: owner.current, verify: options.verify,
      timeoutMs: options.timeoutMs, shutdownMs: options.shutdownMs });
    this.bridge = new StudioProviderBridge({ upstream: owner.baseUrl + "/v1", requestBody: options.requestBody, model: options.model,
      fetch: this.transport.fetch, timeoutMs: options.timeoutMs, shutdownMs: options.shutdownMs });
  }
  start(): Promise<{ baseURL: string; apiKey: string; identity: string }> {
    return this.opening ??= (async () => {
      await this.transport.prepareMetadata();
      const route = await this.bridge.start();
      if (!this.owner.current()) { await this.stop(); throw new Error("The managed private provider changed."); }
      return Object.freeze({ ...route, identity: createHash("sha256").update(JSON.stringify([this.owner.process.identity, route.identity])).digest("hex") });
    })();
  }
  approve(): boolean { return this.owner.current() && this.bridge.approve(); }
  busy(): boolean { return this.bridge.busy() || this.transport.busy(); }
  async stop(): Promise<boolean> {
    const results = await Promise.allSettled([this.bridge.stop(), this.transport.stop()]);
    return results.every(row => row.status === "fulfilled" && row.value === true);
  }
}
