import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookViewFor, type PictureWho } from "@arke-studio/contracts";
import { BRIEF_EXAMPLES, briefRiders, briefRules, holdBrief, namedInText, pictureChecks, type RawBrief } from "../../src/productions/audiobook-picture-brief.js";
import { buildPicturePrompt } from "../../src/productions/audiobook-picture-suggest.js";
import type { ChapterPerson } from "../../src/productions/audiobook-look.js";

/**
 * The picture brief and the seven checks (design turn 193k, 193i; SPEC-047 R-120, R-121), on Na Love
 * or Juju chapter 1 as it was tested: the eyes, the two at the table and the hands. The keys are the
 * coordinator's, the prose the model's; who rides is who is in frame.
 */

const person = (key: string, name: string): ChapterPerson => ({ key, name, sheet: key, neverDepicted: false, first: 0 });
const PEOPLE = [person("ife", "Ife"), person("adeyemi-ade-akinola", "Ade"), person("tunde", "Tunde")];
const PLACES = [{ key: "club", name: "Club Velour" }];
const LINES = [
  { key: "ife", text: "She wears long knotless braids gathered off her neck in a low twist, a low-backed cream-gold silk slip dress, heavy old-gold hoop earrings and stacked old-gold bangles." },
  { key: "adeyemi-ade-akinola", text: "Ade wears an unstructured soft cream linen shirt open at the collar, a steel watch on his wrist, slim dark trousers." },
];
const MOOD = "Purple club light, warm gold, fine grain.";
const EYES_BLOCK = "Not round the room and then at him. Straight at him, as though she had known exactly where he was sitting. She held his eyes without smiling, long enough for him to understand it was a decision, and then she lifted her glass a fraction — not a toast, not quite — and turned back to her friends.";
const HANDS_BLOCK = "Her fingers rested just above his wrist, on the inside of the forearm where his sleeve had ridden up. Her bangles slid down and knocked against his watch, gold against steel.";

const EYES: RawBrief = {
  frame: "Extreme close-up, Ife's eyes",
  inFrame: ["ife"],
  expressions: { ife: "level, unsmiling, lips closed, the gaze held and deliberate" },
  details: [],
  notInFrame: ["ade", "tunde"],
  place: "club",
  prompt: "Extreme close-up on Ife's eyes and the upper half of her face, looking straight into the lens. Her expression is level and unsmiling, lips closed, the gaze held and deliberate, the look of a decision. Her braids are gathered up off her neck; a heavy old-gold hoop hangs at one ear. Purple club light on one cheek, the white flare of a sparkler soft and far behind her.",
};
const HANDS: RawBrief = {
  frame: "Detail, her fingers on his forearm",
  inFrame: [],
  expressions: {},
  details: [{ of: "ife", part: "hand", state: "fingers light and at ease" }, { of: "ade", part: "forearm", state: "still" }],
  notInFrame: [],
  place: "club",
  prompt: "Detail shot, tight on a woman's fingers resting on a man's forearm just above the wrist, where a pale linen sleeve has ridden up. Heavy gold bangles have slid down against the steel of his watch, gold touching steel. Shallow focus, purple club light on the skin, the room a dark blur. Hands and forearm only; both faces are out of frame. Her fingers rest light and at ease, his forearm still.",
};

const hold = (raw: RawBrief) => holdBrief(raw, { people: PEOPLE, places: PLACES, prompt: raw.prompt, fallback: () => [] });
const riding = (keys: string[]): PictureWho[] => keys.map((key) => ({ key, name: PEOPLE.find((p) => p.key === key)?.name ?? key, sheet: key, kind: "character", reference: `references/${key}/takes/tk_look/close.png`, carried: true, look: { lookId: "tk_look", view: "close" } }));
const checksOf = (raw: RawBrief, block: string, who = riding((raw.inFrame ?? []).map((key) => PEOPLE.find((p) => p.key === key || p.name.toLowerCase() === key)!.key)), mood = MOOD) => {
  const held = hold(raw);
  return Object.fromEntries(pictureChecks({ held, who, people: PEOPLE, lines: LINES, block, mood }).map((check) => [check.id, check]));
};

describe("the eyes: a close frame on her, without him (193i)", () => {
  it("keeps Ife in frame, Ade and Tunde out of it by the names the model used, and her expression", () => {
    const held = hold(EYES);
    assert.deepEqual(held.inFrame.map((p) => p.key), ["ife"]);
    assert.deepEqual(held.notInFrame, ["adeyemi-ade-akinola", "tunde"], "`ade` is Ade's name: taken for his sheet");
    assert.equal(held.frame, "Extreme close-up, Ife's eyes");
    assert.equal(lookViewFor(held.frame), "close", "her close view rides, not her main photo");
    assert.deepEqual(briefRiders(held).map((who) => who.key), ["ife", "club"], "only who is in frame rides");
    assert.equal(held.expressions["ife"], "level, unsmiling, lips closed, the gaze held and deliberate");
  });

  it("passes all seven checks", () => {
    const checks = checksOf(EYES, EYES_BLOCK);
    assert.deepEqual(Object.keys(checks), ["reference", "not-in-frame", "frame", "garments", "mood", "closing", "expression"]);
    for (const check of Object.values(checks)) assert.equal(check.ok, true, `${check.id}: ${check.note ?? ""}`);
    assert.equal(checks["reference"]!.label, "1 of 1 in frame has a reference");
    assert.equal(checks["not-in-frame"]!.note, "Ade, Tunde");
    assert.equal(checks["frame"]!.note, "Extreme close-up");
  });

  it("marks what turn 191 drafted: a wide shot over Ade's shoulder names him out of frame", () => {
    const before: RawBrief = { ...EYES, frame: "Extreme close-up, Ife's eyes", prompt: "Wide, over Ade's shoulder, Ife at her table across the floor, looking at him, level and unsmiling." };
    const checks = checksOf(before, EYES_BLOCK);
    assert.equal(checks["not-in-frame"]!.ok, false);
    assert.equal(checks["not-in-frame"]!.note, "names Ade");
    assert.equal(checks["frame"]!.ok, false, "the field says a close-up; the prompt opens wide");
    assert.equal(checks["frame"]!.note, "prompt opens Wide");
  });
});

describe("the hands: detail owners carry identity references (#1677)", () => {
  it("has no full person in frame and carries the detail owners without the place", () => {
    const held = hold(HANDS);
    assert.deepEqual(held.inFrame, []);
    assert.deepEqual(held.details.map((d) => [d.of, d.part]), [["ife", "hand"], ["adeyemi-ade-akinola", "forearm"]]);
    assert.deepEqual(briefRiders(held).map((who) => who.key), ["ife", "adeyemi-ade-akinola"]);
  });

  it("is a detail on the card with its faces said to be out of frame", () => {
    const checks = checksOf(HANDS, HANDS_BLOCK, riding(["ife", "adeyemi-ade-akinola"]));
    assert.equal(checks["reference"]!.ok, true);
    assert.equal(checks["reference"]!.label, "2 of 2 shown in detail have a reference");
    assert.equal(checks["reference"]!.note, undefined);
    assert.equal(checks["expression"]!.ok, true);
    assert.equal(checks["expression"]!.note, "faces out of frame, said so");
    assert.equal(checks["garments"]!.ok, true, "bangles, the watch and the sleeve are the looks' and the block's");
  });

  it("marks missing detail references instead of passing because inFrame is empty", () => {
    const check = checksOf(HANDS, HANDS_BLOCK, [])["reference"]!;
    assert.equal(check.ok, false);
    assert.match(check.note!, /Ife · no reference/);
  });

  it("keeps an unresolved relationship visible and does not guess a sheet", () => {
    const raw = { ...HANDS, details: [{ of: "her mother", part: "hand" }] };
    const held = hold(raw);
    assert.deepEqual(held.details, [{ of: "her mother", part: "hand" }]);
    assert.equal(briefRiders(held)[0]?.sheet, undefined);
    assert.match(checksOf(raw, HANDS_BLOCK, [])["reference"]!.note!, /identity not linked · confirm the character/);
  });

  it("uses a familiar name for its canonical detail owner and excludes never-depicted aliases", () => {
    const people = [{ ...person("maren", "Maren Kest"), aliases: ["Rena"] }, { ...person("lena", "Lena Kest"), aliases: ["Mother"], neverDepicted: true }];
    const held = holdBrief({ ...HANDS, details: [{ of: "Rena", part: "hand" }, { of: "Mother", part: "hand" }] }, { people, places: [], prompt: HANDS.prompt, fallback: () => [] });
    assert.deepEqual(held.details, [{ of: "maren", part: "hand" }]);
    assert.deepEqual(briefRiders(held).map((who) => [who.key, who.sheet]), [["maren", "maren"]]);
  });

  it("is marked when the prompt does not say the faces are out of frame", () => {
    const checks = checksOf({ ...HANDS, prompt: "Detail shot, tight on a woman's fingers on a man's forearm, gold bangles against the steel of his watch." }, HANDS_BLOCK, []);
    assert.equal(checks["expression"]!.ok, false);
  });
});

describe("expression named (check 7)", () => {
  it("marks a face with no expression, and one left to the reference", () => {
    assert.equal(checksOf({ ...EYES, expressions: {} }, EYES_BLOCK)["expression"]!.note, "Ife: none");
    assert.equal(checksOf({ ...EYES, expressions: { ife: "as in the reference" } }, EYES_BLOCK)["expression"]!.ok, false);
    assert.equal(checksOf({ ...EYES, expressions: { ife: "beaming, laughing openly" } }, EYES_BLOCK)["expression"]!.ok, false, "an expression the prompt never writes is not named");
  });

  it("takes a face turned away when the prompt says so", () => {
    const away: RawBrief = { frame: "Wide · from behind", inFrame: ["ife"], expressions: { ife: "face turned away" }, notInFrame: [], prompt: "Wide shot from behind Ife crossing the club floor, her face turned away from the camera, braids down her back." };
    assert.equal(checksOf(away, "She walked away across the floor.")["expression"]!.ok, true);
  });
});

describe("the other checks", () => {
  it("does not turn a shared surname into an off-camera relative, and still recognises familiar names", () => {
    const mother = { name: "Lena Kest", aliases: ["Len"] };
    assert.equal(namedInText("Close-up on Maren Kest's eyes.", mother), false);
    assert.equal(namedInText("Close-up on Lena's eyes.", mother), true);
    assert.equal(namedInText("Close-up on Len's eyes.", mother), true);
    assert.equal(namedInText("Close-up on Lena Kest's eyes.", mother), true);
  });

  it("shows a garment no look line and no word of the block gives as invented", () => {
    const checks = checksOf({ ...EYES, prompt: `${EYES.prompt} A lace-trimmed agbada hangs behind her.` }, EYES_BLOCK);
    assert.equal(checks["garments"]!.ok, false);
    assert.match(checks["garments"]!.note!, /agbada/);
  });

  it("marks a Mood line that names clothing", () => {
    assert.equal(checksOf(EYES, EYES_BLOCK, undefined, "Purple light, lace-trimmed agbada.")["mood"]!.ok, false);
  });

  it("marks a person in frame with no reference, and one named but in neither list", () => {
    const none = [{ ...riding(["ife"])[0]!, reference: null, carried: false, look: undefined }] as PictureWho[];
    assert.equal(checksOf(EYES, EYES_BLOCK, none)["reference"]!.note, "Ife · no reference");
    const stray = checksOf({ ...EYES, notInFrame: ["ade"], prompt: `${EYES.prompt} Tunde laughs at the bar.` }, EYES_BLOCK);
    assert.equal(stray["reference"]!.ok, false);
    assert.match(stray["reference"]!.note!, /Tunde/);
  });
});

describe("the brief the writing service is given (193k)", () => {
  it("is 193k's text: the answer's shape, the eight rules, the examples, then what it is given", () => {
    const prompt = buildPicturePrompt({
      title: "Na Love or Juju",
      mood: MOOD,
      synopsis: "Ade meets Ife at the club.",
      note: "Warm and teasing.",
      block: { key: "p34.0", text: EYES_BLOCK },
      before: "She looked at him.",
      lines: [{ label: "Place", key: null, text: "Club Velour, night." }, { label: "Ife", key: "ife", text: LINES[0]!.text, look: "Long knotless braids" }],
      people: [{ key: "ife", name: "Ife", essence: "A fixer." }],
      places: PLACES,
      never: [],
      maxChars: 900,
    });
    for (const part of [
      '"expressions": {"<key>"',
      "1. THE BLOCK IS THE PICTURE.",
      "5. NAME EVERY FACE'S EXPRESSION AND GAZE.",
      "at most 900 characters",
      "EXAMPLES (Na Love or Juju, chapter 1)",
      "## The book's mood (light, colour and grain only)\nPurple club light",
      "Warm and teasing.",
      'Place: Club Velour, night.\n[ife] Ife, look "Long knotless braids": She wears long knotless braids',
      "## The block [p34.0]",
    ]) assert.ok(prompt.includes(part), part);
    assert.match(buildPicturePrompt({ title: "t", block: { key: "p0.0", text: "x" }, lines: [], people: [], places: [], never: [], maxChars: 900, retry: "it names Ade" }), /Your previous response was rejected: it names Ade/);
  });

  // 0.5.60-local.14: in the hands detail her bangles were drawn on his wrist.
  it("tells a detail shot to say whose hand wears what, and its worked example does", () => {
    const rules = briefRules(900, []);
    assert.match(rules, /In a detail shot say whose hand wears what: every ring, bangle, watch or sleeve stays on the person whose line has it/);
    assert.match(rules, /"her hand, with her old-gold bangles, rests on his forearm above his steel watch"/);
    const hands = BRIEF_EXAMPLES.slice(BRIEF_EXAMPLES.indexOf("Block p64.0"));
    assert.match(hands, /Her hand, with her heavy old-gold bangles, rests on his forearm above his steel watch/);
    assert.doesNotMatch(hands, /Heavy gold bangles have slid down against the steel of his watch/, "never bangles left to float between two hands");
  });

  // 0.5.60-local.14: the club-table pictures of Ife were refused for "bare shoulders" and "low-backed slip dress" with the dress riding.
  it("tells the writing service to name clothes neutrally once a look image rides, and keeps the expression and frame rules", () => {
    const rules = briefRules(900, []);
    assert.match(rules, /that look's image rides and already carries the clothes: name each garment once, briefly and neutrally, by the garment and its colour \("her cream-gold silk evening dress"\)/);
    assert.match(rules, /Never write skin exposure, the cut of a garment or the body under it/);
    assert.match(rules, /2\. NAME THE FRAME FIRST\./);
    assert.match(rules, /5\. NAME EVERY FACE'S EXPRESSION AND GAZE\./);
  });
});
