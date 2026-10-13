import { z } from "zod";
import {
  GARMENT_WORDS,
  PICTURE_DETAIL_PART_MAX,
  PICTURE_EXPRESSION_MAX,
  PICTURE_FRAME_MAX,
  frameWord,
  normalizeSpeechText,
  type PictureCheck,
  type PictureDetail,
  type PictureWho,
} from "@arke-studio/contracts";
import { clip } from "./audiobook-direction.js";
import { personIdentity, resolveChapterPerson, type ChapterPerson, type ChapterPlace } from "./audiobook-look.js";

/**
 * The picture brief (design turn 193k, SPEC-047 R-120, R-121): the instruction the writing service
 * is given for one picture, and what the coordinator holds its answer to. It replaces the rules of
 * turn 191's prompt. The prompt it asks for is scene-true — what the block's words literally put in
 * front of one camera, in a frame the words call for, with who is in it and who is not, each
 * person dressed from their look's line, their expression and gaze named, the block's own action
 * and objects, and the light from the place and the mood. The keys are the coordinator's; the
 * prose is the model's. A wrong frame is the author's to see on the card, never silently corrected.
 */

/** One picture's answer, read leniently: an answer in turn 191's shape (`who`) still parses, and is held to the brief. */
export const RawBriefSchema = z.object({
  frame: z.string().nullable().optional(),
  inFrame: z.array(z.string()).nullable().optional(),
  expressions: z.record(z.string(), z.string()).nullable().optional(),
  details: z.array(z.object({ of: z.string(), part: z.string().optional(), state: z.string().optional() })).nullable().optional(),
  notInFrame: z.array(z.string()).nullable().optional(),
  place: z.string().nullable().optional(),
  prompt: z.string(),
  /** Turn 191's field: who is in frame. Read as `inFrame` when that is absent. */
  who: z.array(z.string()).nullable().optional(),
});
export type RawBrief = z.infer<typeof RawBriefSchema>;

/** The answer's shape, as the brief writes it out. */
export const BRIEF_SHAPE = `{"frame": "<shot size and subject>",
 "inFrame": ["<key>", ...],
 "expressions": {"<key>": "<that person's expression and gaze, in the words the prompt uses>"},
 "details": [{"of": "<key>", "part": "<hands | forearm | feet | back | ...>", "state": "<ease or tension, e.g. light, at ease>"}],
 "notInFrame": ["<key>", ...],
 "place": "<place key, or null>",
 "prompt": "<the picture>"}`;

/**
 * Rules 1 to 8 of the brief (193k), word for word, with two sentences added after testing
 * 0.5.60-local.14 (2026-10-04): a detail shot says whose hand wears what (her bangles were drawn on
 * his wrist), and where a look image rides the clothes are named neutrally (the club-table pictures
 * of Ife and her close view were refused by the safety check for repeating "bare shoulders" and
 * "low-backed slip dress" with the dress itself riding). `maxChars` is the model's room, `never`
 * the sheets never pictured.
 */
export function briefRules(maxChars: number, never: readonly string[]): string {
  return `THE RULES. What you write is held to them after you answer.
1. THE BLOCK IS THE PICTURE. Draw what the block's words literally describe or plainly imply at that moment: who, what they do, what they hold or touch, where they are. Add no event, person, object, weather or feeling the block does not give. The blocks before and after tell you where you are and who is present; they are never what is in the picture. For dialogue, show the speaker, and the person spoken to only when the words put them together.
2. NAME THE FRAME FIRST. The prompt opens with the shot the words call for, and "frame" says it in the same words.
 - eyes, a look, a face, an expression, a held gaze: extreme close-up or close-up on that face; the person looked at is not in frame.
 - hands, fingers, a touch, an object handled: a detail shot of that and only that.
 - two people talking or facing each other across a table: a medium two-shot, both faces readable.
 - a person moving, entering or crossing a room: a wide or medium-wide shot, the place leading.
 - a place with nobody in it: an establishing shot, place only.
 - over-the-shoulder only when the words put one person behind another.
 The camera stands where the words stand. "He saw only her back" is his place looking at her back; it does not put him in frame. Your frame decides which look image rides for each person, and the app does it: the close view for Two-shot, Medium close-up, Close-up and Extreme close-up, the full body for the rest.
3. SAY WHO IS IN FRAME, AND NOBODY ELSE. "inFrame" holds the keys of the characters the frame shows, from the characters list. A character who is in the scene but outside the frame goes in "notInFrame" and is never named in the prompt: not as behind the camera, not as a shoulder, not as a reflection. Write what the camera sees; never write what it does not, because a model draws what it is told. A detail shot has no one in "inFrame": say whose hand or arm it is in "details" (those characters are listed there and not in "notInFrame"), and describe only what the detail shows of them. In a detail shot say whose hand wears what: every ring, bangle, watch or sleeve stays on the person whose line has it, written with that person ("her hand, with her old-gold bangles, rests on his forearm above his steel watch"), never left to float between two hands.
4. DRESS EACH PERSON FROM THEIR LOOK, NEVER FROM THE ART DIRECTION. For every person in frame use their line from "The look of this chapter": clothes, hair, jewellery, what they carry. Do not change, add or drop a garment, a hairstyle or an ornament. Where a line names its look (look "..."), that look's image rides and already carries the clothes: name each garment once, briefly and neutrally, by the garment and its colour ("her cream-gold silk evening dress"). Never write skin exposure, the cut of a garment or the body under it: no bare shoulders or back, no low-backed, strapless, sheer or tight, nothing beneath her braids. A person with no line gets no words about clothes or hair; their reference decides. Their identity (the shape and features of the face) is the reference's; their expression is not: see rule 5.
5. NAME EVERY FACE'S EXPRESSION AND GAZE. For each person in "inFrame" the prompt says what their face is doing and where they are looking, in plain words, taken from what the block's words say they feel, do or react to. "She held his eyes without smiling" is a level, unsmiling, deliberate gaze, lips closed. "Tunde laughed until his chest hurt" is mouth open, eyes creased shut, head back. A block that states no emotion still gets an expression, inferred from the scene, the chapter note and what the person is doing, and written out; never leave it blank. The reference fixes identity, clothes and body only. It never fixes the expression: a reference photo's dead-pan face is not this block's, so never write "as in the reference" about a face. Put each expression in "expressions" under the person's key, in the words the prompt uses. If a face is turned away or out of frame (a wide shot from behind, a detail), say so in the prompt and write "face turned away" in "expressions"; for a detail shot name the ease or tension of the hand or arm in "details".
6. TAKE THE ACTION AND THE OBJECTS FROM THE BLOCK. Name each action and each object the block names (a glass turned slowly on a table, a key in a closed hand) in the posture the words give. Never invent an object to fill the frame.
7. LIGHT AND TIME COME FROM THE PLACE AND THE MOOD. One sentence from "Place" and "Mood": where the light comes from, what colour, what time. The mood is about light, colour and grain only; anything in it about people, clothes or objects is not for this picture.
8. PLAIN AND LITERAL. Three to six sentences, at most ${maxChars} characters. Concrete nouns, one camera, no metaphor, no story, no sound. Never ask for text, captions, titles, speech bubbles or logos. Never write the book's style or the references, and never write "keep the face as in the picture": the app adds the identity, hair and clothes line after your prompt.
${never.length > 0 ? `Never show, name or hint at: ${never.join(", ")}.\n` : ""}`;
}

/** The three worked examples (193k), Na Love or Juju chapter 1; the hands say whose bangles and whose watch (2026-10-04). */
export const BRIEF_EXAMPLES = `EXAMPLES (Na Love or Juju, chapter 1)
Block p33.0-p34.0: She looked at him. / Not round the room and then at him. Straight at him ... She held his eyes without smiling, long enough for him to understand it was a decision, and then she lifted her glass a fraction ... and turned back to her friends.
{"frame": "Extreme close-up, Ife's eyes", "inFrame": ["ife"], "expressions": {"ife": "level, unsmiling, lips closed, the gaze held and deliberate"}, "details": [], "notInFrame": ["ade", "tunde"], "place": "club",
 "prompt": "Extreme close-up on Ife's eyes and the upper half of her face, looking straight into the lens. Her expression is level and unsmiling, lips closed, the gaze held and deliberate, the look of a decision. Her braids are gathered up off her neck; a heavy old-gold hoop hangs at one ear. Purple club light on one cheek, the white flare of a sparkler soft and far behind her."}
Block p49.0-p49.2: "Your friend says it loudly ..." / She turned her glass slowly on the table. / "I was watching you before he started the one about the goat."
{"frame": "Medium two-shot across the table", "inFrame": ["ife", "ade"], "expressions": {"ife": "calm and direct, a trace of amusement at the corner of her closed mouth", "ade": "attentive and still, brows slightly raised, a little startled"}, "details": [], "notInFrame": ["tunde"], "place": "club",
 "prompt": "Medium two-shot across the low table of a leather booth. Ife, in the cream-and-gold dress, braids gathered up, turns her glass slowly on the table, gold bangles slipping down her wrist, her eyes on Ade, calm and direct, a trace of amusement at the corner of her closed mouth. Ade, in a pale linen shirt open at the collar, sits opposite, a little turned toward her, listening, attentive and still, his brows slightly raised, a little startled. Purple club light, sparklers far behind. Both faces readable."}
Block p64.0: Her fingers rested just above his wrist, on the inside of the forearm where his sleeve had ridden up ... Her bangles slid down and knocked against his watch, gold against steel.
{"frame": "Detail, her fingers on his forearm", "inFrame": [], "expressions": {}, "details": [{"of": "ife", "part": "hand", "state": "fingers light and at ease"}, {"of": "ade", "part": "forearm", "state": "still"}], "notInFrame": [], "place": "club",
 "prompt": "Detail shot, tight on her hand resting on his forearm just above the wrist, where his pale linen sleeve has ridden up. Her hand, with her heavy old-gold bangles, rests on his forearm above his steel watch; her bangles have slid down her wrist against his watch, gold touching steel. Shallow focus, purple club light, the room a dark blur. Hands and forearm only; both faces are out of frame. Her fingers rest light and at ease, his forearm still."}`;

/** One look line as the brief gives it: `[key] Name, look "Storm coat": Oilskin coat ...`, or the place. */
export interface BriefLine {
  label: string;
  key?: string | null;
  text: string;
  /** The chosen look's name, when the line is a kit look's (turn 193). */
  look?: string;
}

/** What the brief is given (193k, "WHAT YOU ARE GIVEN"). */
export interface BriefGiven {
  title: string;
  mood?: string;
  synopsis?: string;
  note?: string;
  lines: readonly BriefLine[];
  people: ReadonlyArray<Pick<ChapterPerson, "key" | "name" | "appearance" | "aliases" | "identity" | "pov"> & { essence?: string }>;
  places: readonly ChapterPlace[];
}

/** The given part, from `## The book's mood` to `## Places`. */
export function briefGiven(input: BriefGiven): string {
  const place = input.lines.find((line) => line.key === null || line.label === "Place");
  const cast = input.lines
    .filter((line) => line !== place)
    .map((line) => `[${line.key ?? line.label}] ${line.label}${line.look !== undefined ? `, look "${line.look}"` : ""}: ${line.text}`)
    .join("\n");
  const people = input.people
    .map((person) => `[${person.key}] ${person.name}${person.essence !== undefined ? ` — ${person.essence}` : ""}${person.appearance !== undefined ? ` — ${person.appearance}` : ""}${personIdentity(person)}`)
    .join("\n");
  const places = input.places.map((entry) => `[${entry.key}] ${entry.name}${entry.look !== undefined ? ` — ${entry.look}` : ""}`).join("\n");
  return `WHAT YOU ARE GIVEN
## The book's mood (light, colour and grain only)
${input.mood ?? "none stated"}
## The chapter (${input.title})
${input.synopsis ?? "no synopsis"}${input.note !== undefined ? `\n${input.note}` : ""}
## The look of this chapter
Place: ${place?.text ?? "not read"}
${cast === "" ? "no lines" : cast}
## Characters
Identity candidates only, not everyone in the scene. Resolve viewpoint pronouns, familiar names and relationships from this context and the chapter, and use canonical keys in every field. A remembered or mentioned relative is not automatically in frame. If an identity cannot be resolved, retain the literal name for the author to check; never guess a sheet.
${people === "" ? "none" : people}
## Places
${places === "" ? "none named" : places}`;
}

// ---------------------------------------------------------------------------
// The answer, held to the chapter
// ---------------------------------------------------------------------------

export interface HeldBrief {
  frame: string;
  inFrame: ChapterPerson[];
  notInFrame: string[];
  expressions: Record<string, string>;
  details: PictureDetail[];
  /** People whose body parts the camera shows; their references still define identity. */
  detailPeople?: ChapterPerson[];
  place: ChapterPlace | undefined;
  prompt: string;
}

/**
 * The answer held to the chapter (R-120): every key one of the chapter's people the sheet lets be
 * pictured (a name is taken for the person it names), nobody both in and out of frame, an
 * expression only for someone in frame, a detail only of someone in the chapter, the place one of
 * its places. An answer that says nothing of who is in frame (turn 191's shape, or none) takes the
 * block's speakers and the people its words name, as before; an empty list is nobody.
 */
export function holdBrief(raw: RawBrief, ctx: { people: readonly ChapterPerson[]; places: readonly ChapterPlace[]; prompt: string; fallback: () => ChapterPerson[] }): HeldBrief {
  const find = (key: string): ChapterPerson | undefined => {
    const person = resolveChapterPerson(ctx.people, key);
    if (person !== undefined) return person.neverDepicted ? undefined : person;
    const name = key.trim().slice(0, 120);
    // An unresolved identity remains visible and requires reference confirmation. Dropping it
    // would turn a failed resolution into a misleading green "Nobody in frame" check.
    return name === "" ? undefined : { key: name.toLowerCase(), name, neverDepicted: false, first: 0 };
  };
  const resolve = (keys: readonly string[] | null | undefined): ChapterPerson[] => [...new Map((keys ?? []).flatMap((key) => (find(key) === undefined ? [] : [find(key)!])).map((person) => [person.key, person])).values()].slice(0, 12);
  const listed = raw.inFrame ?? raw.who;
  const inFrame = (listed === null || listed === undefined ? ctx.fallback() : resolve(listed)).slice(0, 12);
  const inKeys = new Set(inFrame.map((person) => person.key));
  const details: PictureDetail[] = (raw.details ?? []).flatMap((detail) => {
    const person = find(detail.of);
    const part = clip(detail.part, PICTURE_DETAIL_PART_MAX) ?? "hand";
    const state = clip(detail.state, PICTURE_EXPRESSION_MAX);
    return person === undefined ? [] : [{ of: person.key, part, ...(state !== undefined ? { state } : {}) }];
  }).slice(0, 12);
  const detailKeys = new Set(details.map((detail) => detail.of));
  const detailPeople = resolve((raw.details ?? []).map((detail) => detail.of)).filter((person) => detailKeys.has(person.key));
  const notInFrame = resolve(raw.notInFrame).map((person) => person.key).filter((key) => !inKeys.has(key) && !detailKeys.has(key));
  const expressions: Record<string, string> = {};
  for (const [key, words] of Object.entries(raw.expressions ?? {})) {
    const person = find(key);
    const said = clip(words, PICTURE_EXPRESSION_MAX);
    if (person !== undefined && inKeys.has(person.key) && said !== undefined) expressions[person.key] = said;
  }
  const place = raw.place === null || raw.place === undefined ? undefined : ctx.places.find((candidate) => candidate.key === raw.place);
  const frame = clip(raw.frame ?? "", PICTURE_FRAME_MAX) ?? openingFrame(ctx.prompt) ?? "";
  return { frame, inFrame, notInFrame, expressions, details, detailPeople, place, prompt: ctx.prompt };
}

/** The frame word a prompt opens with, from its first words. */
function openingFrame(prompt: string): string | undefined {
  return frameWord(prompt.slice(0, 80).split(/[.!?]/)[0] ?? "") ?? undefined;
}

/**
 * Who rides (design turn 193, rule 12; R-120): who is in frame. A detail shot has nobody in frame
 * and carries only the people whose details are shown, not the place; a frame with nobody in it carries the
 * place's view alone; otherwise each person in frame, and the place where one is named.
 */
export function briefRiders(held: Pick<HeldBrief, "frame" | "inFrame" | "place" | "detailPeople">): Array<{ key: string; name: string; sheet?: string; kind: "character" | "place"; billing?: string }> {
  const detail = frameWord(held.frame) === "Detail";
  const people = [...new Map([...(detail ? [] : held.inFrame), ...(held.detailPeople ?? [])].map((person) => [person.key, person])).values()];
  return [
    ...people.map((person) => ({ key: person.key, name: person.name, ...(person.sheet !== undefined ? { sheet: person.sheet } : {}), kind: "character" as const, ...(person.billing !== undefined ? { billing: person.billing } : {}) })),
    ...(detail || held.place === undefined ? [] : [{ key: held.place.key, name: held.place.name, sheet: held.place.key, kind: "place" as const }]),
  ].slice(0, 24);
}

// ---------------------------------------------------------------------------
// The seven checks (rule 14, R-121)
// ---------------------------------------------------------------------------

/** Whether a person is named: a full name, familiar name or given name, never a shared surname alone. */
export function namedInText(text: string, person: Pick<ChapterPerson, "name" | "aliases">): boolean {
  const contains = (name: string): boolean => name !== "" && new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text);
  // Relatives are identity context too; mentioning one person's surname cannot place the family.
  if ([person.name, ...(person.aliases ?? [])].some(contains)) return true;
  // "Maren" for Maren Kest, as written with its capital: never a title or an article ("The Chorister").
  const first = person.name.trim().split(/\s+/)[0] ?? "";
  if (first.length < 3 || first === person.name.trim() || TITLES.has(first.toLowerCase()) || !/^\p{Lu}/u.test(first)) return false;
  return new RegExp(`(^|[^\\p{L}])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u").test(text);
}

const TITLES = new Set(["the", "old", "young", "mr", "mrs", "ms", "miss", "dr", "lady", "lord", "sir", "dame", "madam", "mother", "father", "aunt", "uncle", "brother", "sister", "captain", "chief", "king", "queen", "prince", "princess", "saint"]);

const AWAY = /\b(turned away|faces? (?:is |are )?(?:turned )?away|out of (?:the )?frame|from behind|back to (?:the )?camera|faces? (?:are |is )?(?:not|never) (?:seen|shown|visible))\b/i;
const REFERENCE_FACE = /\b(as in the reference|reference'?s (?:face|expression)|same (?:face|expression) as (?:the )?reference)\b/i;
const STOP = new Set(["with", "that", "this", "from", "into", "over", "onto", "their", "them", "they", "then", "than", "very", "little", "slightly", "just", "only", "still", "while"]);

/** Whether an expression is written in the prompt (check 7): its own words, at least half of those that carry meaning. */
function expressionIn(prompt: string, said: string): boolean {
  const text = normalizeSpeechText(prompt).toLowerCase();
  if (text.includes(normalizeSpeechText(said).toLowerCase())) return true;
  const words = said.toLowerCase().match(/[a-z']{4,}/g)?.filter((word) => !STOP.has(word)) ?? [];
  if (words.length === 0) return false;
  return words.filter((word) => new RegExp(`\\b${word.replace(/'/g, "'?")}`).test(text)).length * 2 >= words.length;
}

export interface CheckInput {
  held: HeldBrief;
  who: readonly PictureWho[];
  people: readonly ChapterPerson[];
  /** The look lines of the people in frame and in details: what they may wear. */
  lines: ReadonlyArray<{ key: string | null; text: string }>;
  /** The block's own words: a garment the block names is not invented. */
  block: string;
  mood: string | undefined;
}

/**
 * The seven checks the coordinator runs on a drafted picture (rule 14, R-121), whatever the model
 * said, before it is shown. Each is a line on the card, ticked or marked; a mark never blocks
 * Generate — the author does.
 */
export function pictureChecks(input: CheckInput): PictureCheck[] {
  const { held, who } = input;
  const nameOf = (key: string): string => input.people.find((person) => person.key === key)?.name ?? key;
  const detail = frameWord(held.frame) === "Detail";
  const inKeys = new Set(held.inFrame.map((person) => person.key));
  const detailKeys = new Set(held.details.map((entry) => entry.of));
  const checks: PictureCheck[] = [];

  // (1) Someone named is in frame or a detail, and each in frame has a reference.
  const strays = input.people.filter((person) => !inKeys.has(person.key) && !detailKeys.has(person.key) && !held.notInFrame.includes(person.key) && namedInText(held.prompt, person));
  const shown = briefRiders(held).filter((person) => person.kind === "character");
  const lacking = shown.filter((person) => (who.find((entry) => entry.key === person.key)?.reference ?? null) === null);
  const withReference = shown.length - lacking.length;
  const count = shown.length;
  checks.push({
    id: "reference",
    ok: strays.length === 0 && lacking.length === 0,
    label: count === 0 ? (detail ? "Detail" : "Nobody in frame") : `${withReference} of ${count} ${detail ? "shown in detail" : "in frame"} ${count === 1 ? "has" : "have"} a reference`,
    ...(strays.length > 0
      ? { note: `names ${strays.map((person) => person.name).join(", ")}, not in frame` }
      : lacking.length > 0
        ? { note: lacking.map((person) => `${person.name} · ${person.sheet === undefined ? "identity not linked · confirm the character" : "no reference"}`).join(", ") }
        : detail && count === 0
          ? { note: "no character detail identified" }
          : count === 0
            ? { note: held.place !== undefined ? "place only" : "no reference rides" }
            : {}),
  });

  // (2) Nobody out of frame is named or carried.
  const named = held.notInFrame.filter((key) => {
    const person = input.people.find((candidate) => candidate.key === key);
    return person !== undefined && namedInText(held.prompt, person);
  });
  const carried = held.notInFrame.filter((key) => who.some((entry) => entry.key === key));
  checks.push({
    id: "not-in-frame",
    ok: named.length === 0 && carried.length === 0,
    label: "Nobody else named",
    ...(named.length > 0 || carried.length > 0 ? { note: `names ${[...new Set([...named, ...carried])].map(nameOf).join(", ")}` } : held.notInFrame.length > 0 ? { note: held.notInFrame.map(nameOf).join(", ") } : {}),
  });

  // (3) The prompt opens with a frame word, and the field agrees.
  const word = frameWord(held.frame);
  const opening = openingFrame(held.prompt);
  checks.push({ id: "frame", ok: word !== null && opening === word, label: "Frame named first", ...(word === null ? { note: "no frame word" } : opening !== word ? { note: `prompt opens ${opening ?? "without one"}` } : { note: word }) });

  // (4) A garment, hairstyle or ornament no look line and no word of the block gives is invented.
  const allowed = [...input.lines.map((line) => line.text), input.block].join(" ").toLowerCase();
  const found = [...new Set([...held.prompt.matchAll(new RegExp(GARMENT_WORDS.source, "gi"))].map((match) => match[0].toLowerCase()))];
  const invented = found.filter((wordFound) => !new RegExp(`\\b${wordFound.replace(/s$/, "")}`, "i").test(allowed));
  checks.push({ id: "garments", ok: invented.length === 0, label: "Look lines", ...(invented.length > 0 ? { note: `invented: ${invented.join(", ")}` } : { note: "from the chosen look" }) });

  // (5) The Mood line carries no clothing.
  const moodClothes = input.mood === undefined ? false : GARMENT_WORDS.test(input.mood);
  checks.push({ id: "mood", ok: !moodClothes, label: "Mood", note: moodClothes ? "names clothing" : "light and colour only" });

  // (6) The closing lines are the app's: the references named and the identity line composed by the coordinator.
  checks.push({ id: "closing", ok: true, label: "Closing lines", note: "added by the app" });

  // (7) Every face in frame has its expression in the prompt, or is said to be turned away.
  const missing = held.inFrame.filter((person) => {
    const said = held.expressions[person.key];
    if (said === undefined || REFERENCE_FACE.test(said)) return true;
    if (/turned away|out of frame/i.test(said)) return !AWAY.test(held.prompt);
    return !expressionIn(held.prompt, said) || REFERENCE_FACE.test(held.prompt);
  });
  const away = held.inFrame.length === 0 ? (detail || held.details.length > 0 ? AWAY.test(held.prompt) : true) : true;
  checks.push({
    id: "expression",
    ok: missing.length === 0 && away,
    label: "Expression named",
    ...(missing.length > 0
      ? { note: missing.map((person) => `${person.name}: none`).join(", ") }
      : !away
        ? { note: "faces not said to be out of frame" }
        : held.inFrame.length === 0
          ? { note: detail || held.details.length > 0 ? "faces out of frame, said so" : "nobody in frame" }
          : { note: held.inFrame.map((person) => held.expressions[person.key]!).join("; ") }),
  });
  return checks;
}
