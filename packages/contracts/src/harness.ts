import { z } from "zod";

/**
 * Which engine runs the authoring work, and what the screen is allowed to offer (SPEC-005 R-1).
 *
 * One harness ships in the installer and two are brought by the user, and the difference is the
 * whole reason this shape exists. OpenCode is present by construction — it is inside the
 * download, so "is it there?" is not a question worth asking. Claude Code and Codex are the user's
 * own installations, which may be absent, too old, or gone since yesterday's update.
 *
 * So availability is DISCOVERED and sent to the screen, rather than assumed. A harness the
 * machine does not have must not be selectable, and the reason has to travel with the answer:
 * "not installed" and "installed but too old" want different things from the reader, and a
 * screen given only a boolean would have to invent the difference or hide it.
 */

export const HarnessEngineSchema = z.enum(["opencode", "claude", "codex"]);
export type HarnessEngine = z.infer<typeof HarnessEngineSchema>;

export const HarnessAvailabilitySchema = z
  .object({
    id: HarnessEngineSchema,
    /** How the harness is named on screen — "OpenCode", "Claude Code". */
    label: z.string().min(1),
    /** Found on this machine and clearing the version floor. The gate for selecting it. */
    installed: z.boolean(),
    version: z.string().nullable(),
    /**
     * How it was found: on PATH, or at a path the user pointed us at. Null when absent.
     *
     * Worth carrying because "found" is not the whole answer — somebody who chose a file wants
     * to see that their choice is what answered, not wonder whether it was quietly ignored.
     */
    source: z.enum(["path", "configured"]).nullable(),
    /**
     * Why it cannot be chosen, written to be read rather than logged. Null when it can be.
     *
     * Carried rather than derived because only the detector knows which case this is. A screen
     * holding `installed: false` alone could say nothing more useful than "unavailable", when
     * the true answer is often "you have 2.1.180, you need 2.1.227" — something the reader can
     * act on in a minute.
     */
    blocked: z.string().nullable(),
    /**
     * Ships inside the installer, so it is always available and never the thing being gated.
     * Kept as data rather than an id comparison so the screen does not have to know which
     * harness is the bundled one.
     */
    bundled: z.boolean(),
  })
  .strict();
export type HarnessAvailability = z.infer<typeof HarnessAvailabilitySchema>;

/** What the screen renders: every harness the app knows, and which one is currently chosen. */
export const HarnessStatusSchema = z
  .object({
    engine: HarnessEngineSchema,
    harnesses: z.array(HarnessAvailabilitySchema),
    /** The executable chosen for Claude Code, if any — echoed so it can be shown and cleared. */
    claudePath: z.string().nullable(),
    codexPath: z.string().nullable().default(null),
    /** A host environment override outranks the saved engine at every launch. */
    launchOverride: HarnessEngineSchema.nullable().optional(),
    /** The engine attempted at startup, retained even if it failed before producing metadata. */
    launchEngine: HarnessEngineSchema.optional(),
  })
  .strict();
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;

/** A launch override chooses the whole engine; it must not accidentally enable two lanes. */
export function effectiveHarnessEngine(stored: HarnessEngine, override?: string): HarnessEngine {
  const parsed = HarnessEngineSchema.safeParse(override);
  return parsed.success ? parsed.data : stored;
}

/**
 * A language model the local runtime has pulled, as the coordinator observed it (issue 1247).
 *
 * OpenCode never asks Ollama what it holds. Measured against the pinned v2 build with Ollama
 * answering on its port: no probe, no row, and a `provider` block in the old v1 grammar is
 * ignored without a warning. A local model reaches the harness's catalogue only when Arke
 * lists it by name in the harness's own configuration — so this is what the coordinator learns
 * from Ollama and hands to the assembly that writes that file. Nothing here is a manifest entry:
 * which models are *offered* stays SPEC-028's business; this is only what is *installed*.
 */
export interface LocalHarnessModel {
  /** Ollama's own name, tag included — `gemma4:12b`. The id the harness will be asked for. */
  readonly id: string;
  /** Context length from the model's metadata, when Ollama states one. */
  readonly contextLength?: number;
  /** Whether the runtime says the model calls tools. Unknown reads as true: a refusal beats a hidden model. */
  readonly tools: boolean;
  /** Whether the runtime says the model reads images. */
  readonly vision: boolean;
  /**
   * The capabilities above were assumed, not read: the model's show failed or was cut off by
   * the listing deadline, or it listed no capabilities. Offered for choosing when its window is
   * stated ({@link meetsLocalModelMinimum}), never chosen unattended — nothing says it completes,
   * let alone calls tools.
   */
  readonly assumed?: true;
}

/**
 * The shortest context a local model must state to be offered to any writing harness: 256k
 * (issue 1247). A product decision, not a measurement — the roster's prompts, world context
 * and long sessions are written for long windows, and a model trained on less degrades well
 * before its window fills. Ollama reports what the weights declare, so Gemma 4 12B and 26B pass
 * and Gemma 4 E2B (128k) does not. 256,000 rather than 262,144: both are published as "256K".
 */
export const LOCAL_MODEL_MIN_CONTEXT = 256_000;

/**
 * Whether a pulled model may be offered for writing: whether it states the window. A model whose
 * details could not be read states none, so it is not; one whose window was read but whose
 * capabilities Ollama did not list is, and `assumed` still keeps it from being chosen unattended.
 */
export function meetsLocalModelMinimum(model: { readonly contextLength?: number }): boolean {
  return (model.contextLength ?? 0) >= LOCAL_MODEL_MIN_CONTEXT;
}

/**
 * The bundled harness, stated once. It cannot be missing, so nothing detects it — a detector
 * that reported OpenCode absent would be describing a broken installation, not a choice.
 */
export const OPENCODE_AVAILABILITY: HarnessAvailability = {
  id: "opencode",
  label: "OpenCode",
  installed: true,
  version: null,
  source: null,
  blocked: null,
  bundled: true,
};
