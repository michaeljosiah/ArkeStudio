import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  ulid,
  type ArtifactSidecar,
  type ProductionBundle,
  type ReviewDecision,
  type Take,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { BoundaryFrameMaker } from "./boundary.js";
import type { WorldStore } from "../world/store.js";

/**
 * The picture a shot was *given* to open on (SPEC-036 R-20, R-21).
 *
 * Its sibling `boundary.ts` cuts a still out of the previous shot's footage so a cut can open
 * where the last one ended. This files the other kind: a still generated *for this shot* — by a
 * frame run, or accepted by hand from the contact sheet — as the picture it opens on.
 *
 * Both land in the same place, `startFrameArtifactId`, because both answer the same question and
 * the dispatch can only send an artifact: the request records `{id, hash}` so the exact bytes can
 * be audited afterwards, and a take carries no hash to record. Filing here is what earns a drawn
 * frame the same durability the chained one already has — its own bytes, its own hash, and a life
 * independent of the take it came from.
 *
 * What tells the two apart afterwards is provenance already on the sidecar: a boundary still
 * carries `boundaryExtraction`, and a drawn frame does not. `hasOwnFrame` reads exactly that, so
 * the continuity chain can decline to overwrite a picture somebody chose.
 *
 * The posture is boundary.ts's, for the same reason: this runs after work that already
 * succeeded and already cost money, so it is total. Every failure is a named reason and an
 * unchanged selection, never a thrown exception that loses the landing.
 */

/** Image media a still can arrive as. Anything else is not a picture and is refused by name. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/**
 * The per-shot authorization snapshot a frame-run job carries (SPEC-036 §2.7, R-22).
 *
 * The durable enqueue shape nests it inside the frozen step request — `params: { frameRun,
 * landing, request }` — because the whole point of the snapshot is to be part of what was
 * frozen at authorization. A hand-enqueued one-shot may carry it at the top level instead.
 * Both are honoured, the frozen request first; reading only the top level is how the fence
 * silently disarms for every real frame run.
 */
export function slotAtAuthorizationOf(
  params: Record<string, unknown>,
): Record<string, string | null> | undefined {
  const request = params["request"];
  const nested =
    typeof request === "object" && request !== null
      ? (request as Record<string, unknown>)["slotAtAuthorization"]
      : undefined;
  const found = nested ?? params["slotAtAuthorization"];
  return typeof found === "object" && found !== null
    ? (found as Record<string, string | null>)
    : undefined;
}

export type DrawnFrameOutcome =
  | { ok: true; artifactId: string; shotId: string }
  /**
   * The slot moved after this work was authorized, so the result stays history and nothing was
   * filed (SPEC-036 R-22, T-18). Not a failure — the newer decision won, which is the rule —
   * so callers can tell "went wrong" from "was overtaken" and log neither as an error.
   */
  | { ok: true; superseded: true; shotId: string; reason: string }
  | { ok: false; reason: string };

/**
 * File a take's still as this shot's frame, and point the selection at it — the artifact and the
 * selection in one commit, so a crash between them cannot leave a selection naming bytes that
 * were never filed.
 */
export async function fileDrawnFrame(
  store: WorldStore,
  production: ProductionBundle,
  input: {
    /** The take that came back. Its media is the picture; it stays untouched and browsable. */
    take: Take;
    shotId: string;
    /** What produced it, for the sidecar's origin line — a run id, or the accept. */
    producedBy: string;
    /**
     * The frame slot as it stood when this work was authorized (SPEC-036 R-22).
     *
     * A frame run can be in flight for a minute while somebody accepts a different frame for
     * the same shot, and two runs can finish out of the order they were dispatched. Without
     * this, *completion* order decides what a shot opens on rather than *authorization* order,
     * and a slow job silently overwrites a choice made after it was sent.
     *
     * `undefined` means no fence — an explicit foreground act, which is allowed to replace
     * whatever is there because the person is looking at it when they press.
     */
    expectedArtifactId?: string | null;
    /**
     * Extra files landing in the SAME commit — the accept's review append (SPEC-013 R-9, D6).
     *
     * A still's decision and its frame are one act. Committed separately they leave a crash
     * window where the durable review says the take was accepted while the slot still names
     * the old frame, which is the divergence the one-commit rule exists to prevent.
     */
    alsoCommit?: readonly {
      path: string;
      action: "create" | "replace";
      content: string;
      baseHash: string | null;
    }[];
    /**
     * Normalises a non-PNG still to PNG while filing. The board compiler reads every filed
     * frame through `decodePng` and swallows the decode error, so a JPEG or WebP filed raw
     * becomes a blank cell in every compiled board — valid provider output, silently absent.
     * The boundary maker already is an image-to-PNG converter when asked for frame zero, so
     * the one ffmpeg the app ships does the job. Absent, or on failure, the original bytes
     * file unchanged: a good frame is never lost to a failed conversion.
     */
    toPng?: BoundaryFrameMaker;
  },
): Promise<DrawnFrameOutcome> {
  const { take, shotId } = input;
  if (take.kind !== "frame" && take.kind !== "still") {
    return { ok: false, reason: `take ${take.id} is ${take.kind}, not a still` };
  }
  const media = take.media;
  if (media === undefined) return { ok: false, reason: `take ${take.id} has no media to file` };
  let extension = extname(media).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    return { ok: false, reason: `take ${take.id}'s media is not an image` };
  }

  const mediaPath = join(store.dir, "productions", production.meta.id, "takes", take.id, media);
  let bytes: Buffer | null = null;
  if (extension !== ".png" && input.toPng !== undefined) {
    // Frame zero of a still image IS that image, so the boundary cutter converts it.
    const staging = join(store.dir, ".cache", "frames", `${ulid()}.png`);
    try {
      await mkdir(toExtendedLength(join(store.dir, ".cache", "frames")), { recursive: true });
      const converted = await input.toPng.write(mediaPath, staging, 0);
      if (converted.ok) {
        const png = await readFile(toExtendedLength(staging));
        if (png.byteLength > 0) {
          bytes = png;
          extension = ".png";
        }
      }
    } catch {
      // Fall through to the original bytes; the take's own media is always the safe answer.
    } finally {
      await rm(toExtendedLength(staging), { force: true }).catch(() => {});
    }
  }
  if (bytes === null) {
    try {
      bytes = await readFile(toExtendedLength(mediaPath));
    } catch (error) {
      return { ok: false, reason: `take ${take.id}'s media could not be read: ${String(error)}` };
    }
  }
  if (bytes.byteLength === 0) return { ok: false, reason: `take ${take.id}'s media is empty` };

  /*
   * `ar_`, which is what `ArtifactIdSchema` accepts. Worth stating because getting it wrong
   * fails silently in the worst way: the sidecar writes, the bytes land, and `scanWorld` then
   * drops the record because it will not parse — so the artifact exists on disk and does not
   * exist to the app, and every consumer reads a frame slot pointing at nothing.
   */
  const artifactId = `ar_${ulid()}`;
  const file = `frame-${shotId}-${artifactId.slice(-8).toLowerCase()}${extension}`;
  const sidecar: ArtifactSidecar = {
    id: artifactId,
    kind: "image",
    file,
    // The same truncated digest shape the boundary sidecar files, so both frames audit alike.
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`,
    origin: { by: "system", producedBy: input.producedBy },
    links: [production.meta.id, shotId, take.id],
    production: production.meta.id,
    /*
     * Deliberately no `boundaryExtraction`. Its absence is what marks this as a frame the shot
     * was given rather than one chained onto it, and `hasOwnFrame` reads exactly that — so
     * adding one here would quietly make every drawn frame overwritable by the next accept.
     */
    created: store.now(),
  };

  const selectionsPath = `productions/${production.meta.id}/selections.json`;
  try {
    return await store.gateOp(async () => {
      let raw: string;
      let existed = true;
      try {
        raw = await readFile(toExtendedLength(join(store.dir, selectionsPath)), "utf8");
      } catch {
        raw = "{}";
        existed = false;
      }
      const selections = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      /*
       * The authorization fence, checked inside the gate — the only point where the answer
       * cannot go stale between reading it and writing on it. Nothing is written when it
       * fails: the take is already on disk, browsable and priced, and it simply is not this
       * shot's frame.
       */
      if (input.expectedArtifactId !== undefined) {
        const current =
          (selections[shotId]?.["startFrameArtifactId"] as string | null | undefined) ?? null;
        if (current !== input.expectedArtifactId) {
          // Recovery after the filing commit but before the run outcome write sees the slot move
          // to this job's own artifact. That is proof the earlier filing completed, not a newer
          // decision overtaking it; return its existing id without appending another review.
          const existing = store.getBundle().artifacts.find(
            (artifact) =>
              artifact.id === current &&
              artifact.origin.by === "system" &&
              artifact.origin.producedBy === input.producedBy &&
              artifact.links.includes(shotId) &&
              artifact.links.includes(take.id),
          );
          if (existing !== undefined) return { ok: true as const, artifactId: existing.id, shotId };
          return {
            ok: true as const,
            superseded: true as const,
            shotId,
            reason: "the frame changed while this one was being made",
          };
        }
      }
      await mkdir(join(store.dir, "artifacts"), { recursive: true });
      await atomicWriteFile(join(store.dir, "artifacts", file), bytes);
      selections[shotId] = {
        trimInSec: 0,
        ...selections[shotId],
        startFrameArtifactId: artifactId,
        /*
         * The legacy pointer is cleared in the same commit (R-20). It names footage that steers,
         * and leaving a previous shot's take standing beside a picture this shot was given would
         * be two answers to what the shot opens on — with the older one still reaching every
         * consumer that reads the take pointer.
         */
        startFrameTakeId: null,
      };
      await store.commitUnserialised({
        kind: "drawn-frame",
        source: input.producedBy,
        files: [
          // The accept's review append rides here, so a still's decision and its frame are one
          // commit and cannot diverge across a crash (SPEC-013 R-9, D6).
          ...(input.alsoCommit ?? []),
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
            baseHash: existed ? sha256(raw) : null,
          },
        ],
        // `startFrameArtifactId` is a version-2 shape (SPEC-023 R-23), the same boundary frames
        // raise: an older build's strict schemas would drop the selection map rather than refuse
        // the world by name.
        raiseSchemaVersion: 2,
      });
      return { ok: true as const, artifactId, shotId };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Accept a still: the decision, the artifact and the frame slot in ONE commit (SPEC-013 R-9, D6).
 *
 * `acceptTake` states the invariant this preserves — "record the decision AND set the selection
 * in one commit; the journalled primitive is exactly the multi-file atomicity a crash window
 * needs". A still is not footage, so it takes none of that function's clip machinery: no
 * continuity seed, no supersession sweep, no trim reset, and nothing in the clip slot. But it
 * keeps the same promise, which is why the review append travels into the filing commit rather
 * than landing in one of its own. Committed separately, a crash between them leaves a durable
 * review saying the take was accepted while the slot still names the old frame.
 *
 * No authorization fence here, deliberately: this is somebody pressing Accept on a picture they
 * are looking at, and the newest explicit decision is the one that should win.
 */
/**
 * The review append for a decision that must land in the same commit as the frame it decides
 * on. Read fresh on every call, so consecutive filings — a run landing several shots — chain
 * their base hashes correctly.
 */
export async function reviewAppendFor(
  store: WorldStore,
  productionId: string,
  decision: ReviewDecision,
): Promise<{ path: string; action: "create" | "replace"; content: string; baseHash: string | null }> {
  const reviewsPath = `productions/${productionId}/reviews.jsonl`;
  let raw = "";
  let existed = true;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, reviewsPath)), "utf8");
  } catch {
    existed = false;
  }
  return {
    path: reviewsPath,
    action: existed ? "replace" : "create",
    content: raw + JSON.stringify(decision) + "\n",
    baseHash: existed ? sha256(raw) : null,
  };
}

export async function acceptStill(
  store: WorldStore,
  production: ProductionBundle,
  input: { takeId: string; shotId: string; by: string; toPng?: BoundaryFrameMaker },
): Promise<{ decision: ReviewDecision; outcome: DrawnFrameOutcome }> {
  const take = production.takes.find((candidate) => candidate.id === input.takeId);
  if (!take) throw new Error(`take ${input.takeId} is not in this production`);
  if (take.boardSheetParent === true) throw new Error(`take ${input.takeId} is a board-sheet parent and cannot be accepted for a shot`);
  if (!take.coversShots.includes(input.shotId)) {
    throw new Error(`take ${input.takeId} does not cover shot ${input.shotId}`);
  }

  const decision: ReviewDecision = {
    ts: store.now(),
    takeId: input.takeId as ReviewDecision["takeId"],
    shotId: input.shotId as ReviewDecision["shotId"],
    decision: "accept",
    by: input.by,
  };

  const outcome = await fileDrawnFrame(store, production, {
    take,
    shotId: input.shotId,
    producedBy: `accept:${input.takeId}`,
    toPng: input.toPng,
    alsoCommit: [await reviewAppendFor(store, production.meta.id, decision)],
  });
  return { decision, outcome };
}
