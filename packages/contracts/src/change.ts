import { z } from "zod";
import { IsoDateTimeSchema, Sha256Schema } from "./ids.js";

/**
 * changes.jsonl — the world's append-only audit trail (master spec §2.5): backing store for
 * the Activity feed, input to index rebuilds, and the record that answers "how did this get
 * here". Passthrough on purpose: later specs add fields and an old reader must not reject a
 * newer world's log.
 */
export const ChangeRecordSchema = z
  .object({
    ts: IsoDateTimeSchema,
    /** World-relative entity path, e.g. "characters/maren-kest". */
    entity: z.string().min(1),
    /** Exact file path and hashes used to advance derived scan state after crash recovery. */
    path: z.string().min(1).optional(),
    commitIndex: z.number().int().min(0).optional(),
    contentHashBefore: Sha256Schema.nullable().optional(),
    contentHashAfter: Sha256Schema.nullable().optional(),
    fromVersion: z.number().int().nullable().optional(),
    toVersion: z.number().int().optional(),
    fieldsChanged: z.array(z.string()).optional(),
    /** Where the change came from, e.g. "chat:sess_9f2" | "form" | "system:import". */
    source: z.string().min(1),
    canonRevisionAfter: z.number().int().optional(),
    proposalId: z.string().optional(),
  })
  .passthrough();
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;
