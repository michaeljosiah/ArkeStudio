import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ulid, type Job, type ShotPlanEntry, type Take, type TakeQc } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import type { TakeQcAnalyzer, TakeQcUnavailableReason } from "./qc.js";
import { writePosterFor, type TakePosterMaker, type TakePosterUnavailableReason } from "./poster.js";

/**
 * Take arrival (SPEC-013 §2.2, §2.3): SPEC-009 landed verified media; this writes the
 * immutable take record beside it and, for passes, derives virtual segments — ranges from the
 * pre-dispatch shot plan, never files, never inspection (R-3, R-4, D2, D3).
 */

interface Provenance {
  canonRevision: number;
  sheets: Record<string, number>;
  artDirectionVersion?: number;
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

export interface TakeArrivalOptions {
  /** Absent on any build without ffmpeg, which is most of them — see takes/qc.ts. */
  analyzer?: TakeQcAnalyzer;
  /** Told why a measurement is missing, so "not measured" is explicable rather than silent. */
  onQcUnavailable?: (reason: TakeQcUnavailableReason) => void;
  /** Absent on any build without ffmpeg, exactly as the analyzer is — see takes/poster.ts. */
  poster?: TakePosterMaker;
  /** Told why a video take has no picture beside it, for the same reason as the measurement. */
  onPosterUnavailable?: (reason: TakePosterUnavailableReason) => void;
}

/**
 * The parts of a dispatch that already have somewhere better to live, and so are not settings.
 *
 * `prompt` and `text` are the take's prompt, `references` its references, `provenance` its
 * provenance, and `shotPlan` describes a pass's segments rather than how it was generated.
 * Everything else — duration, aspect, resolution, sound, seed, voice — describes how to make
 * this again, which is the whole point of keeping it.
 */
const NOT_A_SETTING = new Set(["prompt", "text", "references", "provenance", "shotPlan"]);

function settingsFrom(params: Job["params"]): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (NOT_A_SETTING.has(key) || value === undefined) continue;
    settings[key] = value;
  }
  return settings;
}

/** Only a video clip has motion to measure; a still or a voice line has no question to ask. */
function qcApplies(job: Job): boolean {
  return job.capability === "video" && (job.target.kind === "shot" || job.target.kind === "scene-pass");
}

/**
 * The measurement, or null with the reason reported. Total: every path here returns rather than
 * throws, including the reporting itself — a logging failure that lost a paid take would be an
 * absurd trade, and this is the boundary where that trade would otherwise be made.
 */
async function measureArrival(file: string | null, options: TakeArrivalOptions): Promise<TakeQc | null> {
  const notify = (reason: TakeQcUnavailableReason): void => {
    try {
      options.onQcUnavailable?.(reason);
    } catch {
      /* a diagnostic that fails is still only a diagnostic */
    }
  };
  if (file === null) return null; // Not a video shot or pass: no reason to report, nothing asked.
  if (options.analyzer === undefined) {
    notify("not-configured");
    return null;
  }
  try {
    const analysis = await options.analyzer.analyze(file);
    if (analysis.ok) return analysis.qc;
    notify(analysis.reason);
    return null;
  } catch {
    notify("process-failed");
    return null;
  }
}

/**
 * Write the take (and segments for a pass) from a succeeded job. Media is moved from the
 * landing dir into the take's own directory; take.json is written once and never again (R-1).
 * Returns every take written, pass first.
 */
export async function recordTakesFromJob(
  store: WorldStore,
  job: Job,
  actualMicroUsd: number | null,
  options: TakeArrivalOptions = {},
): Promise<Take[]> {
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

    // Measured once, against the file that arrived, before any take.json exists — a take is
    // immutable, so the only moment to record this is before it is written (#248). Every
    // failure below is swallowed by design: finalization is not replayable, and a paid clip
    // must never be lost to a diagnostic that could not run.
    const qc = await measureArrival(qcApplies(job) ? join(takeDir, mediaName) : null, options);

    // The picture every screen shows for this take. Drawn here, beside the clip, for the same
    // reason the measurement is: the take is about to become immutable, and this is the last
    // moment its media is known to be in one known place. Best-effort throughout — a take with
    // no poster is the state every reader already handles.
    await writePosterFor(join(takeDir, mediaName), options.poster, options.onPosterUnavailable);

    const base = {
      jobId: job.id,
      provider: job.provider,
      model: job.model,
      provenance,
      // A spoken job's prompt is its line: it travels as `text`, because that is what a
      // synthesis endpoint calls it. Without this fallback a landed read recorded no words at
      // all, and nothing on disk could say what had been said.
      ...(typeof job.params["prompt"] === "string"
        ? { prompt: job.params["prompt"] as string }
        : typeof job.params["text"] === "string"
          ? { prompt: job.params["text"] as string }
          : {}),
      references: (job.params["references"] as string[] | undefined) ?? [],
      // How it was made: everything the dispatch carried that is not already a field of its own.
      //
      // Stated as an exclusion rather than a list of settings to keep. A list would have to be
      // edited every time a model gains a control — and the one that was missed would be missing
      // from the record silently, which is exactly how `durationSec`, the aspect and the
      // resolution came to be dropped while the schema and the fixtures both showed them being
      // kept. A new setting is recorded the day it is dispatched, with nobody remembering to.
      params: settingsFrom(job.params),
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
      ...(qc !== null ? { qc } : {}),
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
          // The same source-media measurement, not a per-segment one: the pass media was
          // analyzed once, and decoding each range separately would report numbers nobody took.
          ...(qc !== null ? { qc } : {}),
        };
        const segmentDir = join(store.dir, "productions", job.productionId!, "takes", segmentId);
        await atomicWriteFile(join(segmentDir, "take.json"), JSON.stringify(segment, null, 2) + "\n");
        written.push(segment);
      }
    }
  });
  return written;
}
