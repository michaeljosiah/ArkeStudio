import { STAGE_CAMERA_NEAR, expandStageSet, parseAspect, planBounds, planMark, stagingFov, type PlacePosition, type PlanFigure, type PlanFrame, type PlanSide, type StagingSet } from "@arke-studio/contracts";
import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  OrthographicCamera,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type Material,
} from "three";

/**
 * The Plan's pictures (design turn 285, issue 2302): a place's set from straight above with what
 * the Plan draws over it, and the grey view a position's lens sees. Ported from the turn's own
 * recipe, design-system/location-plan-285.render.mjs, so the screen is the approved frames.
 *
 * Both are still pictures, drawn once for each change and copied into a 2D canvas, through one
 * renderer the module keeps. A location's Plan tab draws its plan and up to 24 grey views; a
 * WebGL context each would pass the browser's limit, and the browser answers that by dropping the
 * oldest context on the page, which may be the Stage's.
 *
 * No React in here and no application state: plain data in, pixels out.
 */

export interface PlanPictureFigure extends PlanFigure {
  /** The cast colour, by the scene's cast order, as the Stage draws the same person. */
  colour: number;
}

export interface PlanPictureModel {
  sets: readonly StagingSet[];
  cast: readonly PlanPictureFigure[];
  sides: readonly PlanSide[];
  positions: ReadonlyArray<Pick<PlacePosition, "n" | "p" | "l" | "focalMm">>;
  selected: number | null;
  /** The positions a crossing shot uses, drawn in the warning colour. */
  warn: readonly number[];
  aspect: string;
  /** From contracts' planFrame, so what is written over the canvas falls where the canvas drew it. */
  frame: PlanFrame;
}

export interface PlanPictureOptions {
  /** How heavy the lines are; a phone's picture is 1.8 times as heavy. */
  weight?: number;
  /** A position's body, metres in radius. */
  body?: number;
}

const GROUND = 0xe6e3dd;
const GREY = 0xa79e93;
const EDGE = 0x9a9187;
const PLAN_EDGE = 0x6f675d;
const INK = 0x111111;
const WARN = 0xd97706;
const rad = MathUtils.degToRad;

type Floor = readonly [number, number];

let available: boolean | undefined;
/** Whether this window can draw the pictures at all. A test DOM and a headless run cannot. */
export function planPictureAvailable(): boolean {
  if (available !== undefined) return available;
  available = false;
  if (typeof document === "undefined") return false;
  const probe = document.createElement("canvas");
  if (typeof probe.getContext !== "function") return false;
  try {
    available = (probe.getContext("webgl2") ?? probe.getContext("webgl")) !== null;
  } catch {
    available = false;
  }
  return available;
}

let shared: WebGLRenderer | null = null;
function renderer(): WebGLRenderer | null {
  if (shared !== null) return shared;
  if (!planPictureAvailable()) return null;
  try {
    const created = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    created.setPixelRatio(1);
    created.shadowMap.enabled = true;
    created.shadowMap.type = PCFShadowMap;
    created.toneMapping = NoToneMapping;
    // The browser may take this context back for a newer one (the Stage opens several). A lost
    // renderer draws nothing and says nothing, so the next picture starts a fresh one.
    created.domElement.addEventListener("webglcontextlost", () => {
      if (shared === created) shared = null;
      created.dispose();
    });
    shared = created;
  } catch {
    available = false;
  }
  return shared;
}

/** Everything a picture built goes with it: nothing outlives the one render it was made for. */
function discard(scene: Scene): void {
  scene.traverse((object) => {
    const drawn = object as Mesh;
    drawn.geometry?.dispose();
    const materials: Material[] = Array.isArray(drawn.material) ? drawn.material : drawn.material === undefined ? [] : [drawn.material];
    for (const material of materials) material.dispose();
    if ((object as DirectionalLight).isDirectionalLight) (object as DirectionalLight).shadow.dispose();
  });
}

/** The set as stage-viewport.ts draws it in Greybox: one mesh a part, and its edges. */
function setGroup(sets: readonly StagingSet[], plan: boolean): Group {
  const group = new Group();
  for (const item of sets) {
    const room = item.kit?.kind === "room";
    for (const part of expandStageSet(item)) {
      // From straight above a ceiling is all there is to see, so the Plan leaves it off, as the
      // Stage's overview cuts it away. A lens inside the room still looks up at it.
      if (plan && room && /\bceiling\b/.test(part.name)) continue;
      let geometry: BufferGeometry = part.shape === "sphere" ? new SphereGeometry(0.5, 16, 12) : part.shape === "cylinder" ? new CylinderGeometry(0.5, 0.5, 1, 16) : new BoxGeometry(1, 1, 1);
      if (part.shape === "mesh" && part.vertices && part.triangles) {
        geometry.dispose();
        geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute(part.vertices.flat(), 3));
        geometry.setIndex(part.triangles);
        geometry.computeVertexNormals();
      }
      const solid = part.solid ?? false;
      const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: GREY, roughness: 0.95, side: DoubleSide, transparent: !solid, opacity: solid ? 1 : 0.22 }));
      mesh.scale.set(part.w, part.h, part.d);
      mesh.position.set(part.x, (part.y ?? 0) + part.h / 2, part.z);
      if (part.rotation) mesh.rotation.set(rad(part.rotation[0]), rad(part.rotation[1]), rad(part.rotation[2]));
      // On the Plan a room's walls throw no shadow: the floor is what is being read.
      mesh.castShadow = solid && !(plan && room);
      mesh.receiveShadow = true;
      group.add(mesh);
      // From above the Greybox line is all that parts a table from the floor, so the Plan draws
      // it at full strength and a shade darker.
      const edges = new LineSegments(new EdgesGeometry(geometry), new LineBasicMaterial({ color: plan ? PLAN_EDGE : EDGE, transparent: true, opacity: plan ? 1 : 0.6 }));
      edges.position.copy(mesh.position);
      edges.rotation.copy(mesh.rotation);
      edges.scale.copy(mesh.scale);
      group.add(edges);
    }
  }
  return group;
}

/** Greybox's figure, capsules in the cast's colour, with the nose that says which way it faces. */
function capsuleFigure(colour: number, seated: boolean): Group {
  const group = new Group();
  const skin = new MeshStandardMaterial({ color: 0x8c837a, roughness: 0.85 });
  const cloth = new MeshStandardMaterial({ color: colour, roughness: 0.78 });
  const add = (geometry: BufferGeometry, material: Material, x: number, y: number, z: number, turn = 0) => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.x = turn;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  };
  const drop = seated ? -0.32 : 0;
  add(new SphereGeometry(0.14, 24, 18), skin, 0, 1.62 + drop, 0);
  add(new CapsuleGeometry(0.17, 0.46, 6, 18), cloth, 0, 1.16 + drop, 0);
  add(new ConeGeometry(0.035, 0.1, 10), new MeshStandardMaterial({ color: 0x15171c, roughness: 0.4 }), 0, 1.62 + drop, 0.16, Math.PI / 2);
  for (const side of [-1, 1]) {
    add(new CapsuleGeometry(0.052, 0.48, 4, 12), skin, side * 0.235, seated ? 0.84 : 1.14, 0);
    if (seated) add(new CapsuleGeometry(0.075, 0.56, 4, 12), cloth, side * 0.095, 0.42, 0.3, Math.PI / 2);
    else add(new CapsuleGeometry(0.075, 0.56, 4, 12), cloth, side * 0.095, 0.44, 0);
  }
  return group;
}

/**
 * What the Plan draws over the set, at one height above everything and with no depth test: a
 * table never hides a wedge. The draw order is the only order these have.
 */
class Overlay {
  readonly group = new Group();
  constructor(private readonly top: number) {}

  private material(colour: number, opacity: number): MeshBasicMaterial {
    return new MeshBasicMaterial({ color: colour, transparent: true, opacity, depthTest: false, depthWrite: false, side: DoubleSide });
  }

  /** A flat ribbon between two floor points, `width` metres wide. */
  ribbon(a: Floor, b: Floor, width: number, colour: number, opacity: number, order: number): void {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-4) return;
    const mesh = new Mesh(new PlaneGeometry(length, width), this.material(colour, opacity));
    mesh.rotation.set(-Math.PI / 2, 0, -Math.atan2(b[1] - a[1], b[0] - a[0]));
    mesh.position.set((a[0] + b[0]) / 2, this.top, (a[1] + b[1]) / 2);
    mesh.renderOrder = order;
    this.group.add(mesh);
  }

  dashed(points: readonly Floor[], colour: number, dash: number, gap: number, width: number): void {
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index]!, b = points[index + 1]!;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 1e-4) continue;
      for (let along = 0; along < length; along += dash + gap) {
        const from = along / length, to = Math.min(along + dash, length) / length;
        this.ribbon([a[0] + (b[0] - a[0]) * from, a[1] + (b[1] - a[1]) * from], [a[0] + (b[0] - a[0]) * to, a[1] + (b[1] - a[1]) * to], width, colour, 0.95, 11);
      }
    }
  }

  /** A filled circle, or a ring when `inner` is given. */
  disc(at: Floor, radius: number, colour: number, opacity: number, order: number, inner = 0): void {
    const mesh = new Mesh(inner > 0 ? new RingGeometry(inner, radius, 40) : new CircleGeometry(radius, 40), this.material(colour, opacity));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(at[0], this.top, at[1]);
    mesh.renderOrder = order;
    this.group.add(mesh);
  }

  fill(corners: readonly Floor[], colour: number, opacity: number): void {
    const geometry = new BufferGeometry().setFromPoints(corners.map((corner) => new Vector3(corner[0], this.top, corner[1])));
    geometry.setIndex(corners.length === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3]);
    const mesh = new Mesh(geometry, this.material(colour, opacity));
    mesh.renderOrder = 13;
    this.group.add(mesh);
  }
}

function planScene(model: PlanPictureModel, weight: number, body: number, top: number): Scene {
  const scene = new Scene();
  scene.background = new Color(GROUND);
  const { cx, cz } = model.frame;
  const reach = Math.max(model.frame.halfW, model.frame.halfH) + 2;
  scene.add(new HemisphereLight(0xffffff, 0xc9c3b8, 1.5));
  // The Stage's key stands at (4.5, 7.5, 4). On the Plan it stands high, so a table's shadow is a
  // rim beside it and not a shape across the floor being read. It is placed about the view's own
  // centre: a set built away from the origin is lit, and shadowed, the same.
  const key = new DirectionalLight(0xffffff, 1.9);
  key.position.set(cx + 2.2, 9, cz + 1.8);
  key.target.position.set(cx, 0, cz);
  key.castShadow = true;
  Object.assign(key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.5, far: 40 + top });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0012;
  scene.add(key, key.target);
  // The Stage's 1 m grid, kept on whole metres wherever the set stands.
  const grid = new GridHelper(40, 40, 0x9a9187, 0xbdb6ac);
  const lines = grid.material as LineBasicMaterial;
  lines.transparent = true;
  lines.opacity = 0.5;
  grid.position.set(Math.round(cx), -0.03, Math.round(cz));
  scene.add(grid);
  scene.add(setGroup(model.sets, true));

  const over = new Overlay(top);
  for (const member of model.cast) {
    const figure = capsuleFigure(member.colour, member.seated);
    figure.position.set(member.x, 0, member.z);
    figure.rotation.y = rad(member.facing);
    scene.add(figure);
    const ring = 0.36 * weight;
    over.disc([member.x, member.z], ring, member.colour, 0.22, 8);
    over.disc([member.x, member.z], ring, member.colour, 1, 8, ring - 0.055 * weight);
    // A later mark is a ring with nobody on it yet.
    for (const mark of member.later) over.disc(mark, 0.3 * weight, member.colour, 1, 8, 0.3 * weight - 0.05 * weight);
    for (const walk of member.walks) over.dashed(walk, member.colour, 0.26, 0.16, 0.07 * weight);
  }
  // A pair's line between their marks, hatched on the side their cameras keep.
  for (const side of model.sides) {
    const [a, b] = side.line;
    over.ribbon(a, b, 0.035, INK, 0.55, 9);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const hatches = Math.max(3, Math.round(length / 0.32));
    for (let index = 0; index <= hatches; index += 1) {
      const at: Floor = [a[0] + ((b[0] - a[0]) * index) / hatches, a[1] + ((b[1] - a[1]) * index) / hatches];
      over.ribbon(at, [at[0] + side.keep[0] * 0.2, at[1] + side.keep[1] * 0.2], 0.03, INK, 0.55, 9);
    }
  }
  for (const position of model.positions) {
    const selected = position.n === model.selected;
    const warn = model.warn.includes(position.n);
    const colour = warn ? WARN : INK;
    const fill = selected ? 0.45 : warn ? 0.34 : 0.14;
    const stroke = selected || warn ? 1 : 0.75;
    const line = 0.045 * weight * (selected ? 1.8 : 1);
    const mark = planMark(position, model.aspect, 1);
    if (mark.kind === "frame") {
      // Looking straight down there is no wedge to draw, so the plan draws what the lens frames.
      over.fill(mark.corners, colour, fill);
      for (let index = 0; index < 4; index += 1) over.ribbon(mark.corners[index]!, mark.corners[(index + 1) % 4]!, line, colour, stroke, 14);
    } else {
      over.fill([mark.apex, mark.left, mark.right], colour, fill);
      over.ribbon(mark.apex, mark.left, line, colour, stroke, 14);
      over.ribbon(mark.apex, mark.right, line, colour, stroke, 14);
      over.ribbon(mark.left, mark.right, line, colour, stroke, 14);
      // Selected, its sight line runs on to what it looks at.
      if (selected) over.dashed([mark.tip, mark.aim], colour, 0.12, 0.12, 0.035);
    }
    over.disc(mark.apex, body, colour, 1, 15);
  }
  scene.add(over.group);
  return scene;
}

/** How high the set stands, so the camera and the overlay clear it whatever was built. */
function setTop(sets: readonly StagingSet[]): number {
  return sets.reduce((top, set) => Math.max(top, (set.y ?? 0) + set.h), 5);
}

function copy(source: HTMLCanvasElement, target: HTMLCanvasElement): void {
  const context = target.getContext("2d");
  if (context === null) return;
  context.clearRect(0, 0, target.width, target.height);
  context.drawImage(source, 0, 0, target.width, target.height);
}

/**
 * Draws the Plan into `canvas` at the canvas's own pixel size: the set from straight above through
 * an orthographic camera, the set's −z at the top. Null, and nothing drawn, where there is no WebGL.
 */
export function drawPlan(canvas: HTMLCanvasElement, model: PlanPictureModel, options: PlanPictureOptions = {}): HTMLCanvasElement | null {
  const gl = renderer();
  if (gl === null || canvas.width === 0 || canvas.height === 0) return null;
  const top = setTop(model.sets) + 1;
  const scene = planScene(model, options.weight ?? 1, options.body ?? 0.21, top);
  const { cx, cz, halfW, halfH } = model.frame;
  const camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, top + 60);
  camera.position.set(cx, top + 30, cz);
  camera.up.set(0, 0, -1);
  camera.lookAt(cx, 0, cz);
  try {
    gl.setSize(canvas.width, canvas.height, false);
    gl.render(scene, camera);
    copy(gl.domElement, canvas);
  } finally {
    discard(scene);
  }
  return canvas;
}

/**
 * A position's grey view: the set alone through the position's own lens, in Greybox, as a JPEG
 * data URL `width` pixels on its long side. No figures, no rigs, no labels, no grid. Null where
 * there is no WebGL.
 */
export function renderGreyView(sets: readonly StagingSet[], position: Pick<PlacePosition, "p" | "l" | "focalMm">, aspect: string, width = 1280): string | null {
  const gl = renderer();
  if (gl === null) return null;
  const ratio = parseAspect(aspect) ?? 16 / 9;
  const w = Math.round(ratio >= 1 ? width : width * ratio), h = Math.round(ratio >= 1 ? width / ratio : width);
  const scene = new Scene();
  scene.background = new Color(GROUND);
  scene.add(new HemisphereLight(0xffffff, 0xc9c3b8, 1.5));
  // The Stage's own key, about the set's centre so its shadows cover a set built off the origin.
  const bounds = planBounds(sets);
  const cx = (bounds.x0 + bounds.x1) / 2, cz = (bounds.z0 + bounds.z1) / 2;
  const reach = Math.max(9, (bounds.x1 - bounds.x0) / 2 + 2, (bounds.z1 - bounds.z0) / 2 + 2);
  const key = new DirectionalLight(0xffffff, 1.9);
  key.position.set(cx + 4.5, 7.5, cz + 4);
  key.target.position.set(cx, 0, cz);
  key.castShadow = true;
  Object.assign(key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.5, far: 40 + setTop(sets) });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0012;
  scene.add(key, key.target);
  scene.add(setGroup(sets, false));
  const camera = new PerspectiveCamera(stagingFov(`${position.focalMm}mm`, aspect), w / h, STAGE_CAMERA_NEAR, 200);
  // Straight down, the set's −z is the top of the picture, as it is on the plan.
  if (Math.hypot(position.l[0] - position.p[0], position.l[2] - position.p[2]) < 0.05) camera.up.set(0, 0, -1);
  camera.position.set(...position.p);
  camera.lookAt(new Vector3(...position.l));
  try {
    gl.setSize(w, h, false);
    gl.render(scene, camera);
    return gl.domElement.toDataURL("image/jpeg", 0.9);
  } finally {
    discard(scene);
  }
}
