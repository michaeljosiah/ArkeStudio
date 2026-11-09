import { z } from "zod";
import { ConversationIdSchema, IsoDateTimeSchema, RunIdSchema, TurnIdSchema } from "./ids.js";

export const VOICE_BACKGROUND_SCHEMA_VERSION = 123;
export const VoiceBackgroundOperationSchema = z.object({
  id: z.string().regex(/^vop_[0-9A-HJKMNP-TV-Z]{26}$/),
  worldId: z.string().min(1).max(200), conversationId: ConversationIdSchema,
  initiatingRunId: RunIdSchema, turnId: TurnIdSchema,
  request: z.string().trim().min(1).max(1500),
  status: z.enum(["requested", "running", "cancel-requested", "completed", "failed", "cancelled", "unknown"]),
  createdAt: IsoDateTimeSchema, updatedAt: IsoDateTimeSchema,
  result: z.string().min(1).max(4000).optional(),
  speechAttempted: z.boolean().optional(),
}).strict();
export type VoiceBackgroundOperation = z.infer<typeof VoiceBackgroundOperationSchema>;

export const voiceBackgroundTerminal = (operation: VoiceBackgroundOperation): boolean =>
  ["completed", "failed", "cancelled", "unknown"].includes(operation.status);

/** Immutable intent, monotonic outcomes; a terminal result cannot be replaced by a late worker. */
export function voiceBackgroundTransition(previous: VoiceBackgroundOperation | undefined, next: VoiceBackgroundOperation): boolean {
  if (!previous) return next.status === "requested" && !next.result && !next.speechAttempted;
  if (["id", "worldId", "conversationId", "initiatingRunId", "turnId", "request", "createdAt"].some(key =>
    previous[key as keyof VoiceBackgroundOperation] !== next[key as keyof VoiceBackgroundOperation]) || next.updatedAt < previous.updatedAt) return false;
  if (voiceBackgroundTerminal(previous)) return previous.status === "completed" && next.status === "completed"
    && !previous.speechAttempted && next.speechAttempted === true && previous.result === next.result;
  const allowed: Record<string, string[]> = {
    requested: ["running", "cancel-requested", "failed", "unknown"],
    running: ["cancel-requested", "completed", "failed", "cancelled", "unknown"],
    "cancel-requested": ["cancelled", "failed", "unknown"],
  };
  return allowed[previous.status]?.includes(next.status) === true && !next.speechAttempted
    && (next.status === "completed" ? !!next.result : !next.result);
}
