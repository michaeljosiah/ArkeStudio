import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import { comfyUiWeightsComponentId, comfyUiWeightsRecipeId } from "./comfyui.js";
import { PROVIDERS, type ProviderId } from "./provider.js";
import type { ClientState } from "./client-state.js";

/**
 * The diagnostics snapshot (SPEC-032): the set of findings true right now, derived from state
 * the app already holds, keeping no store of its own. A finding is a condition, the facts under
 * it, the cause in one clause, and — where the product has one — the control that resolves it.
 *
 * Everything here is arithmetic over facts already measured. The derivation is a pure function
 * of explicit inputs (R-11); the caller owns the previous snapshot, which is how a finding knows
 * when it first became true without this module keeping a store (D2).
 */

// ---------------------------------------------------------------------------
// Severity (R-3, R-4, R-5)
// ---------------------------------------------------------------------------

/**
 * Five, not four (D5). `unmeasured` exists because hardware detection does not run until someone
 * opens an engine pane in Settings · Providers — so in most sessions every hardware fact is
 * missing, and reporting
 * that as `unknown` would say *we tried and failed* when the truth is *nobody asked*.
 */
export const FindingSeveritySchema = z.enum([
  "blocking",
  "degraded",
  "advisory",
  "unknown",
  "unmeasured",
]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** Presentation rank (R-36): the thing that stops work outranks the thing nobody measured. */
export const FINDING_SEVERITY_RANK: Record<FindingSeverity, number> = {
  blocking: 0,
  degraded: 1,
  advisory: 2,
  unknown: 3,
  unmeasured: 4,
};

// ---------------------------------------------------------------------------
// The control registry (R-24..R-27, §2.4)
// ---------------------------------------------------------------------------

/**
 * Every control a remedy may name, with where it lives in the product's own words for that
 * place. A contract rather than a convention because the derivation lives here and the controls
 * live in the renderer: a derivation cannot observe that a button was deleted. Removing an entry
 * makes every remedy that named it a type error — the only place to catch a dangling remedy,
 * since at runtime it is invisible until someone follows it (§2.4).
 *
 * `label` is the control's own text on its screen; `place` is the product's words for where it
 * sits; `route` is the hash route that reaches it. `targetParam`, where present, is the query
 * key the view appends a remedy's target under so the screen opens on the right row.
 */
export const CONTROL_REGISTRY = {
  /** Stops the supervised child and resolves the selection again (Settings · Providers). */
  "comfyui-restart": {
    label: "Restart",
    place: "Settings · Providers · ComfyUI",
    route: "/settings/providers?provider=comfyui",
  },
  /** Re-reads node classes and dependency identity on demand — the Settings refresh. */
  "comfyui-refresh": {
    label: "Refresh",
    place: "Settings · Providers · ComfyUI",
    route: "/settings/providers?provider=comfyui",
  },
  /** The explicit filesystem mapping a URL engine's file checks resolve against (SPEC-021 D13). */
  "comfyui-map-models-folder": {
    label: "Map a folder",
    place: "Settings · Providers · ComfyUI",
    route: "/settings/providers?provider=comfyui",
  },
  /**
   * One component's fetch, from the row that states the lack (SPEC-028 T-25).
   *
   * The three component remedies carry **only** the component, and Providers resolves the pane
   * from the component's own declaration (SPEC-034 R-24). One entry serves components belonging
   * to ComfyUI, Ollama and Voxa, so a `route` naming one engine would open the wrong pane for
   * the other two — and the single `targetParam` is already spent on the component id.
   */
  "component-download": {
    label: "Download",
    place: "Settings · Providers",
    route: "/settings/providers",
    targetParam: "component",
  },
  /** For the file that is on disk, intact, and not the bytes the recipe pins (SPEC-028). */
  "component-repair": {
    label: "Repair",
    place: "Settings · Providers",
    route: "/settings/providers",
    targetParam: "component",
  },
  /** Re-attempts a blocked or failed component — and re-runs the disk guard on the way. */
  "component-retry": {
    label: "Retry",
    place: "Settings · Providers",
    route: "/settings/providers",
    targetParam: "component",
  },
  /** Continue an app-owned ranged transfer from its durable byte boundary. */
  "component-resume": {
    label: "Resume",
    place: "Settings · Downloads",
    route: "/settings/downloads",
    targetParam: "component",
  },
  /** The provider's key row: save, replace, test (SPEC-008 §2.4). */
  "provider-key": {
    label: "Key",
    place: "Settings · Providers",
    route: "/settings/providers",
    targetParam: "provider",
  },
  /** The sign-in for a provider whose credential lives in a tool we drive, never in a key row. */
  "provider-sign-in": {
    label: "Sign in",
    place: "Settings · Providers",
    route: "/settings/providers",
    targetParam: "provider",
  },
  /**
   * A provider-owned component's install/retry — the Higgsfield CLI beside its sign-in.
   * Providers owns the credential a tool exists for, so it owns the tool (SPEC-033 R-1), and
   * Engines deliberately does not list it; a component remedy routed there would land on a
   * pane with no matching row.
   */
  "provider-tool-install": {
    label: "Install",
    place: "Settings · Providers",
    route: "/settings/providers",
    targetParam: "provider",
  },
  /** Resume a paused provider lane — the message is the explicit confirmation (SPEC-009 D7). */
  "queue-resume": {
    label: "Resume",
    place: "Activity · Needs you",
    route: "/activity",
  },
  /**
   * Runs hardware detection on demand — the control `unmeasured` names (§2.2, SPEC-033 R-58).
   *
   * The row it names appears in every engine pane that asks a fit question, so the route names a
   * concrete one rather than landing on whichever pane happens to open (SPEC-034 R-13, R-24).
   * Ollama, not ComfyUI: a ComfyUI resolved to a URL has no fit question and draws no such row,
   * and `hardware-unmeasured` fires exactly when nothing has probed — so that pairing could send
   * a reader to the one pane with no Measure button on it.
   */
  "runtime-detect": {
    label: "Measure",
    place: "Settings · Providers · Ollama",
    route: "/settings/providers?provider=ollama",
  },
} as const satisfies Record<
  string,
  { label: string; place: string; route: string; targetParam?: string }
>;

export type ControlId = keyof typeof CONTROL_REGISTRY;
export const CONTROL_IDS = Object.keys(CONTROL_REGISTRY) as [ControlId, ...ControlId[]];

// ---------------------------------------------------------------------------
// Finding kinds and declared subsumption (R-1, R-8, D3)
// ---------------------------------------------------------------------------

/**
 * Subsumption is declared, never inferred (R-8): nothing in the data says a full drive explains
 * a disabled recipe — only the rule that made the join knows, so the relation is stated here,
 * beside the kind that owns it. A finding may be suppressed from primary presentation only when
 * a finding of a kind that declares it references it as a consequence in the same snapshot.
 */
export const FINDING_KINDS = {
  /** R-20.1 — non-terminal jobs frozen against the resolved engine while it is not ready. */
  "work-held-by-engine": { subsumes: [] },
  /** R-20.2 — a queue lane paused on a credential with work held behind it. */
  "queue-paused-credential": { subsumes: [] },
  /** R-20.3/R-20.4 — a component the user asked for that the volume cannot hold. */
  "component-disk-short": { subsumes: ["comfyui-recipe-disabled"] },
  /** R-20.5 — a recipe's weight files were never fetched; the download is on offer. */
  "comfyui-recipe-weights-missing": { subsumes: ["comfyui-recipe-disabled"] },
  /** R-20.6 — a pinned file is present and its bytes are wrong; only repair answers that. */
  "comfyui-recipe-digest-mismatch": { subsumes: ["comfyui-recipe-disabled"] },
  /** R-20.7 — the engine is absent, unreachable, incompatible or failed. */
  "comfyui-engine-unavailable": { subsumes: ["comfyui-recipe-disabled"] },
  /** R-20.8 — a URL engine with no mapped models folder, where recipes need files. */
  "comfyui-models-folder-unmapped": { subsumes: ["comfyui-recipe-disabled"] },
  /** The consequence node (R-9): one per disabled recipe, referenced by every cause. */
  "comfyui-recipe-disabled": { subsumes: [] },
  /** R-22 — a component in transit is not a fault; it is stated only where something waits on it. */
  "waiting-on-component": { subsumes: [] },
  /** R-4 — hardware detection was never requested this session. */
  "hardware-unmeasured": { subsumes: [] },
  /** R-4 — hardware detection ran and a probe failed. */
  "hardware-unknown": { subsumes: [] },
  /** R-20.9 — three or more faults for one provider inside the window (#555). */
  "provider-repeated-faults": { subsumes: [] },
  /** R-20.10 — the trailing seven days materially above the seven before (#555). */
  "spend-above-previous": { subsumes: [] },
  /** R-21 — a required correlation whose inputs could not be read. */
  "correlation-unavailable": { subsumes: [] },
  /** R-14 — the reserved kind: a rule threw, costing that finding and no other. */
  "rule-failed": { subsumes: [] },
} as const satisfies Record<string, { subsumes: readonly string[] }>;

export type FindingKind = keyof typeof FINDING_KINDS;
export const FINDING_KIND_IDS = Object.keys(FINDING_KINDS) as [FindingKind, ...FindingKind[]];

// ---------------------------------------------------------------------------
// The finding (R-2, R-6, R-7)
// ---------------------------------------------------------------------------

/**
 * A measured fact: the value as measured, the published field it was read from, and the instant
 * it was measured. Live state has no instant of its own — reading it *is* the measurement — so
 * those facts carry the derivation instant; recorded instants (`checkedAt`, `detectedAt`) are
 * carried as recorded. Formatting happens at the surface, never here (R-7).
 */
export const FindingFactSchema = z
  .object({
    name: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    source: z.string().min(1),
    measuredAt: IsoDateTimeSchema,
  })
  .strict();
export type FindingFact = z.infer<typeof FindingFactSchema>;

export const FindingCauseSchema = z
  .object({
    /** One clause naming the specific thing observed — the subsystem's own words where it has them. */
    statement: z.string().min(1),
    /**
     * R-6: the subsystem's own reason was itself generic. The finding carries it anyway, says
     * so, and names the specification that owes a better one. Never a cause more specific than
     * was measured.
     */
    upstreamGeneric: z.string().min(1).optional(),
    /** R-13: redaction altered the carried reason, and the finding says so. */
    redacted: z.boolean().optional(),
  })
  .strict();
export type FindingCause = z.infer<typeof FindingCauseSchema>;

export const FindingRemedySchema = z
  .object({
    control: z.enum(CONTROL_IDS),
    /** What the control acts on — a component id, provider id or recipe id (§1.8-safe). */
    target: z.string().min(1).optional(),
  })
  .strict();
export type FindingRemedy = z.infer<typeof FindingRemedySchema>;

/** R-25: what both surfaces say for a remedy of `null` — stated once, rendered anywhere. */
export const REMEDY_ABSENT_STATEMENT = "No control resolves this.";

/**
 * What a surface states about a null remedy. A suppressed consequence resolves through the
 * cause it is rendered under, so it gets no line at all; a primary finding with no control
 * gets R-25's stated absence. Both surfaces use this so neither can misread the `null`.
 */
export function remedyAbsenceStatement(
  snapshot: Pick<DiagnosticsSnapshot, "findings">,
  finding: Finding,
): string | null {
  if (finding.remedy !== null) return null;
  return suppressedRefs(snapshot).has(findingRef(finding)) ? null : REMEDY_ABSENT_STATEMENT;
}

export const FindingSchema = z
  .object({
    kind: z.enum(FINDING_KIND_IDS),
    /**
     * Distinguishes findings of one kind from each other (R-1): a component id, provider id,
     * recipe id or opaque instance digest — only values §1.8 permits a record to carry.
     */
    occurrence: z.string().min(1),
    severity: FindingSeveritySchema,
    /** A label, not a sentence — the house rule for screens applies to the title it renders. */
    title: z.string().min(1),
    facts: z.array(FindingFactSchema),
    cause: FindingCauseSchema,
    /** The control that resolves it, or `null` — the explicit absence R-25 requires. */
    remedy: FindingRemedySchema.nullable(),
    /** A clause the rule itself owes: "a retry will not resolve this", "dispatch is permitted". */
    note: z.string().min(1).optional(),
    /** Refs (`kind:occurrence`) of consequence findings this one explains (R-9). */
    consequences: z.array(z.string()).default([]),
    /**
     * R-16: facts older than the staleness bound, named, with the existing control that
     * re-measures them. The snapshot never re-measures anything itself (R-11).
     */
    stale: z
      .object({
        facts: z.array(z.string().min(1)).min(1),
        remeasure: FindingRemedySchema.nullable(),
      })
      .strict()
      .optional(),
    /** When this occurrence first became true this session (R-35), from `previous` (R-11). */
    firstSeen: IsoDateTimeSchema,
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

/** The address a consequence edge points at. Compared, never parsed back apart. */
export function findingRef(finding: Pick<Finding, "kind" | "occurrence">): string {
  return `${finding.kind}:${finding.occurrence}`;
}

// ---------------------------------------------------------------------------
// The snapshot (R-10, R-14, R-19, R-35)
// ---------------------------------------------------------------------------

export const DiagnosticsSourceStateSchema = z.enum([
  /** The source was read. */
  "read",
  /** The source exists and could not be read — dependents become `unknown` (R-14). */
  "unavailable",
  /** The source is legitimately absent — never a fault, and never `unknown` (R-19, R-21). */
  "absent",
]);
export type DiagnosticsSourceState = z.infer<typeof DiagnosticsSourceStateSchema>;

export const DiagnosticsSnapshotSchema = z
  .object({
    derivedAt: IsoDateTimeSchema,
    findings: z.array(FindingSchema),
    /** The rules that ran, so the absence of findings is a stated result (R-10). */
    checked: z.array(z.string()),
    /** Each source consulted, with whether it was read, unreadable, or legitimately absent. */
    sources: z.array(
      z.object({ name: z.string().min(1), state: DiagnosticsSourceStateSchema }).strict(),
    ),
  })
  .strict();
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshotSchema>;

/**
 * Primary presentation (R-8, R-36): a finding is suppressed only when a present finding whose
 * kind declares its kind references it as a consequence. Suppressed findings stay in the
 * snapshot, reachable from every finding that subsumes them.
 */
export function suppressedRefs(snapshot: Pick<DiagnosticsSnapshot, "findings">): Set<string> {
  const suppressed = new Set<string>();
  const byRef = new Map(snapshot.findings.map((f) => [findingRef(f), f]));
  for (const finding of snapshot.findings) {
    const declared: readonly string[] = FINDING_KINDS[finding.kind].subsumes;
    for (const ref of finding.consequences) {
      const consequence = byRef.get(ref);
      if (consequence && declared.includes(consequence.kind)) suppressed.add(ref);
    }
  }
  return suppressed;
}

/** Findings in severity order with suppressed consequences removed — the view's primary list. */
export function primaryFindings(snapshot: Pick<DiagnosticsSnapshot, "findings">): Finding[] {
  const suppressed = suppressedRefs(snapshot);
  return snapshot.findings.filter((f) => !suppressed.has(findingRef(f)));
}

/** The consequence findings one cause explains, in snapshot order. */
export function consequencesOf(
  snapshot: Pick<DiagnosticsSnapshot, "findings">,
  cause: Finding,
): Finding[] {
  const wanted = new Set(cause.consequences);
  return snapshot.findings.filter((f) => wanted.has(findingRef(f)));
}

// ---------------------------------------------------------------------------
// What the derivation reads (R-17)
// ---------------------------------------------------------------------------

/**
 * Exactly R-17's list, and nothing else, enforced by shape: a rule cannot reach the provider-call
 * record, a world, or any published field outside the list, because the input never carries them
 * (matrix row 49). The caller projects with `diagnosticsSources`.
 */
export type DiagnosticsSources = Pick<
  ClientState["app"],
  | "version"
  | "health"
  | "env"
  | "runtime"
  | "harness"
  | "harnessInfo"
  | "setup"
  | "comfyui"
  | "voiceRuntime"
  | "queues"
  | "jobs"
  | "providers"
  | "providerTools"
  | "manifest"
  | "routing"
  | "models"
  | "spend"
  | "ledger"
  | "ledgerUnavailable"
  | "drift"
  | "builds"
  | "update"
>;

export function diagnosticsSources(app: ClientState["app"]): DiagnosticsSources {
  return {
    version: app.version,
    health: app.health,
    env: app.env,
    runtime: app.runtime,
    harness: app.harness,
    harnessInfo: app.harnessInfo,
    setup: app.setup,
    comfyui: app.comfyui,
    voiceRuntime: app.voiceRuntime,
    queues: app.queues,
    jobs: app.jobs,
    providers: app.providers,
    providerTools: app.providerTools,
    manifest: app.manifest,
    routing: app.routing,
    models: app.models,
    spend: app.spend,
    ledger: app.ledger,
    ledgerUnavailable: app.ledgerUnavailable,
    drift: app.drift,
    builds: app.builds,
    update: app.update,
  };
}

/**
 * The bounded log tails the derivation is given (R-11). It reads no file itself; the caller
 * reads them, bounded at R-18's 500 records, and says when a read failed rather than passing
 * an empty tail that would be indistinguishable from a quiet log (R-19).
 *
 * Records are parsed lines of `app.jsonl`, oldest first. #554 defines the seam; #555's two
 * windowed correlations are what read it.
 */
export type DiagnosticsTails = {
  appLog: ReadonlyArray<Record<string, unknown>> | "unavailable";
};

/**
 * The redaction seam (R-13, R-29): free text quoted from a subsystem passes through here before
 * it is admitted to a finding, and the finding records when it was altered. Injected because the
 * secret registry lives with the coordinator; identity for callers with nothing to scrub.
 */
export interface RedactionBoundary {
  scrub(text: string): string;
}

const IDENTITY_BOUNDARY: RedactionBoundary = { scrub: (text) => text };

export interface DeriveDiagnosticsInput {
  sources: DiagnosticsSources;
  tails: DiagnosticsTails;
  previous: DiagnosticsSnapshot | null;
  /** The derivation instant — an input, so identical inputs give an identical snapshot (R-11). */
  now: string;
  boundary?: RedactionBoundary;
}

// ---------------------------------------------------------------------------
// Derivation (R-11..R-16, R-20..R-22)
// ---------------------------------------------------------------------------

/** R-16, stated by SPEC-032 D13: a fact older than this owes its age and the re-measure control. */
export const STALE_FACT_MS = 15 * 60 * 1000;

/** Terminal job states; everything else is work the queue still owes an outcome (R-20.1). */
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Engine states that hold work and disable recipes (R-20.7). `starting` is deliberately not
 * here: a component in a transient state is not a fault (R-22), and work queued behind a warming
 * engine is the queue doing its job.
 */
const ENGINE_DOWN_STATES = new Set(["absent", "unreachable", "incompatible", "failed"]);

interface RuleContext {
  sources: DiagnosticsSources;
  tails: DiagnosticsTails;
  now: string;
  boundary: RedactionBoundary;
}

/** A finding before the derivation stamps `firstSeen` from the previous snapshot. */
type DraftFinding = Omit<Finding, "firstSeen">;

interface Rule {
  /** The rule's name in `checked` — its primary kind, which is also what `rule-failed` names. */
  kind: FindingKind;
  run(ctx: RuleContext): DraftFinding[];
}

/** Carry a subsystem's stated reason across the redaction boundary (R-13, D7). */
function carriedCause(
  boundary: RedactionBoundary,
  statement: string,
  upstreamGeneric?: string,
): FindingCause {
  const scrubbed = boundary.scrub(statement);
  return {
    statement: scrubbed,
    ...(upstreamGeneric !== undefined ? { upstreamGeneric } : {}),
    ...(scrubbed !== statement ? { redacted: true } : {}),
  };
}

/** R-16: name the facts older than the bound, with the control that re-measures them. */
function staleOf(
  facts: readonly FindingFact[],
  now: string,
  remeasure: FindingRemedy | null,
): Pick<Finding, "stale"> {
  const bound = Date.parse(now) - STALE_FACT_MS;
  const staleNames = facts
    .filter((f) => {
      const at = Date.parse(f.measuredAt);
      return Number.isFinite(at) && at < bound;
    })
    .map((f) => f.name);
  return staleNames.length > 0 ? { stale: { facts: staleNames, remeasure } } : {};
}

/**
 * The consequence node for a disabled recipe (R-9): a finding in its own right, appearing once
 * however many causes reference it. Its cause is the recipe's own stated reason, so it can
 * never disagree with the Engines row that shows the same fact (R-13).
 */
function recipeConsequence(
  ctx: RuleContext,
  recipe: { recipeId: string; displayName: string; reason?: string },
  checkedAt: string,
): DraftFinding {
  return {
    kind: "comfyui-recipe-disabled",
    occurrence: recipe.recipeId,
    severity: "degraded",
    title: `${recipe.displayName} · disabled`,
    facts: [
      { name: "recipe", value: recipe.recipeId, source: "app.comfyui.recipes", measuredAt: checkedAt },
      { name: "state", value: "disabled", source: "app.comfyui.recipes", measuredAt: checkedAt },
    ],
    cause: carriedCause(ctx.boundary, recipe.reason ?? "disabled"),
    // The causes carry the controls; a consequence is rendered under the cause that explains it,
    // so `null` here is "resolved through the cause", not R-25's "no control exists".
    remedy: null,
    consequences: [],
  };
}

/** R-20.1 — work against a dead engine. Cause is the engine; the held work is a count. */
const workHeldByEngine: Rule = {
  kind: "work-held-by-engine",
  run(ctx) {
    const comfyui = ctx.sources.comfyui;
    if (comfyui === null) return [];
    const engine = comfyui.engine;
    if (engine.instanceId === null || !ENGINE_DOWN_STATES.has(engine.state)) return [];
    const held = ctx.sources.jobs.filter(
      (job) =>
        job.deletedAt === undefined &&
        !TERMINAL_JOB_STATES.has(job.status) &&
        job.status !== "needs-reconciliation" &&
        job.engine?.instanceId === engine.instanceId,
    );
    if (held.length === 0) return [];
    const facts: FindingFact[] = [
      { name: "held-jobs", value: held.length, source: "app.jobs", measuredAt: ctx.now },
      { name: "engine-state", value: engine.state, source: "app.comfyui.engine", measuredAt: comfyui.checkedAt },
    ];
    return [
      {
        kind: "work-held-by-engine",
        occurrence: engine.instanceId,
        severity: "blocking",
        title: `${held.length} local job${held.length === 1 ? "" : "s"} held · engine ${engine.state}`,
        facts,
        // A state that owes a reason and gave none is an upstream-generic cause (R-6):
        // carried as it is, marked, naming the specification that owes a better one.
        cause:
          engine.detail !== null
            ? carriedCause(ctx.boundary, engine.detail)
            : carriedCause(ctx.boundary, `the engine is ${engine.state}`, "SPEC-021"),
        // Restart acts on a spawned engine; nothing acts on somebody else's URL engine (R-25).
        remedy: engine.source === "user-url" ? null : { control: "comfyui-restart" },
        consequences: [],
        ...staleOf(facts, ctx.now, { control: "comfyui-refresh" }),
      },
    ];
  },
};

/** R-20.2 — a lane paused on a credential. Cause is the credential; the held count rides as a fact. */
const queuePausedCredential: Rule = {
  kind: "queue-paused-credential",
  run(ctx) {
    return ctx.sources.queues
      .filter((lane) => lane.paused && lane.pauseKind === "credential" && lane.held > 0)
      .map((lane) => ({
        kind: "queue-paused-credential" as const,
        occurrence: lane.provider,
        severity: "blocking" as const,
        title: `${lane.provider} lane paused · ${lane.held} held`,
        facts: [
          { name: "provider", value: lane.provider, source: "app.queues", measuredAt: ctx.now },
          { name: "held-jobs", value: lane.held, source: "app.queues", measuredAt: ctx.now },
        ],
        cause: carriedCause(ctx.boundary, lane.reason ?? "no credential is stored for this provider"),
        remedy: { control: "provider-key" as const, target: lane.provider },
        // Resuming is a deliberate second act (SPEC-009 D7: the message IS the confirmation),
        // so a saved key alone leaves the lane paused — said here, with where.
        note: "After a new key, the lane resumes from Activity · Needs you.",
        consequences: [],
      }));
  },
};

/**
 * R-20.3 and R-20.4 — anything the user asked for that the volume cannot hold. One rule, one
 * vocabulary: the recipe case differs only in carrying its disabled recipe as a consequence.
 * The blocked component's own sentence already states the volume and both figures; the finding
 * carries it rather than recomputing figures that could disagree with the screen (R-13).
 */
const componentDiskShort: Rule = {
  kind: "component-disk-short",
  run(ctx) {
    const setup = ctx.sources.setup;
    if (setup === null) return [];
    const findings: DraftFinding[] = [];
    for (const component of setup.components) {
      if (component.state !== "blocked" || component.blockedBy !== "disk") continue;
      // The guard's own figures and instant. `setup.diskFreeMb` is the app volume's number, and
      // a finding naming a mapped D: while quoting C:'s free space is the fact/screen
      // disagreement R-13 forbids.
      const blockedAt = component.blockedAt ?? ctx.now;
      const facts: FindingFact[] = [
        { name: "component", value: component.id, source: "app.setup.components", measuredAt: ctx.now },
        {
          name: "needs-mb",
          value: component.blockedNeedMb ?? component.installedMb ?? component.sizeMb,
          source: "app.setup.components",
          measuredAt: blockedAt,
        },
        ...(component.blockedVolumeRoot !== undefined
          ? [{ name: "volume", value: component.blockedVolumeRoot, source: "app.setup.components", measuredAt: blockedAt }]
          : []),
        ...(component.blockedFreeMb !== undefined
          ? [{ name: "volume-free-mb", value: component.blockedFreeMb, source: "app.setup.components", measuredAt: blockedAt }]
          : []),
      ];
      const consequences: string[] = [];
      const recipeId = comfyUiWeightsRecipeId(component.id);
      if (recipeId !== null) {
        const disabled = ctx.sources.comfyui?.recipes.find(
          (r) => r.recipeId === recipeId && r.state === "disabled",
        );
        if (disabled) {
          consequences.push(`comfyui-recipe-disabled:${recipeId}`);
          // An edge must point at a node in the same snapshot (R-9): when this is the only
          // cause standing, no other rule will have emitted it.
          findings.push(recipeConsequence(ctx, disabled, ctx.sources.comfyui!.checkedAt));
        }
      }
      // A provider-owned component is stated on Providers beside its sign-in, and Engines
      // deliberately does not list it — the remedy goes where the row is (SPEC-033 R-1).
      const retry: FindingRemedy =
        component.provider !== undefined
          ? { control: "provider-tool-install", target: component.provider }
          : { control: "component-retry", target: component.id };
      findings.push({
        kind: "component-disk-short",
        occurrence: component.id,
        severity: "blocking",
        title: `${component.displayName} · disk short`,
        facts,
        cause: carriedCause(ctx.boundary, component.detail ?? "the volume cannot hold this download"),
        // Retry is the row's own control and re-runs the disk guard; nothing in the product
        // frees space, so this is the control that resolves the finding once the person has.
        remedy: retry,
        consequences,
        ...staleOf(facts, ctx.now, retry),
      });
    }
    return findings;
  },
};

/** The weights component feeding one recipe, by the id contract both sides already share. */
function weightsComponentFor(ctx: RuleContext, recipeId: string) {
  return ctx.sources.setup?.components.find((c) => c.id === comfyUiWeightsComponentId(recipeId));
}

/** R-20.5 — a recipe short of files, with the weight component on offer. Remedy is its download. */
const recipeWeightsMissing: Rule = {
  kind: "comfyui-recipe-weights-missing",
  run(ctx) {
    const comfyui = ctx.sources.comfyui;
    if (comfyui === null) return [];
    const findings: DraftFinding[] = [];
    for (const recipe of comfyui.recipes) {
      if (recipe.state !== "disabled" || recipe.reasonKind !== "files") continue;
      const weights = weightsComponentFor(ctx, recipe.recipeId);
      // Blocked weights are the disk rule's join; failed ones have their own row. This rule is
      // for files never fetched — offered, or skipped and still on offer.
      if (weights === undefined || (weights.state !== "available" && weights.state !== "skipped")) continue;
      const facts: FindingFact[] = [
        { name: "recipe", value: recipe.recipeId, source: "app.comfyui.recipes", measuredAt: comfyui.checkedAt },
        { name: "component", value: weights.id, source: "app.setup.components", measuredAt: ctx.now },
        { name: "download-mb", value: weights.sizeMb, source: "app.setup.components", measuredAt: ctx.now },
      ];
      findings.push({
        kind: "comfyui-recipe-weights-missing",
        occurrence: recipe.recipeId,
        severity: "degraded",
        title: `${recipe.displayName} · model files missing`,
        facts,
        cause: carriedCause(ctx.boundary, recipe.reason ?? "model files are missing"),
        // The row's own control for the state: Download is drawn for `available`, Retry for
        // `skipped` — a remedy naming a button the row does not draw is a false promise.
        remedy: {
          control: weights.state === "skipped" ? "component-retry" : "component-download",
          target: weights.id,
        },
        consequences: [`comfyui-recipe-disabled:${recipe.recipeId}`],
        ...staleOf(facts, ctx.now, { control: "comfyui-refresh" }),
      });
      findings.push(recipeConsequence(ctx, recipe, comfyui.checkedAt));
    }
    return findings;
  },
};

/** R-20.6 — a failed digest: the file is present and wrong, which a retry cannot resolve. */
const recipeDigestMismatch: Rule = {
  kind: "comfyui-recipe-digest-mismatch",
  run(ctx) {
    const comfyui = ctx.sources.comfyui;
    if (comfyui === null) return [];
    const findings: DraftFinding[] = [];
    for (const recipe of comfyui.recipes) {
      if (recipe.state !== "disabled" || recipe.reasonKind !== "digest") continue;
      const weights = weightsComponentFor(ctx, recipe.recipeId);
      const facts: FindingFact[] = [
        { name: "recipe", value: recipe.recipeId, source: "app.comfyui.recipes", measuredAt: comfyui.checkedAt },
      ];
      findings.push({
        kind: "comfyui-recipe-digest-mismatch",
        occurrence: recipe.recipeId,
        severity: "degraded",
        title: `${recipe.displayName} · file failed verification`,
        // The carried reason names the file and both digests (SPEC-021 §2.5) — never paraphrased.
        cause: carriedCause(ctx.boundary, recipe.reason ?? "a pinned file does not match its digest"),
        facts,
        remedy: weights !== undefined ? { control: "component-repair", target: weights.id } : { control: "component-repair" },
        note: "A retry will not resolve this; repair re-downloads the file.",
        consequences: [`comfyui-recipe-disabled:${recipe.recipeId}`],
        ...staleOf(facts, ctx.now, { control: "comfyui-refresh" }),
      });
      findings.push(recipeConsequence(ctx, recipe, comfyui.checkedAt));
    }
    return findings;
  },
};

/** R-20.7 — an engine that is down, subsuming every recipe it disables. */
const engineUnavailable: Rule = {
  kind: "comfyui-engine-unavailable",
  run(ctx) {
    const comfyui = ctx.sources.comfyui;
    if (comfyui === null) return [];
    const engine = comfyui.engine;
    if (!ENGINE_DOWN_STATES.has(engine.state)) return [];
    // An absent engine whose managed runtime is already on its way is a component in a
    // transient state, not a fault (R-22): the finding would advertise a Download the Engines
    // pane has already disabled as installing. The waiting-on-component rule states the
    // transit where something waits on it.
    const managedInTransit = ctx.sources.setup?.components.some(
      (c) =>
        c.id === "comfyui-runtime" &&
        (c.state === "queued" || c.state === "downloading" || c.state === "paused" || c.state === "installing"),
    );
    if (engine.state === "absent" && managedInTransit === true) return [];
    const disabled = comfyui.recipes.filter(
      (r) => r.state === "disabled" && r.reasonKind === "engine",
    );
    const facts: FindingFact[] = [
      { name: "engine-state", value: engine.state, source: "app.comfyui.engine", measuredAt: comfyui.checkedAt },
      { name: "source", value: engine.source, source: "app.comfyui.engine", measuredAt: comfyui.checkedAt },
      { name: "disabled-recipes", value: disabled.length, source: "app.comfyui.recipes", measuredAt: comfyui.checkedAt },
    ];
    // An engine nobody has configured is a choice on offer, not a fault; one that was set up
    // and is not answering is a lost capability (D5's line between advisory and degraded).
    const severity: FindingSeverity = engine.state === "absent" ? "advisory" : "degraded";
    const managedRuntime = ctx.sources.setup?.components.find((c) => c.id === "comfyui-runtime");
    // Restart acts on a spawned engine. Nothing in the product can start or update somebody
    // else's URL engine — Refresh only re-reads, which is the stale-fact re-measure's job, not
    // a resolving control — so a dead URL engine carries R-25's stated absence instead.
    const remedy: FindingRemedy | null =
      engine.state === "absent"
        ? managedRuntime !== undefined
          ? { control: "component-download", target: managedRuntime.id }
          : null
        : engine.source === "user-url"
          ? null
          : { control: "comfyui-restart" };
    return [
      {
        kind: "comfyui-engine-unavailable",
        occurrence: engine.instanceId ?? "none",
        severity,
        title: `ComfyUI engine · ${engine.state}`,
        facts,
        cause:
          engine.detail !== null
            ? carriedCause(ctx.boundary, engine.detail)
            : engine.state === "absent"
              ? carriedCause(ctx.boundary, "no ComfyUI engine is configured or installed")
              : carriedCause(ctx.boundary, `the engine is ${engine.state}`, "SPEC-021"),
        remedy,
        consequences: disabled.map((r) => `comfyui-recipe-disabled:${r.recipeId}`),
        ...staleOf(facts, ctx.now, { control: "comfyui-refresh" }),
      },
      ...disabled.map((r) => recipeConsequence(ctx, r, comfyui.checkedAt)),
    ];
  },
};

/** R-20.8 — a URL engine with no mapped models folder: a limit of a non-managed engine. */
const modelsFolderUnmapped: Rule = {
  kind: "comfyui-models-folder-unmapped",
  run(ctx) {
    const comfyui = ctx.sources.comfyui;
    if (comfyui === null || comfyui.engine.source !== "user-url") return [];
    const affected = comfyui.recipes.filter(
      (r) => r.state === "disabled" && r.reasonKind === "models-folder",
    );
    if (affected.length === 0) return [];
    const facts: FindingFact[] = [
      { name: "source", value: "user-url", source: "app.comfyui.engine", measuredAt: comfyui.checkedAt },
      { name: "recipes-needing-files", value: affected.length, source: "app.comfyui.recipes", measuredAt: comfyui.checkedAt },
    ];
    return [
      {
        kind: "comfyui-models-folder-unmapped",
        occurrence: comfyui.engine.instanceId ?? "user-url",
        severity: "advisory",
        title: "Models folder · not mapped",
        facts,
        cause: carriedCause(
          ctx.boundary,
          affected[0]!.reason ?? "Arke cannot verify this engine's files without a mapped models folder",
        ),
        remedy: { control: "comfyui-map-models-folder" },
        note: "A limit of a non-managed engine, not a fault.",
        consequences: affected.map((r) => `comfyui-recipe-disabled:${r.recipeId}`),
        ...staleOf(facts, ctx.now, { control: "comfyui-refresh" }),
      },
      ...affected.map((r) => recipeConsequence(ctx, r, comfyui.checkedAt)),
    ];
  },
};

/**
 * R-4 — the hardware facts. `unmeasured` when nobody asked (the common case, §2.2), `unknown`
 * when detection ran and a probe failed. Both state that dispatch remains permitted
 * (SPEC-021 D15); neither softens a known failure.
 */
const hardwareFacts: Rule = {
  kind: "hardware-unmeasured",
  run(ctx) {
    const runtime = ctx.sources.runtime;
    if (runtime === null) {
      return [
        {
          kind: "hardware-unmeasured",
          occurrence: "local-runtime",
          severity: "unmeasured",
          title: "Hardware · not measured",
          facts: [{ name: "local-runtime", value: null, source: "app.runtime", measuredAt: ctx.now }],
          cause: { statement: "detection has not been requested this session" },
          remedy: { control: "runtime-detect" },
          note: "Dispatch remains permitted.",
          consequences: [],
        },
      ];
    }
    const probes = runtime.probes;
    const failed = (
      [
        ["vram-mb", probes.vramMb],
        ["mem-mb", probes.memMb],
        ["disk-free-mb", probes.diskFreeMb],
      ] as const
    ).filter(([, value]) => value === null);
    if (failed.length === 0) return [];
    const facts: FindingFact[] = failed.map(([name]) => ({
      name,
      value: null,
      source: "app.runtime.probes",
      measuredAt: runtime.detectedAt,
    }));
    return [
      {
        kind: "hardware-unknown",
        occurrence: "local-runtime",
        severity: "unknown",
        title: "Hardware · probe failed",
        facts,
        cause: {
          statement: `detection ran and ${failed.map(([name]) => name).join(", ")} could not be measured`,
        },
        remedy: { control: "runtime-detect" },
        note: "Dispatch remains permitted.",
        consequences: [],
        ...staleOf(facts, ctx.now, { control: "runtime-detect" }),
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// The windowed correlations (R-20.9, R-20.10) — the two joins over the log and the ledger
// ---------------------------------------------------------------------------

/** R-18: the derivation's log tail bound — a property of the derivation, never a caller argument. */
export const DIAGNOSTICS_LOG_TAIL_RECORDS = 500;

/** R-20.9, D13: three or more faults for one provider inside fifteen minutes. */
export const PROVIDER_FAULT_THRESHOLD = 3;
export const PROVIDER_FAULT_WINDOW_MS = 15 * 60 * 1000;

/** R-20.10, D13: seven trailing days against the seven before, fifty per cent and a floor. */
export const SPEND_PERIOD_DAYS = 7;
export const SPEND_RISE_FRACTION = 0.5;
export const SPEND_RISE_FLOOR_MICRO_USD = 1_000_000;

/**
 * R-21's unknown, in one spelling: a correlation whose input could not be read states what is
 * missing, never a silent skip that would read as a clean bill. Shared so the windowed rules
 * (and any later one) cannot drift apart on what an unavailable input states.
 */
function correlationUnavailable(
  occurrence: FindingKind,
  title: string,
  missingInput: string,
  statement: string,
  now: string,
): DraftFinding {
  return {
    kind: "correlation-unavailable",
    occurrence,
    severity: "unknown",
    title,
    facts: [{ name: "missing-input", value: missingInput, source: "derivation", measuredAt: now }],
    cause: { statement },
    remedy: null,
    consequences: [],
  };
}

/**
 * R-20.9 — repeated provider faults, counted from the operational log tail. One finding per
 * provider carrying the count and the window, never one per fault. The provider-call record is
 * deliberately not a source (R-17): the fault count comes from the log alone.
 */
const providerRepeatedFaults: Rule = {
  kind: "provider-repeated-faults",
  run(ctx) {
    if (ctx.tails.appLog === "unavailable") {
      return [
        correlationUnavailable(
          "provider-repeated-faults",
          "Provider faults · not countable",
          "log.app",
          "the operational log could not be read",
          ctx.now,
        ),
      ];
    }
    const nowMs = Date.parse(ctx.now);
    const cutoff = nowMs - PROVIDER_FAULT_WINDOW_MS;
    const byProvider = new Map<string, { count: number; last?: string; category?: "auth" | "billing" }>();
    for (const record of ctx.tails.appLog) {
      if (record["kind"] !== "provider.fault") continue;
      const provider = record["provider"];
      const at = record["at"];
      if (typeof provider !== "string" || provider.length === 0 || typeof at !== "string") continue;
      const instant = Date.parse(at);
      // The window is measured backwards from the derivation instant (matrix row 11): a fault
      // sixteen minutes old does not count however many neighbours it has — and a record dated
      // AFTER the instant (a clock corrected backwards) is not in the window either, or it
      // would count until the clock caught up with it.
      if (!Number.isFinite(instant) || instant < cutoff || instant > nowMs) continue;
      const entry = byProvider.get(provider) ?? { count: 0 };
      entry.count += 1;
      const message = record["message"];
      if (typeof message === "string" && message.length > 0) {
        entry.last = message;
        const stamped = record["category"];
        entry.category =
          stamped === "auth" || stamped === "billing" ? stamped : providerFaultCategory(message);
      }
      byProvider.set(provider, entry);
    }
    const findings: DraftFinding[] = [];
    for (const [provider, { count, last, category }] of byProvider) {
      if (count < PROVIDER_FAULT_THRESHOLD) continue;
      findings.push({
        kind: "provider-repeated-faults",
        occurrence: provider,
        severity: "degraded",
        title: `${provider} · ${count} faults · 15 min`,
        facts: [
          { name: "provider", value: provider, source: "log.app", measuredAt: ctx.now },
          { name: "fault-count", value: count, source: "log.app", measuredAt: ctx.now },
          { name: "window-minutes", value: PROVIDER_FAULT_WINDOW_MS / 60_000, source: "derivation", measuredAt: ctx.now },
        ],
        // The most recent fault's own words, already redacted at the log boundary and scrubbed
        // again here — the specific thing observed, not a summary of it (R-6).
        cause:
          last !== undefined
            ? carriedCause(ctx.boundary, last)
            : { statement: `${count} provider faults inside the window` },
        // A provider.fault record is credential-or-billing class by construction (the queue's
        // classifier admits 401/403/402/quota/billing and nothing else) — but the control that
        // answers it depends on which half, and on where the credential lives: a key row for a
        // stored one, the sign-in for a tool-held one, nothing for a keyless runtime, and
        // nothing for billing — a replaced key does not refill a quota (R-25).
        remedy: providerCredentialRemedy(provider, category ?? "auth"),
        consequences: [],
      });
    }
    return findings;
  },
};

/**
 * Which half of the fault class a provider.fault record is (SPEC-032 R-20.9): the queue's
 * classifier admits authentication AND billing shapes into one class, and only the first has a
 * control that resolves it — a replaced key does not refill a quota. One spelling, used by the
 * log producer to stamp records and by the rule as the fallback for records that predate the
 * stamp, so the two can never classify one message differently.
 */
export function providerFaultCategory(message: string): "auth" | "billing" {
  return /(quota exhaust|billing|payment required|HTTP 402)/i.test(message) ? "billing" : "auth";
}

/** The control that answers an authentication fault, by where the credential lives (R-25). */
function providerCredentialRemedy(provider: string, category: "auth" | "billing"): FindingRemedy | null {
  // No control refills an account; the finding says so rather than pointing at a key row the
  // condition would survive (R-25).
  if (category === "billing") return null;
  const kind = (PROVIDERS as Partial<Record<ProviderId, { credential: string }>>)[provider as ProviderId]?.credential;
  if (kind === "in-app") return { control: "provider-key", target: provider };
  if (kind === "external") return { control: "provider-sign-in", target: provider };
  return null;
}

/**
 * The ledger as the spend correlation may see it (R-30): when, what model, what it cost.
 * Ledger entries carry a world and production identifier, and this projection is where they
 * are dropped — a spend finding is about money and models, never about what was being made.
 * The accounting mirrors `rollingSpend` (SPEC-008 R-19): actual where recorded, estimate
 * otherwise, so this figure and the Spend screen's can never rest on different arithmetic.
 */
export function spendProjection(
  ledger: DiagnosticsSources["ledger"],
): Array<{ ts: number; model: string; microUsd: number }> {
  return ledger.map((entry) => ({
    ts: Date.parse(entry.ts),
    model: entry.model,
    microUsd: entry.actualMicroUsd ?? entry.estimatedMicroUsd,
  }));
}

/**
 * R-20.10 — the trailing seven days against the seven before. Advisory when the later period
 * exceeds the earlier by both fifty per cent and the floor — the floor being what stops a
 * rounding difference on a quiet fortnight reading as a trend.
 */
const spendAbovePrevious: Rule = {
  kind: "spend-above-previous",
  run(ctx) {
    // R-21: a ledger that exists and could not be read is not an empty ledger. The read model
    // publishes the failed read (`ledgerUnavailable`), and the correlation answers unknown
    // rather than comparing two windows of nothing and reporting a clean fortnight.
    if (ctx.sources.ledgerUnavailable) {
      return [
        correlationUnavailable(
          "spend-above-previous",
          "Spend · not comparable",
          "app.ledger",
          "the spend ledger could not be read",
          ctx.now,
        ),
      ];
    }
    const entries = spendProjection(ctx.sources.ledger);
    const now = Date.parse(ctx.now);
    const period = SPEND_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    const laterStart = now - period;
    const earlierStart = now - 2 * period;
    // R-21's absent-versus-unreadable distinction: an install too young to have a previous
    // period produces no finding and no `unknown` either (matrix row 15). The evidence of a
    // previous period is any entry older than the trailing window.
    if (!entries.some((entry) => Number.isFinite(entry.ts) && entry.ts < laterStart)) return [];
    let later = 0;
    let earlier = 0;
    const laterByModel = new Map<string, number>();
    const earlierByModel = new Map<string, number>();
    for (const entry of entries) {
      // A future-dated entry (a clock corrected backwards) belongs to no window: counting it
      // into the trailing period would report a rise the fortnight never had.
      if (!Number.isFinite(entry.ts) || entry.ts > now) continue;
      if (entry.ts >= laterStart) {
        later += entry.microUsd;
        laterByModel.set(entry.model, (laterByModel.get(entry.model) ?? 0) + entry.microUsd);
      } else if (entry.ts >= earlierStart) {
        earlier += entry.microUsd;
        earlierByModel.set(entry.model, (earlierByModel.get(entry.model) ?? 0) + entry.microUsd);
      }
    }
    const rise = later - earlier;
    if (rise < SPEND_RISE_FLOOR_MICRO_USD || rise < earlier * SPEND_RISE_FRACTION) return [];
    // The model accounting for the largest share of the difference; a tie names them all, in
    // manifest order, because a coin toss would make two conforming builds disagree (D13).
    const models = new Set([...laterByModel.keys(), ...earlierByModel.keys()]);
    let largest = -Infinity;
    let winners: string[] = [];
    for (const model of models) {
      const delta = (laterByModel.get(model) ?? 0) - (earlierByModel.get(model) ?? 0);
      if (delta > largest) {
        largest = delta;
        winners = [model];
      } else if (delta === largest) {
        winners.push(model);
      }
    }
    const manifestIndex = new Map(
      (ctx.sources.manifest?.models ?? []).map((model, index) => [model.id, index]),
    );
    winners.sort((a, b) => {
      const ai = manifestIndex.get(a) ?? Number.MAX_SAFE_INTEGER;
      const bi = manifestIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
      return ai !== bi ? ai - bi : a < b ? -1 : a > b ? 1 : 0;
    });
    return [
      {
        kind: "spend-above-previous",
        occurrence: "trailing-7d",
        severity: "advisory",
        title: "Spend · above the previous 7 days",
        facts: [
          { name: "later-micro-usd", value: later, source: "app.ledger", measuredAt: ctx.now },
          { name: "earlier-micro-usd", value: earlier, source: "app.ledger", measuredAt: ctx.now },
          { name: "rise-micro-usd", value: rise, source: "app.ledger", measuredAt: ctx.now },
          { name: "largest-share", value: winners.join(", "), source: "app.ledger", measuredAt: ctx.now },
        ],
        cause: {
          statement: `spend rose ${rise} microUSD over the seven days before; ${winners.join(", ")} accounts for the largest share`,
        },
        remedy: null,
        consequences: [],
      },
    ];
  },
};

/**
 * R-22 — a component in a transient state is not a fault. It is stated only where it blocks
 * something else, as `advisory`, naming what is waiting: the components blocked on it through
 * the declared `requires` graph, and any recipe whose weight files it is.
 */
const waitingOnComponent: Rule = {
  kind: "waiting-on-component",
  run(ctx) {
    const setup = ctx.sources.setup;
    if (setup === null) return [];
    const findings: DraftFinding[] = [];
    for (const component of setup.components) {
      if (
        component.state !== "queued" &&
        component.state !== "downloading" &&
        component.state !== "paused" &&
        component.state !== "installing"
      ) {
        continue;
      }
      const waiting: string[] = setup.components
        .filter((c) => c.state === "blocked" && c.blockedBy === "dependency" && (c.requires ?? []).includes(component.id))
        .map((c) => c.id);
      const weightsRecipeId = comfyUiWeightsRecipeId(component.id);
      if (weightsRecipeId !== null) {
        const recipe = ctx.sources.comfyui?.recipes.find(
          (r) => r.recipeId === weightsRecipeId && r.state === "disabled" && r.reasonKind === "files",
        );
        if (recipe) waiting.push(recipe.recipeId);
      }
      // The engine rule suppresses an absent engine while this runtime is in transit (R-22);
      // the recipes it will enable are what wait on it, and the snapshot must not go silent
      // about why they are disabled in the meantime.
      if (component.id === "comfyui-runtime" && ctx.sources.comfyui?.engine.state === "absent") {
        for (const recipe of ctx.sources.comfyui.recipes) {
          if (recipe.state === "disabled" && recipe.reasonKind === "engine") waiting.push(recipe.recipeId);
        }
      }
      if (waiting.length === 0) continue;
      findings.push({
        kind: "waiting-on-component",
        occurrence: component.id,
        severity: "advisory",
        title: `${component.displayName} · ${component.state} · ${waiting.length} waiting`,
        facts: [
          { name: "component", value: component.id, source: "app.setup.components", measuredAt: ctx.now },
          { name: "state", value: component.state, source: "app.setup.components", measuredAt: ctx.now },
          { name: "waiting", value: waiting.join(", "), source: "app.setup.components", measuredAt: ctx.now },
        ],
        cause: { statement: `${waiting.join(", ")} waiting on this ${component.state} component` },
        remedy:
          component.state === "paused" && component.pauseSupported
            ? { control: "component-resume", target: component.id }
            : null,
        consequences: [],
      });
    }
    return findings;
  },
};

/** The ten joins and the hardware facts: eight over published state, two windowed (R-20). */
const STATE_RULES: readonly Rule[] = [
  workHeldByEngine,
  queuePausedCredential,
  componentDiskShort,
  recipeWeightsMissing,
  recipeDigestMismatch,
  engineUnavailable,
  modelsFolderUnmapped,
  waitingOnComponent,
  hardwareFacts,
  providerRepeatedFaults,
  spendAbovePrevious,
];

/**
 * Every source R-17 names, with whether it was read or is legitimately absent (R-19) — the
 * whole list, not the subset this release's rules happen to consult, so a rule added later
 * changes no row and a reader can see the closed set. `unavailable` is reachable for the log
 * tail, for the ledger, whose availability the read model publishes beside its entries (R-21),
 * and for the two values derived from that ledger — the spend status, which states when the
 * read behind its own evaluation failed (SPEC-008 R-19), and drift, which is not derived at
 * all when it did. Without those, the bundle carried a confident spend block and an empty
 * drift list marked `read` beside the very row saying their input could not be read. The jobs
 * list is file-seeded too but does not carry availability yet, so its row can only say `read`;
 * the remaining state fields are in memory, where a null one is a fact that was never taken —
 * absence, not a failed read (R-14's distinction).
 */
/**
 * The state of a value derived from the ledger read. The spend status carries the fate of the
 * evaluation's own read and is therefore the freshest answer; before any evaluation has run —
 * or on an installation with no settings to evaluate against — the seeded list's latched flag
 * is what there is.
 */
function ledgerDerivedState(sources: DiagnosticsSources): DiagnosticsSourceState {
  const failed = sources.spend === null ? sources.ledgerUnavailable : sources.spend.ledgerUnavailable;
  return failed ? "unavailable" : "read";
}

function sourceStates(sources: DiagnosticsSources, tails: DiagnosticsTails) {
  const named: Array<{ name: string; state: DiagnosticsSourceState }> = [
    { name: "app.version", state: "read" },
    { name: "app.health", state: "read" },
    { name: "app.env", state: sources.env === null ? "absent" : "read" },
    { name: "app.runtime", state: sources.runtime === null ? "absent" : "read" },
    { name: "app.harness", state: sources.harness === null ? "absent" : "read" },
    { name: "app.harnessInfo", state: sources.harnessInfo === null ? "absent" : "read" },
    { name: "app.setup", state: sources.setup === null ? "absent" : "read" },
    { name: "app.comfyui", state: sources.comfyui === null ? "absent" : "read" },
    { name: "app.voiceRuntime", state: sources.voiceRuntime === null ? "absent" : "read" },
    { name: "app.queues", state: "read" },
    { name: "app.jobs", state: "read" },
    { name: "app.providers", state: "read" },
    { name: "app.providerTools", state: "read" },
    { name: "app.manifest", state: sources.manifest === null ? "absent" : "read" },
    { name: "app.routing", state: "read" },
    { name: "app.models", state: "read" },
    {
      name: "app.spend",
      state: sources.spend === null ? "absent" : sources.spend.ledgerUnavailable ? "unavailable" : "read",
    },
    { name: "app.ledger", state: sources.ledgerUnavailable ? "unavailable" : "read" },
    // Drift is derived from the ledger beside spend, from the same read, and is not derived at
    // all when that read fails — so its row states that read's fate rather than `read` over a
    // list that was never computed. The freshest fate is the spend status's own; the seeded
    // list's latched flag answers before any evaluation has run.
    { name: "app.drift", state: ledgerDerivedState(sources) },
    { name: "app.builds", state: "read" },
    { name: "app.update", state: "read" },
    { name: "log.app", state: tails.appLog === "unavailable" ? "unavailable" : "read" },
  ];
  return named;
}

/**
 * The derivation (R-11): a pure function of its inputs. No network, no process, no file beyond
 * the tails it is given, nothing written. A rule that throws costs its own finding and no other
 * (R-14); the reserved finding carries the rule's kind and the error's *type*, never its
 * message, which is unvouched text.
 */
export function deriveDiagnostics(input: DeriveDiagnosticsInput): DiagnosticsSnapshot {
  return deriveWithRules(STATE_RULES, input);
}

/** The engine behind `deriveDiagnostics`, taking its rule set — how R-14's isolation is testable. */
export function deriveWithRules(
  rules: readonly Rule[],
  input: DeriveDiagnosticsInput,
): DiagnosticsSnapshot {
  const ctx: RuleContext = {
    sources: input.sources,
    tails: input.tails,
    now: input.now,
    boundary: input.boundary ?? IDENTITY_BOUNDARY,
  };
  const drafts: DraftFinding[] = [];
  const checked: string[] = [];
  for (const rule of rules) {
    try {
      drafts.push(...rule.run(ctx));
      checked.push(rule.kind);
    } catch (err) {
      drafts.push({
        kind: "rule-failed",
        occurrence: rule.kind,
        severity: "unknown",
        title: "A diagnostics rule failed",
        facts: [
          {
            name: "error-type",
            value: err instanceof Error ? err.constructor.name : typeof err,
            source: "derivation",
            measuredAt: input.now,
          },
        ],
        cause: { statement: `the ${rule.kind} rule threw and its finding is missing` },
        remedy: null,
        consequences: [],
      });
    }
  }

  // A consequence appears once however many causes reference it (R-9): rules construct their
  // own copy so each stays self-contained, and the join happens here, by identity.
  const seen = new Map<string, DraftFinding>();
  for (const draft of drafts) {
    const ref = `${draft.kind}:${draft.occurrence}`;
    if (!seen.has(ref)) seen.set(ref, draft);
  }

  // R-35 / D2: an occurrence's firstSeen comes from the previous snapshot — the one piece of
  // bookkeeping the snapshot carries between derivations, and it arrives as an input.
  const previousFirstSeen = new Map(
    (input.previous?.findings ?? []).map((f) => [findingRef(f), f.firstSeen]),
  );
  const findings: Finding[] = [...seen.values()].map((draft) => ({
    ...draft,
    firstSeen: previousFirstSeen.get(`${draft.kind}:${draft.occurrence}`) ?? input.now,
  }));

  // Deterministic order (R-11): severity rank, then kind, then occurrence.
  // Code-unit comparison, not locale collation: two conforming builds in different locales
  // must order identical snapshots identically (the divergence class D13 names).
  const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  findings.sort((a, b) => {
    const rank = FINDING_SEVERITY_RANK[a.severity] - FINDING_SEVERITY_RANK[b.severity];
    if (rank !== 0) return rank;
    const kind = byCodeUnits(a.kind, b.kind);
    return kind !== 0 ? kind : byCodeUnits(a.occurrence, b.occurrence);
  });

  return {
    derivedAt: input.now,
    findings,
    checked,
    sources: sourceStates(input.sources, input.tails),
  };
}

/**
 * Whether two snapshots state the same things, the derivation instant aside — what decides if a
 * fresh derivation is worth broadcasting. `firstSeen` is included on purpose: a condition that
 * lapsed and returned is a new occurrence of itself.
 */
export function diagnosticsEqual(
  a: DiagnosticsSnapshot | null,
  b: DiagnosticsSnapshot | null,
): boolean {
  if (a === null || b === null) return a === b;
  // Live facts are stamped with the derivation instant by construction, so a naive comparison
  // would find every populated snapshot different from its predecessor and re-broadcast on
  // every tick. Normalise exactly those; a recorded instant (`checkedAt`, `detectedAt`,
  // `blockedAt`) stays significant because its movement IS a change.
  const comparable = (snapshot: DiagnosticsSnapshot) => ({
    findings: snapshot.findings.map((finding) => ({
      ...finding,
      facts: finding.facts.map((fact) =>
        fact.measuredAt === snapshot.derivedAt ? { ...fact, measuredAt: "@derivation" } : fact,
      ),
    })),
    checked: snapshot.checked,
    sources: snapshot.sources,
  });
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}
