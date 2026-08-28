import {
  isGraphScene,
  linearizeSceneFlow,
  migrateLegacyScene,
  projectSceneRecord,
  SceneRecordSchema,
  validateSceneFlow,
  type GraphScene,
  type Scene,
  type SceneFlowFinding,
  type SceneRecord,
} from "@arke-studio/contracts";

/**
 * Scene files on the way in and on the way out (SPEC-029 §3.3 step 2; issue 583).
 *
 * Two rules, and everything here is one of them:
 *
 *   Read is pure (R-10). A scene file parses as the R-1 union and is handed on as the legacy
 *   shape, because no consumer has moved onto `linearizeSceneFlow` yet — that is step 3. Opening,
 *   scanning, drawing a board and exporting a legacy scene write nothing and raise nothing.
 *
 *   Every authored write lands the graph shape (R-11). The first one to touch a legacy scene
 *   materialises its `flow`; there is no phase in which a file carries both, and no write that
 *   puts `shots[]` back.
 *
 * Which writes count as authored is decided by the callers, not here. The storyboard's save, a
 * shot's prompt override, an accepted proposal and a restore do. Three do not, each for its own
 * stated reason: the compiled board and the landed storyboard are production output and ride
 * `preserveVersion` (R-10); scene reorder writes `order`, which R-19 keeps outside the scene
 * graph; and adopting an outside edit writes back the bytes a person typed, unchanged, because
 * that is what adoption is (R-62). All three leave whichever shape they found in place.
 *
 * The boundary itself is nobody's decision here. It follows the bytes, inside the commit — see
 * `carriesSceneFlow` and its use in `commit.ts` — so a graph scene that reached the disk by a
 * route none of this anticipated still fences the world it landed in.
 */

/**
 * The world-schema boundary a graph-backed scene lives behind (R-9).
 *
 * Separate from `SUPPORTED_SCHEMA_VERSION`, which is the newest boundary this build understands
 * at all: that number may go on rising for reasons that have nothing to do with scene flow, and
 * a graph scene stays fenced by the version that introduced it.
 */
export const GRAPH_SCENE_SCHEMA_VERSION = 3;

/**
 * A write refused because the graph it would land is not one path (R-59, R-61).
 *
 * Named findings rather than a code, the same discipline as `SceneDeleteRefused`: a person told
 * "cannot save" learns nothing, and a person told which group names a shot that is not there
 * knows what to open.
 */
export class SceneFlowRefused extends Error {
  constructor(readonly findings: SceneFlowFinding[]) {
    super(findings.map((finding) => finding.message).join(" "));
    this.name = "SceneFlowRefused";
  }
}

/** The union (R-1), from the bytes on disk. Throws with the conflicting or missing key named. */
export function parseSceneRecord(raw: string): SceneRecord {
  return SceneRecordSchema.parse(JSON.parse(raw));
}

/**
 * The legacy-shaped view every consumer in this step still reads (R-10, R-16's scaffolding).
 *
 * A malformed graph throws instead of projecting a guess. In the scan that becomes the file's
 * problem entry and the rest of the world opens (R-60); in a writer it refuses the write.
 */
export function sceneFrom(record: SceneRecord): Scene {
  const projection = projectSceneRecord(record);
  if (projection.kind === "invalid") throw new SceneFlowRefused(projection.findings);
  return projection.scene;
}

/** Both halves at once, for the readers that need to know which arm they got. */
export function readSceneRecord(raw: string): { record: SceneRecord; scene: Scene } {
  const record = parseSceneRecord(raw);
  return { record, scene: sceneFrom(record) };
}

/**
 * What an authored write puts on disk (R-11, R-12, R-14).
 *
 * `next` is the authored scene in the shape every writer still builds — whole record, ordered
 * `shots[]` — and `current` is what the file says now, so the two cases can be told apart:
 *
 *   A legacy scene migrates, and migration is `migrateLegacyScene` and nothing else. What Flow
 *   would have shown before the write is what the file says after it, and repeating it is
 *   byte-identical (R-12).
 *
 *   A scene already graph-backed keeps its graph. A payload edit — new wording, a prompt
 *   override — replaces the shot inside its node and leaves node ids, edges and authored groups
 *   untouched, because ids are stable across labels (R-2) and re-minting them would silently
 *   re-point every group and every stored reference at nothing.
 *
 * A write that changes which shots the scene holds, or the order they run in, still has to
 * rebuild: the whole-scene writer's payload carries an array and no graph, which is exactly what
 * step 4's semantic commands exist to replace. Authored groups are carried across that rebuild
 * rather than dropped, and if they no longer describe the scene the write is refused by name —
 * losing a beat somebody wrote is not a repair.
 */
export function graphSceneFor(current: SceneRecord | null, next: Scene): GraphScene {
  const migrated = migrateLegacyScene(next);
  if (current === null || !isGraphScene(current)) return refuseUnlessOnePath(migrated);

  const held = linearizeSceneFlow(current);
  // A malformed graph is not quietly rewritten into a valid one (R-59): the file on disk says
  // something nobody can read as an order, and a save that silently replaced it would destroy
  // the evidence of what went wrong along with any chance of restoring it.
  if (held.kind === "invalid") throw new SceneFlowRefused(held.findings);

  const structureHeld =
    held.shots.length === next.shots.length &&
    held.shots.every((pair, index) => pair.shot.id === next.shots[index]!.id);
  if (!structureHeld) {
    return refuseUnlessOnePath({
      ...migrated,
      flow: { ...migrated.flow, storyboardGroups: current.flow.storyboardGroups },
    });
  }

  const byId = new Map(next.shots.map((shot) => [shot.id, shot]));
  return refuseUnlessOnePath({
    ...migrated,
    flow: {
      ...current.flow,
      nodes: current.flow.nodes.map((node) =>
        node.kind === "shot" && byId.has(node.shot.id) ? { ...node, shot: byId.get(node.shot.id)! } : node,
      ),
    },
  });
}

/** Construct, validate completely, and only then let it near a commit (R-61). */
function refuseUnlessOnePath(scene: GraphScene): GraphScene {
  const findings = validateSceneFlow(scene.flow);
  if (findings.length > 0) throw new SceneFlowRefused(findings);
  return scene;
}

/** The same, as the bytes a commit takes. Two spaces and a trailing newline, like every record. */
export function graphSceneContent(current: SceneRecord | null, next: Scene): string {
  return `${JSON.stringify(graphSceneFor(current, next), null, 2)}\n`;
}

/**
 * The bytes a restore lands (R-15).
 *
 * A schema-2 snapshot is a legacy scene, and putting it back as it stands would write `shots[]`
 * into a world that has moved past that shape. It goes through the same deterministic migration
 * the first authored write used, so what comes back is the snapshot's authored content and
 * nothing else. A snapshot already graph-backed comes back verbatim — node ids and authored
 * groups intact — but only once its topology has been checked: restoring a graph the scan would
 * then drop replaces a scene somebody can open with one nobody can, which is the opposite of
 * what undo is for (R-59, R-61).
 */
export function restoredSceneContent(snapshot: string): string {
  const record = parseSceneRecord(snapshot);
  if (!isGraphScene(record)) return graphSceneContent(null, record);
  const findings = validateSceneFlow(record.flow);
  if (findings.length > 0) throw new SceneFlowRefused(findings);
  return snapshot;
}

/**
 * Do these bytes need the graph-scene boundary (R-9)?
 *
 * Asked of the file rather than of a parsed record, and deliberately: a scene carrying `flow` is
 * one an older build reads as a parse failure and drops, whether or not it satisfies the strict
 * schema. The fence is about what is on disk, not about what is well-formed.
 */
export function carriesSceneFlow(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) && "flow" in value;
  } catch {
    return false;
  }
}
