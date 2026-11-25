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
  /** How long the shot's line runs as recorded (`recordedLineSec`), when it has been; else it is estimated from its words. */
  lineSec?: number | undefined;
}

/** Just what `recordedLineSec` reads of a production, so the client's and the coordinator's both fit. */
interface RecordedLines {
  takes: ReadonlyArray<{ id: string; kind: string; coversShots: readonly string[]; prompt?: string | undefined; media?: unknown; completedAt?: string | undefined }>;
  takeMediaInfo: Readonly<Record<string, { mediaInfo: { durationSec?: number | undefined } } | undefined>>;
}

/**
 * How long the shot's line runs as recorded: the newest finished voice take of the shot whose words are still its
 * line's. Gold on Gold on 0.5.141 is why it is read rather than estimated: at 2.6 words a second shot 17's line fitted
 * its 6 s with 0.2 s to spare and shot 16's 3 s was short of a beat, but recorded, 17's runs 7.6 s and 16's 1.8 s.
 */
export function recordedLineSec(production: RecordedLines, shot: Shot): number | undefined {
  const line = shot.audio?.line?.trim();
  if (!line) return undefined;
  const said = words(line).join(" ");
  const take = production.takes.filter((candidate) => candidate.kind === "voice" && candidate.media !== undefined && candidate.completedAt !== undefined
    && candidate.coversShots.includes(shot.id) && words(candidate.prompt ?? "").join(" ") === said)
    .sort((a, b) => (a.completedAt! < b.completedAt! ? -1 : a.completedAt! > b.completedAt! ? 1 : 0)).at(-1);
  const seconds = take ? production.takeMediaInfo[take.id]?.mediaInfo.durationSec : undefined;
  return seconds !== undefined && seconds > 0 ? seconds : undefined;
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

/** Words in a name that name nobody on their own: a title, an age, a kin word. */
const NOT_A_NAME = new Set(["Mr", "Mrs", "Ms", "Miss", "Dr", "Sir", "Madam", "Chief", "Young", "Old", "Little", "Big", "Aunty", "Auntie", "Uncle", "Mama", "Papa", "Baba", "Iya"]);

/**
 * A character's names as a shot's words would say them. A name of their own (Tunde, Adeyemi "Ade"
 * Akinola) by each part of three letters or more and any nickname in quotes, as written; a name that
 * describes them (The Dancer, The Lady in White) only as the whole phrase, in any case. On 0.5.139
 * "The Dancer" and "The Lady in White" were found in every shot that said "The".
 */
function namesOf(character: BeforeShotInput["characters"][number]): { parts: string[]; phrases: string[] } {
  const parts = new Set<string>(), phrases = new Set<string>();
  for (const name of [character.name, ...(character.aliases ?? [])]) {
    for (const quoted of name.matchAll(/["“]([^"”]+)["”]/g)) parts.add(quoted[1]!.trim());
    if (/^(the|a|an)\s/i.test(name.trim())) { phrases.add(name.trim()); continue; }
    for (const part of name.replace(/["“”]/g, " ").split(/\s+/).map((word) => word.replace(/\.$/, ""))) {
      if (/^\p{Lu}[\p{L}'-]{2,}$/u.test(part) && !NOT_A_NAME.has(part)) parts.add(part);
    }
  }
  return { parts: [...parts], phrases: [...phrases] };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the words name the character, by a part as written or a describing name in any case. */
function names(text: string, character: BeforeShotInput["characters"][number]): boolean {
  const { parts, phrases } = namesOf(character);
  return parts.some((part) => new RegExp(`(^|[^\\p{L}])${escaped(part)}(?![\\p{L}])`, "u").test(text))
    || phrases.some((phrase) => new RegExp(`(^|[^\\p{L}])${escaped(phrase).replace(/\s+/g, "\\s+")}(?![\\p{L}])`, "iu").test(text));
}

/** What the list calls a character: their nickname, else the name they are known by, else their first name. */
function calledBy(character: BeforeShotInput["characters"][number]): string {
  const quoted = /["“]([^"”]+)["”]/.exec(character.name)?.[1]?.trim();
  if (quoted) return quoted;
  const { parts, phrases } = namesOf(character);
  return phrases[0] ?? parts[0] ?? character.name;
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
  const uncited = input.characters.filter((character) => !cited.has(character.id) && names(bare, character));
  const body = BODY_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
  const listed = (characters: BeforeShotInput["characters"]) => [...new Set(characters.map(calledBy))].join(", ");
  if (uncited.length > 0) items.push({ id: "named", result: "fix", says: clip(`${listed(uncited)} not cited`) });
  else if (body.length > 0) items.push({ id: "named", result: "fix", says: clip(`body words: ${body.join(", ")}`) });
  else {
    const seen = input.characters.filter((character) => cited.has(character.id));
    items.push({ id: "named", result: "pass", says: seen.length > 0 ? clip(listed(seen)) : "no one" });
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

  // A beat before and after the line, so a cut can come on either side of it: about a second in all. The
  // recording's own length once there is one; until then the words at 2.6 a second.
  if (spoken !== null && shot.durationSec !== undefined) {
    const recorded = input.lineSec !== undefined;
    const spare = shot.durationSec - (input.lineSec ?? words(spoken).length / 2.6);
    const says = spare <= 0 ? (recorded ? `recorded line runs ${input.lineSec!.toFixed(1)} s` : "the line overruns")
      : `${spare.toFixed(1)} s spare${recorded ? ", recorded" : ""}`;
    items.push({ id: "beats", result: spare >= 1 ? "pass" : "fix", says });
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
