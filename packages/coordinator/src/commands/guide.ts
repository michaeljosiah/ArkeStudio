import { guideVoiceLines, setGuideEntry, setGuideTeasers } from "../productions/world-guide.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

/** The world's Guide (SPEC-059): what a reader may see of it, and its teasers. Open world only. */
export function guideCommands(ctx: CommandContext) {
  return {
    "set-guide-entry": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          await setGuideEntry(store, msg.change, "editor");
        } catch (err) {
          // The switch springs back with the snapshot below; this says why.
          ctx.emit({ at: ctx.nowIso(), type: "command.failed", command: msg.kind, requestId: null, reason: err instanceof Error ? err.message.slice(0, 300) : "The Guide could not be saved" });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "set-guide-teasers": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          await setGuideTeasers(store, msg.change, "editor");
        } catch (err) {
          // The row goes back to what is kept with the snapshot below; this says why.
          ctx.emit({ at: ctx.nowIso(), type: "command.failed", command: msg.kind, requestId: null, reason: err instanceof Error ? err.message.slice(0, 300) : "The teasers could not be saved" });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "list-guide-voice-lines": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          const lines = await guideVoiceLines(store, msg.character, store.closingSignal);
          ctx.emit({ at: ctx.nowIso(), type: "guide.voice-lines", requestId: msg.requestId, worldId: msg.worldId, character: msg.character, lines });
        } catch (err) {
          ctx.emit({ at: ctx.nowIso(), type: "guide.voice-lines", requestId: msg.requestId, worldId: msg.worldId, character: msg.character, lines: [], refused: err instanceof Error ? err.message.slice(0, 300) : "Lines could not be read" });
        }
      },
    },
  } satisfies CommandModule;
}
