import { ArkeGenerationResultSchema, SessionIdSchema, TakeIdSchema, type Job, type WorldBundle, type BenchSession } from "@arke-studio/contracts";
import { sessionMediaDir } from "../bench/store.js";
import { readBenchSession } from "../bench/chat-reads.js";
import type { WorldStore } from "../world/store.js";

/** Only the sealed purchase's finalized jobs may expose their owning domain's immutable output. */
export function generationCardResults(store: Pick<WorldStore, "dir" | "getBundle">, jobs: readonly Job[],
  bench: (id: string) => BenchSession | null = id => readBenchSession(store.dir, id)) {
  const world: WorldBundle = store.getBundle();
  return jobs.flatMap(job => {
    if (job.worldId !== world.meta.worldId || job.status !== "succeeded" || (job.finalization && job.finalization.status !== "complete")) return [];
    const production = world.productions.find(p => p.meta.id === job.productionId);
    const performance = job.target.kind === "performance-generation" ? production?.performances.find(p => p.id === job.target.id && p.kind !== "scratch" && p.jobId === job.id) : undefined;
    let result: unknown;
    if (performance) result = { id: performance.id, medium: "audio", status: "completed", description: `Dialogue · ${performance.target.speakerSheetId}`,
      mediaPath: `productions/${production!.meta.id}/performances/${performance.id}/${performance.file}` };
    else if (job.target.kind === "table-read-cache" && typeof job.params.tableReadCacheFile === "string" && job.landedFiles?.includes(job.params.tableReadCacheFile)) result = {
      id: job.id, medium: "audio", status: "completed", description: "Scene rehearsal", mediaPath: job.params.tableReadCacheFile,
    };
    else if (job.target.kind === "bench-take") {
      const [sessionId, takeId, extra] = job.target.id?.split("/") ?? [];
      if (extra || !SessionIdSchema.safeParse(sessionId).success || !TakeIdSchema.safeParse(takeId).success) return [];
      let session: BenchSession | null;
      try { session = bench(sessionId!); } catch { return []; }
      const take = session?.takes.find(t => t.id === takeId && t.jobId === job.id && t.status === "succeeded" && t.disposition !== "discarded");
      if (!session || session.id !== sessionId || !take?.media) return [];
      result = { id: take.id, medium: take.request.mode === "image" ? "image" : take.request.mode === "video" ? "video" : "audio",
        status: "completed", description: `${take.request.mode} · Take ${take.n}`, mediaPath: `${sessionMediaDir(session.id, take.id)}/${take.media.file}` };
    } else return [];
    const parsed = ArkeGenerationResultSchema.safeParse(result);
    return parsed.success ? [parsed.data] : [];
  });
}
