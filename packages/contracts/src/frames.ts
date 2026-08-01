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
  /** SPEC-004: stage a sheet edit as a proposal — the form editor's whole flow in one message. */
  z
    .object({
      kind: z.literal("stage-sheet-edit"),
      worldId: UlidSchema,
      /** World-relative sheet path, e.g. "characters/maren-kest.md". */
      path: z.string().min(1),
      summary: z.string().min(1).max(300),
      sections: z.array(z.object({ heading: z.string().min(1), body: z.string() }).strict()).min(1),
    })
    .strict(),
  /** SPEC-004: gate decisions. confirmRipples carries the authoritative signature on re-confirm (R-10). */
  z
    .object({
      kind: z.literal("proposal-accept"),
      worldId: UlidSchema,
      proposalId: z.string().min(1),
      confirmRipples: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("proposal-discard"), worldId: UlidSchema, proposalId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("proposal-rebase"), worldId: UlidSchema, proposalId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("proposal-resolve-conflict"),
      worldId: UlidSchema,
      proposalId: z.string().min(1),
      path: z.string().min(1),
      field: z.string().min(1),
      choice: z.enum(["mine", "theirs"]),
    })
    .strict(),
  /** SPEC-004 R-7: the user has seen the merged result; the proposal becomes acceptable again. */
  z
    .object({ kind: z.literal("proposal-mark-seen"), worldId: UlidSchema, proposalId: z.string().min(1) })
    .strict(),
  /** SPEC-005: stage a proposal and run an authoring agent inside it. */
  z
    .object({
      kind: z.literal("draft-with-studio"),
      worldId: UlidSchema,
      /** World-relative target path the draft revises, e.g. "characters/maren-kest.md". */
      path: z.string().min(1),
      instruction: z.string().min(1).max(4000),
      summary: z.string().min(1).max(300),
    })
    .strict(),
  /** SPEC-005 R-13: cancellation is immediate and leaves the proposal intact. */
  z
    .object({ kind: z.literal("authoring-cancel"), worldId: UlidSchema, proposalId: z.string().min(1) })
    .strict(),
  /** SPEC-005 R-16: a human's decision on a harness backstop prompt. */
  z
    .object({
      kind: z.literal("permission-reply"),
      permissionId: z.string().min(1),
      decision: z.enum(["once", "always", "reject"]),
    })
    .strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
