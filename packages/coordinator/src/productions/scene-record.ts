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
  sequenceEdgeIdFor,
} from "@arke-studio/contracts";

/**
 * Compatibility boundaries for scene files (SPEC-029; issue 583).
 *
 * Two rules, and everything here is one of them:
 *
 *   Read is pure (R-10). A scene file parses as the R-1 union. The legacy-shaped projection is
 *   retained only for read-only compatibility with legacy APIs and fixtures; it writes nothing
 *   and is never stored authority.
 *
 *   Canonical scene authorship uses graph operations. The legacy-candidate upgrader remains only
 *   to restore legacy snapshots and accept or compare legacy proposals persisted before direct
 *   whole-scene authorship retired. It never puts `shots[]` back.
 *
 * Whole-document persistence remains atomic. The schema boundary follows the bytes inside the
 * commit — see `carriesSceneFlow` and its use in `commit.ts` — so a graph scene that reached disk
 * by any route still fences the world it landed in.
 */

/**
 * The world-schema boundary a graph-backed scene lives behind (R-9).
 *
 * Separate from `SUPPORTED_SCHEMA_VERSION`, which is the newest boundary this build understands
 * at all: that number may go on rising for reasons that have nothing to do with scene flow, and
 * a graph scene stays fenced by the version that introduced it.
 */
export const GRAPH_SCENE_SCHEMA_VERSION = 3;
export const STAGE_BLOCKING_SCHEMA_VERSION = 6;
export const STAGE_PERFORMANCE_SCHEMA_VERSION = 7;
export const STAGE_EASING_SCHEMA_VERSION = 8;
export const STAGE_RIG_SCHEMA_VERSION = 9;

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
 * A read-only legacy-shaped projection for compatibility APIs and fixtures (R-10).
 * A malformed graph throws instead of projecting a guessed order.
 */
export function sceneFrom(record: SceneRecord): Scene {
  const projection = projectSceneRecord(record);
  if (projection.kind === "invalid") throw new SceneFlowRefused(projection.findings);
  return projection.scene;
}

/** Parse a record and return its read-only legacy projection for compatibility callers. */
export function readSceneRecord(raw: string): { record: SceneRecord; scene: Scene } {
  const record = parseSceneRecord(raw);
  return { record, scene: sceneFrom(record) };
}

/**
 * Upgrade a persisted legacy-shaped candidate to a graph scene (R-11, R-12, R-14).
 *
 * This adapter exists only to restore legacy snapshots and to accept or compare legacy proposals
 * persisted before direct whole-scene authorship retired. New drafts and World Chat proposals are
 * already `GraphScene` values and must not pass through it.
 *
 * A legacy current record migrates deterministically. When comparing or accepting a legacy
 * candidate over an existing graph, unchanged structure keeps node ids, edges and authored
 * groups. A structural difference rebuilds the sequence while preserving surviving node ids and
 * groups, and refuses the result if those groups no longer describe a valid scene.
 */
export function upgradeLegacySceneCandidate(current: SceneRecord | null, next: Scene): GraphScene {
  let migrated = migrateLegacyScene(next);
  if (current === null || !isGraphScene(current)) return refuseUnlessOnePath(migrated);
  // A proposal persisted before shared Stage blocking existed cannot erase blocking authored
  // after it was drafted. Snapshot restore passes no current record, where absence stays absence.
  if (next.blocking === undefined && current.blocking !== undefined) {
    migrated = { ...migrated, blocking: current.blocking };
  }

  const held = linearizeSceneFlow(current);
  // A malformed graph is not quietly rewritten into a valid one (R-59): the file on disk says
  // something nobody can read as an order, and upgrading a legacy candidate over it would destroy
  // the evidence of what went wrong along with any chance of restoring it.
  if (held.kind === "invalid") throw new SceneFlowRefused(held.findings);

  const structureHeld =
    held.shots.length === next.shots.length &&
    held.shots.every((pair, index) => pair.shot.id === next.shots[index]!.id);
  if (!structureHeld) {
    /*
     * A structurally different legacy candidate keeps the node identity the scene already had
     * (#601 round 2).
     *
     * Rebuilding from `migrateLegacyScene` alone re-mints every node and edge id from the
     * projection's own rule. That is harmless while every id in the world came from that same
     * rule — but a semantic command or a group edit can author ids the projection would not
     * have chosen, and then a surviving shot silently changes node id while the groups that
     * name it do not, so a grouped scene is refused even though all its shots are still there.
     * So: a shot that survives keeps the node id the live flow gave it, and only a shot the
     * candidate introduced gets a freshly minted one. Edges are re-derived either way — the
     * adjacency is exactly what changed.
     */
    const heldNodeIds = new Map(
      current.flow.nodes.flatMap((node) => (node.kind === "shot" ? [[node.shot.id, node.id] as const] : [])),
    );
    const nodes = migrated.flow.nodes.map((node) =>
      node.kind === "shot" && heldNodeIds.has(node.shot.id)
        ? { ...node, id: heldNodeIds.get(node.shot.id)! }
        : node,
    );
    // Only shot nodes can be renamed here — the terminals are named from the scene id, which a
    // legacy candidate does not touch — so the edge rewrite reads its endpoints off the same map.
    const renamed = new Map(
      migrated.flow.nodes.flatMap((node, index) =>
        node.id === nodes[index]!.id ? [] : [[node.id, nodes[index]!.id] as const],
      ),
    );
    const byNode = new Map(nodes.map((node) => [node.id, node] as const));
    const edges = migrated.flow.edges.map((edge) => {
      const from = byNode.get(renamed.get(edge.from.nodeId) ?? edge.from.nodeId)!;
      const to = byNode.get(renamed.get(edge.to.nodeId) ?? edge.to.nodeId)!;
      return {
        ...edge,
        id: sequenceEdgeIdFor(from, to),
        from: { ...edge.from, nodeId: from.id },
        to: { ...edge.to, nodeId: to.id },
      };
    });
    return refuseUnlessOnePath({
      ...migrated,
      flow: { ...migrated.flow, nodes, edges, storyboardGroups: current.flow.storyboardGroups },
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

/** Serialize a persisted legacy proposal or snapshot after its compatibility upgrade. */
export function legacySceneCandidateContent(current: SceneRecord | null, next: Scene): string {
  return `${JSON.stringify(upgradeLegacySceneCandidate(current, next), null, 2)}\n`;
}

/**
 * The bytes a restore lands (R-15).
 *
 * A schema-2 snapshot is a legacy scene, and putting it back as it stands would write `shots[]`
 * into a world that has moved past that shape. It goes through the deterministic legacy-candidate
 * upgrade, so what comes back is the snapshot's authored content and nothing else. A snapshot
 * already graph-backed comes back verbatim — node ids and authored
 * groups intact — but only once its topology has been checked: restoring a graph the scan would
 * then drop replaces a scene somebody can open with one nobody can, which is the opposite of
 * what undo is for (R-59, R-61).
 */
export function restoredSceneContent(snapshot: string): string {
  const record = parseSceneRecord(snapshot);
  if (!isGraphScene(record)) return legacySceneCandidateContent(null, record);
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

/** Do these scene bytes use shared blocking or a camera that inherits it? */
export function carriesStageBlocking(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if ("blocking" in object) return true;
    const direct = Array.isArray(object["shots"]) ? object["shots"] : [];
    const flow = object["flow"];
    const nodes = typeof flow === "object" && flow !== null && Array.isArray((flow as Record<string, unknown>)["nodes"])
      ? (flow as Record<string, unknown>)["nodes"] as unknown[]
      : [];
    const shots = [
      ...direct,
      ...nodes.flatMap((node) =>
        typeof node === "object" && node !== null && (node as Record<string, unknown>)["kind"] === "shot"
          ? [(node as Record<string, unknown>)["shot"]]
          : []),
    ];
    return shots.some((shot) => {
      if (typeof shot !== "object" || shot === null) return false;
      const staging = (shot as Record<string, unknown>)["staging"];
      if (typeof staging !== "object" || staging === null) return false;
      const playblast = (staging as Record<string, unknown>)["playblast"];
      const pinsBlocking = typeof playblast === "object" && playblast !== null && "blocking" in playblast;
      return pinsBlocking || !("cast" in staging) || !("sets" in staging);
    });
  } catch {
    return false;
  }
}

/** Do these scene bytes carry the static figure posture introduced after shared blocking? */
export function carriesStagePerformance(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const direct = Array.isArray(object["shots"]) ? object["shots"] : [];
    const flow = object["flow"];
    const nodes = typeof flow === "object" && flow !== null && Array.isArray((flow as Record<string, unknown>)["nodes"])
      ? (flow as Record<string, unknown>)["nodes"] as unknown[]
      : [];
    const shots = [
      ...direct,
      ...nodes.flatMap((node) =>
        typeof node === "object" && node !== null && (node as Record<string, unknown>)["kind"] === "shot"
          ? [(node as Record<string, unknown>)["shot"]]
          : []),
    ];
    const blocks = [
      object["blocking"],
      ...shots.map((shot) => typeof shot === "object" && shot !== null ? (shot as Record<string, unknown>)["staging"] : undefined),
    ];
    return blocks.some((block) => {
      if (typeof block !== "object" || block === null) return false;
      const cast = (block as Record<string, unknown>)["cast"];
      return Array.isArray(cast) && cast.some((figure) => typeof figure === "object" && figure !== null && "pose" in figure);
    });
  } catch {
    return false;
  }
}

/** Do these scene bytes carry per-key easing that strict schema-7 readers do not know? */
export function carriesStageEasing(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const direct = Array.isArray(object["shots"]) ? object["shots"] : [];
    const flow = object["flow"];
    const nodes = typeof flow === "object" && flow !== null && Array.isArray((flow as Record<string, unknown>)["nodes"])
      ? (flow as Record<string, unknown>)["nodes"] as unknown[]
      : [];
    const shots = [
      ...direct,
      ...nodes.flatMap((node) =>
        typeof node === "object" && node !== null && (node as Record<string, unknown>)["kind"] === "shot"
          ? [(node as Record<string, unknown>)["shot"]]
          : []),
    ];
    return shots.some((shot) => {
      if (typeof shot !== "object" || shot === null) return false;
      const staging = (shot as Record<string, unknown>)["staging"];
      if (typeof staging !== "object" || staging === null) return false;
      const keys = (staging as Record<string, unknown>)["keys"];
      return Array.isArray(keys) && keys.some((key) =>
        typeof key === "object" && key !== null && ("easeIn" in key || "easeOut" in key));
    });
  } catch {
    return false;
  }
}

/** Do these scene bytes carry deterministic camera-rig settings or pins? */
export function carriesStageRig(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const direct = Array.isArray(object["shots"]) ? object["shots"] : [];
    const flow = object["flow"];
    const nodes = typeof flow === "object" && flow !== null && Array.isArray((flow as Record<string, unknown>)["nodes"])
      ? (flow as Record<string, unknown>)["nodes"] as unknown[]
      : [];
    const shots = [
      ...direct,
      ...nodes.flatMap((node) =>
        typeof node === "object" && node !== null && (node as Record<string, unknown>)["kind"] === "shot"
          ? [(node as Record<string, unknown>)["shot"]]
          : []),
    ];
    return shots.some((shot) => {
      if (typeof shot !== "object" || shot === null) return false;
      const staging = (shot as Record<string, unknown>)["staging"];
      return typeof staging === "object" && staging !== null &&
        ("rig" in staging || "seed" in staging || "rigIntensity" in staging);
    });
  } catch {
    return false;
  }
}
