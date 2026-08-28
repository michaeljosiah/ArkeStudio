import {
  IDLE_UPDATE_STATE,
  vendorAuthUnavailable,
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
        builds: [],
        ledger: [],
        ledgerUnavailable: false,
        providers: [],
        providerTools: [],
        vendorAuth: vendorAuthUnavailable("the harness has not started"),
        manifest: null,
        routing: { defaults: {}, faults: [] },
        models: { disabled: [] },
        presets: [],
        spend: null,
        backgroundNotifications: "issues-only",
        research: { web: false },
        narrator: null,
        appearance: { theme: "system" },
        runtime: null,
        harness: null,
        comfyui: null,
        voiceRuntime: null,
        drift: [],
        agents: [],
        harnessModels: [],
        harnessInfo: null,
        queues: [],
        setup: null,
        update: IDLE_UPDATE_STATE,
        env: null,
        sampleWorld: { available: false, installing: false, note: null },
      },
      worlds: [],
      world: null,
      worldOpenFailure: null,
      worldChat: null,
      bench: null,
      // Always empty here, and filled on the way out by the coordinator, which is the only thing
      // holding the running sessions (issue 239).
      authoringRuns: [],
    };
  }

  /** Seed the app-config slice at start-up (SPEC-008): manifest, providers, routing, spend. */
  seedAppConfig(
    config: Partial<
      Pick<
        ClientState["app"],
        | "manifest"
        | "providers"
        | "providerTools"
        | "routing"
        | "models"
        | "presets"
        | "spend"
        | "backgroundNotifications"
        | "research"
        | "appearance"
        | "narrator"
        | "runtime"
        | "drift"
        | "harnessInfo"
      >
    >,
  ): void {
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

  /** Whether this build has a sample world, and how the last install of it went. */
  setSampleWorld(patch: Partial<ClientState["app"]["sampleWorld"]>): void {
    const sampleWorld = { ...this.state.app.sampleWorld, ...patch };
    this.state = { ...this.state, app: { ...this.state.app, sampleWorld } };
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
    // Closing or switching worlds drops the open conversation with it: a transcript belongs to
    // the world it was about, and leaving one behind would show it under the next world opened.
    // The open bench session goes the same way, for the same reason (issue 305).
    /*
     * A refusal is settled by *its own* world opening, and by nothing else (issue 571, Codex
     * round 2).
     *
     * Clearing on any world at all looked right and was not: an unknown id refused while another
     * world stays open leaves that world being refreshed constantly — a media backfill, an
     * adopted Bible edit — and each refresh came through here and wiped the refusal for a world
     * that still had not opened. The route for it then fell back to the loader for good, because
     * `useOpenWorldGuard` sees an unchanged route, connection and open-world id, so its effect
     * never runs again and nothing re-asks.
     */
    const settled = world !== null && this.state.worldOpenFailure?.worldId === world.meta.worldId;
    this.state = {
      ...this.state,
      world,
      worldOpenFailure: settled ? null : this.state.worldOpenFailure,
      worldChat: world === null ? null : this.state.worldChat,
      bench: world === null ? null : this.state.bench,
    };
  }

  /**
   * A world was asked for and did not open (issue 571). Recorded beside `world` rather than
   * left to the event alone, because the client's request carries no correlation and its
   * loader has nothing else to end on.
   */
  setWorldOpenFailure(failure: ClientState["worldOpenFailure"]): void {
    this.state = { ...this.state, worldOpenFailure: failure };
  }

  /**
   * Conversation rows, without re-reading the world.
   *
   * `.conversations` is excluded from the watcher on purpose — a transcript is not world state and
   * must not trigger a rescan — which means nothing else notices when a conversation is created,
   * renamed, closed or reopened. This is how those changes reach the screen.
   */
  setConversations(conversations: NonNullable<ClientState["world"]>["conversations"]): void {
    if (!this.state.world) return;
    this.state = { ...this.state, world: { ...this.state.world, conversations } };
  }

  setWorldChat(worldChat: ClientState["worldChat"]): void {
    this.state = { ...this.state, worldChat };
  }

  setBench(bench: ClientState["bench"]): void {
    this.state = { ...this.state, bench };
  }

  /** Session rows without a rescan — `.sessions` is watcher-ignored, like `.conversations`. */
  setBenchSessions(benchSessions: NonNullable<ClientState["world"]>["benchSessions"]): void {
    if (!this.state.world) return;
    this.state = { ...this.state, world: { ...this.state.world, benchSessions } };
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

  /** Founding builds known at startup (SPEC-031 R-33); later changes fold from build.state. */
  setBuilds(builds: ClientState["app"]["builds"]): void {
    this.state = { ...this.state, app: { ...this.state.app, builds } };
  }

  /**
   * Seed the ledger read at start-up — and whether that read failed, which is a published fact
   * (SPEC-032 R-21): folded into an empty array, an unreadable ledger reads as a clean one.
   */
  seedLedger(ledger: ClientState["app"]["ledger"], unavailable: boolean): void {
    this.state = { ...this.state, app: { ...this.state.app, ledger, ledgerUnavailable: unavailable } };
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
      case "build.state": {
        const builds = [...this.state.app.builds];
        const i = builds.findIndex((build) => build.buildId === event.state.buildId);
        if (i === -1) builds.push(event.state);
        else builds[i] = event.state;
        this.state = { ...this.state, app: { ...this.state.app, builds } };
        return;
      }
      case "job.deleted": {
        this.state = {
          ...this.state,
          app: { ...this.state.app, jobs: this.state.app.jobs.filter((j) => j.id !== event.jobId) },
        };
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
      case "provider.tool-status": {
        this.state = { ...this.state, app: { ...this.state.app, providerTools: event.tools } };
        return;
      }
      case "vendor-auth.status": {
        this.state = { ...this.state, app: { ...this.state.app, vendorAuth: event.auth } };
        return;
      }
      case "routing.changed": {
        this.state = {
          ...this.state,
          app: {
            ...this.state.app,
            routing: {
              defaults: event.routing,
              faults: event.faults,
            },
          },
        };
        return;
      }
      case "models.changed": {
        this.state = {
          ...this.state,
          app: {
            ...this.state.app,
            models: event.models,
            routing: {
              ...this.state.app.routing,
              faults: event.faults,
            },
          },
        };
        return;
      }
      case "presets.changed": {
        this.state = { ...this.state, app: { ...this.state.app, presets: event.presets } };
        return;
      }
      case "spend.status": {
        this.state = { ...this.state, app: { ...this.state.app, spend: event.spend } };
        return;
      }
      case "background-notifications.changed": {
        this.state = { ...this.state, app: { ...this.state.app, backgroundNotifications: event.preference } };
        return;
      }
      case "narrator.changed": {
        this.state = { ...this.state, app: { ...this.state.app, narrator: event.voice } };
        return;
      }
      case "appearance.changed": {
        this.state = { ...this.state, app: { ...this.state.app, appearance: { theme: event.preference } } };
        return;
      }
      case "runtime.status": {
        this.state = { ...this.state, app: { ...this.state.app, runtime: event.runtime } };
        return;
      }
      case "harness.status": {
        this.state = { ...this.state, app: { ...this.state.app, harness: event.harness } };
        return;
      }
      case "comfyui.status": {
        this.state = { ...this.state, app: { ...this.state.app, comfyui: event.comfyui } };
        return;
      }
      case "voice.sidecar": {
        this.state = {
          ...this.state,
          app: { ...this.state.app, ...(event.runtime !== undefined ? { voiceRuntime: event.runtime } : {}) },
        };
        return;
      }
      case "voice.audio":
      case "voice.assignment-result":
        return;
      case "update.status": {
        this.state = { ...this.state, app: { ...this.state.app, update: event.update } };
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
      case "queue.enqueue-result":
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
          takes: p.takes.some((take) => take.id === event.take.id) ? p.takes : [...p.takes, event.take],
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
      case "world.open-failed":
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
      case "export.progress":
      case "import.report":
      case "artifact.notice":
      case "env.check":
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
