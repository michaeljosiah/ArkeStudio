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

/** What a client may send up. Commands arrive with their owning specs; SPEC-001 has two. */
export const ClientMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), lastSeq: z.number().int().min(0).optional() }).strict(),
  z.object({ kind: z.literal("open-world"), worldId: UlidSchema }).strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
