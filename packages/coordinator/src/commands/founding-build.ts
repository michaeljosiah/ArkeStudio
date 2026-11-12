import { describeCoordinatorError } from "../errors/user-message.js";
import type { GenesisService } from "../harness/genesis.js";
import { frozenFoundingInput } from "../harness/genesis-conversation.js";
import type { FoundingBuildService } from "../world/founding-build.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

/**
 * The founding build: planned and begun from a genesis, then stopped, run item by item and its
 * notice dismissed for the world it made. A planned build has no world yet; the world's own
 * commands act on that world's build whether or not it is open, and running an item opens it.
 */
export function foundingBuildCommands(ctx: CommandContext, deps: {
  foundingBuild: () => FoundingBuildService | null;
  genesis: () => GenesisService | null;
  /** Genesis ids with a decision in flight. */
  genesisDeciding: Set<string>;
  genesisDir(genesisId: string): Promise<string>;
  openWorld(worldId: string): Promise<void>;
}) {
  return {
    "plan-founding-build": {
      scope: "none",
      async handle(msg) {
        const foundingBuild = deps.foundingBuild();
        if (!foundingBuild) {
          ctx.emit({
            at: new Date().toISOString(),
            type: "build.plan",
            genesisId: msg.genesisId,
            requestId: msg.requestId,
            plan: null,
            reason: "the founding build is not available in this configuration",
          });
          return;
        }
        await foundingBuild.plan(msg.genesisId, msg.requestId, msg.look, msg.models, msg.generateImages);
      },
    },
    "begin-founding-build": {
      scope: "none",
      async handle(msg) {
        const foundingBuild = deps.foundingBuild();
        if (!foundingBuild) return;
        try {
          if (deps.genesis()?.isRunning(msg.genesisId) || deps.genesisDeciding.has(msg.genesisId)) throw new Error("Wait for the current reply or decision before beginning the world.");
          const dir = await deps.genesisDir(msg.genesisId);
          if (!msg.approvalDigest && !await frozenFoundingInput(dir)) throw new Error("Review the current build before Begin.");
          await foundingBuild.begin(msg.genesisId, msg.requestId, msg.look, msg.models, msg.approvalDigest, msg.generateImages);
        } catch (err) {
          ctx.emit({
            at: new Date().toISOString(),
            type: "build.plan",
            genesisId: msg.genesisId,
            requestId: msg.requestId,
            plan: null,
            reason: describeCoordinatorError(err),
          });
        }
      },
    },
    "stop-founding-build": { scope: "any-world", async handle(msg) { await deps.foundingBuild()?.stop(msg.worldId); } },
    "run-build-item": {
      scope: "any-world",
      async handle(msg) {
        const foundingBuild = deps.foundingBuild();
        if (!foundingBuild) return;
        // The landing paths need the build's world open; Activity may be scoped elsewhere.
        if (ctx.openStore()?.worldId !== msg.worldId) {
          await deps.openWorld(msg.worldId).catch(() => {});
        }
        await foundingBuild.runItems(msg.worldId, msg.itemKey, msg.requestId).catch(() => {});
      },
    },
    "dismiss-build-notice": { scope: "any-world", async handle(msg) { await deps.foundingBuild()?.dismissNotice(msg.worldId); } },
  } satisfies CommandModule;
}
