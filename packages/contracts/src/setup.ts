import { z } from "zod";
import { EngineIdSchema } from "./local-ai.js";

/**
 * Local runtimes fetched during setup: the writing runtime (Ollama and one model) and the two
 * voice models. Each one is optional, individually skippable, and never blocks the app — the
 * user can continue while they arrive.
 *
 * A component is a *thing that must be on this machine*, not a thing we generate. Presence is
 * detected before anything is fetched, so a second launch downloads nothing.
 */

export const SetupComponentStateSchema = z.enum([
  /** Already on this machine — nothing to do. */
  "present",
  /** Offered but never fetched on its own: yours to start, from Settings. */
  "available",
  /** Waiting its turn. */
  "queued",
  "downloading",
  /** Bytes are here; the runtime's own installer or model-pull is running. */
  "installing",
  /** Arrived and usable. */
  "ready",
  /** The user said no, this time or for good. */
  "skipped",
  /** Cannot even be attempted — no disk, no network — with the measured reason. */
  "blocked",
  "failed",
]);
export type SetupComponentState = z.infer<typeof SetupComponentStateSchema>;

export const SetupComponentSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    /** What it buys you, in the product's words: "Writes with you, on this machine". */
    purpose: z.string().min(1),
    /** The download size as published, for honest arithmetic before anything starts. */
    sizeMb: z.number().int().min(0),
    state: SetupComponentStateSchema,
    bytesDone: z.number().int().min(0).default(0),
    bytesTotal: z.number().int().min(0).default(0),
    /** Measured, not guessed; null while nothing is moving. */
    bytesPerSecond: z.number().int().min(0).nullable().default(null),
    /** The reason, whenever the state is one that owes you one. */
    detail: z.string().optional(),
    /** The failed action must be tried again; an ordinary retry would trust the surviving file. */
    repairRequired: z.boolean().optional(),
    /**
     * The manifest models this component makes available (SPEC-033 R-39). Declared, so that a
     * capability row can say whether a model is installed without inferring a chain from an
     * identifier's prefix — the same class of mistake as `ollama-gemma4-12b` naming its runtime.
     *
     * ComfyUI recipe weights are deliberately absent: their component id is already derived from
     * the recipe catalogue, and a second declaration of the same weights is what drifts.
     */
    provides: z.array(z.string().min(1)).optional(),
    /**
     * Which engine requires this component (SPEC-033 R-71). Declared, so Engines can state a
     * component under the engine that needs it rather than in one flat list that mixes a runtime
     * with a set of weights.
     *
     * Absent means no engine requires it — a CLI, a native dependency. Those keep a place on
     * Engines and are not the organising idea.
     */
    engine: EngineIdSchema.optional(),
  })
  .strict();
export type SetupComponent = z.infer<typeof SetupComponentSchema>;

export const SetupStatusSchema = z
  .object({
    components: z.array(SetupComponentSchema),
    /** True while any component is downloading or installing. */
    running: z.boolean(),
    /** Free disk at the last check — the guard's evidence, shown rather than assumed. */
    diskFreeMb: z.number().int().min(0).nullable(),
  })
  .strict();
export type SetupStatus = z.infer<typeof SetupStatusSchema>;
