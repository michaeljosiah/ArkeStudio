import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ulid, type Job, type ShotPlanEntry, type Take } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";

/**
 * Take arrival (SPEC-013 §2.2, §2.3): SPEC-009 landed verified media; this writes the
 * immutable take record beside it and, for passes, derives virtual segments — ranges from the
 * pre-dispatch shot plan, never files, never inspection (R-3, R-4, D2, D3).
 */

interface Provenance {
  canonRevision: number;
  sheets: Record<string, number>;
}

function provenanceOf(job: Job): Provenance {
  const p = job.params["provenance"] as Provenance | undefined;
  return p ?? { canonRevision: 0, sheets: {} };
}

function takeKindFor(job: Job): Take["kind"] {
  if (job.target.kind === "voice-line" || job.target.kind === "voice-preview") return "voice";
  if (job.capability === "image") return "frame";
  return "clip";
}

/**
 * Write the take (and segments for a pass) from a succeeded job. Media is moved from the
 * landing dir into the take's own directory; take.json is written once and never again (R-1).
 * Returns every take written, pass first.
 */
export async function recordTakesFromJob(store: WorldStore, job: Job, actualMicroUsd: number | null): Promise<Take[]> {
  if (job.status !== "succeeded" || job.productionId === undefined) return [];
  const media = job.landedFiles?.[0];
  if (media === undefined) return [];
  const shotPlan = job.params["shotPlan"] as ShotPlanEntry[] | undefined;
  const provenance = provenanceOf(job);
  const now = store.now();
  const mediaName = media.split("/").pop()!;
  const written: Take[] = [];

  await store.gateOp(async () => {
    const primaryId = `tk_${ulid()}`;
    const takeDir = join(store.dir, "productions", job.productionId!, "takes", primaryId);
    // The landed file moves into the take's own directory — one stored artifact (R-3).
    await atomicWriteFile(join(takeDir, ".keep"), "");
    await rename(toExtendedLength(join(store.dir, media)), toExtendedLength(join(takeDir, mediaName)));
    const { rm } = await import("node:fs/promises");
    await rm(toExtendedLength(join(takeDir, ".keep")), { force: true }).catch(() => {});
    await rm(toExtendedLength(dirname(join(store.dir, media))), { recursive: true, force: true }).catch(() => {});

    const base = {
      jobId: job.id,
      provider: job.provider,
      model: job.model,
      provenance,
      ...(typeof job.params["prompt"] === "string" ? { prompt: job.params["prompt"] as string } : {}),
      references: (job.params["references"] as string[] | undefined) ?? [],
      params: {},
      dispatchedAt: job.createdAt,
      completedAt: now,
    };

    const primary: Take = {
      id: primaryId,
      ...base,
      coversShots: (job.target.coversShots ?? (job.target.id !== undefined ? [job.target.id] : [])) as Take["coversShots"],
      kind: takeKindFor(job),
      cost: {
        estimatedMicroUsd: job.estimatedMicroUsd,
        actualMicroUsd,
        ...(actualMicroUsd !== null ? { actualSource: "manifest-derived" as const } : {}),
      },
      media: mediaName,
    };
    await atomicWriteFile(join(takeDir, "take.json"), JSON.stringify(primary, null, 2) + "\n");
    written.push(primary);

    // A pass derives per-shot segment takes: ranges within the pass media (R-3), boundaries
    // from the plan (R-4), costs pro-rata and marked allocated, summing exactly (R-5, D4).
    if (job.target.kind === "scene-pass" && shotPlan && shotPlan.length > 0) {
      const chargeBase = actualMicroUsd ?? job.estimatedMicroUsd;
      const totalSec = shotPlan.reduce((a, p) => a + (p.endSec - p.startSec), 0);
      let allocatedSoFar = 0;
      for (const [i, entry] of shotPlan.entries()) {
        const isLast = i === shotPlan.length - 1;
        const share = isLast
          ? chargeBase - allocatedSoFar // the remainder lands on the last segment: exact sum
          : Math.floor((chargeBase * (entry.endSec - entry.startSec)) / totalSec);
        allocatedSoFar += share;
        const segmentId = `tk_${ulid()}`;
        const segment: Take = {
          id: segmentId,
          ...base,
          coversShots: [entry.shotId] as Take["coversShots"],
          kind: "clip",
          cost: {
            estimatedMicroUsd: share,
            actualMicroUsd: share,
            actualSource: "manifest-derived",
            allocated: true,
          },
          segment: { passTakeId: primaryId, inSec: entry.startSec, outSec: entry.endSec },
        };
        const segmentDir = join(store.dir, "productions", job.productionId!, "takes", segmentId);
        await atomicWriteFile(join(segmentDir, "take.json"), JSON.stringify(segment, null, 2) + "\n");
        written.push(segment);
      }
    }
  });
  return written;
}
