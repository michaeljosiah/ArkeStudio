import { join } from "node:path";
import type { WorldStore } from "../world/store.js";
import type { ImportFileSpace, ImportFileStorage } from "../storage/import-files.js";
import type { BrowserImportPayload } from "./browser-media-import.js";
import { planBrowserArtifactCopies } from "./filing.js";

/** Original browser spool stays owned by its caller throughout batch planning and filing. */
export async function withBrowserImportBatch<T>(store: WorldStore, payloads: readonly BrowserImportPayload[], storage: ImportFileStorage | undefined,
  consume: (space: ImportFileSpace | undefined) => Promise<T>): Promise<T> {
  if (!storage) return consume(undefined);
  const plan = await planBrowserArtifactCopies(store, payloads);
  const batch = await storage.reserveBatch(join(store.dir, "artifacts"), plan.bytes, plan.copies, store.closingSignal);
  try { store.closingSignal.throwIfAborted(); return await consume(batch.space); }
  finally { await batch.settle(); }
}
