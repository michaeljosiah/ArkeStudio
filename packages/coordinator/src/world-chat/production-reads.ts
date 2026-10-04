import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FrameRunSchema, SlugSchema, foldFrameRun, type Job, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { conversationActionDigest } from "../arke-actions/digest.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";

export interface ProductionReadRow { readonly key: string; readonly value: unknown }
const numbered = (index: number) => String(index).padStart(10, "0");
export const productionReadFence = (rows: readonly ProductionReadRow[]) => conversationActionDigest(rows);

/** Read the same durable runs for retrieval and approval, without exposing provider inputs. */
export function frameRunReadRows(store: Pick<WorldStore, "dir" | "worldId">, productionId: string,
  jobs: readonly Pick<Job, "id" | "worldId" | "productionId" | "status" | "finalization">[]): ProductionReadRow[] {
  SlugSchema.parse(productionId);
  const dir = toExtendedLength(join(store.dir, "productions", productionId, "runs"));
  let files: string[];
  try { files = readdirSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const rows: ProductionReadRow[] = [];
  const facts = jobs.filter(job => job.worldId === store.worldId && job.productionId === productionId)
    .map(job => ({ id: job.id, status: job.status, finalization: job.finalization?.status }));
  for (const file of files.filter(file => file.endsWith(".json")).sort()) {
    const run = FrameRunSchema.parse(JSON.parse(readFileSync(toExtendedLength(join(dir, file)), "utf8")));
    if (file !== `${run.id}.json` || run.steps.some(step => step.dispatch.worldId !== store.worldId || step.dispatch.productionId !== productionId)) continue;
    const state = foldFrameRun(run, facts);
    rows.push({ key: `${run.createdAt}:${run.id}:0`, value: { kind: "frame-run", runId: run.id, sceneId: run.sceneId,
      mode: run.mode, modelId: run.model, cursor: run.cursor, paused: run.paused,
      cancelled: run.cancelled, dismissed: run.dismissed ?? false, status: state.status, createdAt: run.createdAt,
      completedSteps: state.completedSteps, failedSteps: state.failedSteps } });
    run.steps.forEach((step, index) => {
      const folded = state.steps[index]!;
      rows.push({ key: `${run.createdAt}:${run.id}:1:${numbered(index)}`, value: { kind: "frame-run-step", runId: run.id,
        stepIndex: index, sourceStepIndex: step.sourceStepIndex, retryOf: step.retryOf ?? null,
        requestShotIds: step.requestShotIds, updateShotIds: step.updateShotIds, jobId: step.jobId ?? null,
        status: folded.status, canRetry: folded.canRetry, canRetryCell: folded.canRetryCell,
        shots: folded.shots.map(({ shotId, status, canRetryCell, landingOutcome }) => ({ shotId, status, canRetryCell, landingOutcome })) } });
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

export function performanceReadRows(production: ProductionBundle | undefined): ProductionReadRow[] {
  if (!production) return [];
  return [
    ...production.performances.map(performance => ({ key: `0:${performance.id}`, value: { kind: "performance", performance } })),
    ...production.performanceReview.reviews.map((review, index) => ({ key: `1:${numbered(index)}`, value: { kind: "performance-review", review } })),
    ...Object.entries(production.performanceReview.selections).sort(([a], [b]) => a.localeCompare(b))
      .map(([target, selection]) => ({ key: `2:${target}`, value: { kind: "performance-selection", target, selection } })),
  ].sort((a, b) => a.key.localeCompare(b.key));
}

export function voiceSampleReadRows(bundle: WorldBundle): ProductionReadRow[] {
  return bundle.referenceKits.filter(kit => kit.designatedVoiceSample !== undefined)
    .sort((a, b) => a.sheetId.localeCompare(b.sheetId))
    .map(kit => ({ key: kit.sheetId, value: { sheetId: kit.sheetId, sample: kit.designatedVoiceSample } }));
}

export function audioCutReadRows(production: ProductionBundle | undefined): ProductionReadRow[] {
  return (production?.cut.audio ?? []).map((track, index) => ({ key: numbered(index), value: track }));
}

export function editorRequestReadRows(production: ProductionBundle | undefined): ProductionReadRow[] {
  return [...(production?.editorRequests ?? [])].sort((a, b) => a.id.localeCompare(b.id))
    .map(request => ({ key: request.id, value: request }));
}
