import type { SceneAtmosphere, StageMaterial, StagingSet } from "./scene.js";
import type { StageKitPart, StageKitSurface } from "./stage-kit.js";

/**
 * The Stage's looks (issue 1825, design turn 228a–c). Greybox is the drawing the Stage always
 * had. Lit draws each part by what it is made of and lights the set with its own lights under
 * the scene's sky. Plate paints the set with the location plate from its matching camera. The
 * values live here, beside the schema, so the viewport, the inspection renderer and the export
 * draw the same thing; they are the ones turn 228's renders were approved from.
 */

export const STAGE_LOOKS = ["greybox", "lit", "plate"] as const;
export type StageLook = (typeof STAGE_LOOKS)[number];
export const STAGE_LOOK_LABELS: Record<StageLook, string> = { greybox: "Greybox", lit: "Lit", plate: "Plate" };

export interface StageMaterialLook {
  colour: number;
  roughness: number;
  metalness: number;
  /** Below one, the part is see-through and casts no shadow. */
  opacity?: number;
  emissive?: number;
  emissiveIntensity?: number;
}

export const STAGE_MATERIAL_LOOKS: Record<StageMaterial, StageMaterialLook> = {
  plaster: { colour: 0xb88a57, roughness: 0.85, metalness: 0 },
  concrete: { colour: 0x8f8a83, roughness: 0.9, metalness: 0 },
  stone: { colour: 0x2b2a29, roughness: 0.7, metalness: 0 },
  marble: { colour: 0x2a2622, roughness: 0.16, metalness: 0 },
  wood: { colour: 0x3a281d, roughness: 0.6, metalness: 0 },
  metal: { colour: 0x8c8274, roughness: 0.32, metalness: 0.85 },
  glass: { colour: 0x101a22, roughness: 0.04, metalness: 0.6, opacity: 0.32 },
  fabric: { colour: 0x5b4636, roughness: 0.9, metalness: 0 },
  leather: { colour: 0x2b1a14, roughness: 0.55, metalness: 0 },
  foliage: { colour: 0x2e4a2a, roughness: 0.8, metalness: 0 },
  pot: { colour: 0x1d1b1a, roughness: 0.5, metalness: 0 },
  lamp: { colour: 0xffd9a0, roughness: 0.6, metalness: 0, emissive: 0xffb45e, emissiveIntensity: 2.4 },
  screen: { colour: 0x0b0f14, roughness: 0.2, metalness: 0.1, emissive: 0x7fb4ff, emissiveIntensity: 1.2 },
  neon: { colour: 0xff4fa0, roughness: 0.4, metalness: 0, emissive: 0xff2f8f, emissiveIntensity: 3 },
  road: { colour: 0x232427, roughness: 0.95, metalness: 0 },
  paint: { colour: 0x6b1f24, roughness: 0.35, metalness: 0.4 },
  grass: { colour: 0x3d5a2e, roughness: 1, metalness: 0 },
  water: { colour: 0x1d3442, roughness: 0.08, metalness: 0.3, opacity: 0.8 },
};

/** What each kit surface is made of until the item's surfaces say otherwise. */
export const STAGE_SURFACE_DEFAULTS: Record<StageKitSurface, StageMaterial> = {
  floor: "stone", wall: "plaster", glass: "glass", wood: "wood", metal: "metal", fabric: "fabric", leather: "leather",
  stone: "stone", foliage: "foliage", pot: "pot", lamp: "lamp", road: "road", paint: "paint",
};

/**
 * The material a part is drawn in. A plain set is its own material (concrete when unset). A kit
 * part is, in order: its wall by side ("right wall"), its surface ("glass"), the item's own
 * material for a wall or floor, then the surface's default.
 */
export function stageMaterialOf(item: StagingSet, part: StageKitPart): StageMaterial {
  if (!item.kit) return item.material ?? "concrete";
  const local = part.name.slice(item.name.length + 3);
  const side = /^(front|back|left|right) wall/.exec(local)?.[0];
  return (side === undefined ? undefined : item.surfaces?.[side])
    ?? item.surfaces?.[part.surface]
    ?? (part.surface === "wall" || part.surface === "floor" ? item.material : undefined)
    ?? STAGE_SURFACE_DEFAULTS[part.surface];
}

/**
 * The cast's colours, in order (design turn 228 rule 3): strong against a neutral set in every
 * look, so a figure never reads as part of the furniture. They replace burgundy, ochre, slate,
 * dark blue and brown, which sat too close to a warm set.
 */
export const STAGE_CAST_COLOURS: readonly number[] = [0x2f7fd8, 0xd6336c, 0xf59f00, 0x12b886, 0x7048e8, 0x74b816];

export interface StageAtmosphereLook {
  skyTop: number;
  skyBottom: number;
  fog: number;
  haze: number;
  hemisphereSky: number;
  hemisphereGround: number;
  hemisphereIntensity: number;
  sun: number;
  sunIntensity: number;
  /** Where the sun comes from, as a direction toward it. */
  sunFrom: [number, number, number];
  exposure: number;
  shading: boolean;
}

const TIMES: Record<NonNullable<SceneAtmosphere["time"]>, Omit<StageAtmosphereLook, "skyTop" | "skyBottom" | "haze" | "shading">> = {
  day: { fog: 0xc9d6e2, hemisphereSky: 0xdbe7ff, hemisphereGround: 0x6a5a48, hemisphereIntensity: 1.1, sun: 0xfff1dc, sunIntensity: 2.6, sunFrom: [6, 10, 4], exposure: 1 },
  dusk: { fog: 0x6d5a62, hemisphereSky: 0xf2a77a, hemisphereGround: 0x2a1e1e, hemisphereIntensity: 0.7, sun: 0xffa060, sunIntensity: 1.6, sunFrom: [-10, 3, 2], exposure: 1.15 },
  night: { fog: 0x0c0d12, hemisphereSky: 0x3a4a72, hemisphereGround: 0x1a120c, hemisphereIntensity: 0.55, sun: 0x9db4ff, sunIntensity: 0.9, sunFrom: [-9, 8, 3], exposure: 1.35 },
  interior: { fog: 0x2a2724, hemisphereSky: 0xfff3e2, hemisphereGround: 0x3a3028, hemisphereIntensity: 0.9, sun: 0xfff4e6, sunIntensity: 1.2, sunFrom: [3, 9, 5], exposure: 1.1 },
};
const SKIES: Record<NonNullable<SceneAtmosphere["sky"]>, [number, number]> = {
  clear: [0x6f9fd8, 0xd8e6f2],
  overcast: [0x9aa3ab, 0xc7cbcf],
  "night-city": [0x05070d, 0x1b1a22],
  studio: [0x2b2a29, 0x3a3734],
};

/** The scene's atmosphere as the renderer reads it; an unset scene is a neutral interior. */
export function stageAtmosphereLook(atmosphere: SceneAtmosphere | undefined): StageAtmosphereLook {
  const time = atmosphere?.time ?? "interior";
  const sky = atmosphere?.sky ?? (time === "night" ? "night-city" : time === "interior" ? "studio" : "clear");
  const [skyTop, skyBottom] = SKIES[sky];
  return { ...TIMES[time], skyTop, skyBottom, haze: atmosphere?.haze ?? (time === "night" ? 0.022 : 0.008), shading: (atmosphere?.shading ?? "soft") === "soft" };
}

/** A colour temperature as the colour a lamp of it gives, #rrggbb (Tanner Helland's fit, 1000–20000 K). */
export function stageKelvinColour(kelvin: number): string {
  const t = Math.min(20000, Math.max(1000, kelvin)) / 100;
  const clamp = (value: number) => Math.round(Math.min(255, Math.max(0, value)));
  const red = t <= 66 ? 255 : clamp(329.698727446 * Math.pow(t - 60, -0.1332047592));
  const green = t <= 66 ? clamp(99.4708025861 * Math.log(t) - 161.1195681661) : clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492));
  const blue = t >= 66 ? 255 : t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** A new light's starting values: a warm practical just above head height. */
export function stageLightDefault(name: string, at: { x: number; z: number }): import("./scene.js").StageLight {
  return { name, kind: "point", colour: stageKelvinColour(3200), kelvin: 3200, strength: 8, reach: 8, x: at.x, y: 2.4, z: at.z };
}
