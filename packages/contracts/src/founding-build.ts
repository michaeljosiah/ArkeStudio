import { z } from "zod";
import { GenesisBlueprintSchema, keyArtBriefSettled, type GenesisBlueprint } from "./genesis.js";
import { GenesisIdSchema, IsoDateTimeSchema, UlidSchema, prefixedIdSchema, ulid } from "./ids.js";
import { estimateCharacterImageMicroUsd, estimateMicroUsd, type ManifestModel } from "./manifest.js";
import { SheetKindSchema } from "./world.js";

/**
 * The founding build (SPEC-031 §1.4–§1.7): one press turns the blueprint into a finished
 * world. The build record is the authorization — written atomically once, never edited —
 * and progress lives in a sibling append-only journal. Build state is a pure fold over the
 * record, the journal and the queue's job facts: never a timer, never an open screen.
 *
 * The record and journal live inside the world it founds:
 *
 *   <world>/build/build.json    the authorization, written once
 *   <world>/build/build.jsonl   the journal, appended and fsynced
 */

export const FoundingBuildIdSchema = prefixedIdSchema("fb");

// ---------------------------------------------------------------------------
// Stages (R-38, R-39): five, mapped one-to-one onto the run's phases so a
// stage can never fill while the phase behind it is still running.
// ---------------------------------------------------------------------------

export const BUILD_STAGES = [
  { id: "understanding", label: "Understanding your vision" },
  { id: "shaping", label: "Shaping the world" },
  { id: "creating", label: "Creating characters" },
  { id: "forging", label: "Forging history and lore" },
  { id: "finalizing", label: "Finalizing the details" },
] as const;
export type BuildStageId = (typeof BUILD_STAGES)[number]["id"];

// ---------------------------------------------------------------------------
// Items (R-13): a stable key for everything the run will do, derived from the
// item's identity — the same item computes the same key on every pass,
// including the pass after a crash.
// ---------------------------------------------------------------------------

export const BuildItemKindSchema = z.enum([
  /** world.json, art direction v1, bible v1, attachments carried in. */
  "world",
  /** One sheet authored — character, location or faction — and settled. */
  "author-sheet",
  /** One canon thread opened. */
  "thread",
  /** One main photo, generated at count 1, landing as the identity anchor (R-21, R-26). */
  "main-photo",
  /** One establishing view per location, landing as the location's anchor (R-28). */
  "establishing-view",
  /** One character sheet composite, conditioned on that character's anchor (R-22). */
  "sheet-image",
  /** The world's key art, conditioned on the cast (§1.11). */
  "key-art",
  /** Index rebuild, change log, sandbox discard — the run's tail. */
  "finalize",
]);
export type BuildItemKind = z.infer<typeof BuildItemKindSchema>;

/** The kinds that dispatch a paid generation — the number the review screen states (R-12). */
export function buildItemDispatches(kind: BuildItemKind): boolean {
  return kind === "main-photo" || kind === "establishing-view" || kind === "sheet-image" || kind === "key-art";
}

export const BuildItemSchema = z
  .object({
    /** `<kind>:<subject>` — stable across every pass (R-13). */
    key: z.string().min(1),
    kind: BuildItemKindSchema,
    /** 1..4 — which post-planning stage this item's work fills (stage 0 is planning). */
    stage: z.number().int().min(1).max(4),
    /** The entity slug, or the kind itself for singletons. */
    subject: z.string().min(1),
    /** What the working line calls it: "Nadia", "The Vigil", the world's name (R-41). */
    name: z.string().min(1),
    sheetType: SheetKindSchema.optional(),
    estimatedMicroUsd: z.number().int().min(0),
    /**
     * Authorized to run in this build. False for image work with no resolvable route
     * (R-11) — recorded anyway, because these keys are the durable record Activity
     * derives runnable rows from (R-48), and excluded from the progress denominator.
     */
    authorized: z.boolean(),
    /** Why an unauthorized item is not running, stated once (R-11). */
    refusal: z.string().optional(),
    /**
     * Pre-allocated queue idempotency key for image items (SPEC-024 D2): the crash
     * window between the journal append and the enqueue has nothing to invent, and
     * re-enqueueing the same key joins the existing job rather than spending twice.
     */
    idempotencyKey: UlidSchema.optional(),
    /** A sheet-image runs only if this character's anchor landed (R-22). */
    needsAnchorOf: z.string().optional(),
  })
  .strict();
export type BuildItem = z.infer<typeof BuildItemSchema>;

// ---------------------------------------------------------------------------
// The record (R-13, R-14): no mutable status of any kind.
// ---------------------------------------------------------------------------

export const FoundingBuildRecordSchema = z
  .object({
    buildId: FoundingBuildIdSchema,
    /** The creating command's idempotency (R-16): a replayed press joins this run. */
    requestId: UlidSchema,
    worldId: UlidSchema,
    genesisId: GenesisIdSchema,
    /** The folded blueprint as authorized — what the author said yes to. */
    blueprint: GenesisBlueprintSchema,
    /** Every image records the version it was made under; the build founds at v1 (R-20). */
    artDirectionVersion: z.literal(1),
    /** The aggregate cap in micro-USD: the sum of estimates the author confirmed (R-15). */
    capMicroUsd: z.number().int().min(0),
    /** The model and route frozen per capability. Null: a text-only build (R-11). */
    image: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        displayName: z.string().min(1),
        /** What the route accepts — 0 refuses every conditioned generation (R-10). */
        referenceImages: z.number().int().min(0),
      })
      .nullable(),
    items: z.array(BuildItemSchema).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type FoundingBuildRecord = z.infer<typeof FoundingBuildRecordSchema>;

// ---------------------------------------------------------------------------
// The journal (R-31): intent before dispatch, terminal when settled.
// ---------------------------------------------------------------------------

export const BuildOutcomeSchema = z.enum([
  /** Written, accepted, live (R-25). */
  "landed",
  /** The item failed alone; the run continued (R-23). */
  "failed",
  /** A dependency did not land, or the cap was reached — never dispatched (R-22, R-15). */
  "skipped",
  /**
   * The queue parked it behind a human action — a paused lane, needs-reconciliation —
   * and the build refused to wait (R-23). The job is not cancelled; Activity resumes it.
   */
  "held",
]);
export type BuildOutcome = z.infer<typeof BuildOutcomeSchema>;

export const BuildJournalEntrySchema = z.discriminatedUnion("kind", [
  /**
   * The work is about to be dispatched — fsynced before anything runs (R-31). An image
   * item's intent carries the queue idempotency key the dispatch will use, so the crash
   * window between this append and the enqueue has nothing to invent on ANY attempt —
   * a retry's fresh key included: recovery re-enqueues the journalled key and the queue
   * returns the existing job rather than journalling a second spend (R-34).
   */
  z
    .object({
      kind: z.literal("intent"),
      key: z.string().min(1),
      idempotencyKey: UlidSchema.optional(),
      at: IsoDateTimeSchema,
    })
    .strict(),
  /** The queue returned a job id for the intent (R-31). */
  z
    .object({
      kind: z.literal("enqueued"),
      key: z.string().min(1),
      jobId: z.string().min(1),
      at: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("terminal"),
      key: z.string().min(1),
      outcome: BuildOutcomeSchema,
      detail: z.string().optional(),
      at: IsoDateTimeSchema,
    })
    .strict(),
  /** The author pressed Stop — the only halt there is (R-35). */
  z.object({ kind: z.literal("stopped"), at: IsoDateTimeSchema }).strict(),
  /** The run reached the end of the last wave (R-24). */
  z.object({ kind: z.literal("completed"), at: IsoDateTimeSchema }).strict(),
  /** The author dismissed the completion notice (R-45). */
  z.object({ kind: z.literal("notice-dismissed"), at: IsoDateTimeSchema }).strict(),
]);
export type BuildJournalEntry = z.infer<typeof BuildJournalEntrySchema>;

// ---------------------------------------------------------------------------
// The fold (R-32): pure, idempotent, indifferent to replay.
// ---------------------------------------------------------------------------

/** The queue facts the fold joins on — a projection of SPEC-009's job record, never a copy. */
export interface BuildJobFacts {
  id: string;
  status: "queued" | "submitting" | "running" | "succeeded" | "failed" | "cancelled" | "needs-reconciliation";
}

export const BuildItemStateSchema = z
  .object({
    key: z.string().min(1),
    kind: BuildItemKindSchema,
    stage: z.number().int().min(1).max(4),
    subject: z.string().min(1),
    name: z.string().min(1),
    state: z.enum(["pending", "running", "landed", "failed", "skipped", "held", "unauthorized"]),
    authorized: z.boolean(),
    estimatedMicroUsd: z.number().int().min(0),
    jobId: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();
export type BuildItemState = z.infer<typeof BuildItemStateSchema>;

export const BuildStageStateSchema = z
  .object({
    id: z.enum(["understanding", "shaping", "creating", "forging", "finalizing"]),
    label: z.string().min(1),
    state: z.enum(["pending", "active", "complete"]),
  })
  .strict();

export const FoundingBuildStateSchema = z
  .object({
    buildId: FoundingBuildIdSchema,
    worldId: UlidSchema,
    genesisId: GenesisIdSchema,
    worldName: z.string().min(1),
    status: z.enum(["running", "stopped", "completed"]),
    stages: z.array(BuildStageStateSchema).length(5),
    /** Items terminal over items authorized — a real fraction of known work (R-40). */
    progress: z.object({ terminal: z.number().int().min(0), authorized: z.number().int().min(0) }).strict(),
    /** The items in flight, named — "Nadia · main photo" (R-41). */
    working: z.array(z.string()),
    items: z.array(BuildItemStateSchema),
    /** What did not land, as a count and one cause (R-46). Null: everything landed. */
    shortfall: z
      .object({ count: z.number().int().min(1), cause: z.string().min(1) })
      .strict()
      .nullable(),
    /** The notice shows until dismissed or the work it names is no longer outstanding (R-45). */
    noticeDismissed: z.boolean(),
    capMicroUsd: z.number().int().min(0),
    estimatedSpendMicroUsd: z.number().int().min(0),
  })
  .strict();
export type FoundingBuildState = z.infer<typeof FoundingBuildStateSchema>;

/** What the working line calls one item (R-41): the subject, then what is being made. */
export function buildWorkingLine(item: Pick<BuildItem, "kind" | "name">): string {
  const noun: Record<BuildItemKind, string> = {
    world: "world files",
    "author-sheet": "sheet",
    thread: "thread",
    "main-photo": "main photo",
    "establishing-view": "establishing view",
    "sheet-image": "character sheet",
    "key-art": "key art",
    finalize: "finishing",
  };
  return `${item.name} · ${noun[item.kind]}`;
}

/**
 * Fold the record, the journal and the queue's facts into one state. Terminal entries
 * outrank everything; an intent with no terminal reads as running (in doubt after a crash,
 * which recovery resolves against the queue by job id — R-34).
 */
export function foldFoundingBuild(
  record: FoundingBuildRecord,
  entries: readonly BuildJournalEntry[],
  jobs: readonly BuildJobFacts[],
  worldName: string,
): FoundingBuildState {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  // Last word wins, per key: a terminal followed by a fresh intent is the item running
  // again — the shape every Activity re-run leaves behind (R-48, R-49).
  const lastByKey = new Map<string, Extract<BuildJournalEntry, { kind: "intent" | "terminal" }>>();
  const jobIdByKey = new Map<string, string>();
  let stopped = false;
  let completed = false;
  let noticeDismissed = false;
  for (const entry of entries) {
    if (entry.kind === "intent" || entry.kind === "terminal") lastByKey.set(entry.key, entry);
    else if (entry.kind === "enqueued") jobIdByKey.set(entry.key, entry.jobId);
    else if (entry.kind === "stopped") stopped = true;
    else if (entry.kind === "completed") completed = true;
    else if (entry.kind === "notice-dismissed") noticeDismissed = true;
  }

  const items: BuildItemState[] = record.items.map((item) => {
    const jobId = jobIdByKey.get(item.key);
    const base = {
      key: item.key,
      kind: item.kind,
      stage: item.stage,
      subject: item.subject,
      name: item.name,
      authorized: item.authorized,
      estimatedMicroUsd: item.estimatedMicroUsd,
      ...(jobId !== undefined ? { jobId } : {}),
    };
    const last = lastByKey.get(item.key);
    if (last?.kind === "terminal") {
      return {
        ...base,
        state: last.outcome,
        ...(last.detail !== undefined ? { detail: last.detail } : {}),
      };
    }
    if (last?.kind === "intent") {
      // Dispatched, not yet settled. The joined job says how it is going; a job the queue
      // no longer knows reads as running until recovery reconciles it (R-34).
      const job = jobId !== undefined ? jobById.get(jobId) : undefined;
      if (job?.status === "failed" || job?.status === "cancelled") {
        return { ...base, state: "failed" as const, detail: "the job did not land" };
      }
      return { ...base, state: "running" as const };
    }
    // Never journalled. Unauthorized work is visible with its refusal (R-11, R-48) — the
    // journal above outranks this, so a later press that ran it reads as what it became.
    if (!item.authorized) {
      return {
        ...base,
        state: "unauthorized" as const,
        ...(item.refusal !== undefined ? { detail: item.refusal } : {}),
      };
    }
    if (stopped) return { ...base, state: "skipped" as const, detail: "stopped before it ran" };
    return { ...base, state: "pending" as const };
  });

  const authorized = items.filter((item) => item.authorized);
  const terminalStates = new Set(["landed", "failed", "skipped", "held"]);
  const terminalCount = authorized.filter((item) => terminalStates.has(item.state)).length;

  // Stage states (R-39): stage 0 completes when the record exists — planning is what wrote
  // it. A later stage is complete when every authorized item in it is terminal, active when
  // any has started, pending otherwise — and never active while an earlier stage is unfinished.
  const stages = BUILD_STAGES.map((stage, index) => {
    if (index === 0) return { id: stage.id, label: stage.label, state: "complete" as const };
    const of = authorized.filter((item) => item.stage === index);
    const done = of.every((item) => terminalStates.has(item.state));
    if (of.length === 0 || done) {
      // An empty stage completes when the one before it does, never sooner.
      const priorDone = authorized
        .filter((item) => item.stage < index)
        .every((item) => terminalStates.has(item.state));
      return { id: stage.id, label: stage.label, state: priorDone ? ("complete" as const) : ("pending" as const) };
    }
    const started = of.some((item) => item.state !== "pending");
    return { id: stage.id, label: stage.label, state: started ? ("active" as const) : ("pending" as const) };
  });

  const working = items
    .filter((item) => item.state === "running")
    .map((item) => buildWorkingLine(item));

  // The shortfall (R-46): everything authorized that did not land, plus unauthorized image
  // work — a text-only build completes with its images named, not forgotten (R-11, row 25).
  const missing = items.filter(
    (item) =>
      item.state === "failed" ||
      item.state === "held" ||
      item.state === "skipped" ||
      item.state === "unauthorized",
  );
  const causes = new Map<string, number>();
  for (const item of missing) {
    const cause = item.detail ?? "did not land";
    causes.set(cause, (causes.get(cause) ?? 0) + 1);
  }
  const topCause = [...causes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const shortfall =
    missing.length > 0 && topCause !== undefined ? { count: missing.length, cause: topCause } : null;

  const estimatedSpendMicroUsd = items
    .filter((item) => item.state === "running" || item.state === "landed" || item.state === "failed" || item.state === "held")
    .reduce((sum, item) => sum + item.estimatedMicroUsd, 0);

  return {
    buildId: record.buildId,
    worldId: record.worldId,
    genesisId: record.genesisId,
    worldName,
    status: completed ? "completed" : stopped ? "stopped" : "running",
    stages,
    progress: { terminal: terminalCount, authorized: authorized.length },
    working,
    items,
    shortfall,
    noticeDismissed,
    capMicroUsd: record.capMicroUsd,
    estimatedSpendMicroUsd,
  };
}

// ---------------------------------------------------------------------------
// Compiling the blueprint into items (R-13) and the review (R-12).
// ---------------------------------------------------------------------------

export interface BuildImageRoute {
  model: ManifestModel;
  /** What the route accepts after the unverified floor — 0 refuses conditioned work. */
  referenceImages: number;
}

/**
 * One estimate per image kind, from the frozen route — the figures the review sums. Key art
 * bills the references it will carry, so its figure counts the knowable upper bound: every
 * cast member and place the brief names, capped at the route's slots (R-59, R-60).
 */
export function buildImageEstimates(
  model: ManifestModel,
  keyArtReferences = 0,
): Record<"mainPhoto" | "establishingView" | "sheetImage" | "keyArt", number> {
  return {
    mainPhoto: estimateCharacterImageMicroUsd(model, "main-photo", 1, 0),
    establishingView: estimateCharacterImageMicroUsd(model, "location-view", 1, 0),
    sheetImage: estimateCharacterImageMicroUsd(model, "character-sheet", 1, 1),
    keyArt: estimateMicroUsd(model, { images: 1, megapixels: 1, referenceImages: keyArtReferences }),
  };
}

/**
 * Every item the press authorizes, in run order, with stable keys (R-13). The blueprint
 * fixes the denominator (R-40); image work with no route is recorded unauthorized with the
 * refusal stated (R-11, R-48).
 */
export function compileBuildItems(
  blueprint: GenesisBlueprint,
  route: BuildImageRoute | null,
  mintKey: () => string = ulid,
): BuildItem[] {
  const items: BuildItem[] = [];
  const worldName = blueprint.name ?? "The world";
  const noImages = route === null;
  const refusal = noImages ? "no image model resolves — add a provider key and run it from Activity" : undefined;
  const sheetsRefused =
    route !== null && route.referenceImages === 0
      ? `${route.model.displayName} takes no reference images, so character sheets cannot carry the main photo`
      : undefined;
  const keyArtReferences =
    route === null || blueprint.keyArt === undefined
      ? 0
      : Math.min(
          blueprint.keyArt.characters.length + (blueprint.keyArt.location !== undefined ? 1 : 0),
          route.referenceImages,
        );
  const estimates = route !== null ? buildImageEstimates(route.model, keyArtReferences) : null;

  items.push({
    key: "world:world",
    kind: "world",
    stage: 1,
    subject: "world",
    name: worldName,
    estimatedMicroUsd: 0,
    authorized: true,
  });
  for (const location of blueprint.locations) {
    items.push({
      key: `author-sheet:location:${location.slug}`,
      kind: "author-sheet",
      stage: 1,
      subject: location.slug,
      name: location.name,
      sheetType: "location",
      estimatedMicroUsd: 0,
      authorized: true,
    });
  }
  for (const faction of blueprint.factions) {
    items.push({
      key: `author-sheet:faction:${faction.slug}`,
      kind: "author-sheet",
      stage: 1,
      subject: faction.slug,
      name: faction.name,
      sheetType: "faction",
      estimatedMicroUsd: 0,
      authorized: true,
    });
  }
  blueprint.threads.forEach((thread, index) => {
    items.push({
      key: `thread:${index + 1}`,
      kind: "thread",
      stage: 1,
      subject: `thread-${index + 1}`,
      name: thread.length > 60 ? `${thread.slice(0, 57)}…` : thread,
      estimatedMicroUsd: 0,
      authorized: true,
    });
  });

  for (const character of blueprint.characters) {
    items.push({
      key: `author-sheet:character:${character.slug}`,
      kind: "author-sheet",
      stage: 2,
      subject: character.slug,
      name: character.name,
      sheetType: "character",
      estimatedMicroUsd: 0,
      authorized: true,
    });
    items.push({
      key: `main-photo:${character.slug}`,
      kind: "main-photo",
      stage: 2,
      subject: character.slug,
      name: character.name,
      estimatedMicroUsd: estimates?.mainPhoto ?? 0,
      authorized: !noImages,
      ...(refusal !== undefined ? { refusal } : {}),
      ...(noImages ? {} : { idempotencyKey: mintKey() }),
    });
  }
  for (const location of blueprint.locations) {
    items.push({
      key: `establishing-view:${location.slug}`,
      kind: "establishing-view",
      stage: 2,
      subject: location.slug,
      name: location.name,
      estimatedMicroUsd: estimates?.establishingView ?? 0,
      authorized: !noImages,
      ...(refusal !== undefined ? { refusal } : {}),
      ...(noImages ? {} : { idempotencyKey: mintKey() }),
    });
  }

  for (const character of blueprint.characters) {
    const sheetImageRefusal = refusal ?? sheetsRefused;
    items.push({
      key: `sheet-image:${character.slug}`,
      kind: "sheet-image",
      stage: 3,
      subject: character.slug,
      name: character.name,
      estimatedMicroUsd: estimates?.sheetImage ?? 0,
      authorized: sheetImageRefusal === undefined,
      ...(sheetImageRefusal !== undefined ? { refusal: sheetImageRefusal } : {}),
      needsAnchorOf: character.slug,
      ...(sheetImageRefusal === undefined ? { idempotencyKey: mintKey() } : {}),
    });
  }
  // Key art needs a brief: one is never invented from a logline (R-5).
  if (keyArtBriefSettled(blueprint.keyArt)) {
    items.push({
      key: "key-art:world",
      kind: "key-art",
      stage: 3,
      subject: "key-art",
      name: worldName,
      estimatedMicroUsd: estimates?.keyArt ?? 0,
      authorized: !noImages,
      ...(refusal !== undefined ? { refusal } : {}),
      ...(noImages ? {} : { idempotencyKey: mintKey() }),
    });
  }

  items.push({
    key: "finalize:world",
    kind: "finalize",
    stage: 4,
    subject: "finalize",
    name: worldName,
    estimatedMicroUsd: 0,
    authorized: true,
  });

  return items;
}

// ---------------------------------------------------------------------------
// The review (R-12): what will be created, counted by kind; how many
// generations; the estimated spend as one figure — before the press.
// ---------------------------------------------------------------------------

export const BuildReviewSchema = z
  .object({
    genesisId: GenesisIdSchema,
    requestId: UlidSchema,
    worldName: z.string().min(1),
    counts: z
      .object({
        characters: z.number().int().min(0),
        locations: z.number().int().min(0),
        factions: z.number().int().min(0),
        threads: z.number().int().min(0),
      })
      .strict(),
    /** Image jobs the press authorizes — the number the author is agreeing to pay for. */
    generations: z.number().int().min(0),
    estimateMicroUsd: z.number().int().min(0),
    /** The frozen image route, named — or null with the refusal in `notes` (R-11). */
    imageModel: z.string().nullable(),
    /**
     * What will be built without what is missing, stated before the press (R-11): a dead
     * route, a reference-less model, a blueprint file that failed to parse (row 9), a
     * key-art brief never settled (row 9a), a harness that is not ready.
     */
    notes: z.array(z.string()),
    /** Blueprint files dropped from the fold, named (R-8, row 9). */
    dropped: z.array(z.string()),
  })
  .strict();
export type BuildReview = z.infer<typeof BuildReviewSchema>;
