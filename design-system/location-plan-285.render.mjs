// Turn 285 · the Plan's pictures, rendered. Built from stage-229.render.mjs: the same engine
// (three.js, the app's own), the same Greybox figure and rig, deterministic, no clock and no noise.
// What is new is the set and the camera above it. The set is the turn's sample (a club: the kit's
// Room, Counter, Booth and Table and chairs, a box for the DJ and a slab for the dance floor), and it
// is expanded by the app's own kit code, packages/contracts/src/stage-kit.ts, not by a copy of it;
// materials and the night come from packages/contracts/src/stage-look.ts. So the plan is the Stage's
// scene seen from straight above through an orthographic camera, which is the turn's first rule.
//
//   window.plan285.render({ view, ... }) returns { png, frame }:
//     view 'plan'      the set from above in Greybox, with what the Plan draws over it
//     view 'grey'      the grey view from position n: the set alone, through that position's lens
//     view 'picture'   the same view in Lit, standing in for a drawn location picture
//
// Bundled and driven by location-plan-285.renders.mjs (it imports TypeScript from contracts).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { expandStageSet } from '../packages/contracts/src/stage-kit.ts';
import { STAGE_MATERIAL_LOOKS, stageAtmosphereLook, stageMaterialOf } from '../packages/contracts/src/stage-look.ts';
import { CAST, CROSSING, POSITIONS, SETS, SIDES } from './location-plan-285.plan.mjs';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const rad = THREE.MathUtils.degToRad;
const INK = 0x111111, WARN = 0xd97706;

// The lens as the app computes it: a Super 35 gate cropped to the production's aspect.
const GATE_W = 24.89, GATE_H = 18.66;
export const vfov = (mm, aspect) => THREE.MathUtils.radToDeg(2 * Math.atan(Math.min(GATE_H, GATE_W / aspect) / 2 / mm));
export const hfov = (mm, aspect) => THREE.MathUtils.radToDeg(2 * Math.atan(Math.min(GATE_W, GATE_H * aspect) / 2 / mm));

// ---------- The set, as stage-viewport.ts draws it: one mesh a part, edges in the Greybox line ----------
const GREY = 0xa79e93, EDGE = 0x9a9187;
// The club's surfaces for Lit, named as a Room's form names them (229e).
const DRESS = { club: { material: 'stone', surfaces: { floor: 'marble' } }, bar: { surfaces: { wood: 'wood', stone: 'marble' } }, DJ: { material: 'metal' }, 'dance floor': { material: 'marble' }, 'low table': { material: 'marble' } };
// Its practical lights, as a Light's form holds them: kind, colour, strength, reach, place.
const LIGHTS = [
  { name: 'bar pendants', colour: 0xffb35c, strength: 16, reach: 7, at: [0, 2.3, -3.0] },
  { name: 'booth wash', colour: 0xff3f9a, strength: 12, reach: 6, at: [-5.4, 2.5, 0.05] },
  { name: 'table wash', colour: 0x9a5cff, strength: 13, reach: 6, at: [5.2, 2.5, -1.4] },
  { name: 'DJ', colour: 0x5c8dff, strength: 12, reach: 7, at: [0.2, 2.4, 2.9] },
  { name: 'floor', colour: 0xb04dff, strength: 9, reach: 8, at: [0.2, 3.0, 0.3] },
];

function setGroup(look, { plan = false } = {}) {
  const group = new THREE.Group();
  for (const item of SETS) {
    const dressed = { ...item, solid: true, ...(DRESS[item.name] ?? {}) };
    for (const part of expandStageSet(dressed)) {
      const geometry = part.shape === 'sphere' ? new THREE.SphereGeometry(0.5, 16, 12) : part.shape === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 16) : new THREE.BoxGeometry(1, 1, 1);
      let material;
      if (look === 'greybox') material = new THREE.MeshStandardMaterial({ color: GREY, roughness: 0.95, side: THREE.DoubleSide, transparent: !part.solid, opacity: part.solid ? 1 : 0.22 });
      else {
        const m = STAGE_MATERIAL_LOOKS[stageMaterialOf(dressed, part)];
        material = new THREE.MeshStandardMaterial({ color: m.colour, roughness: m.roughness, metalness: m.metalness, side: THREE.DoubleSide, transparent: m.opacity !== undefined, opacity: m.opacity ?? 1, emissive: m.emissive ?? 0, emissiveIntensity: m.emissiveIntensity ?? 0 });
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.set(part.w, part.h, part.d);
      mesh.position.set(part.x, (part.y ?? 0) + part.h / 2, part.z);
      if (part.rotation) mesh.rotation.set(...part.rotation.map(rad));
      // On the Plan a room's walls throw no shadow: the floor is what is being read.
      mesh.castShadow = part.solid && !(plan && item.kit?.kind === 'room'); mesh.receiveShadow = true;
      group.add(mesh);
      if (look === 'greybox') {
        // The Greybox line. From above it is all that parts a table from the floor, so the Plan
        // draws it at full strength and a shade darker.
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: plan ? 0x6f675d : EDGE, transparent: true, opacity: plan ? 1 : 0.6 }));
        edges.position.copy(mesh.position); edges.rotation.copy(mesh.rotation); edges.scale.copy(mesh.scale);
        group.add(edges);
      }
    }
  }
  return group;
}

// ---------- Greybox's figure: capsules, as stage-229.render.mjs draws them, in the cast's colour ----------
function capsuleFigure(colour, seated) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x8c837a, roughness: 0.85 });
  const cloth = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.78 });
  const m = (geo, mat, x, y, z, rx = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.rotation.x = rx; o.castShadow = o.receiveShadow = true; g.add(o); };
  const dy = seated ? -0.32 : 0;
  m(new THREE.SphereGeometry(0.14, 24, 18), skin, 0, 1.62 + dy, 0);
  m(new THREE.CapsuleGeometry(0.17, 0.46, 6, 18), cloth, 0, 1.16 + dy, 0);
  // A nose, so the way a figure faces reads from above (229's figure rule).
  m(new THREE.ConeGeometry(0.035, 0.1, 10), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.4 }), 0, 1.62 + dy, 0.16, Math.PI / 2);
  for (const s of [-1, 1]) {
    m(new THREE.CapsuleGeometry(0.052, 0.48, 4, 12), skin, s * 0.235, seated ? 0.84 : 1.14, 0);
    if (seated) m(new THREE.CapsuleGeometry(0.075, 0.56, 4, 12), cloth, s * 0.095, 0.42, 0.3, Math.PI / 2);
    else m(new THREE.CapsuleGeometry(0.075, 0.56, 4, 12), cloth, s * 0.095, 0.44, 0);
  }
  return g;
}

// ---------- What the Plan draws over the set: always on top, as the app's own overview strokes are ----------
const over = (colour, opacity) => new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
const TOP = 6; // above the walls, under the camera
/** A flat ribbon between two floor points, `width` metres wide. */
function ribbon(a, b, width, material, order = 10) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(length, width), material);
  mesh.rotation.set(-Math.PI / 2, 0, -Math.atan2(b[1] - a[1], b[0] - a[0]));
  mesh.position.set((a[0] + b[0]) / 2, TOP, (a[1] + b[1]) / 2);
  mesh.renderOrder = order;
  return mesh;
}
function dashed(points, colour, { dash = 0.26, gap = 0.16, width = 0.07 } = {}) {
  const group = new THREE.Group(); const material = over(colour, 0.95);
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]]; const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let t = 0; t < length; t += dash + gap) {
      const u0 = t / length, u1 = Math.min(t + dash, length) / length;
      group.add(ribbon([a[0] + (b[0] - a[0]) * u0, a[1] + (b[1] - a[1]) * u0], [a[0] + (b[0] - a[0]) * u1, a[1] + (b[1] - a[1]) * u1], width, material, 11));
    }
  }
  return group;
}
function disc(x, z, r, material, inner = 0, order = 12) {
  const mesh = new THREE.Mesh(inner ? new THREE.RingGeometry(inner, r, 40) : new THREE.CircleGeometry(r, 40), material);
  mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, TOP, z); mesh.renderOrder = order;
  return mesh;
}
/** A position on the plan: a wedge as wide as its lens sees and `reach` metres long, and its body. */
function wedge(position, aspect, { state = 'rest', reach = 1.0, line = 0.045, body = 0.21 } = {}) {
  const group = new THREE.Group();
  const [x, y, z] = position.at, heading = Math.atan2(position.aim[2] - z, position.aim[0] - x), half = rad(hfov(position.mm, aspect)) / 2;
  const tip = a => [x + Math.cos(a) * reach, z + Math.sin(a) * reach];
  const colour = state === 'warn' ? WARN : INK;
  const fillOf = over(colour, state === 'rest' ? 0.14 : state === 'selected' ? 0.45 : 0.34), stroke = over(colour, state === 'rest' ? 0.75 : 1);
  if (state === 'selected') line *= 1.8;
  if (Math.hypot(position.aim[0] - x, position.aim[2] - z) < 0.05) {
    // Looking straight down: no wedge to draw, so the plan draws what the lens frames at its aim.
    const halfW = (y - position.aim[1]) * Math.tan(half), halfH = halfW / aspect;
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(halfW * 2, halfH * 2), fillOf); frame.rotation.x = -Math.PI / 2; frame.position.set(x, TOP, z); frame.renderOrder = 13; group.add(frame);
    const c = [[x - halfW, z - halfH], [x + halfW, z - halfH], [x + halfW, z + halfH], [x - halfW, z + halfH]];
    for (let i = 0; i < 4; i++) group.add(ribbon(c[i], c[(i + 1) % 4], line, stroke, 14));
    group.add(disc(x, z, body, over(colour, 1), 0, 15));
    return group;
  }
  const shape = new THREE.BufferGeometry().setFromPoints([V(x, TOP, z), V(...[tip(heading - half)[0], TOP, tip(heading - half)[1]]), V(...[tip(heading + half)[0], TOP, tip(heading + half)[1]])]);
  shape.setIndex([0, 1, 2]);
  const fill = new THREE.Mesh(shape, fillOf); fill.renderOrder = 13;
  group.add(fill);
  group.add(ribbon([x, z], tip(heading - half), line, stroke, 14), ribbon([x, z], tip(heading + half), line, stroke, 14), ribbon(tip(heading - half), tip(heading + half), line, stroke, 14));
  // Selected, its sight line runs on to what it looks at.
  if (state === 'selected') group.add(dashed([tip(heading), [position.aim[0], position.aim[2]]], INK, { dash: 0.12, gap: 0.12, width: 0.035 }));
  group.add(disc(x, z, body, over(colour, 1), 0, 15));
  return group;
}
/** A pair's line between their marks, hatched on the side their cameras keep. */
function sideLine(pair) {
  const group = new THREE.Group(); const [a, b] = pair.line; const material = over(INK, 0.55);
  group.add(ribbon(a, b, 0.035, material, 9));
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(3, Math.round(length / 0.32));
  for (let i = 0; i <= n; i++) {
    const p = [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n];
    group.add(ribbon(p, [p[0] + pair.keep[0] * 0.2, p[1] + pair.keep[1] * 0.2], 0.03, material, 9));
  }
  return group;
}

// ---------- Scenes ----------
function greyboxLight(scene, { overhead }) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc9c3b8, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  // The Stage's key stands at (4.5, 7.5, 4). On the Plan it stands high, so a table's shadow is a
  // rim beside it and not a shape across the floor being read.
  key.position.set(...(overhead ? [2.2, 9, 1.8] : [4.5, 7.5, 4]));
  key.castShadow = true; Object.assign(key.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 0.5, far: 40 });
  key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0012;
  scene.add(key);
}
function planScene({ cast = true, paths = true, sides = true, positions = POSITIONS, selected = null, warn = null, aspect = 16 / 9, reach = 1.0, weight = 1, body = 0.21 }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe6e3dd); // the clear colour of the app's own Greybox stills
  greyboxLight(scene, { overhead: true });
  const grid = new THREE.GridHelper(40, 40, 0x9a9187, 0xbdb6ac); grid.material.transparent = true; grid.material.opacity = 0.5; grid.position.y = -0.03; scene.add(grid);
  scene.add(setGroup('greybox', { plan: true }));
  if (cast) for (const member of CAST) {
    const [first, ...later] = member.marks;
    const figure = capsuleFigure(member.colour, first.pose === 'sit'); figure.position.set(first.x, 0, first.z); figure.rotation.y = rad(first.facing); scene.add(figure);
    scene.add(disc(first.x, first.z, 0.36 * weight, over(member.colour, 0.22), 0, 8), disc(first.x, first.z, 0.36 * weight, over(member.colour, 1), 0.36 * weight - 0.055 * weight, 8));
    // A later mark is a ring with nobody on it yet.
    for (const mark of later) scene.add(disc(mark.x, mark.z, 0.3 * weight, over(member.colour, 1), 0.3 * weight - 0.05 * weight, 8));
    if (paths && member.path) scene.add(dashed(member.path, member.colour, { width: 0.07 * weight }));
  }
  if (cast && sides) for (const pair of SIDES) scene.add(sideLine(pair));
  for (const position of positions) scene.add(wedge(position, aspect, { state: position.n === warn ? 'warn' : position.n === selected ? 'selected' : 'rest', reach, line: 0.045 * weight, body }));
  return scene;
}
function viewScene(look) {
  const scene = new THREE.Scene();
  if (look === 'greybox') { scene.background = new THREE.Color(0xe6e3dd); greyboxLight(scene, { overhead: false }); }
  else {
    const a = stageAtmosphereLook({ time: 'night' });
    scene.background = new THREE.Color(a.skyBottom);
    scene.fog = new THREE.FogExp2(a.fog, 0.018);
    scene.environment = environment; scene.environmentIntensity = 0.3;
    scene.add(new THREE.HemisphereLight(a.hemisphereSky, a.hemisphereGround, a.hemisphereIntensity * 0.55));
    for (const light of LIGHTS) { const p = new THREE.PointLight(light.colour, light.strength * 3, light.reach * 1.6, 1.6); p.position.set(...light.at); p.castShadow = light.name !== 'floor'; p.shadow.mapSize.set(1024, 1024); p.shadow.bias = -0.002; scene.add(p); }
  }
  scene.add(setGroup(look));
  return scene;
}

// ---------- Render ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
const environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;

/** The room with `margin` metres round it, in a frame of w × h: what the orthographic camera sees. */
function planFrame(w, h, margin) {
  const room = SETS[0], aspect = w / h;
  const halfW = Math.max(room.w / 2 + margin, (room.d / 2 + margin) * aspect), halfH = halfW / aspect;
  return { x0: room.x - halfW, z0: room.z - halfH, s: w / (2 * halfW), halfW, halfH };
}

function render({ view = 'plan', n = 1, w = 1338, h = 828, margin = 0.3, type = 'image/jpeg', aspect = 16 / 9, crossing = false, ...draw }) {
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.NoToneMapping;
  if (view === 'plan') {
    const frame = planFrame(w, h, margin);
    const scene = planScene({ ...draw, aspect, positions: crossing ? [...POSITIONS, CROSSING] : (draw.positions ?? POSITIONS) });
    const camera = new THREE.OrthographicCamera(-frame.halfW, frame.halfW, frame.halfH, -frame.halfH, 0.1, 80);
    camera.position.set(SETS[0].x, 40, SETS[0].z); camera.up.set(0, 0, -1); camera.lookAt(SETS[0].x, 0, SETS[0].z);
    renderer.render(scene, camera);
    return { png: renderer.domElement.toDataURL(type, 0.9), frame: { w, h, x0: frame.x0, z0: frame.z0, s: frame.s } };
  }
  const position = [...POSITIONS, CROSSING].find(p => p.n === n);
  const camera = new THREE.PerspectiveCamera(vfov(position.mm, aspect), w / h, 0.05, 200);
  // Straight down, north is the top of the picture, as it is on the plan.
  if (Math.hypot(position.aim[0] - position.at[0], position.aim[2] - position.at[2]) < 0.05) camera.up.set(0, 0, -1);
  camera.position.set(...position.at); camera.lookAt(V(...position.aim));
  if (view === 'picture') { renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = 1.6; }
  renderer.render(viewScene(view === 'picture' ? 'lit' : 'greybox'), camera);
  return { png: renderer.domElement.toDataURL(type, 0.9), frame: { w, h } };
}
window.plan285 = { render };
window.plan285ready = true;
