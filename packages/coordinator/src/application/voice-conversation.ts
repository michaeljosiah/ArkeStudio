import type { ConversationId } from "@arke-studio/contracts";
import { VoiceConversationHost, type LiveSpeechEndpoint } from "../voice/conversation.js";
import { WorldChatStore, conversationDir } from "../world-chat/store.js";
import type { WorldChatRunner } from "../world-chat/run.js";
import type { WorldStore } from "../world/store.js";
import type { VoiceBackgroundOwner } from "../voice/background.js";

function spokenLookup(result: string): string {
  const text = result.split("\nSources: ")[0]!.trim();
  if (text.length <= 480) return `Your background lookup is ready. ${text}`;
  const sentence = text.lastIndexOf(". ", 400);
  const summary = sentence >= 80 ? text.slice(0, sentence + 1) : text.slice(0, 400).replace(/\s+\S*$/, "") + "…";
  return `Your background lookup is ready. ${summary} The full result is written in the conversation.`;
}

/** Captures the selected world, conversation, model and local narrator once per session. */
export function createVoiceConversationHost(deps: {
  endpoint(signal: AbortSignal): Promise<LiveSpeechEndpoint | null>;
  store(): WorldStore | null;
  current(store: WorldStore, id: ConversationId): boolean;
  runner(store: WorldStore, id: ConversationId): Pick<WorldChatRunner, "prepareVoice" | "voice">;
  narrator(store: WorldStore): Promise<{ provider: string; voiceId: string }>;
  refresh(store: WorldStore, id: ConversationId): Promise<void>;
  background?: () => VoiceBackgroundOwner | null;
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
    const openedAt = new Date().toISOString();
    return { signal: store.closingSignal, current, voice: narrator.voiceId,
      notification: {
        next: async () => {
          if (!current()) return null;
          const row = (await deps.background?.()?.list(store.worldId, command.conversationId))?.find(operation =>
            operation.status === "completed" && !operation.speechAttempted && operation.updatedAt >= openedAt);
          return row?.result ? { id: row.id, text: spokenLookup(row.result) } : null;
        },
        claim: async id => {
          if (!current()) return null;
          const row = await deps.background?.()?.markSpeechAttempted(store.worldId, command.conversationId, id);
          return row?.result && current() ? spokenLookup(row.result) : null;
        },
      },
      run: async (text, stop, delta) => {
        if (!current()) throw new Error("The conversation changed.");
        await store.assertOwnership();
        return runner.voice(chat, command.conversationId, text, binding, stop, delta);
      },
      refresh: async () => { if (current()) await deps.refresh(store, command.conversationId); },
    };
  } });
}
