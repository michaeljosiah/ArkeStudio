import type { PromptInspection, PromptInspectSource, PromptToolsResult } from "@arke-studio/contracts";
import type { AppSettingsFile } from "../app-settings.js";
import { readShotPromptHistory, restoreShotPrompt } from "../productions/prompt-tools.js";
import type { WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/**
 * Prompt history and inspection: a shot's prompt history read and restored, a request inspected,
 * and the setting that turns them on. Each read answers a world that is not open with its own
 * failed result, which the tool waits on by its request, so they check the world themselves.
 */
export function promptToolsCommands(ctx: CommandContext, deps: {
  enabled: () => boolean;
  appSettings: () => AppSettingsFile | null;
  inspectPromptRequest(store: WorldStore, source: PromptInspectSource, requestId: string): Promise<PromptInspection>;
  stillOpen(store: WorldStore): boolean;
}) {
  const read = async (msg: CommandOf<"prompt-history-read" | "prompt-history-restore" | "prompt-request-inspect">) => {
    const store = ctx.openStore();
    let result: PromptToolsResult;
    try {
      if (!deps.enabled()) throw Error("Enable Prompt history and inspection in Settings → General first.");
      if (!store || store.worldId !== msg.worldId) throw Error("The owning world is not open.");
      if (msg.kind === "prompt-history-read") result = { kind: "history", history: await readShotPromptHistory(store,
        { productionId: msg.productionId, sceneId: msg.sceneId, shotId: msg.shotId, capability: msg.capability }) };
      else if (msg.kind === "prompt-history-restore") {
        const version = await restoreShotPrompt(store, msg, msg);
        await ctx.refreshWorldSnapshot(msg.worldId);
        result = { kind: "restored", version };
      } else result = { kind: "inspection", inspection: await deps.inspectPromptRequest(store, msg.source, msg.requestId) };
      if (!deps.stillOpen(store)) throw Error("The world changed while the request was read. Reopen the tool.");
    } catch (error) {
      // Do not put prompt contents or filesystem exceptions into operational diagnostics.
      result = { kind: "failed", reason: error instanceof Error && !/ENOENT|EACCES|EPERM|UNKNOWN|Zod|\n/.test(error.message)
        ? error.message.slice(0, 1000) : "The prompt evidence could not be read safely. Read again or reopen the source." };
    }
    ctx.emit({ at: ctx.nowIso(), type: "prompt-tools.result", worldId: msg.worldId, requestId: msg.requestId, result });
  };
  return {
    "prompt-history-read": { scope: "any-world", handle: read },
    "prompt-history-restore": { scope: "any-world", handle: read },
    "prompt-request-inspect": { scope: "any-world", handle: read },
    "set-prompt-tools": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        const settings = await appSettings.setPromptTools(msg.enabled);
        ctx.emit({ at: ctx.nowIso(), type: "prompt-tools.changed", enabled: settings.promptTools === true });
      },
    },
  } satisfies CommandModule;
}
