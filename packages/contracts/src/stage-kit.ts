import type { StageKit, StagingSet } from "./scene.js";

/**
 * The set kit (issue 1819, design turn 228e). A kit item is one set entry — a name, a place, an
 * overall size, a turn — that expands here into the primitives the viewport, occlusion and the
 * inspection renderer draw. The model writes "a room 8 × 12 × 5, open at the front, two doors on
 * the right wall" instead of a dozen boxes it has to line up by hand: fewer tokens, and walls
 * that always meet. The expansion is pure and deterministic, so every renderer and every check
 * sees the same geometry, and it stays inside the per-object budgets because it emits only boxes,
 * cylinders and spheres.
 */

/** What a part is made of, for the Lit look (issue 1825); the expansion names it, the look colours it. */
export type StageKitSurface = "floor" | "wall" | "glass" | "wood" | "metal" | "fabric" | "leather" | "stone" | "foliage" | "pot" | "lamp" | "road" | "paint";

export type StageKitPart = StagingSet & { surface: StageKitSurface };

export const STAGE_KIT_LABELS: Record<StageKit["kind"], string> = {
  room: "Room", doorway: "Doorway", window: "Window", stairs: "Stairs", counter: "Counter", booth: "Booth",
  table: "Table and chairs", armchair: "Armchair", sofa: "Sofa", bed: "Bed", planter: "Planter", tree: "Tree",
  lamp: "Lamp", car: "Car", street: "Street", facade: "Facade",
};

/** The overall size a kit item starts at when it is added, in metres (w, h, d). */
export const STAGE_KIT_SIZES: Record<StageKit["kind"], [number, number, number]> = {
  room: [6, 3, 8], doorway: [1, 2.2, 0.2], window: [1.4, 1.4, 0.2], stairs: [1.2, 1.8, 3], counter: [3, 1.05, 0.7],
  booth: [1.8, 1.1, 0.8], table: [1.2, 0.75, 0.8], armchair: [0.86, 0.9, 0.8], sofa: [2, 0.85, 0.9], bed: [1.6, 0.6, 2.1],
  planter: [0.6, 1.4, 0.6], tree: [2.5, 5, 2.5], lamp: [0.4, 1.6, 0.4], car: [1.8, 1.45, 4.4], street: [10, 0.15, 20], facade: [10, 9, 0.4],
};

const WALL = 0.15;
type Box = { name: string; surface: StageKitSurface; x: number; y: number; z: number; w: number; h: number; d: number; shape?: StagingSet["shape"]; solid?: boolean; ry?: number };

/** A wall along its own length, cut by openings: full-height pieces between them, a header above each, a sill below a window. */
function wall(name: string, length: number, height: number, openings: NonNullable<StageKit["openings"]>, place: (along: number, piece: { w: number; h: number; y: number }) => Box, glassAt: (along: number, w: number, h: number, y: number) => Box): Box[] {
  const pieces: Box[] = [];
  const cuts = openings.map(o => ({ ...o, from: o.at - o.w / 2, to: o.at + o.w / 2, sill: o.kind === "door" ? 0 : (o.sill ?? 0.9) }))
    .filter(o => o.from > -length / 2 && o.to < length / 2)
    .sort((a, b) => a.from - b.from);
  let cursor = -length / 2;
  for (const cut of cuts) {
    if (cut.from > cursor + .01) pieces.push(place((cursor + cut.from) / 2, { w: cut.from - cursor, h: height, y: 0 }));
    const top = Math.min(height, cut.sill + cut.h);
    if (height - top > .01) pieces.push(place(cut.at, { w: cut.w, h: height - top, y: top }));
    if (cut.sill > .01) pieces.push(place(cut.at, { w: cut.w, h: cut.sill, y: 0 }));
    if (cut.kind !== "door") pieces.push(glassAt(cut.at, cut.w, top - cut.sill, cut.sill));
    cursor = Math.max(cursor, cut.to);
  }
  if (length / 2 > cursor + .01) pieces.push(place((cursor + length / 2) / 2, { w: length / 2 - cursor, h: height, y: 0 }));
  return pieces.map((piece, index) => ({ ...piece, name: piece.surface === "glass" ? `${name} glass` : index === 0 ? name : `${name} ${index + 1}` }));
}

function room(kit: StageKit, w: number, h: number, d: number): Box[] {
  const open = new Set(kit.open ?? []);
  const openings = kit.openings ?? [];
  const on = (side: string) => openings.filter(o => o.wall === side);
  const parts: Box[] = [];
  const sides = [
    { side: "back", length: w, place: (a: number, p: { w: number; h: number; y: number }): Box => ({ name: "", surface: "wall", x: a, y: p.y, z: -d / 2, w: p.w, h: p.h, d: WALL }), glass: (a: number, gw: number, gh: number, gy: number): Box => ({ name: "", surface: "glass", x: a, y: gy, z: -d / 2, w: gw, h: gh, d: .03, solid: false }) },
    { side: "front", length: w, place: (a: number, p: { w: number; h: number; y: number }): Box => ({ name: "", surface: "wall", x: a, y: p.y, z: d / 2, w: p.w, h: p.h, d: WALL }), glass: (a: number, gw: number, gh: number, gy: number): Box => ({ name: "", surface: "glass", x: a, y: gy, z: d / 2, w: gw, h: gh, d: .03, solid: false }) },
    { side: "left", length: d, place: (a: number, p: { w: number; h: number; y: number }): Box => ({ name: "", surface: "wall", x: -w / 2, y: p.y, z: a, w: WALL, h: p.h, d: p.w }), glass: (a: number, gw: number, gh: number, gy: number): Box => ({ name: "", surface: "glass", x: -w / 2, y: gy, z: a, w: .03, h: gh, d: gw, solid: false }) },
    { side: "right", length: d, place: (a: number, p: { w: number; h: number; y: number }): Box => ({ name: "", surface: "wall", x: w / 2, y: p.y, z: a, w: WALL, h: p.h, d: p.w }), glass: (a: number, gw: number, gh: number, gy: number): Box => ({ name: "", surface: "glass", x: w / 2, y: gy, z: a, w: .03, h: gh, d: gw, solid: false }) },
  ] as const;
  parts.push({ name: "floor", surface: "floor", x: 0, y: -.02, z: 0, w, h: .02, d });
  for (const { side, length, place, glass } of sides) {
    if (open.has(side)) continue;
    parts.push(...wall(`${side} wall`, length, h, on(side), place, glass));
  }
  if (kit.ceiling) parts.push({ name: "ceiling", surface: "wall", x: 0, y: h, z: 0, w, h: .1, d });
  return parts;
}

function chairsAround(w: number, d: number, seats: number): Box[] {
  const parts: Box[] = [];
  const perSide = Math.ceil(seats / 2);
  for (let i = 0; i < seats; i++) {
    const front = i % 2 === 0, slot = Math.floor(i / 2);
    const x = -w / 2 + (w / perSide) * (slot + .5);
    const z = (front ? 1 : -1) * (d / 2 + .3);
    parts.push({ name: `chair ${i + 1}`, surface: "wood", x, y: 0, z, w: .45, h: .45, d: .45 });
    parts.push({ name: `chair ${i + 1} back`, surface: "wood", x, y: .45, z: z + (front ? .2 : -.2), w: .45, h: .45, d: .05 });
  }
  return parts;
}

function local(kit: StageKit, w: number, h: number, d: number): Box[] {
  switch (kit.kind) {
    case "room": return room(kit, w, h, d);
    case "doorway": return [
      { name: "jamb left", surface: "wood", x: -w / 2 - .05, y: 0, z: 0, w: .1, h, d },
      { name: "jamb right", surface: "wood", x: w / 2 + .05, y: 0, z: 0, w: .1, h, d },
      { name: "header", surface: "wood", x: 0, y: h, z: 0, w: w + .2, h: .12, d },
    ];
    case "window": return [
      { name: "frame", surface: "wood", x: 0, y: 0, z: 0, w: w + .1, h: .08, d },
      { name: "frame top", surface: "wood", x: 0, y: h - .08, z: 0, w: w + .1, h: .08, d },
      { name: "frame left", surface: "wood", x: -w / 2, y: 0, z: 0, w: .08, h, d },
      { name: "frame right", surface: "wood", x: w / 2, y: 0, z: 0, w: .08, h, d },
      { name: "glass", surface: "glass", x: 0, y: .08, z: 0, w, h: h - .16, d: .03, solid: false },
    ];
    case "stairs": {
      const steps = kit.steps ?? Math.max(2, Math.round(h / .18));
      return Array.from({ length: steps }, (_, i) => ({ name: i === 0 ? "step" : `step ${i + 1}`, surface: "stone" as const, x: 0, y: 0, z: d / 2 - (d / steps) * (i + .5), w, h: (h / steps) * (i + 1), d: d / steps }));
    }
    case "counter": return [
      { name: "body", surface: "wood", x: 0, y: 0, z: 0, w, h: h - .05, d },
      { name: "top", surface: "stone", x: 0, y: h - .05, z: 0, w: w + .06, h: .05, d: d + .06 },
    ];
    case "booth": return [
      { name: "seat", surface: "leather", x: 0, y: 0, z: d * .15, w, h: .45, d: d * .7 },
      { name: "back", surface: "leather", x: 0, y: 0, z: -d / 2 + .08, w, h, d: .16 },
    ];
    case "table": return [
      { name: "top", surface: "wood", x: 0, y: h - .05, z: 0, w, h: .05, d },
      { name: "pedestal", surface: "metal", x: 0, y: 0, z: 0, w: .12, h: h - .05, d: .12, shape: "cylinder" },
      ...chairsAround(w, d, kit.seats ?? 0),
    ];
    case "armchair": case "sofa": return [
      { name: "seat", surface: "leather", x: 0, y: 0, z: .05, w, h: .42, d: d - .1 },
      { name: "back", surface: "leather", x: 0, y: .42, z: -d / 2 + .08, w, h: h - .42, d: .16 },
      { name: "arm left", surface: "leather", x: -w / 2 + .07, y: .42, z: 0, w: .14, h: .24, d },
      { name: "arm right", surface: "leather", x: w / 2 - .07, y: .42, z: 0, w: .14, h: .24, d },
    ];
    case "bed": return [
      { name: "base", surface: "fabric", x: 0, y: 0, z: 0, w, h, d },
      { name: "headboard", surface: "wood", x: 0, y: 0, z: -d / 2 + .04, w, h: h + .6, d: .08 },
      { name: "pillow", surface: "fabric", x: 0, y: h, z: -d / 2 + .3, w: w * .8, h: .12, d: .35 },
    ];
    case "planter": return [
      { name: "pot", surface: "pot", x: 0, y: 0, z: 0, w: w * .8, h: h * .35, d: d * .8, shape: "cylinder" },
      { name: "leaves", surface: "foliage", x: 0, y: h * .35, z: 0, w, h: h * .65, d, shape: "sphere", solid: false },
    ];
    case "tree": return [
      { name: "trunk", surface: "wood", x: 0, y: 0, z: 0, w: w * .12, h: h * .55, d: d * .12, shape: "cylinder" },
      { name: "canopy", surface: "foliage", x: 0, y: h * .4, z: 0, w, h: h * .6, d, shape: "sphere" },
    ];
    case "lamp": return [
      { name: "base", surface: "metal", x: 0, y: 0, z: 0, w, h: .03, d, shape: "cylinder" },
      { name: "pole", surface: "metal", x: 0, y: 0, z: 0, w: .03, h: h - .3, d: .03, shape: "cylinder" },
      { name: "shade", surface: "lamp", x: 0, y: h - .3, z: 0, w, h: .3, d, shape: "cylinder", solid: false },
    ];
    case "car": return [
      { name: "body", surface: "paint", x: 0, y: .3, z: 0, w, h: h * .4, d },
      { name: "cabin", surface: "glass", x: 0, y: .3 + h * .4, z: -d * .05, w: w * .9, h: h * .6 - .3, d: d * .5 },
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => ({ name: `wheel ${i + 1}`, surface: "stone" as const, x: sx! * (w / 2 - .1), y: 0, z: sz! * (d / 2 - .7), w: .25, h: .64, d: .64, shape: "cylinder" as const })),
    ];
    case "street": return [
      { name: "road", surface: "road", x: 0, y: 0, z: 0, w: w * .7, h: .02, d },
      { name: "pavement left", surface: "stone", x: -w * .425, y: 0, z: 0, w: w * .15, h, d },
      { name: "pavement right", surface: "stone", x: w * .425, y: 0, z: 0, w: w * .15, h, d },
    ];
    case "facade": {
      const parts: Box[] = [{ name: "wall", surface: "wall", x: 0, y: 0, z: 0, w, h, d }];
      const floors = Math.max(1, Math.floor(h / 3)), across = Math.max(1, Math.floor(w / 2.5));
      for (let f = 0; f < floors; f++) for (let c = 0; c < across; c++) {
        parts.push({ name: `window ${f * across + c + 1}`, surface: "glass", x: -w / 2 + (w / across) * (c + .5), y: f * 3 + 1, z: d / 2 + .01, w: 1.1, h: 1.4, d: .02, solid: false });
      }
      return parts;
    }
  }
}

/**
 * A set entry as the primitives it stands for. A plain set is itself; a kit item is its parts,
 * each turned with the item and placed about its centre, named "<item> · <part>", solid unless
 * the part is glass, leaves or a lampshade, and tagged with what it is made of.
 */
export function expandStageSet(set: StagingSet): StageKitPart[] {
  if (!set.kit) return [{ ...set, surface: "wall" }];
  const turn = ((set.rotation?.[1] ?? 0) * Math.PI) / 180;
  const cos = Math.cos(turn), sin = Math.sin(turn);
  const base = set.y ?? 0;
  return local(set.kit, set.w, set.h, set.d).map((part): StageKitPart => {
    // three's Y rotation: x' = x cos + z sin, z' = −x sin + z cos.
    const x = set.x + part.x * cos + part.z * sin;
    const z = set.z - part.x * sin + part.z * cos;
    const rotation: [number, number, number] = [set.rotation?.[0] ?? 0, set.rotation?.[1] ?? 0, set.rotation?.[2] ?? 0];
    return {
      name: `${set.name} · ${part.name}`,
      x, z, y: base + part.y, w: Math.max(.01, part.w), h: Math.max(.01, part.h), d: Math.max(.01, part.d),
      ...(part.shape === undefined ? {} : { shape: part.shape }),
      ...(rotation.some(v => v !== 0) ? { rotation } : {}),
      ...(set.group === undefined ? {} : { group: set.group }),
      solid: part.solid ?? set.solid ?? true,
      surface: part.surface,
    };
  });
}

/** Every set as primitives, in order; what the renderers, occlusion and the inspection draw. */
export function expandStageSets(sets: readonly StagingSet[]): Array<StageKitPart & { index: number }> {
  return sets.flatMap((set, index) => expandStageSet(set).map(part => ({ ...part, index })));
}
