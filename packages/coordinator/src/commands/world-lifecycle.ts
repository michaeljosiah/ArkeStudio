import { basename, join } from "node:path";
import type { ClientState, WorldBundle, WorldSummary } from "@arke-studio/contracts";
import { describeCoordinatorError } from "../errors/user-message.js";
import type { FoundingBuildService } from "../world/founding-build.js";
import type { GenesisService } from "../harness/genesis.js";
import { foundingMessages, genesisControlDir, reserveGenesisWorld } from "../harness/genesis-conversation.js";
import { atomicWriteFile } from "../world/atomic.js";
import type { WorldProvider } from "../world-provider.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

/**
 * A world opened, created, archived, and an edit made outside the app reconciled. Opening and
 * creating choose the world rather than act in one; archiving and reconciling name theirs, open or
 * not, and the provider answers for it.
 */
export function worldLifecycleCommands(ctx: CommandContext, deps: {
  provider: WorldProvider;
  openWorld(worldId: string): Promise<void>;
  failWorldOpen(worldId: string, err: unknown): Promise<void>;
  setDisplayWorld(world: WorldBundle | null): void;
  state: () => ClientState;
  setWorlds(worlds: WorldSummary[]): void;
  broadcastSnapshot(): void;
  genesis: () => GenesisService | null;
  foundingBuild: () => FoundingBuildService | null;
  completeGenesisFormHandoff(genesisId: string, worldId: string): Promise<void>;
  /** Form handoffs in flight by genesis, so a discard cannot delete the sandbox under the copy. */
  carrying: Map<string, Promise<void>>;
}) {
  return {
    "open-world": {
      scope: "none",
      async handle(msg) {
        try {
          await deps.openWorld(msg.worldId);
        } catch (err) {
          /*
           * Every way a world can fail to open ends here, and this used to end nowhere (issue 571).
           *
           * The catch was written for one of them — an unknown world id from a stale client, which
           * the next snapshot corrects — and swallowed the rest. But `WorldStore.open` also refuses
           * for reasons it has already worded: the world is open in another process, an entity's
           * history conflicts with its committed version, a scan cannot read the folder. Those
           * refusals were dropped in silence: no log line, and the throw lands before both
           * `world.opened` and the snapshot that follows it, so the screen sat on "opening the
           * world" indefinitely with nothing anywhere saying why. There is no next snapshot to be
           * corrected by, because nothing else sends one.
           *
           * All three of the ways out are needed. The log is for afterwards, the event for anything
           * listening, and the snapshot for the screen — which has no correlation to its own
           * request and cannot otherwise tell a refusal from a world still opening.
           */
          await deps.failWorldOpen(msg.worldId, err);
        }
      },
    },
    "create-world": {
      scope: "none",
      async handle(msg) {
        const create = deps.provider.createWorld?.bind(deps.provider);
        if (!create) return;
        try {
          const sandbox = msg.genesisId ? await deps.provider.genesisDir?.(msg.genesisId) : undefined;
          if (sandbox && (await foundingMessages(sandbox)).length) {
            ctx.emit({ type: "genesis.status", at: new Date().toISOString(), genesisId: msg.genesisId!, status: "failed",
              detail: "Review the proposed content and use Begin in the conversation to save the approved world." });
            return;
          }
          if (msg.genesisId && (deps.genesis()?.isRunning(msg.genesisId) || deps.foundingBuild()?.isBeginning(msg.genesisId))) throw new Error("Wait for the current founding operation to finish.");
          const creationId = sandbox ? await reserveGenesisWorld(sandbox) : undefined;
          const { worldId } = await create({
            ...(creationId ? { creationId } : {}),
            name: msg.name,
            ...(msg.logline !== undefined ? { logline: msg.logline } : {}),
            ...(msg.tone !== undefined ? { tone: msg.tone } : {}),
            ...(msg.genre !== undefined ? { genre: msg.genre } : {}),
            ...(msg.artDirection !== undefined ? { artDirection: msg.artDirection } : {}),
            ...(msg.bible !== undefined ? { bible: msg.bible } : {}),
            ...(msg.models !== undefined ? { models: msg.models } : {}),
          });
          if (sandbox) await atomicWriteFile(join(genesisControlDir(sandbox), "begun.json"), JSON.stringify({ worldId, form: true }) + "\n");
          deps.setWorlds(await deps.provider.listWorlds());
          await deps.openWorld(worldId);
          // After the world is open, so filing has a store to commit into. Whatever was handed
          // to the conversation is now an artifact like any other.
          const genesisId = msg.genesisId;
          if (genesisId !== undefined) {
            // Held so a discard cannot delete the sandbox out from under the copy. The screen
            // discards as soon as the world opens, which is while this is still running.
            const carry = deps.completeGenesisFormHandoff(genesisId, worldId);
            deps.carrying.set(genesisId, carry);
            await carry.finally(() => deps.carrying.delete(genesisId));
          }
        } catch (err) {
          if (msg.genesisId) ctx.emit({ type: "genesis.status", at: ctx.nowIso(), genesisId: msg.genesisId, status: "failed", detail: describeCoordinatorError(err) });
          deps.broadcastSnapshot(); // surface whatever state we do have
        }
      },
    },
    "archive-world": {
      scope: "any-world",
      async handle(msg) {
        // Anything not in this set is still going somewhere, so the world stays put.
        const TERMINAL_JOB_STATUS = new Set(["succeeded", "failed", "cancelled"]);
        const archive = deps.provider.archiveWorld?.bind(deps.provider);
        if (!archive) return;

        const summary = deps.state().worlds.find((w) => w.worldId === msg.worldId);
        const refuse = (reason: string) =>
          ctx.emit({
            at: new Date().toISOString(),
            type: "world.archive-refused",
            worldId: msg.worldId,
            reason,
          });
        // Work in flight keeps its world. Moving the folder under a running job turns a job
        // that would have finished into one that fails writing its result somewhere gone.
        const inFlight = deps
          .state()
          .app.jobs.filter((j) => j.worldId === msg.worldId && !TERMINAL_JOB_STATUS.has(j.status));
        if (inFlight.length > 0) {
          refuse(
            `${inFlight.length} job${inFlight.length === 1 ? " is" : "s are"} still running for this world — let them finish or cancel them first`,
          );
          return;
        }
        try {
          const { folder } = await archive(msg.worldId);
          if (deps.state().world?.meta.worldId === msg.worldId) deps.setDisplayWorld(null);
          deps.setWorlds(await deps.provider.listWorlds());
          ctx.emit({
            at: new Date().toISOString(),
            type: "world.archived",
            worldId: msg.worldId,
            name: summary?.name ?? "that world",
            folder: basename(folder),
          });
        } catch (err) {
          refuse(describeCoordinatorError(err));
        }
        deps.broadcastSnapshot();
      },
    },
    "reconcile-external-edit": {
      scope: "any-world",
      async handle(msg) {
        const reconcile = deps.provider.reconcileExternalEdit?.bind(deps.provider);
        if (!reconcile) return;
        try {
          deps.setDisplayWorld(await reconcile(msg.worldId, msg.path));
        } catch {
          /* refusal shows up as the edit still listed */
        }
        deps.broadcastSnapshot();
      },
    },
  } satisfies CommandModule;
}
