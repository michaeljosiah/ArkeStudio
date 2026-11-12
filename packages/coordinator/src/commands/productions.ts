import type { ClientState, ConversationId, DomainEvent } from "@arke-studio/contracts";
import { measureProductionMedia } from "../media/measurement.js";
import type { MediaProbe } from "../media/probe.js";
import { saveProductionNarrative } from "../productions/narrative.js";
import { handleProductionSetupCommand } from "../productions/setup-command.js";
import type { WorldChatRunner } from "../world-chat/run.js";
import type { WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

/**
 * A production's spend refreshed, its media measured, its narrative saved and its setup turn run.
 * Each checks its world itself: the spend refresh is sent on its own and is dropped without a word
 * once its world is no longer shown, and the rest answer a world that is not open in their own words.
 */
export function productionCommands(ctx: CommandContext, deps: {
  mediaProbe: MediaProbe | null;
  runtimeStop: AbortSignal;
  backgroundWork: Set<Promise<unknown>>;
  shownWorldId: () => string | undefined;
  scheduleProductionSpend(): Promise<void>;
  broadcastSnapshot(options?: { immediate?: boolean }): void;
  worldOpensSettled(): Promise<void>;
  worldChatRunner(store: WorldStore, conversationId: ConversationId): WorldChatRunner;
  refreshConversations(store: WorldStore): Promise<void>;
  openWorldChat(store: WorldStore, conversationId: ConversationId): Promise<void>;
  stillOpen(store: WorldStore): boolean;
  worldChat: () => ClientState["worldChat"];
  setWorldChat(worldChat: ClientState["worldChat"]): void;
}) {
  return {
    "production-spend-refresh": {
      scope: "any-world",
      async handle(msg) {
        if (deps.shownWorldId() === msg.worldId) await deps.scheduleProductionSpend();
      },
    },
    "measure-production-media": {
      scope: "any-world",
      async handle(msg) {
        const store = ctx.openStore();
        if (!store || store.worldId !== msg.worldId) {
          ctx.emit({ at: ctx.nowIso(), type: "media.measured", worldId: msg.worldId, requestId: msg.requestId, result: { status: "failed", reason: "unavailable" } });
          return;
        }
        const work = measureProductionMedia(store, msg.productionId, msg.source, deps.mediaProbe, msg.expectedHash, deps.runtimeStop);
        deps.backgroundWork.add(work);
        try {
          const result = await work;
          if (deps.stillOpen(store)) {
            if (result.status === "measured") await ctx.refreshWorldSnapshot(store.worldId);
            if (deps.stillOpen(store)) ctx.emit({ at: ctx.nowIso(), type: "media.measured", worldId: msg.worldId, requestId: msg.requestId, result });
          }
        } finally { deps.backgroundWork.delete(work); }
      },
    },
    "save-production-narrative": {
      scope: "any-world",
      async handle(msg) {
        const store = ctx.openStore();
        if (!store || store.worldId !== msg.worldId) throw new Error("Open this production's world before editing its narrative.");
        await saveProductionNarrative(store, msg.productionId, msg.expectedVersion, msg.narrative);
        await ctx.refreshWorldSnapshot(msg.worldId);
        deps.broadcastSnapshot({ immediate: true });
        ctx.emit({ type: "production-narrative.saved", at: ctx.nowIso(), worldId: msg.worldId,
          productionId: msg.productionId, requestId: msg.requestId });
      },
    },
    "production-setup": {
      scope: "any-world",
      async handle(msg) {
        // A setup turn is a World Chat run like any other, and recovery repairs setups too.
        await deps.worldOpensSettled();
        const store = ctx.openStore();
        try {
          if (!store || store.worldId !== msg.worldId) throw new Error("Open the world this production setup belongs to.");
          const state = await handleProductionSetupCommand(store, msg,
            () => deps.worldChatRunner(store, msg.setupId),
            async id => { await deps.refreshConversations(store); await deps.openWorldChat(store, id); });
          if (!deps.stillOpen(store)) return;
          await ctx.refreshWorldSnapshot(msg.worldId);
          await deps.refreshConversations(store);
          if (state.status === "discarded") deps.setWorldChat(null);
          else await deps.openWorldChat(store, msg.setupId);
          ctx.emit({ type: "production-setup.result", at: ctx.nowIso(), worldId: msg.worldId,
            setupId: msg.setupId, requestId: msg.requestId, state });
          deps.broadcastSnapshot();
        } catch (error) {
          let detail = error instanceof Error ? error.message : "This production setup could not be updated.";
          let state: Extract<DomainEvent, { type: "production-setup.result" }>["state"];
          // A refusal can reset review or leave an uncertain creation locked. Publish the
          // durable state before answering so the rail cannot offer actions from the old review.
          if (store && store.worldId === msg.worldId && deps.stillOpen(store) && !store.isClosed()) {
            try {
              await ctx.refreshWorldSnapshot(msg.worldId);
              await deps.refreshConversations(store);
              await deps.openWorldChat(store, msg.setupId);
              const workspace = deps.worldChat();
              if (workspace?.conversationId === msg.setupId) state = workspace.productionSetup;
            } catch {
              detail += " Reopen this setup to refresh its current state.";
            }
          }
          ctx.emit({ type: "production-setup.result", at: ctx.nowIso(), worldId: msg.worldId,
            setupId: msg.setupId, requestId: msg.requestId, state, detail });
        }
      },
    },
  } satisfies CommandModule;
}
