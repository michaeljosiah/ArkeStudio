import type { ComfyUiSettings, ComfyUiStatus, RuntimeProbes } from "@arke-studio/contracts";
import { ComfyUiEngineService, type EngineServiceDeps } from "./engine.js";

/** Recipe startup requirements belong to a separate process, never to a user's shared URL. */
export class ProfiledComfyUiEngineService extends ComfyUiEngineService {
  private readonly worker: ComfyUiEngineService;
  private profileWork: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(deps: EngineServiceDeps, private readonly model: string, launch: NonNullable<EngineServiceDeps["launch"]>) {
    super({ ...deps, recipes: deps.recipes.filter(recipe => recipe.id !== model) });
    this.worker = new ComfyUiEngineService({ ...deps, recipes: deps.recipes.filter(recipe => recipe.id === model), launch });
  }

  override subscribe(listener: () => void): () => void {
    const primary = super.subscribe(listener);
    const worker = this.worker.subscribe(listener);
    return () => { primary(); worker(); };
  }

  override applySettings(settings: ComfyUiSettings): Promise<void> {
    const work = this.profileWork.then(async () => {
      if (this.closing) return;
      const results = await Promise.allSettled([super.applySettings(settings), this.worker.applySettings(settings)]);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    this.profileWork = work.catch(() => {});
    return work;
  }

  override baseUrl(model?: string): string | null {
    return model === this.model ? this.worker.baseUrl() : super.baseUrl();
  }

  override baseUrls(): readonly string[] {
    return [...new Set([super.baseUrl(), this.worker.baseUrl()].filter((url): url is string => url !== null))];
  }

  override instanceId(model?: string): string | null {
    return model === this.model ? this.worker.instanceId() : super.instanceId();
  }

  override engineIdentity(model?: string) {
    return model === this.model ? this.worker.engineIdentity() : super.engineIdentity();
  }

  override identityFor(model: string) {
    return model === this.model ? this.worker.identityFor(model) : super.identityFor(model);
  }

  override async status(probes: RuntimeProbes | null): Promise<ComfyUiStatus> {
    const [primary, worker] = await Promise.all([super.status(probes), this.worker.status(probes)]);
    return { ...primary, recipes: [...primary.recipes, ...worker.recipes] };
  }

  override preflight(model: string, forceHash = false) {
    return model === this.model ? this.worker.preflight(model, forceHash) : super.preflight(model, forceHash);
  }

  override reverify(models?: readonly string[], forceHash = false): Promise<void> {
    const work = this.profileWork.then(async () => {
      if (this.closing) return;
      if (models === undefined || models.includes(this.model)) {
        // Download completion activates an idle worker. Never restart a healthy worker or
        // the primary process, which may already have another recipe's job in flight.
        await this.worker.activateInstalledProfile();
        await this.worker.reverify([this.model], forceHash);
      }
      const primary = models?.filter(model => model !== this.model);
      if (primary === undefined || primary.length > 0) await super.reverify(primary, forceHash);
    });
    this.profileWork = work.catch(() => {});
    return work;
  }

  override async checkNow(): Promise<void> {
    await super.checkNow();
    if (!this.closing) await this.worker.checkNow();
  }

  override async waitUntilReady(timeoutMs = 120_000): Promise<boolean> {
    const primary = await super.waitUntilReady(timeoutMs);
    if (this.worker.engineStatus().state === "starting") await this.worker.waitUntilReady(timeoutMs);
    return primary;
  }

  override stopManagedSupervision(): Promise<boolean> {
    const work = this.profileWork.then(async () => {
      const worker = await this.worker.stopManagedSupervision();
      return (await super.stopManagedSupervision()) || worker;
    });
    this.profileWork = work.then(() => {}, () => {});
    return work;
  }

  override async dispose(): Promise<void> {
    this.closing = true;
    const stopped = Promise.all([super.dispose(), this.worker.dispose()]);
    await this.profileWork;
    await stopped;
  }
}
