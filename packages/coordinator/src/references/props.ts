import { readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { checkPropName, newId, PropSchema, type Prop, type PropState, type Take } from "@arke-studio/contracts";
import { WorldStateStaleError } from "../world/store.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { commitReferenceRecord, type ReferenceMutationOptions } from "./kit.js";
import { pendingPropStateTake, recordUploadedPropTake, referenceReviewDecision } from "./takes.js";
import { prepareArtifactLinks } from "../artifacts/filing.js";

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
  options: ReferenceMutationOptions & { artifactId?: string } = {},
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
  const artifact = options.artifactId ? store.getBundle().artifacts.find(artifact => artifact.id === options.artifactId) : undefined;
  if (options.artifactId && !artifact) throw new Error("The source artifact is unavailable.");
  const artifactFiles = artifact ? [await prepareArtifactLinks(store, artifact, [input.propId])] : [];
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
      ...artifactFiles,
      {
        path: propPath(input.propId),
        action: "replace",
        content: `${JSON.stringify(next, null, 2)}\n`,
        baseHash: sha256(found.raw),
      },
    ],
    referenceReviewDecision(acceptedAt, accepted, "accept"),
    options,
  );
  // Best effort, as for a main photo: the take holds the bytes now, and a candidate that outlives
  // its accept only reappears as a choice already made.
  if (candidatePath !== null) await rm(toExtendedLength(join(store.dir, fromPortable(candidatePath)))).catch(() => {});
  return { status: "accepted", takeId: accepted.id };
}

/**
 * A prop is born as a name and an empty, ordered list of states — nothing owned beyond them
 * (turn 105f; issue 537). The name's slug is what shots cite, so it has to be free of every
 * other prop's and every sheet's id (issue 1116): the screen says which holds the word before
 * it sends, and this is the gate of record — silent, as the accept's refusal is, since nothing
 * changed and the name is still in the box. The check runs as the commit's precondition,
 * inside the serialised write after its rescan, so two equivalent requests in flight at once
 * cannot both read a bundle that knows neither and both land: the second sees the first.
 */
export async function createProp(store: WorldStore, name: string, options: ReferenceMutationOptions & { id?: string; states?: PropState[] } = {}): Promise<Prop | null> {
  if (options.id) {
    const existing = store.getBundle().props.find(prop => prop.id === options.id);
    if (existing) return existing;
  }
  const free = (): string | null => {
    const bundle = store.getBundle();
    const check = checkPropName(name, bundle.props, bundle.sheets);
    return check.ok ? null : `@${check.slug || name.trim()} is not free to cite a prop by`;
  };
  if (free() !== null) return null;
  const prop: Prop = PropSchema.parse({ id: options.id ?? newId("prop"), name: name.trim(), states: options.states ?? [] });
  if (new Set(prop.states.map(state => state.id)).size !== prop.states.length ||
    new Set(prop.states.map(state => state.name.toLowerCase())).size !== prop.states.length) throw new Error("Prop states must have distinct identities and names.");
  try {
    await commitReferenceRecord(
      store,
      [{ path: propPath(prop.id), action: "create", content: `${JSON.stringify(prop, null, 2)}\n`, baseHash: null }],
      undefined,
      { ...options, precondition: () => options.precondition?.() ?? free() },
    );
  } catch (error) {
    if (error instanceof WorldStateStaleError) return null;
    throw error;
  }
  return prop;
}

/** One more named state at the end of the order; its id is what shots will cite, so the name may change later. */
export async function addPropState(store: WorldStore, propId: string, name: string, options: ReferenceMutationOptions & { id?: string } = {}): Promise<PropState | null> {
  const found = await readProp(store, propId);
  if (!found) return null;
  const known = options.id ? found.prop.states.find(state => state.id === options.id) : undefined;
  if (known) return known;
  if (found.prop.states.some(state => state.name.toLowerCase() === name.trim().toLowerCase())) throw new Error("That state name already exists.");
  const state: PropState = { id: options.id ?? newId("pst"), name: name.trim() };
  const next: Prop = { ...found.prop, states: [...found.prop.states, state] };
  await commitReferenceRecord(store, [
    { path: propPath(propId), action: "replace", content: `${JSON.stringify(next, null, 2)}\n`, baseHash: sha256(found.raw) },
  ], undefined, options);
  return state;
}

export async function renameProp(store: WorldStore, propId: string, name: string, stateId?: string, options: ReferenceMutationOptions = {}): Promise<void> {
  const found = await readProp(store, propId);
  if (!found) throw new Error("The prop is unavailable.");
  if (stateId && !found.prop.states.some(state => state.id === stateId)) throw new Error("The state is unavailable.");
  if (stateId && found.prop.states.some(state => state.id !== stateId && state.name.toLowerCase() === name.trim().toLowerCase())) throw new Error("That state name already exists.");
  const free = () => {
    const bundle = store.getBundle();
    return stateId || checkPropName(name, bundle.props.filter(prop => prop.id !== propId), bundle.sheets).ok ? null : "The prop name is already in use.";
  };
  const next = PropSchema.parse(stateId ? { ...found.prop, states: found.prop.states.map(state => state.id === stateId ? { ...state, name: name.trim() } : state) }
    : { ...found.prop, name: name.trim() });
  await commitReferenceRecord(store, [{ path: propPath(propId), action: "replace", baseHash: sha256(found.raw), content: JSON.stringify(next, null, 2) + "\n" }],
    undefined, { ...options, precondition: () => options.precondition?.() ?? free() });
}
