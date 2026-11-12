import { advanceAllPlans, advancePlan, appendPlanEvents, listPlans, planState, type PlanDriverDeps } from "../productions/plans.js";
import type { WorldStore } from "../world/store.js";
import type { CommandModule, CommandOf } from "./router.js";

/** A production's dispatch plans (SPEC-024): continuing, reconfirming, cancelling, listing. Open world only. */
export function planCommands(deps: {
  driver(): PlanDriverDeps;
  emitPlanStates(store: WorldStore, worldId: string, productionId: string): Promise<void>;
  cancelJob(jobId: string): Promise<void>;
}) {
  const approve = async (msg: CommandOf<"plan-continue" | "plan-reconfirm">, store: WorldStore) => {
    const bundle = store.getBundle();
    const production = bundle.productions.find((p) => p.meta.id === msg.productionId);
    const plan = (await listPlans(store, msg.productionId)).find((p) => p.planId === msg.planId);
    if (!production || !plan) return;
    // The visible act, recorded before anything moves (SPEC-024 R-16/R-17). Appending twice
    // is harmless — the fold reads presence, not count.
    await appendPlanEvents(store, msg.productionId, msg.planId, [
      {
        kind: msg.kind === "plan-continue" ? "continue-approved" : "reconfirmed",
        ts: new Date().toISOString(),
        planId: msg.planId,
        passIndex: msg.passIndex,
      },
    ]);
    await advancePlan(store, production, bundle, plan, deps.driver()).catch(() => {});
    await deps.emitPlanStates(store, msg.worldId, msg.productionId);
  };
  return {
    "plan-continue": { scope: "open-world", handle: approve },
    "plan-reconfirm": { scope: "open-world", handle: approve },
    "plan-cancel": {
      scope: "open-world",
      async handle(msg, store) {
        const plan = (await listPlans(store, msg.productionId)).find((p) => p.planId === msg.planId);
        if (!plan) return;
        // The mark first, durably — then the fold: cancelling from a pre-cancel snapshot missed
        // any job a racing advance enqueued in the gap, and every non-terminal job deserves the
        // ask, waiting-reconciliation included.
        await appendPlanEvents(store, msg.productionId, msg.planId, [
          { kind: "cancelled", ts: new Date().toISOString(), planId: msg.planId },
        ]);
        const state = await planState(store, plan, deps.driver());
        // Future spend stops here; in-flight jobs are asked to stop through SPEC-009, which
        // owes no promise about work already running at a provider (R-25).
        for (const pass of state.passes) {
          if (pass.jobId !== undefined && pass.state !== "succeeded" && pass.state !== "failed") {
            await deps.cancelJob(pass.jobId).catch(() => {});
          }
        }
        await deps.emitPlanStates(store, msg.worldId, msg.productionId);
      },
    },
    "list-plans": {
      scope: "open-world",
      async handle(msg, store) {
        const bundle = store.getBundle();
        const production = bundle.productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        // Recovery on request (T-19): advancing is a fold plus at most one durable act per pass,
        // so the first screen that asks after a restart is the reconciliation.
        await advanceAllPlans(store, production, bundle, deps.driver()).catch(() => {});
        await deps.emitPlanStates(store, msg.worldId, msg.productionId);
      },
    },
  } satisfies CommandModule;
}
