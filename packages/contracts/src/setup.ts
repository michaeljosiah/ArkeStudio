import { z } from "zod";

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
