import { z } from "zod";
import { ArtifactKindSchema } from "./artifact.js";
import { AskCandidateSchema, AskResultSchema } from "./ask.js";
import { BenchPresetSchema } from "./bench.js";
import { ChangeRecordSchema } from "./change.js";
import { ComfyUiStatusSchema } from "./comfyui.js";
import {
  IsoDateTimeSchema,
  JobIdSchema,
  ProposalIdSchema,
  ShotIdSchema,
  SlugSchema,
  SessionIdSchema,
  UlidSchema,
} from "./ids.js";
import { JobSchema, LedgerEntrySchema, QueueStatusSchema, ReconcileActionSchema } from "./job.js";
import { ProviderStatusSchema, ProviderToolStatusSchema } from "./provider.js";
import { ProviderCallRecordSchema } from "./provider-call.js";
import { ShotSelectionSchema } from "./scene.js";
import {
  LocalRuntimeStatusSchema,
  ThemePreferenceSchema,
  BackgroundNotificationPreferenceSchema,
  ManifestDriftSchema,
  ModelAvailabilitySchema,
  RoutingDefaultsSchema,
  RoutingFaultSchema,
  SpendStatusSchema,
} from "./settings.js";
import { SetupStatusSchema } from "./setup.js";
import { ReviewDecisionSchema, TakeSchema } from "./take.js";
import { RankedVoiceSchema, VoiceCandidateSchema, VoiceRuntimeStatusSchema } from "./voice.js";
import { NarratorSettingsSchema } from "./settings.js";
import { UpdateStateSchema } from "./update.js";

/**
 * The normalised domain-event union (SPEC-001 R-2, R-3). Everything the coordinator pushes to
 * clients after the snapshot is one of these, schema-validated at the boundary — a malformed
 * event fails loudly rather than propagating a partial object.
 */

export const HealthComponentSchema = z.enum(["coordinator", "harness", "voice"]);
export type HealthComponent = z.infer<typeof HealthComponentSchema>;

export const HealthStatusSchema = z.enum(["starting", "healthy", "unhealthy", "unavailable"]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

const base = { at: IsoDateTimeSchema };

export const QueueCommandSchema = z.enum([
  "dispatch-scene",
  "voice-preview",
  "voice-line",
  "read-sheet-section",
  "generate-world-image",
  "upload-world-image",
  "generate-master-look",
  "upload-master-look",
  "pick-staged-reference",
  "establish-look",
  "generate-main-photo",
  "generate-character-sheet",
  "generate-location-view",
  "generate-character-looks",
  "generate-missing-tiles",
  "regenerate-tile",
  "bench-dispatch",
  "bench-rerun",
  "bench-upload-references",
]);
export type QueueCommand = z.infer<typeof QueueCommandSchema>;

/**
 * The genesis draft as the world-author agent maintains it in the sandbox's draft.json.
 * Deliberately tolerant — every field optional, unknown keys stripped — because an agent's
 * enthusiasm should degrade to a smaller draft, never to a parse failure.
 */
export const GenesisDraftSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    logline: z.string().min(1).max(500).optional(),
    tone: z.string().min(1).max(120).optional(),
    genre: z.string().min(1).max(120).optional(),
    characters: z
      .array(z.object({ name: z.string().min(1).max(120), line: z.string().min(1).max(300) }).strip())
      .max(8)
      .default([]),
    locations: z
      .array(z.object({ name: z.string().min(1).max(120), line: z.string().min(1).max(300) }).strip())
      .max(8)
      .default([]),
    threads: z.array(z.string().min(1).max(300)).max(8).default([]),
  })
  .strip();
export type GenesisDraft = z.infer<typeof GenesisDraftSchema>;

export const DomainEventSchema = z.discriminatedUnion("type", [
  /** A world was opened into the coordinator; the follow-up snapshot carries its bundle. */
  z.object({ ...base, type: z.literal("world.opened"), worldId: UlidSchema }).strict(),
  z.object({ ...base, type: z.literal("world.closed"), worldId: UlidSchema }).strict(),
  z
    .object({
      ...base,
      type: z.literal("provider-calls.ready"),
      jobId: JobIdSchema.nullable(),
      calls: z.array(ProviderCallRecordSchema),
    })
    .strict(),

  /** Mirror of a changes.jsonl append — an accepted mutation to a world entity (§2.5). */
  z
    .object({ ...base, type: z.literal("entity.changed"), worldId: UlidSchema, change: ChangeRecordSchema })
    .strict(),

  /** The world canon revision advanced (accepting any canon change increments once, §2.4). */
  z
    .object({
      ...base,
      type: z.literal("canon.revision.advanced"),
      worldId: UlidSchema,
      revision: z.number().int(),
    })
    .strict(),
  /** Transient Settings test result. Audio is never written to the change log or diagnostics. */
  z
    .object({
      ...base,
      type: z.literal("voice.runtime-test"),
      requestId: UlidSchema,
      status: z.enum(["testing", "ready", "failed"]),
      detail: z.string(),
      audioBase64: z.string().nullable(),
    })
    .strict(),

  z
    .object({
      ...base,
      type: z.literal("proposal.staged"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("proposal.resolved"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
      outcome: z.enum(["accepted", "discarded"]),
    })
    .strict(),

  /** An accept did not land; the reason is stated and the client decides what to offer (SPEC-004). */
  z
    .object({
      ...base,
      type: z.literal("proposal.blocked"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
      reason: z.enum([
        "stale",
        "needs-reconfirm",
        "no-op",
        "pending-review",
        "unresolved-conflicts",
        "target-retired",
        /** Authored content broke a bound the gate enforces, e.g. an over-long role (SPEC-007 R-18). */
        "invalid",
        /**
         * #70 §11.4.1: an in-place edit left a journal record that cannot be read, so what the
         * proposal's files now say is unknown. Accepting is refused rather than guessed.
         */
        "draft-unresolved",
      ]),
      detail: z.string().optional(),
      /** On needs-reconfirm: the authoritative set and its signature to echo back (R-10). */
      authoritativeSignature: z.string().optional(),
    })
    .strict(),

  /** Full row on every transition — jobs are small and the client never patches by hand. */
  z.object({ ...base, type: z.literal("job.updated"), job: JobSchema }).strict(),
  /** A succeeded job's artifacts and coordinator follow-on are ready for use. */
  z.object({ ...base, type: z.literal("job.ready"), job: JobSchema }).strict(),
  /** The user dropped a finished job from Activity's history (SPEC-014 R-13). The id, not a row. */
  z.object({ ...base, type: z.literal("job.deleted"), jobId: JobIdSchema }).strict(),

  /** One correlated acknowledgement after all durable enqueue attempts for a user action. */
  z
    .object({
      ...base,
      type: z.literal("queue.enqueue-result"),
      requestId: UlidSchema,
      command: QueueCommandSchema,
      disposition: z.enum(["accepted", "partial", "rejected", "not-queued"]),
      requestedCount: z.number().int().min(0),
      acceptedJobIds: z.array(JobIdSchema),
      failures: z.array(z.object({ index: z.number().int().min(0), reason: z.string().min(1) }).strict()),
    })
    .strict(),

  /** Result of the deliberate main-photo acceptance action (SPEC-017 R-12, issue #71). */
  z
    .object({
      ...base,
      type: z.literal("main-photo.acceptance"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      /**
       * "cancelled" is the answer to a file dialog closed without a choice. It says nothing to
       * the user — there is nothing to say — but a client that marked the button busy on the
       * press has no other way to learn it may stop (PR review).
       */
      status: z.enum(["accepted", "failed", "cancelled"]),
      reason: z.string().optional(),
      candidateRetained: z.boolean(),
    })
    .strict(),

  /**
   * Result of bringing a character sheet in by hand (PR #241).
   *
   * A generated sheet reports through the queue and then through its review; an uploaded one
   * passes neither, so without this the only answer to "did my file take?" is whether the card
   * happens to change. The main photo learned that lesson as `main-photo.acceptance`.
   */
  z
    .object({
      ...base,
      type: z.literal("character-sheet.acceptance"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      /** As above: a closed dialog is reported so the button that opened it can stop waiting. */
      status: z.enum(["accepted", "failed", "cancelled"]),
      reason: z.string().optional(),
    })
    .strict(),

  /**
   * An uploaded location view landed, or did not (#243). A candidate, never an acceptance — the
   * take arrives unreviewed like a generated one, so the screen has one accept path and not two.
   * Reported all the same: a refused file and a dead button look identical without it.
   */
  z
    .object({
      ...base,
      type: z.literal("location-view.upload"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      status: z.enum(["landed", "failed", "cancelled"]),
      reason: z.string().optional(),
    })
    .strict(),

  /** A provider queue paused, resumed, or its held count moved (SPEC-009 R-8, R-11). */
  z.object({ ...base, type: z.literal("queue.status"), queue: QueueStatusSchema }).strict(),
  /** What start-up reconciliation resolved, reported once (SPEC-009 R-18). */
  z.object({ ...base, type: z.literal("queue.reconciled"), report: z.array(ReconcileActionSchema) }).strict(),

  /**
   * Every voice the world can read with (design 70), unranked. `usedBy` is stated so the picker
   * can say a character already uses a voice — data on the row, not a warning, and choosing it
   * still only reads.
   */
  z
    .object({
      ...base,
      type: z.literal("voice.catalogue"),
      worldId: UlidSchema.optional(),
      voices: z.array(
        VoiceCandidateSchema.extend({ usedBy: z.array(z.string()).default([]) }).strict(),
      ),
    })
    .strict(),
  /** Who reads the app's prose aloud changed; null is the shipped local voice. */
  z.object({ ...base, type: z.literal("narrator.changed"), voice: NarratorSettingsSchema }).strict(),
  /** Ranked voice candidates for a sheet, matched attributes shown (SPEC-011 R-7, R-8). */
  z
    .object({
      ...base,
      type: z.literal("voice.candidates"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      extracted: z.array(z.string()),
      ranked: z.array(RankedVoiceSchema),
      previewLine: z.object({ text: z.string(), source: z.enum(["own-line", "drafted", "stock"]) }).strict(),
      /** Stated before any preview that will incur a charge (R-10); null when no cloud model. */
      cloudPreviewMicroUsd: z.number().int().min(0).nullable(),
    })
    .strict(),
  /** Correlated synthesis result for candidate previews and authoritative sheet reads. */
  z
    .object({
      ...base,
      type: z.literal("voice.audio"),
      requestId: UlidSchema,
      worldId: UlidSchema,
      sheetId: SlugSchema,
      sheetVersion: z.number().int().min(1),
      purpose: z.enum(["candidate-preview", "sheet-section"]),
      sectionHeading: z.string().min(1).optional(),
      provider: z.enum(["kokoro", "elevenlabs"]),
      model: z.string().min(1),
      voiceId: z.string().min(1),
      status: z.enum(["confirmation-required", "ready", "failed"]),
      file: z.string().nullable(),
      cached: z.boolean(),
      characterCount: z.number().int().min(0),
      estimatedMicroUsd: z.number().int().min(0),
      confirmationToken: z.string().min(1).optional(),
      error: z.string().optional(),
    })
    .strict(),
  /** A preview is ready (or failed): the cached file replays without a provider call (R-10). */
  z
    .object({
      ...base,
      type: z.literal("voice.preview"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      provider: z.string().min(1),
      voiceId: z.string().min(1),
      file: z.string().nullable(),
      error: z.string().nullable(),
    })
    .strict(),
  /** Local transcription result — editable text, never auto-submitted (SPEC-011 R-17, R-18). */
  z
    .object({
      ...base,
      type: z.literal("dictation.result"),
      requestId: z.string().min(1),
      text: z.string().nullable(),
      error: z.string().nullable(),
    })
    .strict(),
  /** Import stage one's report: filed, excluded and why — a silent import is a partial one (SPEC-015 R-11). */
  z
    .object({
      ...base,
      type: z.literal("import.report"),
      worldId: UlidSchema,
      filed: z.array(z.object({ name: z.string(), kind: z.string() }).strict()),
      deduplicated: z.array(z.string()),
      excluded: z.array(z.object({ name: z.string(), reason: z.string() }).strict()),
      needsConsent: z.array(z.object({ name: z.string(), sizeBytes: z.number() }).strict()),
    })
    .strict(),
  /** A large file awaiting stated-size consent, or a filing refusal (SPEC-015 R-6). */
  z
    .object({
      ...base,
      type: z.literal("artifact.notice"),
      worldId: UlidSchema,
      sourcePath: z.string(),
      outcome: z.enum(["needs-consent", "refused"]),
      reason: z.string(),
      sizeBytes: z.number().nullable(),
    })
    .strict(),

  /**
   * A correlated filing request's answer (issue 305 §4): the ids of what landed, in the order
   * it was picked. A file that was refused or needs consent holds its position as null — the
   * refusal itself arrives as artifact.notice — so the caller can still line ids up with what
   * it asked for. Cancelling the host dialog answers with an empty list, not silence.
   */
  z
    .object({
      ...base,
      type: z.literal("artifact.filed-batch"),
      worldId: UlidSchema,
      requestId: UlidSchema,
      artifactIds: z.array(z.string().min(1).nullable()),
    })
    .strict(),

  /**
   * One file landed in the world by attaching it to a conversation. The chat shows a chip for
   * it; the snapshot carries the artifact itself. Carries no path — the name it was given in
   * the world is the only name the renderer needs.
   */
  z
    .object({
      ...base,
      type: z.literal("artifact.attached"),
      worldId: UlidSchema,
      artifactId: z.string().min(1),
      file: z.string().min(1),
      kind: ArtifactKindSchema,
      /** Filed already under this content: the same material, not a second copy. */
      deduplicated: z.boolean(),
    })
    .strict(),

  /**
   * A world left the library. Carries where it went by folder name rather than by path — enough
   * to find it beside the others, without handing the renderer a location on disk.
   */
  z
    .object({
      ...base,
      type: z.literal("world.archived"),
      worldId: UlidSchema,
      name: z.string().min(1),
      folder: z.string().min(1),
    })
    .strict(),
  /** Archiving refused, and why — a world with work still running is not tidied away. */
  z
    .object({
      ...base,
      type: z.literal("world.archive-refused"),
      worldId: UlidSchema,
      reason: z.string().min(1),
    })
    .strict(),

  /**
   * The sample world landed in the library (SPEC-016 R-6). Carries the slug because a second
   * install is `the-undersong-2`, and a screen that says otherwise would be naming a folder
   * that is not there.
   */
  z
    .object({
      ...base,
      type: z.literal("sample-world.installed"),
      worldId: UlidSchema,
      slug: SlugSchema,
      name: z.string().min(1),
    })
    .strict(),
  /** Installing refused, and why — a build without the sample world says so rather than stalling. */
  z
    .object({
      ...base,
      type: z.literal("sample-world.refused"),
      reason: z.string().min(1),
    })
    .strict(),

  /**
   * Reading a document for facts (SPEC-015 stage two), as the chat sees it. Extraction was
   * silent before: it ran, wrote a batch into the artifact and said nothing, so a screen could
   * only find out by noticing the snapshot had changed. These two events are what let the offer
   * under the composer say "reading…", "14 found", or "nothing this file evidences".
   */
  z
    .object({
      ...base,
      type: z.literal("extraction.started"),
      worldId: UlidSchema,
      artifactId: z.string().min(1),
      file: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("extraction.finished"),
      worldId: UlidSchema,
      artifactId: z.string().min(1),
      file: z.string().min(1),
      /**
       * Every ending is named. "nothing" and "no-text" are not failures and must not read as
       * one; "stopped" is the user's own doing; "unavailable" is the harness, not the file.
       */
      outcome: z.enum(["found", "nothing", "no-text", "stopped", "unavailable", "failed"]),
      /** Offered, after verification — never what the model claimed. */
      found: z.number().int().min(0),
      /** Quotes that did not appear in the document, dropped before anyone saw them (D3). */
      dropped: z.number().int().min(0),
      reason: z.string().optional(),
    })
    .strict(),

  /**
   * One file handed to a genesis conversation. Outcome rather than two event types: there is
   * no world yet, so there is no artifact to name and nothing to look up — a chip and, when it
   * would not go, the reason, is the whole of what the screen can say.
   */
  z
    .object({
      ...base,
      type: z.literal("genesis.attachment"),
      genesisId: z.string().min(1),
      name: z.string().min(1),
      kind: ArtifactKindSchema,
      outcome: z.enum(["waiting", "refused"]),
      reason: z.string().optional(),
    })
    .strict(),

  /**
   * A file World Chat would not take (#70 §13.2).
   *
   * Only the refusal travels. An attachment that lands is already in the conversation's own
   * event log and arrives on the next workspace load, so announcing it here as well would give
   * the screen two sources for one fact — and they would eventually disagree. A refusal has no
   * such home: nothing was written, so if this does not say it, nothing does.
   */
  z
    .object({
      ...base,
      type: z.literal("world-chat.attachment-refused"),
      conversationId: z.string().min(1),
      name: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),

  /**
   * A wrap-up the coordinator would not perform (#70 §11.3).
   *
   * Like a refused attachment, this has no durable home: a refused wrap-up writes nothing, closes
   * nothing and leaves the conversation exactly as it was, so the next workspace load carries no
   * trace of it. Without this the refusal reached only the log, and the screen — which had already
   * moved to the proposals it was promised — showed an empty list. That is the same thing a
   * broken button looks like.
   *
   * `reason` is the machine-readable why; `detail` is already the words to show.
   *
   * `requestId` names the attempt this answers. Events reach every connected client, and two
   * windows on one conversation would otherwise have the second one's refusal settle the first
   * one's wrap-up — freeing a screen whose proposals are still being written.
   */
  z
    .object({
      ...base,
      type: z.literal("world-chat.wrap-up-refused"),
      conversationId: z.string().min(1),
      requestId: z.string().min(1),
      reason: z.enum([
        "stale",
        "nothing-to-carry",
        "materialise",
        "too-many",
        "in-flight",
        "look-already-proposed",
        "leftovers",
        "unknown",
      ]),
      detail: z.string().min(1).max(300),
    })
    .strict(),

  /**
   * What the studio is doing, while it is doing it (#70 §15.3).
   *
   * A turn takes as long as a model takes, and until this existed the screen showed nothing at
   * all for the whole of it — which is exactly what having sent nothing looks like. Transient by
   * design: it has no durable home and needs none, because a finished turn is described by its
   * receipts and its reply, not by what it was doing halfway through.
   *
   * `label` is already the words to show. The raw tool summary never crosses this boundary: those
   * strings name entities, and R-18 reserves that for coordinator-computed receipts.
   */
  z
    .object({
      ...base,
      type: z.literal("world-chat.progress"),
      conversationId: z.string().min(1),
      label: z.string().min(1).max(120),
    })
    .strict(),

  /** Export lifecycle (SPEC-013 R-21): progress, and a terminal status with the output path. */
  z
    .object({
      ...base,
      type: z.literal("export.progress"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      exportId: z.string().min(1),
      status: z.enum(["running", "done", "cancelled", "failed"]),
      percent: z.number().min(0).max(100),
      output: z.string().nullable(),
      error: z.string().nullable(),
    })
    .strict(),

  /** First-run environment verification (SPEC-016 R-2, D4): checked once, reported plainly. */
  z
    .object({
      ...base,
      type: z.literal("env.check"),
      pathBudgetOk: z.boolean(),
      pathBudgetDetail: z.string().nullable(),
      diskFreeMb: z.number().int().nullable(),
      nativeIndexOk: z.boolean(),
      nativeIndexDetail: z.string().nullable(),
    })
    .strict(),
  /** Desktop-owned update lifecycle (SPEC-016 R-12, R-13). */
  z
    .object({
      ...base,
      type: z.literal("update.status"),
      update: UpdateStateSchema,
    })
    .strict(),
  /** A diagnostics bundle, already through the redaction boundary (SPEC-016 R-15, D9). */
  z.object({ ...base, type: z.literal("diagnostics.ready"), bundle: z.string() }).strict(),

  /** The sidecar's four degradation states, each with its copy (SPEC-011 §2.10). */
  z
    .object({
      ...base,
      type: z.literal("voice.sidecar"),
      state: z.enum(["not-started", "downloading", "unavailable", "ready"]),
      detail: z.string(),
      runtime: VoiceRuntimeStatusSchema.nullable().optional(),
    })
    .strict(),

  z
    .object({
      ...base,
      type: z.literal("take.recorded"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      take: TakeSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.recorded"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      review: ReviewDecisionSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("selection.changed"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      shotId: ShotIdSchema,
      selection: ShotSelectionSchema,
    })
    .strict(),

  z.object({ ...base, type: z.literal("ledger.appended"), entry: LedgerEntrySchema }).strict(),

  /** Provider configuration or validation changed — the full set, never a patch (SPEC-008 R-2, R-3). */
  z
    .object({ ...base, type: z.literal("provider.status"), providers: z.array(ProviderStatusSchema) })
    .strict(),
  /**
   * An external tool's presence or sign-in changed (issue #137). Separate from provider.status
   * because it changes on its own schedule — a token expiring, a login finishing minutes after
   * it started — and carries what to do about it rather than only whether it works.
   */
  z
    .object({ ...base, type: z.literal("provider.tool-status"), tools: z.array(ProviderToolStatusSchema) })
    .strict(),
  /** Routing defaults or their faults changed (SPEC-008 R-20, §2.7). */
  z
    .object({
      ...base,
      type: z.literal("routing.changed"),
      routing: RoutingDefaultsSchema,
      faults: z.array(RoutingFaultSchema),
    })
    .strict(),
  /**
   * Which models this studio offers changed. Faults ride along because switching one off can
   * strand a routing default, and the two are read together (SPEC-008 §2.7).
   */
  z
    .object({
      ...base,
      type: z.literal("models.changed"),
      models: ModelAvailabilitySchema,
      faults: z.array(RoutingFaultSchema),
    })
    .strict(),
  /** The enhancer's answer: the rewritten prompt, or null with why not (never silence). */
  z
    .object({
      ...base,
      type: z.literal("bench.brief-enhanced"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      prompt: z.string().nullable(),
      reason: z.string().optional(),
    })
    .strict(),
  /** Saved bench setups changed (issue 305 §3): the whole list rides, it is small. */
  z.object({ ...base, type: z.literal("presets.changed"), presets: z.array(BenchPresetSchema) }).strict(),
  /** Rolling spend re-evaluated on a ledger append or a settings change (SPEC-008 R-19, D10). */
  z.object({ ...base, type: z.literal("spend.status"), spend: SpendStatusSchema }).strict(),
  z
    .object({
      ...base,
      type: z.literal("background-notifications.changed"),
      preference: BackgroundNotificationPreferenceSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("appearance.changed"),
      preference: ThemePreferenceSchema,
    })
    .strict(),
  /** Local runtime detection completed (SPEC-008 R-22, D12). */
  z.object({ ...base, type: z.literal("runtime.status"), runtime: LocalRuntimeStatusSchema }).strict(),
  /** The ComfyUI engine and its recipes, whole each time (SPEC-021 §2.12). */
  z.object({ ...base, type: z.literal("comfyui.status"), comfyui: ComfyUiStatusSchema }).strict(),
  /** Estimate-versus-actual divergence crossed the drift threshold (SPEC-008 R-13, §2.11). */
  z.object({ ...base, type: z.literal("manifest.drift"), reports: z.array(ManifestDriftSchema) }).strict(),

  /** Agent progress in product language: canon checks, drafting steps (SPEC-005 R-15). */
  z
    .object({
      ...base,
      type: z.literal("authoring.progress"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
      line: z.string().min(1),
    })
    .strict(),
  /** Authoring session lifecycle over a proposal — endings always carry a reason (SPEC-005 R-13). */
  z
    .object({
      ...base,
      type: z.literal("authoring.status"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
      status: z.enum(["running", "completed", "cancelled", "timeout", "budget-exceeded", "failed"]),
      detail: z.string().optional(),
    })
    .strict(),
  /**
   * One turn of the conversation over a proposal: the user's instruction going in, the gate's
   * reply coming back. The proposal's session persists between turns, so chat surfaces are a
   * running conversation with the same agent, not a series of strangers.
   */
  z
    .object({
      ...base,
      type: z.literal("authoring.turn"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
      role: z.enum(["user", "gate"]),
      text: z.string().min(1),
    })
    .strict(),
  /** Local-runtime setup progress: one event per change, the whole picture each time. */
  z.object({ ...base, type: z.literal("setup.status"), setup: SetupStatusSchema }).strict(),
  /** Genesis conversation turns — before any world exists, in the sandbox (SPEC-005). */
  z
    .object({
      ...base,
      type: z.literal("genesis.turn"),
      genesisId: z.string().min(1),
      role: z.enum(["user", "gate"]),
      text: z.string().min(1),
    })
    .strict(),
  /** Genesis session lifecycle — endings always carry a reason. */
  z
    .object({
      ...base,
      type: z.literal("genesis.status"),
      genesisId: z.string().min(1),
      status: z.enum(["running", "completed", "cancelled", "timeout", "budget-exceeded", "failed"]),
      detail: z.string().optional(),
    })
    .strict(),
  /**
   * The genesis turn in flight, one verb at a time — the same working surface world chat has.
   * The label arrives already worded; the client never invents one.
   */
  z
    .object({
      ...base,
      type: z.literal("genesis.progress"),
      genesisId: z.string().min(1),
      label: z.string().min(1),
    })
    .strict(),
  /**
   * The world-so-far, as the agent maintains it in the sandbox's draft.json after each turn.
   * Everything here is proposed; nothing exists until "Begin in this world" walks it through
   * the ordinary creation gates.
   */
  z
    .object({
      ...base,
      type: z.literal("genesis.draft"),
      genesisId: z.string().min(1),
      draft: GenesisDraftSchema,
    })
    .strict(),

  /** A grounded answer, a refusal with receipts, or honest unavailability (SPEC-006). */
  z
    .object({
      ...base,
      type: z.literal("canon.answer"),
      worldId: UlidSchema,
      askId: z.string().min(1),
      result: AskResultSchema,
    })
    .strict(),
  /** List-search results over the same retrieval path (SPEC-006 R-18). */
  z
    .object({
      ...base,
      type: z.literal("canon.search"),
      worldId: UlidSchema,
      searchId: z.string().min(1),
      searched: z.number().int().min(0),
      floorCleared: z.boolean(),
      candidates: z.array(AskCandidateSchema),
    })
    .strict(),
  /** An entry's computed detail: cited-by and speculative ripples (SPEC-006 §2.5). */
  z
    .object({
      ...base,
      type: z.literal("canon.refs"),
      worldId: UlidSchema,
      entryId: z.string().min(1),
      citedBy: z
        .object({
          sheets: z.array(z.object({ id: z.string(), atVersion: z.number().nullable() }).strict()),
          entries: z.array(z.string()),
          productions: z.array(z.string()),
        })
        .strict(),
      ripples: z.array(
        z.object({ kind: z.string(), summary: z.string(), targets: z.array(z.string()) }).strict(),
      ),
    })
    .strict(),

  /** A sheet's computed detail: refs, versions cited, incoming links (SPEC-007 R-4, R-16). */
  z
    .object({
      ...base,
      type: z.literal("sheet.refs"),
      worldId: UlidSchema,
      sheetId: z.string().min(1),
      tiles: z.number().int().min(0),
      productions: z.array(z.string()),
      artifacts: z.array(z.string()),
      scenes: z.array(z.string()),
      takesByVersion: z.record(z.string(), z.number().int()),
      /** Sheets that link here — reverse lookup from the index, never a second stored edge. */
      incomingLinks: z.array(z.string()),
    })
    .strict(),

  /** A harness permission backstop prompt, in Studio's language (SPEC-005 R-16, R-17). */
  z
    .object({
      ...base,
      type: z.literal("permission.pending"),
      permissionId: z.string().min(1),
      /** What the agent is asking to do, already translated for the user. */
      description: z.string().min(1),
      actionClass: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("permission.settled"),
      permissionId: z.string().min(1),
      decision: z.enum(["once", "always", "reject"]),
      /** True when a remembered grant answered without prompting; recorded, revocable. */
      remembered: z.boolean(),
    })
    .strict(),

  /** Supervised-child and harness health — what powers degraded mode (SPEC-001 R-6). */
  z
    .object({
      ...base,
      type: z.literal("health.changed"),
      component: HealthComponentSchema,
      status: HealthStatusSchema,
      reason: z.string().optional(),
    })
    .strict(),
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
