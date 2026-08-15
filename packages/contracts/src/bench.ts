import { z } from "zod";
import {
  ArtifactIdSchema,
  IsoDateTimeSchema,
  JobIdSchema,
  SessionIdSchema,
  Sha256Schema,
  TakeIdSchema,
} from "./ids.js";
import { JobStatusSchema } from "./job.js";
import { SizeTierSchema } from "./manifest.js";
import { MediaInfoSchema } from "./media.js";
import { ReferenceKindSchema, type ReferenceKind } from "./reference-budget.js";
import { TakeCostSchema } from "./take.js";

/**
 * The bench (issue 305; design turns 68–69): one picture or one shot made with no production
 * waiting on it, reached from the world's Artifacts screen and filing back into it.
 *
 * A bench session is durable and event-sourced — `.sessions/<sessionId>/events.jsonl` under the
 * world, mirroring World Chat's append rules — because pressing Generate here authorizes paid
 * provider calls, and the record that authorized a charge cannot be a mutable file that a crash
 * half-wrote. Everything below is the *folded* view of that log plus the events themselves.
 */

export const BenchModeSchema = z.enum(["image", "video"]);
export type BenchMode = z.infer<typeof BenchModeSchema>;

// ---------------------------------------------------------------------------
// Composer parameters — one shape per mode, discriminated so a video duration
// can never ride an image request unnoticed.
// ---------------------------------------------------------------------------

export const BenchImageParamsSchema = z
  .object({
    kind: z.literal("image"),
    /** The shape, in the chosen model's own vocabulary ("16:9"). Absent = provider default. */
    aspect: z.string().min(1).optional(),
    tier: SizeTierSchema.optional(),
    /** How many takes one press asks for. Each is its own numbered take and its own job. */
    count: z.number().int().min(1).max(4),
  })
  .strict();
export type BenchImageParams = z.infer<typeof BenchImageParamsSchema>;

export const BenchVideoParamsSchema = z
  .object({
    kind: z.literal("video"),
    aspect: z.string().min(1).optional(),
    /** Video keeps its own words — "720p", never a normalised tier (manifest.ts). */
    resolution: z.string().min(1).optional(),
    durationSec: z.number().int().min(1).optional(),
    /** Present only where the model declares the control; absent is "the control does not exist". */
    sound: z.boolean().optional(),
  })
  .strict();
export type BenchVideoParams = z.infer<typeof BenchVideoParamsSchema>;

export const BenchParamsSchema = z.discriminatedUnion("kind", [BenchImageParamsSchema, BenchVideoParamsSchema]);
export type BenchParams = z.infer<typeof BenchParamsSchema>;

// ---------------------------------------------------------------------------
// References — a token is the name the brief cites; the source is what it names.
// ---------------------------------------------------------------------------

/**
 * Where a reference's bytes come from. The hash is recorded at attach time so provenance can
 * say exactly which bytes rode along even after the artifact is superseded or the take's file
 * is later filed under another name.
 */
export const BenchReferenceSourceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("artifact"), artifactId: ArtifactIdSchema, hash: Sha256Schema }).strict(),
  z.object({ source: z.literal("take"), takeId: TakeIdSchema, hash: Sha256Schema }).strict(),
]);
export type BenchReferenceSource = z.infer<typeof BenchReferenceSourceSchema>;

/** "Image 3" — the kind capitalised, then the 1-based number. The display form IS the identity. */
export const BENCH_TOKEN = /^(Image|Video|Audio) ([1-9][0-9]*)$/;

const TOKEN_PREFIX: Record<ReferenceKind, string> = { image: "Image", video: "Video", audio: "Audio" };

export function benchTokenFor(kind: ReferenceKind, n: number): string {
  return `${TOKEN_PREFIX[kind]} ${n}`;
}

/** The parsed identity of a token, or null for a string that is not one. */
export function parseBenchToken(token: string): { kind: ReferenceKind; n: number } | null {
  const m = BENCH_TOKEN.exec(token);
  if (!m) return null;
  const kind = (Object.entries(TOKEN_PREFIX).find(([, p]) => p === m[1])?.[0] ?? null) as ReferenceKind | null;
  return kind === null ? null : { kind, n: Number(m[2]) };
}

export const BenchReferenceTokenSchema = z
  .object({
    /** Display form, e.g. "Image 3" — stable for the session's life, never renumbered. */
    token: z.string().regex(BENCH_TOKEN),
    kind: ReferenceKindSchema,
    source: BenchReferenceSourceSchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    const parsed = parseBenchToken(entry.token);
    if (parsed !== null && parsed.kind !== entry.kind) {
      ctx.addIssue({ code: "custom", message: `token "${entry.token}" does not spell its kind "${entry.kind}"` });
    }
  });
export type BenchReferenceToken = z.infer<typeof BenchReferenceTokenSchema>;

/** One stable identity per source, so the same artifact can never ride under two names. */
export function benchSourceKey(source: BenchReferenceSource): string {
  return source.source === "artifact" ? `artifact:${source.artifactId}` : `take:${source.takeId}`;
}

// ---------------------------------------------------------------------------
// The request snapshot — immutable once a take is reserved. Selection and
// re-run read THIS, never the live composer, which is what makes an older
// take restorable after the composer has moved on.
// ---------------------------------------------------------------------------

export const BenchRequestSnapshotSchema = z
  .object({
    mode: BenchModeSchema,
    brief: z.string(),
    references: z.array(BenchReferenceTokenSchema),
    provider: z.string().min(1),
    model: z.string().min(1),
    params: BenchParamsSchema,
    /** Recorded only when one was asked for; providers do not universally return one. */
    requestedSeed: z.number().int().optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.params.kind !== request.mode) {
      ctx.addIssue({ code: "custom", message: `params are for "${request.params.kind}" but the mode is "${request.mode}"` });
    }
  });
export type BenchRequestSnapshot = z.infer<typeof BenchRequestSnapshotSchema>;

// ---------------------------------------------------------------------------
// Takes
// ---------------------------------------------------------------------------

/**
 * "allocating" is the crash window the recovery saga exists for: the take number is reserved
 * and fsynced, and no job yet records having been enqueued. Everything after that is the
 * queue's own status vocabulary, carried whole rather than projected down to four states.
 */
export const BenchTakeStatusSchema = z.enum(["allocating", ...JobStatusSchema.options]);
export type BenchTakeStatus = z.infer<typeof BenchTakeStatusSchema>;

export const BenchTakeMediaSchema = z
  .object({
    /** Filename within the take's own media directory — never a path. */
    file: z.string().min(1),
    hash: Sha256Schema,
    info: MediaInfoSchema.optional(),
  })
  .strict();
export type BenchTakeMedia = z.infer<typeof BenchTakeMediaSchema>;

export const BenchTakeDispositionSchema = z.enum(["open", "filed", "discarded"]);
export type BenchTakeDisposition = z.infer<typeof BenchTakeDispositionSchema>;

export const BenchTakeSchema = z
  .object({
    id: TakeIdSchema,
    /** 1-based, in the order asked for, oldest first. A queued take holds its number. */
    n: z.number().int().min(1),
    /** Idempotency: a retried dispatch command re-reads this instead of minting a sibling. */
    requestId: z.string().min(1),
    jobId: JobIdSchema.optional(),
    status: BenchTakeStatusSchema,
    request: BenchRequestSnapshotSchema,
    media: BenchTakeMediaSchema.optional(),
    cost: TakeCostSchema.optional(),
    disposition: BenchTakeDispositionSchema,
    keptArtifactId: ArtifactIdSchema.optional(),
    /** Hidden from the wall. Presentation state — the bytes and the number both stay. */
    clearedFromView: z.boolean().optional(),
    error: z.string().optional(),
    createdAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.optional(),
  })
  .strict();
export type BenchTake = z.infer<typeof BenchTakeSchema>;

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export const BenchComposerSchema = z
  .object({
    mode: BenchModeSchema,
    provider: z.string(),
    /** Empty means no model chosen yet — a state the screen shows, never dispatches from. */
    model: z.string(),
    params: BenchParamsSchema,
    brief: z.string(),
    /** Tokens currently riding, in attach order. Every one resolves in the registry. */
    activeTokens: z.array(z.string().regex(BENCH_TOKEN)),
  })
  .strict();
export type BenchComposer = z.infer<typeof BenchComposerSchema>;

export const BenchSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SessionIdSchema,
    /** Null renders as "Untitled session". */
    title: z.string().max(200).nullable(),
    composer: BenchComposerSchema,
    /**
     * Every token ever allocated, active or not. Inactive entries are retained so re-adding
     * the same source restores its old name instead of minting a new one — "Image 2" means the
     * same bytes for the whole life of the session, in every brief that ever cited it.
     */
    tokenRegistry: z.array(BenchReferenceTokenSchema),
    /** Next number per kind. Monotonic; never reused within the session. */
    nextToken: z.record(ReferenceKindSchema, z.number().int().min(1)),
    nextTake: z.number().int().min(1),
    selectedTakeId: TakeIdSchema.optional(),
    takes: z.array(BenchTakeSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((session, ctx) => {
    const seenN = new Set<number>();
    const seenId = new Set<string>();
    const seenRequest = new Set<string>();
    for (const take of session.takes) {
      if (seenN.has(take.n)) ctx.addIssue({ code: "custom", message: `take number ${take.n} is used twice` });
      if (seenId.has(take.id)) ctx.addIssue({ code: "custom", message: `take id ${take.id} is used twice` });
      if (seenRequest.has(take.requestId)) {
        ctx.addIssue({ code: "custom", message: `take requestId ${take.requestId} is used twice` });
      }
      seenN.add(take.n);
      seenId.add(take.id);
      seenRequest.add(take.requestId);
      if (take.n >= session.nextTake) {
        ctx.addIssue({ code: "custom", message: `nextTake ${session.nextTake} does not clear allocated take ${take.n}` });
      }
      if (take.disposition === "filed" && take.keptArtifactId === undefined) {
        ctx.addIssue({ code: "custom", message: `take ${take.n} is filed but names no artifact` });
      }
    }
    if (session.selectedTakeId !== undefined && !seenId.has(session.selectedTakeId)) {
      ctx.addIssue({ code: "custom", message: "selectedTakeId names no take in this session" });
    }
    const tokens = new Set<string>();
    const sources = new Set<string>();
    for (const entry of session.tokenRegistry) {
      if (tokens.has(entry.token)) ctx.addIssue({ code: "custom", message: `token "${entry.token}" is allocated twice` });
      tokens.add(entry.token);
      const key = benchSourceKey(entry.source);
      if (sources.has(key)) ctx.addIssue({ code: "custom", message: `source ${key} carries two tokens` });
      sources.add(key);
      const parsed = parseBenchToken(entry.token);
      if (parsed !== null) {
        const next = session.nextToken[parsed.kind] ?? 1;
        if (parsed.n >= next) {
          ctx.addIssue({ code: "custom", message: `nextToken.${parsed.kind} ${next} does not clear "${entry.token}"` });
        }
      }
    }
    const active = new Set<string>();
    for (const token of session.composer.activeTokens) {
      if (active.has(token)) ctx.addIssue({ code: "custom", message: `token "${token}" is active twice` });
      active.add(token);
      if (!tokens.has(token)) ctx.addIssue({ code: "custom", message: `active token "${token}" is not in the registry` });
    }
    if (session.composer.params.kind !== session.composer.mode) {
      ctx.addIssue({ code: "custom", message: "composer params do not match the composer mode" });
    }
  });
export type BenchSession = z.infer<typeof BenchSessionSchema>;

/** What the world bundle carries: enough to resume, never the takes themselves. */
export const BenchSessionSummarySchema = z
  .object({
    id: SessionIdSchema,
    title: z.string().max(200).nullable(),
    mode: BenchModeSchema,
    updatedAt: IsoDateTimeSchema,
    takeCount: z.number().int().min(0),
    runningCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
  })
  .strict();
export type BenchSessionSummary = z.infer<typeof BenchSessionSummarySchema>;

/** The loaded workspace on ClientState — one session at a time, like World Chat's. */
export const BenchWorkspaceSchema = z
  .object({
    worldId: z.string().min(1),
    session: BenchSessionSchema,
  })
  .strict();
export type BenchWorkspace = z.infer<typeof BenchWorkspaceSchema>;

// ---------------------------------------------------------------------------
// The event log
// ---------------------------------------------------------------------------

export const BenchSessionMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SessionIdSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type BenchSessionMeta = z.infer<typeof BenchSessionMetaSchema>;

/**
 * The reservation is its own event, fsynced before any job exists, because it is the record
 * that authorizes provider spend: recovery finding a reserved take with no job knows the crash
 * happened before enqueue and nothing was charged. Count N reserves N in one event so sibling
 * numbers are consecutive whatever lands between them.
 */
export const BenchReservedTakeSchema = z
  .object({
    id: TakeIdSchema,
    n: z.number().int().min(1),
    requestId: z.string().min(1),
    request: BenchRequestSnapshotSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type BenchReservedTake = z.infer<typeof BenchReservedTakeSchema>;

export const BenchEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("title-set"), title: z.string().max(200).nullable() }).strict(),
  z
    .object({
      type: z.literal("composer-set"),
      mode: BenchModeSchema,
      provider: z.string(),
      model: z.string(),
      params: BenchParamsSchema,
      brief: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("reference-added"), entry: BenchReferenceTokenSchema }).strict(),
  /** Re-adding a source whose token already exists in the registry: the old name comes back. */
  z.object({ type: z.literal("reference-restored"), token: z.string().regex(BENCH_TOKEN) }).strict(),
  z.object({ type: z.literal("reference-removed"), token: z.string().regex(BENCH_TOKEN) }).strict(),
  /** The at-capacity path: one out, one in, atomically, so the set is never over the ceiling. */
  z
    .object({
      type: z.literal("reference-replaced"),
      removed: z.string().regex(BENCH_TOKEN),
      entry: BenchReferenceTokenSchema,
    })
    .strict(),
  z.object({ type: z.literal("takes-reserved"), takes: z.array(BenchReservedTakeSchema).min(1) }).strict(),
  z.object({ type: z.literal("take-job"), takeId: TakeIdSchema, jobId: JobIdSchema }).strict(),
  z
    .object({
      type: z.literal("take-status"),
      takeId: TakeIdSchema,
      status: JobStatusSchema,
      error: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("take-completed"),
      takeId: TakeIdSchema,
      media: BenchTakeMediaSchema,
      cost: TakeCostSchema.optional(),
      completedAt: IsoDateTimeSchema,
    })
    .strict(),
  z.object({ type: z.literal("take-filed"), takeId: TakeIdSchema, artifactId: ArtifactIdSchema }).strict(),
  z.object({ type: z.literal("take-discarded"), takeId: TakeIdSchema }).strict(),
  z.object({ type: z.literal("take-cleared"), takeId: TakeIdSchema }).strict(),
  z.object({ type: z.literal("take-selected"), takeId: TakeIdSchema }).strict(),
]);
export type BenchEvent = z.infer<typeof BenchEventSchema>;

export const BenchEventEnvelopeSchema = z
  .object({
    seq: z.number().int().min(1),
    at: IsoDateTimeSchema,
    /** Carried when a client command asked for this, so a resent command deduplicates. */
    requestId: z.string().min(1).optional(),
    event: BenchEventSchema,
  })
  .strict();
export type BenchEventEnvelope = z.infer<typeof BenchEventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// The fold — events in, session out. Pure, shared by the coordinator's writer
// and any test that wants to assert what a log means.
// ---------------------------------------------------------------------------

const EMPTY_COMPOSER: BenchComposer = {
  mode: "image",
  provider: "",
  model: "",
  params: { kind: "image", count: 1 },
  brief: "",
  activeTokens: [],
};

export function foldBenchSession(meta: BenchSessionMeta, envelopes: readonly BenchEventEnvelope[]): BenchSession {
  const session: BenchSession = {
    schemaVersion: 1,
    id: meta.id,
    title: null,
    composer: { ...EMPTY_COMPOSER, params: { ...EMPTY_COMPOSER.params } as BenchParams, activeTokens: [] },
    tokenRegistry: [],
    nextToken: {},
    nextTake: 1,
    takes: [],
    createdAt: meta.createdAt,
    updatedAt: meta.createdAt,
  };
  const takesById = new Map<string, BenchTake>();
  const claimToken = (entry: BenchReferenceToken): void => {
    session.tokenRegistry.push(entry);
    const parsed = parseBenchToken(entry.token);
    if (parsed !== null) {
      const next = session.nextToken[parsed.kind] ?? 1;
      if (parsed.n >= next) session.nextToken[parsed.kind] = parsed.n + 1;
    }
  };
  const activate = (token: string): void => {
    if (!session.composer.activeTokens.includes(token)) session.composer.activeTokens.push(token);
  };
  for (const { at, event } of envelopes) {
    session.updatedAt = at;
    switch (event.type) {
      case "title-set":
        session.title = event.title;
        break;
      case "composer-set":
        session.composer = {
          mode: event.mode,
          provider: event.provider,
          model: event.model,
          params: event.params,
          brief: event.brief,
          activeTokens: session.composer.activeTokens,
        };
        break;
      case "reference-added":
        claimToken(event.entry);
        activate(event.entry.token);
        break;
      case "reference-restored":
        activate(event.token);
        break;
      case "reference-removed":
        session.composer.activeTokens = session.composer.activeTokens.filter((t) => t !== event.token);
        break;
      case "reference-replaced":
        session.composer.activeTokens = session.composer.activeTokens.filter((t) => t !== event.removed);
        claimToken(event.entry);
        activate(event.entry.token);
        break;
      case "takes-reserved":
        for (const reserved of event.takes) {
          const take: BenchTake = {
            id: reserved.id,
            n: reserved.n,
            requestId: reserved.requestId,
            status: "allocating",
            request: reserved.request,
            disposition: "open",
            createdAt: reserved.createdAt,
          };
          session.takes.push(take);
          takesById.set(take.id, take);
          if (reserved.n >= session.nextTake) session.nextTake = reserved.n + 1;
          session.selectedTakeId = take.id;
        }
        break;
      case "take-job": {
        const take = takesById.get(event.takeId);
        if (take) {
          take.jobId = event.jobId;
          if (take.status === "allocating") take.status = "queued";
        }
        break;
      }
      case "take-status": {
        const take = takesById.get(event.takeId);
        if (take) {
          take.status = event.status;
          if (event.error !== undefined) take.error = event.error;
        }
        break;
      }
      case "take-completed": {
        const take = takesById.get(event.takeId);
        if (take) {
          take.status = "succeeded";
          take.media = event.media;
          if (event.cost !== undefined) take.cost = event.cost;
          take.completedAt = event.completedAt;
          session.selectedTakeId = take.id;
        }
        break;
      }
      case "take-filed": {
        const take = takesById.get(event.takeId);
        if (take) {
          take.disposition = "filed";
          take.keptArtifactId = event.artifactId;
        }
        break;
      }
      case "take-discarded": {
        const take = takesById.get(event.takeId);
        if (take) take.disposition = "discarded";
        break;
      }
      case "take-cleared": {
        const take = takesById.get(event.takeId);
        if (take) take.clearedFromView = true;
        break;
      }
      case "take-selected":
        if (takesById.has(event.takeId)) session.selectedTakeId = event.takeId;
        break;
    }
  }
  return session;
}

/** The summary a world bundle carries, derived the one way everywhere. */
export function benchSessionSummary(session: BenchSession): BenchSessionSummary {
  const running = session.takes.filter(
    (t) => t.status === "allocating" || t.status === "queued" || t.status === "submitting" || t.status === "running",
  ).length;
  const failed = session.takes.filter((t) => t.status === "failed" || t.status === "needs-reconciliation").length;
  return {
    id: session.id,
    title: session.title,
    mode: session.composer.mode,
    updatedAt: session.updatedAt,
    takeCount: session.takes.length,
    runningCount: running,
    failedCount: failed,
  };
}
