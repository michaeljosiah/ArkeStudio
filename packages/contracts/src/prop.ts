import { z } from "zod";
import { IsoDateTimeSchema, JobIdSchema, prefixedIdSchema, TakeIdSchema } from "./ids.js";

/**
 * Props — a stable identity with ordered named states, and nothing owned beyond them (design
 * turn 105, Option C; issue 534).
 *
 * Deliberately not sheet-weight: no prose sections, no timeline, and `SheetKindSchema` is
 * untouched. The shot owns the state and the transition is simply the shot where a control first
 * changes, so neither is recorded here. A state is a name with a stable id — renaming
 * `on-fridge` never breaks a shot that already cites it — and, once one is accepted, the
 * reference dispatch reads for it.
 */

export const PropIdSchema = prefixedIdSchema("prop");
export const PropStateIdSchema = prefixedIdSchema("pst");

/**
 * The accepted reference for one state. The character look's shape, mirrored rather than
 * extended: it arrives through the same accept/take path (turn 105, `referenceOwner`), but a prop
 * state has no look kind and attaches to nothing — the state is its whole address.
 */
export const PropStateReferenceSchema = z
  .object({
    id: z.string().min(1),
    file: z.string().min(1),
    prompt: z.string().min(1),
    sourceJobId: JobIdSchema.optional(),
    sourceTakeId: TakeIdSchema.optional(),
    acceptedAt: IsoDateTimeSchema,
  })
  .strict();
export type PropStateReference = z.infer<typeof PropStateReferenceSchema>;

export const PropStateSchema = z
  .object({
    id: PropStateIdSchema,
    name: z.string().min(1),
    reference: PropStateReferenceSchema.optional(),
  })
  .strict();
export type PropState = z.infer<typeof PropStateSchema>;

export const PropSchema = z
  .object({
    id: PropIdSchema,
    name: z.string().min(1),
    /** Ordered, and that is all the order means — no state implies the next. */
    states: z.array(PropStateSchema),
  })
  .strict();
export type Prop = z.infer<typeof PropSchema>;

/**
 * What a take froze about one prop at dispatch — turn 105's five fields, explicit about absence
 * rather than silent: a shot that cited the prop with no state chosen dispatches `unresolved`
 * with null state and reference, never a guess. `override` is a one-shot choice made before
 * spend; `overrideSource` says who made it and is null whenever the shot's own control was read.
 */
export const PropStateProvenanceSchema = z
  .object({
    propId: PropIdSchema,
    stateId: PropStateIdSchema.nullable(),
    referenceId: z.string().min(1).nullable(),
    resolutionSource: z.enum(["shot", "override", "unresolved"]),
    overrideSource: z.enum(["manual"]).nullable(),
  })
  .strict();
export type PropStateProvenance = z.infer<typeof PropStateProvenanceSchema>;
