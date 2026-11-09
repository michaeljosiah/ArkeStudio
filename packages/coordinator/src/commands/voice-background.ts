import type { ConversationId } from "@arke-studio/contracts";
import type { VoiceBackgroundOwner } from "../voice/background.js";
import type { WorldStore } from "../world/store.js";
import type { CommandModule } from "./router.js";

export function voiceBackgroundCommands(deps: {
  owner(): VoiceBackgroundOwner | null;
  refresh(store: WorldStore, id: ConversationId): Promise<void>;
}) {
  return { "cancel-voice-background": { scope: "open-world", async handle(message, store) {
    const owner = deps.owner(); if (!owner) throw new Error("Background lookup controls are unavailable.");
    await owner.cancel(store.worldId, message.conversationId, message.operationId);
    await deps.refresh(store, message.conversationId);
  } } } satisfies CommandModule;
}
