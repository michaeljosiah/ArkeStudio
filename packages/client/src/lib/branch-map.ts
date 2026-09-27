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
/** How far each further choice between the same two scenes sits from the one before it. */
const FAN = 34;
/** The highest a skip-layer arc's label may sit: its pill, centred there, stays inside the map. */
const ARC_LABEL_MIN = 32;

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
  /** Where the tray's cards sit, in a row under the map. */
  trayNodes: PlacedNode[];
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
  nth = 0,
): { d: string; lx: number; ly: number } {
  const o = outPort(from);
  const i = inPort(to);
  // The nth of several choices between the same two scenes is drawn apart from the ones before it.
  const fan = nth * FAN;
  const span = (layerOf.get(to.id) ?? 0) - (layerOf.get(from.id) ?? 0);
  // A tray card has no layer: its choice is drawn straight across to where it goes, since no
  // layer order says what it would be arcing over.
  if (span === 1 || !layerOf.has(from.id) || !layerOf.has(to.id)) {
    const bend = Math.max(40, Math.abs(i.x - o.x) / 2);
    return {
      d: `M${o.x},${o.y} C${o.x + bend},${o.y + fan} ${i.x - bend},${i.y + fan} ${i.x - 6},${i.y}`,
      lx: (o.x + i.x) / 2,
      ly: (o.y + i.y) / 2 + fan,
    };
  }
  if (span > 1) {
    // Over the cards between, but never above the map: from the first row the full 150px put
    // the curve's top and its label above y=0, where a fitted view clipped them.
    // Several choices over the same cards stack their arcs upward, where there is only more room;
    // moved down, or along the arc, a third one landed on a card the arc exists to clear. Above
    // the map's top is room too: mapGeometry moves the whole picture down until the highest fits.
    const top = Math.min(o.y, i.y) - 150 - fan;
    return {
      d: `M${o.x},${o.y} C${o.x + 110},${top} ${i.x - 110},${top} ${i.x - 6},${i.y}`,
      lx: (o.x + i.x) / 2,
      ly: 0.125 * (o.y + i.y) + 0.75 * top,
    };
  }
  const bottom = Math.max(o.y, i.y) + 150 + fan;
  return {
    d: `M${o.x},${o.y} C${o.x + 110},${bottom} ${i.x - 110},${bottom} ${i.x - 6},${i.y}`,
    lx: (o.x + i.x) / 2,
    ly: 0.125 * (o.y + i.y) + 0.75 * bottom,
  };
}

/** Cards on the canvas from the layout, the curves between them, and the tray below. */
export function mapGeometry(routing: Routing, scenes: ReadonlyArray<{ id: string }>, layout: RoutingLayout): MapGeometry {
  // The picture starts at y=0 and a fitted view clips above it, so an arc over the first row — the
  // full 150px, or stacked above another — moves everything down until its label is inside.
  const first = mapGeometryAt(routing, scenes, layout, PAD_TOP);
  const highest = Math.min(Infinity, ...first.edges.map((edge) => edge.ly));
  return highest >= ARC_LABEL_MIN ? first : mapGeometryAt(routing, scenes, layout, PAD_TOP + Math.ceil(ARC_LABEL_MIN - highest));
}

function mapGeometryAt(routing: Routing, scenes: ReadonlyArray<{ id: string }>, layout: RoutingLayout, padTop: number): MapGeometry {
  const layerOf = new Map<string, number>();
  const nodes: PlacedNode[] = [];
  let rows = 0;
  layout.layers.forEach((layer, index) => {
    rows = Math.max(rows, layer.length);
    layer.forEach((id, row) => {
      layerOf.set(id, index);
      nodes.push({ id, x: PAD_X + index * (NODE_W + LAYER_GAP), y: padTop + row * (NODE_H + ROW_GAP) });
    });
  });
  const at = new Map(nodes.map((node) => [node.id, node]));
  const placed = new Set(at.keys());
  const known = new Set(scenes.map((scene) => scene.id));
  const excludedOff = routing.excluded.map((entry) => entry.sceneId).filter((id) => known.has(id) && !placed.has(id));
  const tray = [...layout.unplaced, ...excludedOff.filter((id) => !layout.unplaced.includes(id))];
  const onTray = new Set(tray);

  // Two choices between the same two scenes are different choices, walked and counted apart;
  // drawn on one curve, the second label covered the first. Each further one fans out by FAN.
  const seen = new Map<string, number>();
  const draw = (choice: Routing["choices"][number], from: PlacedNode, to: PlacedNode): DrawnEdge => {
    const pair = `${choice.from}\u0000${choice.to}`;
    const nth = seen.get(pair) ?? 0;
    seen.set(pair, nth + 1);
    return { id: choice.id, from: choice.from, to: choice.to, label: choice.label, ...edgePath(from, to, layerOf, nth) };
  };
  const bottomOf = (list: DrawnEdge[]) => Math.max(0, ...list.map((edge) => edge.ly + 24));
  const rightOf = (list: DrawnEdge[]) =>
    Math.max(0, ...list.map((edge) => Math.max(edge.lx + 64, ...[...edge.d.matchAll(/(-?[\d.]+),/g)].map((m) => Number(m[1]) + PAD_X))));

  // Choices between cards on the canvas first: the tray sits under their curves.
  const edges: DrawnEdge[] = [];
  for (const choice of routing.choices) {
    const from = at.get(choice.from);
    const to = at.get(choice.to);
    if (from !== undefined && to !== undefined) edges.push(draw(choice, from, to));
  }
  const layers = Math.max(1, layout.layers.length);
  // The bounds hold the curves as well as the cards: a loop back to an earlier layer bows about
  // 150px under its cards and past the rightmost one, and a fit to the cards alone clipped it.
  const cardsBottom = padTop + Math.max(1, rows) * (NODE_H + ROW_GAP) - ROW_GAP;
  const trayY = Math.max(cardsBottom, bottomOf(edges)) + TRAY_GAP;
  const trayNodes: PlacedNode[] = tray.map((id, index) => ({ id, x: 40 + index * (NODE_W + 20), y: trayY + 56 }));

  // Then a choice from or to a tray card — one the Inspector let the author draw from a scene no
  // route reaches yet. It is persisted, so it is drawn and walkable like any other. A choice to
  // a scene that does not exist has nowhere to go; the findings name it.
  const trayAt = new Map(trayNodes.map((node) => [node.id, node]));
  const trayEdges: DrawnEdge[] = [];
  for (const choice of routing.choices) {
    if (!onTray.has(choice.from) && !onTray.has(choice.to)) continue;
    const from = at.get(choice.from) ?? trayAt.get(choice.from);
    const to = at.get(choice.to) ?? trayAt.get(choice.to);
    if (from !== undefined && to !== undefined) trayEdges.push(draw(choice, from, to));
  }
  edges.push(...trayEdges);

  const trayRight = tray.length > 0 ? 40 + tray.length * (NODE_W + 20) + PAD_X : 0;
  const width = Math.max(PAD_X * 2 + layers * NODE_W + (layers - 1) * LAYER_GAP, rightOf(edges), trayRight);
  const height = tray.length > 0 ? Math.max(trayY + NODE_H + 84, bottomOf(trayEdges)) : trayY;
  return { nodes, edges, tray, trayY, trayNodes, width: Math.max(width, PAD_X * 2 + 2 * NODE_W + LAYER_GAP), height };
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
