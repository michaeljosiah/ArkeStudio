import type { ConversationId } from "@arke-studio/contracts";
import { VoiceConversationHost, type LiveSpeechEndpoint } from "../voice/conversation.js";
import { WorldChatStore, conversationDir } from "../world-chat/store.js";
import type { WorldChatRunner } from "../world-chat/run.js";
import type { WorldStore } from "../world/store.js";

/** Captures the selected world, conversation, model and local narrator once per session. */
export function createVoiceConversationHost(deps: {
  endpoint(signal: AbortSignal): Promise<LiveSpeechEndpoint | null>;
  store(): WorldStore | null;
  current(store: WorldStore, id: ConversationId): boolean;
  runner(store: WorldStore, id: ConversationId): Pick<WorldChatRunner, "prepareVoice" | "voice">;
  narrator(store: WorldStore): Promise<{ provider: string; voiceId: string }>;
  refresh(store: WorldStore, id: ConversationId): Promise<void>;
}): VoiceConversationHost {
  return new VoiceConversationHost({ endpoint: deps.endpoint, scope: async (command, signal) => {
    const store = deps.store();
    const current = () => !!store && deps.current(store, command.conversationId);
    if (!store || store.worldId !== command.worldId || !current()) throw new Error("The conversation changed.");
    await store.assertOwnership(); signal.throwIfAborted();
    const chat = new WorldChatStore(conversationDir(store.dir, command.conversationId));
    const runner = deps.runner(store, command.conversationId);
    const binding = await runner.prepareVoice(chat, command.conversationId, signal);
    const narrator = await deps.narrator(store);
    if (narrator.provider !== "kokoro" || !current()) throw new Error("Choose a local Kokoro narrator before starting voice conversation.");
    return { signal: store.closingSignal, current, voice: narrator.voiceId,
      run: async (text, stop, delta) => {
        if (!current()) throw new Error("The conversation changed.");
        await store.assertOwnership();
        return runner.voice(chat, command.conversationId, text, binding, stop, delta);
      },
      refresh: async () => { if (current()) await deps.refresh(store, command.conversationId); },
    };
  } });
}
