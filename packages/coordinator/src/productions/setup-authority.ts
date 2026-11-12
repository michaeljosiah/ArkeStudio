import type { ClientMessage } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { WorldChatService } from "../world-chat/service.js";

/** Old conversation commands cannot bypass setup's revision, ownership or creation gates. */
export async function guardProductionSetupAuthority(world: WorldStore | undefined | null, message: ClientMessage): Promise<void> {
  if (!world || !message.kind.startsWith("world-chat-") || !("conversationId" in message) || !message.conversationId) return;
  // Only a conversation created as production setup can hold a setup, and that never changes,
  // so its row answers for every other thread. Loading and folding each one under a full world
  // rescan put seconds in front of every chat command on a large world (issue 2780). A thread
  // not yet among the rows is loaded, as before.
  const row = world.getBundle().conversations.find(conversation => conversation.id === message.conversationId);
  if (row && row.entryContext?.kind !== "production-setup") return;
  const loaded = await world.operationalWrite(() => new WorldChatService(world.dir).load(message.conversationId!));
  if (!loaded?.productionSetup || loaded.productionSetup.status === "created") return;
  if ("worldId" in message && message.worldId !== world.worldId) throw new Error("This setup belongs to another world.");
  if (message.kind !== "world-chat-open" && message.kind !== "world-chat-cancel") {
    throw new Error("Continue this draft in Production setup. Its creation and changes are reviewed there.");
  }
}
