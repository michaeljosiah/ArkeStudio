import { applyPlacePlanChange } from "../references/place-plan.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

/**
 * A place's camera positions (design turn 285, issue 2302). One command, one commit; a refusal
 * (no set to stand a camera in, a name already taken, a twenty-fifth position) throws, and the
 * router says it on the toaster every command failure reaches.
 */
export function placePlanCommands(ctx: Pick<CommandContext, "refreshWorldSnapshot">) {
  return {
    "place-plan": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          await applyPlacePlanChange(store, { sheetId: msg.sheetId, from: msg.from, change: msg.change });
        } finally {
          // Also after a refusal: the screen holds the change it asked for, and only the world as
          // it is puts it back.
          await ctx.refreshWorldSnapshot(msg.worldId);
        }
      },
    },
  } satisfies CommandModule;
}
