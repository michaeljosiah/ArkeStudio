// Turn 285 · the sample every part of the turn draws from: Gold on Gold, scene 2 of Na Love or
// Juju: The Film, as its paper plan lays it out (issue 2302's comment of 20 November 2026). One
// room, three people, ten camera positions, 72 shots. The by-hand drawing put the room in a
// 1480 × 790 px box; this is that box at 100 px to the metre, in the Stage's own axes: x runs east,
// z runs south, y is up, and a figure facing 0° looks south. Nothing here is measured from a place
// that exists. Plain data, no imports: the render page, the frames and the capture all read it.

/** The set, in the Stage's own shape (contracts StagingSet): kit items expand in stage-kit.ts. */
export const SETS = [
  { name: 'club', x: 0, z: 0, w: 14.8, h: 3.2, d: 7.9, kit: { kind: 'room' } },
  { name: 'bar', x: 0, z: -3.5, w: 4, h: 1.05, d: 0.6, kit: { kind: 'counter' } },
  // The booth is three of the kit's Booth: a bench at each end and one on the wall, open to the floor.
  { name: 'booth', x: -5.6, z: -1.22, w: 2.6, h: 1.1, d: 0.8, kit: { kind: 'booth' } },
  { name: 'booth', x: -5.6, z: 1.32, w: 2.6, h: 1.1, d: 0.8, rotation: [0, 180, 0], kit: { kind: 'booth' } },
  { name: 'booth', x: -6.9, z: 0.05, w: 1.7, h: 1.1, d: 0.8, rotation: [0, 90, 0], kit: { kind: 'booth' } },
  { name: 'low table', x: -5.35, z: 0.05, w: 1.2, h: 0.45, d: 1.3 },
  // Turned a quarter so its two chairs face each other east and west, as the two of them sit.
  { name: 'her table', x: 5.2, z: -1.75, w: 1.0, h: 0.75, d: 1.3, rotation: [0, 90, 0], kit: { kind: 'table', seats: 2 } },
  { name: 'DJ', x: 0.2, z: 3.5, w: 1.8, h: 1.1, d: 0.6 },
  { name: 'dance floor', x: 0.2, z: 0.3, w: 5.2, h: 0.03, d: 4.7 },
];

/** Where each set's name sits on the plan, clear of the wedges: [name, x, z]. */
export const SET_LABELS = [['bar', 0, -3.5], ['booth', -6.6, -2.2], ['her table', 6.72, -1.2], ['DJ', 1.05, 3.55], ['dance floor', 0.2, 0.9]];
/** Where each person's name sits beside their first mark. */
export const NAME_AT = { ade: [-5.35, -1.8], tunde: [-5.35, 1.9], ife: [6.86, -2.0] };

/**
 * The cast in the scene's order, which is the order the Stage hands out its colours in (contracts
 * STAGE_CAST_COLOURS). A mark is where someone sits; a path is a walk between marks.
 */
export const CAST = [
  { id: 'ade', name: 'Ade', colour: '#2f7fd8', marks: [{ x: -5.35, z: -1.1, facing: 0, pose: 'sit' }, { x: 4.25, z: -1.75, facing: 90, pose: 'sit' }],
    path: [[-5.35, -1.1], [-4.2, -0.72], [-1.0, -1.05], [3.5, -1.4], [4.25, -1.75]] },
  { id: 'ife', name: 'Ife', colour: '#d6336c', marks: [{ x: 6.15, z: -1.75, facing: -90, pose: 'sit' }],
    path: [[-3.4, 3.55], [-3.4, -2.55], [5.75, -2.85], [6.15, -1.75]] },
  { id: 'tunde', name: 'Tunde', colour: '#f59f00', marks: [{ x: -5.35, z: 1.2, facing: 180, pose: 'sit' }], path: null },
];

/**
 * The place's positions. `at` is where the camera stands (x, height, z) and `aim` what it looks at;
 * `mm` is the lens. `words` is the camera as turn 229 writes it. Names are the paper plan's, cut to
 * the turn's 24 characters. Position 10 stands just south of Ade's chair: the paper drawing put it
 * north of her table, where it would cross Tunde · Ade (see the notes).
 */
export const POSITIONS = [
  { n: 1, name: 'Both men', at: [-3.8, 1.0, 0.05], aim: [-5.6, 0.85, 0.05], mm: 28, words: { subject: 'Tunde', size: 'Med', angle: 'Eye', side: 'Left', lens: 28 } },
  { n: 2, name: 'On Tunde', at: [-3.9, 1.25, -1.75], aim: [-5.35, 0.95, 1.2], mm: 65, words: { subject: 'Tunde', size: 'MCU', angle: 'Eye', side: 'Over the shoulder', over: 'Ade', lens: 65 } },
  { n: 3, name: 'On Ade', at: [-3.9, 1.25, 1.85], aim: [-5.35, 0.95, -1.1], mm: 75, words: { subject: 'Ade', size: 'CU', angle: 'Eye', side: 'Over the shoulder', over: 'Tunde', lens: 75 } },
  { n: 4, name: 'Ade’s view', at: [-4.65, 1.05, -0.8], aim: [5.6, 0.9, -1.75], mm: 135, words: { subject: 'Ife', size: 'Med', angle: 'Eye', side: 'Front', lens: 135 } },
  // The room's master. Its subject is a piece of the set, which a position's may be (rule 4).
  { n: 5, name: 'The wide', at: [0.2, 1.5, 3.07], aim: [0.2, 1.0, -1.0], mm: 10, words: { subject: 'dance floor', size: 'Wide', angle: 'Eye', side: 'Front', lens: 10 } },
  { n: 6, name: 'Both at her table', at: [5.2, 1.1, 0.35], aim: [5.2, 0.85, -1.75], mm: 35, words: { subject: 'Ife', size: 'Med', angle: 'Eye', side: 'Left', lens: 35 } },
  { n: 7, name: 'On Ife', at: [3.3, 1.2, -0.35], aim: [6.15, 0.95, -1.75], mm: 65, words: { subject: 'Ife', size: 'MCU', angle: 'Eye', side: 'Over the shoulder', over: 'Ade', lens: 65 } },
  { n: 8, name: 'On Ade, her table', at: [6.9, 1.2, -0.35], aim: [4.25, 0.95, -1.75], mm: 65, words: { subject: 'Ade', size: 'MCU', angle: 'Eye', side: 'Over the shoulder', over: 'Ife', lens: 65 } },
  // Straight down on her table: a position that looks down has no wedge, so the plan draws its frame.
  { n: 9, name: 'Table-top', at: [5.2, 2.3, -1.75], aim: [5.2, 0.75, -1.75], mm: 24, words: { subject: 'her table', size: 'CU', angle: 'Top', side: 'Front', lens: 24 } },
  { n: 10, name: 'On Tunde, long', at: [4.3, 1.1, -1.1], aim: [-4.9, 0.95, 0.9], mm: 135, words: { subject: 'Tunde', size: 'Med', angle: 'Eye', side: 'Front', lens: 135 } },
];
/** The positions whose picture has been drawn; the rest show their grey view alone. */
export const DRAWN = [1, 4, 5, 6, 7, 8];
/** The position turn 285c adds: on Ife from the bar's side of her table, across the pair's line. */
export const CROSSING = { n: 11, name: 'On Ife, bar side', at: [3.9, 1.2, -3.05], aim: [6.15, 0.95, -1.75], mm: 65, words: { subject: 'Ife', size: 'MCU', angle: 'Eye', side: 'Over the shoulder', over: 'Ade', lens: 65 } };

/**
 * The 72 shots in the paper plan's order, as [position, seconds]: all the turn draws of a shot is
 * where it stands and how long it runs. The plan's 36a, 36b and 36c are Arke's 36, 37 and 38, so
 * its 37 to 70 are Arke's 39 to 72. Position 0 is a shot set somewhere else, which has no position
 * in this room. A shot is named here for its position; its words are the film's and are not kept.
 */
const BOOTH = [[1, 3], [2, 7], [3, 3], [2, 5], [3, 5], [1, 8], [3, 3], [2, 6], [3, 8], [4, 7], [3, 3], [2, 2], [3, 3], [2, 6], [4, 6], [3, 3], [2, 9], [4, 6], [1, 4], [5, 8], [6, 4]];
const TABLE = [[8, 2], [7, 5], [10, 3], [8, 4], [7, 5], [6, 4], [7, 11], [6, 4], [8, 2], [7, 2], [8, 2], [7, 4], [8, 3], [7, 5], [8, 4], [7, 2], [6, 5], [6, 6], [6, 4], [8, 5], [9, 3], [8, 5], [7, 2], [8, 2], [9, 2], [7, 2], [8, 4], [7, 3], [8, 4], [7, 4], [6, 4], [9, 4], [8, 3], [7, 3], [9, 5], [7, 4]];
const AWAY = [[0, 8], [0, 6], [0, 2], [0, 6], [0, 2], [0, 2], [0, 5], [0, 5], [0, 10], [0, 5], [0, 7], [0, 9], [0, 4], [0, 4], [0, 7]];
export const SHOTS = [...BOOTH, ...TABLE, ...AWAY].map(([position, sec], i) => ({ n: i + 1, position, sec, title: POSITIONS.find(p => p.n === position)?.name ?? 'Elsewhere' }));

/** The numbers of the shots that use a position, in scene order. */
export const shotsAt = n => SHOTS.filter(shot => shot.position === n).map(shot => shot.n);

/**
 * Sides. A pair is written in picture order, left then right; `shots` is how many of the scene's
 * shots count for it under the turn's rule (both in frame, or one of them framed looking at or over
 * the other). `line` is the two marks the pair's line runs between on the plan, and `keep` the side
 * of it the cameras stand on, as a unit vector.
 */
export const SIDES = [
  { left: 'Tunde', right: 'Ade', shots: 18, line: [[-5.35, 1.2], [-5.35, -1.1]], keep: [1, 0] },
  { left: 'Ade', right: 'Ife', shots: 34, line: [[4.25, -1.75], [6.15, -1.75]], keep: [0, 1] },
];

export const PLACE = { name: 'The Club', version: 3 };
export const SCENE = { number: 2, title: 'Gold on Gold', production: 'Na Love or Juju: The Film', world: 'Na Love or Juju', aspect: '16:9' };
