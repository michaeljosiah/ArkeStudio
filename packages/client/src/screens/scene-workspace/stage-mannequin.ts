import { BoxGeometry, CapsuleGeometry, Color, ConeGeometry, Group, MathUtils, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3 } from "three";
import type { StagePose } from "@arke-studio/contracts";

/**
 * The jointed figure (issue 1821, design turn 228 rule 3): about fifteen joints, a nose so its
 * facing reads, posed by name and with two-bone IK for a hand put on someone or something. It is
 * the figure the Lit and Plate looks draw; Greybox keeps its capsules. Built for 1.8 m and scaled
 * by the walker like the capsules were. Deterministic: a pose is a table, a stride is a sine of the
 * shot clock, nothing is random.
 */

type Joint = "hips" | "spine" | "chest" | "neck" | "head" | "lShoulder" | "lElbow" | "rShoulder" | "rElbow" | "lHip" | "lKnee" | "rHip" | "rKnee";
export interface Mannequin { root: Group; joints: Record<Joint, Group> }

const UPPER_ARM = 0.29, FOREARM = 0.33;

export function mannequin(colour: number, ghost: boolean): Mannequin {
  const fade = ghost ? { transparent: true, opacity: 0.18 } : {};
  const cloth = new MeshStandardMaterial({ color: colour, roughness: 0.42, metalness: 0.05, ...fade });
  const joint = new MeshStandardMaterial({ color: new Color(colour).multiplyScalar(0.55), roughness: 0.5, ...fade });
  const dark = new MeshStandardMaterial({ color: 0x15171c, roughness: 0.25, metalness: 0.4, ...fade });
  const root = new Group();
  const joints = {} as Record<Joint, Group>;
  const bone = (name: Joint, parent: Group, at: [number, number, number]) => {
    const group = new Group();
    group.position.set(...at);
    parent.add(group);
    joints[name] = group;
    return group;
  };
  const limb = (group: Group, length: number, radius: number, down = true) => {
    const piece = new Mesh(new CapsuleGeometry(radius, Math.max(0.01, length - 2 * radius), 6, 14), cloth);
    piece.position.y = down ? -length / 2 : length / 2;
    group.add(piece);
    group.add(new Mesh(new SphereGeometry(radius * 1.05, 14, 10), joint));
  };
  const hips = bone("hips", root, [0, 0.95, 0]);
  const pelvis = new Mesh(new CapsuleGeometry(0.13, 0.12, 6, 16), cloth);
  pelvis.rotation.z = Math.PI / 2;
  hips.add(pelvis);
  const spine = bone("spine", hips, [0, 0.06, 0]);
  limb(spine, 0.26, 0.12, false);
  const chest = bone("chest", spine, [0, 0.24, 0]);
  const torso = new Mesh(new CapsuleGeometry(0.14, 0.16, 8, 18), cloth);
  torso.scale.set(1.12, 1, 0.7);
  torso.position.y = 0.13;
  chest.add(torso);
  const neck = bone("neck", chest, [0, 0.3, 0]);
  limb(neck, 0.08, 0.045, false);
  const head = bone("head", neck, [0, 0.09, 0]);
  const skull = new Mesh(new SphereGeometry(0.105, 24, 18), cloth);
  skull.scale.set(0.92, 1.12, 1);
  skull.position.y = 0.1;
  head.add(skull);
  const nose = new Mesh(new ConeGeometry(0.022, 0.06, 10), dark);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.1, 0.115);
  head.add(nose);
  for (const [side, x] of [["l", 1], ["r", -1]] as const) {
    const shoulder = bone(`${side}Shoulder`, chest, [x * 0.21, 0.24, 0]);
    limb(shoulder, UPPER_ARM, 0.05);
    const elbow = bone(`${side}Elbow`, shoulder, [0, -UPPER_ARM, 0]);
    limb(elbow, 0.27, 0.042);
    const hand = new Mesh(new SphereGeometry(0.05, 12, 10), cloth);
    hand.scale.set(0.8, 1.3, 0.55);
    hand.position.y = -0.31;
    elbow.add(hand);
    const hip = bone(`${side}Hip`, hips, [x * 0.1, -0.04, 0]);
    limb(hip, 0.44, 0.07);
    const knee = bone(`${side}Knee`, hip, [0, -0.44, 0]);
    limb(knee, 0.44, 0.058);
    const foot = new Mesh(new BoxGeometry(0.1, 0.06, 0.24), joint);
    foot.position.set(0, -0.45, 0.06);
    knee.add(foot);
  }
  root.traverse((object) => { if ((object as Mesh).isMesh) { object.castShadow = !ghost; object.receiveShadow = !ghost; } });
  return { root, joints };
}

type Table = Partial<Record<Joint, [number, number, number]>>;
const STAND: Table = { lShoulder: [0, 0, 7], rShoulder: [0, 0, -7], lElbow: [-8, 0, 0], rElbow: [-8, 0, 0] };
const SEATED: Table = { hips: [-4, 0, 0], lHip: [-88, 0, 5], rHip: [-86, 0, -4], lKnee: [84, 0, 0], rKnee: [88, 0, 0], spine: [-6, 0, 0], lShoulder: [-8, 0, 14], rShoulder: [-8, 0, -14], lElbow: [-72, 0, 0], rElbow: [-72, 0, 0] };
/** Joint rotations in degrees for each named pose; a figure faces +Z. */
const POSES: Record<StagePose, Table> = {
  stand: STAND,
  sit: SEATED,
  lie: { hips: [90, 0, 0], lShoulder: [0, 0, 12], rShoulder: [0, 0, -12] },
  fall: { hips: [90, 0, 25], lShoulder: [-60, 0, 70], rShoulder: [-40, 0, -50], lHip: [-30, 0, 10], lKnee: [50, 0, 0] },
  "lean-on": { spine: [24, 0, 0], chest: [12, 0, 6], neck: [4, 0, 0], head: [10, 0, -10], lHip: [-6, 0, 0], rHip: [-10, 0, 0], lKnee: [10, 0, 0], rKnee: [14, 0, 0], lShoulder: [-30, 0, 8], rShoulder: [-18, 0, -12], lElbow: [-30, 0, 0], rElbow: [-30, 0, 0] },
  reach: { spine: [8, 0, 0], rShoulder: [-80, 0, -6], rElbow: [-10, 0, 0], lShoulder: [0, 0, 8], lElbow: [-8, 0, 0] },
  point: { rShoulder: [-88, 0, -5], rElbow: [0, 0, 0], lShoulder: [0, 0, 7], lElbow: [-8, 0, 0], head: [0, -8, 0] },
  wipe: { spine: [16, 0, 0], rShoulder: [-55, 0, -10], rElbow: [-40, 0, 0], lShoulder: [-20, 0, 10], lElbow: [-50, 0, 0] },
  crouch: { hips: [-10, 0, 0], lHip: [-100, 0, 8], rHip: [-100, 0, -8], lKnee: [130, 0, 0], rKnee: [130, 0, 0], spine: [25, 0, 0], lShoulder: [-30, 0, 10], rShoulder: [-30, 0, -10], lElbow: [-40, 0, 0], rElbow: [-40, 0, 0] },
  stumble: { spine: [30, 0, 0], chest: [10, 0, 0], lHip: [-35, 0, 0], lKnee: [30, 0, 0], rHip: [15, 0, 0], lShoulder: [-40, 0, 60], rShoulder: [-40, 0, -60], lElbow: [-20, 0, 0], rElbow: [-20, 0, 0] },
  "arms-crossed": { lShoulder: [-30, 0, -18], rShoulder: [-30, 0, 18], lElbow: [-105, 0, -55], rElbow: [-105, 0, 55] },
  phone: { rShoulder: [-20, 0, -28], rElbow: [-150, 0, 0], lShoulder: [0, 0, 7], lElbow: [-8, 0, 0], head: [0, 0, 6] },
  carry: { lShoulder: [-35, 0, 10], rShoulder: [-35, 0, -10], lElbow: [-80, 0, 0], rElbow: [-80, 0, 0], spine: [-4, 0, 0] },
  "hands-on-hips": { lShoulder: [0, 0, 42], rShoulder: [0, 0, -42], lElbow: [0, 0, -105], rElbow: [0, 0, 105] },
};

/** A stride on top of a standing pose, its phase in −1..1 from the shot clock. */
function stride(phase: number): Table {
  return {
    lHip: [-22 * phase, 0, 0], rHip: [22 * phase, 0, 0],
    lKnee: [Math.max(0, 25 * phase) + 4, 0, 0], rKnee: [Math.max(0, -25 * phase) + 4, 0, 0],
    lShoulder: [18 * phase, 0, 6], rShoulder: [-18 * phase, 0, -6],
    lElbow: [-14, 0, 0], rElbow: [-14, 0, 0], spine: [3, 0, 0],
  };
}

/** Put the figure in a named pose; a walking figure strides, its phase set by the caller. */
export function poseMannequin(figure: Mannequin, pose: StagePose, walking: number | null): void {
  for (const group of Object.values(figure.joints)) group.rotation.set(0, 0, 0);
  figure.joints.hips.position.set(0, 0.95, 0);
  const table = walking !== null && (pose === "stand" || pose === "carry" || pose === "phone") ? { ...POSES[pose], ...stride(walking), ...(pose === "stand" ? {} : POSES[pose]) } : POSES[pose];
  for (const [name, [x, y, z]] of Object.entries(table) as Array<[Joint, [number, number, number]]>) figure.joints[name].rotation.set(MathUtils.degToRad(x), MathUtils.degToRad(y), MathUtils.degToRad(z));
  if (pose === "sit") figure.joints.hips.position.y = 0.5;
  else if (pose === "crouch") figure.joints.hips.position.y = 0.55;
  else if (pose === "lie" || pose === "fall") figure.joints.hips.position.y = 0.16;
  figure.root.updateWorldMatrix(true, true);
}

const DOWN = new Vector3(0, -1, 0);
const parentTurn = new Quaternion();
const worldTurn = new Quaternion();
function aimBone(bone: Group, direction: Vector3): void {
  worldTurn.setFromUnitVectors(DOWN, direction.clone().normalize());
  bone.parent!.getWorldQuaternion(parentTurn);
  bone.quaternion.copy(parentTurn.invert().multiply(worldTurn));
  bone.updateWorldMatrix(false, true);
}

/** Two-bone IK: the hand lands on a world point, the elbow bending down and back. */
export function reachMannequin(figure: Mannequin, side: "left" | "right", target: Vector3): void {
  const shoulder = figure.joints[side === "left" ? "lShoulder" : "rShoulder"];
  const elbow = figure.joints[side === "left" ? "lElbow" : "rElbow"];
  figure.root.updateWorldMatrix(true, true);
  const scale = figure.root.getWorldScale(new Vector3()).y || 1;
  const a = UPPER_ARM * scale, b = FOREARM * scale;
  const from = new Vector3().setFromMatrixPosition(shoulder.matrixWorld);
  const toward = target.clone().sub(from);
  const distance = Math.min(toward.length(), a + b - 1e-3);
  const direction = toward.normalize();
  const bend = Math.acos(MathUtils.clamp((a * a + distance * distance - b * b) / (2 * a * distance), -1, 1));
  const pole = new Vector3(side === "left" ? 0.3 : -0.3, -0.4, -1).applyQuaternion(figure.root.getWorldQuaternion(new Quaternion())).normalize();
  const axis = new Vector3().crossVectors(direction, pole).normalize();
  const upper = direction.clone().applyAxisAngle(axis, bend);
  aimBone(shoulder, upper);
  const at = from.clone().addScaledVector(upper, a);
  aimBone(elbow, target.clone().sub(at));
}

/** Turn the head toward a world point, within what a neck allows. */
export function lookMannequin(figure: Mannequin, target: Vector3): void {
  figure.root.updateWorldMatrix(true, true);
  const local = figure.root.worldToLocal(target.clone());
  const yaw = MathUtils.clamp(Math.atan2(local.x, local.z), -1.2, 1.2);
  const pitch = MathUtils.clamp(-Math.atan2(local.y - 1.6, Math.hypot(local.x, local.z)), -0.6, 0.6);
  figure.joints.neck.rotation.y = yaw * 0.4;
  figure.joints.head.rotation.set(pitch, yaw * 0.6, 0);
  figure.root.updateWorldMatrix(true, true);
}
