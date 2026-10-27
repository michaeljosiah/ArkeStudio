import { z } from "zod";
import { UlidSchema } from "./ids.js";
import { CapabilitySchema } from "./provider.js";
import { JobStatusSchema } from "./job.js";
import { FINDING_KIND_IDS, FindingSeveritySchema } from "./diagnostics.js";
import { RecoveryEvidenceStateSchema, RecoveryFactSchema, RecoveryIncidentPhaseSchema } from "./recovery-incidents.js";
import { StorageLimitationSchema, StorageProbeSourceSchema, StorageRootRoleSchema } from "./storage-health.js";

export const STUDIO_ASSISTANT_LIMITS = Object.freeze({ storeBytes: 2 * 1024 ** 2, evidenceBytes: 32 * 1024,
  threads: 20, messages: 100, requestChars: 8000, replyChars: 16000, responseBytes: 192 * 1024, modelCalls: 3 });
const instant = z.number().int().nonnegative().safe().max(8_640_000_000_000_000), digest = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().nonnegative().safe(), audit = z.enum(["starting", "available", "unavailable"]);
export const StudioDiagnosticTopicSchema = z.enum(["storage", "local-ai", "setup", "jobs"]);
export type StudioDiagnosticTopic = z.infer<typeof StudioDiagnosticTopicSchema>;

/** Closed, bounded operational context. No free-text diagnostic cause, path, model name,
 * provider job identity, world entity, transcript, prompt, credential or raw log field. */
export const StudioDiagnosticEvidenceSchema = z.object({
  version: z.literal(1), at: instant, topic: StudioDiagnosticTopicSchema,
  audit: z.object({ history: audit, recovery: audit, storage: z.enum(["starting", "available", "unavailable", "reconciling"]) }).strict(),
  incidents: z.array(z.object({ id: digest, kind: z.enum(FINDING_KIND_IDS), revision: digest,
    phase: RecoveryIncidentPhaseSchema, severity: FindingSeveritySchema, evidence: RecoveryEvidenceStateSchema,
    observedAt: instant, facts: z.array(RecoveryFactSchema).max(12), factsLimited: z.boolean() }).strict()).max(16),
  storage: z.array(z.object({ id: digest, role: StorageRootRoleSchema,
    state: z.enum(["unmeasured", "measured", "stale", "unavailable", "unsupported"]), source: StorageProbeSourceSchema,
    limitations: z.array(StorageLimitationSchema).max(5),
    capacity: z.object({ volumeId: digest, mappingRevision: digest, measuredAt: instant, availableBytes: bytes.nullable(), totalBytes: bytes.nullable() }).strict().nullable(),
  }).strict()).max(16),
  jobs: z.array(z.object({ ref: digest, capability: CapabilitySchema, status: JobStatusSchema, attempt: bytes,
    accepted: z.boolean(), updatedAt: instant.nullable() }).strict()).max(16),
  limited: z.object({ incidents: z.boolean(), storage: z.boolean(), jobs: z.boolean() }).strict(),
}).strict().superRefine((value, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(value)).length > STUDIO_ASSISTANT_LIMITS.evidenceBytes) ctx.addIssue({ code: "custom", message: "Operational evidence exceeds its byte bound." });
});
export type StudioDiagnosticEvidence = z.infer<typeof StudioDiagnosticEvidenceSchema>;

/** The application handles these requests itself. They are not native harness tools and
 * cannot execute a repair, pass a path or carry a transcript to the specialist. */
export const StudioAssistantDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reply"), text: z.string().min(1).max(STUDIO_ASSISTANT_LIMITS.replyChars) }).strict(),
  z.object({ kind: z.literal("diagnose"), topic: StudioDiagnosticTopicSchema }).strict(),
  z.object({ kind: z.literal("handoff"), destination: z.enum(["world", "builder"]), draft: z.string().min(1).max(STUDIO_ASSISTANT_LIMITS.requestChars) }).strict(),
]);
export type StudioAssistantDecision = z.infer<typeof StudioAssistantDecisionSchema>;
export const StudioDiagnosticAnswerSchema = z.object({
  explanation: z.string().min(1).max(STUDIO_ASSISTANT_LIMITS.replyChars),
  evidenceRefs: z.array(digest).max(32), hypotheses: z.array(z.string().min(1).max(1000)).max(8),
}).strict();
export type StudioDiagnosticAnswer = z.infer<typeof StudioDiagnosticAnswerSchema>;

export const StudioAssistantMessageSchema = z.object({
  id: UlidSchema, role: z.enum(["user", "arke"]), text: z.string().max(STUDIO_ASSISTANT_LIMITS.replyChars), at: instant,
  diagnostic: z.object({ evidence: StudioDiagnosticEvidenceSchema, answer: StudioDiagnosticAnswerSchema }).strict().optional(),
  handoff: z.object({ destination: z.enum(["world", "builder"]), draft: z.string().max(STUDIO_ASSISTANT_LIMITS.requestChars) }).strict().optional(),
  interrupted: z.object({ runId: UlidSchema, phase: z.enum(["main", "diagnostic", "answer"]), at: instant,
    model: z.string().min(1).max(512), destination: digest.nullable(), disclosure: digest.nullable() }).strict().optional(),
}).strict();
export const StudioAssistantThreadSchema = z.object({
  id: UlidSchema, createdAt: instant, updatedAt: instant, archived: z.boolean(),
  messages: z.array(StudioAssistantMessageSchema).max(STUDIO_ASSISTANT_LIMITS.messages),
  pending: z.object({ id: UlidSchema, phase: z.enum(["main", "diagnostic", "answer"]),
    state: z.enum(["preparing", "intended", "interrupted"]), startedAt: instant,
    model: z.string().min(1).max(512), destination: digest.nullable(), disclosure: digest.nullable(),
  }).strict().nullable(),
}).strict();
export type StudioAssistantThread = z.infer<typeof StudioAssistantThreadSchema>;
export const StudioAssistantFileSchema = z.object({ version: z.literal(1), threads: z.array(StudioAssistantThreadSchema).max(STUDIO_ASSISTANT_LIMITS.threads) }).strict()
  .superRefine((value, ctx) => {
    if (new Set(value.threads.map(thread => thread.id)).size !== value.threads.length) ctx.addIssue({ code: "custom", message: "Repeated Studio thread." });
    if (value.threads.filter(thread => thread.pending && thread.pending.state !== "interrupted").length > 1) ctx.addIssue({ code: "custom", message: "More than one Studio turn is active." });
    for (const thread of value.threads) {
      if (new Set(thread.messages.map(message => message.id)).size !== thread.messages.length) ctx.addIssue({ code: "custom", message: "Repeated Studio message." });
      if (thread.pending?.state === "intended" && (!thread.pending.destination || !thread.pending.disclosure)) ctx.addIssue({ code: "custom", message: "A Studio dispatch needs its exact destination and disclosure." });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > STUDIO_ASSISTANT_LIMITS.storeBytes) ctx.addIssue({ code: "custom", message: "Studio conversation history is full." });
  });
export type StudioAssistantFile = z.infer<typeof StudioAssistantFileSchema>;
export const StudioCloudShareSchema = z.object({ id: UlidSchema, runId: UlidSchema, threadId: UlidSchema, digest,
  role: z.enum(["studio-assistant", "diagnostic-specialist"]), phase: z.enum(["main", "diagnostic", "answer"]),
  model: z.string().min(1).max(512), provider: z.string().min(1).max(128), destination: digest,
  prompt: z.string().max(192 * 1024), customBrief: z.string().max(16_000).optional(), variant: z.string().max(512).optional(),
}).strict();
export type StudioCloudShare = z.infer<typeof StudioCloudShareSchema>;
/** Private host response only. Never add Studio transcript/share payloads to the common
 * app snapshot, world event log, operational export or model diagnostic context. */
export const StudioAssistantSnapshotSchema = z.object({
  audit, accepting: z.boolean(), busy: z.boolean(), threads: z.array(StudioAssistantThreadSchema).max(STUDIO_ASSISTANT_LIMITS.threads),
  share: StudioCloudShareSchema.nullable(), ephemeralReply: StudioAssistantMessageSchema.nullable(),
}).strict();
export type StudioAssistantSnapshot = z.infer<typeof StudioAssistantSnapshotSchema>;
