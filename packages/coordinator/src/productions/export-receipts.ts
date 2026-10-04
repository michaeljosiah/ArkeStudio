import { readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ReadinessExportSchema, SlugSchema, UlidSchema, IsoDateTimeSchema, type ReadinessExport } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { atomicWriteFile } from "../world/atomic.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import { toExtendedLength } from "../world/paths.js";
import { interactiveExportCompleted } from "./interactive.js";

const CompletedExportSchema = ReadinessExportSchema.extend({
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  worldId: UlidSchema,
  productionId: SlugSchema,
  status: z.literal("done"),
  createdAt: IsoDateTimeSchema,
  output: z.string().startsWith("exports/"),
  sourceFingerprint: z.string().min(1).max(200),
  deliveryKind: z.enum(["video", "manuscript", "interactive"]),
});
const receiptPath = (id: string) => `exports/.completed/${id}.json`;

/** SPEC-002 §2.10 / SPEC-051 R-40: delivery metadata, flushed before completion is published.
 * This operational receipt changes neither authored world records nor their schema floor. */
export async function recordCompletedExport(store: WorldStore, record: ReadinessExport): Promise<void> {
  const receipt = CompletedExportSchema.parse({ version: 1, ...ReadinessExportSchema.strip().parse(record) });
  if (receipt.worldId !== store.worldId) throw new Error("export-receipt-world-mismatch");
  await store.ownedWrite(async () => {
    const path = await containedWorldFilePath(store.dir, receiptPath(receipt.id), true, "export-receipt");
    const existing = await readFile(toExtendedLength(path), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (existing !== null) {
      const prior = CompletedExportSchema.parse(JSON.parse(existing));
      if (JSON.stringify(prior) !== JSON.stringify(receipt)) throw new Error("export-receipt-identity-conflict");
      return;
    }
    await atomicWriteFile(path, `${JSON.stringify(receipt)}\n`);
  });
}

/** Reading never creates receipt directories or trusts the app's best-effort diagnostic log. */
export async function readCompletedExports(store: WorldStore): Promise<ReadinessExport[]> {
  let directory: string;
  try {
    directory = dirname(await containedWorldFilePath(store.dir, "exports/.completed/.probe", false, "export-receipt", true));
  } catch { return []; }
  const records: ReadinessExport[] = [];
  for (const name of await readdir(toExtendedLength(directory))) {
    if (!/^[A-Za-z0-9_-]{1,100}\.json$/.test(name)) continue;
    try {
      const path = await containedWorldFilePath(store.dir, `exports/.completed/${name}`, false, "export-receipt");
      const receipt = CompletedExportSchema.parse(JSON.parse(await readFile(toExtendedLength(path), "utf8")));
      if (receipt.worldId !== store.worldId || name !== `${receipt.id}.json`) continue;
      if (receipt.deliveryKind === "interactive") {
        if (receipt.output !== `exports/interactive-${receipt.productionId}-${receipt.id}`) continue;
        // Containment checks reject imported reparse points before the native package validator.
        await containedWorldFilePath(store.dir, `${receipt.output}/manifest.json`, false, "export-receipt");
        await containedWorldFilePath(store.dir, `${receipt.output}/player.html`, false, "export-receipt");
        if (!await interactiveExportCompleted(store, receipt.productionId, receipt.id)) continue;
      } else {
        await containedWorldFilePath(store.dir, receipt.output, false, "export-receipt");
      }
      const { version: _version, ...record } = receipt;
      records.push(record);
    } catch { /* A malformed receipt or missing delivery cannot prove a completed export. */ }
  }
  return records;
}
