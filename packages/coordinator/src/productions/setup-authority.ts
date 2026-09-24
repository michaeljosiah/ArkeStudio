import type { ClientMessage } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { WorldChatService } from "../world-chat/service.js";

/** Old conversation commands cannot bypass setup's revision, ownership or creation gates. */
export async function guardProductionSetupAuthority(world: WorldStore | undefined | null, message: ClientMessage): Promise<void> {
  if (!world || !message.kind.startsWith("world-chat-") || !("conversationId" in message) || !message.conversationId) return;
  const loaded = await world.ownedWrite(() => new WorldChatService(world.dir).load(message.conversationId!));
  if (!loaded?.productionSetup || loaded.productionSetup.status === "created") return;
  if ("worldId" in message && message.worldId !== world.worldId) throw new Error("This setup belongs to another world.");
  if (message.kind !== "world-chat-open" && message.kind !== "world-chat-cancel") {
    throw new Error("Continue this draft in Production setup. Its creation and changes are reviewed there.");
  }
}
