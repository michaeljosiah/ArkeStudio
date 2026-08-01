import { z } from "zod";
import { ClientStateSchema } from "./client-state.js";
import { DomainEventSchema } from "./events.js";
import { UlidSchema } from "./ids.js";

/**
 * Coordinator transport (SPEC-001 §2.5): one `snapshot` frame then `event` frames, sequence
 * numbers monotonic per connection. A reconnecting client sends its last-seen sequence and
 * receives a fresh snapshot — partial replay is deliberately not offered (D4).
 */

export const FrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), seq: z.number().int().min(1), state: ClientStateSchema }).strict(),
  z.object({ kind: z.literal("event"), seq: z.number().int().min(1), event: DomainEventSchema }).strict(),
]);
export type Frame = z.infer<typeof FrameSchema>;

/** What a client may send up. Commands arrive with their owning specs. */
export const ClientMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), lastSeq: z.number().int().min(0).optional() }).strict(),
  z.object({ kind: z.literal("open-world"), worldId: UlidSchema }).strict(),
  /** SPEC-002: create a world folder under the app root. */
  z
    .object({
      kind: z.literal("create-world"),
      name: z.string().min(1).max(200),
      logline: z.string().max(500).optional(),
      tone: z.string().max(200).optional(),
      genre: z.string().max(200).optional(),
    })
    .strict(),
  /** SPEC-002: reload after an external change made the open world stale (R-23). */
  z.object({ kind: z.literal("reload-world"), worldId: UlidSchema }).strict(),
  /** SPEC-002: adopt one closed-world edit — snapshot, bump, log (R-28). */
  z
    .object({ kind: z.literal("reconcile-external-edit"), worldId: UlidSchema, path: z.string().min(1) })
    .strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
