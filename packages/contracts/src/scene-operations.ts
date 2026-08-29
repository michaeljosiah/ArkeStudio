import { z } from "zod";
import { ShotIdSchema } from "./ids.js";
import type { Shot } from "./scene.js";
import {
  isGraphScene,
  linearizeSceneFlow,
  migrateLegacyScene,
  shotNodeIdFor,
  validateSceneFlow,
  type GraphScene,
  type SceneFlowFinding,
  type SceneRecord,
} from "./scene-flow.js";

/**
 * The semantic vocabulary a scene is edited in (SPEC-029 R-36, §2.4).
 *
 * Before this, the only way to change a scene was to hand the writer a whole legacy-shaped
 * `Scene` and let `graphSceneFor` work out what happened. That is a migration, not authorship:
 * it cannot say *which* shot moved, so it cannot preserve identity through a structural edit,
 * and every caller had to assemble the whole document to change one field.
 *
 * Each operation here takes the record as it stands, applies ONE named change, and returns a
 * complete `GraphScene` that has already been validated (R-61). Nothing partial is returned and
 * nothing is written: a refusal throws with the findings named, so the caller commits or does
 * not, and there is no state in between. **No operation accepts arbitrary graph JSON** — the
 * inputs are shot ids and payloads, never nodes and edges.
 *
 * Node and edge identity is deterministic (R-12): `sfn_sh-14` for a shot, `sfe_sh-14-sh-15` for
 * the edge between two. That is why these operations can rebuild the flow from the new order
 * rather than surgically rewiring it and still satisfy R-36's "preserve node identity" — a shot
 * that kept its id keeps its node id, and an edge is named by the pair it joins, so rebuilding
 * produces exactly the ids a surgical rewire would have produced. It also normalises storage
 * order, which R-18 says carries no meaning anyway.
 */

/** A refused operation, carrying what is wrong rather than a code (R-59). */
export class SceneOperationRefused extends Error {
  constructor(
    readonly reasons: string[],
    readonly findings: SceneFlowFinding[] = [],
  ) {
    super(reasons.join(" · "));
    this.name = "SceneOperationRefused";
  }
}

/**
 * Where a shot goes, relative to ANOTHER SHOT — never an index (R-36, R-62).
 *
 * "Before shot 15" survives somebody else inserting a shot above it; "at position 3" does not,
 * and an edit composed against one order landing in another is exactly the merge-by-position
 * failure the version check exists to prevent.
 */
export const ShotAnchorSchema = z.union([
  z.object({ before: ShotIdSchema }).strict(),
  z.object({ after: ShotIdSchema }).strict(),
  z.object({ atStart: z.literal(true) }).strict(),
]);
export type ShotAnchor = z.infer<typeof ShotAnchorSchema>;

/**
 * The scene's shots as the operations work in them: the canonical order, refusing an invalid
 * graph by name rather than editing something nobody can read (R-59).
 */
function shotsOf(record: SceneRecord): Shot[] {
  const sequence = linearizeSceneFlow(record);
  if (sequence.kind === "invalid") {
    throw new SceneOperationRefused(
      ["this scene's flow cannot be read as an order, so it cannot be edited"],
      sequence.findings,
    );
  }
  return sequence.shots.map((pair) => pair.shot);
}

/**
 * The candidate, validated, or nothing (R-61).
 *
 * Groups are carried across every rebuild, and a group naming a shot the operation removed is a
 * refusal rather than a silent repair — losing a beat somebody wrote is not a fix. (SPEC-035
 * supersedes authored groups with derived boards, so in practice this list is empty; the carry
 * is here because a world written before that supersession still parses one.)
 */
function complete(record: SceneRecord, shots: readonly Shot[]): GraphScene {
  const held = isGraphScene(record) ? record.flow.storyboardGroups : [];
  const base = migrateLegacyScene({ ...stripFlow(record), shots: [...shots] });
  const flow = { ...base.flow, storyboardGroups: held };
  const findings = validateSceneFlow(flow);
  if (findings.length > 0) {
    throw new SceneOperationRefused(
      findings.map((finding) => finding.message),
      findings,
    );
  }
  return { ...base, flow };
}

/** The record's shared fields, whichever arm it is — the shape both `shots` and `flow` hang off. */
function stripFlow(record: SceneRecord): Omit<GraphScene, "flow"> {
  if (!isGraphScene(record)) {
    const { shots: _shots, ...base } = record;
    return base;
  }
  const { flow: _flow, ...base } = record;
  return base;
}

/** The position an anchor names, as an index into the ordered shots. */
function indexFor(shots: readonly Shot[], anchor: ShotAnchor): number {
  if ("atStart" in anchor) return 0;
  const targetId = "before" in anchor ? anchor.before : anchor.after;
  const at = shots.findIndex((shot) => shot.id === targetId);
  if (at < 0) throw new SceneOperationRefused([`shot ${targetId} is not in this scene`]);
  return "before" in anchor ? at : at + 1;
}

/**
 * Numbers are the scene's own 1..n, renumbered after every structural change.
 *
 * A shot's *identity* is its id and never its number (R-30's rule for groups, and the same
 * reason): ids are what takes, selections, spine anchors and board overrides key by. The number
 * is display order, so it is derived here rather than carried — an insert that left the numbers
 * alone would show two shot 3s.
 */
function renumbered(shots: readonly Shot[]): Shot[] {
  return shots.map((shot, index) => ({ ...shot, number: index + 1 }));
}

/** The first free `sh_<n>` across the WHOLE production — ids are unique per production, not per scene. */
export function nextShotIdIn(taken: Iterable<string>): string {
  let highest = 0;
  for (const id of taken) {
    const n = Number(id.replace(/^sh_0*/, ""));
    if (Number.isFinite(n)) highest = Math.max(highest, n);
  }
  return `sh_${highest + 1}`;
}

/**
 * Insert a shot on the edge the anchor names (§2.4's worked example).
 *
 * The caller mints the id — it must clear every shot in the production, which this function
 * cannot see — and `nextShotIdIn` is how. A collision is refused here rather than allowed to
 * become a duplicate node id at validation, so the message names the real problem.
 */
export function insertShot(
  record: SceneRecord,
  input: { shot: Omit<Shot, "number">; at: ShotAnchor },
): GraphScene {
  const shots = shotsOf(record);
  if (shots.some((shot) => shot.id === input.shot.id)) {
    throw new SceneOperationRefused([`shot ${input.shot.id} is already in this scene`]);
  }
  const at = indexFor(shots, input.at);
  const next = [...shots];
  next.splice(at, 0, { ...input.shot, number: 0 });
  return complete(record, renumbered(next));
}

/** Move a shot before or after another, keeping its id, its node id and its payload (R-36). */
export function moveShot(record: SceneRecord, input: { shotId: string; to: ShotAnchor }): GraphScene {
  const shots = shotsOf(record);
  const from = shots.findIndex((shot) => shot.id === input.shotId);
  if (from < 0) throw new SceneOperationRefused([`shot ${input.shotId} is not in this scene`]);
  if (!("atStart" in input.to)) {
    const targetId = "before" in input.to ? input.to.before : input.to.after;
    if (targetId === input.shotId) {
      throw new SceneOperationRefused([`shot ${input.shotId} cannot move relative to itself`]);
    }
  }
  // The anchor is resolved against the list WITHOUT the moving shot, so "after shot 5" means the
  // same thing whether the mover started before or after shot 5 — resolving against the original
  // list makes a forward move land one place short of what the words say.
  const without = shots.filter((shot) => shot.id !== input.shotId);
  const at = indexFor(without, input.to);
  const next = [...without];
  next.splice(at, 0, shots[from]!);
  return complete(record, renumbered(next));
}

/**
 * Duplicate a shot: the authored beat again, never its output.
 *
 * The copy takes a fresh id and drops `covers` — a duplicate that carried the original's covers
 * would claim footage it has no relationship to, and takes and selections key by shot id, so
 * nothing else follows the copy either.
 */
export function duplicateShot(
  record: SceneRecord,
  input: { shotId: string; newShotId: string },
): GraphScene {
  const shots = shotsOf(record);
  const source = shots.find((shot) => shot.id === input.shotId);
  if (source === undefined) throw new SceneOperationRefused([`shot ${input.shotId} is not in this scene`]);
  if (shots.some((shot) => shot.id === input.newShotId)) {
    throw new SceneOperationRefused([`shot ${input.newShotId} is already in this scene`]);
  }
  const copy: Shot = { ...source, id: input.newShotId, number: 0 };
  delete (copy as Partial<Shot>).covers;
  const next = [...shots];
  next.splice(shots.indexOf(source) + 1, 0, copy);
  return complete(record, renumbered(next));
}

/**
 * Edit a shot's payload in place: same id, same node id, same position, same edges.
 *
 * A patch, not a rewrite — every field the change omits is left as the shot has it, because a
 * conversation that mentioned the duration has not thereby cleared the hand-tuned prompt. An
 * explicit `undefined` clears the key, which is how a caller says "remove this".
 */
export function editShot(record: SceneRecord, input: { shotId: string; change: Partial<Shot> }): GraphScene {
  const shots = shotsOf(record);
  const at = shots.findIndex((shot) => shot.id === input.shotId);
  if (at < 0) throw new SceneOperationRefused([`shot ${input.shotId} is not in this scene`]);
  if (input.change.id !== undefined && input.change.id !== input.shotId) {
    throw new SceneOperationRefused(["a shot's id is its identity and cannot be edited"]);
  }
  const merged = { ...shots[at]!, ...input.change } as Shot;
  for (const [key, value] of Object.entries(input.change)) {
    if (value === undefined) delete (merged as Record<string, unknown>)[key];
  }
  const next = [...shots];
  next[at] = { ...merged, id: input.shotId, number: shots[at]!.number };
  return complete(record, next);
}

/**
 * Delete a shot: predecessor joins successor, the node and its incident edges go (§2.4).
 *
 * The live-dependency refusals (R-39) are the CALLER's — they need selections, spine anchors,
 * plans and panels this function cannot see. What is refused here is what the graph itself
 * knows: a shot that is not in the scene, and a board override or authored group left naming a
 * shot that no longer exists. The override cleanup is deliberate rather than a refusal: a split
 * or merge is a boundary hint keyed by shot id, and a hint pointing at a deleted shot is stale
 * bookkeeping, not somebody's authored beat.
 */
export function deleteShot(record: SceneRecord, input: { shotId: string }): GraphScene {
  const shots = shotsOf(record);
  if (!shots.some((shot) => shot.id === input.shotId)) {
    throw new SceneOperationRefused([`shot ${input.shotId} is not in this scene`]);
  }
  const held = isGraphScene(record) ? record.flow.storyboardGroups : [];
  const orphaned = held.filter((group) => group.shotNodeIds.includes(shotNodeIdFor(input.shotId)));
  if (orphaned.length > 0) {
    throw new SceneOperationRefused(
      orphaned.map(
        (group) => `"${group.title}" still holds this shot — take it out of the group first`,
      ),
    );
  }
  const next = renumbered(shots.filter((shot) => shot.id !== input.shotId));
  const scene = complete(record, next);
  return withBoards(scene, prune(scene.boards, input.shotId));
}

// ---------------------------------------------------------------------------
// Board overrides (SPEC-035, amending §1.9's authored groups)
// ---------------------------------------------------------------------------

type Boards = NonNullable<SceneRecord["boards"]>;

/** Overrides with the deleted shot's hints dropped; `undefined` when nothing is left to say. */
function prune(boards: Boards | undefined, shotId: string): Boards | undefined {
  if (boards === undefined) return undefined;
  return normalise({
    ...boards,
    splits: boards.splits.filter((id) => id !== shotId),
    merges: boards.merges.filter((id) => id !== shotId),
    ...(boards.prompts !== undefined
      ? {
          prompts: boards.prompts
            .map((prompt) => ({ ...prompt, members: prompt.members.filter((id) => id !== shotId) }))
            .filter((prompt) => prompt.members.length > 0),
        }
      : {}),
  });
}

/** An empty override block is absent, not `{splits: [], merges: []}` — one answer, not two. */
function normalise(boards: Boards): Boards | undefined {
  const empty =
    boards.splits.length === 0 && boards.merges.length === 0 && (boards.prompts ?? []).length === 0;
  return empty ? undefined : boards;
}

function withBoards(scene: GraphScene, boards: Boards | undefined): GraphScene {
  if (boards === undefined) {
    const { boards: _dropped, ...rest } = scene;
    return rest as GraphScene;
  }
  return { ...scene, boards };
}

/**
 * The four board-override commands, keyed by SHOT ID (SPEC-035): a split says "start a new
 * board at this shot", a merge says "do not break before this shot". Ordinals were the
 * prototype's one porting divergence — a hint keyed by position silently moves to a different
 * shot the moment anything is inserted above it.
 *
 * Setting one clears the other for that shot: they are opposite answers to the same question,
 * and holding both would make the packer's walk depend on which list it read first.
 */
export function setBoardOverride(
  record: SceneRecord,
  input: { shotId: string; override: "split" | "merge" },
): GraphScene {
  const shots = shotsOf(record);
  if (!shots.some((shot) => shot.id === input.shotId)) {
    throw new SceneOperationRefused([`shot ${input.shotId} is not in this scene`]);
  }
  if (shots[0]?.id === input.shotId) {
    throw new SceneOperationRefused([
      "the first shot already opens a board — a break before it would divide nothing",
    ]);
  }
  const boards: Boards = record.boards ?? { splits: [], merges: [] };
  const splits = new Set(boards.splits);
  const merges = new Set(boards.merges);
  if (input.override === "split") {
    splits.add(input.shotId);
    merges.delete(input.shotId);
  } else {
    merges.add(input.shotId);
    splits.delete(input.shotId);
  }
  const scene = complete(record, shots);
  return withBoards(
    scene,
    normalise({ ...boards, splits: ordered(shots, splits), merges: ordered(shots, merges) }),
  );
}

export function clearBoardOverride(
  record: SceneRecord,
  input: { shotId: string; override: "split" | "merge" },
): GraphScene {
  const shots = shotsOf(record);
  const boards = record.boards;
  if (boards === undefined) {
    throw new SceneOperationRefused(["this scene has no board overrides to clear"]);
  }
  const list = input.override === "split" ? boards.splits : boards.merges;
  if (!list.includes(input.shotId)) {
    throw new SceneOperationRefused([`shot ${input.shotId} carries no ${input.override}`]);
  }
  const scene = complete(record, shots);
  return withBoards(
    scene,
    normalise({
      ...boards,
      splits: input.override === "split" ? boards.splits.filter((id) => id !== input.shotId) : boards.splits,
      merges: input.override === "merge" ? boards.merges.filter((id) => id !== input.shotId) : boards.merges,
    }),
  );
}

/** Override lists in scene order, so the file reads the way the scene runs and diffs stay small. */
function ordered(shots: readonly Shot[], ids: ReadonlySet<string>): string[] {
  return shots.filter((shot) => ids.has(shot.id)).map((shot) => shot.id);
}
