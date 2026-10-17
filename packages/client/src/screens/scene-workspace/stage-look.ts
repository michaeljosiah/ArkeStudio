import {
  AgXToneMapping,
  Box3,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HemisphereLight,
  type Material,
  MeshStandardMaterial,
  NoToneMapping,
  type Object3D,
  PerspectiveCamera,
  PointLight,
  type Scene,
  ShaderMaterial,
  SpotLight,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
  type WebGLRenderer,
} from "three";
import {
  STAGE_MATERIAL_LOOKS,
  stageAtmosphereLook,
  stageMaterialOf,
  stagingFov,
  type SceneAtmosphere,
  type StageKitPart,
  type StageLight,
  type StageLook,
  type StagingSet,
} from "@arke-studio/contracts";

/**
 * The Stage's looks in three.js (issue 1825, design turn 229a–c). Greybox shows the rig the
 * viewport always had: one grey, a sun, the grid, the light ground. Lit hides that and lights the
 * set with its own lights under the scene's sky, in materials by what each part is made of. Plate
 * paints the set with the location plate projected from the camera it was taken from. Every look
 * is deterministic — no clock, no noise — so a playblast renders the same pixels for the same time.
 */

export interface StagePlateView {
  url: string;
  camera: { p: readonly [number, number, number]; l: readonly [number, number, number]; focalMm: number };
}

export interface StageLookData {
  look: StageLook;
  lights: readonly StageLight[];
  atmosphere: SceneAtmosphere | undefined;
  plate: StagePlateView | null;
}

const GREY = 0xa79e93;

function skyTexture(top: number, bottom: number): CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const gradient = context.createLinearGradient(0, 0, 0, 128);
  gradient.addColorStop(0, `#${top.toString(16).padStart(6, "0")}`);
  gradient.addColorStop(1, `#${bottom.toString(16).padStart(6, "0")}`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 4, 128);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

const PLATE_VERTEX = `varying vec3 vWorld; varying vec3 vNormal;
void main() { vec4 world = modelMatrix * vec4(position, 1.0); vWorld = world.xyz; vNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * world; }`;
const PLATE_FRAGMENT = `uniform sampler2D plate; uniform mat4 viewProjection; uniform vec3 eye; varying vec3 vWorld; varying vec3 vNormal;
void main() {
  vec4 clip = viewProjection * vec4(vWorld, 1.0);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  float facing = abs(dot(normalize(vNormal), normalize(eye - vWorld)));
  vec3 base = vec3(0.13, 0.12, 0.115) * (0.55 + 0.45 * abs(vNormal.y));
  bool inside = clip.w > 0.0 && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0;
  gl_FragColor = vec4(inside ? mix(base, texture2D(plate, uv).rgb, 0.35 + 0.65 * facing) : base, 1.0);
  #include <colorspace_fragment>
}`;

export class StageLookRig {
  private readonly lit = new Group();
  private data: StageLookData = { look: "greybox", lights: [], atmosphere: undefined, plate: null };
  private sky: CanvasTexture | null = null;
  private sun: DirectionalLight | null = null;
  /**
   * The scene's lights as built, in the order they are listed. Held apart from the group, which
   * also holds the sky light, the sun and the sun's target: counting into it put every named aim
   * one light off (the first never aimed, each later one aimed by the light before it).
   */
  private practicals: Object3D[] = [];
  private plateTexture: Texture | null = null;
  /** The plate picture's load, settled true once it is drawable and false if it failed. */
  private plateLoading: Promise<boolean> | null = null;
  private plateUrl: string | null = null;
  private readonly loader = new TextureLoader();

  constructor(private readonly scene: Scene, private readonly greybox: readonly Object3D[], private readonly onReady: () => void) {
    this.lit.name = "stage-look";
    scene.add(this.lit);
  }

  get look(): StageLook {
    return this.data.look;
  }

  /** Dress the scene for a look; sets are dressed one part at a time through material(). */
  apply(data: StageLookData): void {
    this.data = data;
    const dressed = data.look !== "greybox";
    for (const object of this.greybox) object.visible = !dressed;
    while (this.lit.children.length > 0) {
      const child = this.lit.children[0]!;
      this.lit.remove(child);
      (child as { dispose?: () => void }).dispose?.();
    }
    this.sun = null;
    this.practicals = [];
    this.sky?.dispose();
    this.sky = null;
    if (!dressed) {
      this.scene.background = null;
      this.scene.fog = null;
      return;
    }
    const atmosphere = stageAtmosphereLook(data.atmosphere);
    this.sky = skyTexture(atmosphere.skyTop, atmosphere.skyBottom);
    this.scene.background = this.sky ?? new Color(atmosphere.skyBottom);
    this.scene.fog = atmosphere.haze > 0 ? new FogExp2(atmosphere.fog, atmosphere.haze) : null;
    this.lit.add(new HemisphereLight(atmosphere.hemisphereSky, atmosphere.hemisphereGround, atmosphere.hemisphereIntensity));
    const sun = new DirectionalLight(atmosphere.sun, atmosphere.sunIntensity);
    sun.position.set(...atmosphere.sunFrom);
    sun.castShadow = atmosphere.shading;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0006;
    sun.shadow.radius = 4;
    this.lit.add(sun, sun.target);
    this.sun = sun;
    this.practicals = data.lights.map((light) => this.practical(light));
    for (const object of this.practicals) this.lit.add(object);
    if (data.look === "plate" && data.plate !== null && data.plate.url !== this.plateUrl) {
      this.plateUrl = data.plate.url;
      this.plateTexture?.dispose();
      this.plateTexture = null;
      this.plateLoading = new Promise((resolve) => {
        this.loader.load(data.plate!.url, (texture) => {
          texture.colorSpace = SRGBColorSpace;
          this.plateTexture = texture;
          this.onReady();
          resolve(true);
        }, undefined, () => resolve(false));
      });
    }
  }

  private practical(light: StageLight): Object3D {
    const colour = new Color(light.colour);
    const reach = light.reach ?? 0;
    if (light.kind === "sun") {
      const sun = new DirectionalLight(colour, light.strength / 10);
      sun.position.set(light.x, light.y, light.z);
      sun.castShadow = light.shadow ?? false;
      return sun;
    }
    if (light.kind === "spot" || light.kind === "area") {
      const spot = new SpotLight(colour, light.strength, reach, light.kind === "area" ? Math.PI / 2.2 : Math.PI / 5, 0.6, 2);
      spot.position.set(light.x, light.y, light.z);
      const aim = Array.isArray(light.aim) ? light.aim : [light.x, 0, light.z];
      spot.target.position.set(aim[0]!, aim[1]!, aim[2]!);
      spot.castShadow = light.shadow ?? false;
      const group = new Group();
      group.add(spot, spot.target);
      return group;
    }
    const point = new PointLight(colour, light.strength, reach, 2);
    point.position.set(light.x, light.y, light.z);
    point.castShadow = light.shadow ?? false;
    if (point.castShadow) point.shadow.bias = -0.002;
    return point;
  }

  /**
   * Settles once a Plate look's picture can be drawn: until then the set wears Lit materials, so
   * an export must wait or it would file Lit frames as Plate, or switch to the plate partway
   * through when the picture arrives. False when the picture could not be loaded.
   */
  whenPlateReady(): Promise<boolean> {
    if (this.data.look !== "plate" || this.data.plate === null || this.plateTexture !== null) return Promise.resolve(true);
    return this.plateLoading ?? Promise.resolve(false);
  }

  /** A named aim resolves against the set once it is built: the light points at that set's centre. */
  aimAt(resolve: (name: string) => Vector3 | null): void {
    for (const [index, light] of this.data.lights.entries()) {
      const object = this.practicals[index];
      if (typeof light.aim !== "string" || !object) continue;
      const target = resolve(light.aim);
      const spot = object.children.find((child) => (child as SpotLight).isSpotLight) as SpotLight | undefined;
      if (target && spot) spot.target.position.copy(target);
    }
  }

  /** The sun's shadow covers the set it falls on, however large, rather than a fixed nine metres. */
  fitShadow(bounds: Box3): void {
    if (this.sun === null || bounds.isEmpty()) return;
    const centre = bounds.getCenter(new Vector3());
    const radius = Math.max(4, bounds.getSize(new Vector3()).length() / 2 + 1);
    const direction = this.sun.position.clone().normalize();
    this.sun.target.position.copy(centre);
    this.sun.position.copy(centre).addScaledVector(direction, radius * 2);
    const camera = this.sun.shadow.camera;
    camera.left = camera.bottom = -radius;
    camera.right = camera.top = radius;
    camera.near = 0.5;
    camera.far = radius * 4;
    camera.updateProjectionMatrix();
  }

  /** One part's material in the current look; a fresh one each time, so clearing a group disposes only its own. */
  material(item: StagingSet, part: StageKitPart, aspect: number): Material {
    const look = this.data.look;
    if (look === "plate" && this.data.plate !== null && this.plateTexture !== null) {
      const camera = this.data.plate.camera;
      const image = this.plateTexture.image as { width?: number; height?: number } | undefined;
      const plateAspect = image?.width && image?.height ? image.width / image.height : aspect;
      const projector = new PerspectiveCamera(stagingFov(`${camera.focalMm}mm`, `${plateAspect}:1`), plateAspect, 0.05, 500);
      projector.position.set(...camera.p);
      projector.lookAt(new Vector3(...camera.l));
      projector.updateMatrixWorld();
      return new ShaderMaterial({
        uniforms: {
          plate: { value: this.plateTexture },
          viewProjection: { value: projector.projectionMatrix.clone().multiply(projector.matrixWorldInverse) },
          eye: { value: projector.position.clone() },
        },
        vertexShader: PLATE_VERTEX,
        fragmentShader: PLATE_FRAGMENT,
        side: DoubleSide,
      });
    }
    if (look === "greybox") {
      return new MeshStandardMaterial({ color: GREY, roughness: 0.95, side: DoubleSide, transparent: true, opacity: part.solid ? 1 : 0.22 });
    }
    const values = STAGE_MATERIAL_LOOKS[stageMaterialOf(item, part)];
    const colour = item.colour && !item.kit ? new Color(item.colour) : new Color(values.colour);
    return new MeshStandardMaterial({
      color: colour,
      roughness: values.roughness,
      metalness: values.metalness,
      side: DoubleSide,
      ...(values.opacity === undefined ? {} : { transparent: true, opacity: values.opacity }),
      ...(values.emissive === undefined ? {} : { emissive: new Color(values.emissive), emissiveIntensity: values.emissiveIntensity ?? 1 }),
    });
  }

  /** Tone mapping and exposure for a renderer drawing this look. */
  prepare(renderer: WebGLRenderer): void {
    if (this.data.look === "greybox") {
      renderer.toneMapping = NoToneMapping;
      renderer.toneMappingExposure = 1;
      return;
    }
    renderer.toneMapping = AgXToneMapping;
    renderer.toneMappingExposure = this.data.look === "plate" ? 1 : stageAtmosphereLook(this.data.atmosphere).exposure;
  }

  /** Whether contact shading (GTAO) is drawn: Lit with soft shading. */
  get shading(): boolean {
    return this.data.look === "lit" && stageAtmosphereLook(this.data.atmosphere).shading;
  }

  dispose(): void {
    this.sky?.dispose();
    this.plateTexture?.dispose();
    this.scene.remove(this.lit);
  }
}
