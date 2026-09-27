import { routingFindings, type Routing, type RoutingFinding, type RoutingLayout } from "@arke-studio/contracts";

/**
 * The branch map's geometry and words (design turn 157), kept out of the screen so the picture
 * can be tested as numbers: where each card sits, how each choice is drawn between them, and what
 * a finding or a removal says in a person's vocabulary — scene titles and choice labels, never ids.
 */

export const NODE_W = 148;
export const THUMB_H = 83;
export const NODE_H = THUMB_H + 48;
/** Wide enough for a two-line label between layers; the layout pitch is card plus gap. */
export const LAYER_GAP = 120;
export const ROW_GAP = 89;
const PAD_X = 24;
/** Room above the first row for tags and for the arc of a choice that skips a layer. */
const PAD_TOP = 72;
const PORT_DY = 65;
const TRAY_GAP = 36;

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
}

export interface DrawnEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  d: string;
  /** Where the label pill sits. */
  lx: number;
  ly: number;
}

export interface MapGeometry {
  nodes: PlacedNode[];
  edges: DrawnEdge[];
  /** Scenes on no route: unreachable ones and excluded ones the layout does not place. */
  tray: string[];
  trayY: number;
  width: number;
  height: number;
}

/** The out-port a choice leaves from and the in-port it arrives at, for a card at (x, y). */
export function outPort(node: PlacedNode): { x: number; y: number } {
  return { x: node.x + NODE_W, y: node.y + PORT_DY };
}
export function inPort(node: PlacedNode): { x: number; y: number } {
  return { x: node.x, y: node.y + PORT_DY };
}

/**
 * A curve between two cards. The next layer gets an S-curve; a choice that skips a layer arcs over
 * the cards between rather than through them; one that goes back, or stays in its layer, loops
 * underneath. The arrowhead sits six pixels short of the card so it is never under its border.
 */
export function edgePath(
  from: PlacedNode,
  to: PlacedNode,
  layerOf: ReadonlyMap<string, number>,
): { d: string; lx: number; ly: number } {
  const o = outPort(from);
  const i = inPort(to);
  const span = (layerOf.get(to.id) ?? 0) - (layerOf.get(from.id) ?? 0);
  if (span === 1) {
    const bend = Math.max(40, (i.x - o.x) / 2);
    return {
      d: `M${o.x},${o.y} C${o.x + bend},${o.y} ${i.x - bend},${i.y} ${i.x - 6},${i.y}`,
      lx: (o.x + i.x) / 2,
      ly: (o.y + i.y) / 2,
    };
  }
  if (span > 1) {
    const top = Math.min(o.y, i.y) - 150;
    return {
      d: `M${o.x},${o.y} C${o.x + 110},${top} ${i.x - 110},${top} ${i.x - 6},${i.y}`,
      lx: (o.x + i.x) / 2,
      ly: 0.125 * (o.y + i.y) + 0.75 * top,
    };
  }
  const bottom = Math.max(o.y, i.y) + 150;
  return {
    d: `M${o.x},${o.y} C${o.x + 110},${bottom} ${i.x - 110},${bottom} ${i.x - 6},${i.y}`,
    lx: (o.x + i.x) / 2,
    ly: 0.125 * (o.y + i.y) + 0.75 * bottom,
  };
}

/** Cards on the canvas from the layout, the curves between them, and the tray below. */
export function mapGeometry(routing: Routing, scenes: ReadonlyArray<{ id: string }>, layout: RoutingLayout): MapGeometry {
  const layerOf = new Map<string, number>();
  const nodes: PlacedNode[] = [];
  let rows = 0;
  layout.layers.forEach((layer, index) => {
    rows = Math.max(rows, layer.length);
    layer.forEach((id, row) => {
      layerOf.set(id, index);
      nodes.push({ id, x: PAD_X + index * (NODE_W + LAYER_GAP), y: PAD_TOP + row * (NODE_H + ROW_GAP) });
    });
  });
  const at = new Map(nodes.map((node) => [node.id, node]));
  const edges: DrawnEdge[] = [];
  for (const choice of routing.choices) {
    const from = at.get(choice.from);
    const to = at.get(choice.to);
    // A choice from a scene no route reaches, or to one that does not exist, has nowhere to be
    // drawn; the card's meta counts it and the findings name it.
    if (from === undefined || to === undefined) continue;
    edges.push({ id: choice.id, from: choice.from, to: choice.to, label: choice.label, ...edgePath(from, to, layerOf) });
  }
  const placed = new Set(at.keys());
  const known = new Set(scenes.map((scene) => scene.id));
  const excludedOff = routing.excluded.map((entry) => entry.sceneId).filter((id) => known.has(id) && !placed.has(id));
  const tray = [...layout.unplaced, ...excludedOff.filter((id) => !layout.unplaced.includes(id))];
  const layers = Math.max(1, layout.layers.length);
  // The bounds hold the curves as well as the cards: a loop back to an earlier layer bows about
  // 150px under its cards and past the rightmost one, and a fit to the cards alone clipped it.
  const cardsBottom = PAD_TOP + Math.max(1, rows) * (NODE_H + ROW_GAP) - ROW_GAP;
  const edgesBottom = Math.max(0, ...edges.map((edge) => edge.ly + 24));
  const edgesRight = Math.max(0, ...edges.map((edge) => Math.max(edge.lx + 64, ...[...edge.d.matchAll(/(-?[\d.]+),/g)].map((m) => Number(m[1]) + PAD_X))));
  const trayY = Math.max(cardsBottom, edgesBottom) + TRAY_GAP;
  const width = Math.max(PAD_X * 2 + layers * NODE_W + (layers - 1) * LAYER_GAP, edgesRight);
  const height = tray.length > 0 ? trayY + NODE_H + 84 : trayY;
  return { nodes, edges, tray, trayY, width: Math.max(width, PAD_X * 2 + 2 * NODE_W + LAYER_GAP), height };
}

/** Choices nobody has walked in preview at their current ends, read off the served findings. */
export function unwalkedChoices(findings: readonly RoutingFinding[]): Set<string> {
  return new Set(findings.filter((finding) => finding.kind === "untraversed-edge").flatMap((finding) => finding.choiceIds));
}

/** The scale that fits the whole map inside the viewport, never above actual size. */
export function fitScale(width: number, height: number, viewW: number, viewH: number, margin = 24): number {
  if (viewW <= 0 || viewH <= 0) return 1;
  return Math.max(0.2, Math.min(1, (viewW - margin * 2) / width, (viewH - margin * 2) / height));
}

/** A choice id from its words, unique by suffix — never by count, which repeats after a removal. */
export function choiceIdFor(label: string, routing: Routing | null): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "choice";
  const taken = new Set((routing?.choices ?? []).map((choice) => choice.id));
  let id = `ch_${slug}`;
  for (let n = 2; taken.has(id); n++) id = `ch_${slug}-${n}`;
  return id;
}

/** One finding as the Inspector lists it: who it is about, what is wrong, and its evidence. */
export interface FindingRow {
  key: string;
  severity: "blocks" | "warns";
  kind: RoutingFinding["kind"];
  title: string;
  note: string;
  evidence: string[];
  sceneIds: string[];
  choiceIds: string[];
}

/**
 * The findings in the map's words, blocks first. Unwalked choices fold into one row — the
 * unvisited-route warning restates them, so it is folded in rather than listed beside them.
 */
export function findingRows(
  findings: readonly RoutingFinding[],
  titleOf: (sceneId: string) => string,
  labelOf: (choiceId: string) => string,
): FindingRow[] {
  const rows: FindingRow[] = [];
  const unwalked = findings.filter((finding) => finding.kind === "untraversed-edge");
  for (const [index, finding] of findings.entries()) {
    const base = { key: `${finding.kind}-${index}`, severity: finding.severity, kind: finding.kind, sceneIds: finding.sceneIds, choiceIds: finding.choiceIds };
    switch (finding.kind) {
      case "unreachable":
        rows.push({ ...base, title: titleOf(finding.sceneIds[0]!), note: "no way in", evidence: [] });
        break;
      case "invalid-destination":
        rows.push({ ...base, title: labelOf(finding.choiceIds[0]!), note: "names a scene that is not here", evidence: finding.sceneIds });
        break;
      case "cannot-reach-ending":
        rows.push({ ...base, title: titleOf(finding.sceneIds[0]!), note: "can't reach an ending", evidence: [] });
        break;
      case "unintended-loop":
        rows.push({ ...base, title: finding.sceneIds.map(titleOf).join(" → "), note: "a loop with no way out", evidence: [] });
        break;
      case "ending-with-choices":
        rows.push({ ...base, title: titleOf(finding.sceneIds[0]!), note: "an ending that still offers choices", evidence: finding.choiceIds.map(labelOf) });
        break;
      case "reconvergence":
        rows.push({ ...base, title: titleOf(finding.sceneIds[0]!), note: `${finding.choiceIds.length} ways in`, evidence: finding.choiceIds.map(labelOf) });
        break;
      case "untraversed-edge":
      case "unvisited-route":
        break;
    }
  }
  if (unwalked.length > 0) {
    const choiceIds = unwalked.flatMap((finding) => finding.choiceIds);
    rows.push({
      key: "untraversed",
      severity: "blocks",
      kind: "untraversed-edge",
      title: `${choiceIds.length} choice${choiceIds.length === 1 ? "" : "s"} not walked`,
      note: "",
      evidence: choiceIds.map(labelOf),
      sceneIds: [...new Set(unwalked.flatMap((finding) => finding.sceneIds))],
      choiceIds,
    });
  }
  return [...rows.filter((row) => row.severity === "blocks"), ...rows.filter((row) => row.severity === "warns")];
}

/**
 * The header's counts: every blocking finding, which is also the export's number (turn 157 draws
 * `4 block` beside `Export blocked · 4`), and the warnings bar the unvisited-route ones, which only
 * restate an unwalked choice already counted.
 */
export function findingCounts(findings: readonly RoutingFinding[]): { blocks: number; warns: number } {
  return {
    blocks: findings.filter((finding) => finding.severity === "blocks").length,
    warns: findings.filter((finding) => finding.severity === "warns" && finding.kind !== "unvisited-route").length,
  };
}

/**
 * What removing a choice breaks, named before anything is written (design turn 157e): the
 * structural findings the routing would have without it that it does not have now. Walk
 * evidence is left out on both sides — removing an edge never un-walks another.
 */
export function removalConsequences(
  routing: Routing,
  scenes: ReadonlyArray<{ id: string }>,
  choiceId: string,
  titleOf: (sceneId: string) => string,
): string[] {
  const structural = (list: RoutingFinding[]) =>
    list.filter((finding) => finding.kind === "unreachable" || finding.kind === "cannot-reach-ending" || finding.kind === "unintended-loop");
  const key = (finding: RoutingFinding) => `${finding.kind}:${finding.sceneIds.join(",")}`;
  const before = new Set(structural(routingFindings(routing, scenes)).map(key));
  const after = structural(
    routingFindings({ ...routing, choices: routing.choices.filter((choice) => choice.id !== choiceId) }, scenes),
  );
  return after
    .filter((finding) => !before.has(key(finding)))
    .map((finding) =>
      finding.kind === "unreachable"
        ? `${titleOf(finding.sceneIds[0]!)} — no way in`
        : finding.kind === "cannot-reach-ending"
          ? `${titleOf(finding.sceneIds[0]!)} — can't reach an ending`
          : `${finding.sceneIds.map(titleOf).join(" → ")} — a loop with no way out`,
    );
}
