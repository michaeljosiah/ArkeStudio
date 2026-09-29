import { ProductionNarrativeSchema, productionShape, type ProductionNarrative } from "@arke-studio/contracts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";

/** A direct author edit, guarded by the version the editor read, on the normal history track. */
export async function saveProductionNarrative(
  world: WorldStore,
  productionId: string,
  expectedVersion: number | null,
  narrative: Omit<ProductionNarrative, "version">,
): Promise<void> {
  const production = world.getBundle().productions.find(item => item.meta.id === productionId);
  if (!production || productionShape(production.meta).medium !== "video" || productionShape(production.meta).isEpisodic) {
    throw new Error("A film narrative belongs to a non-episodic video production.");
  }
  const path = `productions/${production.meta.id}/narrative.json`;
  const raw = await readFile(toExtendedLength(join(world.dir, fromPortable(path))), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const current = raw === null ? null : ProductionNarrativeSchema.parse(JSON.parse(raw));
  if ((current?.version ?? null) !== expectedVersion) throw new Error("The film narrative changed. Reopen it before saving.");
  const record = ProductionNarrativeSchema.parse({ ...narrative, version: expectedVersion ?? 1 });
  await world.commit({
    kind: "narrative-edit", source: "editor", files: [{
      path, action: raw === null ? "create" : "replace", baseHash: raw === null ? null : sha256(raw),
      content: `${JSON.stringify(record, null, 2)}\n`,
    }],
  }, undefined, () => {
    const currentProduction = world.getBundle().productions.find(item => item.meta.id === productionId);
    return currentProduction && productionShape(currentProduction.meta).medium === "video" && !productionShape(currentProduction.meta).isEpisodic
      ? null : "This production changed format. Reopen its Overview before saving.";
  });
}
