import { z } from "zod";
import { UlidSchema } from "./ids.js";
import { CapabilitySchema } from "./provider.js";
import { JobStatusSchema } from "./job.js";
import { FINDING_KIND_IDS, FindingSeveritySchema } from "./diagnostics.js";
import { RecoveryEvidenceStateSchema, RecoveryFactSchema, RecoveryIncidentPhaseSchema } from "./recovery-incidents.js";
import { StorageLimitationSchema, StorageProbeSourceSchema, StorageRootRoleSchema } from "./storage-health.js";
import { DEFAULT_NARRATOR, KOKORO_VOICE_MODEL } from "./voice.js";

export const STUDIO_ASSISTANT_LIMITS = Object.freeze({ storeBytes: 2 * 1024 ** 2, evidenceBytes: 32 * 1024,
  threads: 20, messages: 100, requestChars: 8000, replyChars: 16000, responseBytes: 192 * 1024, modelCalls: 3,
  dictationBytes: 6_000_000, dictationMs: 60_000, speechBytes: 6_000_000, speechChunkChars: 450, speechParts: 128,
  attachments: 4, attachmentBytes: 32 * 1024, requestBytes: 48 * 1024 });
/** Explicit user text, never a path, import, diagnostic fact or native tool grant. */
function studioTextCharacters(value: string, whitespace: boolean, limit: number): boolean {
  if (value.length > limit) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 127 || code < 32 && !(whitespace && (code === 9 || code === 10 || code === 13))) return false;
  }
  return true;
}
export const StudioTextAttachmentSchema = z.object({ id: z.string().uuid(),
  name: z.string().min(1).max(128).refine(value => !/[\\/]/.test(value) && studioTextCharacters(value, false, 128)),
  text: z.string().min(1).max(STUDIO_ASSISTANT_LIMITS.attachmentBytes).refine(value => studioTextCharacters(value, true, STUDIO_ASSISTANT_LIMITS.attachmentBytes)),
}).strict();
export type StudioTextAttachment = z.infer<typeof StudioTextAttachmentSchema>;
export const StudioTextAttachmentsSchema = z.array(StudioTextAttachmentSchema).max(STUDIO_ASSISTANT_LIMITS.attachments)
  .refine(value => value.length <= STUDIO_ASSISTANT_LIMITS.attachments && value.every(row => row.name.length <= 128 && row.text.length <= STUDIO_ASSISTANT_LIMITS.attachmentBytes) && new Set(value.map(row => row.id)).size === value.length &&
    new TextEncoder().encode(JSON.stringify(value)).length <= STUDIO_ASSISTANT_LIMITS.attachmentBytes,
  "Text documents exceed the request's count or byte limit.");
export function studioRequestFits(value: { text: string; attachments?: readonly StudioTextAttachment[] }): boolean {
  return value.text.length <= STUDIO_ASSISTANT_LIMITS.requestChars && (!value.attachments || value.attachments.length <= STUDIO_ASSISTANT_LIMITS.attachments && value.attachments.every(row => row.name.length <= 128 && row.text.length <= STUDIO_ASSISTANT_LIMITS.attachmentBytes)) &&
    new TextEncoder().encode(JSON.stringify({ text: value.text, ...(value.attachments?.length ? { attachments: value.attachments } : {}) })).length <= STUDIO_ASSISTANT_LIMITS.requestBytes;
}
export const StudioAssistantSendSchema = z.object({ action: z.literal("send"), threadId: UlidSchema,
  text: z.string().trim().min(1).max(STUDIO_ASSISTANT_LIMITS.requestChars), attachments: StudioTextAttachmentsSchema.optional(),
  model: z.string().min(1).max(512), diagnosticModel: z.string().min(1).max(512).optional() }).strict();
/** Studio has no world narrator or implicit cloud/fallback permission. */
export function studioLocalNarrator(stored: { provider: string; model?: string; voiceId: string; worldId?: string } | null | undefined): string | null {
  if (!stored) return DEFAULT_NARRATOR.voiceId;
  return stored.provider === "kokoro" && (!stored.model || stored.model === KOKORO_VOICE_MODEL) && stored.worldId === undefined && stored.voiceId.length > 0 && stored.voiceId.length <= 128 ? stored.voiceId : null;
}
export const StudioDictationContentTypeSchema = z.enum(["audio/webm", "audio/webm;codecs=opus", "audio/ogg", "audio/ogg;codecs=opus", "audio/mp4", "audio/wav"]);
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

/** Closed private failure vocabulary; never persist raw provider errors or rejected replies. */
export const StudioInterruptionReasonSchema = z.enum(["host-stopped", "cancelled", "model-failed", "response-invalid", "evidence-invalid", "delegation-limit"]);
export type StudioInterruptionReason = z.infer<typeof StudioInterruptionReasonSchema>;
export function studioInterruptionMessage(reason?: StudioInterruptionReason): string {
  switch (reason) {
    case "host-stopped": return "Arke closed before this request finished. Review the conversation before starting a new request.";
    case "cancelled": return "This request was stopped. You can continue with a new message after acknowledging it.";
    case "model-failed": return "The model could not complete this request. Check its availability in Settings, then start a new request when ready.";
    case "response-invalid": return "The model returned an answer Arke could not read. You can choose another available model for a new request.";
    case "evidence-invalid": return "The diagnostic answer could not be verified against the supplied facts. Open Diagnostics for the measured status.";
    case "delegation-limit": return "The model requested another diagnosis instead of answering. Open Diagnostics or start a new request.";
    default: return "Arke cannot confirm that this request finished. Review the conversation before starting a new request.";
  }
}

export const StudioAssistantMessageSchema = z.object({
  id: UlidSchema, role: z.enum(["user", "arke"]), text: z.string().max(STUDIO_ASSISTANT_LIMITS.replyChars), at: instant,
  attachments: StudioTextAttachmentsSchema.optional(),
  diagnostic: z.object({ evidence: StudioDiagnosticEvidenceSchema, answer: StudioDiagnosticAnswerSchema }).strict().optional(),
  handoff: z.object({ destination: z.enum(["world", "builder"]), draft: z.string().max(STUDIO_ASSISTANT_LIMITS.requestChars) }).strict().optional(),
  interrupted: z.object({ runId: UlidSchema, phase: z.enum(["main", "diagnostic", "answer"]), at: instant,
    reason: StudioInterruptionReasonSchema.optional(),
    model: z.string().min(1).max(512), destination: digest.nullable(), disclosure: digest.nullable() }).strict().optional(),
}).strict().refine(value => value.attachments === undefined || value.role === "user" && studioRequestFits(value), "Only bounded user requests may contain text documents.");
export const StudioAssistantThreadSchema = z.object({
  id: UlidSchema, createdAt: instant, updatedAt: instant, archived: z.boolean(),
  messages: z.array(StudioAssistantMessageSchema).max(STUDIO_ASSISTANT_LIMITS.messages),
  pending: z.object({ id: UlidSchema, phase: z.enum(["main", "diagnostic", "answer"]),
    reason: StudioInterruptionReasonSchema.optional(),
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
  system: z.string().max(32 * 1024).optional(), outputTokenLimit: z.number().int().min(1).max(4096).optional(),
}).strict();
export type StudioCloudShare = z.infer<typeof StudioCloudShareSchema>;
/** Private host response only. Never add Studio transcript/share payloads to the common
 * app snapshot, world event log, operational export or model diagnostic context. */
export const StudioAssistantSnapshotSchema = z.object({
  audit, accepting: z.boolean(), busy: z.boolean(), threads: z.array(StudioAssistantThreadSchema).max(STUDIO_ASSISTANT_LIMITS.threads),
  share: StudioCloudShareSchema.nullable(), ephemeralReply: StudioAssistantMessageSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  // A bounded conversation plus one disclosure/unsaved response, never the unbounded
  // cross-product of every individual thread/message field limit.
  if (new TextEncoder().encode(JSON.stringify(value)).length > STUDIO_ASSISTANT_LIMITS.storeBytes + 512 * 1024) ctx.addIssue({ code: "custom", message: "Private Studio state exceeds its byte bound." });
});
export type StudioAssistantSnapshot = z.infer<typeof StudioAssistantSnapshotSchema>;

/** Owner-only commands. No pathname, world binding, repair execution or standing consent. */
export const StudioAssistantCommandSchema = z.object({ kind: z.literal("studio-assistant"), requestId: z.string().uuid(),
  command: z.discriminatedUnion("action", [
    z.object({ action: z.literal("watch") }).strict(), z.object({ action: z.literal("unwatch") }).strict(),
    z.object({ action: z.literal("create") }).strict(),
    z.object({ action: z.literal("read-reply"), threadId: UlidSchema, messageId: UlidSchema,
      part: z.number().int().min(0).max(STUDIO_ASSISTANT_LIMITS.speechParts - 1), source: digest.optional(), voiceId: z.string().min(1).max(128).optional() }).strict(),
    z.object({ action: z.literal("stop-reply-read"), readRequestId: z.string().uuid() }).strict(),
    z.object({ action: z.literal("dictate"), audioBase64: z.string().min(4).max(8_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0), contentType: StudioDictationContentTypeSchema }).strict(),
    z.object({ action: z.literal("archive"), threadId: UlidSchema, archived: z.boolean() }).strict(),
    StudioAssistantSendSchema,
    z.object({ action: z.literal("cancel"), threadId: UlidSchema, runId: UlidSchema }).strict(),
    z.object({ action: z.literal("acknowledge"), threadId: UlidSchema, runId: UlidSchema }).strict(),
    z.object({ action: z.literal("approve-cloud"), threadId: UlidSchema, runId: UlidSchema, shareId: UlidSchema, digest }).strict(),
  ]).refine(value => value.action !== "send" || studioRequestFits(value), "The request and documents exceed their byte limit."),
}).strict();
export type StudioAssistantCommand = z.infer<typeof StudioAssistantCommandSchema>;
export const StudioAssistantResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: StudioAssistantSnapshotSchema }).strict(),
  z.object({ type: z.literal("dictation"), text: z.string().max(STUDIO_ASSISTANT_LIMITS.requestChars) }).strict(),
  z.object({ type: z.literal("speech"), part: z.number().int().min(0).max(STUDIO_ASSISTANT_LIMITS.speechParts - 1),
    parts: z.number().int().min(1).max(STUDIO_ASSISTANT_LIMITS.speechParts), source: digest,
    voiceId: z.string().min(1).max(128), format: z.literal("wav"),
    audioBase64: z.string().min(4).max(8_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0),
  }).strict(),
  z.object({ type: z.literal("result"), status: z.enum(["ok", "accepted", "refused", "unconfirmed"]),
    reason: z.enum(["invalid", "missing-thread", "busy", "interrupted", "unavailable", "full", "stopped", "timeout"]).nullable(),
    threadId: UlidSchema.nullable(), runId: UlidSchema.nullable() }).strict(),
]).refine(value => value.type !== "speech" || value.part < value.parts);
export type StudioAssistantResponse = z.infer<typeof StudioAssistantResponseSchema>;
