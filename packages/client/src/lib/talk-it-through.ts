import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { WorldChatContext } from "@arke-studio/contracts";
import { createWorldChat, subscribeWorldChatCreateResults, useStore } from "./store.js";
import { useGlobalChat } from "../components/global-chat-context.js";
import { chatSurfaceForPage } from "./global-chat.js";

/**
 * Starting a conversation about the thing you are already looking at (#70 phase 6).
 *
 * The World Chat screen is one way in, and it is the wrong one for most of these moments. Somebody
 * reading a refusal, or a character sheet that is not quite right, has the subject in front of
 * them; making them navigate away, start a conversation and then re-explain what they were looking
 * at is a toll on the exact moment the feature is for.
 *
 * So the conversation carries where it came from. `entryContext` is recorded on the conversation
 * itself rather than being passed through router state, because it has to survive a reload and be
 * readable when the conversation is opened again a week later.
 */
export function useTalkItThrough(worldId: string | undefined) {
  const { state, connection } = useStore();
  const navigate = useNavigate(), location = useLocation(), owner = useGlobalChat();
  const path = location.pathname + location.search;
  const [pending, setPending] = useState<{ requestId: string; worldId: string; path: string; conversationId?: string } | null>(null);
  const starting = pending !== null;

  useEffect(() => subscribeWorldChatCreateResults(result => {
    setPending(previous => previous?.requestId === result.requestId && previous.worldId === result.worldId
      ? result.conversationId ? { ...previous, conversationId: result.conversationId } : null : previous);
  }), []);
  useEffect(() => {
    if (!pending) return;
    if (pending.path !== path || pending.worldId !== worldId || connection !== "open") { setPending(null); return; }
    if (!pending.conversationId || state?.world?.meta.worldId !== worldId || !state.world.conversations.some(row => row.id === pending.conversationId)) return;
    const destination = `/w/${worldId}/chat/${pending.conversationId}`;
    const surface = chatSurfaceForPage(state, destination);
    if (surface) owner?.history(surface);
    setPending(null); void navigate(destination);
  }, [pending, path, worldId, connection, state?.world, owner, navigate]);

  /**
   * `title` is the opening line of the conversation, not a name somebody has to invent. A
   * refusal's question is already the best title it could have.
   */
  const talk = (title: string, entryContext: WorldChatContext) => {
    if (!worldId || starting) return;
    const requestId = crypto.randomUUID();
    setPending({ worldId, path, requestId });
    if (!createWorldChat(worldId, title, requestId, entryContext)) setPending(null);
  };

  return { talk, starting };
}
