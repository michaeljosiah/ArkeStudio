import { z } from "zod";
import { SceneFlowEdgeIdSchema, SceneFlowNodeIdSchema, StoryboardGroupIdSchema } from "./ids.js";
import { SceneBaseShape, SceneSchema, ShotSchema, type Scene, type Shot } from "./scene.js";

/**
 * The canonical scene flow (SPEC-029; issue 479).
 *
 * A graph-backed scene stores its internal structure as a bounded, typed graph: one Entry,
 * shot nodes, one Exit, sequence edges, and authored storyboard groups. The graph is canonical,
 * not a projection — a graph scene has no `shots[]` beside it (R-1), and every ordered-shot
 * consumer linearises through the one function at the bottom of this file (R-7, R-16).
 *
 * Version 1 is deliberately linear: the accepted shape is one forward path through every shot
 * exactly once (R-6). The data shape is extensible; the accepted shape is not — a future node
 * or edge kind needs its own specification and schema boundary before it may parse (R-4).
 *
 * Rollout steps 1 and 2 (§3.3) live here: the shapes, pure validation and linearisation, the
 * deterministic legacy projection, and — since the scan now reads the union — the two functions
 * the schema-3 writer and the legacy-shaped read path are made of. Nothing in this file touches
 * a disk. The consumer sweep is step 3; until it lands, `projectSceneRecord` is what a consumer
 * still reading `scene.shots` is handed, and it is derived read-side state, never stored.
 */

// ---------------------------------------------------------------------------
// Shapes (R-2..R-5): strict, and ports typed by node kind rather than stored
// ---------------------------------------------------------------------------

/**
 * V1 node kinds (R-3). Entry and Exit carry no payload; a shot node carries the one authored
 * `Shot` record unchanged — takes and selections stay outside it, exactly as they are outside
 * the legacy array. Unknown kinds and unknown keys fail parse with the key named.
 */
export const SceneFlowNodeSchema = z.discriminatedUnion("kind", [
  z.object({ id: SceneFlowNodeIdSchema, kind: z.literal("entry") }).strict(),
  z.object({ id: SceneFlowNodeIdSchema, kind: z.literal("shot"), shot: ShotSchema }).strict(),
  z.object({ id: SceneFlowNodeIdSchema, kind: z.literal("exit") }).strict(),
]);
export type SceneFlowNode = z.infer<typeof SceneFlowNodeSchema>;

/**
 * V1 edges are sequence only (R-5), and the port names are literals: `from` is always an `out`,
 * `to` is always an `in`. What remains checkable — and is checked in validation, not parse — is
 * whether the named node actually has that port: an edge out of Exit or into Entry parses as a
 * shape and fails as a graph, so a malformed file still opens read-only (R-60).
 */
export const SceneFlowEdgeSchema = z
  .object({
    id: SceneFlowEdgeIdSchema,
    kind: z.literal("sequence"),
    from: z.object({ nodeId: SceneFlowNodeIdSchema, port: z.literal("out") }).strict(),
    to: z.object({ nodeId: SceneFlowNodeIdSchema, port: z.literal("in") }).strict(),
  })
  .strict();
export type SceneFlowEdge = z.infer<typeof SceneFlowEdgeSchema>;

/**
 * An authored storyboard beat (R-30): stable id, authored title, members by shot-node id —
 * never by shot number or array position, so reorder cannot silently change what a group means.
 * Contiguity and overlap are graph validation, not parse: they need the canonical order.
 */
export const StoryboardGroupSchema = z
  .object({
    id: StoryboardGroupIdSchema,
    title: z.string().min(1),
    shotNodeIds: z.array(SceneFlowNodeIdSchema).min(1),
  })
  .strict();
export type StoryboardGroup = z.infer<typeof StoryboardGroupSchema>;

export const SceneFlowSchema = z
  .object({
    schemaVersion: z.literal(1),
    entryNodeId: SceneFlowNodeIdSchema,
    exitNodeId: SceneFlowNodeIdSchema,
    nodes: z.array(SceneFlowNodeSchema),
    edges: z.array(SceneFlowEdgeSchema),
    storyboardGroups: z.array(StoryboardGroupSchema),
  })
  .strict();
export type SceneFlow = z.infer<typeof SceneFlowSchema>;

/**
 * Ports derive from node kind (R-4) — they are never repeated as mutable arrays on disk, so a
 * stored port list can never disagree with what the kind means. Entry starts, Exit ends, a
 * shot passes through.
 */
export function sceneFlowPorts(kind: SceneFlowNode["kind"]): ReadonlyArray<"in" | "out"> {
  return kind === "entry" ? ["out"] : kind === "exit" ? ["in"] : ["in", "out"];
}

// ---------------------------------------------------------------------------
// The read union (R-1): legacy shots[] or graph flow — exactly one, named
// ---------------------------------------------------------------------------

/** R-1's vocabulary for what `SceneSchema` has always parsed: `shots[]` owns payload and order. */
export const LegacySceneSchema = SceneSchema;
export type LegacyScene = Scene;

/** A graph-backed scene: every shared field identical to the legacy arm, `flow` in place of `shots`. */
export const GraphSceneSchema = z.object({ ...SceneBaseShape, flow: SceneFlowSchema }).strict();
export type GraphScene = z.infer<typeof GraphSceneSchema>;

export type SceneRecord = LegacyScene | GraphScene;

export function isGraphScene(scene: SceneRecord): scene is GraphScene {
  return "flow" in scene;
}

/**
 * The two-arm read union (R-1). Presence of the structural key picks the arm; carrying both or
 * neither fails parse with the conflicting or missing keys named, because a file that says
 * `A → B` in one field and `[B, A]` in the other has two sequence authorities and history could
 * never explain which one the creator changed (§2.1). This is what the scan parses scene files
 * with — it had to become the read the same step the migration writer landed, or the first
 * authored write would have produced a file the build that wrote it could no longer read.
 */
export const SceneRecordSchema = z.unknown().transform((value, ctx): SceneRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a scene record must be an object" });
    return z.NEVER;
  }
  const hasShots = "shots" in value;
  const hasFlow = "flow" in value;
  if (hasShots && hasFlow) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'carries both "shots" and "flow" — a scene keeps exactly one structural authority (SPEC-029 R-1)',
    });
    return z.NEVER;
  }
  if (!hasShots && !hasFlow) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'carries neither "shots" nor "flow" — a scene needs one structural authority (SPEC-029 R-1)',
    });
    return z.NEVER;
  }
  const parsed = (hasFlow ? GraphSceneSchema : LegacySceneSchema).safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue(issue);
    return z.NEVER;
  }
  return parsed.data;
});

// ---------------------------------------------------------------------------
// Deterministic identity (R-12) and the legacy projection (R-10)
// ---------------------------------------------------------------------------

/** `sc_bell-room` → `sc-bell-room`: ids only ever hold the one prefix underscore. */
function flowToken(id: string): string {
  return id.replace("_", "-");
}

/** The scene's terminals are named from the scene id: `sfn_sc-bell-room-entry` (§2.3). */
export function entryNodeIdFor(sceneId: string): string {
  return `sfn_${flowToken(sceneId)}-entry`;
}

export function exitNodeIdFor(sceneId: string): string {
  return `sfn_${flowToken(sceneId)}-exit`;
}

/** A shot node is named from the shot id alone: `sh_14` → `sfn_sh-14` (§2.3). */
export function shotNodeIdFor(shotId: string): string {
  return `sfn_${flowToken(shotId)}`;
}

/** How a node appears inside an edge id: terminals by their kind, shots by their token. */
function endpointToken(node: SceneFlowNode): string {
  return node.kind === "shot" ? flowToken(node.shot.id) : node.kind;
}

/**
 * A sequence edge is named from its adjacent endpoints (R-12): `sfe_entry-sh-14`,
 * `sfe_sh-14-sh-15`, `sfe_sh-15-exit`. Deterministic so repeating the projection is
 * byte-identical; if pathological shot ids ever made two pairs collide, the duplicate edge id
 * is a named validation finding and a writer must refuse it rather than guess.
 */
export function sequenceEdgeIdFor(from: SceneFlowNode, to: SceneFlowNode): string {
  return `sfe_${endpointToken(from)}-${endpointToken(to)}`;
}

/**
 * A legacy scene resolved in memory (R-10): Entry → `shots[]` order → Exit, no groups, and no
 * write anywhere. Pure and deterministic — same scene in, byte-identical flow out — because
 * this projection is also exactly what the first authored write will materialise (R-11, R-12):
 * migration is this function plus a commit, so what Flow showed before the write is what the
 * file says after it. Node payloads are the scene's own shot records, not copies.
 */
export function resolveLegacySceneFlow(scene: LegacyScene): SceneFlow {
  const entry: SceneFlowNode = { id: entryNodeIdFor(scene.id), kind: "entry" };
  const exit: SceneFlowNode = { id: exitNodeIdFor(scene.id), kind: "exit" };
  const shots: SceneFlowNode[] = scene.shots.map((shot) => ({ id: shotNodeIdFor(shot.id), kind: "shot", shot }));
  const chain = [entry, ...shots, exit];
  const edges: SceneFlowEdge[] = [];
  for (let i = 1; i < chain.length; i += 1) {
    const from = chain[i - 1]!;
    const to = chain[i]!;
    edges.push({
      id: sequenceEdgeIdFor(from, to),
      kind: "sequence",
      from: { nodeId: from.id, port: "out" },
      to: { nodeId: to.id, port: "in" },
    });
  }
  return {
    schemaVersion: 1,
    entryNodeId: entry.id,
    exitNodeId: exit.id,
    nodes: chain,
    edges,
    storyboardGroups: [],
  };
}

/**
 * The record the first authored write to a legacy scene lands (R-11, R-12).
 *
 * The projection above plus dropping the array it was read from — migration is that function
 * and a commit, and nothing else. Every other field keeps its identity and its place, so what
 * this returns differs from what went in by exactly one key. `storyboardGroups` is empty
 * because migration authors no beats; people do (R-12). Deterministic and total: the same scene
 * in gives byte-identical `flow` out, and every legacy scene has exactly one graph form.
 */
export function migrateLegacyScene(scene: LegacyScene): GraphScene {
  const { shots: _shots, ...base } = scene;
  return { ...base, flow: resolveLegacySceneFlow(scene) };
}

// ---------------------------------------------------------------------------
// Graph validation (R-6, R-58, R-59): named findings, no score, no repair
// ---------------------------------------------------------------------------

export type SceneFlowFindingKind =
  | "duplicate-node-id"
  | "duplicate-edge-id"
  | "duplicate-group-id"
  | "entry-mismatch"
  | "exit-mismatch"
  | "dangling-endpoint"
  | "incompatible-port"
  | "self-edge"
  | "parallel-edges"
  | "branch"
  | "reconvergence"
  | "disconnected"
  | "unreachable-exit"
  | "cycle"
  | "skipped-shot"
  | "group-member-missing"
  | "group-member-not-shot"
  | "group-member-duplicated"
  | "group-overlap"
  | "group-not-contiguous";

export interface SceneFlowFinding {
  kind: SceneFlowFindingKind;
  /** The node, edge, or group it is about, where it is about one. */
  about?: string;
  /** The finding as a sentence a creator can act on (§2.7's vocabulary). */
  message: string;
  /** The stable ids that make it true — enough to locate the problem (R-59). */
  evidence: string[];
}

/** How a node is named in a sentence: the terminals by role, a shot by its number. */
function label(node: SceneFlowNode): string {
  return node.kind === "entry" ? "Scene start" : node.kind === "exit" ? "Scene end" : `Shot ${node.shot.number}`;
}

/** Two and three read better than digits in a refusal; larger counts stay numbers. */
function counted(n: number, noun: string): string {
  const word = n === 2 ? "two" : n === 3 ? "three" : String(n);
  return `${word} ${noun}s`;
}

/**
 * Validate one parsed flow (R-58), in three layers that each assume the one before it:
 * referential first (every id resolves, once, to a node that has the named port), then local
 * shape (each node's in/out counts), then the one-path walk and group contiguity, which only
 * mean anything once the layers under them are clean — so a dangling edge is reported as the
 * dangling edge it is, not as the phantom disconnection it causes. Findings are named with
 * stable ids and evidence; there is no score, no severity, and no repair (R-59): any finding
 * refuses mutation, planning, generation, cut derivation, and export by name.
 *
 * Pure and `O(nodes + edges + group members)` (R-68).
 */
export function validateSceneFlow(flow: SceneFlow): SceneFlowFinding[] {
  const findings: SceneFlowFinding[] = [];

  // --- referential: ids resolve, once, and every endpoint names a port the node has --------
  const nodeById = new Map<string, SceneFlowNode>();
  for (const node of flow.nodes) {
    if (nodeById.has(node.id)) {
      findings.push({
        kind: "duplicate-node-id",
        about: node.id,
        message: `Two nodes carry the id ${node.id}.`,
        evidence: [node.id],
      });
      continue;
    }
    nodeById.set(node.id, node);
  }

  for (const [key, kind] of [
    ["entryNodeId", "entry"],
    ["exitNodeId", "exit"],
  ] as const) {
    const id = flow[key];
    const findingKind = kind === "entry" ? "entry-mismatch" : "exit-mismatch";
    const at = nodeById.get(id);
    if (at === undefined) {
      findings.push({
        kind: findingKind,
        about: id,
        message: `${key} ${id} is not a node in this scene.`,
        evidence: [id],
      });
    } else if (at.kind !== kind) {
      findings.push({
        kind: findingKind,
        about: id,
        message: `${key} ${id} is a ${at.kind} node.`,
        evidence: [id],
      });
    }
    const terminals = flow.nodes.filter((node) => node.kind === kind);
    if (terminals.length !== 1) {
      findings.push({
        kind: findingKind,
        message: `A scene has exactly one ${kind === "entry" ? "start" : "end"}; found ${terminals.length} ${kind} nodes.`,
        evidence: terminals.map((node) => node.id),
      });
    }
  }

  const edgeIds = new Set<string>();
  const pairs = new Map<string, SceneFlowEdge>();
  for (const edge of flow.edges) {
    if (edgeIds.has(edge.id)) {
      findings.push({
        kind: "duplicate-edge-id",
        about: edge.id,
        message: `Two connections carry the id ${edge.id}.`,
        evidence: [edge.id],
      });
    }
    edgeIds.add(edge.id);

    const from = nodeById.get(edge.from.nodeId);
    const to = nodeById.get(edge.to.nodeId);
    for (const [endpoint, node] of [
      [edge.from.nodeId, from],
      [edge.to.nodeId, to],
    ] as const) {
      if (node === undefined) {
        findings.push({
          kind: "dangling-endpoint",
          about: edge.id,
          message: `Connection ${edge.id} points to a node that is missing (${endpoint}).`,
          evidence: [edge.id, endpoint],
        });
      }
    }
    if (from !== undefined && !sceneFlowPorts(from.kind).includes("out")) {
      findings.push({
        kind: "incompatible-port",
        about: edge.id,
        message: `Connection ${edge.id} leads out of ${label(from)}, which has no output.`,
        evidence: [edge.id, from.id],
      });
    }
    if (to !== undefined && !sceneFlowPorts(to.kind).includes("in")) {
      findings.push({
        kind: "incompatible-port",
        about: edge.id,
        message: `Connection ${edge.id} leads into ${label(to)}, which has no input.`,
        evidence: [edge.id, to.id],
      });
    }
    if (edge.from.nodeId === edge.to.nodeId) {
      findings.push({
        kind: "self-edge",
        about: edge.id,
        message: `Connection ${edge.id} connects ${from !== undefined ? label(from) : edge.from.nodeId} to itself. A scene needs one forward path.`,
        evidence: [edge.id, edge.from.nodeId],
      });
      continue;
    }
    const pair = `${edge.from.nodeId} > ${edge.to.nodeId}`;
    const first = pairs.get(pair);
    if (first !== undefined) {
      findings.push({
        kind: "parallel-edges",
        about: edge.id,
        message: `${from !== undefined ? label(from) : edge.from.nodeId} is connected to ${to !== undefined ? label(to) : edge.to.nodeId} twice.`,
        evidence: [first.id, edge.id],
      });
    } else {
      pairs.set(pair, edge);
    }
  }

  // Groups, referentially: members exist, are shots, and belong to at most one group (R-31).
  const groupIds = new Set<string>();
  const memberOf = new Map<string, StoryboardGroup>();
  for (const group of flow.storyboardGroups) {
    if (groupIds.has(group.id)) {
      findings.push({
        kind: "duplicate-group-id",
        about: group.id,
        message: `Two storyboard groups carry the id ${group.id}.`,
        evidence: [group.id],
      });
    }
    groupIds.add(group.id);
    const seen = new Set<string>();
    for (const memberId of group.shotNodeIds) {
      const node = nodeById.get(memberId);
      if (node === undefined) {
        findings.push({
          kind: "group-member-missing",
          about: group.id,
          message: `“${group.title}” names a shot node that is missing (${memberId}).`,
          evidence: [group.id, memberId],
        });
        continue;
      }
      if (node.kind !== "shot") {
        findings.push({
          kind: "group-member-not-shot",
          about: group.id,
          message: `“${group.title}” includes ${label(node)}, which is not a shot.`,
          evidence: [group.id, memberId],
        });
        continue;
      }
      if (seen.has(memberId)) {
        findings.push({
          kind: "group-member-duplicated",
          about: group.id,
          message: `“${group.title}” lists ${label(node)} twice.`,
          evidence: [group.id, memberId],
        });
        continue;
      }
      seen.add(memberId);
      const other = memberOf.get(memberId);
      if (other !== undefined) {
        findings.push({
          kind: "group-overlap",
          about: memberId,
          message: `${label(node)} is in “${other.title}” and “${group.title}”. A shot belongs to at most one group.`,
          evidence: [other.id, group.id, memberId],
        });
        continue;
      }
      memberOf.set(memberId, group);
    }
  }

  if (findings.length > 0) return findings;

  // --- local shape: each node's in and out counts against what its kind means (R-6) --------
  const outEdges = new Map<string, SceneFlowEdge[]>();
  const inEdges = new Map<string, SceneFlowEdge[]>();
  for (const edge of flow.edges) {
    const outs = outEdges.get(edge.from.nodeId);
    if (outs === undefined) outEdges.set(edge.from.nodeId, [edge]);
    else outs.push(edge);
    const ins = inEdges.get(edge.to.nodeId);
    if (ins === undefined) inEdges.set(edge.to.nodeId, [edge]);
    else ins.push(edge);
  }
  for (const node of flow.nodes) {
    const outs = outEdges.get(node.id) ?? [];
    const ins = inEdges.get(node.id) ?? [];
    // An edge into Entry or out of Exit was already refused as an incompatible port, so here
    // only the counts a node's real ports allow remain to check.
    if (node.kind !== "exit" && outs.length > 1) {
      findings.push({
        kind: "branch",
        about: node.id,
        message:
          node.kind === "shot"
            ? `${label(node)} has ${counted(outs.length, "next shot")}. Choices belong between scenes.`
            : `${label(node)} has ${counted(outs.length, "outgoing connection")}. A scene needs one forward path.`,
        evidence: [node.id, ...outs.map((edge) => edge.id)],
      });
    }
    if (node.kind !== "entry" && ins.length > 1) {
      findings.push({
        kind: "reconvergence",
        about: node.id,
        message: `${label(node)} has ${counted(ins.length, "previous connection")}. Paths do not merge inside a scene.`,
        evidence: [node.id, ...ins.map((edge) => edge.id)],
      });
    }
    if (node.kind === "entry" && outs.length === 0) {
      findings.push({
        kind: "disconnected",
        about: node.id,
        message: "Scene start is not connected to anything.",
        evidence: [node.id],
      });
    }
    if (node.kind === "exit" && ins.length === 0) {
      findings.push({
        kind: "unreachable-exit",
        about: node.id,
        message: "Nothing connects to Scene end.",
        evidence: [node.id],
      });
    }
    if (node.kind === "shot" && (ins.length === 0 || outs.length === 0)) {
      findings.push({
        kind: "disconnected",
        about: node.id,
        message: `${label(node)} is not connected between Scene start and end.`,
        evidence: [node.id],
      });
    }
  }

  if (findings.length > 0) return findings;

  // --- the one path (R-6): from Entry, every shot exactly once, ending at Exit -------------
  // With the layers above clean, every node has exactly the degrees its kind allows, so the
  // walk from Entry cannot revisit (a revisit needs two ins) and can only stop at Exit (the
  // one node with no out). What can still be wrong is what the walk never saw: shots whose
  // perfect-looking degrees close over each other in a loop the path never enters.
  const visited = new Set<string>();
  let at = nodeById.get(flow.entryNodeId)!;
  visited.add(at.id);
  while (at.kind !== "exit") {
    at = nodeById.get(outEdges.get(at.id)![0]!.to.nodeId)!;
    visited.add(at.id);
  }
  const skipped = flow.nodes.filter((node) => node.kind === "shot" && !visited.has(node.id));
  if (skipped.length > 0) {
    findings.push({
      kind: "skipped-shot",
      message: `${skipped.map((node) => label(node)).join(" and ")} ${skipped.length === 1 ? "is" : "are"} never reached between Scene start and end.`,
      evidence: skipped.map((node) => node.id),
    });
    const reported = new Set<string>();
    for (const node of skipped) {
      if (reported.has(node.id)) continue;
      // Follow the loop these degrees necessarily form, so the refusal can say where it closes.
      const loop: SceneFlowNode[] = [node];
      reported.add(node.id);
      let cursor = nodeById.get(outEdges.get(node.id)![0]!.to.nodeId)!;
      while (cursor.id !== node.id) {
        loop.push(cursor);
        reported.add(cursor.id);
        cursor = nodeById.get(outEdges.get(cursor.id)![0]!.to.nodeId)!;
      }
      findings.push({
        kind: "cycle",
        about: node.id,
        message: `${label(loop[loop.length - 1]!)} leads back to ${label(node)}. A scene needs one forward path.`,
        evidence: loop.map((member) => member.id),
      });
    }
    return findings;
  }

  // --- authored groups stay together (R-31): contiguous runs of the canonical order --------
  const position = new Map<string, number>();
  for (const id of visited) position.set(id, position.size);
  for (const group of flow.storyboardGroups) {
    const positions = group.shotNodeIds.map((memberId) => position.get(memberId)!);
    const lowest = Math.min(...positions);
    const highest = Math.max(...positions);
    if (highest - lowest + 1 === positions.length) continue;
    const held = new Set(group.shotNodeIds);
    const gaps = [...position.entries()]
      .filter(([id, place]) => place > lowest && place < highest && !held.has(id))
      .map(([id]) => nodeById.get(id)!);
    findings.push({
      kind: "group-not-contiguous",
      about: group.id,
      message: `“${group.title}” skips ${gaps.length > 0 ? label(gaps[0]!) : "a shot"}. A storyboard group must stay together.`,
      evidence: [group.id, ...gaps.map((node) => node.id)],
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// The one ordered-shot boundary (R-7, R-16, R-18)
// ---------------------------------------------------------------------------

export interface SceneSequenceShot {
  nodeId: string;
  shot: Shot;
}

/**
 * The sole ordered-shot result (R-16). `linear` carries the pairs in canonical order plus the
 * terminals; `invalid` carries the named findings and no shots at all — a malformed graph is
 * never partially linearised (R-7), because half a sequence is exactly the guess every
 * downstream consumer must refuse to make (R-59).
 */
export type SceneSequence =
  | { kind: "linear"; entryNodeId: string; exitNodeId: string; shots: SceneSequenceShot[] }
  | { kind: "invalid"; findings: SceneFlowFinding[] };

/**
 * The one place shot order comes from (R-7). A graph scene is validated and walked Entry to
 * Exit; a legacy scene resolves as its array order with the same deterministic node identity
 * the migration will one day write (R-10) — so both arms answer with the same shape and a
 * consumer moved onto this function never learns which arm it read. Storage order of `nodes[]`
 * and `edges[]` never matters (R-18): only the edges decide what follows what.
 *
 * The returned array is fresh; the shot payloads are the scene's own records, exactly as the
 * legacy array shared them.
 */
export function linearizeSceneFlow(scene: SceneRecord): SceneSequence {
  if (!isGraphScene(scene)) {
    return {
      kind: "linear",
      entryNodeId: entryNodeIdFor(scene.id),
      exitNodeId: exitNodeIdFor(scene.id),
      shots: scene.shots.map((shot) => ({ nodeId: shotNodeIdFor(shot.id), shot })),
    };
  }
  const findings = validateSceneFlow(scene.flow);
  if (findings.length > 0) return { kind: "invalid", findings };
  const nodeById = new Map(scene.flow.nodes.map((node) => [node.id, node]));
  const nextOf = new Map(scene.flow.edges.map((edge) => [edge.from.nodeId, edge.to.nodeId]));
  const shots: SceneSequenceShot[] = [];
  let at = nodeById.get(scene.flow.entryNodeId)!;
  while (at.kind !== "exit") {
    at = nodeById.get(nextOf.get(at.id)!)!;
    if (at.kind === "shot") shots.push({ nodeId: at.id, shot: at.shot });
  }
  return {
    kind: "linear",
    entryNodeId: scene.flow.entryNodeId,
    exitNodeId: scene.flow.exitNodeId,
    shots,
  };
}

/** A scene in the legacy shape, or the reasons it could not be read as one. */
export type SceneProjection =
  | { kind: "scene"; scene: LegacyScene }
  | { kind: "invalid"; findings: SceneFlowFinding[] };

/**
 * Either arm as the legacy shape — the read path's scaffolding for rollout step 2 (§3.3).
 *
 * The scan reads the union; every consumer still reads `scene.shots`. This is the one place
 * those two facts are reconciled, and it is a *derivation*, not a second stored authority: it is
 * computed at scan, never written back, and a graph scene's `flow` remains the only thing on
 * disk that says what follows what (R-14). Step 3 moves the consumers onto `linearizeSceneFlow`
 * and deletes this function; nothing new should be built on it.
 *
 * A malformed graph projects to nothing at all rather than to a guessed array (R-7, R-59) — the
 * caller reports the findings as the per-file problem they are and leaves the rest of the world
 * open (R-60).
 */
export function projectSceneRecord(record: SceneRecord): SceneProjection {
  if (!isGraphScene(record)) return { kind: "scene", scene: record };
  const sequence = linearizeSceneFlow(record);
  if (sequence.kind === "invalid") return { kind: "invalid", findings: sequence.findings };
  const { flow: _flow, ...base } = record;
  return { kind: "scene", scene: { ...base, shots: sequence.shots.map((pair) => pair.shot) } };
}
