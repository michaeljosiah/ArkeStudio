import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MOUSE,
  Object3D,
  OctahedronGeometry,
  OrthographicCamera,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RingGeometry,
  Scene,
  ShadowMaterial,
  SphereGeometry,
  Spherical,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  Box3,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { StagingKey, StagingSet } from "@arke-studio/contracts";

/**
 * The Stage viewport: one canvas, one renderer, two cameras, and the greybox previs of a shot
 * (the Stage guide, part 2). It owns three.js's per-frame mutable state and nothing else — the
 * React panel hands it a `StageData` snapshot and listens for the handful of events below; it
 * never reads application state.
 *
 * Ported from the design's `stage-viewport.js` with the four things the guide calls hard-won
 * kept exactly (camera-convention `lookAt` for the rig, `updateMatrixWorld` before every
 * raycast, LEFT taken off OrbitControls, a crash-proof loop) and three things the port fixes:
 * keys are sampled by their TIME rather than by index, so retiming a key on the track moves the
 * camera; a left drag on empty space orbits, which the prototype called and never defined; and
 * the lens is the production's aspect and the shot's real lens rather than a fixed 16:9 at 40°.
 */

export interface StageFigureData {
  sheetId: string;
  name: string;
  colour: number;
  x: number;
  z: number;
  to: readonly [number, number] | null;
  /** The previous shot's continuity ghost, drawn translucent and untouchable. */
  ghost: readonly [number, number] | null;
}

export interface StageData {
  cast: readonly StageFigureData[];
  sets: readonly StagingSet[];
  keys: readonly StagingKey[];
  /** Length of the shot, which is what the key times are measured against. */
  durationSec: number;
  active: number;
  mode: "look" | "camera";
  /** Playhead, seconds. */
  at: number;
  /** The lens: vertical field of view in degrees, and width over height. */
  fov: number;
  aspect: number;
  lensLabel: string;
}

export type StageSelection =
  | { kind: "rig" }
  | { kind: "aim" }
  | { kind: "cast"; sheetId: string }
  | { kind: "walkend"; sheetId: string }
  | null;

export interface StageEvents {
  /** The camera was moved at time `at`: insert-or-update a key there. `p` is relative to the key's anchor. */
  autokey(at: number, p: [number, number, number]): void;
  /** The aim target was moved at time `at`. */
  autoaim(at: number, l: [number, number, number]): void;
  castchange(sheetId: string, x: number, z: number): void;
  walkchange(sheetId: string, x: number, z: number): void;
  selchange(selection: StageSelection): void;
  /** A figure was double-clicked: lock the aim onto them. */
  trackpick(sheetId: string): void;
}

const PALETTE = [0x7a2e43, 0xb08c2e, 0x5f6b7a, 0x3f4a5a, 0x8a6a4f];
export function figureColour(index: number): number {
  return PALETTE[index % PALETTE.length]!;
}

const INK = 0x0a0a0a;
const aimMatrix = new Matrix4();
/** Orient a Group the way a CAMERA would: -Z toward the target. `Object3D.lookAt` aims +Z. */
function aimAt(group: Object3D, target: Vector3): void {
  aimMatrix.lookAt(group.position, target, Object3D.DEFAULT_UP);
  group.quaternion.setFromRotationMatrix(aimMatrix);
}
const v3 = (a: readonly [number, number, number]): Vector3 => new Vector3(a[0], a[1], a[2]);
const noPick = () => {};

function selectionRing(radius: number): Mesh {
  const ring = new Mesh(
    new RingGeometry(radius, radius + 0.035, 40),
    new MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.8, side: DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.raycast = noPick;
  return ring;
}

function segment(line: Line, a: Vector3, b: Vector3): void {
  const position = line.geometry.attributes["position"] as BufferAttribute;
  position.setXYZ(0, a.x, a.y, a.z);
  position.setXYZ(1, b.x, b.y, b.z);
  position.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}

function lineBetween(a: Vector3, b: Vector3, material: LineBasicMaterial): Line {
  const line = new Line(new BufferGeometry().setFromPoints([a.clone(), b.clone()]), material);
  line.raycast = noPick;
  return line;
}

/** A neutral capsule figure: head, torso, arms, legs. Greybox, never a render. */
function figure(colour: number, ghost: boolean): Group {
  const group = new Group();
  const skin = new MeshStandardMaterial({ color: 0x8c837a, roughness: 0.85, metalness: 0 });
  const cloth = new MeshStandardMaterial({ color: colour, roughness: 0.78, metalness: 0 });
  if (ghost) {
    for (const material of [skin, cloth]) {
      material.transparent = true;
      material.opacity = 0.18;
    }
  }
  const head = new Mesh(new SphereGeometry(0.14, 24, 18), skin);
  head.position.y = 1.62;
  group.add(head);
  const torso = new Mesh(new CapsuleGeometry(0.17, 0.46, 6, 18), cloth);
  torso.position.y = 1.16;
  group.add(torso);
  for (const side of [-1, 1]) {
    const arm = new Mesh(new CapsuleGeometry(0.052, 0.48, 4, 12), skin);
    arm.position.set(side * 0.235, 1.14, 0);
    group.add(arm);
    const leg = new Mesh(new CapsuleGeometry(0.075, 0.56, 4, 12), cloth);
    leg.position.set(side * 0.095, 0.44, 0);
    group.add(leg);
  }
  group.traverse((object) => {
    if ((object as Mesh).isMesh) {
      object.castShadow = !ghost;
      object.receiveShadow = !ghost;
    }
  });
  return group;
}

/** The camera body with a wireframe cone generated from the real lens. */
function rig(fov: number, aspect: number): Group {
  const group = new Group();
  const body = new Mesh(new BoxGeometry(0.3, 0.2, 0.38), new MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.5 }));
  group.add(body);
  const edge = new LineSegments(new EdgesGeometry(new BoxGeometry(0.3, 0.2, 0.38)), new LineBasicMaterial({ color: 0xffffff }));
  edge.raycast = noPick;
  group.add(edge);
  const d = 1.5;
  const h = d * Math.tan(MathUtils.degToRad(fov) / 2);
  const w = h * aspect;
  const corners = [
    [-w, h, -d],
    [w, h, -d],
    [w, -h, -d],
    [-w, -h, -d],
  ];
  const points: Vector3[] = [];
  for (const corner of corners) points.push(new Vector3(0, 0, 0), new Vector3(...(corner as [number, number, number])));
  for (let index = 0; index < 4; index += 1) {
    points.push(
      new Vector3(...(corners[index] as [number, number, number])),
      new Vector3(...(corners[(index + 1) % 4] as [number, number, number])),
    );
  }
  const frustum = new LineSegments(
    new BufferGeometry().setFromPoints(points),
    new LineBasicMaterial({ color: INK, transparent: true, opacity: 0.85 }),
  );
  frustum.raycast = noPick;
  group.add(frustum);
  return group;
}

function aimMarker(): Group {
  const group = new Group();
  const ring = new Mesh(new TorusGeometry(0.17, 0.022, 10, 32), new MeshBasicMaterial({ color: INK }));
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  group.add(new Mesh(new SphereGeometry(0.05, 14, 10), new MeshBasicMaterial({ color: INK })));
  const stem = new Line(
    new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, -1, 0)]),
    new LineBasicMaterial({ color: INK, transparent: true, opacity: 0.3 }),
  );
  stem.raycast = noPick;
  group.add(stem);
  group.add(new Mesh(new SphereGeometry(0.28, 10, 8), new MeshBasicMaterial({ visible: false })));
  return group;
}

interface PickTag {
  pick: "rig" | "aim" | "cast" | "walkend";
  sheetId?: string;
}

interface CamRefs {
  rig: Group;
  stem: Line;
  foot: Mesh;
  ring: Mesh | null;
  tether: Line | null;
}

interface AimRefs {
  marker: Group;
  sight: Line;
  ring: Mesh | null;
}

const PATH_POINTS = 60;

export class StageViewport {
  private readonly host: HTMLElement;
  private readonly events: StageEvents;
  private readonly scene = new Scene();
  private readonly renderer: WebGLRenderer;
  private readonly view = new PerspectiveCamera(38, 1, 0.1, 200);
  private readonly shot: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly transform: TransformControls;
  private readonly transformHelper: Object3D;
  private readonly proxy = new Object3D();
  private readonly castGroup = new Group();
  private readonly setGroup = new Group();
  private readonly rigGroup = new Group();
  private readonly ray = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly overlay: HTMLDivElement;
  private readonly pip: HTMLDivElement;
  private readonly pipCaption: HTMLSpanElement;
  private readonly gizmo: { scene: Scene; camera: OrthographicCamera; renderer: WebGLRenderer; knobs: Mesh[] };
  private readonly resize: ResizeObserver | null;
  private labels: Array<{ element: HTMLDivElement; object: Object3D; up: number }> = [];
  private walkers: Group[] = [];
  private aids: Object3D[] = [];
  private setMeshes: Mesh[] = [];
  private cam: CamRefs | null = null;
  private aim: AimRefs | null = null;
  private path: Line | null = null;
  private marks: Array<{ index: number; mesh: Mesh }> = [];
  private data: StageData;
  private structure = "";
  private selection: StageSelection = null;
  private framed = false;
  private proxyLive = false;
  private liveAim: Vector3 | null = null;
  private recordingAt: number | null = null;
  private raf = 0;
  private warned = false;
  private disposed = false;

  constructor(host: HTMLElement, data: StageData, events: StageEvents) {
    this.host = host;
    this.events = events;
    this.data = data;
    host.style.position = "relative";
    host.style.cursor = "grab";

    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.view.position.set(4.4, 3.1, 6.4);
    this.shot = new PerspectiveCamera(data.fov, data.aspect, 0.1, 200);

    const controls = new OrbitControls(this.view, renderer.domElement);
    // LEFT must be null, not a preference: with LEFT bound to ROTATE, OrbitControls takes pointer
    // capture before any selection code runs, and stopPropagation cannot reach it.
    controls.mouseButtons = { LEFT: null, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.PAN };
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.target.set(0, 0.9, 0);
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 2.2;
    controls.maxDistance = 22;
    this.controls = controls;

    this.scene.add(new HemisphereLight(0xffffff, 0xc9c3b8, 1.5));
    const key = new DirectionalLight(0xffffff, 1.9);
    key.position.set(4.5, 7.5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.top = key.shadow.camera.right = 9;
    key.shadow.camera.bottom = key.shadow.camera.left = -9;
    key.shadow.bias = -0.0012;
    this.scene.add(key);
    const floor = new Mesh(new PlaneGeometry(60, 60), new ShadowMaterial({ opacity: 0.17 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new GridHelper(40, 40, 0x9a9187, 0xbdb6ac);
    (grid.material as LineBasicMaterial).transparent = true;
    (grid.material as LineBasicMaterial).opacity = 0.5;
    this.scene.add(grid);
    this.scene.add(this.castGroup, this.setGroup, this.rigGroup, this.proxy);

    this.ray.params.Line.threshold = 0.02;

    const transform = new TransformControls(this.view, renderer.domElement);
    transform.setSize(0.72);
    transform.setSpace("world");
    transform.addEventListener("dragging-changed", (event) => {
      this.controls.enabled = !event.value;
      if (!event.value) this.commitProxy();
    });
    transform.addEventListener("objectChange", () => this.liveProxy());
    this.transform = transform;
    this.transformHelper = transform.getHelper();
    this.transformHelper.visible = false;
    this.scene.add(this.transformHelper);

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    host.appendChild(overlay);
    this.overlay = overlay;
    const pip = document.createElement("div");
    pip.className = "fy-swstage__pip";
    pip.style.cssText = "position:absolute;pointer-events:none;opacity:0";
    const caption = document.createElement("span");
    pip.appendChild(caption);
    overlay.appendChild(pip);
    this.pip = pip;
    this.pipCaption = caption;

    renderer.domElement.addEventListener("pointerdown", (event) => {
      if (event.button === 0) this.down(event);
    });
    renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());
    renderer.domElement.addEventListener("dblclick", (event) => {
      // A recording reads the data the panel holds; a track picked mid-take would change the
      // active key under it and file a take of two stagings under one version.
      if (this.recordingAt !== null) return;
      this.track(event);
    });
    renderer.domElement.addEventListener("pointermove", (event) => {
      if (this.transform.dragging || this.data.mode === "camera") return;
      const hit = this.probe(event);
      host.style.cursor = hit === null ? "grab" : this.isSelected(hit) ? "grab" : "pointer";
    });

    this.gizmo = this.makeGizmo();
    this.resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.size());
    this.resize?.observe(host);

    this.build();
    this.size();
    this.loop();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resize?.disconnect();
    this.transform.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.gizmo.renderer.dispose();
    this.host.replaceChildren();
  }

  /** New attributes from the panel. Geometry is rebuilt only when the structure changed. */
  set(data: StageData): void {
    const previous = this.data;
    this.data = data;
    if (data.fov !== this.shot.fov || data.aspect !== this.shot.aspect) {
      this.shot.fov = data.fov;
      this.shot.aspect = data.aspect;
      this.shot.updateProjectionMatrix();
    }
    const structure = JSON.stringify([data.cast, data.sets, data.keys, data.active, data.fov, data.aspect]);
    if (this.transform.dragging) return;
    if (structure !== this.structure) {
      const castChanged = previous.cast.map((c) => c.sheetId).join("|") !== data.cast.map((c) => c.sheetId).join("|");
      this.build();
      if (castChanged) {
        this.framed = false;
        this.frame();
      }
    } else if (data.mode !== previous.mode) {
      this.attachGizmo();
    }
  }

  /** Select from outside — the panel's readouts and the viewport agree on what is picked. */
  select(selection: StageSelection): void {
    this.selection = selection;
    this.build();
  }

  private size(): void {
    const width = this.host.clientWidth || 1;
    const height = this.host.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.view.aspect = width / height;
    this.view.updateProjectionMatrix();
    if (this.framed) this.frame();
  }

  /** Fit the orbit camera around everything on stage. */
  frame(): void {
    const box = new Box3();
    for (const group of [this.castGroup, this.setGroup]) if (group.children.length > 0) box.expandByObject(group);
    if (this.cam !== null) box.expandByPoint(this.cam.rig.position);
    if (this.aim !== null) box.expandByPoint(this.aim.marker.position);
    if (box.isEmpty()) return;
    box.expandByScalar(0.6);
    const centre = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const vertical = MathUtils.degToRad(this.view.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.view.aspect);
    const distance =
      Math.max(size.y / 2 / Math.tan(vertical / 2), size.x / 2 / Math.tan(horizontal / 2), size.z / 2 / Math.tan(horizontal / 2)) * 1.12;
    const direction = new Vector3(0.62, 0.42, 1).normalize();
    this.controls.target.set(centre.x, Math.max(0.85, centre.y * 0.72), centre.z);
    this.view.position.copy(this.controls.target).addScaledVector(direction, Math.max(3.2, distance));
    this.controls.maxDistance = Math.max(22, distance * 3);
    this.view.far = Math.max(200, distance * 8);
    this.view.updateProjectionMatrix();
    this.controls.update();
    this.framed = true;
  }

  private clear(group: Group): void {
    while (group.children.length > 0) {
      const child = group.children.pop()!;
      child.traverse((object) => {
        const mesh = object as Mesh;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material === undefined ? [] : [mesh.material];
        for (const material of materials) material.dispose();
      });
    }
  }

  private build(): void {
    const data = this.data;
    this.structure = JSON.stringify([data.cast, data.sets, data.keys, data.active, data.fov, data.aspect]);
    this.clear(this.castGroup);
    this.clear(this.setGroup);
    this.clear(this.rigGroup);
    this.setMeshes = [];
    this.walkers = [];
    this.aids = [];
    this.marks = [];
    this.cam = null;
    this.aim = null;
    this.path = null;

    for (const set of data.sets) {
      const box = new Mesh(
        new BoxGeometry(set.w, set.h, set.d),
        new MeshStandardMaterial({ color: 0xa79e93, roughness: 0.95, transparent: true, opacity: 0.22 }),
      );
      box.position.set(set.x, set.h / 2, set.z);
      box.receiveShadow = true;
      box.userData = { label: set.name, up: set.h / 2 + 0.28 };
      this.setGroup.add(box);
      this.setMeshes.push(box);
      const edges = new LineSegments(
        new EdgesGeometry(box.geometry),
        new LineBasicMaterial({ color: 0x9a9187, transparent: true, opacity: 0.6 }),
      );
      edges.position.copy(box.position);
      this.setGroup.add(edges);
    }

    for (const member of data.cast) {
      const from = new Vector3(member.x, 0, member.z);
      const to = member.to === null ? null : new Vector3(member.to[0], 0, member.to[1]);
      const walker = figure(member.colour, false);
      walker.position.copy(from);
      walker.userData = { pick: "cast", sheetId: member.sheetId, name: member.name, from: from.clone(), to: to?.clone() ?? null } satisfies PickTag & Record<string, unknown>;
      this.castGroup.add(walker);
      this.walkers.push(walker);
      if (this.isSelected({ kind: "cast", sheetId: member.sheetId })) {
        const ring = selectionRing(0.34);
        ring.position.set(from.x, 0.015, from.z);
        this.castGroup.add(ring);
        walker.userData["ring"] = ring;
        this.aids.push(ring);
      }
      if (to !== null) {
        const end = figure(member.colour, true);
        end.position.copy(to);
        end.userData = { pick: "walkend", sheetId: member.sheetId } satisfies PickTag;
        this.castGroup.add(end);
        this.aids.push(end);
        if (this.isSelected({ kind: "walkend", sheetId: member.sheetId })) {
          const ring = selectionRing(0.34);
          ring.position.set(to.x, 0.015, to.z);
          this.castGroup.add(ring);
          this.aids.push(ring);
        }
        const direction = to.clone().sub(from);
        if (direction.length() > 0.05) {
          const unit = direction.clone().normalize();
          const tip = to.clone().sub(unit.clone().multiplyScalar(0.18));
          const side = new Vector3(-unit.z, 0, unit.x).multiplyScalar(0.12);
          const walk = new Line(
            new BufferGeometry().setFromPoints([
              from.clone().setY(0.02),
              to.clone().setY(0.02),
              tip.clone().setY(0.02).add(side),
              to.clone().setY(0.02),
              tip.clone().setY(0.02).sub(side),
              to.clone().setY(0.02),
            ]),
            new LineDashedMaterial({ color: 0x5f6b7a, dashSize: 0.18, gapSize: 0.1, transparent: true, opacity: 0.55 }),
          );
          walk.computeLineDistances();
          walk.raycast = noPick;
          this.castGroup.add(walk);
          this.aids.push(walk);
        }
      } else if (member.ghost !== null) {
        const ghost = figure(member.colour, true);
        ghost.position.set(member.ghost[0], 0, member.ghost[1]);
        ghost.traverse((object) => {
          object.raycast = noPick;
        });
        this.castGroup.add(ghost);
        this.aids.push(ghost);
      }
    }

    const at = this.clampAt(data.at);
    if (data.keys.length > 0) {
      const position = this.sampleCam(at, at);
      const look = this.sampleAim(at, at);
      const body = rig(data.fov, data.aspect);
      body.position.copy(position);
      aimAt(body, look);
      body.userData = { pick: "rig" } satisfies PickTag;
      // The lens IS the rig: a child at local origin, identity rotation, so they cannot diverge.
      body.add(this.shot);
      this.shot.position.set(0, 0, 0);
      this.shot.rotation.set(0, 0, 0);
      this.rigGroup.add(body);
      const stem = lineBetween(new Vector3(position.x, 0, position.z), position, new LineBasicMaterial({ color: INK, transparent: true, opacity: 0.3 }));
      this.rigGroup.add(stem);
      const foot = new Mesh(new RingGeometry(0.06, 0.1, 18), new MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.45, side: DoubleSide }));
      foot.rotation.x = -Math.PI / 2;
      foot.position.set(position.x, 0.01, position.z);
      foot.raycast = noPick;
      this.rigGroup.add(foot);
      let ring: Mesh | null = null;
      if (this.isSelected({ kind: "rig" })) {
        ring = selectionRing(0.3);
        ring.position.set(position.x, 0.015, position.z);
        this.rigGroup.add(ring);
      }
      let tether: Line | null = null;
      const anchor = this.keyAt(at).anchor;
      const subject = anchor === undefined ? null : this.subjectAt(anchor, at);
      if (subject !== null) {
        tether = lineBetween(position, subject.clone().setY(1.1), new LineBasicMaterial({ color: 0x4a6e96, transparent: true, opacity: 0.4 }));
        this.rigGroup.add(tether);
      }
      this.cam = { rig: body, stem, foot, ring, tether };

      const marker = aimMarker();
      marker.position.copy(look);
      marker.userData = { pick: "aim" } satisfies PickTag;
      this.rigGroup.add(marker);
      let aimRing: Mesh | null = null;
      if (this.isSelected({ kind: "aim" })) {
        aimRing = selectionRing(0.26);
        aimRing.position.set(look.x, 0.015, look.z);
        this.rigGroup.add(aimRing);
      }
      const sight = lineBetween(position, look, new LineBasicMaterial({ color: INK, transparent: true, opacity: 0.28 }));
      this.rigGroup.add(sight);
      this.aim = { marker, sight, ring: aimRing };
    }

    if (data.keys.length > 1) {
      const line = new Line(
        new BufferGeometry().setAttribute("position", new Float32BufferAttribute(new Float32Array(PATH_POINTS * 3), 3)),
        new LineBasicMaterial({ color: INK, transparent: true, opacity: 0.38 }),
      );
      line.raycast = noPick;
      this.rigGroup.add(line);
      this.path = line;
      data.keys.forEach((key, index) => {
        const on = index === data.active;
        const mesh = new Mesh(new OctahedronGeometry(on ? 0.075 : 0.055), new MeshBasicMaterial({ color: on ? INK : 0xffffff }));
        const edge = new LineSegments(
          new EdgesGeometry(new OctahedronGeometry(on ? 0.075 : 0.055)),
          new LineBasicMaterial({ color: INK, transparent: true, opacity: on ? 1 : 0.5 }),
        );
        mesh.add(edge);
        mesh.position.copy(this.keyWorld(key, at));
        mesh.raycast = noPick;
        edge.raycast = noPick;
        this.rigGroup.add(mesh);
        this.marks.push({ index, mesh });
      });
      this.drawPath();
    }

    this.buildLabels();
    this.attachGizmo();
    if (!this.framed && this.host.clientWidth > 0) this.frame();
  }

  private makeGizmo() {
    const mount = document.createElement("div");
    mount.className = "fy-swstage__gizmo";
    mount.style.cssText = "position:absolute;right:10px;bottom:10px;width:62px;height:62px;pointer-events:auto";
    this.host.appendChild(mount);
    const scene = new Scene();
    const camera = new OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
    camera.position.set(0, 0, 5);
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.cssText = "display:block;cursor:pointer;width:62px;height:62px";
    renderer.setSize(62, 62, false);
    mount.appendChild(renderer.domElement);
    const knobs: Mesh[] = [];
    const axes = [
      { v: new Vector3(1, 0, 0), c: 0xb4553f },
      { v: new Vector3(0, 1, 0), c: 0x5c8551 },
      { v: new Vector3(0, 0, 1), c: 0x4a6e96 },
    ];
    for (const axis of axes) {
      for (const sign of [1, -1]) {
        const at = axis.v.clone().multiplyScalar(sign * 1.05);
        scene.add(
          new Line(
            new BufferGeometry().setFromPoints([new Vector3(), at]),
            new LineBasicMaterial({ color: axis.c, transparent: true, opacity: sign > 0 ? 0.95 : 0.35 }),
          ),
        );
        const knob = new Mesh(new SphereGeometry(0.28, 16, 12), new MeshBasicMaterial({ color: axis.c, transparent: true, opacity: sign > 0 ? 1 : 0.4 }));
        knob.position.copy(at);
        knob.userData = { direction: axis.v.clone().multiplyScalar(sign) };
        scene.add(knob);
        knobs.push(knob);
      }
    }
    const ray = new Raycaster();
    const point = new Vector2();
    renderer.domElement.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      const bounds = renderer.domElement.getBoundingClientRect();
      point.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
      ray.setFromCamera(point, camera);
      const hit = ray.intersectObjects(knobs)[0];
      if (hit === undefined) return;
      const distance = this.view.position.distanceTo(this.controls.target);
      const direction = hit.object.userData["direction"] as Vector3;
      this.view.position.copy(this.controls.target).addScaledVector(direction, distance);
      // Straight down has no stable up vector; a hair of z keeps the horizon predictable.
      if (Math.abs(direction.y) > 0.9) this.view.position.z += 0.001;
      this.controls.update();
    });
    return { scene, camera, renderer, knobs };
  }

  private canvasPoint(event: PointerEvent | MouseEvent): void {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.view);
  }

  /** World matrices refresh on render; a pick between a rebuild and the next frame needs them now. */
  private syncPick(): void {
    this.rigGroup.updateMatrixWorld(true);
    this.castGroup.updateMatrixWorld(true);
  }

  private tagOf(object: Object3D | null): (PickTag & { name?: string }) | null {
    let current: Object3D | null = object;
    while (current !== null && current.userData["pick"] === undefined) current = current.parent;
    return current === null ? null : (current.userData as PickTag & { name?: string });
  }

  private probe(event: PointerEvent): StageSelection {
    this.syncPick();
    this.canvasPoint(event);
    const hits = this.ray.intersectObjects([...this.rigGroup.children, ...this.castGroup.children], true);
    for (const hit of hits) {
      const tag = this.tagOf(hit.object);
      if (tag === null) continue;
      return tag.pick === "rig" || tag.pick === "aim" ? { kind: tag.pick } : { kind: tag.pick, sheetId: tag.sheetId! };
    }
    return null;
  }

  private isSelected(candidate: StageSelection): boolean {
    const current = this.selection;
    if (current === null || candidate === null || current.kind !== candidate.kind) return false;
    return current.kind === "rig" || current.kind === "aim" || (current as { sheetId: string }).sheetId === (candidate as { sheetId: string }).sheetId;
  }

  private down(event: PointerEvent): void {
    // While the playblast records, the scene is the one being filed: nothing may move it.
    if (this.recordingAt !== null) return;
    // A press on a gizmo arrow is the gizmo's: it hovers the axis before the press lands, and a
    // pick or an orbit started underneath it would fight the drag for the same pointer.
    if (this.transform.dragging || this.transform.axis !== null) return;
    if (this.data.mode === "camera") {
      this.lookAround(event);
      return;
    }
    this.syncPick();
    this.canvasPoint(event);
    const rigHits = this.ray.intersectObjects(this.rigGroup.children, true);
    // The aim marker wins ties against the rig body, then anything else in the rig group.
    const first = (list: typeof rigHits, want?: PickTag["pick"]) => {
      for (const hit of list) {
        const tag = this.tagOf(hit.object);
        if (tag !== null && (want === undefined || tag.pick === want)) return tag;
      }
      return null;
    };
    const tag = first(rigHits, "aim") ?? first(rigHits) ?? first(this.ray.intersectObjects(this.castGroup.children, true));
    if (tag === null) {
      this.orbitDrag(event);
      return;
    }
    this.selection = tag.pick === "rig" || tag.pick === "aim" ? { kind: tag.pick } : { kind: tag.pick, sheetId: tag.sheetId! };
    this.events.selchange(this.selection);
    this.build();
  }

  /** A left drag on empty space orbits — by hand, since the left button is off OrbitControls. */
  private orbitDrag(event: PointerEvent): void {
    const startX = event.clientX;
    const startY = event.clientY;
    const width = this.renderer.domElement.clientWidth || 1;
    const offset = this.view.position.clone().sub(this.controls.target);
    const start = new Spherical().setFromVector3(offset);
    let moved = false;
    const move = (next: PointerEvent) => {
      const dx = next.clientX - startX;
      const dy = next.clientY - startY;
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      moved = true;
      const spherical = new Spherical(start.radius, start.phi, start.theta);
      spherical.theta = start.theta - (dx / width) * Math.PI * 1.6;
      spherical.phi = Math.max(0.08, Math.min(this.controls.maxPolarAngle, start.phi - (dy / width) * Math.PI));
      this.view.position.copy(this.controls.target).add(new Vector3().setFromSpherical(spherical));
      this.controls.update();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.host.style.cursor = "grab";
    };
    this.host.style.cursor = "grabbing";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Camera mode: drag to pan and tilt from where the camera stands, then write the aim key. */
  private lookAround(event: PointerEvent): void {
    if (this.data.keys.length === 0 || this.cam === null || this.aim === null) return;
    const at = this.clampAt(this.data.at);
    const position = this.sampleCam(at, at);
    const direction = this.sampleAim(at, at).sub(position);
    const length = direction.length() || 1;
    const startX = event.clientX;
    const startY = event.clientY;
    const width = this.renderer.domElement.clientWidth || 1;
    let moved = false;
    const move = (next: PointerEvent) => {
      const dx = next.clientX - startX;
      const dy = next.clientY - startY;
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      moved = true;
      this.proxyLive = true;
      const spherical = new Spherical().setFromVector3(direction);
      spherical.theta -= (dx / width) * Math.PI;
      spherical.phi = Math.max(0.12, Math.min(Math.PI - 0.12, spherical.phi + (dy / width) * Math.PI));
      spherical.radius = length;
      const aim = position.clone().add(new Vector3().setFromSpherical(spherical));
      aimAt(this.cam!.rig, aim);
      this.aim!.marker.position.copy(aim);
      this.liveAim = aim;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.host.style.cursor = "grab";
      this.proxyLive = false;
      if (!moved || this.liveAim === null) return;
      this.events.autoaim(at, this.relative(this.liveAim, at));
      this.liveAim = null;
    };
    this.host.style.cursor = "grabbing";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private track(event: MouseEvent): void {
    this.syncPick();
    this.canvasPoint(event);
    for (const hit of this.ray.intersectObjects(this.castGroup.children, true)) {
      const tag = this.tagOf(hit.object);
      if (tag !== null && tag.pick === "cast" && tag.sheetId !== undefined) {
        this.events.trackpick(tag.sheetId);
        return;
      }
    }
  }

  private attachGizmo(): void {
    const selection = this.selection;
    if (selection === null || this.data.mode === "camera") {
      this.transform.detach();
      this.transformHelper.visible = false;
      return;
    }
    const at = this.clampAt(this.data.at);
    let position: Vector3 | null = null;
    if (selection.kind === "rig") position = this.sampleCam(at, at);
    else if (selection.kind === "aim") position = this.sampleAim(at, at);
    else {
      const walker = this.walkers.find((candidate) => candidate.userData["sheetId"] === selection.sheetId);
      if (walker !== undefined) {
        position = selection.kind === "cast" ? walker.position.clone() : ((walker.userData["to"] as Vector3 | null) ?? walker.position).clone();
      }
    }
    if (position === null) {
      this.transform.detach();
      this.transformHelper.visible = false;
      return;
    }
    this.proxy.position.copy(position);
    this.transform.attach(this.proxy);
    this.transformHelper.visible = true;
    // Figures stay on the floor; only the camera and its aim have a height to drag.
    this.transform.showY = selection.kind === "rig" || selection.kind === "aim";
  }

  private liveProxy(): void {
    const selection = this.selection;
    if (selection === null) return;
    const p = this.proxy.position;
    if (selection.kind === "cast" || selection.kind === "walkend") {
      p.y = 0;
      return;
    }
    p.y = Math.max(0.15, Math.min(9, p.y));
    this.proxyLive = true;
    if (selection.kind === "rig" && this.cam !== null && this.aim !== null) {
      this.cam.rig.position.copy(p);
      aimAt(this.cam.rig, this.aim.marker.position);
      segment(this.cam.stem, new Vector3(p.x, 0, p.z), p);
      this.cam.foot.position.set(p.x, 0.01, p.z);
      segment(this.aim.sight, p, this.aim.marker.position);
    } else if (selection.kind === "aim" && this.aim !== null) {
      this.aim.marker.position.copy(p);
      if (this.cam !== null) {
        aimAt(this.cam.rig, p);
        segment(this.aim.sight, this.cam.rig.position, p);
      }
    }
  }

  private commitProxy(): void {
    const selection = this.selection;
    if (selection === null) return;
    this.proxyLive = false;
    const at = this.clampAt(this.data.at);
    const p = this.proxy.position.clone();
    const rounded = (value: number) => Math.round(value * 100) / 100;
    if (selection.kind === "cast") {
      this.events.castchange(selection.sheetId, rounded(p.x), rounded(p.z));
      return;
    }
    if (selection.kind === "walkend") {
      this.events.walkchange(selection.sheetId, rounded(p.x), rounded(p.z));
      return;
    }
    const relative = this.relative(p, at);
    if (selection.kind === "rig") this.events.autokey(at, relative);
    else this.events.autoaim(at, relative);
  }

  /** A world point expressed the way the key at `at` stores it: an offset, when anchored. */
  private relative(point: Vector3, at: number): [number, number, number] {
    const key = this.keyAt(at);
    const p = point.clone();
    if (key.anchor !== undefined) {
      const subject = this.subjectAt(key.anchor, at);
      if (subject !== null) p.sub(subject);
    }
    return [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100];
  }

  private label(text: string, strong: boolean): HTMLDivElement {
    const element = document.createElement("div");
    element.className = strong ? "fy-swstage__label fy-swstage__label--camera" : "fy-swstage__label";
    element.style.cssText = "position:absolute;transform:translate(-50%,-50%);white-space:nowrap;opacity:0";
    element.textContent = text;
    this.overlay.appendChild(element);
    return element;
  }

  private buildLabels(): void {
    for (const entry of this.labels) entry.element.remove();
    this.labels = [];
    for (const walker of this.walkers) {
      this.labels.push({ element: this.label(walker.userData["name"] as string, false), object: walker, up: 1.95 });
    }
    for (const mesh of this.setMeshes) {
      this.labels.push({ element: this.label(mesh.userData["label"] as string, false), object: mesh, up: mesh.userData["up"] as number });
    }
    if (this.cam !== null) this.labels.push({ element: this.label("CAMERA", true), object: this.cam.rig, up: 0.34 });
  }

  private drawLabels(lens: boolean): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    const point = new Vector3();
    for (const entry of this.labels) {
      if (lens || entry.object.parent === null) {
        entry.element.style.opacity = "0";
        continue;
      }
      entry.object.getWorldPosition(point);
      point.y += entry.up;
      point.project(this.view);
      if (point.z > 1) {
        entry.element.style.opacity = "0";
        continue;
      }
      entry.element.style.opacity = "1";
      entry.element.style.left = `${((point.x * 0.5 + 0.5) * width).toFixed(1)}px`;
      entry.element.style.top = `${((-point.y * 0.5 + 0.5) * height).toFixed(1)}px`;
    }
  }

  private clampAt(at: number): number {
    return Math.max(0, Math.min(this.data.durationSec, at));
  }

  /** The key nearest the playhead — what a new key inherits its aim and anchor from. */
  private keyAt(at: number): StagingKey {
    const keys = this.data.keys;
    let best = keys[0]!;
    for (const key of keys) if (Math.abs(key.t - at) < Math.abs(best.t - at)) best = key;
    return best;
  }

  /** The pair of keys around `at` and the mix between them, by time, never by index. */
  private span(at: number): { a: StagingKey; b: StagingKey; k: number } {
    const keys = this.data.keys;
    if (keys.length === 1) return { a: keys[0]!, b: keys[0]!, k: 0 };
    let index = 0;
    while (index < keys.length - 2 && keys[index + 1]!.t <= at) index += 1;
    const a = keys[index]!;
    const b = keys[index + 1]!;
    const k = b.t === a.t ? 0 : Math.max(0, Math.min(1, (at - a.t) / (b.t - a.t)));
    return { a, b, k };
  }

  /** Camera position at path time `s`, with anchored subjects evaluated at `clock`. */
  private sampleCam(s: number, clock: number): Vector3 {
    const { a, b, k } = this.span(s);
    return this.keyWorld(a, clock).lerp(this.keyWorld(b, clock), k);
  }

  private sampleAim(s: number, clock: number): Vector3 {
    const { a, b, k } = this.span(s);
    return this.keyLook(a, clock).lerp(this.keyLook(b, clock), k);
  }

  private subjectAt(sheetId: string, at: number): Vector3 | null {
    const walker = this.walkers.find((candidate) => candidate.userData["sheetId"] === sheetId);
    if (walker === undefined) return null;
    const from = walker.userData["from"] as Vector3;
    const to = walker.userData["to"] as Vector3 | null;
    if (to === null) return from.clone();
    return from.clone().lerp(to, this.data.durationSec === 0 ? 0 : Math.max(0, Math.min(1, at / this.data.durationSec)));
  }

  private keyWorld(key: StagingKey, at: number): Vector3 {
    const p = v3(key.p);
    if (key.anchor === undefined) return p;
    const subject = this.subjectAt(key.anchor, at);
    return subject === null ? p : p.add(subject);
  }

  private keyLook(key: StagingKey, at: number): Vector3 {
    if (key.track !== undefined) {
      const subject = this.subjectAt(key.track, at);
      if (subject !== null) return subject.setY(key.l[1]);
    }
    const l = v3(key.l);
    if (key.anchor === undefined) return l;
    const subject = this.subjectAt(key.anchor, at);
    return subject === null ? l : l.add(subject);
  }

  /** The true animated path: anchored keys curve around their subject rather than joining dots. */
  private drawPath(): void {
    if (this.path === null || this.data.keys.length < 2) return;
    const position = this.path.geometry.attributes["position"] as BufferAttribute;
    for (let index = 0; index < PATH_POINTS; index += 1) {
      // Each sample resolves its anchor at ITS OWN time: a camera riding a walker crosses the
      // set with them, and a path clocked to the playhead would draw that ride as one point.
      const t = (index / (PATH_POINTS - 1)) * this.data.durationSec;
      const point = this.sampleCam(t, t);
      position.setXYZ(index, point.x, point.y, point.z);
    }
    position.needsUpdate = true;
    this.path.geometry.computeBoundingSphere();
  }

  /** Per-frame: move what exists. No geometry is created here. */
  private refresh(at: number): void {
    if (this.proxyLive) return;
    for (const walker of this.walkers) {
      const from = walker.userData["from"] as Vector3;
      const to = walker.userData["to"] as Vector3 | null;
      if (to === null) continue;
      walker.position.copy(from).lerp(to, this.data.durationSec === 0 ? 0 : at / this.data.durationSec);
      const ring = walker.userData["ring"] as Mesh | undefined;
      ring?.position.set(walker.position.x, 0.015, walker.position.z);
      const direction = to.clone().sub(from);
      if (direction.lengthSq() > 0.0025) walker.rotation.y = Math.atan2(direction.x, direction.z);
    }
    if (this.cam !== null && this.data.keys.length > 0) {
      const position = this.sampleCam(at, at);
      const look = this.sampleAim(at, at);
      this.cam.rig.position.copy(position);
      aimAt(this.cam.rig, look);
      segment(this.cam.stem, new Vector3(position.x, 0, position.z), position);
      this.cam.foot.position.set(position.x, 0.01, position.z);
      this.cam.ring?.position.set(position.x, 0.015, position.z);
      if (this.cam.tether !== null) {
        const anchor = this.keyAt(at).anchor;
        const subject = anchor === undefined ? null : this.subjectAt(anchor, at);
        if (subject !== null) segment(this.cam.tether, position, subject.setY(1.1));
      }
      if (this.aim !== null) {
        this.aim.marker.position.copy(look);
        this.aim.ring?.position.set(look.x, 0.015, look.z);
        segment(this.aim.sight, position, look);
      }
    }
    for (const mark of this.marks) {
      const key = this.data.keys[mark.index];
      if (key !== undefined) mark.mesh.position.copy(this.keyWorld(key, at));
    }
    this.drawPath();
  }

  private loop(): void {
    if (this.disposed) return;
    try {
      this.frameBody();
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn("stage frame skipped", error);
      }
    } finally {
      this.raf = requestAnimationFrame(() => this.loop());
    }
  }

  private hideStaging(hidden: boolean): void {
    this.rigGroup.visible = !hidden;
    for (const aid of this.aids) aid.visible = !hidden;
    this.transformHelper.visible = !hidden && this.transform.object !== undefined;
  }

  private letterbox(width: number, height: number): { w: number; h: number } {
    let w = width;
    let h = Math.round(width / this.data.aspect);
    if (h > height) {
      h = height;
      w = Math.round(height * this.data.aspect);
    }
    return { w, h };
  }

  private frameBody(): void {
    const data = this.data;
    const lens = data.mode === "camera";
    this.hideStaging(lens);
    const at = this.recordingAt ?? this.clampAt(data.at);
    this.refresh(at);
    if (!lens) this.controls.update();
    const canvasWidth = this.renderer.domElement.width;
    const canvasHeight = this.renderer.domElement.height;
    const ratio = this.renderer.getPixelRatio();
    if (lens) {
      const box = this.letterbox(canvasWidth, canvasHeight);
      const x = Math.round((canvasWidth - box.w) / 2);
      const y = Math.round((canvasHeight - box.h) / 2);
      // The bands outside the letterbox are the page showing through, not the last Look frame:
      // a scissored render clears only inside the scissor, so the whole canvas is cleared first.
      this.renderer.setScissorTest(false);
      this.renderer.clear();
      try {
        this.renderer.setViewport(x / ratio, y / ratio, box.w / ratio, box.h / ratio);
        this.renderer.setScissor(x / ratio, y / ratio, box.w / ratio, box.h / ratio);
        this.renderer.setScissorTest(true);
        this.renderer.render(this.scene, this.shot);
      } finally {
        this.renderer.setScissorTest(false);
        this.renderer.setViewport(0, 0, canvasWidth / ratio, canvasHeight / ratio);
      }
      this.pip.style.opacity = "0";
    } else {
      this.renderer.render(this.scene, this.view);
      // A live lens preview, always on screen while blocking. Staging aids stay out of the lens.
      const pipWidth = Math.max(150 * ratio, Math.min(238 * ratio, canvasWidth * 0.3));
      const box = this.letterbox(pipWidth, canvasHeight);
      const margin = 12 * ratio;
      const x = canvasWidth - box.w - margin;
      const y = margin;
      try {
        this.hideStaging(true);
        this.renderer.setViewport(x / ratio, y / ratio, box.w / ratio, box.h / ratio);
        this.renderer.setScissor(x / ratio, y / ratio, box.w / ratio, box.h / ratio);
        this.renderer.setScissorTest(true);
        this.renderer.autoClear = false;
        this.renderer.clear();
        this.renderer.render(this.scene, this.shot);
      } finally {
        this.renderer.autoClear = true;
        this.renderer.setScissorTest(false);
        this.renderer.setViewport(0, 0, canvasWidth / ratio, canvasHeight / ratio);
        this.hideStaging(false);
      }
      this.pip.style.opacity = "1";
      this.pip.style.left = `${x / ratio}px`;
      this.pip.style.top = `${(canvasHeight - y - box.h) / ratio}px`;
      this.pip.style.width = `${box.w / ratio}px`;
      this.pip.style.height = `${box.h / ratio}px`;
      this.pipCaption.textContent = `camera · ${data.lensLabel}`;
    }
    this.drawLabels(lens);
    this.gizmo.camera.position.copy(this.view.position).sub(this.controls.target).normalize().multiplyScalar(4);
    this.gizmo.camera.up.copy(this.view.up);
    this.gizmo.camera.lookAt(0, 0, 0);
    this.gizmo.renderer.render(this.gizmo.scene, this.gizmo.camera);
  }

  /**
   * The playblast: the shot played through the lens, in real time, into a WebM. A second
   * renderer draws the same scene off screen at the production aspect so the file is the
   * lens and nothing else — no gizmo, no path, no labels — while the on-screen view plays
   * along so the person can see what is being written.
   */
  async record(onProgress: (fraction: number) => void): Promise<Blob> {
    if (typeof MediaRecorder === "undefined") throw new Error("this browser cannot record video");
    const width = 1280;
    const height = Math.round(width / this.data.aspect);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.setClearColor(0xe6e3dd, 1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    const stream = canvas.captureStream(30);
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    const recorder = new MediaRecorder(stream, type === undefined ? {} : { mimeType: type, videoBitsPerSecond: 6_000_000 });
    const chunks: BlobPart[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    // Exactly the shot's length — the pin says the take is the shot, so the take must not
    // run past it; one frame is the floor a recorder can make anything of.
    const duration = Math.max(1 / 30, this.data.durationSec);
    const finished = new Promise<Blob>((resolve, reject) => {
      recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: type ?? "video/webm" })));
      recorder.addEventListener("error", () => reject(new Error("the recording failed")));
    });
    // Elapsed from a start timestamp, never accumulated per tick (SPEC-036 R-29).
    const started = Date.now();
    // The gizmo comes off for the take, so a drag cannot reshape what is being written.
    this.transform.detach();
    this.transformHelper.visible = false;
    recorder.start(250);
    try {
      await new Promise<void>((resolve) => {
        const step = () => {
          const at = Math.min(duration, (Date.now() - started) / 1000);
          this.recordingAt = at;
          this.refresh(at);
          this.hideStaging(true);
          try {
            renderer.render(this.scene, this.shot);
          } finally {
            this.hideStaging(this.data.mode === "camera");
          }
          onProgress(at / duration);
          if (at >= duration || this.disposed) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    } finally {
      this.recordingAt = null;
      recorder.stop();
      for (const track of stream.getTracks()) track.stop();
      this.attachGizmo();
    }
    const blob = await finished;
    renderer.dispose();
    return blob;
  }
}
