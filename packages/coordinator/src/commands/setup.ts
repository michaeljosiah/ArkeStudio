import { VOXA_SETUP_COMPONENT_IDS } from "../setup/catalogue.js";
import { PIPECAT_WHISPER_COMPONENT } from "../local-ai/speech-catalogue.js";
import type { LocalSetupService } from "../setup/local-setup.js";
import type { AppStorageService } from "../storage/service.js";
import type { CommandModule } from "./router.js";

/**
 * Local AI setup: installing, repairing and removing components. Application state, no world.
 * An adapter's component never reaches here: the coordinator's prologue sends it to the adapter
 * library first, under that library's own policy.
 */
export function setupCommands(deps: { setup: () => LocalSetupService | null; storageHealth: () => AppStorageService | null | undefined; speechBackend?: () => Promise<"voxa" | "pipecat"> }) {
  return {
    "repair-voice-models": { scope: "none", async handle() {
      const setup = deps.setup(); if (!setup) return;
      const ids: string[] = [VOXA_SETUP_COMPONENT_IDS.kokoro, VOXA_SETUP_COMPONENT_IDS.whisper];
      if (await deps.speechBackend?.() === "pipecat") ids.push(PIPECAT_WHISPER_COMPONENT);
      const repaired = await Promise.all(ids.map(id => setup.repair(id)));
      if (repaired.some(Boolean)) { await setup.run(); await setup.run(); }
    } },
    "setup-skip": { scope: "none", handle(msg) { deps.setup()?.skip(msg.componentId); } },
    "setup-retry": { scope: "none", handle(msg) { deps.setup()?.retry(msg.componentId); } },
    "setup-pause": { scope: "none", handle(msg) { deps.setup()?.pause(msg.componentId); } },
    "setup-resume": { scope: "none", handle(msg) { deps.setup()?.resume(msg.componentId); } },
    "setup-repair": {
      scope: "none",
      async handle(msg) {
        // Only a completed deletion queues work. A held file remains a stated repair failure;
        // running detection there would otherwise bless the same corrupt bytes as present again.
        const setup = deps.setup();
        if (setup && await setup.repair(msg.componentId, msg.revision)) {
          await setup.run();
          // If Repair joined a pass that had already attempted this component, only a fresh pass
          // can collect the newly queued download. An ordinary completed repair makes this a
          // cheap presence check.
          await setup.run();
        }
      },
    },
    "setup-cancel": { scope: "none", async handle() { await deps.setup()?.cancel(); } },
    "setup-install": {
      scope: "none",
      async handle(msg) {
        const setup = deps.setup();
        if (!setup) return;
        setup.installClosure(msg.componentId);
        // A run already in flight has an `attempted` set, and a component it has been past this
        // round is never picked up again by it — so the press would queue the closure and then
        // do nothing. The repair handler pays the same cost for the same reason: await the pass
        // that is running, then start one that will collect what was just queued.
        await setup.run().catch(() => {});
        await setup.run().catch(() => {});
      },
    },
    "setup-remove": {
      scope: "none",
      async handle(msg) {
        await deps.setup()?.remove(msg.componentId).catch(() => {});
        await deps.storageHealth()?.refresh().catch(() => {});
      },
    },
  } satisfies CommandModule;
}
