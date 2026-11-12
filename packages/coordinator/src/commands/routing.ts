import type { DomainEvent } from "@arke-studio/contracts";
import { describeCoordinatorError } from "../errors/user-message.js";
import type { ProposalManager } from "../gate/proposals.js";
import {
  appendTraversal,
  applyRoutingCommandOnDisk,
  exportInteractiveWithProgress,
  proposeBranchCanon,
  saveRouting,
  type BeatVoices,
  type InteractiveExportResult,
} from "../productions/interactive.js";
import type { WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

type ExportProgressEvent = Extract<DomainEvent, { type: "export.progress" }>;

/**
 * An interactive production's routing: the map saved and edited, a walk recorded, its findings
 * listed, a branch's canon proposed and the whole exported. Open world only.
 */
export function routingCommands(ctx: CommandContext, deps: {
  gate: () => ProposalManager | null | undefined;
  emitRoutingFindings(store: WorldStore, worldId: string, productionId: string): Promise<void>;
  stillOpen(store: WorldStore): boolean;
  refreshIfStillOpen(store: WorldStore): void;
  broadcastSnapshot(): void;
  interactiveExportVoices(store: WorldStore, productionId: string): BeatVoices | undefined;
  publishExportProgress(store: WorldStore, event: ExportProgressEvent): Promise<void>;
  log(entry: { kind: string; reason: string; detail: Record<string, unknown> }): void;
}) {
  return {
    "save-routing": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          // The strict parse IS the no-state import gate (brief §1): a condition key fails here
          // with the key named, before anything touches disk.
          await saveRouting(store, msg.productionId, msg.routing);
          await ctx.refreshWorldSnapshot(msg.worldId);
          await deps.emitRoutingFindings(store, msg.worldId, msg.productionId);
        } catch (err) {
          deps.log({
            kind: "routing.refused",
            reason: err instanceof Error ? err.message : String(err),
            detail: { productionId: msg.productionId },
          });
          deps.broadcastSnapshot();
        }
      },
    },
    "routing-command": {
      scope: "open-world",
      async handle(msg, store) {
        // The frame names its world: handled after a switch to another world that happens to hold
        // a production with the same slug, it must not land there.
        if (!store.getBundle().productions.some((p) => p.meta.id === msg.productionId)) return;
        try {
          // Applied to the routing on disk, not a copy the map held: two edits in flight each
          // land on the other's result (design turn 157).
          await applyRoutingCommandOnDisk(store, msg.productionId, msg.command);
          // Only the world the edit landed in, and only while it is still the open one: a world
          // opened while the edit was in flight must not be closed to reload the edited one.
          if (!deps.stillOpen(store)) return;
          deps.refreshIfStillOpen(store);
          await deps.emitRoutingFindings(store, msg.worldId, msg.productionId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          deps.log({
            kind: "routing.refused",
            reason,
            detail: { productionId: msg.productionId, operation: msg.command.operation },
          });
          // The map closes its editor as it sends; a refusal logged and nothing else read as the
          // edit silently vanishing. The author is told why, in the toast every refusal uses.
          if (deps.stillOpen(store)) {
            ctx.emit({ type: "command.failed", at: new Date().toISOString(), command: msg.kind, requestId: null, reason });
            deps.broadcastSnapshot();
          }
        }
      },
    },
    "record-traversal": {
      scope: "open-world",
      async handle(msg, store) {
        // Evidence is durable and clears export blockers: a walk from a world that has since been
        // switched away from must not land in another world that happens to share the ids.
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production || production.routing === null) return;
        try { await appendTraversal(store, msg.productionId, {
          ts: new Date().toISOString(),
          routingVersion: production.routing.version,
          choiceId: msg.choiceId,
          from: msg.from,
          to: msg.to,
          route: msg.route,
          ...(msg.story ? { story: msg.story } : {}),
        }); } catch (error) {
          if (deps.stillOpen(store) && production.routing.schemaVersion === 2) ctx.emit({ type: "command.failed", at: new Date().toISOString(), command: msg.kind, requestId: null, reason: error instanceof Error ? error.message : String(error) });
        }
        if (!deps.stillOpen(store)) return;
        await deps.emitRoutingFindings(store, msg.worldId, msg.productionId);
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "list-routing-findings": {
      scope: "open-world",
      async handle(msg, store) { await deps.emitRoutingFindings(store, msg.worldId, msg.productionId); },
    },
    "propose-branch-canon": {
      scope: "open-world",
      async handle(msg, store) {
        const gate = deps.gate();
        if (!gate) return;
        try {
          await proposeBranchCanon(store, gate, {
            productionId: msg.productionId,
            sceneId: msg.sceneId,
            route: msg.route,
            title: msg.title,
            body: msg.body,
          });
          await ctx.refreshWorldSnapshot(msg.worldId);
        } catch {
          deps.broadcastSnapshot();
        }
      },
    },
    "export-interactive": {
      scope: "open-world",
      async handle(msg, store) {
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        const voices = deps.interactiveExportVoices(store, production.meta.id);
        const result = await exportInteractiveWithProgress(store, production, () => ctx.nowIso(), {
          onProgress: event => deps.publishExportProgress(store, event), ...(voices === undefined ? {} : { voices }),
        }).catch(
          (err): InteractiveExportResult => ({
            ok: false,
            blockers: [describeCoordinatorError(err)],
          }),
        );
        ctx.emit({
          at: new Date().toISOString(),
          type: "production.interactive-export-result",
          worldId: msg.worldId,
          productionId: msg.productionId,
          disposition: result.ok ? "exported" : "refused",
          ...(result.ok ? { dir: result.dir } : { blockers: result.blockers }),
        });
      },
    },
  } satisfies CommandModule;
}
