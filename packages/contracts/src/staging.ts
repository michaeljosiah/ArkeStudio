import { sampleStageCamera, stageTargetTransform, stageObjectAt, stageLocalPoint } from "./stage-camera.js";
import type { Shot, ShotStaging, StageRig, StagingFigure, StagingKey, StagingSet, StagePerformance, StageObjectMotion } from "./scene.js";
import type { SceneRecord } from "./scene-flow.js";
import { parseAspect } from "./manifest.js";

/**
 * The Stage's pure arithmetic: where a fresh staging puts things, what a key list amounts to in
 * words, and the timed beats a prompt can carry. Shared by the client (the viewport and the
 * panel readouts) and the coordinator (the bench prefill), so the numbers a person reads on
 * the panel are the numbers the generator is told.
 *
 * Camera positions curve through keys; key ease maps time onto distance along each leg.
 */

const SUPER_35_WIDTH_MM = 24.89;
const SUPER_35_HEIGHT_MM = 18.66;
export const STAGE_FRAME_RATE = 30;
export const MAX_STAGE_WALK_SPEED_MPS = 2.2;
export const STAGE_RIGS: readonly StageRig[] = ["sticks", "dolly", "steadicam", "handheld", "crane", "drone", "car-mount"];

const RIG_PROFILE: Record<StageRig, { pos: number; rot: number; frequency: number; octaves: number }> = {
  sticks: { pos: 0, rot: 0, frequency: 0, octaves: 1 },
  dolly: { pos: 0.005, rot: 0.0005, frequency: 0.4, octaves: 1 },
  steadicam: { pos: 0.03, rot: 0.004, frequency: 0.5, octaves: 2 },
  handheld: { pos: 0.045, rot: 0.018, frequency: 1.8, octaves: 3 },
  crane: { pos: 0.01, rot: 0.001, frequency: 0.3, octaves: 1 },
  drone: { pos: 0.05, rot: 0.002, frequency: 0.25, octaves: 2 },
  "car-mount": { pos: 0.02, rot: 0.006, frequency: 2.5, octaves: 3 },
};

/** Stable unsigned seed for a shot id; no wall clock enters a Stage rig. */
export function stageRigSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function random(seed: number, channel: number, cell: number): number {
  let value = seed ^ Math.imul(channel + 1, 0x9e3779b1) ^ Math.imul(cell, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
}

function rigNoise(seed: number, channel: number, at: number, frequency: number, octaves: number): number {
  let total = 0;
  let weight = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const scale = 2 ** octave;
    const phase = at * frequency * scale;
    const cell = Math.floor(phase);
    const f = phase - cell;
    const smooth = f * f * (3 - 2 * f);
    const amplitude = 1 / scale;
    total += (random(seed, channel + octave * 7, cell) * (1 - smooth) + random(seed, channel + octave * 7, cell + 1) * smooth) * amplitude;
    weight += amplitude;
  }
  return weight === 0 ? 0 : total / weight;
}

export function stageRigOffset(
  rig: StageRig | undefined,
  seed: number | undefined,
  intensity: number | undefined,
  at: number,
): { position: [number, number, number]; rotation: [number, number, number] } {
  const profile = RIG_PROFILE[rig ?? "sticks"];
  const amount = intensity ?? 1;
  if (amount === 0 || (profile.pos === 0 && profile.rot === 0)) {
    return { position: [0, 0, 0], rotation: [0, 0, 0] };
  }
  const noise = (channel: number) => rigNoise(seed ?? 0, channel, at, profile.frequency, profile.octaves);
  return {
    position: [noise(0) * profile.pos * amount, noise(1) * profile.pos * 0.7 * amount, noise(2) * profile.pos * amount],
    rotation: [noise(3) * profile.rot * amount, noise(4) * profile.rot * amount, noise(5) * profile.rot * 0.35 * amount],
  };
}

/** Distance fraction along one leg after its two mark-owned ease regions are applied. */
export function stagingEase(from: Pick<StagingKey, "easeOut">, to: Pick<StagingKey, "easeIn">, linear: number): number {
  const k = Math.max(0, Math.min(1, linear));
  let a = from.easeOut ?? 0;
  let b = to.easeIn ?? 0;
  const overlap = a + b;
  if (overlap > 1) {
    a /= overlap;
    b /= overlap;
  }
  const velocity = 1 / (1 - a / 2 - b / 2);
  if (a > 0 && k < a) return velocity * k * k / (2 * a);
  if (b > 0 && k > 1 - b) return 1 - velocity * (1 - k) * (1 - k) / (2 * b);
  return velocity * (k - a / 2);
}

export type EffectiveStageBlocking = {
  cast: StagingFigure[];
  sets: StagingSet[];
  identity: { owner: "scene"; version: number | null } | { owner: "shot" };
};

export type ResolvedShotStaging = Omit<ShotStaging, "cast" | "sets"> & {
  cast: StagingFigure[];
  sets: StagingSet[];
};

/** A legacy inline block is a complete shot override; otherwise the scene owns the action. */
export function effectiveStageBlocking(
  scene: Pick<SceneRecord, "blocking">,
  staging: ShotStaging | undefined,
): EffectiveStageBlocking {
  if (staging?.cast !== undefined && staging.sets !== undefined) {
    return { cast: staging.cast, sets: staging.sets, identity: { owner: "shot" } };
  }
  const blocking = scene.blocking;
  return blocking === undefined
    ? { cast: [], sets: [], identity: { owner: "scene", version: null } }
    : { cast: blocking.cast, sets: blocking.sets, identity: { owner: "scene", version: blocking.version } };
}

export function resolvedShotStaging(scene: Pick<SceneRecord, "blocking">, staging: ShotStaging): ResolvedShotStaging {
  const blocking = effectiveStageBlocking(scene, staging);
  return { ...staging, cast: blocking.cast, sets: blocking.sets };
}

/** Whether a filed Stage image no longer depicts this camera, blocking, lens, or duration. */
export function stagePlayblastIsStale(
  scene: Pick<SceneRecord, "blocking">,
  staging: ShotStaging,
  shown: { durationSec: number; aspect: string; lens: string | undefined },
): boolean {
  const pinned = staging.playblast;
  if (pinned === undefined) return false;
  const current = effectiveStageBlocking(scene, staging).identity;
  const blockingMoved = current.owner === "shot"
    ? pinned.blocking !== undefined && pinned.blocking.owner !== "shot"
    : pinned.blocking === undefined || pinned.blocking.owner !== "scene" || pinned.blocking.version !== current.version;
  return pinned.version !== staging.version || blockingMoved ||
    (pinned.durationSec !== undefined && pinned.durationSec !== shown.durationSec) ||
    (pinned.aspect !== undefined && pinned.aspect !== shown.aspect) ||
    (pinned.lens !== undefined && pinned.lens !== (shown.lens ?? "")) ||
    (pinned.rig !== undefined && pinned.rig !== staging.rig) ||
    (pinned.seed !== undefined && pinned.seed !== staging.seed) ||
    (pinned.rigIntensity !== undefined && pinned.rigIntensity !== staging.rigIntensity);
}

/** Fixed-rate export is half-open: frame i samples i/fps, never an extra frame at the end. */
export function stageFrameCount(durationSec: number): number {
  return Math.max(1, Math.ceil(durationSec * STAGE_FRAME_RATE - 1e-9));
}

/** Vertical field of view on a Super 35 gate cropped to the production aspect. */
export function stagingFov(lens: string | undefined, aspect: string): number {
  const millimetres = Number.parseFloat(/([\d.]+)\s*mm/i.exec(lens ?? "")?.[1] ?? "");
  if (!Number.isFinite(millimetres) || millimetres <= 0) return 34;
  const ratio = parseAspect(aspect) ?? 16 / 9;
  const usedHeight = Math.min(SUPER_35_HEIGHT_MM, SUPER_35_WIDTH_MM / ratio);
  return (2 * Math.atan(usedHeight / (2 * millimetres)) * 180) / Math.PI;
}

/** Inverse of the active Super 35 gate, used when a lens-animation key inherits the shot lens. */
export function stagingFocalForFov(fov: number, aspect: number): number {
  return Math.min(SUPER_35_HEIGHT_MM,SUPER_35_WIDTH_MM/aspect)/(2*Math.tan(fov*Math.PI/360));
}

/** How far back a shot size stands, in metres, measured to the subject. */
function distanceFor(size: string | undefined, camera: string | undefined): number {
  const words = `${size ?? ""} ${camera ?? ""}`.toLowerCase();
  if (/extreme close|ecu/.test(words)) return 1.4;
  if (/close|mcu|\bcu\b/.test(words)) return 2.4;
  if (/extreme wide|ews/.test(words)) return 10;
  if (/wide|\bws\b/.test(words)) return 6.5;
  return 4;
}

function heightFor(angle: string | undefined): number {
  const words = (angle ?? "").toLowerCase();
  if (/overhead|top/.test(words)) return 4.4;
  if (/high/.test(words)) return 2.6;
  if (/low|worm/.test(words)) return 0.7;
  return 1.55;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function key(t: number, p: readonly [number, number, number], l: readonly [number, number, number], subject: string | null): StagingKey {
  return {
    t: round(t),
    p: [round(p[0]), round(p[1]), round(p[2])],
    l: [round(l[0]), round(l[1]), round(l[2])],
    ...(subject === null ? {} : { anchor: subject, track: subject }),
  };
}

function figureAction(description: string, sheetId: string, cast: readonly string[]): string {
  const words = description.toLowerCase();
  const mention = `@${sheetId.toLowerCase()}`;
  const start = words.indexOf(mention);
  if (start < 0) return "";
  const after = words.slice(start + mention.length);
  const sentenceStart = Math.max(words.lastIndexOf(".", start), words.lastIndexOf("!", start), words.lastIndexOf("?", start)) + 1;
  const castMentions = cast.map((id) => `@${id.toLowerCase()}`);
  const hasPreviousCast = castMentions.some((candidate) => words.lastIndexOf(candidate, start - 1) >= sentenceStart);
  const ends = [140];
  for (const candidate of castMentions) {
    const at = after.indexOf(candidate);
    if (at >= 0) ends.push(at);
  }
  const punctuation = after.search(/[.!?]/);
  if (punctuation >= 0) ends.push(punctuation);
  const prefix = hasPreviousCast ? "" : words.slice(sentenceStart, start);
  return `${prefix} ${after.slice(0, Math.min(...ends))}`;
}

const PROP_PROFILES: ReadonlyArray<{
  pattern: RegExp;
  name: string;
  w: number;
  h: number;
  d: number;
  beside: boolean;
}> = [
  { pattern: /\bchairs?\b/, name: "chair", w: 0.5, h: 0.45, d: 0.5, beside: false },
  { pattern: /\btables?\b/, name: "table", w: 1.4, h: 0.75, d: 0.8, beside: true },
  { pattern: /\bdesks?\b/, name: "desk", w: 1.4, h: 0.75, d: 0.7, beside: true },
  { pattern: /\bcounters?\b/, name: "counter", w: 2, h: 0.9, d: 0.7, beside: true },
  { pattern: /\bbeds?\b/, name: "bed", w: 1.5, h: 0.5, d: 2, beside: false },
  { pattern: /\b(?:sofas?|couches?)\b/, name: "sofa", w: 1.8, h: 0.45, d: 0.8, beside: false },
  { pattern: /\bbench(?:es)?\b/, name: "bench", w: 1.4, h: 0.45, d: 0.45, beside: false },
  { pattern: /\bstools?\b/, name: "stool", w: 0.4, h: 0.45, d: 0.4, beside: false },
];

function stagingProp(action: string, x: number, z: number): StagingSet | null {
  const found = PROP_PROFILES
    .map((profile) => ({ profile, at: action.search(profile.pattern) }))
    .filter((candidate) => candidate.at >= 0)
    .sort((left, right) => left.at - right.at)[0]?.profile;
  if (found === undefined) return null;
  return {
    name: found.name,
    x,
    z: round(z + (found.beside ? found.d / 2 + 0.25 : 0)),
    w: found.w,
    h: found.h,
    d: found.d,
  };
}

/**
 * A first staging, from nothing but the shot: cast in a loose line facing the lens, one massing
 * box per named location, and a camera move read off the framing words. Deterministic on
 * purpose — the same shot stages the same way twice, so a re-stage is a reset and not a
 * surprise — and every value here is a starting point for the gizmo, not a verdict.
 */
export function stageShot(
  shot: Shot,
  input: { cast: readonly string[]; sets: readonly string[]; durationSec: number; framing?: Shot["framing"] },
): ResolvedShotStaging {
  const framing = input.framing ?? shot.framing;
  const blocked = input.cast.slice(0, 5).map((sheetId, index) => {
    const x = round(-1.5 + index * 1.5 - (Math.min(input.cast.length, 5) - 1) * 0.75);
    const z = index % 2 === 0 ? 0 : -0.5;
    const action = figureAction(shot.description, sheetId, input.cast);
    const pose = /\b(?:sits?|sitting|seated|takes? (?:a )?seat)\b/.test(action)
      ? "sit" as const
      : /\b(?:lies?|lying|reclines?|reclining|prone|supine)\b/.test(action)
        ? "lie" as const
        : undefined;
    const walking = pose === undefined && /\b(?:walks?|walking|paces?|pacing|crosses?|crossing)\b/.test(action);
    const distance = Math.min(2.4, Math.max(0.7, input.durationSec * 1.2));
    const figure: StagingFigure = {
      sheetId,
      x,
      z,
      ...(pose === undefined ? {} : { pose }),
      ...(walking ? { to: [x, round(z - distance)] as [number, number] } : {}),
    };
    return { figure, prop: stagingProp(action, x, z) };
  });
  const cast = blocked.map(({ figure }) => figure);
  const locations = input.sets.map((name, index) => ({
    name,
    x: index === 0 ? -3.4 : 4.2 + (index - 1) * 3.2,
    z: -3.4,
    w: index === 0 ? 4.4 : 2.6,
    h: index === 0 ? 2.9 : 2.1,
    d: 1.1,
  }));
  const sets = [...locations, ...blocked.flatMap(({ prop }) => prop === null ? [] : [prop])];
  const subject = cast[0]?.sheetId ?? null;
  // Anchored keys are offsets from the subject; an unanchored scene stands where the subject
  // would have been, so a castless shot still has a camera somewhere sensible.
  const distance = distanceFor(framing?.size, shot.camera);
  const height = heightFor(framing?.angle);
  const aim: [number, number, number] = [0, subject === null ? 1.1 : 1.25, 0];
  const dur = Math.max(0.5, input.durationSec);
  const move = `${framing?.movement ?? ""} ${shot.camera ?? ""}`.toLowerCase();
  const keys: StagingKey[] =
    /\bpan\b/.test(move)
      ? [key(0, [0, height, distance], [-1.5, aim[1], 0], null), key(dur, [0, height, distance], [1.5, aim[1], 0], null)]
      : /\btilt\b/.test(move)
        ? [key(0, [0, height, distance], [0, 0.3, 0], null), key(dur, [0, height, distance], [0, 2.5, 0], null)]
        : /push|dolly in|move in|track in/.test(move)
      ? [key(0, [0, height, distance], aim, subject), key(dur, [0, height, Math.max(1, distance * 0.55)], aim, subject)]
      : /pull|dolly out|move out|track out/.test(move)
        ? [key(0, [0, height, distance], aim, subject), key(dur, [0, height, distance * 1.6], aim, subject)]
        : /orbit|arc|circle/.test(move)
          ? [
              key(0, [-distance * 0.7, height, distance * 0.7], aim, subject),
              key(dur / 2, [0, height, distance], aim, subject),
              key(dur, [distance * 0.7, height, distance * 0.7], aim, subject),
            ]
          : /crane|rise|boom/.test(move)
            ? [key(0, [0, Math.max(0.6, height - 0.6), distance], aim, subject), key(dur, [0, height + 1.4, distance * 0.9], aim, subject)]
            : /truck|track|follow|lateral/.test(move)
              ? [key(0, [-distance * 0.35, height, distance], aim, subject), key(dur, [distance * 0.35, height, distance], aim, subject)]
              : [key(0, [0, height, distance], aim, subject), key(dur, [0, height, distance], aim, subject)];
  if (/pan.*left|tilt.*down|truck.*left|crane.*down|boom.*down|lower|descend/.test(move)) {
    const poses = keys.map(({ p, l }) => ({ p, l })).reverse();
    keys.forEach((k, i) => Object.assign(k, poses[i]));
  }
  // Only an explicit follow/tracking instruction rides with a subject. Fixed and rotational
  // moves retain their world position while the performer crosses the frame.
  if (!/track|follow/.test(move)) {
    const figure = cast[0];
    for (const k of keys) {
      if (figure) {
        k.p = [k.p[0] + figure.x, k.p[1], k.p[2] + figure.z];
        k.l = [k.l[0] + figure.x, k.l[1], k.l[2] + figure.z];
      }
      delete k.anchor;
      delete k.track;
    }
  }
  if (/slow|gentle|soft|smooth/.test(move) && keys.length > 1) {
    keys[0] = { ...keys[0]!, easeOut: 0.25 };
    keys[keys.length - 1] = { ...keys[keys.length - 1]!, easeIn: 0.25 };
  }
  const rig: StageRig = /handheld|hand-held|shoulder/.test(move)
    ? "handheld"
    : /steadicam|gimbal/.test(move)
      ? "steadicam"
      : /crane|boom/.test(move)
        ? "crane"
        : /drone|aerial/.test(move)
          ? "drone"
          : /car mount|vehicle mount/.test(move)
            ? "car-mount"
            : /push|pull|dolly|track|truck/.test(move)
              ? "dolly"
              : "sticks";
  return { version: 1, cast, sets, keys, rig, seed: stageRigSeed(shot.id), rigIntensity: 1 };
}

/** The move in one word, read off what the keys actually do. */
export function stagingMoveWord(keys: readonly StagingKey[], cast: readonly StagingFigure[] = [], rig?: StageRig): string {
  const withRig = (move: string) => rig === undefined || rig === "sticks" || rig === move ? move : `${rig.replace("-", " ")} ${move}`;
  if (keys.length < 2) return withRig("static");
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  const dx = Math.abs(last.p[0] - first.p[0]);
  const dy = Math.abs(last.p[1] - first.p[1]);
  const dz = Math.abs(last.p[2] - first.p[2]);
  if (dx < 0.15 && dy < 0.15 && dz < 0.15) {
    const aimX = Math.max(...keys.map(k => k.l[0])) - Math.min(...keys.map(k => k.l[0]));
    const aimY = Math.max(...keys.map(k => k.l[1])) - Math.min(...keys.map(k => k.l[1]));
    const excursion = keys.some(k => Math.hypot(k.p[0] - first.p[0], k.p[1] - first.p[1], k.p[2] - first.p[2]) >= 0.15);
    if (excursion) return withRig(sweep(keys) > 50 ? "orbit" : "out and back");
    if (aimX > 0.05 || aimY > 0.05) return withRig(aimX > 0.05 && aimY > 0.05 ? "pan and tilt" : aimX > aimY ? "pan" : "tilt");
    if (keys.length > 2 && sweep(keys) > 50) return withRig("orbit");
    // The same offset from a figure who walks is a camera that walks with them: it holds its
    // frame and crosses the set, which is a tracking shot and not a static one.
    const rides = keys.every((key) => key.anchor !== undefined && cast.find((figure) => figure.sheetId === key.anchor)?.to !== undefined);
    return withRig(rides ? "tracking" : "static");
  }
  if (sweep(keys) > 50) return withRig("orbit");
  if (dy >= dx && dy >= dz) return withRig("crane");
  if (dx > dz) return withRig("truck");
  return withRig("dolly");
}

/** Total angular travel around the aim, including intermediate keys and full revolutions. */
function sweep(keys: readonly StagingKey[]): number {
  let degrees=0;
  for(let i=1;i<keys.length;i++) {
    const from=keys[i-1]!,to=keys[i]!;
    const a=Math.atan2(from.p[0]-from.l[0],from.p[2]-from.l[2]);
    const b=Math.atan2(to.p[0]-to.l[0],to.p[2]-to.l[2]);
    degrees+=Math.abs(((b-a+3*Math.PI)%(2*Math.PI))-Math.PI)*180/Math.PI;
  }
  return degrees;
}

/** Include moving parents and performers when naming the shot's actual camera movement. */
export function stagingMotionWord(staging: ResolvedShotStaging, durationSec: number): string {
  const world=staging.keys.map(key=>({...key,...sampleStageCamera(staging,key.t,durationSec),anchor:undefined}));
  const first=staging.keys[0];
  const rides=first?.anchor && staging.keys.every(key=>key.anchor===first.anchor&&key.p.every((v,i)=>Math.abs(v-first.p[i]!)<.01));
  if(rides && world.some(key=>Math.hypot(...key.p.map((v,i)=>v-world[0]!.p[i]!))>.15)) {
    const rig=staging.rig && staging.rig!=="sticks"?`${staging.rig.replace("-"," ")} `:"";
    const rotation=stagingMoveWord(staging.keys);
    return `${rig}tracking${rotation.includes("pan")||rotation.includes("tilt")?` with ${rotation}`:""}`;
  }
  return stagingMoveWord(world,staging.cast,staging.rig);
}

/**
 * Where the camera stands relative to what it looks at, in the words a prompt uses. A figure
 * faces +Z until it walks (then it faces its path), and "left" is the subject's left.
 */
function bearing(ox: number, oz: number, rise: number, facing: readonly [number, number]): string {
  const flat = Math.hypot(ox, oz);
  if (rise > 2.4 && flat < 1.6) return "above";
  if (flat < 0.05) return "on top of";
  // Forward along the facing; the subject's left is up × forward.
  const forward = (ox * facing[0] + oz * facing[1]) / flat;
  const left = (ox * facing[1] - oz * facing[0]) / flat;
  if (forward > 0.7) return "in front of";
  if (forward < -0.7) return "behind";
  return left > 0 ? "to the left of" : "to the right of";
}

/**
 * The move as timed beats the generator can read — one line per key, in metres and seconds.
 * These ride in the prompt beside the playblast, and are the whole point of measuring: a
 * playblast the route cannot carry still leaves the numbers behind.
 */
export function stagingBeats(
  staging: ResolvedShotStaging,
  nameOf: (sheetId: string) => string,
  durationSec: number,
): string[] {
  staging = stagingRetimed(staging,durationSec) as ResolvedShotStaging;
  const keys = staging.keys;
  const warnings = durationSec <= 0 ? [] : staging.cast.flatMap((figure) => {
    const speed = stageWalkSpeed(figure, durationSec);
    if (speed === null || speed <= MAX_STAGE_WALK_SPEED_MPS) return [];
    const shownSpeed = Math.ceil(speed * 100) / 100;
    return [`Blocking warning — ${nameOf(figure.sheetId)} · ${(speed * durationSec).toFixed(1)}m in ${durationSec.toFixed(1)}s · ${shownSpeed.toFixed(2)}m/s · too fast for a walk`];
  });
  const camera = keys.map((k) => {
    const subject = k.anchor ?? k.track ?? null;
    const pose = sampleStageCamera({...staging,keys},k.t,durationSec);
    const target = subject ? stageTargetTransform(staging,subject,k.t,durationSec) : null;
    const [tx,,tz] = target?.p ?? pose.l;
    const ox = pose.p[0]-tx, oz=pose.p[2]-tz;
    const flat = Math.hypot(ox,oz).toFixed(1);
    const height = pose.p[1].toFixed(2);
    const angle = (target?.rotation[1]??0)*Math.PI/180;
    const where = bearing(ox,oz,pose.p[1]-pose.l[1],[Math.sin(angle),Math.cos(angle)]);
    const who = subject === null ? "the aim point" : nameOf(subject);
    const aim = k.track === undefined ? `, aim (${pose.l.map(v=>v.toFixed(2)).join(", ")})m in world space` : `, aimed at ${nameOf(k.track)}`;
    const ease = [
      k.easeIn === undefined ? "" : `ease in ${Math.round(k.easeIn * 100)}%`,
      k.easeOut === undefined ? "" : `ease out ${Math.round(k.easeOut * 100)}%`,
    ].filter(Boolean).join(", ");
    return `${k.t.toFixed(1)}s — ${flat}m ${where} ${who}, ${height}m high${aim}${k.roll === undefined ? "" : `, roll ${k.roll}°`}${k.focalMm === undefined ? "" : `, lens ${k.focalMm}mm`}${ease === "" ? "" : `, ${ease}`}`;
  });
  return [...warnings, ...camera];
}

/** Metres per second implied by a figure's blocked path, or null when it holds. */
export function stageWalkSpeed(figure: StagingFigure, durationSec: number): number | null {
  if (figure.to === undefined) return null;
  const distance = Math.hypot(figure.to[0] - figure.x, figure.to[1] - figure.z);
  if (durationSec <= 0) return distance === 0 ? 0 : Number.POSITIVE_INFINITY;
  return distance / durationSec;
}

/** Where a figure stands a fraction `u` of the way through the shot: on its walk, or where it was put. */
function figureAt(figure: StagingFigure, u: number): [number, number] {
  if (figure.to === undefined) return [figure.x, figure.z];
  const along = Math.max(0, Math.min(1, u));
  return [figure.x + (figure.to[0] - figure.x) * along, figure.z + (figure.to[1] - figure.z) * along];
}

/**
 * A staging held to the shot's length. The end key is the end pose, so it always sits at the
 * shot's duration; a shot retimed after it was staged would otherwise play past (or stop short
 * of) its own end pose, and the beats would name seconds the clip does not have. Interior keys
 * that no longer fit are pulled in ahead of the end, in order. Returns the same object when
 * nothing needs to move.
 */
export function stagingRetimed(staging: ShotStaging, durationSec: number): ShotStaging {
  if (staging.keys.length === 0) return staging;
  const last = staging.keys.length - 1;
  const oldDuration = staging.keys[last]!.t;
  if (staging.objectMotions && oldDuration > 0 && oldDuration !== durationSec) staging = { ...staging, objectMotions: staging.objectMotions.map(motion => ({ ...motion, keys: motion.keys.map(key => ({ ...key, t: key.t * durationSec / oldDuration })) })) };
  if (staging.performances && oldDuration > 0 && oldDuration !== durationSec) staging = { ...staging, performances: staging.performances.map(performance => ({ ...performance, keys: performance.keys.map(key => ({ ...key, t: key.t * durationSec / oldDuration })) })) };
  if (staging.keys[last]!.t === durationSec && staging.keys.every((key, index) => index === last || key.t < durationSec)) return staging;
  // Interior keys that still fit stay where they are; if any no longer does, the whole move is
  // scaled to the new length instead of clamped, so no two keys land on one moment.
  const fits = !staging.performances?.length && !staging.objectMotions?.length && staging.keys.every((key, index) => index === last || key.t < durationSec);
  const scale = staging.keys[last]!.t > 0 ? durationSec / staging.keys[last]!.t : 0;
  const scaled = staging.keys.map((key, index) =>
    index === last ? { ...key, t: round(durationSec) } : fits ? key : { ...key, t: round(key.t * scale) },
  );
  if (fits) return { ...staging, keys: scaled };
  // Rounding to hundredths can still land two scaled keys on one moment; each is kept a step
  // after the last, and any pushed onto the end pose is folded into it.
  const end = round(durationSec);
  const interior: StagingKey[] = [];
  for (const key of scaled.slice(0, -1)) {
    const prev = interior.at(-1);
    const t = prev === undefined ? key.t : Math.max(key.t, round(prev.t + 0.01));
    if (t < end) interior.push({ ...key, t });
  }
  return { ...staging, keys: [...interior, { ...scaled[last]!, t: end }] };
}

/** The playblast's own line for a session brief: what it is, and the beats beneath it. */
export function stagingPromptClause(
  staging: ResolvedShotStaging,
  nameOf: (sheetId: string) => string,
  durationSec: number,
): string {
  staging = stagingRetimed(staging,durationSec) as ResolvedShotStaging;
  const keys = staging.keys;
  const walkers = staging.cast
    .filter((figure) => {
      const speed = stageWalkSpeed(figure, durationSec);
      return speed !== null && speed <= MAX_STAGE_WALK_SPEED_MPS;
    })
    .map((figure) => nameOf(figure.sheetId));
  const walk = walkers.length === 0 ? "" : ` ${walkers.join(", ")} ${walkers.length === 1 ? "walks" : "walk"} through the shot.`;
  const poses = staging.cast.flatMap((figure) =>
    figure.pose === "sit"
      ? [`${nameOf(figure.sheetId)} is seated`]
      : figure.pose === "lie"
        ? [`${nameOf(figure.sheetId)} is lying down`]
        : [],
  );
  const posture = poses.length === 0 ? "" : ` ${poses.join("; ")}.`;
  const sets = staging.sets.length === 0
    ? []
    : [`Set massing — ${staging.sets.map((set) => `${set.name}: ${set.w.toFixed(2)}m wide, ${set.h.toFixed(2)}m high, ${set.d.toFixed(2)}m deep at x ${set.x.toFixed(2)}m, z ${set.z.toFixed(2)}m`).join("; ")}.`];
  return [
    "Use the blockout for composition, action and camera motion. Replace greybox geometry with the approved character, location and style references.",
    `Camera move, ${stagingMotionWord(staging,durationSec)}, blocked out on the stage (${keys.length} keys).${walk}${posture}`,
    ...sets,
    ...(staging.performances ?? []).flatMap(performance => performance.keys.map(key => `${key.t.toFixed(2)}s — ${nameOf(performance.sheetId)} at (${key.x.toFixed(2)}, ${(key.y ?? 0).toFixed(2)}, ${key.z.toFixed(2)})m, facing ${key.facing ?? 0}°, ${key.pose ?? "standing"}`)),
    ...(staging.objectMotions ?? []).flatMap(motion=>motion.keys.map(key=>`${key.t.toFixed(2)}s — ${motion.group} at (${key.p.join(", ")})m, rotation (${(key.rotation??[0,0,0]).join(", ")})°.`)),
    ...stagingBeats(staging, nameOf, durationSec),
    ...keys.slice(0,-1).map((key,index) => {
      const at = (key.t + keys[index + 1]!.t) / 2;
      const pose = sampleStageCamera({ ...staging, keys }, at, durationSec);
      return `${at.toFixed(2)}s — camera world position (${pose.p.map(v => v.toFixed(2)).join(", ")})m; aim (${pose.l.map(v => v.toFixed(2)).join(", ")})m.`;
    }),
  ].join("\n");
}

/** Shot-local action overrides a shared figure's legacy full-shot walk. Angles use degrees. */
export function stageFigureAt(figure: StagingFigure, performances: readonly StagePerformance[] | undefined, at: number, durationSec: number, motions?: readonly StageObjectMotion[]) {
  const state = stageFigureLocalAt(figure, performances, at, durationSec);
  if (!figure.parent) return state;
  const transform = stageObjectAt(motions, figure.parent, at);
  const [x,y,z] = stageLocalPoint([state.x,state.y,state.z], transform);
  return { ...state, x,y,z, facing:state.facing+transform.rotation[1] };
}
function stageFigureLocalAt(figure: StagingFigure, performances: readonly StagePerformance[] | undefined, at: number, durationSec: number): {x:number;z:number;y:number;facing:number;pose:"stand"|"sit"|"lie"} {
  const keys = performances?.find(p => p.sheetId === figure.sheetId)?.keys;
  if (!keys?.length) {
    const [x, z] = figureAt(figure, durationSec <= 0 ? 0 : at / durationSec);
    return { x, z, y: figure.y ?? 0, facing: figure.facing ?? (figure.to ? Math.atan2(figure.to[0] - figure.x, figure.to[1] - figure.z) * 180 / Math.PI : 0), pose: figure.pose ?? "stand" };
  }
  let index = 0;
  while (index < keys.length - 1 && keys[index + 1]!.t <= at) index++;
  const a = keys[index]!;
  const b = keys[Math.min(index + 1, keys.length - 1)]!;
  const k = b.t === a.t ? 0 : Math.max(0, Math.min(1, (at - a.t) / (b.t - a.t)));
  const facing = a.facing ?? figure.facing ?? 0;
  const turn = ((b.facing ?? facing) - facing + 540) % 360 - 180;
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k,
    y: (a.y ?? figure.y ?? 0) + ((b.y ?? figure.y ?? 0) - (a.y ?? figure.y ?? 0)) * k,
    facing: facing + turn * k, pose: a.pose ?? figure.pose ?? "stand" };
}

/** Write-boundary checks; permissive legacy reading must not admit new unusable camera data. */
export function stageProblems(staging: ResolvedShotStaging, durationSec: number): string[] {
  const problems: string[] = [];
  const ids = new Set(staging.cast.map(f => f.sheetId));
  const groups = new Set(staging.sets.flatMap(set=>set.group?[set.group]:[]));
  const targets = new Set([...ids,...groups]);
  if ([...groups].some(group=>ids.has(group))) problems.push("Object group names must differ from figure identities.");
  if (ids.size !== staging.cast.length) problems.push("Each figure must have a unique sheet identity.");
  if (staging.keys.length < 1 || staging.keys[0]?.t !== 0 || (staging.keys.length > 1 && staging.keys.at(-1)?.t !== durationSec)) problems.push("Camera keys must cover the shot from 0 to its duration.");
  const ordered = (keys: readonly { t: number }[]) => keys.every((k, i) => Number.isFinite(k.t) && k.t <= durationSec && (i === 0 || k.t > keys[i - 1]!.t));
  if (!ordered(staging.keys)) problems.push("Camera key times must be strictly increasing within the shot.");
  for (const k of staging.keys) {
    if (![...k.p, ...k.l].every(Number.isFinite)) problems.push("Camera coordinates must be finite.");
    if ((k.anchor && !targets.has(k.anchor)) || (k.track && !targets.has(k.track))) problems.push("Camera anchor or track names a missing figure.");
    const sampled = sampleStageCamera(staging, k.t, durationSec);
    if (Math.hypot(...sampled.p.map((v,i)=>v-sampled.l[i]!)) < 0.01) problems.push("Camera aim must be distinct from its position.");
  }
  for (const set of staging.sets) if (![set.w, set.h, set.d].every(v => Number.isFinite(v) && v > 0)) problems.push("Set dimensions must be positive and finite.");
  for (const figure of staging.cast) if (figure.parent && !groups.has(figure.parent)) problems.push("A figure names a missing parent object.");
  for (const set of staging.sets) if (set.shape === "mesh" && (!set.vertices || !set.triangles || set.triangles.length % 3 !== 0 || set.triangles.some(index=>index >= set.vertices!.length))) problems.push("Mesh geometry needs valid vertices and triangle indices.");
  for (const motion of staging.objectMotions ?? []) if (!groups.has(motion.group) || !ordered(motion.keys) || motion.keys[0]?.t !== 0) problems.push("Object motion must name a group and have ordered keys from time 0.");
  if (new Set(staging.objectMotions?.map(m=>m.group)).size !== (staging.objectMotions?.length??0)) problems.push("An object can have only one motion track.");
  if (new Set(staging.performances?.map(p=>p.sheetId)).size !== (staging.performances?.length??0)) problems.push("A figure can have only one performance track.");
  for (const performance of staging.performances ?? []) {
    if (!ids.has(performance.sheetId) || !ordered(performance.keys) || performance.keys[0]?.t !== 0) problems.push("Performance keys must name a figure and increase from time 0 within the shot.");
  }
  return [...new Set(problems)];
}
