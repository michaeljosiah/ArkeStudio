import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { IsoDateTimeSchema } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";

/**
 * The proposal-local draft journal (#70 §11.4.1).
 *
 * In-place edits on the approvals screen must not reuse the unjournaled write, because that
 * sequence has a window in which the target file on disk has moved on and the manifest has not.
 * A crash inside that window leaves a proposal whose recorded revision understates what its files
 * actually say — and the revision is precisely what the next edit checks itself against. The
 * lie would be silent, and the next writer would build on it.
 *
 * So an edit is a small saga with its own record on disk, and the record is the authority on how
 * far it got. Two states are enough: `prepared` means nothing authoritative has moved yet and the
 * operation can simply be dropped; `committing` means target files may already have been renamed,
 * so the only safe direction is forward. Everything after the mark is idempotent, which is what
 * lets recovery re-run it without knowing where it stopped.
 *
 * The spec also names a candidate projection sidecar in step 5. This implementation has no such
 * file — a proposal's link to its propositions lives in `worldChatOrigins` on the manifest — so
 * that step is the manifest write, and there is deliberately no second file to keep in step.
 */

export const DRAFT_JOURNAL_DIR = ".draft-commit";

const DraftFileSchema = z.object({ path: z.string().min(1), content: z.string() }).strict();

export const DraftOperationSchema = z
  .object({
    operationId: z.string().min(1),
    /** Makes a retry after a refusal idempotent rather than a second edit. */
    requestId: z.string().min(1),
    proposalId: z.string().min(1),
    /** What the editor believed when they typed; what `currentDraftRevision` was checked against. */
    expectedDraftRevision: z.number().int().min(1),
    currentDraftRevision: z.number().int().min(1),
    nextDraftRevision: z.number().int().min(1),
    state: z.enum(["prepared", "committing"]),
    /**
     * Complete next contents of every target this edit changes. Whole files, not patches: a
     * partly-applied patch is a state recovery would have to interpret, and interpreting is
     * exactly what must not happen after a crash.
     */
    files: z.array(DraftFileSchema).min(1),
    /** The complete next manifest, already carrying nextDraftRevision. Written wholesale at step 5. */
    nextManifest: z.record(z.string(), z.unknown()),
    at: IsoDateTimeSchema,
  })
  .strict();

export type DraftOperation = z.infer<typeof DraftOperationSchema>;

/** Where one operation's record lives. One file per operation, named by its id. */
export function draftRecordPath(proposalDir: string, operationId: string): string {
  return join(proposalDir, DRAFT_JOURNAL_DIR, `${operationId}.json`);
}

/** Where a next file waits before it is renamed over the target (step 2). */
export function draftStagingPath(proposalDir: string, operationId: string, portablePath: string): string {
  // Flattened into one staging file per target, so no directory tree has to be created or
  // cleaned up under the journal; the record holds the real path.
  const flat = portablePath.replace(/[^A-Za-z0-9._-]+/g, "_");
  return join(proposalDir, DRAFT_JOURNAL_DIR, `${operationId}.${flat}.staged`);
}

export async function writeDraftRecord(proposalDir: string, op: DraftOperation): Promise<void> {
  await atomicWriteFile(
    draftRecordPath(proposalDir, op.operationId),
    JSON.stringify(DraftOperationSchema.parse(op), null, 2) + "\n",
  );
}

export async function removeDraftOperation(proposalDir: string, op: DraftOperation): Promise<void> {
  for (const file of op.files) {
    await rm(toExtendedLength(draftStagingPath(proposalDir, op.operationId, file.path)), { force: true });
  }
  await rm(toExtendedLength(draftRecordPath(proposalDir, op.operationId)), { force: true });
}

/**
 * Every unresolved operation for a proposal, oldest first.
 *
 * A record that will not parse is reported rather than skipped. Skipping it would let accept
 * proceed past an edit whose outcome nobody knows, which is the one thing the journal exists to
 * prevent — so an unreadable record keeps the proposal locked until a person deals with it.
 */
export async function readDraftOperations(
  proposalDir: string,
): Promise<{ operations: DraftOperation[]; unreadable: string[] }> {
  let entries: string[] = [];
  try {
    entries = await readdir(toExtendedLength(join(proposalDir, DRAFT_JOURNAL_DIR)));
  } catch {
    return { operations: [], unreadable: [] };
  }

  const operations: DraftOperation[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await readFile(toExtendedLength(join(proposalDir, DRAFT_JOURNAL_DIR, entry)), "utf8");
      operations.push(DraftOperationSchema.parse(JSON.parse(raw)));
    } catch {
      unreadable.push(entry);
    }
  }
  operations.sort((a, b) =>
    a.at === b.at ? a.operationId.localeCompare(b.operationId) : a.at.localeCompare(b.at),
  );
  return { operations, unreadable };
}
