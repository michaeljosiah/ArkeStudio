import { z } from "zod";
import { ConversationIdSchema, UlidSchema } from "./ids.js";

export const LIVE_VOICE_REPLIES_SCHEMA_VERSION = 126;

const session = z.string().uuid();
const pcm = z.string().min(4).max(11000).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0);
export const VoiceConversationCommandSchema = z.object({
  kind: z.literal("voice-conversation"),
  session,
  command: z.discriminatedUnion("action", [
    z.object({ action: z.literal("open"), worldId: UlidSchema, conversationId: ConversationIdSchema,
      silenceMs: z.number().int().min(400).max(2000), cloudConsent: z.literal(true) }).strict(),
    z.object({ action: z.literal("audio"), audioBase64: pcm }).strict(),
    z.object({ action: z.literal("interrupt") }).strict(),
    z.object({ action: z.literal("end") }).strict(),
  ]),
}).strict();
export type VoiceConversationCommand = z.infer<typeof VoiceConversationCommandSchema>;
export const VoiceConversationResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: z.enum(["starting", "listening", "thinking", "speaking", "ended", "failed"]),
    reason: z.string().max(300).optional() }).strict(),
  z.object({ type: z.literal("audio"), audioBase64: pcm }).strict(),
  z.object({ type: z.literal("interrupted") }).strict(),
  z.object({ type: z.literal("text"), role: z.enum(["user", "studio"]), text: z.string().max(8000), final: z.boolean() }).strict(),
]);
export type VoiceConversationResponse = z.infer<typeof VoiceConversationResponseSchema>;

/** Streamed words have no proposal authority. Refuse code/structured output before speech. */
export function speakableConversationText(text: string): boolean {
  if (text.length > 8000 || /[{}[\]`<>]/.test(text)) return false;
  return Array.from(text).every(character => {
    const code = character.charCodeAt(0); return code >= 32 || code === 9 || code === 10 || code === 13;
  });
}
