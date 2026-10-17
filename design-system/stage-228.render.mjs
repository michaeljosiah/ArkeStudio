// Turn 228 · the Stage's proposed look, rendered for the frames. One scene — a hotel lobby at night,
// Ade waiting in an armchair and Ife crossing from the lifts to lean on his shoulder — drawn three
// ways: Greybox (today's renderer: one grey, a sun, a grid, capsule figures), Lit (material tags,
// practical lights, AgX, soft shadows, GTAO, fog, a night sky) and Plate (the location plate
// projected from shot 1's camera). The set is assembled from kit items and the figures are jointed
// mannequins posed by name with two-bone IK for the hand contact, as issues 1819, 1821 and 1825 ask.
// window.stage228.render({look, view, w, h}) returns {png, labels}. Deterministic: no clock, no noise.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const rad = THREE.MathUtils.degToRad;

// ---------- Shots: 9:16, Super 35 gate cropped to the aspect, as the app computes it ----------
const ASPECT = 9 / 16;
const vfov = mm => THREE.MathUtils.radToDeg(2 * Math.atan(Math.min(18.66, 24.89 / ASPECT) / 2 / mm));
export const SHOTS = [
  { n: 1, name: 'Wide · Ade waits', p: V(0.0, 1.05, 6.2), l: V(0.9, 0.4, -6), mm: 18 },
  { n: 2, name: 'Ade · checks the time', p: V(0.75, 1.15, 3.4), l: V(1.3, 1.0, 0.05), mm: 50 },
  { n: 3, name: 'Ife · from the lifts', p: V(3.05, 1.5, 1.7), l: V(2.5, 1.1, -1.3), mm: 28 },
  { n: 4, name: 'Two · she leans in', p: V(1.15, 1.3, 3.3), l: V(1.3, 1.22, -0.3), mm: 40 },
];
const OVERVIEW = { p: V(-1.4, 8.6, 10.8), l: V(0.9, 0.2, -1.3), fov: 36 };
const TOP = { p: V(0.4, 22, -0.2), l: V(0.4, 0, -0.21), fov: 34 };
// The board's overview stands further back than the shot's, so every camera, shot 1's at the
// lobby's open front included, is on the stage and numbered (228g).
const BOARD = { p: V(-1.6, 10.5, 14.5), l: V(0.9, 0.2, 0.6), fov: 38 };

// ---------- Materials by tag (Lit) and today's single grey (Greybox) ----------
const TAGS = {
  marble: { color: 0x2a2622, roughness: 0.16, metalness: 0.0 },
  plaster: { color: 0xb88a57, roughness: 0.85 },
  wood: { color: 0x3a281d, roughness: 0.6 },
  stone: { color: 0x2b2a29, roughness: 0.7 },
  metal: { color: 0x8c8274, roughness: 0.32, metalness: 0.85 },
  glass: { color: 0x101a22, roughness: 0.04, metalness: 0.6, transparent: true, opacity: 0.32 },
  fabric: { color: 0x5b4636, roughness: 0.9 },
  leather: { color: 0x2b1a14, roughness: 0.55 },
  rug: { color: 0x463a33, roughness: 1 },
  foliage: { color: 0x2e4a2a, roughness: 0.8 },
  pot: { color: 0x1d1b1a, roughness: 0.5 },
  lamp: { color: 0xffd9a0, emissive: 0xffb45e, emissiveIntensity: 2.4, roughness: 0.6 },
  strip: { color: 0xffe2b8, emissive: 0xffc27a, emissiveIntensity: 3.2 },
};
const litMaterial = new Map(Object.entries(TAGS).map(([k, v]) => [k, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...v })]));
const greyMaterial = new THREE.MeshStandardMaterial({ color: 0xa79e93, roughness: 0.95, side: THREE.DoubleSide });

// ---------- Kit: each item expands to named primitives with a material tag ----------
const parts = []; // {mesh, tag, item}
function prim(item, tag, geo, { x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, shadow = true } = {}) {
  const mesh = new THREE.Mesh(geo, litMaterial.get(tag));
  mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = shadow && tag !== 'glass' && tag !== 'rug'; mesh.receiveShadow = true;
  mesh.userData = { tag, item };
  parts.push(mesh);
  return mesh;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const KIT = new THREE.Group();
function add(item, tag, geo, at) { KIT.add(prim(item, tag, geo, at)); }

function room() { // 8 × 12 × 4.2, open front, glass on the left, lifts on the right
  add('lobby', 'marble', box(8, 0.04, 12), { x: 0, y: -0.02, z: 0 });
  add('lobby', 'plaster', box(8, 5, 0.2), { x: 0, y: 2.5, z: -6.1 });
  add('lobby', 'wood', box(0.2, 5, 12), { x: 4.1, y: 2.5, z: 0 });
  for (let i = 0; i <= 6; i++) add('glass wall', 'stone', box(0.12, 5, 0.12), { x: -4.05, y: 2.5, z: -6 + i * 2 });
  add('glass wall', 'glass', box(0.04, 5, 12), { x: -4.05, y: 2.5, z: 0 });
  add('glass wall', 'stone', box(0.16, 0.12, 12), { x: -4.05, y: 4.96, z: 0 });
}
function lifts() {
  for (const z of [-3.6, -1.4]) {
    add('lifts', 'metal', box(0.06, 2.3, 1.1), { x: 3.98, y: 1.15, z });
    add('lifts', 'stone', box(0.1, 2.5, 1.4), { x: 4.02, y: 1.25, z });
    add('lifts', 'strip', box(0.05, 0.05, 1.0), { x: 3.95, y: 2.42, z });
  }
}
function niche() {
  add('niche', 'stone', box(2.6, 0.1, 0.7), { x: 0.3, y: 0.05, z: -5.65 });
  add('planter', 'pot', new THREE.CylinderGeometry(0.34, 0.28, 0.62, 24), { x: 0.3, y: 0.31, z: -5.55 });
  plant('planter', 0.3, -5.55, 0.62, 1.15, 9);
}
function plant(item, x, z, base, height, leaves) {
  add(item, 'wood', new THREE.CylinderGeometry(0.035, 0.05, height, 8), { x, y: base + height / 2, z });
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2, lean = 0.9 + (i % 3) * 0.18;
    const leaf = new THREE.ConeGeometry(0.09, 0.9, 6); leaf.translate(0, 0.45, 0);
    add(item, 'foliage', leaf, { x, y: base + height * (0.72 + (i % 2) * 0.12), z, ry: a, rx: lean });
  }
}
function pillar(x, z) { add('pillar', 'stone', box(0.62, 5, 0.62), { x, y: 2.5, z }); }
function screen(x, z) {
  add('screen', 'stone', box(0.08, 3.4, 0.08), { x: x - 0.6, y: 1.7, z });
  add('screen', 'stone', box(0.08, 3.4, 0.08), { x: x + 0.6, y: 1.7, z });
  add('screen', 'stone', box(1.28, 0.08, 0.08), { x, y: 3.4, z });
  add('screen', 'glass', box(1.2, 3.36, 0.03), { x, y: 1.7, z });
}
function armchair(item, x, z, ry) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; KIT.add(g);
  const local = (tag, geo, at) => g.add(prim(item, tag, geo, at));
  local('leather', box(0.86, 0.42, 0.8), { y: 0.21 });
  local('leather', box(0.86, 0.62, 0.16), { y: 0.73, z: -0.34 });
  local('leather', box(0.14, 0.24, 0.8), { x: -0.43, y: 0.54 });
  local('leather', box(0.14, 0.24, 0.8), { x: 0.43, y: 0.54 });
}
function table(x, z) {
  add('table', 'stone', new THREE.CylinderGeometry(0.42, 0.42, 0.05, 32), { x, y: 0.42, z });
  add('table', 'metal', new THREE.CylinderGeometry(0.05, 0.12, 0.4, 12), { x, y: 0.2, z });
}
function floorLamp(x, z) {
  add('lamp', 'metal', new THREE.CylinderGeometry(0.015, 0.015, 1.5, 8), { x, y: 0.75, z });
  add('lamp', 'metal', new THREE.CylinderGeometry(0.16, 0.16, 0.02, 16), { x, y: 0.01, z });
  add('lamp', 'lamp', new THREE.CylinderGeometry(0.16, 0.24, 0.3, 24, 1, true), { x, y: 1.55, z, shadow: false });
}
room(); lifts(); niche(); pillar(-1.9, -2.4); screen(2.05, -3.9);
plant('palm', -2.6, 3.0, 0, 1.9, 11);
add('palm', 'pot', new THREE.CylinderGeometry(0.3, 0.26, 0.5, 20), { x: -2.6, y: 0.25, z: 3.0 });
armchair('armchair', 1.3, 0.05, 0); armchair('armchair', -1.25, 1.7, rad(65)); table(0.55, 1.35);
add('rug', 'rug', box(3.2, 0.012, 2.6), { x: 0.6, y: 0.006, z: 0.8 });
floorLamp(2.25, -0.2);

// ---------- Practical lights (Lit), declared on the set like any item ----------
const LIGHTS = [
  { name: 'floor lamp', at: V(2.25, 1.5, -0.2), color: 0xffb867, intensity: 7, distance: 7, shadow: true },
  { name: 'niche wash', at: V(0.3, 3.6, -5.2), color: 0xffb35c, intensity: 14, distance: 8 },
  { name: 'lift strip', at: V(3.7, 2.4, -3.6), color: 0xffd29a, intensity: 3, distance: 4 },
  { name: 'lift strip', at: V(3.7, 2.4, -1.4), color: 0xffd29a, intensity: 3, distance: 4 },
  { name: 'pendant', at: V(0.55, 2.7, 1.35), color: 0xffc78a, intensity: 5, distance: 5 },
];

// ---------- Figures: a jointed mannequin, posed by name ----------
const CAST = { ade: 0x2f7fd8, ife: 0xd6336c };
function mannequin(colour, { ghost = false } = {}) {
  const cloth = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.42, metalness: 0.05, transparent: ghost, opacity: ghost ? 0.22 : 1 });
  const joint = new THREE.MeshStandardMaterial({ color: new THREE.Color(colour).multiplyScalar(0.55), roughness: 0.5, transparent: ghost, opacity: ghost ? 0.22 : 1 });
  const visor = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.25, metalness: 0.4, transparent: ghost, opacity: ghost ? 0.22 : 1 });
  const root = new THREE.Group();
  const J = {};
  const bone = (name, parent, [x, y, z]) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); J[name] = g; return g; };
  const limb = (g, length, r, down = true) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, length - 2 * r), 6, 14), cloth);
    m.position.y = down ? -length / 2 : length / 2; g.add(m);
    const k = new THREE.Mesh(new THREE.SphereGeometry(r * 1.05, 14, 10), joint); g.add(k);
  };
  const hips = bone('hips', root, [0, 0.95, 0]);
  const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.12, 6, 16), cloth); pelvis.rotation.z = Math.PI / 2; hips.add(pelvis);
  const spine = bone('spine', hips, [0, 0.06, 0]); limb(spine, 0.26, 0.12, false);
  const chest = bone('chest', spine, [0, 0.24, 0]);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.16, 8, 18), cloth); torso.scale.set(1.12, 1, 0.7); torso.position.y = 0.13; chest.add(torso);
  const neck = bone('neck', chest, [0, 0.3, 0]); limb(neck, 0.08, 0.045, false);
  const head = bone('head', neck, [0, 0.09, 0]);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 18), cloth); skull.scale.set(0.92, 1.12, 1); skull.position.y = 0.1; head.add(skull);
  // A nose, not a visor: enough to read which way the figure faces, and a mannequin rather than a mascot.
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.06, 10), visor); nose.rotation.x = Math.PI / 2; nose.position.set(0, 0.1, 0.115); head.add(nose);
  for (const [s, x] of [['l', 1], ['r', -1]]) {
    const sh = bone(s + 'Shoulder', chest, [x * 0.21, 0.24, 0]); limb(sh, 0.29, 0.05);
    const el = bone(s + 'Elbow', sh, [0, -0.29, 0]); limb(el, 0.27, 0.042);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), cloth); hand.scale.set(0.8, 1.3, 0.55); hand.position.y = -0.31; el.add(hand);
    const hip = bone(s + 'Hip', hips, [x * 0.1, -0.04, 0]); limb(hip, 0.44, 0.07);
    const knee = bone(s + 'Knee', hip, [0, -0.44, 0]); limb(knee, 0.44, 0.058);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.24), joint); foot.position.set(0, -0.45, 0.06); knee.add(foot);
  }
  root.traverse(o => { if (o.isMesh) { o.castShadow = !ghost; o.receiveShadow = !ghost; } });
  return { root, J };
}
// Named poses: joint rotations in degrees (x, y, z); a figure faces +Z.
const POSES = {
  stand: { lShoulder: [0, 0, 7], rShoulder: [0, 0, -7], lElbow: [-8, 0, 0], rElbow: [-8, 0, 0] },
  walk: { lHip: [18, 0, 0], rHip: [-24, 0, 0], lKnee: [22, 0, 0], rKnee: [6, 0, 0], lShoulder: [-20, 0, 6], rShoulder: [16, 0, -6], lElbow: [-18, 0, 0], rElbow: [-10, 0, 0], spine: [3, 0, 0], head: [-3, 0, 0] },
  sit: { hips: [-4, 0, 0], lHip: [-88, 0, 5], rHip: [-86, 0, -4], lKnee: [84, 0, 0], rKnee: [88, 0, 0], spine: [-6, 0, 0], lShoulder: [-8, 0, 14], rShoulder: [-8, 0, -14], lElbow: [-72, 0, 0], rElbow: [-72, 0, 0] },
  'sit-watch': { hips: [-4, 0, 0], lHip: [-88, 0, 5], rHip: [-86, 0, -4], lKnee: [84, 0, 0], rKnee: [88, 0, 0], spine: [2, 0, 0], head: [22, 0, 0], neck: [6, 0, 0], lShoulder: [-40, 0, 26], lElbow: [-112, 0, 0], rShoulder: [-30, 0, -6], rElbow: [-62, 0, 0] },
  lean: { spine: [24, 0, 0], chest: [12, 0, 6], neck: [4, 0, 0], head: [10, 0, -10], lHip: [-6, 0, 0], rHip: [-10, 0, 0], lKnee: [10, 0, 0], rKnee: [14, 0, 0], rShoulder: [-18, 0, -12], rElbow: [-30, 0, 0] },
};
function pose(fig, name) {
  for (const [j, [x, y, z]] of Object.entries(POSES[name])) fig.J[j].rotation.set(rad(x), rad(y), rad(z));
  if (name.startsWith('sit')) fig.J.hips.position.y = 0.5;
}
// Two-bone IK: the hand lands on a world point; the elbow bends toward the pole.
const _q = new THREE.Quaternion(), _p = new THREE.Quaternion();
function aim(bone, dir) {
  _q.setFromUnitVectors(V(0, -1, 0), dir.clone().normalize());
  bone.parent.getWorldQuaternion(_p);
  bone.quaternion.copy(_p.invert().multiply(_q));
  bone.updateWorldMatrix(false, true);
}
function reach(fig, side, target, pole) {
  const sh = fig.J[side + 'Shoulder'], el = fig.J[side + 'Elbow'], a = 0.29, b = 0.33;
  fig.root.updateWorldMatrix(true, true);
  const S = V(0, 0, 0).applyMatrix4(sh.matrixWorld);
  const toT = target.clone().sub(S), dist = Math.min(toT.length(), a + b - 1e-3), d = toT.normalize();
  const A = Math.acos(THREE.MathUtils.clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1));
  const axis = V(0, 0, 0).crossVectors(d, pole).normalize();
  const upper = d.clone().applyAxisAngle(axis, A);
  aim(sh, upper);
  const E = S.clone().addScaledVector(upper, a);
  aim(el, target.clone().sub(E));
}
function place(fig, x, z, facing) { fig.root.position.set(x, 0, z); fig.root.rotation.y = rad(facing); fig.root.updateWorldMatrix(true, true); }

// Per view: where Ife is. Shot 3 is mid-crossing; 1 at the lift; 2 halfway (soft, behind him); 4 leaning.
const IFE_PATH = [V(3.55, 0, -2.5), V(2.9, 0, -1.6), V(2.1, 0, -0.95), V(1.35, 0, -0.62)];
const ifeAt = { overview: 1.4, top: 1.4, shot1: 0.15, shot2: 1.0, shot3: 1.55, shot4: 3, plate: 1.4, board: 1.4 };
function along(u) { const i = Math.min(Math.floor(u), IFE_PATH.length - 2), f = u - i; return IFE_PATH[i].clone().lerp(IFE_PATH[i + 1], f); }

// ---------- Today's figure: capsules, positioned not jointed (stage-viewport.ts figure()) ----------
function capsuleFigure(colour, seated) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x8c837a, roughness: 0.85 });
  const cloth = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.78 });
  const m = (geo, mat, x, y, z, rx = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.rotation.x = rx; o.castShadow = o.receiveShadow = true; g.add(o); };
  const dy = seated ? -0.32 : 0;
  m(new THREE.SphereGeometry(0.14, 24, 18), skin, 0, 1.62 + dy, 0);
  m(new THREE.CapsuleGeometry(0.17, 0.46, 6, 18), cloth, 0, 1.16 + dy, 0);
  for (const s of [-1, 1]) {
    m(new THREE.CapsuleGeometry(0.052, 0.48, 4, 12), skin, s * 0.235, (seated ? 0.84 : 1.14), 0);
    if (seated) m(new THREE.CapsuleGeometry(0.075, 0.56, 4, 12), cloth, s * 0.095, 0.42, 0.3, Math.PI / 2);
    else m(new THREE.CapsuleGeometry(0.075, 0.56, 4, 12), cloth, s * 0.095, 0.44, 0);
  }
  return g;
}

// ---------- Plate projection: the plate painted onto the set from shot 1's camera ----------
const plateTexture = new THREE.TextureLoader().load('assets/stage-228-plate.jpg');
plateTexture.colorSpace = THREE.SRGBColorSpace;
function plateMaterial(projector) {
  return new THREE.ShaderMaterial({
    uniforms: { plate: { value: plateTexture }, viewProj: { value: projector.projectionMatrix.clone().multiply(projector.matrixWorldInverse) }, eye: { value: projector.position.clone() } },
    vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform sampler2D plate; uniform mat4 viewProj; uniform vec3 eye; varying vec3 vW; varying vec3 vN;
      void main(){ vec4 c = viewProj * vec4(vW,1.0); vec3 ndc = c.xyz / c.w; vec2 uv = ndc.xy * 0.5 + 0.5;
        float facing = abs(dot(normalize(vN), normalize(eye - vW)));
        vec3 base = vec3(0.13,0.12,0.115) * (0.55 + 0.45 * abs(vN.y));
        bool inside = c.w > 0.0 && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0;
        vec3 col = inside ? mix(base, texture2D(plate, uv).rgb, 0.35 + 0.65 * facing) : base;
        gl_FragColor = vec4(col, 1.0);
#include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
  });
}

// ---------- The camera rig as the Stage draws it: body, frustum, aim ring ----------
function rig(shot, { active = true, label = true } = {}) {
  const g = new THREE.Group();
  const ink = active ? 0x111111 : 0x5a5a5a;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.18, 0.34), new THREE.MeshStandardMaterial({ color: ink, roughness: 0.4 }));
  g.add(body);
  const cam = new THREE.PerspectiveCamera(vfov(shot.mm), ASPECT, 0.1, 1.2);
  const d = 1.1, h = d * Math.tan(rad(vfov(shot.mm)) / 2), w = h * ASPECT;
  const pts = [];
  const c = [[-w, h], [w, h], [w, -h], [-w, -h]];
  // A group's lookAt turns its +Z toward the target (only cameras look down −Z), so the frustum
  // opens along +Z: the cone points at what the shot records.
  for (const [x, y] of c) pts.push(V(0, 0, 0), V(x, y, d));
  for (let i = 0; i < 4; i++) pts.push(V(c[i][0], c[i][1], d), V(c[(i + 1) % 4][0], c[(i + 1) % 4][1], d));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: active ? 0xffffff : 0xbbbbbb, transparent: true, opacity: active ? 0.9 : 0.5 })));
  g.position.copy(shot.p); g.lookAt(shot.l);
  void cam; void label;
  return g;
}

// ---------- Build a scene for a look and a view ----------
function scene(look, view) {
  const s = new THREE.Scene();
  const lit = look !== 'greybox';
  const ife = ifeAt[view] ?? 1.4;
  if (look === 'greybox') {
    s.background = new THREE.Color(0xeeece8);
    s.add(new THREE.HemisphereLight(0xffffff, 0xc9c3b8, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(4.5, 7.5, 4); key.castShadow = true;
    Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9 }); key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0012;
    s.add(key);
    const grid = new THREE.GridHelper(40, 40, 0x9a9187, 0xbdb6ac); grid.material.transparent = true; grid.material.opacity = 0.5; grid.position.y = 0.002; s.add(grid);
  } else {
    // A night sky behind the glass: a vertical gradient with lit windows far off.
    const sky = document.createElement('canvas'); sky.width = 64; sky.height = 256;
    const sg = sky.getContext('2d'); const grad = sg.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#05070d'); grad.addColorStop(0.6, '#0d1424'); grad.addColorStop(1, '#1b1a22'); sg.fillStyle = grad; sg.fillRect(0, 0, 64, 256);
    const skyTex = new THREE.CanvasTexture(sky); skyTex.colorSpace = THREE.SRGBColorSpace; s.background = skyTex;
    const city = document.createElement('canvas'); city.width = 512; city.height = 256; const cg = city.getContext('2d');
    cg.fillStyle = '#070a12'; cg.fillRect(0, 0, 512, 256);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let b = 0; b < 14; b++) { const bx = b * 37 + rnd() * 10, bw = 26 + rnd() * 14, bh = 60 + rnd() * 160; cg.fillStyle = '#0c111c'; cg.fillRect(bx, 256 - bh, bw, bh); for (let y = 256 - bh + 6; y < 250; y += 9) for (let x = bx + 4; x < bx + bw - 4; x += 7) if (rnd() > 0.55) { cg.fillStyle = rnd() > 0.7 ? '#ffd39a' : '#8fb4ff'; cg.globalAlpha = 0.35 + rnd() * 0.5; cg.fillRect(x, y, 3, 4); cg.globalAlpha = 1; } }
    const cityTex = new THREE.CanvasTexture(city); cityTex.colorSpace = THREE.SRGBColorSpace;
    const far = new THREE.Mesh(new THREE.PlaneGeometry(60, 30), new THREE.MeshBasicMaterial({ map: cityTex, fog: false }));
    far.position.set(-26, 12, 0); far.rotation.y = Math.PI / 2; s.add(far);
    s.fog = new THREE.FogExp2(0x0c0d12, 0.022);
    s.add(new THREE.HemisphereLight(0x3a4a72, 0x1a120c, 0.55));
    const moon = new THREE.DirectionalLight(0x9db4ff, 0.9); moon.position.set(-9, 8, 3); moon.castShadow = true;
    Object.assign(moon.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 30 }); moon.shadow.mapSize.set(2048, 2048); moon.shadow.bias = -0.0006; moon.shadow.radius = 4;
    s.add(moon);
    for (const l of LIGHTS) { const p = new THREE.PointLight(l.color, l.intensity, l.distance, 2); p.position.copy(l.at); if (l.shadow) { p.castShadow = true; p.shadow.mapSize.set(1024, 1024); p.shadow.bias = -0.002; } s.add(p); }
  }
  // Set
  const kit = KIT.clone(true);
  const projector = new THREE.PerspectiveCamera(vfov(SHOTS[0].mm), ASPECT, 0.1, 100); projector.position.copy(SHOTS[0].p); projector.lookAt(SHOTS[0].l); projector.updateMatrixWorld(); projector.updateProjectionMatrix();
  const plate = look === 'plate' ? plateMaterial(projector) : null;
  kit.traverse(o => {
    if (!o.isMesh) return;
    if (look === 'greybox') o.material = o.userData.tag === 'glass' ? Object.assign(greyMaterial.clone(), { transparent: true, opacity: 0.22 }) : greyMaterial;
    else if (plate && !['lamp', 'strip'].includes(o.userData.tag)) o.material = plate;
  });
  s.add(kit);
  // Figures
  const labels = [];
  if (look === 'greybox') {
    const ade = capsuleFigure(0x7a2e3b, true); ade.position.set(1.3, 0, 0.05); s.add(ade);
    const at = along(ife); const ifeFig = capsuleFigure(0xb5832f, false); ifeFig.position.set(at.x, 0, at.z); s.add(ifeFig);
    labels.push(['Ade', V(1.3, 1.62, 0.05)], ['Ife', V(at.x, 1.95, at.z)]);
  } else {
    const ade = mannequin(CAST.ade); place(ade, 1.3, 0.05, -8); pose(ade, view === 'shot2' ? 'sit-watch' : 'sit'); s.add(ade.root);
    const at = along(ife), next = along(Math.min(ife + 0.2, 3));
    const ifeFig = mannequin(CAST.ife);
    if (ife >= 3) {
      place(ifeFig, 1.32, -0.6, 0); pose(ifeFig, 'lean');
      ade.root.updateWorldMatrix(true, true);
      const shoulder = V(0, 0, 0).applyMatrix4(ade.J.lShoulder.matrixWorld).add(V(0.02, 0.04, 0.0));
      reach(ifeFig, 'l', shoulder, V(0.4, -0.3, -1).normalize());
    } else {
      const facing = THREE.MathUtils.radToDeg(Math.atan2(next.x - at.x, next.z - at.z));
      place(ifeFig, at.x, at.z, facing); pose(ifeFig, 'walk');
    }
    s.add(ifeFig.root);
    labels.push(['Ade', V(1.3, 1.45, 0.05)], ['Ife', ife >= 3 ? V(1.32, 1.75, -0.6) : V(at.x, 1.95, at.z)]);
    if (view === 'overview' || view === 'plate' || view === 'board') {
      const ghost = mannequin(CAST.ife, { ghost: true }); place(ghost, 1.32, -0.6, 0); pose(ghost, 'lean'); s.add(ghost.root);
    }
  }
  // Ife's walk as the Stage draws it, and the rigs, in the overviews only
  if (view === 'overview' || view === 'plate' || view === 'board' || view === 'top') {
    const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(IFE_PATH.map(p => V(p.x, 0.02, p.z))), new THREE.LineDashedMaterial({ color: look === 'greybox' ? 0x5f6b7a : 0xff8fb3, dashSize: 0.18, gapSize: 0.1 }));
    path.computeLineDistances(); s.add(path);
    const shown = view === 'board' || view === 'top' ? SHOTS : [SHOTS[0]];
    for (const sh of shown) { s.add(rig(sh, { active: view !== 'board' || sh.n === 3 })); labels.push([view === 'board' || view === 'top' ? String(sh.n) : 'CAMERA', sh.p.clone().add(V(0, 0.32, 0))]); }
    labels.push(['lifts', V(3.9, 2.9, -2.5)], ['armchair', V(-1.25, 1.05, 1.7)], ['planter', V(0.3, 2.3, -5.55)], ['glass wall', V(-4, 3.2, -1)]);
  }
  return { s, labels };
}

// ---------- Render ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
const pmrem = new THREE.PMREMGenerator(renderer);
const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

function cameraFor(view, w, h) {
  if (view.startsWith('shot') || view === 'plateview') {
    const sh = view === 'plateview' ? SHOTS[0] : SHOTS[Number(view.slice(4)) - 1];
    const c = new THREE.PerspectiveCamera(vfov(sh.mm), w / h, 0.05, 200); c.position.copy(sh.p); c.lookAt(sh.l); return c;
  }
  const v = view === 'top' ? TOP : view === 'board' ? BOARD : OVERVIEW;
  const c = new THREE.PerspectiveCamera(v.fov, w / h, 0.1, 200); c.position.copy(v.p); c.lookAt(v.l); return c;
}

async function render({ look = 'lit', view = 'overview', w = 1600, h = 900, type = 'image/png' }) {
  await new Promise(r => (plateTexture.image ? r() : (plateTexture.onUpdate = r, setTimeout(r, 1500))));
  const { s, labels } = scene(look, view === 'plateview' ? 'shot1' : view);
  const cam = cameraFor(view, w, h);
  renderer.setSize(w, h);
  if (look === 'greybox') {
    renderer.toneMapping = THREE.NoToneMapping; s.environment = null;
    renderer.render(s, cam);
  } else {
    renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = look === 'plate' ? 1.0 : 1.35;
    s.environment = env; s.environmentIntensity = 0.35;
    const composer = new EffectComposer(renderer);
    composer.setSize(w, h);
    composer.addPass(new RenderPass(s, cam));
    if (look === 'lit') { const ao = new GTAOPass(s, cam, w, h); ao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1, thickness: 1, scale: 1.2 }); ao.blendIntensity = 0.85; composer.addPass(ao); }
    composer.addPass(new OutputPass());
    composer.render();
  }
  cam.updateMatrixWorld();
  const projected = labels.map(([text, p]) => { const v = p.clone().project(cam); return { text, x: Math.round((v.x * 0.5 + 0.5) * w), y: Math.round((-v.y * 0.5 + 0.5) * h), visible: v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 }; });
  return { png: renderer.domElement.toDataURL(type, 0.9), labels: projected };
}
window.stage228 = { render, SHOTS: SHOTS.map(s => ({ n: s.n, name: s.name, p: s.p.toArray(), l: s.l.toArray(), mm: s.mm, vfov: vfov(s.mm) })) };
window.stage228ready = true;
