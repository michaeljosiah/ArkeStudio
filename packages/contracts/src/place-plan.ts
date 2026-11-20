import { z } from "zod";
import { IsoDateTimeSchema, SceneIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";
import { parseAspect } from "./manifest.js";
import { normalizeViewName } from "./reference.js";
import { STAGE_FRAME_SIZES, StagingSetSchema, type Shot, type ShotStaging, type StagingFigure, type StagingKey, type StagingSet } from "./scene.js";
import { orderedShots, type SceneRecord } from "./scene-flow.js";
import { sampleStageCamera } from "./stage-camera.js";
import { stageFrameKey } from "./stage-framing.js";
import { expandStageSets } from "./stage-kit.js";
import { stageMarkAt } from "./stage-pose.js";
import { resolvedShotStaging, stageKeySamples, stagingFov, type ResolvedShotStaging } from "./staging.js";

/**
 * The Plan (design turn 285, issue 2302): a place owns its set, its numbered camera positions and
 * each position's pictures. A scene set there sees them from straight above with its own cast on
 * their marks, and each pair's cameras held to one side of the line between them.
 *
 * The film's second scene needed a floor plan, ten named camera positions and a rule of sides, and
 * all three were drawn by hand outside the app; its first scene went through seven draft cuts
 * partly for want of them. Until now a set and a camera were a shot's, or the scene's shared
 * blocking, so a second scene in the same room started from nothing.
 *
 * The record is `references/<sheetId>/plan.json`, beside the place's reference kit and written
 * the same way. It is not on the sheet: moving a camera must not move the sheet's version, which
 * every accepted location view is dated against.
 *
 * The set is kept twice on purpose. The plan is its owner, and every staged scene set in the place
 * carries the same pieces as `blocking.sets`, written in the commit that changes them. So the
 * Stage, the playblast's fingerprint, the bench's brief and the line check go on reading the scene
 * they always read, and a scene's own version fences a Keep composed against an older set.
 */

/**
 * World schema 147. A plan file and a shot's `position` are both strict fields a build before the
 * Plan cannot read: it would drop the scene over the one and never look for the other, so the
 * world is raised with the first of either.
 */
export const PLACE_PLAN_SCHEMA_VERSION = 147;

export const MAX_PLACE_POSITIONS = 24;
export const PLACE_POSITION_NAME_MAX = 24;

const Point3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const FocalSchema = z.number().finite().positive().max(1000);
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
/**
 * A name's length as a person reads it. Yoruba writes a letter with a dot below and a tone above
 * it, which is one letter and up to three code points: counted in code units, a name of fifteen
 * letters could be refused as too long.
 */
export const placePositionNameLength = (name: string): number => (graphemes ? [...graphemes.segment(name)].length : [...name].length);
const PositionNameSchema = z.string().trim().min(1).refine((name) => placePositionNameLength(name) <= PLACE_POSITION_NAME_MAX, `a position's name is ${PLACE_POSITION_NAME_MAX} characters at most`);

/**
 * The camera in words, as a position keeps them (turn 229's words; the lens is the position's own).
 * The subject is someone in the scene the words were written in, or a piece of the set by its
 * name: a room's master frames the dance floor, not a person.
 */
export const PlacePositionWordsSchema = z
  .object({
    subject: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("cast"), sheetId: SlugSchema }).strict(),
      z.object({ kind: z.literal("set"), name: z.string().min(1) }).strict(),
    ]),
    size: z.enum(STAGE_FRAME_SIZES),
    angle: z.enum(["eye", "low", "high", "top"]),
    side: z.enum(["front", "behind", "left", "right", "over"]),
    over: SlugSchema.optional(),
  })
  .strict();
export type PlacePositionWords = z.infer<typeof PlacePositionWordsSchema>;

/**
 * The location drawn from a position's grey view: a plate in turn 229's sense, kept once for each
 * aspect. It records the set's version and the camera it was drawn from, so a picture whose
 * position or set has moved since reads as stale without a stored flag that could lie. It is kept
 * either way, never deleted.
 */
export const PlacePositionPictureSchema = z
  .object({
    aspect: z.string().min(1).max(20),
    /** Relative to `references/<sheetId>/`, inside the immutable take that holds it. */
    file: z.string().min(1),
    sourceTakeId: TakeIdSchema,
    acceptedAt: IsoDateTimeSchema,
    setVersion: z.number().int().min(1),
    camera: z.object({ p: Point3Schema, l: Point3Schema, focalMm: FocalSchema }).strict(),
  })
  .strict();
export type PlacePositionPicture = z.infer<typeof PlacePositionPictureSchema>;

/**
 * A position: a number, a name and a camera. What the place keeps is where the camera stands,
 * where it looks and its lens, in the set's metres, so it stands where it stood when another
 * scene seats someone else there. The words ride beside the numbers and are solved again only
 * when they are edited.
 */
export const PlacePositionSchema = z
  .object({
    n: z.number().int().min(1),
    name: PositionNameSchema,
    p: Point3Schema,
    l: Point3Schema,
    focalMm: FocalSchema,
    words: PlacePositionWordsSchema.optional(),
    pictures: z.array(PlacePositionPictureSchema).max(12).optional(),
  })
  .strict();
export type PlacePosition = z.infer<typeof PlacePositionSchema>;

export const PlacePlanSchema = z
  .object({
    sheetId: SlugSchema,
    /** The set's version: every change to the set moves it, and nothing else does. */
    version: z.number().int().min(1),
    sets: z.array(StagingSetSchema).max(120),
    positions: z.array(PlacePositionSchema).max(MAX_PLACE_POSITIONS),
    /** The number the next position takes. A number is never reused, so this only grows. */
    next: z.number().int().min(1),
  })
  .strict()
  .superRefine((plan, context) => {
    const numbers = new Set<number>(), names = new Set<string>();
    for (const position of plan.positions) {
      if (numbers.has(position.n) || position.n >= plan.next) context.addIssue({ code: "custom", message: `position ${position.n} is numbered twice, or past the next number` });
      numbers.add(position.n);
      const key = normalizeViewName(position.name);
      if (names.has(key)) context.addIssue({ code: "custom", message: `two positions are named ${position.name}` });
      names.add(key);
    }
  });
export type PlacePlan = z.infer<typeof PlacePlanSchema>;

/** One change to a place's positions. Each is applied to the plan as it stands, so two people adding positions both keep theirs. */
export const PlacePlanChangeSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add-position"),
    /** Left out, the position is named for its number. */
    name: PositionNameSchema.optional(),
    p: Point3Schema, l: Point3Schema, focalMm: FocalSchema,
    words: PlacePositionWordsSchema.optional(),
  }).strict(),
  z.object({
    op: z.literal("edit-position"),
    n: z.number().int().min(1),
    name: PositionNameSchema.optional(),
    p: Point3Schema.optional(), l: Point3Schema.optional(), focalMm: FocalSchema.optional(),
    /** Null drops the words: the camera was moved by hand, and they no longer say where it is. */
    words: PlacePositionWordsSchema.nullable().optional(),
  }).strict(),
  z.object({ op: z.literal("remove-position"), n: z.number().int().min(1) }).strict(),
]);
export type PlacePlanChange = z.infer<typeof PlacePlanChangeSchema>;

/** The scene a place's first plan takes its set from. */
export const PlacePlanSourceSchema = z
  .object({ productionId: SlugSchema, sceneFile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), sceneId: SceneIdSchema })
  .strict();
export type PlacePlanSource = z.infer<typeof PlacePlanSourceSchema>;

export class PlacePlanRefused extends Error {}

/** The name a position takes when none is given: its number, which no other position has had. */
export const placePositionDefaultName = (n: number): string => `Position ${n}`;

/**
 * A plan after one change, or a refusal by name. Pure, so the screen can say what a change would
 * do before it is sent and the coordinator applies the same rule inside its gate.
 */
export function placePlanAfter(plan: PlacePlan, change: PlacePlanChange): PlacePlan {
  const taken = (name: string, except?: number) => plan.positions.some((position) => position.n !== except && normalizeViewName(position.name) === normalizeViewName(name));
  if (change.op === "add-position") {
    if (plan.positions.length >= MAX_PLACE_POSITIONS) throw new PlacePlanRefused(`A place holds ${MAX_PLACE_POSITIONS} positions at most.`);
    const n = plan.next;
    const name = change.name ?? placePositionDefaultName(n);
    if (taken(name)) throw new PlacePlanRefused(`Another position is named ${name}.`);
    const position: PlacePosition = { n, name, p: change.p, l: change.l, focalMm: change.focalMm, ...(change.words === undefined ? {} : { words: change.words }) };
    return { ...plan, positions: [...plan.positions, position], next: n + 1 };
  }
  const current = plan.positions.find((position) => position.n === change.n);
  if (current === undefined) throw new PlacePlanRefused(`Position ${change.n} is not on this plan.`);
  if (change.op === "remove-position") return { ...plan, positions: plan.positions.filter((position) => position !== current) };
  if (change.name !== undefined && taken(change.name, current.n)) throw new PlacePlanRefused(`Another position is named ${change.name}.`);
  const { words: _words, ...rest } = current;
  const words = change.words === undefined ? current.words : change.words ?? undefined;
  const next: PlacePosition = {
    ...rest,
    ...(change.name === undefined ? {} : { name: change.name }),
    ...(change.p === undefined ? {} : { p: change.p }),
    ...(change.l === undefined ? {} : { l: change.l }),
    ...(change.focalMm === undefined ? {} : { focalMm: change.focalMm }),
    ...(words === undefined ? {} : { words }),
  };
  return { ...plan, positions: plan.positions.map((position) => (position === current ? next : position)) };
}

/** A value's JSON with every object's keys in one order, so two records that say the same thing read the same. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner);
}

/**
 * Whether two sets are the same pieces in the same order: what "the scene carries the place's set"
 * means. Judged on what they say, not on their bytes: a set that has been through the schema comes
 * back with its keys in the schema's order, and read as bytes it would differ from the same set as
 * a command wrote it, so a Keep that changed nothing would move the place's version.
 */
export function sameStageSets(a: readonly StagingSet[] | undefined, b: readonly StagingSet[] | undefined): boolean {
  return canonical(a ?? []) === canonical(b ?? []);
}

/** The plan of the place a scene is set in, when the place has one. */
export function scenePlacePlan(plans: readonly PlacePlan[], scene: Pick<SceneRecord, "inherits">): PlacePlan | undefined {
  const place = scene.inherits?.location;
  return place === undefined ? undefined : plans.find((plan) => plan.sheetId === place);
}

/** The position a shot's camera started from, while the place still holds it. */
export function shotPlacePosition(plan: PlacePlan | undefined, shot: Pick<Shot, "staging">): PlacePosition | undefined {
  const n = shot.staging?.position;
  return n === undefined ? undefined : plan?.positions.find((position) => position.n === n);
}

/** The numbers of the scene's shots that use each position, in scene order. */
export function placePositionShots(plan: PlacePlan, scene: SceneRecord): Map<number, number[]> {
  const shots = new Map<number, number[]>(plan.positions.map((position) => [position.n, []]));
  for (const shot of orderedShots(scene)) {
    const position = shotPlacePosition(plan, shot);
    if (position) shots.get(position.n)!.push(shot.number);
  }
  return shots;
}

const NEAR = 1e-6;
const samePoint = (a: readonly number[], b: readonly number[]) => a.every((value, index) => Math.abs(value - b[index]!) < NEAR);

/** A shot's camera, standing still at a position for the shot's whole length. */
export function placePositionKeys(position: Pick<PlacePosition, "p" | "l" | "focalMm">, durationSec: number): StagingKey[] {
  const key = { p: position.p, l: position.l, focalMm: position.focalMm };
  return [{ t: 0, ...key }, { t: durationSec, ...key }];
}

/** Whether a shot has moved its camera off the position it started from: the nudge is the shot's. */
export function shotNudged(position: Pick<PlacePosition, "p" | "l" | "focalMm">, staging: Pick<ShotStaging, "keys">): boolean {
  return staging.keys.some((key) => key.anchor !== undefined || key.track !== undefined || !samePoint(key.p, position.p) || !samePoint(key.l, position.l) || (key.focalMm !== undefined && Math.abs(key.focalMm - position.focalMm) > NEAR));
}

/** Whether a position's picture still shows it: drawn from this set and from where the camera stands now. */
export function placePictureStale(plan: Pick<PlacePlan, "version">, position: Pick<PlacePosition, "p" | "l" | "focalMm">, picture: PlacePositionPicture): boolean {
  return picture.setVersion !== plan.version || !samePoint(picture.camera.p, position.p) || !samePoint(picture.camera.l, position.l) || Math.abs(picture.camera.focalMm - position.focalMm) > NEAR;
}

/** A position's picture at an aspect, when one has been drawn. */
export function placePositionPicture(position: Pick<PlacePosition, "pictures">, aspect: string): PlacePositionPicture | undefined {
  return position.pictures?.find((picture) => picture.aspect === aspect);
}

const SET_SUBJECT = "plan-subject";

/**
 * Where a position's words put its camera, solved by the Stage's own resolver through the
 * position's lens. A person is framed where they first stand in the scene. A piece of the set is
 * framed as something its own height, or half its width when it is low and wide, so a wide on a
 * dance floor holds the floor and not its three centimetres. Null when the subject is not there.
 */
export function placePositionCamera(words: PlacePositionWords, focalMm: number, stage: { cast: readonly StagingFigure[]; sets: readonly StagingSet[] }, aspect: string): { p: [number, number, number]; l: [number, number, number] } | null {
  let cast = [...stage.cast];
  let subject: string;
  if (words.subject.kind === "cast") subject = words.subject.sheetId;
  else {
    const name = words.subject.name;
    const piece = stage.sets.find((set) => set.name === name);
    if (piece === undefined) return null;
    subject = SET_SUBJECT;
    cast = [...cast.filter((figure) => figure.sheetId !== SET_SUBJECT), {
      sheetId: SET_SUBJECT, x: piece.x, z: piece.z, y: piece.y ?? 0,
      height: Math.min(20, Math.max(piece.h, Math.max(piece.w, piece.d) / 2, .3)),
      facing: piece.rotation?.[1] ?? 0,
    }];
  }
  const staging: ResolvedShotStaging = { version: 1, keys: [], cast, sets: [...stage.sets] };
  const key = stageFrameKey(staging, { subject, size: words.size, angle: words.angle, side: words.side, ...(words.over === undefined ? {} : { over: words.over }), focalMm }, 0, 1, aspect, undefined);
  if (key === null) return null;
  const at = sampleStageCamera({ ...staging, keys: [key] }, 0, 1);
  return { p: at.p, l: at.l };
}

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

export interface PlanSide {
  /** In picture order: who stands on the left of the pair's shots, then who stands on the right. */
  left: string;
  right: string;
  /** The shots that count for the pair, by id, in scene order. */
  shotIds: string[];
  /** Those of them on the other side of the line. Flagged, never refused: a director may cross on purpose. */
  crossings: string[];
  /** The line between the pair's first marks on the floor, as [x, z] twice. */
  line: [[number, number], [number, number]];
  /** A unit vector from the line toward the side the cameras keep. */
  keep: [number, number];
}

/**
 * Sides, judged from where each shot's camera stands (design turn 285, rule 8).
 *
 * A pair is two of the scene's cast for whom two shots or more count. A shot counts when both are
 * in its frame at one of its camera keys, or when its camera's subject is one of them and that
 * person looks at the other or is framed over the other's shoulder. Its side is which side of the
 * line between the two its camera stands on there, measured as the line check measures it, a
 * camera within 0.05 m of the line counting for neither. The pair's side is the one most of its
 * shots keep, the earliest shot's on a tie.
 *
 * A shot with marks of its own is left out: the Plan draws the scene's marks, and a private
 * layout is not on it.
 */
export function planSides(scene: SceneRecord, aspect = "16:9"): PlanSide[] {
  const shared = scene.blocking?.cast ?? [];
  if (shared.length < 2) return [];
  const votes = new Map<string, Array<{ shotId: string; side: number }>>();
  for (const shot of orderedShots(scene)) {
    const own = shot.staging;
    if (own === undefined || own.keys.length === 0 || (own.cast !== undefined && own.sets !== undefined)) continue;
    const staging = resolvedShotStaging(scene, own);
    const samples = stageKeySamples(scene, shot, staging, staging.cast, aspect);
    for (let a = 0; a < staging.cast.length - 1; a++) for (let b = a + 1; b < staging.cast.length; b++) {
      const first = staging.cast[a]!.sheetId, second = staging.cast[b]!.sheetId;
      for (const sample of samples) {
        const one = sample.figures[a]!, other = sample.figures[b]!;
        const subject = sample.key.frame?.subject ?? sample.key.track ?? sample.key.anchor;
        const single = (who: string, whom: string) => subject === who &&
          ((sample.key.frame?.side === "over" && sample.key.frame.over === whom) || stageMarkAt(staging, who, sample.at)?.look === whom);
        if (!(one.visible && other.visible) && !single(first, second) && !single(second, first)) continue;
        const dx = other.x - one.x, dz = other.z - one.z, length = Math.hypot(dx, dz);
        if (length < .05) continue;
        const distance = (dx * (sample.camera[2] - one.z) - dz * (sample.camera[0] - one.x)) / length;
        if (Math.abs(distance) < .05) continue;
        const key = `${first}\n${second}`;
        votes.set(key, [...(votes.get(key) ?? []), { shotId: shot.id, side: Math.sign(distance) }]);
        break;
      }
    }
  }
  const sides: PlanSide[] = [];
  for (let a = 0; a < shared.length - 1; a++) for (let b = a + 1; b < shared.length; b++) {
    const first = shared[a]!, second = shared[b]!;
    const counted = votes.get(`${first.sheetId}\n${second.sheetId}`) ?? votes.get(`${second.sheetId}\n${first.sheetId}`)?.map((vote) => ({ ...vote, side: -vote.side }));
    if (counted === undefined || counted.length < 2) continue;
    const sum = counted.reduce((total, vote) => total + vote.side, 0);
    const side = sum === 0 ? counted[0]!.side : Math.sign(sum);
    const dx = second.x - first.x, dz = second.z - first.z, length = Math.hypot(dx, dz) || 1;
    // A camera on the positive side of first → second looks at the line with first on its left.
    sides.push({
      left: side > 0 ? first.sheetId : second.sheetId,
      right: side > 0 ? second.sheetId : first.sheetId,
      shotIds: counted.map((vote) => vote.shotId),
      crossings: counted.filter((vote) => vote.side !== side).map((vote) => vote.shotId),
      line: [[first.x, first.z], [second.x, second.z]],
      keep: [(-dz / length) * side, (dx / length) * side],
    });
  }
  return sides;
}

// ---------------------------------------------------------------------------
// The cast on the plan
// ---------------------------------------------------------------------------

export interface PlanFigure {
  sheetId: string;
  /** The first mark: where the scene's shared blocking stands them. */
  x: number;
  z: number;
  facing: number;
  seated: boolean;
  /** Every other place a shot's action marks them, each once. */
  later: Array<[number, number]>;
  /** Each walk between marks, as the floor points it passes through, each once. */
  walks: Array<Array<[number, number]>>;
}

/**
 * The scene's cast as the Plan draws them, in the scene's cast order: each on their first mark,
 * with the later marks and the walks the scene's shots give them. A shot with marks of its own is
 * left out, as it is from the sides: its layout is not the scene's.
 */
export function planCast(scene: SceneRecord): PlanFigure[] {
  const near = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < .05;
  return (scene.blocking?.cast ?? []).map((figure) => {
    const first: [number, number] = [figure.x, figure.z];
    const later: Array<[number, number]> = [];
    const walks: Array<Array<[number, number]>> = [];
    const mark = (point: [number, number]) => { if (!near(point, first) && !later.some((other) => near(other, point))) later.push(point); };
    const walk = (points: Array<[number, number]>) => {
      const path = points.filter((point, index) => index === 0 || !near(point, points[index - 1]!));
      if (path.length > 1 && !walks.some((other) => JSON.stringify(other) === JSON.stringify(path))) walks.push(path);
    };
    if (figure.to) { mark(figure.to); walk([first, figure.to]); }
    for (const shot of orderedShots(scene)) {
      const staging = shot.staging;
      if (staging === undefined || (staging.cast !== undefined && staging.sets !== undefined)) continue;
      const keys = staging.performances?.find((track) => track.sheetId === figure.sheetId)?.keys;
      if (!keys?.length) continue;
      const points = keys.map((key): [number, number] => [key.x, key.z]);
      points.forEach(mark);
      walk(points);
    }
    return { sheetId: figure.sheetId, x: figure.x, z: figure.z, facing: figure.facing ?? 0, seated: figure.pose === "sit", later, walks };
  });
}

// ---------------------------------------------------------------------------
// The picture's geometry: what the Plan frames, and what it draws for a position
// ---------------------------------------------------------------------------

export interface PlanBounds { x0: number; z0: number; x1: number; z1: number }

/** The floor a turned box covers, as the corners of its footprint. */
function footprint(part: { x: number; z: number; w: number; d: number; rotation?: readonly number[] | undefined }): Array<[number, number]> {
  const turn = ((part.rotation?.[1] ?? 0) * Math.PI) / 180, cos = Math.cos(turn), sin = Math.sin(turn);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sz]) => {
    const x = (sx * part.w) / 2, z = (sz * part.d) / 2;
    return [part.x + x * cos + z * sin, part.z - x * sin + z * cos];
  });
}

/**
 * What the Plan fits to its view: the set's rooms when it has any, else everything the set covers,
 * widened to hold every mark and every position so nothing drawn falls off the picture. An empty
 * stage is four metres square about its origin.
 */
export function planBounds(sets: readonly StagingSet[], points: ReadonlyArray<readonly [number, number]> = []): PlanBounds {
  const rooms = sets.filter((set) => set.kit?.kind === "room");
  const corners = [...(rooms.length > 0 ? rooms.flatMap(footprint) : expandStageSets(sets).flatMap(footprint)), ...points];
  if (corners.length === 0) return { x0: -2, z0: -2, x1: 2, z1: 2 };
  return {
    x0: Math.min(...corners.map((corner) => corner[0])), z0: Math.min(...corners.map((corner) => corner[1])),
    x1: Math.max(...corners.map((corner) => corner[0])), z1: Math.max(...corners.map((corner) => corner[1])),
  };
}

export interface PlanFrame {
  /** The centre of the view, in the set's metres. */
  cx: number; cz: number;
  /** Half of what the view holds, in metres: the orthographic camera's own numbers. */
  halfW: number; halfH: number;
  /** Pixels to a metre, and the world place of the picture's top-left corner. */
  scale: number; x0: number; z0: number;
}

/** The view that holds `bounds` with `margin` metres round it in a picture of width × height, −z at the top. */
export function planFrame(bounds: PlanBounds, width: number, height: number, margin = .3): PlanFrame {
  const cx = (bounds.x0 + bounds.x1) / 2, cz = (bounds.z0 + bounds.z1) / 2;
  const aspect = width / height;
  const halfW = Math.max((bounds.x1 - bounds.x0) / 2 + margin, ((bounds.z1 - bounds.z0) / 2 + margin) * aspect);
  const halfH = halfW / aspect;
  return { cx, cz, halfW, halfH, scale: width / (2 * halfW), x0: cx - halfW, z0: cz - halfH };
}

/** Where a place on the floor falls in the picture, in pixels from its top-left. */
export const planSpot = (frame: PlanFrame, x: number, z: number): [number, number] => [(x - frame.x0) * frame.scale, (z - frame.z0) * frame.scale];

/** How wide a lens sees, in radians, at an aspect: the Stage's cropped Super 35 gate, across. */
export function planLensSpread(focalMm: number, aspect: string): number {
  const ratio = parseAspect(aspect) ?? 16 / 9;
  return 2 * Math.atan(Math.tan((stagingFov(`${focalMm}mm`, aspect) * Math.PI) / 360) * ratio);
}

export type PlanMark =
  /** A wedge from where the camera stands, `reach` metres long and as wide as its lens sees. */
  | { kind: "wedge"; apex: [number, number]; left: [number, number]; right: [number, number]; tip: [number, number]; aim: [number, number] }
  /** A position that looks straight down has no wedge: the rectangle its lens frames at its aim. */
  | { kind: "frame"; apex: [number, number]; corners: Array<[number, number]> };

/** What the Plan draws for a position, on the floor in the set's metres. */
export function planMark(position: Pick<PlacePosition, "p" | "l" | "focalMm">, aspect: string, reach = 1): PlanMark {
  const [x, y, z] = position.p, [ax, ay, az] = position.l;
  const half = planLensSpread(position.focalMm, aspect) / 2;
  if (Math.hypot(ax - x, az - z) < .05) {
    const ratio = parseAspect(aspect) ?? 16 / 9;
    const halfW = Math.abs(y - ay) * Math.tan(half), halfH = halfW / ratio;
    return { kind: "frame", apex: [x, z], corners: [[x - halfW, z - halfH], [x + halfW, z - halfH], [x + halfW, z + halfH], [x - halfW, z + halfH]] };
  }
  const heading = Math.atan2(az - z, ax - x);
  const at = (angle: number): [number, number] => [x + Math.cos(angle) * reach, z + Math.sin(angle) * reach];
  return { kind: "wedge", apex: [x, z], left: at(heading - half), right: at(heading + half), tip: at(heading), aim: [ax, az] };
}
