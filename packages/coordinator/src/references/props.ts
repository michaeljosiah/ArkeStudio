import { readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { PropSchema, type Prop, type Take } from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { commitReferenceRecord } from "./kit.js";
import { pendingPropStateTake, recordUploadedPropTake, referenceReviewDecision } from "./takes.js";

/**
 * Prop-state references (design turn 105, `referenceOwner: accepted-state-record`; issue 535).
 *
 * A prop lives beside the sheets it is not one of — `references/<propId>/prop.json`, with its
 * candidates and immutable takes in the directory shape a sheet's kit uses — so the scan that
 * finds a location's takes finds a prop's without learning anything new. The accept is the main
 * photo's, keyed by (prop, state) instead of a sheet: candidate → immutable take → one commit
 * carrying the record and the review that decided it.
 */

const propPath = (propId: string): string => `references/${propId}/prop.json`;

export async function readProp(store: WorldStore, propId: string): Promise<{ prop: Prop; raw: string } | null> {
  try {
    const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(propPath(propId)))), "utf8");
    return { prop: PropSchema.parse(JSON.parse(raw)), raw };
  } catch {
    return null;
  }
}

export type PropStateSelection = { source: "take"; takeId: Take["id"] } | { source: "candidate"; file: string };

export type PropStateAcceptance =
  | { status: "accepted"; takeId: Take["id"] }
  | { status: "refused"; reason: string };

export async function acceptPropStateReference(
  store: WorldStore,
  input: { propId: string; stateId: string; selection: PropStateSelection; replace?: boolean },
): Promise<PropStateAcceptance> {
  const found = await readProp(store, input.propId);
  if (!found) return { status: "refused", reason: `no prop ${input.propId}` };
  const state = found.prop.states.find((candidate) => candidate.id === input.stateId);
  if (!state) return { status: "refused", reason: `${found.prop.name} has no state ${input.stateId}` };
  // Turn 57's rule, which 105f reuses: a state that already has its reference asks first.
  // Superseding is a loss somebody notices later, in a shot, so it takes saying twice.
  if (state.reference !== undefined && input.replace !== true) {
    return {
      status: "refused",
      reason: `${found.prop.name} · ${state.name} already has a reference (${state.reference.id}); confirm the replacement`,
    };
  }

  let take: Take | null;
  let candidatePath: string | null = null;
  if (input.selection.source === "take") {
    const bundle = store.getBundle();
    take = pendingPropStateTake(
      bundle.referenceTakes,
      bundle.referenceReviews,
      input.selection.takeId,
      input.propId,
      input.stateId,
    );
    if (!take) return { status: "refused", reason: "the selected take is unavailable or already decided" };
  } else {
    candidatePath = `references/${input.propId}/candidates/${input.selection.file}`;
    if (!(store.getBundle().referenceCandidates[input.propId] ?? []).includes(candidatePath)) {
      return { status: "refused", reason: "the selected candidate is no longer available" };
    }
    take = await recordUploadedPropTake(store, input.propId, input.stateId, candidatePath);
  }
  const media = take.media;
  if (media === undefined || basename(media) !== media) {
    return { status: "refused", reason: "the immutable take was not written" };
  }
  const stored = join(store.dir, "references", input.propId, "takes", take.id, media);
  if ((await stat(toExtendedLength(stored)).catch(() => null))?.isFile() !== true) {
    return { status: "refused", reason: "the immutable take was not written" };
  }

  // The prior reference is replaced on the record and nowhere else: its take stays on disk and
  // in the bundle, which is the history a shot that already cites it may still want.
  const acceptedAt = store.now();
  const accepted = take;
  const next: Prop = {
    ...found.prop,
    states: found.prop.states.map((candidate) =>
      candidate.id !== state.id
        ? candidate
        : {
            ...candidate,
            reference: {
              id: `psr_${accepted.id.slice(3)}`,
              file: `takes/${accepted.id}/${media}`,
              ...(accepted.prompt !== undefined ? { prompt: accepted.prompt } : {}),
              ...(accepted.jobId !== undefined ? { sourceJobId: accepted.jobId } : {}),
              sourceTakeId: accepted.id,
              acceptedAt,
            },
          },
    ),
  };
  await commitReferenceRecord(
    store,
    [
      {
        path: propPath(input.propId),
        action: "replace",
        content: `${JSON.stringify(next, null, 2)}\n`,
        baseHash: sha256(found.raw),
      },
    ],
    referenceReviewDecision(acceptedAt, accepted, "accept"),
  );
  // Best effort, as for a main photo: the take holds the bytes now, and a candidate that outlives
  // its accept only reappears as a choice already made.
  if (candidatePath !== null) await rm(toExtendedLength(join(store.dir, fromPortable(candidatePath)))).catch(() => {});
  return { status: "accepted", takeId: accepted.id };
}
