import { z } from "zod";
import { PerformanceIdSchema } from "./performance.js";
import { SessionIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";

/*
 * The identities and bounds every agent media read shares. They live apart from the observation
 * schema so the measurements (agent-measure.ts), which name a second source, can use them without
 * an import cycle through agent-media.ts.
 */
export const AGENT_MEDIA_LIMITS = Object.freeze({ frames: 8, intervalSeconds: 60, edge: 1024,
  streams: 16, channels: 8, sampleRate: 192000, pcmBytes: 64 * 1024 * 1024, calls: 16 });
export const AgentMediaSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("performance"), productionId: SlugSchema, performanceId: PerformanceIdSchema }).strict(),
  z.object({ kind: z.literal("production-take"), productionId: SlugSchema, takeId: TakeIdSchema }).strict(),
  z.object({ kind: z.literal("bench-take"), sessionId: SessionIdSchema, takeId: TakeIdSchema }).strict(),
  z.object({ kind: z.literal("artifact"), id: z.string().min(1).max(200) }).strict(),
  // The completed-export receipt's own id pattern: an id, never a path.
  z.object({ kind: z.literal("export"), exportId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict(),
]);
export type AgentMediaSource = z.infer<typeof AgentMediaSourceSchema>;
export const agentMediaTime = z.number().finite().min(0);
export const AgentMediaRangeSchema = z.object({ startSec: agentMediaTime, endSec: agentMediaTime }).strict().superRefine((range, context) => {
  if (range.endSec <= range.startSec || range.endSec - range.startSec > AGENT_MEDIA_LIMITS.intervalSeconds) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Inspection needs a positive interval of at most 60 seconds" });
  }
});
export const AgentMediaStreamIndexSchema = z.number().int().min(0).max(255);
