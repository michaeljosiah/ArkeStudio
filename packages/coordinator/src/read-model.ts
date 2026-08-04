import {
  type AppHealth,
  type ClientState,
  type DomainEvent,
  type HealthComponent,
  type WorldBundle,
  type WorldSummary,
} from "@arke-studio/contracts";

/**
 * Folds world state and events into the shape the client renders (SPEC-001 §2.6). Pure state
 * container: validation happens at the boundaries (transport out, provider in), never here.
 */
export class ReadModel {
  private state: ClientState;

  constructor(appVersion: string) {
    const unavailable = { status: "unavailable" as const, reason: "not started" };
    this.state = {
      app: {
        version: appVersion,
        health: {
          coordinator: { status: "starting" },
          harness: unavailable,
          voice: unavailable,
        },
        jobs: [],
        ledger: [],
        providers: [],
        manifest: null,
        routing: { defaults: {}, faults: [] },
        spend: null,
        runtime: null,
        drift: [],
        agents: [],
        harnessModels: [],
        queues: [],
        setup: null,
        env: null,
      },
      worlds: [],
      world: null,
    };
  }

  /** Seed the app-config slice at start-up (SPEC-008): manifest, providers, routing, spend. */
  seedAppConfig(config: Partial<Pick<ClientState["app"], "manifest" | "providers" | "routing" | "spend" | "runtime" | "drift">>): void {
    this.state = { ...this.state, app: { ...this.state.app, ...config } };
  }

  /** Local-runtime setup progress, kept so a client that connects mid-download sees it. */
  setSetup(setup: NonNullable<ClientState["app"]["setup"]>): void {
    this.state = { ...this.state, app: { ...this.state.app, setup } };
  }

  /** The one-shot environment verification, kept so late-joining clients still see it. */
  setEnv(env: NonNullable<ClientState["app"]["env"]>): void {
    this.state = { ...this.state, app: { ...this.state.app, env } };
  }

  /** The roster as it will run, and what the harness says it can run. */
  setAgents(agents: ClientState["app"]["agents"]): void {
    this.state = { ...this.state, app: { ...this.state.app, agents } };
  }

  setHarnessModels(harnessModels: ClientState["app"]["harnessModels"]): void {
    this.state = { ...this.state, app: { ...this.state.app, harnessModels } };
  }

  getState(): ClientState {
    return this.state;
  }

  setWorlds(worlds: WorldSummary[]): void {
    this.state = { ...this.state, worlds };
  }

  setWorld(world: WorldBundle | null): void {
    this.state = { ...this.state, world };
  }

  setHealth(component: HealthComponent, health: AppHealth[HealthComponent]): void {
    this.state = {
      ...this.state,
      app: { ...this.state.app, health: { ...this.state.app.health, [component]: health } },
    };
  }

  seedJobs(jobs: ClientState["app"]["jobs"]): void {
    this.state = { ...this.state, app: { ...this.state.app, jobs } };
  }

  seedLedger(ledger: ClientState["app"]["ledger"]): void {
    this.state = { ...this.state, app: { ...this.state.app, ledger } };
  }

  /** Fold one domain event. Unknown-to-this-fold events are deliberate no-ops. */
  apply(event: DomainEvent): void {
    switch (event.type) {
      case "health.changed": {
        this.setHealth(event.component, {
          status: event.status,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        });
        return;
      }
      case "job.updated": {
        const jobs = [...this.state.app.jobs];
        const i = jobs.findIndex((j) => j.id === event.job.id);
        if (i === -1) jobs.push(event.job);
        else jobs[i] = event.job;
        this.state = { ...this.state, app: { ...this.state.app, jobs } };
        return;
      }
      case "ledger.appended": {
        this.state = {
          ...this.state,
          app: { ...this.state.app, ledger: [...this.state.app.ledger, event.entry] },
        };
        return;
      }
      case "provider.status": {
        this.state = { ...this.state, app: { ...this.state.app, providers: event.providers } };
        return;
      }
      case "routing.changed": {
        this.state = {
          ...this.state,
          app: { ...this.state.app, routing: { defaults: event.routing, faults: event.faults } },
        };
        return;
      }
      case "spend.status": {
        this.state = { ...this.state, app: { ...this.state.app, spend: event.spend } };
        return;
      }
      case "runtime.status": {
        this.state = { ...this.state, app: { ...this.state.app, runtime: event.runtime } };
        return;
      }
      case "manifest.drift": {
        this.state = { ...this.state, app: { ...this.state.app, drift: event.reports } };
        return;
      }
      case "queue.status": {
        const queues = [...this.state.app.queues];
        const i = queues.findIndex((q) => q.provider === event.queue.provider);
        if (i === -1) queues.push(event.queue);
        else queues[i] = event.queue;
        this.state = { ...this.state, app: { ...this.state.app, queues } };
        return;
      }
      case "queue.reconciled":
        // A report, not state: the Activity screen shows it transiently; jobs carry the truth.
        return;
      case "entity.changed": {
        const world = this.state.world;
        if (!world || world.meta.worldId !== event.worldId) return;
        this.state = { ...this.state, world: { ...world, changes: [...world.changes, event.change] } };
        return;
      }
      case "canon.revision.advanced": {
        const world = this.state.world;
        if (!world || world.meta.worldId !== event.worldId) return;
        this.state = {
          ...this.state,
          world: { ...world, meta: { ...world.meta, canonRevision: event.revision } },
        };
        return;
      }
      case "take.recorded": {
        this.mutateProduction(event.worldId, event.productionId, (p) => ({
          ...p,
          takes: [...p.takes, event.take],
        }));
        return;
      }
      case "review.recorded": {
        this.mutateProduction(event.worldId, event.productionId, (p) => ({
          ...p,
          reviews: [...p.reviews, event.review],
        }));
        return;
      }
      case "selection.changed": {
        this.mutateProduction(event.worldId, event.productionId, (p) => ({
          ...p,
          selections: { ...p.selections, [event.shotId]: event.selection },
        }));
        return;
      }
      case "world.stale": {
        const world = this.state.world;
        if (!world || world.meta.worldId !== event.worldId) return;
        this.state = { ...this.state, world: { ...world, stale: true } };
        return;
      }
      case "world.opened":
      case "world.closed":
      case "proposal.staged":
      case "proposal.resolved":
      case "proposal.blocked":
      case "main-photo.acceptance":
      case "authoring.progress":
      case "authoring.status":
      case "permission.pending":
      case "permission.settled":
      case "canon.answer":
      case "canon.search":
      case "canon.refs":
      case "sheet.refs":
      case "voice.candidates":
      case "voice.preview":
      case "dictation.result":
      case "voice.sidecar":
      case "export.progress":
      case "import.report":
      case "artifact.notice":
      case "env.check":
      case "update.status":
      case "diagnostics.ready":
        // Signals only in SPEC-001: the bundle arrives via a fresh snapshot, and proposals
        // are static fixtures until the gate lands in SPEC-004.
        return;
    }
  }

  private mutateProduction(
    worldId: string,
    productionId: string,
    fn: (p: NonNullable<ClientState["world"]>["productions"][number]) => typeof p,
  ): void {
    const world = this.state.world;
    if (!world || world.meta.worldId !== worldId) return;
    const productions = world.productions.map((p) => (p.meta.id === productionId ? fn(p) : p));
    this.state = { ...this.state, world: { ...world, productions } };
  }
}
