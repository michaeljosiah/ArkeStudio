import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeOllamaUrl, type OllamaSettings, type OllamaRuntimeStatus } from "@arke-studio/contracts";
import { ChildSupervisor, registerExitBackstop, type SupervisorDeps, type SupervisorRecoveryPort, type SupervisedProcessOrigin } from "../supervisor.js";
import { OLLAMA_VERSION } from "../setup/catalogue.js";
import { RuntimeContentVerifier, type RuntimeContentPin } from "./runtime-content.js";
import privatePin from "./ollama-private-pin-x64.json" with { type: "json" };

interface OllamaEngineOptions {
  appRoot: string;
  port: number;
  deps?: SupervisorDeps;
  fetch?: typeof fetch;
  exists?: (path: string) => boolean;
  supervise?: (spec: ConstructorParameters<typeof ChildSupervisor>[0]) => ChildSupervisor;
  registerBackstop?: (supervisor: ChildSupervisor) => () => void;
  externalHealthIntervalMs?: number;
  /** Trusted native-fixture seam, never Settings/wire state; stand-ins pin their own real bytes. */
  privateContentPin?: RuntimeContentPin;
}

/** Arke owns the portable child; an explicit URL remains owned by the user. */
export class OllamaEngineService {
  private settings: OllamaSettings = { engineUrl: null, modelsDir: null };
  private supervisor: ChildSupervisor | null = null;
  private recoveryFactory: ((supervisor: ChildSupervisor) => SupervisorRecoveryPort) | null = null;
  private recoveryPort: SupervisorRecoveryPort | null = null;
  private installing = false;
  private installationLane: (() => void) | null = null;
  private removeBackstop: (() => void) | null = null;
  private serial: Promise<void> = Promise.resolve();
  private closing = false;
  private generation = 0;
  private externalHealthTimer: ReturnType<typeof setInterval> | null = null;
  private externalHealthRevision = 0;
  private privateContent: { identity: string; verifier: RuntimeContentVerifier } | null = null;
  private readonly listeners = new Set<() => void>();
  private current: OllamaRuntimeStatus = { source: "managed", state: "absent", url: null, version: null, detail: "Install the Arke-managed Ollama runtime." };

  constructor(private readonly opts: OllamaEngineOptions) {}

  configureRecovery(factory: (supervisor: ChildSupervisor) => SupervisorRecoveryPort): void {
    if (this.recoveryFactory || this.supervisor) throw new Error("Configure Ollama recovery once, before managed startup.");
    this.recoveryFactory = factory;
  }
  ownsSupervisor(supervisor: ChildSupervisor): boolean { return this.supervisor === supervisor && !this.closing && !this.installing; }
  private attachRecovery(supervisor: ChildSupervisor): void {
    this.recoveryPort = this.recoveryFactory?.(supervisor) ?? null;
    if (this.recoveryPort) supervisor.setRecoveryPort(this.recoveryPort);
  }

  status(): OllamaRuntimeStatus { return { ...this.current }; }
  endpoint(): string { return this.settings.engineUrl ?? `http://127.0.0.1:${this.opts.port}`; }
  baseUrl(): string | null { return !this.closing && (this.externallySelected() || !this.installing && !this.installationLane) && this.current.state === "ready" ? this.endpoint() : null; }
  executable(): string { return join(this.opts.appRoot, "ollama-runtime", "ollama.exe"); }
  modelsDir(): string | null { return this.settings.modelsDir ?? (this.externallySelected() ? null : join(this.opts.appRoot, "models", "ollama")); }
  externallySelected(): boolean { return this.settings.engineUrl !== null; }
  /** Private host composition only. Explicit existing installs never acquire managed origin. */
  captureManagedOrigin(): { process: SupervisedProcessOrigin; baseUrl: string; current(): boolean } | null {
    const supervisor = this.supervisor, generation = this.generation, baseUrl = this.baseUrl();
    if (!supervisor || !baseUrl || this.externallySelected() || this.closing || this.installing || this.installationLane ||
      this.current.source !== "managed" || this.current.version !== OLLAMA_VERSION) return null;
    const origin = supervisor.captureProcessOrigin();
    if (!origin || origin.executable !== this.executable() || baseUrl !== `http://127.0.0.1:${origin.port}`) return null;
    return Object.freeze({ process: origin, baseUrl, current: () => this.supervisor === supervisor && this.generation === generation &&
      !this.externallySelected() && !this.closing && !this.installing && !this.installationLane && this.baseUrl() === baseUrl && origin.current() });
  }
  async qualifyManagedOrigin(signal: AbortSignal): Promise<ReturnType<OllamaEngineService["captureManagedOrigin"]>> {
    const owner = this.captureManagedOrigin(), pin = this.opts.privateContentPin ?? privatePin;
    if (!owner || signal.aborted || pin.version !== OLLAMA_VERSION) return null;
    try {
      if (this.privateContent?.identity !== owner.process.identity) this.privateContent = { identity: owner.process.identity,
        verifier: new RuntimeContentVerifier(join(this.opts.appRoot, "ollama-runtime"), pin) };
      if (!await this.privateContent.verifier.verify(signal, owner.current) || signal.aborted || !owner.current()) return null;
      return owner;
    } catch { return null; }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private publish(patch: Partial<OllamaRuntimeStatus>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }

  applySettings(settings: OllamaSettings, options: { deferManagedStart?: boolean } = {}): Promise<void> {
    const work = this.serial.then(async () => {
      if (this.closing) return;
      const url = settings.engineUrl === null ? null : normalizeOllamaUrl(settings.engineUrl);
      if (settings.engineUrl !== null && url === null) throw new Error("Choose a loopback Ollama HTTP URL.");
      if (this.current.state === "ready" && this.settings.engineUrl === url && this.settings.modelsDir === settings.modelsDir) return;
      await this.stopOwned();
      if (this.closing) return;
      this.stopExternalHealth();
      this.generation++;
      this.settings = { ...settings, engineUrl: url };
      this.publish({ source: url === null ? "managed" : "user-url", state: "starting", url: this.endpoint(), version: null, detail: null });
      if (url !== null) {
        await this.checkExternal();
        if (!this.closing) {
          this.externalHealthTimer = setInterval(() => { void this.checkExternal(); }, this.opts.externalHealthIntervalMs ?? 15_000);
          this.externalHealthTimer.unref?.();
        }
        return;
      }
      if (options.deferManagedStart || this.installing) return; // Endpoint selection precedes harness assembly; the coordinator admits startup.
      if (!(this.opts.exists ?? existsSync)(this.executable())) {
        this.publish({ state: "absent", url: null, detail: "Install the Arke-managed Ollama runtime, or explicitly choose an existing service." });
        return;
      }
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
        entry[1] !== undefined && ["SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"].includes(entry[0].toUpperCase())));
      const home = join(this.opts.appRoot, "runtime-home", "ollama");
      await mkdir(home, { recursive: true });
      if (this.closing || this.installing) return;
      const spec = {
        id: "ollama", command: this.executable(), port: this.opts.port, args: ["serve"], inheritEnv: false,
        env: { ...env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "local"), APPDATA: join(home, "roaming"),
          OLLAMA_HOST: "127.0.0.1:{port}", OLLAMA_MODELS: this.modelsDir()!, OLLAMA_KEEP_ALIVE: "5m", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_NO_CLOUD: "1" },
        // Cold driver/GPU discovery can exceed thirty seconds before the version route serves.
        healthPath: "/api/version", readyTimeoutMs: 60_000, healthIntervalMs: 15_000,
        logFile: join(this.opts.appRoot, "logs", "engines", "ollama.log"),
        validateHealth: async (response: Response) => {
          const value = await response.json().catch(() => null) as { version?: unknown } | null;
          if (value?.version !== OLLAMA_VERSION) return { ok: false, reason: `The managed Ollama runtime must be ${OLLAMA_VERSION}. Repair its installation.` };
          this.publish({ version: value.version });
          return true;
        },
      };
      const supervisor = this.opts.supervise?.(spec) ?? new ChildSupervisor(spec, this.opts.deps);
      this.supervisor = supervisor;
      this.attachRecovery(supervisor);
      this.removeBackstop = (this.opts.registerBackstop ?? registerExitBackstop)(supervisor);
      supervisor.on("status", () => {
        if (this.supervisor !== supervisor || this.closing) return;
        const state = supervisor.status === "healthy" ? "ready" : supervisor.status === "starting" ? "starting" : supervisor.status === "stopped" ? "stopped" : "failed";
        this.publish({ state, detail: supervisor.reason ?? null });
      });
      await supervisor.start();
    });
    this.serial = work.catch(() => {});
    return work;
  }

  private async checkExternal(): Promise<void> {
    const generation = this.generation;
    const revision = ++this.externalHealthRevision;
    const endpoint = this.endpoint();
    try {
      const response = await (this.opts.fetch ?? fetch)(`${endpoint}/api/version`, { signal: AbortSignal.timeout(3_000), redirect: "error" });
      const value = await response.json() as { version?: unknown };
      if (!response.ok || typeof value.version !== "string") throw new Error("The selected service did not report an Ollama version.");
      if (!this.closing && generation === this.generation && revision === this.externalHealthRevision) this.publish({ state: "ready", version: value.version, detail: null });
    } catch {
      if (!this.closing && generation === this.generation && revision === this.externalHealthRevision) this.publish({ state: "failed", version: null, detail: "The selected Ollama service is not answering. Start it or choose Arke-managed." });
    }
  }

  private stopExternalHealth(): void {
    if (this.externalHealthTimer !== null) clearInterval(this.externalHealthTimer);
    this.externalHealthTimer = null;
  }

  async refresh(): Promise<void> {
    if (this.closing) return;
    if (this.externallySelected()) await this.checkExternal();
    else if (!this.supervisor || !this.recoveryFactory && (this.current.state === "failed" || this.current.state === "stopped")) await this.applySettings(this.settings);
  }

  /** Another engine owns the inference lane here. A confirmed crashed child may keep its
   * queued recovery; a live unusable managed child must exit before memory can be handed over. */
  async prepareGpuHandover(): Promise<void> {
    if (this.externallySelected()) return;
    if (this.recoveryPort && this.supervisor?.pid === null && this.supervisor.descendantPids.length === 0) return;
    this.supervisor?.quiesce();
    await this.stopManaged();
  }

  async list(signal: AbortSignal): Promise<readonly string[]> {
    const response = await this.request("/api/tags", { signal });
    const value = await response.json() as { models?: Array<{ name?: string }> };
    if (!Array.isArray(value.models)) throw new Error("Ollama did not report its models.");
    return value.models.flatMap(row => typeof row.name === "string" ? [row.name] : []);
  }

  /** A bounded, content-free first-run check. Never asks a cloud-backed Ollama model to run. */
  async checkLocalModel(model: string, signal: AbortSignal): Promise<void> {
    const generation = this.generation;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    const info = await this.request("/api/show", { method: "POST", signal: bounded,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
    const metadata = await info.json() as { remote_model?: unknown; remote_host?: unknown };
    if (metadata.remote_model || metadata.remote_host || /(?:^|[-:])cloud(?:$|[-:])/i.test(model)) throw new Error("Choose a model that runs on this computer.");
    const response = await this.request("/api/generate", { method: "POST", signal: bounded,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, prompt: "Reply with OK.",
        stream: false, think: false, keep_alive: 0, options: { num_predict: 8, num_ctx: 2048, temperature: 0 } }) });
    const answer = await response.json() as { done?: unknown; response?: unknown; error?: unknown };
    if (answer.error || answer.done !== true || typeof answer.response !== "string" || !answer.response.trim()) throw new Error("The writing model did not return a response. Try again or choose another model.");
    if (generation !== this.generation || this.closing) throw new Error("The local service changed during the check. Check again.");
  }

  async pull(model: string, signal: AbortSignal, progress: (done: number, total: number) => void): Promise<void> {
    const generation = this.generation;
    const response = await this.request("/api/pull", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, stream: true }) });
    if (!response.body) throw new Error("Ollama returned no download progress.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", success = false;
    const take = (line: string) => {
      if (!line.trim()) return;
      const row = JSON.parse(line) as { error?: string; status?: string; completed?: number; total?: number };
      if (row.error) throw new Error(row.error);
      if (row.status === "success") success = true;
      if (typeof row.completed === "number" && typeof row.total === "number") progress(row.completed, row.total);
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        if (buffer.length > 1_000_000) throw new Error("Ollama returned an oversized progress record.");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) { take(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
        if (done) { take(buffer); break; }
      }
      if (!success) throw new Error("Ollama's model download ended before confirming success.");
      if (generation !== this.generation) throw new Error("The Ollama selection changed during download. Install the model on the newly selected service.");
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async remove(model: string, signal: AbortSignal): Promise<void> {
    await this.request("/api/delete", { method: "DELETE", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const base = this.baseUrl();
    if (base === null) throw new Error("The selected Ollama runtime is not ready.");
    const response = await (this.opts.fetch ?? fetch)(`${base}${path}`, { ...init, redirect: "error" });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    return response;
  }

  private async stopOwned(): Promise<void> {
    const worker = this.supervisor;
    if (worker) await worker.stopAndConfirm();
    this.recoveryPort = null;
    const release = this.installationLane; this.installationLane = null; release?.();
    this.supervisor = null;
    this.removeBackstop?.(); this.removeBackstop = null;
  }

  /** Setup owns the file-change interval. Activation stays closed until verified publication;
   * quiescing first also cancels a startup/recovery that stopManaged must otherwise await. */
  async reserveInstallation(releaseLane: () => void = () => {}): Promise<() => void> {
    if (this.closing || this.installing || this.installationLane) {
      releaseLane(); throw new Error("Ollama's files are already changing or stopping.");
    }
    // Ownership of this reservation transfers here. Failed native cleanup keeps it reachable
    // until a later stop confirms exit; rejecting setup must not hand over a possibly live GPU.
    this.installationLane = releaseLane;
    this.installing = true; this.supervisor?.quiesce();
    try {
      await this.stopManaged();
      const release = this.installationLane; this.installationLane = null; release?.();
    }
    catch (error) { this.installing = false; throw error; }
    let held = true;
    return () => { if (held) { held = false; this.installing = false; } };
  }

  async stopManaged(): Promise<void> {
    const work = this.serial.then(async () => {
      if (this.externallySelected()) return;
      if (!this.supervisor) return;
      await this.stopOwned();
      this.publish({ state: "stopped", detail: null });
    });
    this.serial = work.catch(() => {});
    await work;
  }

  /** Close activation immediately; existing inference keeps its process until normal drain. */
  beginShutdown(): void {
    this.closing = true;
    this.stopExternalHealth();
    this.supervisor?.quiesce();
  }

  async dispose(): Promise<void> {
    this.beginShutdown();
    await this.serial;
    await this.stopOwned();
    this.listeners.clear();
  }
}
