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
      },
      worlds: [],
      world: null,
    };
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
      case "world.opened":
      case "world.closed":
      case "proposal.staged":
      case "proposal.resolved":
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
