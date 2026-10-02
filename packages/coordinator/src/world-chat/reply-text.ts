import type { ConversationId } from "@arke-studio/contracts";
import { foldConversation } from "./fold.js";
import { WorldChatStore, conversationDir } from "./store.js";

/**
 * The words of one of Arke's replies, read from its conversation's own log (design turn 183).
 *
 * Every chat in a world keeps the same journal under `.conversations/` — World Chat, the
 * founding conversation once it is handed to the world, a production's threads and its docks,
 * and production setup — so one reader serves them all, and the address is only ever the
 * conversation and the message: the screen's copy of a reply is never what is spoken.
 *
 * The whole log is folded rather than the window a screen opens on. The read used to load the
 * default window and refused a reply that had paged out of it, which was right only while
 * nothing on screen could reach an older page; a reply the author scrolled back to is still
 * that reply, and the id is what says which one. The fold is the same one the transcript is
 * drawn from, so a user's line, a queued input that never reached a run, a report card, or an id
 * that is not in this conversation at all is refused rather than read.
 */
export async function conversationReplyText(
  worldPath: string,
  conversationId: ConversationId,
  messageId: string,
): Promise<string> {
  const log = new WorldChatStore(conversationDir(worldPath, conversationId));
  const meta = await log.readMeta();
  if (!meta || meta.id !== conversationId) throw new Error("That conversation is not in this world.");
  const { events } = await log.read();
  const { view } = foldConversation(meta.id, meta.createdAt, events, { messageLimit: Number.MAX_SAFE_INTEGER });
  const message = view.messages.find((candidate) => candidate.id === messageId);
  if (!message) throw new Error("That reply is no longer in this conversation.");
  // A filed take's or a frame run's report is a card the studio wrote about work it did, not
  // something Arke said (design turn 183: never a receipt, refusal or card).
  if (message.role !== "studio" || view.benchOutcomes[messageId] !== undefined || view.frameRunOutcomes[messageId] !== undefined) {
    throw new Error("Only Arke's replies are read aloud.");
  }
  return message.text;
}
