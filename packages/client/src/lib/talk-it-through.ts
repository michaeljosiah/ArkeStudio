import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { WorldChatContext } from "@arke-studio/contracts";
import { createWorldChat, useStore } from "./store.js";

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
  const { state } = useStore();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);

  const opened = state?.worldChat?.conversationId ?? null;
  useEffect(() => {
    if (!starting || !opened || !worldId) return;
    setStarting(false);
    navigate(`/w/${worldId}/chat/${opened}`);
  }, [starting, opened, worldId, navigate]);

  /**
   * `title` is the opening line of the conversation, not a name somebody has to invent. A
   * refusal's question is already the best title it could have.
   */
  const talk = (title: string, entryContext: WorldChatContext) => {
    if (!worldId || starting) return;
    setStarting(true);
    createWorldChat(worldId, title, crypto.randomUUID(), entryContext);
  };

  return { talk, starting };
}
