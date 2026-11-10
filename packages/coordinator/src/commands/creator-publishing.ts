import type { AccountService } from "../account.js";
import { CreatorSignInRequired } from "../publishing/account.js";
import { PublishingRefusal } from "../publishing/api.js";
import type { CreatorPublishingPort } from "../publishing/service.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/**
 * Cloud publishing: a world's publications listed, a frozen edition prepared, submitted and
 * controlled. A world's publications are read whether or not it is open; preparing one says so
 * itself when it is not, in the publishing state the screen reads.
 */
export function creatorPublishingCommands(ctx: CommandContext, deps: {
  service: () => CreatorPublishingPort | undefined;
  account: AccountService;
}) {
  const publish = async (msg: CommandOf<"creator-publishing-list" | "creator-publishing-prepare" | "creator-publishing-submit" | "creator-publishing-control">) => {
    if (ctx.stopping()) return;
    const service = deps.service();
    let state;
    try {
      if (!service) state = { configured: false, scopeId: null, publications: [], refusal: "Cloud publishing is not configured on this device. Local export remains available." };
      else if (msg.kind === "creator-publishing-list") state = await service.list(msg.worldId);
      else if (msg.kind === "creator-publishing-prepare") {
        const store = ctx.openStore();
        if (!store || store.worldId !== msg.worldId) throw new PublishingRefusal("world-unavailable", "Open this world before preparing its frozen edition.");
        state = await service.prepare(store, msg.productionId, msg.exportId);
      } else if (msg.kind === "creator-publishing-submit") state = await service.submit(msg.worldId, msg.candidateId, msg.form, msg.replace);
      else state = await service.control(msg.worldId, msg.id, msg.action);
    } catch (error) {
      state = { configured: !!service, scopeId: deps.account.current().kind === "signed-in" ? (deps.account.current() as Extract<ReturnType<AccountService["current"]>, { kind: "signed-in" }>).creatorScope ?? null : null, publications: service ? (await service.list(msg.worldId).catch(() => ({ publications: [] }))).publications : [],
        refusal: error instanceof PublishingRefusal || error instanceof CreatorSignInRequired ? error.message : "This publishing request could not be confirmed. Refresh the saved receipt before continuing." };
    }
    const account = deps.account.current();
    if (!ctx.stopping() && state.scopeId === (account.kind === "signed-in" ? account.creatorScope ?? null : null)) ctx.emit({ at: new Date().toISOString(), type: "creator-publishing.changed", worldId: msg.worldId, requestId: msg.requestId, state });
  };
  return {
    "creator-publishing-list": { scope: "any-world", handle: publish },
    "creator-publishing-prepare": { scope: "any-world", handle: publish },
    "creator-publishing-submit": { scope: "any-world", handle: publish },
    "creator-publishing-control": { scope: "any-world", handle: publish },
  } satisfies CommandModule;
}
