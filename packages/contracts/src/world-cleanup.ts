import { z } from "zod";

/**
 * World clean-up (SPEC-066): a plan the Studio computes from the world's own records, read and
 * ticked by the person, then run by the coordinator under the world's ownership with a ledger,
 * `cleanup.jsonl`, it can recover from. Duplicate copies become hard links, remakeable mixes are
 * cleared, and everything else waits in `.held` for days, where Restore puts it back.
 *
 * Everything here travels on one private request and its reply, to the asking Studio window only
 * (R-2, R-17): the plan names world paths, and the client sends back ids, never paths.
 */

export const CLEANUP_CLASSES = [
  "bench-copies", "reference-copies", "stale-mixes", "current-mixes", // phase 1: links and caches
  "old-exports", "unkept-bench-takes",                                 // phase 2: the hold
  "unused-artifacts", "audiobook-takes",                               // phase 3: after a census
] as const;
export type CleanupClass = typeof CLEANUP_CLASSES[number];

export const CLEANUP_CLASS_LABELS: Record<CleanupClass, string> = {
  "bench-copies": "Bench copies", "reference-copies": "Reference copies", "stale-mixes": "Old chapter mixes",
  "current-mixes": "Current mixes", "old-exports": "Old exports", "unkept-bench-takes": "Unkept Bench takes",
  "unused-artifacts": "Unused artifacts", "audiobook-takes": "Unkept narration",
};

/** Days a class's files wait in `.held` before they go (R-28); 0 is a link or a cleared mix. */
export const CLEANUP_HOLD_DAYS: Record<CleanupClass, 0 | 7 | 30> = {
  "bench-copies": 0, "reference-copies": 0, "stale-mixes": 0, "current-mixes": 0,
  "old-exports": 7, "unkept-bench-takes": 7, "unused-artifacts": 30, "audiobook-takes": 30,
};

/** Ticked when the sheet opens (R-32 – R-40): only what costs nothing to have again. */
export const CLEANUP_TICKED: ReadonlySet<CleanupClass> = new Set(["bench-copies", "reference-copies", "stale-mixes"]);

export const CleanupActionSchema = z.enum(["link", "clear", "hold"]);
export type CleanupAction = z.infer<typeof CleanupActionSchema>;
export const cleanupAction = (cls: CleanupClass): CleanupAction =>
  cls === "bench-copies" || cls === "reference-copies" ? "link" : cls === "stale-mixes" || cls === "current-mixes" ? "clear" : "hold";

const PlanId = z.string().regex(/^cp_[0-9A-HJKMNP-TV-Z]{26}$/);
const ItemId = z.string().regex(/^ci_\d{1,6}$/);
const Bytes = z.number().int().nonnegative().safe();
const IsoDate = z.string().datetime();
const Label = z.string().min(1).max(300);

/** An item as the sheet shows it: world paths and labels, never a file identity (R-17). */
export const CleanupItemSchema = z.object({
  id: ItemId, class: z.enum(CLEANUP_CLASSES), label: Label,
  /** Under Unused artifacts, the production that owns it, else the world (R-15). */
  group: z.string().max(200).optional(),
  paths: z.array(z.string().min(1).max(1024)).min(1).max(4096),
  /** Logical bytes the item leaves with no name, counted once per file (R-9). */
  bytes: Bytes,
  /** What reading an audiobook take again would cost (R-40). */
  costMicroUsd: Bytes.optional(),
  /** The newer export that covers an old one (R-36). */
  covers: z.string().max(200).optional(),
  ticked: z.boolean(),
}).strict();
export type CleanupItem = z.infer<typeof CleanupItemSchema>;

export const CleanupProblemSchema = z.object({
  kind: z.enum(["missing-media", "former-shapes", "header-only", "no-sidecar", "changed", "stray", "last-copy", "kept-back"]),
  label: Label, count: z.number().int().nonnegative(), bytes: Bytes.nullable(),
  /** Bench pictures whose artifact is gone: Put back on shelf files them again (R-44). */
  putBack: z.boolean().optional(),
}).strict();
export type CleanupProblem = z.infer<typeof CleanupProblemSchema>;

export const CleanupClassRowSchema = z.object({
  class: z.enum(CLEANUP_CLASSES), state: z.enum(["offered", "stopped"]),
  /** Why a class offers nothing, in one clause (R-8, R-14). */
  stoppedBy: z.string().max(200).optional(),
  items: z.number().int().nonnegative(), bytes: Bytes, holdDays: z.union([z.literal(0), z.literal(7), z.literal(30)]),
}).strict();

export const CleanupPlanSchema = z.object({
  id: PlanId, madeAt: IsoDate, expiresAt: IsoDate,
  classes: z.array(CleanupClassRowSchema),
  items: z.array(CleanupItemSchema).max(50_000),
  problems: z.array(CleanupProblemSchema).max(64),
  /** Retired records whose file is already gone: counted apart, not a problem (R-42). */
  retiredWithoutMedia: z.number().int().nonnegative(),
}).strict();
export type CleanupPlan = z.infer<typeof CleanupPlanSchema>;

/** Why nothing can run now (R-3, R-4, R-24): the plan still reads, Clean up… is off. */
export const CleanupRefusalSchema = z.enum(["read-only", "outside-edits", "opened-elsewhere", "unsettled", "running"]);
export type CleanupRefusal = z.infer<typeof CleanupRefusalSchema>;

export const CleanupClassResultSchema = z.object({
  class: z.enum(CLEANUP_CLASSES), done: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), bytes: Bytes, reasons: z.array(z.string().max(200)).max(8),
}).strict();

export const CleanupRunSchema = z.object({
  planId: PlanId, startedAt: IsoDate, endedAt: IsoDate.nullable(),
  done: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  /** Bytes the run left with no name: links and cleared mixes (R-23). */
  cleared: Bytes,
  held: Bytes, holdUntil: IsoDate.nullable(),
  classes: z.array(CleanupClassResultSchema),
  /** Set when a run ended before its last item (R-22). */
  stopped: z.enum(["stopped", "outside-edits", "opened-elsewhere", "world-closed", "failed"]).optional(),
  /** The drive's free space before and after, as measured; null when it cannot be told (R-23). */
  availableBefore: Bytes.nullable(), availableAfter: Bytes.nullable(),
}).strict();
export type CleanupRun = z.infer<typeof CleanupRunSchema>;

export const CleanupHeldItemSchema = z.object({
  id: ItemId, class: z.enum(CLEANUP_CLASSES), label: Label, bytes: Bytes,
  /** Why it cannot go back now (R-29): its place is taken, or its files are not where they were held. */
  blocked: z.string().max(200).optional(),
}).strict();

export const CleanupHeldPlanSchema = z.object({
  planId: PlanId, madeAt: IsoDate, holdUntil: IsoDate,
  /** The first Clean up opening after this goes ahead with the files (R-30). */
  goesAfter: IsoDate,
  state: z.enum(["held", "ended", "elsewhere", "unsettled"]),
  bytes: Bytes, items: z.array(CleanupHeldItemSchema),
}).strict();
export type CleanupHeldPlan = z.infer<typeof CleanupHeldPlanSchema>;

export const CleanupStatusSchema = z.object({
  /** The run under way, or the last one, until the sheet's Done. */
  run: CleanupRunSchema.nullable(),
  running: z.boolean(),
  held: z.array(CleanupHeldPlanSchema),
  refusal: CleanupRefusalSchema.nullable(),
  /** Phase 4 (R-41): old chapter mixes cleared on their own when the world opens. */
  autoMixes: z.boolean(),
}).strict();
export type CleanupStatus = z.infer<typeof CleanupStatusSchema>;

const Ids = z.array(ItemId).max(50_000);
export const WorldCleanupOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("plan") }).strict(),
  z.object({ op: z.literal("status") }).strict(),
  z.object({ op: z.literal("run"), planId: PlanId, items: Ids.min(1) }).strict(),
  z.object({ op: z.literal("stop") }).strict(),
  z.object({ op: z.literal("dismiss") }).strict(),
  z.object({ op: z.literal("restore"), planId: PlanId, items: Ids.optional() }).strict(),
  z.object({ op: z.literal("empty"), planId: PlanId }).strict(),
  z.object({ op: z.literal("put-back") }).strict(),
  z.object({ op: z.literal("auto-mixes"), on: z.boolean() }).strict(),
]);
export type WorldCleanupOp = z.infer<typeof WorldCleanupOpSchema>;

export const WorldCleanupCommandSchema = z.object({
  kind: z.literal("world-cleanup"), requestId: z.string().uuid(), worldId: z.string().min(1).max(64), request: WorldCleanupOpSchema,
}).strict();
export type WorldCleanupCommand = z.infer<typeof WorldCleanupCommandSchema>;

export const WorldCleanupAnswerSchema = z.union([
  z.object({ ok: z.literal(true), plan: CleanupPlanSchema.optional(), status: CleanupStatusSchema, note: z.string().max(300).optional() }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1).max(300) }).strict(),
]);
export type WorldCleanupAnswer = z.infer<typeof WorldCleanupAnswerSchema>;
