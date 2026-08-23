import { z } from "zod";
import { BenchPresetSchema } from "./bench.js";
import { HarnessEngineSchema } from "./harness.js";
import { CapabilitySchema, ProviderIdSchema } from "./provider.js";

/**
 * App-level settings (SPEC-008 §2.7, §2.10): routing defaults that resolve to concrete models
 * (R-20, D1), and the spend threshold that alerts but never blocks (R-19, D10).
 */

/** capability → concrete model id. Displayed by provider name; stored as the model (D1). */
export const RoutingDefaultsSchema = z.record(CapabilitySchema, z.string().min(1));
export type RoutingDefaults = z.infer<typeof RoutingDefaultsSchema>;

/** A default whose model has left the manifest — a Settings fault, not a dispatch failure (§2.7). */
export const RoutingFaultSchema = z
  .object({
    capability: CapabilitySchema,
    modelId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type RoutingFault = z.infer<typeof RoutingFaultSchema>;

export const SpendSettingsSchema = z
  .object({
    /** 0 disables the alert. */
    thresholdMicroUsd: z.number().int().min(0),
    /** The rolling window the threshold is evaluated over, across all worlds (R-19). */
    periodDays: z.number().int().min(1).max(365),
  })
  .strict();
export type SpendSettings = z.infer<typeof SpendSettingsSchema>;

export const BackgroundNotificationPreferenceSchema = z.enum([
  "background-results-and-issues",
  "issues-only",
  "off",
]);
export type BackgroundNotificationPreference = z.infer<typeof BackgroundNotificationPreferenceSchema>;

export const ThemePreferenceSchema = z.enum(["system", "light", "dark"]);
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;

/**
 * Which harness runs the work. Only ever set to a harness the coordinator confirmed is on the
 * machine — see `HarnessAvailability`. Defaults to the one inside the installer, so doing
 * nothing keeps the behaviour every existing install already has.
 */
export const HarnessSettingsSchema = z
  .object({
    engine: HarnessEngineSchema.default("opencode"),
    /**
     * An explicit path to Claude Code, for when PATH does not carry it.
     *
     * Not a convenience. A GUI app inherits whatever environment launched it, and an install
     * living somewhere like `~/.local/bin` can be perfectly present and still invisible to the
     * app — leaving a screen that says "not here" about something the user can see on disk,
     * with nothing to do about it. This is the something.
     */
    claudePath: z.string().min(1).nullable().default(null),
  })
  .strict();
export type HarnessSettings = z.infer<typeof HarnessSettingsSchema>;

export const AppearanceSettingsSchema = z
  .object({
    theme: ThemePreferenceSchema.default("system"),
  })
  .strict();
export type AppearanceSettings = z.infer<typeof AppearanceSettingsSchema>;

export const VoxaSettingsSchema = z
  .object({
    executablePath: z.string().min(1).nullable().default(null),
    /** null uses `%APP_ROOT%/models`, where local setup writes verified model files. */
    modelRoot: z.string().min(1).nullable().default(null),
    /** Advanced arguments are always discrete spawn arguments, never a shell command line. */
    extraArgs: z.array(z.string()).default([]),
  })
  .strict();
export type VoxaSettings = z.infer<typeof VoxaSettingsSchema>;

/**
 * Where the ComfyUI engine is (SPEC-021 §2.2). Path and URL are both user direction, and both
 * beat the managed install (D5); they are separate fields because they mean different things —
 * a path is spawned and supervised, a URL is probed and never spawned (D13).
 */
export const ComfyUiSettingsSchema = z
  .object({
    /** An install Arke launches as its own supervised child. */
    enginePath: z.string().min(1).nullable().default(null),
    /** An already-running engine. Probed, never spawned; wins over `enginePath` when both are set. */
    engineUrl: z.string().min(1).nullable().default(null),
    /**
     * The models folder presence detection, downloads and pre-flight verification all resolve
     * against (§2.4). null → `<engineRoot>/models`. For a URL engine this is the explicit
     * filesystem mapping D13 requires — the user's assertion that this folder is the one the
     * engine reads — and without it recipes stay disabled with verification stated unavailable.
     */
    modelsDir: z.string().min(1).nullable().default(null),
  })
  .strict();
export type ComfyUiSettings = z.infer<typeof ComfyUiSettingsSchema>;

/**
 * What the user has changed about an agent. Absent fields mean "as shipped": no model pins the
 * agent to whatever the harness is configured with, and no brief leaves the shipped one alone.
 *
 * The brief is only what the agent is FOR. The confinement rules — stay in your folder, do not
 * restate canon, do not stamp versions — are not here and cannot be edited, because the accept
 * gate assumes them and an agent talked out of them fails in ways that look like our bugs.
 */
export const AgentSettingsSchema = z
  .object({
    /** "provider/model" as the harness names it, e.g. "github-copilot/claude-sonnet-4.6". */
    model: z.string().min(1).optional(),
    brief: z.string().min(1).max(8000).optional(),
  })
  .strict();
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

/**
 * Which of a provider's models this studio offers. Stored as the exceptions, not the roster:
 * every model in the manifest is available until it is switched off, so a settings file written
 * before this existed keeps behaving exactly as it did, and a manifest that grows does not need
 * anyone to opt in to what it added.
 */
export const ModelAvailabilitySchema = z
  .object({ disabled: z.array(z.string().min(1)).default([]) })
  .strict();
export type ModelAvailability = z.infer<typeof ModelAvailabilitySchema>;

/**
 * The voice the app reads its own prose in (design 70; asked for 2026-08-17).
 *
 * A third role, and deliberately not either of the other two. A **character voice** lives on a
 * sheet and answers who speaks; a **reading voice** is chosen per take on the bench and belongs
 * to one recording. The narrator is neither: it reads text *about* the world rather than lines
 * *in* it, which is why reading a sheet section aloud in that character's own voice — the
 * behaviour this replaces — described Bray in Bray's voice, and refused entirely for the many
 * characters who have no voice at all.
 *
 * It carries its provider, the way a sheet's assignment does. Routing chooses a *model* and can
 * disagree with a voice's provider; the narrator wins, because a voice that resolves to a
 * provider that cannot say it is the silent-mismatch failure this codebase keeps paying for.
 *
 * Null means the local default: unmetered, so pressing "read aloud" never spends. Cloud is an
 * opt-in the user makes with the per-character price in front of them — no other preference in
 * this app spends money on a passive action, and this one must not be the first.
 */
export const NarratorSettingsSchema = z
  .object({
    provider: z.string().min(1),
    voiceId: z.string().min(1),
    label: z.string().min(1).optional(),
  })
  .strict()
  .nullable();
export type NarratorSettings = z.infer<typeof NarratorSettingsSchema>;

const AppSettingsObjectSchema = z
  .object({
    /**
     * Whether the studio may go online when asked to research (2026-08-22, widened 2026-08-23).
     *
     * Off, because this app runs on your machine and reads your world off your disk, and going
     * online is a different promise from the one it makes by default.
     *
     * On, it may now SEARCH as well as fetch a page you name. It could only fetch a named URL
     * before, which sounds like a smaller promise and mostly worked as a broken one: asking it to
     * go and find out how something is done meant finding the pages yourself and pasting them in,
     * and the one link it did pick on its own was dead. Nobody asking for research is asking for
     * that. What it reads is not canon and reaches the world only through the accept gate, the
     * same as everything else, and it is told to cite the URL a claim came from so you can check
     * it — see WEB_RESEARCH_RULE.
     *
     * Two surfaces answer to this one switch. The `fetch_url` tool asks per call, so switching it
     * off stops the next call. Harness sessions take their confinement when they open, so
     * switching it off reaches the next session rather than the running one.
     */
    research: z.object({ web: z.boolean().default(false) }).strict().default({ web: false }),
    routing: RoutingDefaultsSchema.default({}),
    models: ModelAvailabilitySchema.default({ disabled: [] }),
    spend: SpendSettingsSchema.default({ thresholdMicroUsd: 0, periodDays: 7 }),
    backgroundNotifications: BackgroundNotificationPreferenceSchema.default("issues-only"),
    appearance: z
      .preprocess(
        (value) => (AppearanceSettingsSchema.safeParse(value).success ? value : {}),
        AppearanceSettingsSchema,
      )
      .default({ theme: "system" }),
    voxa: z
      .preprocess(
        (value) => (VoxaSettingsSchema.safeParse(value).success ? value : {}),
        VoxaSettingsSchema,
      )
      .default({ executablePath: null, modelRoot: null, extraArgs: [] }),
    /** Where the ComfyUI engine is (SPEC-021 §2.2); guarded the same way voxa is. */
    comfyui: z
      .preprocess(
        (value) => (ComfyUiSettingsSchema.safeParse(value).success ? value : {}),
        ComfyUiSettingsSchema,
      )
      .default({ enginePath: null, engineUrl: null, modelsDir: null }),
    /** The voice the app reads text aloud in. Null uses the local default (see the schema). */
    narrator: z
      .preprocess(
        (value) => (NarratorSettingsSchema.safeParse(value).success ? value : null),
        NarratorSettingsSchema,
      )
      .default(null),
    /**
     * Which engine runs authoring work. Guarded and defaulted: a settings file written before
     * there was a choice has no `harness` key at all, and a strict parse that threw over it
     * would hand the user back a default file, losing their routing and spend choices to a
     * feature they never used.
     */
    harness: z
      .preprocess(
        (value) => (HarnessSettingsSchema.safeParse(value).success ? value : { engine: "opencode" }),
        HarnessSettingsSchema,
      )
      .default({ engine: "opencode" }),
    /** Per-agent overrides, keyed by roster name. */
    agents: z.record(z.string().min(1), AgentSettingsSchema).default({}),
    /**
     * Saved bench setups (issue 305 §3). Guarded per entry: one preset a future build cannot
     * read drops alone, because a corrupt row that takes the whole settings file down would
     * cost the user their routing and spend choices with it.
     */
    presets: z
      .preprocess(
        (value) => (Array.isArray(value) ? value.filter((r) => BenchPresetSchema.safeParse(r).success) : []),
        z.array(BenchPresetSchema),
      )
      .default([]),
  })
  .strict();

/**
 * Saved bench setups were called `recipes` until SPEC-021 gave that word a precise and quite
 * different meaning — a pinned, versioned local generation definition. The stored key is
 * migrated on read rather than left to fail: the object above is `.strict()`, so an untouched
 * settings file carrying the old key would throw, and the catch around it would hand the user
 * back a default file — losing their routing, spend and appearance choices to a rename.
 */
export const AppSettingsSchema = z.preprocess((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (!("recipes" in raw)) return value;
  // The legacy key is ALWAYS removed, not only when it is the one being read: leaving it in
  // place fails the strict parse below, and a thrown parse costs the whole settings file. A
  // file carrying both keeps `presets` — the newer key is the one the app last wrote.
  const { recipes, ...rest } = raw;
  return "presets" in rest ? rest : { ...rest, presets: recipes };
}, AppSettingsObjectSchema);
export type AppSettings = z.infer<typeof AppSettingsSchema>;

/** Rolling spend as evaluated on the last ledger append (R-19). */
export const SpendStatusSchema = z
  .object({
    settings: SpendSettingsSchema,
    /** Spend inside the rolling window, all worlds, actual-where-reported. */
    rollingMicroUsd: z.number().int().min(0),
    /** True while the rolling spend sits at or over a non-zero threshold. */
    alerted: z.boolean(),
  })
  .strict();
export type SpendStatus = z.infer<typeof SpendStatusSchema>;

/** Repeated estimate/actual divergence for one model — the manifest went stale (R-13, §2.11). */
export const ManifestDriftSchema = z
  .object({
    modelId: z.string().min(1),
    provider: ProviderIdSchema,
    /** Provider-reported samples the judgement is based on. */
    samples: z.number().int().min(1),
    /** Median divergence as parts-per-thousand of the estimate, integer (R-14 discipline). */
    medianDivergencePerMille: z.number().int().min(0),
  })
  .strict();
export type ManifestDrift = z.infer<typeof ManifestDriftSchema>;

// ---------------------------------------------------------------------------
// Local runtimes (R-22, D11, D12)
// ---------------------------------------------------------------------------

/** Measured machine figures; null means the probe failed → unknown, never unavailable (D12). */
export const RuntimeProbesSchema = z
  .object({
    vramMb: z.number().int().min(0).nullable(),
    memMb: z.number().int().min(0).nullable(),
    diskFreeMb: z.number().int().min(0).nullable(),
  })
  .strict();
export type RuntimeProbes = z.infer<typeof RuntimeProbesSchema>;

export const LocalRuntimeModelSchema = z
  .object({
    modelId: z.string().min(1),
    provider: ProviderIdSchema,
    displayName: z.string().min(1),
    capability: CapabilitySchema,
    state: z.enum(["ready", "disabled", "unknown"]),
    /** The measured reason, both figures: "Needs 24 GB VRAM. This machine has 12 GB." (R-22). */
    reason: z.string().optional(),
    /** The cloud alternative worth noting, when one exists. */
    cloudAlternative: z.string().optional(),
  })
  .strict();
export type LocalRuntimeModel = z.infer<typeof LocalRuntimeModelSchema>;

export const LocalRuntimeStatusSchema = z
  .object({
    probes: RuntimeProbesSchema,
    detectedAt: z.string().min(1),
    models: z.array(LocalRuntimeModelSchema),
  })
  .strict();
export type LocalRuntimeStatus = z.infer<typeof LocalRuntimeStatusSchema>;
