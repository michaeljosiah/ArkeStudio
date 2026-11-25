import { lookFraming, sceneUnderLook, type ProductionLook } from "./production-look.js";
import { parseMentions } from "./planning.js";
import type { ScriptBlock, Shot, ShotFraming } from "./scene.js";

/**
 * What is read of a shot before it is made (design turns 287 and 288b): the checks a director runs
 * down before money moves, the same way every time. Gold on Gold's shots went to the model with
 * "the camera is locked off" in about fifty of seventy-seven prompts in a film meant to be
 * handheld, lines that ran the whole shot with no beat either side, and shots made one by one that
 * their neighbours' faces and light did not hold across. Each is in the shot's own words, so each
 * is read here before the press.
 *
 * Only the read items are here. The looked ones of turn 287's list (it opens as the shot before
 * ends, the production's own lines) are Arke's, with the frames; the request's measured items
 * (references within the route's limits, the price) are its card's.
 */
export const BEFORE_SHOT_CHECKS = ["line", "named", "camera", "light", "beats", "frame", "board"] as const;
export type BeforeShotCheckId = typeof BEFORE_SHOT_CHECKS[number];

export const BEFORE_SHOT_NAMES: Readonly<Record<BeforeShotCheckId, string>> = {
  line: "Line", named: "Named", camera: "Camera", light: "Light", beats: "Beat around the line", frame: "First frame", board: "Board",
};

/** The items that hold a paid press until fixed or passed over (turn 287's hard items). */
export const HARD_BEFORE_SHOT: ReadonlySet<BeforeShotCheckId> = new Set(["line", "named", "camera", "frame"]);

export interface BeforeShotCheck { id: BeforeShotCheckId; result: "pass" | "fix"; says: string }

export interface BeforeShotInput {
  /** The scene's camera and its script, which every shot of it inherits and quotes. */
  scene: { defaults?: ShotFraming | undefined; script?: { blocks: readonly ScriptBlock[] } | undefined };
  shot: Shot;
  look: ProductionLook | undefined;
  /** What the shot's clip is made from, the shot's own choice over the production's. */
  clipsFrom: "frames" | "references";
  /** Whether the shot has a start frame to open on. */
  hasFrame: boolean;
  /** The world's characters, to find one named in the shot's words but not cited. */
  characters: ReadonlyArray<{ id: string; name: string; aliases?: readonly string[] }>;
  /** The shot's board when it shares one with other shots, by their numbers in the scene, and its seconds. */
  board: { numbers: readonly number[]; seconds: number } | null;
}

/** Words as compared: one case, apostrophes kept inside a word, nothing else but letters and digits. */
function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").split(/[^\p{L}\p{N}']+/u)
    .map((word) => word.replace(/^'+|'+$/g, "")).filter(Boolean);
}

const clip = (text: string, length = 36) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);
const SPOKEN = new Set(["dialogue", "vo", "voice", "voice-over", "voiceover", "line", "speech"]);

/**
 * Words about a body's build. Owner's rule from the Juju film: a character is their sheet, and a
 * build word in a shot line is amplified by the model into a different body.
 */
const BODY_WORDS = ["slim", "slender", "skinny", "thin-waisted", "curvy", "curvaceous", "voluptuous", "busty", "buxom", "petite",
  "plump", "chubby", "stocky", "muscular", "muscled", "brawny", "burly", "toned", "athletic build", "hourglass", "full-figured", "thick thighs", "wide hips"];

/** The words that tell a model to hold the camera still. */
const STILL_CAMERA = /\blocked[ -]?off\b|\btripod\b|\bdoes not move\b|\bdoesn't move\b|\bstatic camera\b|\bcamera (?:is|stays|holds) still\b|\bno camera (?:movement|motion)\b/i;
const MOVING_CAMERA = /\bhand-?held\b|\bshaky\b|\bshoulder-?mounted\b/i;

/** A character's names as a shot's words would say them: each name of three letters or more, and any nickname in quotes. */
function namesOf(character: BeforeShotInput["characters"][number]): string[] {
  const names = new Set<string>();
  for (const name of [character.name, ...(character.aliases ?? [])]) {
    for (const quoted of name.matchAll(/["“]([^"”]+)["”]/g)) names.add(quoted[1]!.trim());
    for (const part of name.replace(/["“”]/g, " ").split(/\s+/)) if (/^\p{Lu}[\p{L}'-]{2,}$/u.test(part)) names.add(part);
  }
  return [...names];
}

export function beforeShotChecks(input: BeforeShotInput): BeforeShotCheck[] {
  const { shot } = input;
  const items: BeforeShotCheck[] = [];
  const audio = shot.audio, spoken = audio?.line?.trim() && SPOKEN.has(audio.kind.trim().toLowerCase()) ? audio.line.trim() : null;

  // The line, word for word as the script has it, said by its speaker: one speaker a shot.
  const dialogue = (input.scene.script?.blocks ?? []).filter((block) => block.kind === "dialogue");
  if (spoken !== null && dialogue.length > 0) {
    const said = words(spoken).join(" ");
    const block = dialogue.find((candidate) => words(candidate.text).join(" ") === said);
    items.push(block === undefined ? { id: "line", result: "fix", says: "not in the script" }
      : audio?.speaker !== undefined && block.speaker !== undefined && block.speaker !== audio.speaker ? { id: "line", result: "fix", says: "another's line" }
      : { id: "line", result: "pass", says: "word for word" });
  }

  // Everyone seen is cited by @mention, and no words about their build.
  const text = [shot.description, shot.camera ?? "", shot.intent ?? "", ...(shot.beats ?? []).map((beat) => beat.text)].join("\n");
  const cited = new Set(parseMentions(shot.description));
  const bare = text.replace(/@[a-z0-9][a-z0-9-]*/g, " ");
  const uncited = input.characters.filter((character) => !cited.has(character.id)
    && namesOf(character).some((name) => new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u").test(bare)));
  const body = BODY_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
  const shortName = (character: BeforeShotInput["characters"][number]) => namesOf(character).find((name) => /["“]/.test(character.name) && character.name.includes(`"${name}"`)) ?? namesOf(character)[0] ?? character.name;
  if (uncited.length > 0) items.push({ id: "named", result: "fix", says: clip(`${uncited.map(shortName).join(", ")} not cited`) });
  else if (body.length > 0) items.push({ id: "named", result: "fix", says: clip(`body words: ${body.join(", ")}`) });
  else {
    const names = input.characters.filter((character) => cited.has(character.id)).map(shortName);
    items.push({ id: "named", result: "pass", says: names.length > 0 ? clip(names.join(", ")) : "no one" });
  }

  // The camera's words against the film's look: never told to hold still in a handheld film.
  const scene = sceneUnderLook({ defaults: input.scene.defaults }, input.look);
  const movement = shot.framing?.movement ?? scene.defaults?.movement;
  const cameraText = [shot.description, shot.camera ?? "", shot.framing?.movement ?? "", shot.promptOverride?.text ?? ""].join("\n");
  const kind = input.look?.camera?.kind;
  if (kind === "handheld" || kind === "shaky") {
    items.push(STILL_CAMERA.test(cameraText) ? { id: "camera", result: "fix", says: "says locked off" } : { id: "camera", result: "pass", says: kind });
  } else if (kind === "locked" || kind === "steady") {
    items.push(MOVING_CAMERA.test(cameraText) ? { id: "camera", result: "fix", says: "says handheld" } : { id: "camera", result: "pass", says: kind });
  } else if (movement) {
    items.push({ id: "camera", result: "pass", says: clip(movement) });
  }

  // Its light named: every frame says where its light comes from (owner's rule, the Juju film).
  const lighting = shot.framing?.lighting ?? input.scene.defaults?.lighting ?? lookFraming(input.look).lighting;
  items.push(lighting?.trim() ? { id: "light", result: "pass", says: clip(lighting.trim()) } : { id: "light", result: "fix", says: "none named" });

  // A beat before and after the line, so a cut can come on either side of it: about a second in all.
  if (spoken !== null && shot.durationSec !== undefined) {
    const spare = shot.durationSec - words(spoken).length / 2.6;
    items.push(spare >= 1 ? { id: "beats", result: "pass", says: `${spare.toFixed(1)} s spare` }
      : { id: "beats", result: "fix", says: spare <= 0 ? "the line overruns" : `${spare.toFixed(1)} s spare` });
  }

  // A clip made from frames needs its first frame.
  if (input.clipsFrom === "frames") {
    items.push(input.hasFrame ? { id: "frame", result: "pass", says: "set" } : { id: "frame", result: "fix", says: "none" });
  }

  // A shot whose board holds others keeps their faces and light best made with them, as one clip.
  if (input.board !== null && input.board.numbers.length > 1) {
    const numbers = input.board.numbers, span = `${numbers[0]}–${numbers[numbers.length - 1]}`;
    items.push({ id: "board", result: "fix", says: `with ${span} · ${input.board.seconds.toFixed(1)} s` });
  }
  return items;
}

/** The count beside the press: how many passed, of how many, and the hard ones still to fix. */
export function beforeShotCount(items: readonly BeforeShotCheck[]): { passed: number; of: number; hardToFix: number } {
  return { passed: items.filter((item) => item.result === "pass").length, of: items.length,
    hardToFix: items.filter((item) => item.result === "fix" && HARD_BEFORE_SHOT.has(item.id)).length };
}
