import type { ClientState } from "./client-state.js";
import type { DomainEvent } from "./events.js";

/**
 * The events the coordinator's read model and the client's store both fold into `ClientState`,
 * applied once, here (issue 2799). Each side kept its own copy, arm for arm, and the copies had
 * begun to apply different world rules. Pure and immutable: the state passed in is never changed.
 * Returns null for an event this does not fold, which the caller then handles itself (the read
 * model's world list, export reads and genesis bookkeeping) or ignores.
 */
export function applyClientStateEvent(state: ClientState, event: DomainEvent): ClientState | null {
  switch (event.type) {
    case "onboarding.changed":
      return { ...state, app: { ...state.app, onboarding: event.onboarding } };
    case "health.changed":
      return {
        ...state,
        app: {
          ...state.app,
          health: {
            ...state.app.health,
            [event.component]: {
              status: event.status,
              ...(event.reason !== undefined ? { reason: event.reason } : {}),
            },
          },
        },
      };
    case "audiobook.activity": {
      const runs = [event.run, ...(state.app.audiobookActivity ?? []).filter(run => run.id !== event.run.id)].slice(0, 200);
      return { ...state, app: { ...state.app, audiobookActivity: runs } };
    }
    case "job.updated": {
      const jobs = [...state.app.jobs];
      const i = jobs.findIndex((j) => j.id === event.job.id);
      if (i === -1) jobs.push(event.job);
      else jobs[i] = event.job;
      return { ...state, app: { ...state.app, jobs } };
    }
    case "build.state": {
      const builds = [...state.app.builds];
      const i = builds.findIndex((build) => build.buildId === event.state.buildId);
      if (i === -1) builds.push(event.state);
      else builds[i] = event.state;
      return { ...state, app: { ...state.app, builds } };
    }
    case "job.deleted":
      // The row leaves Activity; its ledger entry stays, so spend does not move.
      return { ...state, app: { ...state.app, jobs: state.app.jobs.filter((j) => j.id !== event.jobId) } };
    case "production.frame-run": {
      // A frame run is the open world's; one in another world is the snapshot's to deliver, not
      // this fold's, as the coordinator always held (issue 2799, where the client's copy had drifted).
      if (state.world?.meta.worldId !== event.worldId) return state;
      const frameRuns = state.frameRuns.filter((run) => run.run.id !== event.runId);
      if (event.state !== null) frameRuns.push(event.state);
      return { ...state, frameRuns };
    }
    case "editor-effect.analysis": {
      const effectAnalyses = (state.effectAnalyses ?? []).filter(row => row.worldId !== event.worldId || row.productionId !== event.productionId);
      if (event.analysis !== null) effectAnalyses.push(event.analysis);
      return { ...state, effectAnalyses };
    }
    case "ledger.appended":
      return { ...state, app: { ...state.app, ledger: [...state.app.ledger, event.entry] } };
    case "provider.status":
      return { ...state, app: { ...state.app, providers: event.providers } };
    case "provider.tool-status":
      // Folded late (2026-08-26): without this arm the absent → signing-in → ready progression
      // only ever arrived by reconnect snapshot, so the row could not move while you watched.
      return { ...state, app: { ...state.app, providerTools: event.tools } };
    case "vendor-auth.status":
      return { ...state, app: { ...state.app, vendorAuth: event.auth } };
    case "routing.changed":
      return { ...state, app: { ...state.app, routing: { defaults: event.routing, faults: event.faults } } };
    case "presets.changed":
      return { ...state, app: { ...state.app, presets: event.presets } };
    case "models.changed":
      // Faults travel with availability because they are the same act: switching a model off can
      // strand the default that points at it, and the two arriving separately would show a
      // studio that briefly claims a routing it cannot honour.
      return {
        ...state,
        app: {
          ...state.app,
          models: event.models,
          routing: { ...state.app.routing, faults: event.faults },
        },
      };
    case "spend.status":
      return { ...state, app: { ...state.app, spend: event.spend } };
    case "background-notifications.changed":
      return { ...state, app: { ...state.app, backgroundNotifications: event.preference } };
    case "prompt-tools.changed":
      return { ...state, app: { ...state.app, promptTools: event.enabled } };
    case "appearance.changed":
      return { ...state, app: { ...state.app, appearance: { theme: event.preference } } };
    case "narrator.changed":
      return { ...state, app: { ...state.app, narrator: event.voice } };
    case "provider-plans.changed":
      // The manifest travels with the plans: every price on screen reads it (design turn 182).
      return { ...state, app: { ...state.app, providerPlans: event.plans, manifest: event.manifest } };
    case "runtime.status":
      return { ...state, app: { ...state.app, runtime: event.runtime } };
    case "local-ai.residency":
      return { ...state, app: { ...state.app, residency: event.residency } };
    case "comfyui.status":
      return { ...state, app: { ...state.app, comfyui: event.comfyui } };
    case "ollama.status":
      return { ...state, app: { ...state.app, ollama: event.ollama } };
    case "storage.health":
      return { ...state, app: { ...state.app, storageHealth: event.health } };
    case "system.resources":
      return { ...state, app: { ...state.app, systemResources: event.resources } };
    case "recovery.history":
      return { ...state, app: { ...state.app, recoveryHistory: event.history } };
    case "recovery.policy": return { ...state, app: { ...state.app, recoveryPolicy: event.policy } };
    case "recovery.notice":
    case "recovery.history-page":
    case "recovery.command-result": return state;
    case "recovery.action-result": return state;
    case "adapters.changed":
      return { ...state, app: { ...state.app, adapters: event.adapters } };
    case "harness.status":
      return { ...state, app: { ...state.app, harness: event.harness } };
    case "voice.sidecar":
      return event.runtime === undefined
        ? state
        : { ...state, app: { ...state.app, voiceRuntime: event.runtime } };
    case "manifest.drift":
      return { ...state, app: { ...state.app, drift: event.reports } };
    case "queue.status": {
      const queues = [...state.app.queues];
      const i = queues.findIndex((q) => q.provider === event.queue.provider);
      if (i === -1) queues.push(event.queue);
      else queues[i] = event.queue;
      return { ...state, app: { ...state.app, queues } };
    }
    case "update.status":
      return { ...state, app: { ...state.app, update: event.update } };
    case "activity.seen":
      return { ...state, app: { ...state.app, activitySeen: event.seen } };
    case "account.changed":
      return { ...state, app: { ...state.app, account: event.account } };
    case "take.recorded":
    case "review.recorded":
    case "selection.changed": {
      if (!state.world || state.world.meta.worldId !== event.worldId) return state;
      const productions = state.world.productions.map((p) => {
        if (p.meta.id !== event.productionId) return p;
        if (event.type === "take.recorded") {
          return {
            ...p,
            takes: p.takes.some((take) => take.id === event.take.id) ? p.takes : [...p.takes, event.take],
          };
        }
        if (event.type === "review.recorded") return { ...p, reviews: [...p.reviews, event.review] };
        return { ...p, selections: { ...p.selections, [event.shotId]: event.selection } };
      });
      return { ...state, world: { ...state.world, productions } };
    }
    default:
      return null;
  }
}
