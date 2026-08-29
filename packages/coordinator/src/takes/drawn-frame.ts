import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
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
  },
): Promise<DrawnFrameOutcome> {
  const { take, shotId } = input;
  if (take.kind !== "frame" && take.kind !== "still") {
    return { ok: false, reason: `take ${take.id} is ${take.kind}, not a still` };
  }
  const media = take.media;
  if (media === undefined) return { ok: false, reason: `take ${take.id} has no media to file` };
  const extension = extname(media).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    return { ok: false, reason: `take ${take.id}'s media is not an image` };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(
      toExtendedLength(join(store.dir, "productions", production.meta.id, "takes", take.id, media)),
    );
  } catch (error) {
    return { ok: false, reason: `take ${take.id}'s media could not be read: ${String(error)}` };
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
export async function acceptStill(
  store: WorldStore,
  production: ProductionBundle,
  input: { takeId: string; shotId: string; by: string },
): Promise<{ decision: ReviewDecision; outcome: DrawnFrameOutcome }> {
  const take = production.takes.find((candidate) => candidate.id === input.takeId);
  if (!take) throw new Error(`take ${input.takeId} is not in this production`);
  if (!take.coversShots.includes(input.shotId)) {
    throw new Error(`take ${input.takeId} does not cover shot ${input.shotId}`);
  }

  const reviewsPath = `productions/${production.meta.id}/reviews.jsonl`;
  let reviewsRaw = "";
  let reviewsExisted = true;
  try {
    reviewsRaw = await readFile(toExtendedLength(join(store.dir, reviewsPath)), "utf8");
  } catch {
    reviewsExisted = false;
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
    alsoCommit: [
      {
        path: reviewsPath,
        action: reviewsExisted ? "replace" : "create",
        content: reviewsRaw + JSON.stringify(decision) + "\n",
        baseHash: reviewsExisted ? sha256(reviewsRaw) : null,
      },
    ],
  });
  return { decision, outcome };
}
