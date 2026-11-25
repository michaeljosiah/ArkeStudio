import { z } from "zod";
import type { ShotFraming } from "./scene.js";

/**
 * A production's look (design turns 287 and 288): how the whole production is photographed, cut,
 * mixed and played, chosen from a preset when it is made and edited after. Each part is a choice
 * plus a few words of the production's own.
 *
 * Why it exists: Gold on Gold, scene 2 of Na Love or Juju: The Film, was made as 77 clips, and
 * about fifty of their prompts said the camera was locked off in a film meant to be handheld. The
 * only place a production could say how it is shot was `styleOverride`, one paragraph of free words
 * that is writer context and never reaches a frame (issue 942). A look in parts can reach the
 * framing a shot already says to a still and a clip (SPEC-036's scene camera) and be checked.
 *
 * Where each part goes:
 *  - camera, light, lens and focus, and grade become the production's camera: the framing every
 *    shot inherits beneath its scene's camera (`scene.defaults`) and its own (`framing`), field by
 *    field. `sceneUnderLook` lays them under a scene at the places a prompt is assembled.
 *  - cutting, sound, performance and the production's own checks are Arke's to read (the brief) and
 *    the director's checks' to hold (turn 287), not words for a picture model.
 *
 * Two schemas from one shape: the read path takes any string it finds (a `.min()` or `.max()` on a
 * read path deletes productions from worlds on disk), and the write path bounds what a person or
 * Arke may write, as the scene camera's patch does (issue 3247).
 */

export const LOOK_PRESETS = ["naturalistic-drama", "romance", "thriller", "found-footage", "music-video"] as const;
export type LookPreset = (typeof LOOK_PRESETS)[number];
export const LOOK_CAMERA_KINDS = ["handheld", "steady", "locked", "shaky"] as const;
export const LOOK_CAMERA_STRENGTHS = ["gentle", "strong"] as const;
export const LOOK_LIGHT_KEYS = ["low", "high"] as const;
export const LOOK_LENS_LENGTHS = ["wide", "normal", "long"] as const;
export const LOOK_FOCUS = ["shallow", "deep"] as const;
export const LOOK_PERFORMANCE = ["naturalistic", "heightened", "deadpan"] as const;

/** The words a person writes beside a choice: a few, never a paragraph that drowns the shot's own. */
export const LOOK_WORDS_MAX = 160;
/** One own check: a line, such as "Ade's watch on his near wrist". */
export const LOOK_CHECK_MAX = 120;
export const LOOK_CHECKS_MAX = 12;

function lookShape(write: boolean) {
  const words = write ? z.string().trim().min(1).max(LOOK_WORDS_MAX).optional() : z.string().optional();
  const check = write ? z.string().trim().min(1).max(LOOK_CHECK_MAX) : z.string();
  const checks = write ? z.array(check).max(LOOK_CHECKS_MAX) : z.array(check);
  return z
    .object({
      preset: z.enum(LOOK_PRESETS).optional(),
      camera: z
        .object({
          kind: z.enum(LOOK_CAMERA_KINDS).optional(),
          strength: z.enum(LOOK_CAMERA_STRENGTHS).optional(),
          /** Eases closer on the beat that matters. */
          pushOnBeat: z.boolean().optional(),
          words,
        })
        .strict()
        .optional(),
      light: z.object({ key: z.enum(LOOK_LIGHT_KEYS).optional(), words }).strict().optional(),
      lens: z.object({ length: z.enum(LOOK_LENS_LENGTHS).optional(), focus: z.enum(LOOK_FOCUS).optional(), words }).strict().optional(),
      grade: z.object({ words }).strict().optional(),
      cutting: z
        .object({
          /** A line may run over the listener, or start under the shot before. */
          splitCuts: z.boolean().optional(),
          /** How long an insert holds, in seconds. */
          insertSec: (write ? z.number().min(0.3).max(5) : z.number()).optional(),
          words,
        })
        .strict()
        .optional(),
      sound: z
        .object({
          /** One room tone for each place, under every take of it. */
          roomTonePerPlace: z.boolean().optional(),
          /** A generated take's own sound effects are kept where they are clear and on the action. */
          keepModelEffects: z.boolean().optional(),
          words,
        })
        .strict()
        .optional(),
      performance: z.object({ style: z.enum(LOOK_PERFORMANCE).optional(), words }).strict().optional(),
      /** The production's own checks: lines a director's check looks for in every shot. */
      checks: checks.optional(),
    })
    .strict();
}

/** production.json `look`: the read path. */
export const ProductionLookSchema = lookShape(false);
export type ProductionLook = z.infer<typeof ProductionLookSchema>;
/** What a person or Arke may write: the read shape, bounded. */
export const ProductionLookInputSchema = lookShape(true);

/**
 * What each preset chooses. A preset fills the choices and nothing else: the words and the
 * production's own checks are the production's, and a preset never writes over them (turn 288,
 * rule 6). A choice edited after a preset changes only itself.
 */
export const LOOK_PRESET_CHOICES: Record<LookPreset, Omit<ProductionLook, "preset" | "checks">> = {
  "naturalistic-drama": {
    camera: { kind: "handheld", strength: "gentle", pushOnBeat: true },
    light: { key: "low" },
    lens: { length: "normal", focus: "shallow" },
    cutting: { splitCuts: true, insertSec: 1 },
    sound: { roomTonePerPlace: true, keepModelEffects: true },
    performance: { style: "naturalistic" },
  },
  romance: {
    camera: { kind: "steady", strength: "gentle", pushOnBeat: true },
    light: { key: "high" },
    lens: { length: "long", focus: "shallow" },
    cutting: { splitCuts: true, insertSec: 1.5 },
    sound: { roomTonePerPlace: true, keepModelEffects: true },
    performance: { style: "naturalistic" },
  },
  thriller: {
    camera: { kind: "handheld", strength: "strong", pushOnBeat: true },
    light: { key: "low" },
    lens: { length: "wide", focus: "deep" },
    cutting: { splitCuts: true, insertSec: 0.8 },
    sound: { roomTonePerPlace: true, keepModelEffects: true },
    performance: { style: "naturalistic" },
  },
  "found-footage": {
    camera: { kind: "shaky", strength: "strong", pushOnBeat: false },
    light: { key: "high" },
    lens: { length: "wide", focus: "deep" },
    cutting: { splitCuts: false, insertSec: 1 },
    sound: { roomTonePerPlace: false, keepModelEffects: true },
    performance: { style: "naturalistic" },
  },
  "music-video": {
    camera: { kind: "steady", strength: "strong", pushOnBeat: true },
    light: { key: "high" },
    lens: { length: "normal", focus: "shallow" },
    cutting: { splitCuts: false, insertSec: 0.5 },
    sound: { roomTonePerPlace: false, keepModelEffects: false },
    performance: { style: "heightened" },
  },
};

export const LOOK_PRESET_NAMES: Record<LookPreset, string> = {
  "naturalistic-drama": "Naturalistic drama",
  romance: "Romance",
  thriller: "Thriller",
  "found-footage": "Found footage",
  "music-video": "Music video",
};

/** A look with a preset's choices laid in: words and own checks kept, every choice the preset's. */
export function applyLookPreset(look: ProductionLook | undefined, preset: LookPreset): ProductionLook {
  const chosen = LOOK_PRESET_CHOICES[preset];
  const next: ProductionLook = { ...look, preset };
  for (const part of ["camera", "light", "lens", "cutting", "sound", "performance"] as const) {
    const words = look?.[part]?.words;
    next[part] = { ...chosen[part], ...(words !== undefined ? { words } : {}) } as never;
  }
  return next;
}

const join = (parts: ReadonlyArray<string | undefined>, by = ", "): string | undefined => {
  const kept = parts.map((part) => part?.trim()).filter((part): part is string => !!part);
  return kept.length > 0 ? kept.join(by) : undefined;
};

/** The camera's movement in the words a shot's framing uses. */
function movementWords(camera: ProductionLook["camera"]): string | undefined {
  if (!camera) return undefined;
  const kind =
    camera.kind === "handheld"
      ? camera.strength === "strong" ? "handheld, loose and energetic" : "handheld, gently breathing and drifting"
      : camera.kind === "steady"
        ? camera.strength === "strong" ? "steady and moving, on a dolly or gimbal" : "steady, slow glides on a dolly or gimbal"
        : camera.kind === "locked"
          ? "locked off on a tripod"
          : camera.kind === "shaky"
            ? camera.strength === "gentle" ? "shaky handheld" : "shaky handheld, raw and jolting"
            : undefined;
  const push = camera.pushOnBeat === true && camera.kind !== "locked" ? "easing a little closer on the beat that matters" : undefined;
  return join([kind, push, camera.words], "; ");
}

/**
 * The production's camera: the framing fields its look says, for every shot beneath the scene's
 * camera and the shot's own. Movement only where the camera has a kind or words; never a field
 * the look leaves unsaid, so an empty look adds nothing to any prompt.
 */
export function lookFraming(look: ProductionLook | undefined): ShotFraming {
  if (!look) return {};
  const framing: ShotFraming = {};
  const movement = movementWords(look.camera);
  if (movement) framing.movement = movement;
  const lighting = join([look.light?.key === "low" ? "low key" : look.light?.key === "high" ? "high key" : undefined, look.light?.words], ": ");
  if (lighting) framing.lighting = lighting;
  const lens = join([look.lens?.length ? `${look.lens.length} lens` : undefined, look.lens?.words]);
  if (lens) framing.lens = lens;
  if (look.lens?.focus) framing.focus = `${look.lens.focus} focus`;
  const grade = look.grade?.words?.trim();
  if (grade) framing.grade = grade;
  return framing;
}

/**
 * The scene as a prompt sees it under the production's look: the look's camera laid beneath the
 * scene's own (SPEC-036's scene camera), which a shot's `framing` still overrides field by field.
 * Only where a prompt is assembled: the Stage solves its cameras from the scene's own lens.
 */
export function sceneUnderLook<S extends { defaults?: ShotFraming }>(scene: S, look: ProductionLook | undefined): S {
  const base = lookFraming(look);
  if (Object.keys(base).length === 0) return scene;
  return { ...scene, defaults: { ...base, ...scene.defaults } };
}

/** The look's choices in a line, as a screen names them (turn 288b): "handheld · low key · long, shallow". */
export function lookLine(look: ProductionLook): string {
  const lens = [look.lens?.length, look.lens?.focus].filter(Boolean).join(", ");
  return [look.camera?.kind, look.light?.key ? `${look.light.key} key` : undefined, lens || undefined].filter(Boolean).join(" · ");
}

/**
 * The look as Arke reads it, one line a part, for the brief of a production's threads (turn 287,
 * rule 12). Plain words; the parts a picture model never sees (cutting, sound, performance, the
 * own checks) are said here because the director has to keep them.
 */
export function lookBrief(look: ProductionLook | undefined): string | null {
  if (!look) return null;
  const lines: string[] = [];
  const preset = look.preset ? LOOK_PRESET_NAMES[look.preset] : undefined;
  const framing = lookFraming(look);
  if (framing.movement) lines.push(`camera ${framing.movement}`);
  if (framing.lighting) lines.push(`light ${framing.lighting}`);
  const lens = join([framing.lens, framing.focus]);
  if (lens) lines.push(lens);
  if (framing.grade) lines.push(`grade ${framing.grade}`);
  const cutting = join([
    look.cutting?.splitCuts === true ? "split cuts (a line runs over the listener, or starts under the shot before)" : look.cutting?.splitCuts === false ? "straight cuts" : undefined,
    look.cutting?.insertSec !== undefined ? `an insert holds about ${look.cutting.insertSec} s` : undefined,
    look.cutting?.words,
  ]);
  if (cutting) lines.push(`cutting: ${cutting}`);
  const sound = join([
    look.sound?.roomTonePerPlace === true ? "one room tone for each place under every take" : undefined,
    look.sound?.keepModelEffects === true ? "a take's own effects kept where clear and on the action" : look.sound?.keepModelEffects === false ? "a take's own effects replaced" : undefined,
    look.sound?.words,
  ]);
  if (sound) lines.push(`sound: ${sound}`);
  const performance = join([look.performance?.style, look.performance?.words]);
  if (performance) lines.push(`performance ${performance}`);
  const checks = (look.checks ?? []).map((check) => check.trim()).filter(Boolean);
  if (lines.length === 0 && checks.length === 0 && !preset) return null;
  const head = `The production's look${preset ? ` (${preset})` : ""}: ${lines.length > 0 ? lines.join("; ") : "no parts set"}.`;
  const own = checks.length > 0 ? ` Its own checks, to hold in every shot: ${checks.join("; ")}.` : "";
  return `${head}${own} Shots inherit its camera, light, lens and grade unless their scene or the shot says otherwise; write every shot's movement to match it.`;
}
