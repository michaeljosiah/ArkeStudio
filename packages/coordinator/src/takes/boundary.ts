/**
 * Boundary frames (issue 154): the durable still that lets one shot open where the last ended.
 *
 * Continuity chaining used to write only `startFrameTakeId` — a pointer at footage. Footage is
 * not a frame: the board tried to decode an .mp4 as a PNG and silently drew a gap, and nothing
 * could ever travel to a provider. This module cuts the actual picture — the final frame of an
 * accepted clip, or the frame at a pass segment's out-point — and files it as an image artifact
 * with extraction provenance, so the selection can name a picture that exists, hashes, and
 * survives its source take being deleted.
 *
 * The posture is `takes/poster.ts`'s: bounded, total, and never a thrown exception. Extraction
 * runs after an accept, which must not be failable by a diagnostic — a refusal here is a named
 * reason and an unchanged selection, never a lost decision. Nothing in this file spends provider
 * money; that is the point of extracting locally.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ulid, type ArtifactSidecar, type ProductionBundle, type Take } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import type { MediaProbeRunner } from "./qc.js";
import { isVideoMedia } from "./poster.js";

/** Wall clock for one extraction. Decoding tenths of a second of video does not take this long. */
export const BOUNDARY_TIMEOUT_MS = 20_000;
/** ffmpeg writes the picture to a file; stdout is diagnostics, and a megabyte of those is a fault. */
export const BOUNDARY_MAX_OUTPUT_BYTES = 1_048_576;
/** The method stamped into extraction provenance, versioned so a better cutter supersedes. */
export const BOUNDARY_METHOD = "ffmpeg-frame/1";

/**
 * The command, as an argument array — never a shell string, for the same reason as the poster's.
 *
 * `atSec === null` means the clip's own final frame: seek to half a second before the end and
 * let `-update 1` overwrite the output with every decoded frame, so the last one standing IS the
 * last frame. A segment boundary seeks just short of its out-point and takes one frame — the
 * picture the next shot opens on is the picture at the cut. No scale filter: this is the shot's
 * opening image, not a thumbnail, and downscaling it would feed the model less than the clip had.
 */
export function boundaryFrameArgs(input: string, output: string, atSec: number | null): string[] {
  const seek = atSec === null ? ["-sseof", "-0.5"] : ["-ss", Math.max(0, atSec - 0.05).toFixed(3)];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...seek,
    "-i",
    input,
    "-map",
    "0:v:0",
    ...(atSec === null ? [] : ["-frames:v", "1"]),
    "-update",
    "1",
    "-y",
    output,
  ];
}

export type BoundaryFrameUnavailableReason = "not-configured" | "timeout" | "process-failed";

export interface BoundaryFrameMaker {
  /** Cut `output` from `input`. Resolves either way; the reason is for the log. Absolute paths. */
  write(
    input: string,
    output: string,
    atSec: number | null,
  ): Promise<{ ok: true } | { ok: false; reason: BoundaryFrameUnavailableReason }>;
}

export function createBoundaryFrameMaker(runner: MediaProbeRunner): BoundaryFrameMaker {
  return {
    write: async (input, output, atSec) => {
      let result;
      try {
        result = await runner.run(boundaryFrameArgs(input, output, atSec), {
          timeoutMs: BOUNDARY_TIMEOUT_MS,
          maxOutputBytes: BOUNDARY_MAX_OUTPUT_BYTES,
        });
      } catch {
        return { ok: false, reason: "process-failed" };
      }
      if (result.timedOut) return { ok: false, reason: "timeout" };
      if (result.code !== 0) return { ok: false, reason: "process-failed" };
      return { ok: true };
    },
  };
}

export type BoundaryChainResult =
  | { ok: true; artifactId: string; followingShotId: string }
  | { ok: false; reason: string };

export type BoundaryExtractResult =
  | { ok: true; artifactId: string; hash: string; file: string }
  | { ok: false; reason: string };

/**
 * Cut a take's boundary still and file it durably — the extraction half alone (SPEC-024 R-18):
 * dispatch plans gate passes on this artifact without touching any shot's selection. Total,
 * named failures, no provider money anywhere near it.
 */
export async function extractBoundaryArtifact(
  store: WorldStore,
  production: ProductionBundle,
  input: {
    take: Take;
    /** Lands in the artifact's filename, so two consumers never collide on a name. */
    label: string;
    maker: BoundaryFrameMaker | undefined;
    clock: () => string;
  },
): Promise<BoundaryExtractResult> {
  const { take, label, maker, clock } = input;
  if (maker === undefined) return { ok: false, reason: "not-configured" };

  const mediaTakeId = take.segment?.passTakeId ?? take.id;
  const mediaTake = take.segment !== undefined ? production.takes.find((t) => t.id === mediaTakeId) : take;
  const media = mediaTake?.media;
  if (media === undefined) return { ok: false, reason: `take ${mediaTakeId} has no media to cut a frame from` };
  if (!isVideoMedia(media)) return { ok: false, reason: `take ${mediaTakeId}'s media is not footage` };
  const atSec = take.segment?.outSec ?? null;

  const inputPath = join(store.dir, "productions", production.meta.id, "takes", mediaTakeId, media);
  const stagingDir = join(store.dir, ".cache", "boundary");
  const stagingPath = join(stagingDir, `${ulid()}.png`);
  try {
    await mkdir(toExtendedLength(stagingDir), { recursive: true });
  } catch {
    return { ok: false, reason: "could not stage the extraction" };
  }
  try {
    const outcome = await maker.write(toExtendedLength(inputPath), toExtendedLength(stagingPath), atSec);
    if (!outcome.ok) return { ok: false, reason: `extraction from take ${mediaTakeId} failed: ${outcome.reason}` };

    let png: Buffer;
    try {
      png = await readFile(toExtendedLength(stagingPath));
    } catch {
      return { ok: false, reason: `extraction from take ${mediaTakeId} wrote nothing` };
    }
    if (png.byteLength === 0) return { ok: false, reason: `extraction from take ${mediaTakeId} wrote an empty file` };

    const stamp = clock().replace(/[-:TZ.]/g, "").slice(0, 14);
    const file = `boundary-${label}-${stamp}.png`;
    const sidecar: ArtifactSidecar = {
      id: `ar_${ulid()}`,
      kind: "image",
      file,
      hash: `sha256:${createHash("sha256").update(png).digest("hex").slice(0, 16)}`,
      origin: { by: "system", producedBy: `boundary-frame:${take.id}` },
      links: [production.meta.id, take.id],
      production: production.meta.id,
      boundaryExtraction: {
        sourceTakeId: take.id,
        mediaTakeId,
        atSec,
        method: BOUNDARY_METHOD,
      },
      created: clock(),
    };
    await store.gateOp(async () => {
      await atomicWriteFile(join(store.dir, "artifacts", file), png);
      await store.commitUnserialised({
        kind: "boundary-frame",
        source: `boundary-frame:${take.id}`,
        files: [
          {
            path: `artifacts/${file}.json`,
            action: "create",
            content: JSON.stringify(sidecar, null, 2) + "\n",
            baseHash: null,
          },
        ],
      });
    });
    return { ok: true, artifactId: sidecar.id, hash: sidecar.hash, file };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(toExtendedLength(stagingPath), { force: true }).catch(() => {});
  }
}

/**
 * Cut the boundary frame an accepted take seeds the following shot with, file it durably, and
 * point the following shot's selection at it — one artifact plus one selection write, in one
 * commit, so a crash between them cannot leave a selection naming bytes that were never filed.
 *
 * The source of the picture follows review.ts's continuity rule: a pass segment's frame comes
 * from the pass media at the segment's out-point; a plain clip's from its own final frame. The
 * legacy `startFrameTakeId` the accept already wrote stays untouched — it still steers models
 * with no frame route — and `startFrameArtifactId` lands beside it.
 *
 * Total: every failure is a named reason, the selection keeps what the accept wrote, and no
 * provider money is at stake anywhere in here.
 */
export async function chainBoundaryFrame(
  store: WorldStore,
  production: ProductionBundle,
  input: {
    take: Take;
    followingShotId: string;
    maker: BoundaryFrameMaker | undefined;
    clock: () => string;
  },
): Promise<BoundaryChainResult> {
  const { take, followingShotId, maker, clock } = input;
  if (maker === undefined) return { ok: false, reason: "not-configured" };

  // The media actually decoded: the pass clip for a segment, the take's own file otherwise.
  const mediaTakeId = take.segment?.passTakeId ?? take.id;
  const mediaTake = take.segment !== undefined ? production.takes.find((t) => t.id === mediaTakeId) : take;
  const media = mediaTake?.media;
  if (media === undefined) return { ok: false, reason: `take ${mediaTakeId} has no media to cut a frame from` };
  if (!isVideoMedia(media)) return { ok: false, reason: `take ${mediaTakeId}'s media is not footage` };
  const atSec = take.segment?.outSec ?? null;

  const inputPath = join(store.dir, "productions", production.meta.id, "takes", mediaTakeId, media);
  const stagingDir = join(store.dir, ".cache", "boundary");
  const stagingPath = join(stagingDir, `${ulid()}.png`);
  try {
    await mkdir(toExtendedLength(stagingDir), { recursive: true });
  } catch {
    return { ok: false, reason: "could not stage the extraction" };
  }
  try {
    const outcome = await maker.write(toExtendedLength(inputPath), toExtendedLength(stagingPath), atSec);
    if (!outcome.ok) return { ok: false, reason: `extraction from take ${mediaTakeId} failed: ${outcome.reason}` };

    let png: Buffer;
    try {
      png = await readFile(toExtendedLength(stagingPath));
    } catch {
      return { ok: false, reason: `extraction from take ${mediaTakeId} wrote nothing` };
    }
    if (png.byteLength === 0) return { ok: false, reason: `extraction from take ${mediaTakeId} wrote an empty file` };

    const stamp = clock().replace(/[-:TZ.]/g, "").slice(0, 14);
    const file = `boundary-${followingShotId}-${stamp}.png`;
    const sidecar: ArtifactSidecar = {
      id: `ar_${ulid()}`,
      kind: "image",
      file,
      hash: `sha256:${createHash("sha256").update(png).digest("hex").slice(0, 16)}`,
      origin: { by: "system", producedBy: `boundary-frame:${take.id}` },
      links: [production.meta.id, followingShotId, take.id],
      production: production.meta.id,
      boundaryExtraction: {
        sourceTakeId: take.id,
        mediaTakeId,
        atSec,
        method: BOUNDARY_METHOD,
      },
      created: clock(),
    };

    const selectionsPath = `productions/${production.meta.id}/selections.json`;
    await store.gateOp(async () => {
      await atomicWriteFile(join(store.dir, "artifacts", file), png);
      let selectionsRaw: string;
      let existed = true;
      try {
        selectionsRaw = await readFile(toExtendedLength(join(store.dir, selectionsPath)), "utf8");
      } catch {
        selectionsRaw = "{}";
        existed = false;
      }
      const selections = JSON.parse(selectionsRaw) as Record<string, Record<string, unknown>>;
      selections[followingShotId] = {
        trimInSec: 0,
        ...selections[followingShotId],
        startFrameArtifactId: sidecar.id,
      };
      await store.commitUnserialised({
        kind: "boundary-frame",
        source: `boundary-frame:${take.id}`,
        files: [
          {
            path: `artifacts/${file}.json`,
            action: "create",
            content: JSON.stringify(sidecar, null, 2) + "\n",
            baseHash: null,
          },
          {
            path: selectionsPath,
            action: existed ? "replace" : "create",
            content: JSON.stringify(selections, null, 2) + "\n",
            baseHash: existed ? sha256(selectionsRaw) : null,
          },
        ],
      });
    });
    return { ok: true, artifactId: sidecar.id, followingShotId };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(toExtendedLength(stagingPath), { force: true }).catch(() => {});
  }
}
