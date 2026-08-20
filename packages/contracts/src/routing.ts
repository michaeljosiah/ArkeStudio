import { z } from "zod";
import { IsoDateTimeSchema, SceneIdSchema } from "./ids.js";

/**
 * Interactive video's routing (epic #401; brief rev 1 §2–§4; Scope §03).
 *
 * One graph authority per production: routing.json. A choice selects the next scene and does
 * nothing else — the schemas are strict, so a `condition`, `state`, or `unlock` key does not
 * fail a rule, it fails PARSE with the key named. That is what "unrepresentable" means here.
 * Scenes stay ordinary SPEC-012 scenes; endings and exclusions are designations, never a
 * second scene kind. Validation is named findings with evidence — no score of any kind.
 */

export const ChoiceSchema = z
  .object({
    /** Stable identity: survives edits and reorders; the words are the label, not the id. */
    id: z.string().regex(/^ch_[a-z0-9-]+$/, "expected ch_<slug>"),
    from: SceneIdSchema,
    /** What the player reads. */
    label: z.string().min(1),
    to: SceneIdSchema,
  })
  .strict();
export type Choice = z.infer<typeof ChoiceSchema>;

export const RoutingSchema = z
  .object({
    version: z.number().int().min(1),
    /** Exactly one start scene — where every route begins. */
    start: SceneIdSchema,
    /** The complete edge list, in authored order — the map's in-layer tiebreak. */
    choices: z.array(ChoiceSchema),
    /** Designations of existing scenes; an ending offers no choices (finding, not parse). */
    endings: z.array(z.object({ sceneId: SceneIdSchema, title: z.string().min(1) }).strict()),
    /** The durable record that makes "unreachable" an author's decision, with its reason. */
    excluded: z.array(z.object({ sceneId: SceneIdSchema, reason: z.string().min(1) }).strict()),
    /** Optional, non-logical, presentation-only. Any other field fails parse. */
    groups: z.array(
      z
        .object({
          id: z.string().regex(/^grp_[a-z0-9-]+$/, "expected grp_<slug>"),
          title: z.string().min(1),
          scenes: z.array(SceneIdSchema),
        })
        .strict(),
    ),
  })
  .strict()
  // Identity is what evidence and edits key on: two choices sharing an id would let one
  // traversal vouch for an edge nobody previewed, and one "remove" delete both. Refused at
  // parse, so the shape cannot exist on disk.
  .superRefine((routing, ctx) => {
    const duplicate = routing.choices.find(
      (choice, index) => routing.choices.findIndex((other) => other.id === choice.id) !== index,
    );
    if (duplicate !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `choice id ${duplicate.id} is used twice` });
    }
    const ending = routing.endings.find(
      (entry, index) => routing.endings.findIndex((other) => other.sceneId === entry.sceneId) !== index,
    );
    if (ending !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${ending.sceneId} is designated an ending twice` });
    }
  });
export type Routing = z.infer<typeof RoutingSchema>;

/** One preview traversal, durable (brief §4): counts only while its choice matches from/to. */
export const TraversalEvidenceSchema = z
  .object({
    ts: IsoDateTimeSchema,
    routingVersion: z.number().int().min(1),
    choiceId: z.string().min(1),
    from: SceneIdSchema,
    to: SceneIdSchema,
    /** The route walked to get here, for the unvisited-route finding's evidence. */
    route: z.array(SceneIdSchema),
  })
  .strict();
export type TraversalEvidence = z.infer<typeof TraversalEvidenceSchema>;

// ---------------------------------------------------------------------------
// Findings (brief §4): named, evidenced, blocks or warns — never a number
// ---------------------------------------------------------------------------

export interface RoutingFinding {
  kind:
    | "unreachable"
    | "invalid-destination"
    | "cannot-reach-ending"
    | "unintended-loop"
    | "untraversed-edge"
    | "unvisited-route"
    | "reconvergence"
    | "ending-with-choices";
  severity: "blocks" | "warns";
  /** The evidence, in words a person acts on — a scene, a choice, a route, by name. */
  detail: string;
  sceneIds: string[];
  choiceIds: string[];
}

function reachableFrom(start: string, edges: ReadonlyMap<string, string[]>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const next of edges.get(at) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * The eight findings of brief §4, as one pure fold over routing + the scene list + evidence.
 * Derived, never stored: a graph edit cannot leave a finding describing a shape that no longer
 * exists. Evidence is version-scoped by identity — a line counts only while the choice it names
 * still exists with the same from/to.
 */
export function routingFindings(
  routing: Routing,
  scenes: ReadonlyArray<{ id: string }>,
  evidence: readonly TraversalEvidence[] = [],
): RoutingFinding[] {
  const findings: RoutingFinding[] = [];
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const excluded = new Set(routing.excluded.map((entry) => entry.sceneId));
  const endings = new Set(routing.endings.map((entry) => entry.sceneId));
  const forward = new Map<string, string[]>();
  const inbound = new Map<string, Choice[]>();
  for (const choice of routing.choices) {
    forward.set(choice.from, [...(forward.get(choice.from) ?? []), choice.to]);
    inbound.set(choice.to, [...(inbound.get(choice.to) ?? []), choice]);
  }

  // Invalid destinations first: every other finding walks edges these would poison.
  for (const choice of routing.choices) {
    for (const [end, id] of [
      ["destination", choice.to],
      ["origin", choice.from],
    ] as const) {
      if (!sceneIds.has(id)) {
        findings.push({
          kind: "invalid-destination",
          severity: "blocks",
          detail: `choice ${choice.id} ("${choice.label}") names ${id} as its ${end}, which is not a scene here`,
          sceneIds: [id],
          choiceIds: [choice.id],
        });
      }
    }
  }

  const reachable = reachableFrom(routing.start, forward);
  for (const scene of scenes) {
    if (!reachable.has(scene.id) && !excluded.has(scene.id)) {
      const nearest = routing.choices.find((choice) => reachable.has(choice.from) && choice.to === scene.id);
      findings.push({
        kind: "unreachable",
        severity: "blocks",
        detail: `${scene.id} is unreachable and not deliberately excluded${
          nearest !== undefined ? ` — nearest reachable ancestor is ${nearest.from}` : ""
        }`,
        sceneIds: [scene.id],
        choiceIds: [],
      });
    }
  }

  // Which scenes can reach an ending — walked backwards from every ending at once.
  const backward = new Map<string, string[]>();
  for (const choice of routing.choices) {
    backward.set(choice.to, [...(backward.get(choice.to) ?? []), choice.from]);
  }
  const canEnd = new Set<string>();
  const queue = [...endings];
  for (const id of queue) canEnd.add(id);
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const previous of backward.get(at) ?? []) {
      if (!canEnd.has(previous)) {
        canEnd.add(previous);
        queue.push(previous);
      }
    }
  }
  const trapped = [...reachable].filter((id) => !canEnd.has(id) && !endings.has(id) && sceneIds.has(id));
  for (const id of trapped) {
    findings.push({
      kind: "cannot-reach-ending",
      severity: "blocks",
      detail: `${id} can never reach an ending — every route from it dead-ends or loops`,
      sceneIds: [id],
      choiceIds: [],
    });
  }
  // The trapped set's cycles are the unintended loops: a cycle an ending escapes is a feature;
  // one nothing escapes is the trap, named as the cycle rather than scene by scene. Trimmed to
  // the actual cycle — a trapped CHAIN into a dead end is not a loop, and calling it one sent
  // the author hunting for a cycle that does not exist. Peeling nodes with no in-trap successor
  // until nothing peels leaves exactly the nodes that sit on cycles.
  if (trapped.length > 0) {
    const inTrap = new Set(trapped);
    let peeled = true;
    while (peeled) {
      peeled = false;
      for (const id of inTrap) {
        if (!(forward.get(id) ?? []).some((next) => inTrap.has(next))) {
          inTrap.delete(id);
          peeled = true;
        }
      }
    }
    if (inTrap.size > 0) {
      const cycle = trapped.filter((id) => inTrap.has(id));
      findings.push({
        kind: "unintended-loop",
        severity: "blocks",
        detail: `no ending escapes the loop through ${cycle.join(" → ")}`,
        sceneIds: cycle,
        choiceIds: [],
      });
    }
  }

  for (const entry of routing.endings) {
    const outgoing = routing.choices.filter((choice) => choice.from === entry.sceneId);
    if (outgoing.length > 0) {
      findings.push({
        kind: "ending-with-choices",
        severity: "blocks",
        detail: `${entry.sceneId} is the ending "${entry.title}" and still offers ${outgoing
          .map((choice) => choice.id)
          .join(", ")}`,
        sceneIds: [entry.sceneId],
        choiceIds: outgoing.map((choice) => choice.id),
      });
    }
  }

  // Traversal: evidence counts only while its choice exists with the same from/to (brief §4).
  const byChoice = new Map(routing.choices.map((choice) => [choice.id, choice]));
  const traversed = new Set(
    evidence
      .filter((line) => {
        const choice = byChoice.get(line.choiceId);
        return choice !== undefined && choice.from === line.from && choice.to === line.to;
      })
      .map((line) => line.choiceId),
  );
  const untraversed = routing.choices.filter(
    (choice) => !traversed.has(choice.id) && sceneIds.has(choice.from) && sceneIds.has(choice.to),
  );
  for (const choice of untraversed) {
    findings.push({
      kind: "untraversed-edge",
      severity: "blocks",
      detail: `choice ${choice.id} ("${choice.label}") has never been traversed in preview`,
      sceneIds: [choice.from, choice.to],
      choiceIds: [choice.id],
    });
  }
  if (untraversed.length > 0) {
    // One representative unvisited route per untraversed edge's origin — named, capped, warns.
    const origins = [...new Set(untraversed.map((choice) => choice.from))].slice(0, 5);
    for (const origin of origins) {
      findings.push({
        kind: "unvisited-route",
        severity: "warns",
        detail: `routes through ${origin} include untraversed choices — preview a route that takes ${untraversed
          .filter((choice) => choice.from === origin)
          .map((choice) => choice.id)
          .join(", ")}`,
        sceneIds: [origin],
        choiceIds: untraversed.filter((choice) => choice.from === origin).map((choice) => choice.id),
      });
    }
  }

  // Reconvergence: a scene two routes reach carries the continuity risk (Scope §03) — named
  // with its inbound choices so the author checks what the shared scene assumes.
  for (const [sceneId, choices] of inbound) {
    if (choices.length > 1 && reachable.has(sceneId)) {
      findings.push({
        kind: "reconvergence",
        severity: "warns",
        detail: `${sceneId} reconverges — routes via ${choices
          .map((choice) => choice.id)
          .join(" and ")} must not contradict what it assumes`,
        sceneIds: [sceneId],
        choiceIds: choices.map((choice) => choice.id),
      });
    }
  }

  return findings;
}

/** What stops an export (brief §6): every blocking finding, in its own words. */
export function publicationBlockers(findings: readonly RoutingFinding[]): RoutingFinding[] {
  return findings.filter((finding) => finding.severity === "blocks");
}

// ---------------------------------------------------------------------------
// The branch map's deterministic layout (brief §3; design turn 84)
// ---------------------------------------------------------------------------

export interface RoutingLayout {
  /** Scene ids by layer, start first: longest-path layering, stable in-layer order. */
  layers: string[][];
  /** Scenes the graph never places (unreachable and unexcluded) — drawn in a trailing layer. */
  unplaced: string[];
}

/**
 * The same graph always draws the same picture: longest-path layers from the start scene,
 * in-layer order by first authored inbound choice then scene id. No force simulation, no
 * dependency — the graphs this medium allows do not justify either.
 */
export function layoutRouting(routing: Routing, scenes: ReadonlyArray<{ id: string }>): RoutingLayout {
  const forward = new Map<string, string[]>();
  for (const choice of routing.choices) {
    forward.set(choice.from, [...(forward.get(choice.from) ?? []), choice.to]);
  }
  const depth = new Map<string, number>([[routing.start, 0]]);
  // Longest path over a bounded walk: cycles cannot deepen forever, so the pass count is the
  // node count — after that, depths are stable and a cycle keeps its first-reached layer.
  const ids = new Set(scenes.map((scene) => scene.id));
  for (let pass = 0; pass < ids.size; pass++) {
    let moved = false;
    for (const choice of routing.choices) {
      const from = depth.get(choice.from);
      if (from === undefined || !ids.has(choice.to)) continue;
      const proposed = from + 1;
      const current = depth.get(choice.to);
      if ((current === undefined || proposed > current) && proposed < ids.size) {
        if (choice.to === routing.start) continue; // the start stays layer 0, cycles or not
        depth.set(choice.to, proposed);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const order = new Map<string, number>();
  routing.choices.forEach((choice, index) => {
    if (!order.has(choice.to)) order.set(choice.to, index);
  });
  // Built dense, never sparse: assigning by layer index leaves holes Array.prototype.map skips,
  // so `?? []` never ran and consumers met undefined layers.
  const deepest = Math.max(0, ...depth.values());
  const layers: string[][] = Array.from({ length: deepest + 1 }, () => []);
  for (const [id, layer] of depth) {
    layers[layer]!.push(id);
  }
  for (const layer of layers) {
    layer.sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1) || (a < b ? -1 : a > b ? 1 : 0));
  }
  const placed = new Set(depth.keys());
  const excluded = new Set(routing.excluded.map((entry) => entry.sceneId));
  const unplaced = scenes
    .map((scene) => scene.id)
    .filter((id) => !placed.has(id) && !excluded.has(id))
    .sort();
  return { layers, unplaced };
}
