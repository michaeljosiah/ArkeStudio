import { sameVoiceAssignment, shotDeleteBlockers, SceneOperationRefused, sceneCommandCandidate, sceneCommandBatchCandidate, type SemanticSceneCommand as SceneCommand, type SceneRecord, type GraphScene, type Shot, type WorldBundle } from "@arke-studio/contracts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sceneLookReleases } from "../references/kit.js";
import { currentPerformanceTarget } from "../audio/performances.js";
import { sha256 } from "../world/text-files.js";
import { parseSceneRecord } from "./scene-record.js";
import type { CommitFileInput } from "../world/commit.js";
import { WorldStateStaleError, type WorldStore } from "../world/store.js";

/**
 * The one way a scene's structure changes (SPEC-029 R-36, R-61, R-62).
 *
 * These commands each name ONE change, carry the scene version they were composed against, and commit exactly one
 * validated record — or write nothing at all.
 *
 * The layering is deliberate: `scene-operations.ts` in contracts owns the graph (pure, no disk,
 * refuses by name), and this file owns everything the graph cannot see — which version is on
 * disk, what a deletion would strand, and the selection that must go in the same commit as the
 * shot it belonged to.
 */

export type { SemanticSceneCommand as SceneCommand } from "@arke-studio/contracts";

/**
 * The wire command as the operations take it: `clear` becomes the explicit `undefined` that
 * `editShot` reads as "remove this key".
 *
 * JSON cannot carry `undefined` and an omitted key means "leave it", so the transport names the
 * fields to drop instead of sending a value for them. Translating here keeps the operations
 * working in one vocabulary — a patch where present-with-undefined clears — rather than
 * teaching every one of them about a wire shape.
 */
export function sceneCommandFrom(wire: WireSceneCommand): SceneCommand {
  if (wire.kind !== "edit-shot") return wire as SceneCommand;
  const change: Record<string, unknown> = { ...wire.change };
  for (const field of wire.clear ?? []) change[field] = undefined;
  return {
    kind: "edit-shot",
    shotId: wire.shotId,
    change: change as Partial<Omit<Shot, "id" | "number" | "staging">>,
  };
}

/** The wire shape, structurally — the frame owns its schema; this is what reaches the command. */
type WireSceneCommand =
  | Exclude<SceneCommand, { kind: "edit-shot" }>
  | { kind: "edit-shot"; shotId: string; change: Partial<Omit<Shot, "id" | "number" | "staging">>; clear?: readonly string[] };

/** A refusal that names what stands in the way, never a code (R-39, R-59). */
export class SceneCommandRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" · "));
    this.name = "SceneCommandRefused";
  }
}

/** The scene moved under the command; it is refused against the version, never merged (R-62). */
export class SceneVersionMoved extends Error {
  constructor(
    readonly expected: number,
    readonly found: number,
  ) {
    super(
      `the scene moved from v${expected} to v${found} while this edit was being made — it was not overwritten`,
    );
    this.name = "SceneVersionMoved";
  }
}

/**
 * What the command needs that only the coordinator can answer.
 *
 * `activePlans` names the nonterminal dispatch plans for this production. It is injected rather
 * than read here because plan status is FOLDED from the journal joined with live queue facts
 * (SPEC-024 R-10) — there is no stored status to consult, and reaching for the queue from a
 * write path would put the whole dispatcher behind every scene edit. A caller that supplies
 * nothing gets no plan blocker, which is right for the callers that have no queue at all.
 */
export interface SceneCommandDeps {
  activePlans?: (productionId: string) => Promise<Array<{ planId: string; sceneId: string; status: string }>>;
  /** Revalidate a human review binding inside the same write gate as its scene change. */
  validateInGate?: () => Promise<void>;
}

export interface SceneCommandInput {
  productionId: string;
  /** A file stem, never a path. */
  sceneFile: string;
  /**
   * The scene the caller composed against, by id.
   *
   * The version alone cannot tell a scene from its replacement: deleting a scene frees both its
   * id and its stem, a new scene can be drafted at the same path, and a delayed command
   * composed against v1 of the old one would pass a v1 check and land in the new one.
   */
  sceneId: string;
  /** The version the caller composed against. Refused if the file has moved past it (R-62). */
  baseVersion: number;
  command: SceneCommand;
  /** Stable delivery key for a conversation action, when this command came from one. */
  requestId?: string;
}

export interface SceneCommandsInput extends Omit<SceneCommandInput, "command"> {
  commands: readonly SceneCommand[];
  /** Both snapshots are fixed before the person reviews this batch. */
  expectedBefore: SceneRecord;
  expectedAfter: SceneRecord;
  precondition?: () => string | null;
}

/** Scene, selection cleanup and released kit claims land together or not at all (SPEC-051 R-16). */
export async function applySceneCommands(store: WorldStore, input: SceneCommandsInput, deps: SceneCommandDeps = {}): Promise<void> {
  const stem = stemOrThrow(input.sceneFile), path = `productions/${input.productionId}/scenes/${stem}.json`;
  await store.gateOp(async () => {
    const refused = input.precondition?.();
    if (refused) throw new WorldStateStaleError(refused);
    const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
    const record = parseSceneRecord(raw);
    fenceOrThrow(input, record, stem);
    if (!isDeepStrictEqual(record, input.expectedBefore)) throw new SceneCommandRefused(["The scene differs from the dependency result this batch reviewed."]);
    const after = sceneCommandBatchCandidate(store.getBundle(), input.productionId, record, input.commands);
    if (!isDeepStrictEqual(after, input.expectedAfter)) throw new SceneCommandRefused(["The resulting scene or its fixed shot identities changed after review."]);
    let working: SceneRecord = record;
    const files: CommitFileInput[] = [];
    for (const command of input.commands) {
      const bundle: WorldBundle = { ...store.getBundle(), productions: store.getBundle().productions.map(p => p.meta.id !== input.productionId ? p :
        { ...p, scenes: p.scenes.map(s => s.id === record.id ? working : s) }) };
      if (command.kind === "delete-shot") {
        const blockers = await deletionBlockers(store, { ...input, command }, command.shotId, deps, bundle);
        if (blockers.length) throw new SceneCommandRefused(blockers);
      }
      working = await candidateFor(store, { ...input, command }, working, files, bundle);
    }
    const unique = new Map(files.map(file => [file.path, file]));
    unique.set(path, { path, action: "replace", content: JSON.stringify(after, null, 2) + "\n", baseHash: sha256(raw) });
    await store.commitUnserialised({ kind: "scene-command-batch", source: "production-chat", files: [...unique.values()],
      ...(input.requestId ? { requestId: input.requestId } : {}) });
  });
}

/**
 * Apply one command: read, check the version, construct, validate, commit once (R-61).
 *
 * Every failure path leaves the world byte-identical: nothing is written before the candidate
 * has been built and validated in full, so a refusal costs reads and nothing else — no version,
 * no selection cleanup, no schema raise, no plan, no job, no spend.
 */
export async function applySceneCommand(
  store: WorldStore,
  input: SceneCommandInput,
  deps: SceneCommandDeps = {},
): Promise<void> {
  const stem = stemOrThrow(input.sceneFile);
  const path = `productions/${input.productionId}/scenes/${stem}.json`;

  /*
   * A cheap first look, so a command composed against a scene that has since moved says so
   * rather than reporting on a world it was never looking at. The authoritative fence is the
   * one inside the gate; this one only saves the work.
   */
  const opening = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  fenceOrThrow(input, parseSceneRecord(opening), stem);

  /*
   * Read, mint, validate and commit inside ONE serialised region.
   *
   * Shot ids are unique per production, not per scene, and minting one means looking at every
   * scene. Two inserts into DIFFERENT scenes therefore read the same snapshot, mint the same
   * id, and both commit cleanly — their base hashes never collide, because they replace
   * different files. The result is two shots with one id, and selections and takes keyed by the
   * bare id then alias the wrong one. The gate is what makes the read and the write one act.
   */
  await store.gateOp(async () => {
    await deps.validateInGate?.();
    const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
    const record = parseSceneRecord(raw);
    fenceOrThrow(input, record, stem);

    /*
     * Blockers are derived INSIDE the gate, immediately before the commit is built.
     *
     * The version fence cannot stand in for them: accepting a take does not touch the scene's
     * version, so an accept landing between an out-of-gate check and this write would sail
     * through the fence — and the deletion would then remove the selection that accept had just
     * written, leaving paid footage with no shot to belong to. Reading a plan journal under the
     * lock costs a little; orphaning footage is not a thing to be a little fast about.
     */
    if (input.command.kind === "delete-shot") {
      const blockers = await deletionBlockers(store, input, input.command.shotId, deps);
      if (blockers.length > 0) throw new SceneCommandRefused(blockers);
    }

    const files: CommitFileInput[] = [];
    const next = await candidateFor(store, input, record, files);

    files.unshift({
      path,
      action: "replace",
      content: `${JSON.stringify(next, null, 2)}\n`,
      baseHash: sha256(raw),
    });
    await store.commitUnserialised({
      kind: "scene-command",
      source: input.command.kind,
      files,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
  });
}

/**
 * Is this the scene the command was composed against, as it was composed against it?
 *
 * The id first, because the version alone cannot tell a scene from its replacement: deleting a
 * scene frees both its id and its stem, a new scene can be drafted at the same path, and a
 * delayed command composed against v1 of the old one would sail through a version check and
 * land in the new one.
 */
function fenceOrThrow(input: Pick<SceneCommandInput, "sceneId" | "baseVersion">, record: SceneRecord, stem: string): void {
  if (record.id !== input.sceneId) {
    throw new SceneCommandRefused([
      `${stem}.json holds scene ${record.id}, not ${input.sceneId} — this edit was composed against a different scene`,
    ]);
  }
  if (record.version !== input.baseVersion) {
    throw new SceneVersionMoved(input.baseVersion, record.version);
  }
}

/**
 * What a deletion would strand (R-39), refusing rather than guessing when it cannot be read.
 *
 * An unreadable plan journal is not "no active plans": it is the coordinator being unable to
 * prove the deletion is safe, which is exactly when it must not proceed. "I could not look"
 * belongs on the blocker list beside the blockers themselves.
 */
async function deletionBlockers(
  store: WorldStore,
  input: SceneCommandInput,
  shotId: string,
  deps: SceneCommandDeps,
  bundle: WorldBundle = store.getBundle(),
): Promise<string[]> {
  const production = bundle.productions.find((p) => p.meta.id === input.productionId);
  if (!production) return [`production ${input.productionId} is not in this world`];
  const scene = production.scenes.find((candidate) => candidate.id === input.sceneId);
  if (!scene) return [`scene ${input.sceneId} is not in ${input.productionId}`];
  let plans: Array<{ planId: string; sceneId: string; status: string }>;
  try {
    plans = (await deps.activePlans?.(input.productionId)) ?? [];
  } catch (error) {
    return [
      `the dispatch plans for this production could not be read, so a running one cannot be ruled out: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  return shotDeleteBlockers(production, scene, shotId, plans);
}

/**
 * The validated candidate, plus any file that has to land in the SAME commit as it.
 *
 * A deleted shot's selection is the case that matters: written separately, a crash between the
 * two leaves a selection keyed by a shot that no longer exists — bookkeeping about nothing,
 * which is exactly what R-39's "removes its selection in the same commit" prevents.
 */
async function candidateFor(
  store: WorldStore,
  input: SceneCommandInput,
  record: SceneRecord,
  files: CommitFileInput[],
  bundle: WorldBundle = store.getBundle(),
): Promise<GraphScene> {
  const command = input.command;
  if (command.kind === "edit-scene") {
    // A command that names nothing is refused rather than committed as a version cut over
    // an unchanged record — the schema cannot say "at least one", so this is where it is said.
    if (command.title === undefined && command.synopsis === undefined && command.inherits === undefined && command.cast === undefined) {
      throw new SceneCommandRefused(["this edit names neither a title, a synopsis, the inherited context nor the cast"]);
    }
    // The place must be a location this world holds (SPEC-044 R-19) — the same refusal Arke's
    // proposal path makes, so a picker and a proposal cannot disagree about what a place is.
    const location = command.inherits?.location;
    if (location && !store.getBundle().sheets.some((sheet) => sheet.id === location && sheet.type === "location")) {
      throw new SceneCommandRefused([`location ${location} is not in this world`]);
    }
    // A read chosen for the cast must be this production's, accepted, the bytes the pointer
    // names, and current for its line (codex round 1): the reducer takes any pointer, and a
    // stale one would land here only to be refused at dispatch, the sample riding in its place
    // with nothing on the page saying so.
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === input.productionId);
    for (const [sheetId, member] of Object.entries(command.cast ?? {})) {
      if (member === null) continue;
      // A member is a character this world holds (R-7; codex round 2): the reducer takes any
      // key, and a place or a slug nobody has would be drawn as a member of the cast.
      if (!store.getBundle().sheets.some((sheet) => sheet.id === sheetId && sheet.type === "character" && !sheet.retired)) {
        throw new SceneCommandRefused([`${sheetId} is not a character in this world`]);
      }
      const voice = member.voice;
      if (voice?.kind !== "performance") continue;
      const read = production?.performances.find((candidate) => candidate.id === voice.performanceId);
      if (read === undefined) throw new SceneCommandRefused([`${sheetId}: read ${voice.performanceId} is not in this production`]);
      if (read.target.sceneId !== input.sceneId || read.target.speakerSheetId !== sheetId) throw new SceneCommandRefused([`${sheetId}: that read is another line's`]);
      if (read.provenance.outputHash !== voice.hash) throw new SceneCommandRefused([`${sheetId}: that read changed`]);
      if (production?.performanceReview.reviews.filter((review) => review.performanceId === read.id).at(-1)?.decision !== "accept") {
        throw new SceneCommandRefused([`${sheetId}: that read is not accepted`]);
      }
      if (read.kind !== "scratch" && !sameVoiceAssignment(store.getBundle().sheets.find((sheet) => sheet.id === sheetId)?.voice, read.voiceAssignment)) {
        throw new SceneCommandRefused([`${sheetId}: that read is an earlier voice's`]);
      }
      if (!currentPerformanceTarget(store, read.target)) throw new SceneCommandRefused([`${sheetId}: that read no longer matches its line`]);
    }
    // The kit writes that release this scene's claims ride in this commit (codex round 1): a
    // member removed, or the place changed, with its look still attached is a claim nobody can
    // see, and a second commit is a gap a crash can fall into that no retry repairs.
    for (const [sheetId, member] of Object.entries(command.cast ?? {})) {
      if (member === null) files.push(...(await sceneLookReleases(store, sheetId, { productionId: input.productionId, sceneId: input.sceneId })));
    }
    const previousLocation = record.inherits?.location;
    if (typeof previousLocation === "string" && command.inherits?.location !== undefined && command.inherits.location !== previousLocation) {
      files.push(...(await sceneLookReleases(store, previousLocation, { productionId: input.productionId, sceneId: input.sceneId })));
    }
  }
  if (command.kind === "delete-shot") await appendSelectionCleanup(store, input.productionId, command.shotId, files);
  return sceneCommandCandidate(bundle, input.productionId, record, command);
}

/**
 * The selection the deleted shot carried, dropped in the deletion's own commit — and the
 * selections file claimed as a write dependency even when it carries no row for this shot.
 *
 * An accepted take is a blocker, so what is dropped here is never a decision: a trim, a pinned
 * frame, a cleared slot. Selection writers now validate under the same gate, but claiming the
 * file here also protects this commit from any writer that still carries an optimistic base
 * hash. Whichever operation reaches the gate second must observe the deletion or a changed hash;
 * neither order can leave bookkeeping keyed to a shot that no longer exists.
 */
async function appendSelectionCleanup(
  store: WorldStore,
  productionId: string,
  shotId: string,
  files: CommitFileInput[],
): Promise<void> {
  const path = `productions/${productionId}/selections.json`;
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  } catch (error) {
    // Only "there is no file" is ordinary — a production nobody has selected in has none. Any
    // other read failure means the file may hold a selection for this shot that this commit
    // would then fail to remove, so the deletion is refused rather than left half-done.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new SceneCommandRefused([
      `the selections for ${productionId} could not be read, so this shot's selection cannot be removed with it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]);
  }
  const previous = files.find(file => file.path === path);
  const selections = JSON.parse(previous?.content ?? raw) as Record<string, unknown>;
  // No early return when the row is absent: the point is to claim the file, not only to edit it.
  delete selections[shotId];
  const replacement: CommitFileInput = {
    path,
    action: "replace",
    content: `${JSON.stringify(selections, null, 2)}\n`,
    baseHash: sha256(raw),
  };
  if (previous) files[files.indexOf(previous)] = replacement;
  else files.push(replacement);
}

export function stemOrThrow(sceneFile: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sceneFile) || sceneFile === "." || sceneFile === "..") {
    throw new SceneCommandRefused([`"${sceneFile}" is not a scene file name`]);
  }
  return sceneFile;
}

/**
 * Removing a member takes its scene look with it (SPEC-044 R-9): the look stays on the kit, and
 * only the attachment that made it ride here goes. One detach per character — clearing a look
 * empties the scope it held (design 67), so a look-by-look loop rewrote the kit for nothing.
 * Called after the scene write landed, by every arm that applies the wire command.
 */
export { SceneOperationRefused };
