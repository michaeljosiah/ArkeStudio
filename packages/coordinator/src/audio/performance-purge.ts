import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PerformanceIdSchema, PerformancePurgeSchema, PerformanceRecordSchema, SlugSchema, type Job } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { audioWorldPath } from "./storage.js";
import { appendFlushed } from "../flushed-append.js";

export async function performancePurges(dir: string, productionId: string) {
  SlugSchema.parse(productionId);
  const portable = `productions/${productionId}/performance-purges.jsonl`;
  try { await lstat(join(dir, portable)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const path = await audioWorldPath(dir, portable);
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (text && !text.endsWith("\n")) throw new Error("Performance purge history needs repair.");
  return text.split("\n").filter(Boolean).map(line => PerformancePurgeSchema.parse(JSON.parse(line)));
}
export async function requireUnpurgedPerformance(store: Pick<WorldStore, "dir">, productionId: string, id: string) {
  if ((await performancePurges(store.dir, productionId)).some(p => p.performanceId === id)) throw new Error("This performance has been purged. Capture a new recording.");
}

/** A checked sentinel verifies every parent, including junction containment, before a directory move or removal. */
async function directory(dir: string, portable: string) {
  return dirname(await audioWorldPath(dir, `${portable}/.containment-check`, true));
}
export async function removePartialPerformance(store: WorldStore, productionId: string, id: string) {
  SlugSchema.parse(productionId); PerformanceIdSchema.parse(id);
  await store.ownedWrite(async () => {
    const prefix = `productions/${productionId}/performances/${id}`;
    const manifest = await audioWorldPath(store.dir, `${prefix}/performance.json`, true);
    if (await lstat(manifest).catch(() => null)) return;
    await rm(await directory(store.dir, prefix), { recursive: true, force: true });
  });
}

/** The census intentionally keeps historical jobs and every current production authority. */
export async function purgePerformance(store: WorldStore, productionId: string, id: string, jobs: readonly Job[]) {
  SlugSchema.parse(productionId); PerformanceIdSchema.parse(id);
  await store.ownedWrite(async () => {
    const events = await performancePurges(store.dir, productionId);
    if (events.some(p => p.performanceId === id)) return;
    const production = store.getBundle().productions.find(p => p.meta.id === productionId);
    if (!production) throw new Error("This production is unavailable.");
    if (store.getBundle().problems.some(problem => (problem.path.startsWith(`productions/${productionId}/performance`) || problem.path.endsWith("/performance-bible.jsonl")))) throw new Error("Repair performance metadata before purging.");
    const { performances, ...authorities } = production;
    const references = [store.getBundle().performanceBibles ?? [], authorities, ...performances.filter(p => p.id !== id), ...jobs.filter(j => j.worldId === store.worldId)];
    if (references.some(value => JSON.stringify(value).includes(id))) throw new Error("This performance is referenced by a performance, selection, review, designation or job. Remove its dependencies first.");
    const prefix = `productions/${productionId}/performances/${id}`;
    PerformanceRecordSchema.parse(JSON.parse(await readFile(await audioWorldPath(store.dir, `${prefix}/performance.json`), "utf8")));
    const staged = await directory(store.dir, ".staging/performance-purge");
    const destination = `${staged}/${id}`;
    if (await lstat(destination).catch(() => null)) throw new Error("An interrupted purge needs recovery first.");
    await rename(await directory(store.dir, prefix), destination);
    // A failed sync is uncertain. Leave staging intact; recovery consults the durable tombstone.
    await appendFlushed(await audioWorldPath(store.dir, `productions/${productionId}/performance-purges.jsonl`, true),
      JSON.stringify(PerformancePurgeSchema.parse({ performanceId: id, purgedAt: new Date().toISOString(), reason: "user-request" })) + "\n");
    await rm(await directory(store.dir, `.staging/performance-purge/${id}`), { recursive: true, force: true });
  });
}

/** Called under ownership before the first scan. Never discards a paid conversion's replay material. */
export async function recoverPerformanceStorage(dir: string) {
  const recovered: string[] = [];
  const stage = await directory(dir, ".staging/performance-purge");
  for (const entry of await readdir(stage, { withFileTypes: true })) {
    if (!PerformanceIdSchema.safeParse(entry.name).success) continue;
    const prefix = `.staging/performance-purge/${entry.name}`;
    const record = PerformanceRecordSchema.parse(JSON.parse(await readFile(await audioWorldPath(dir, `${prefix}/performance.json`), "utf8")));
    if (record.id !== entry.name) throw new Error("Performance purge identity conflict.");
    const path = await directory(dir, prefix);
    recovered.push(`productions/${record.target.productionId}/performances/${record.id}/performance.json`);
    if ((await performancePurges(dir, record.target.productionId)).some(p => p.performanceId === record.id)) {
      await rm(path, { recursive: true, force: true });
    } else {
      const destination = await audioWorldPath(dir, `productions/${record.target.productionId}/performances/${record.id}`, true).catch(() => null);
      if (!destination) throw new Error("Performance purge recovery destination is occupied.");
      await rename(path, destination);
    }
  }
  const productions = await directory(dir, "productions");
  for (const production of await readdir(productions, { withFileTypes: true })) {
    if (!production.isDirectory() || !SlugSchema.safeParse(production.name).success) continue;
    const parent = await directory(dir, `productions/${production.name}/performances`);
    const purges = await performancePurges(dir, production.name);
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!PerformanceIdSchema.safeParse(entry.name).success) continue;
      const prefix = `productions/${production.name}/performances/${entry.name}`;
      const path = await directory(dir, prefix);
      if (purges.some(p => p.performanceId === entry.name)) { recovered.push(`${prefix}/performance.json`); await rm(path, { recursive: true, force: true }); continue; }
      if (await lstat(await audioWorldPath(dir, `${prefix}/performance.json`, true)).catch(() => null)) continue;
      // Conversion input/landing must survive until the durable queue replays finalization.
      const source = await readFile(await audioWorldPath(dir, `${prefix}/source.json`, true), "utf8").catch(() => null);
      const metadata = source ? JSON.parse(source) as { target?: unknown; operationId?: string; jobId?: string } : null;
      if (!metadata || metadata.jobId || (!metadata.target && !metadata.operationId)) continue;
      await rm(path, { recursive: true, force: true });
    }
  }
  return recovered;
}
