import type { ScenePlate, StagingKey } from "./scene.js";

/**
 * The location plate's pure parts (issue 1818, design turn 228c). The plate is a picture of the
 * empty place: the build reads it as the authority on layout and estimates where its camera
 * stood, Match camera puts the matched shot's opening key there, and on a staged clip it rides
 * to the generator as the first image so the blockout and the location reference agree.
 */

/** The detail a plate's Bench tile carries, which is also how the brief recognises it to cite it. */
export const STAGE_PLATE_DETAIL = "the location plate";

/** The plate's file, world-relative: a world file as it is, an artifact under artifacts/. Null when its artifact is gone. */
export function scenePlatePath(plate: ScenePlate, artifacts: readonly { id: string; file: string }[]): string | null {
  if (plate.source.source === "world-file") return plate.source.path;
  const artifactId = plate.source.artifactId;
  const artifact = artifacts.find((candidate) => candidate.id === artifactId);
  return artifact === undefined ? null : `artifacts/${artifact.file}`;
}

/** The plate's own words in a brief: "the lobby". */
export function scenePlateName(plate: ScenePlate): string {
  return `the ${plate.label.charAt(0).toLowerCase()}${plate.label.slice(1)}`;
}

/**
 * The opening key Match camera writes: where the plate was taken from, at its lens. Unanchored
 * and untracked — a plate is a fixed view of the place, not of anyone in it — and it keeps any
 * ease the key it replaces had, so matching moves the camera and changes nothing else.
 */
export function stagePlateKey(plate: ScenePlate, replacing: StagingKey | undefined): StagingKey | null {
  if (plate.camera === undefined) return null;
  return {
    t: 0,
    p: [...plate.camera.p],
    l: [...plate.camera.l],
    focalMm: plate.camera.focalMm,
    ...(replacing?.easeOut === undefined ? {} : { easeOut: replacing.easeOut }),
    ...(replacing?.roll === undefined ? {} : { roll: replacing.roll }),
  };
}

/** The plate camera's height, which the plate form calls its horizon. */
export function stagePlateHorizon(plate: ScenePlate): number | null {
  return plate.camera === undefined ? null : plate.camera.p[1];
}
