import assert from "node:assert/strict";
import { test } from "node:test";
import { namedWithoutCitation, resolveCast } from "../src/planning.js";
import { WORLD_ACTION_DESCRIPTIONS } from "../src/world-chat.js";
import type { Sheet } from "../src/world.js";

/**
 * Who a shot names in plain words and does not cite (issue 3155). Arke wrote "Timi J on his dark
 * set" and "Ade small at the frame edge" for six sections of a music video, and each frame went out
 * with no picture of either: a mention is the only thing that sends one. These are the rules the
 * card and the frame dialog say it by.
 */

function sheet(id: string, name: string, extra: Partial<Sheet> = {}): Sheet {
  return {
    id, type: "character", name, version: 1, status: "sketch", canonRules: [], links: [],
    created: "2026-11-15", updated: "2026-11-15", sections: [], ...extra,
  };
}

const SHEETS: Sheet[] = [
  sheet("timi-j", "Timi J"),
  sheet("adeyemi-ade-akinola", 'Adeyemi "Ade" Akinola'),
  sheet("ife", "Ife"),
  sheet("mrs-abosede-akinola", "Mrs. Abosede Akinola"),
  sheet("the-dancer", "The Dancer"),
  sheet("the-lady-in-white", "The Lady in White", { shortName: "The Lady" }),
  sheet("timi-j-s-dark-set", "Timi J's Dark Set", { type: "location" }),
  sheet("ade-s-house-ikoyi", "Ade's House, Ikoyi", { type: "location" }),
  sheet("the-ebb-council", "The Ebb Council", { type: "faction" }),
];

const names = (description: string, sheets: Sheet[] = SHEETS, riding?: ReadonlySet<string>) =>
  namedWithoutCitation(description, sheets, riding).map(({ sheet, name }) => `${sheet.id}:${name}`);

test("the shots that went out with no picture: a full name and the nickname a name quotes", () => {
  assert.deepEqual(names("Timi J on his dark set, saxophone held low, singing into the lens."), ["timi-j:Timi J"]);
  assert.deepEqual(names("Photo-real wide of a rooftop party. Ade small at the frame edge, holding two drinks."), ["adeyemi-ade-akinola:Ade"]);
  assert.deepEqual(names("Ife on the rooftop laughing; over her shoulder Ade's face does not move."), ["ife:Ife", "adeyemi-ade-akinola:Ade"], "in the order they are named");
  // The same shots as Arke rewrote them: everyone cited, nobody left to name.
  assert.deepEqual(names("@ife on the rooftop laughing; over her shoulder @adeyemi-ade-akinola's face does not move."), []);
  assert.deepEqual(resolveCast("Timi J on his dark set.", SHEETS).cast, [], "mentions stay the one cast list (SPEC-012 R-9)");
});

test("a sheet cited anywhere in the description is not named without citation", () => {
  assert.deepEqual(names("@ife turns; Ife's hand finds her collarbone."), []);
});

test("whole words with their capitals, never part of another word", () => {
  assert.deepEqual(names("Life on the lifeline; the ife of it; Ifeoma waits."), []);
  assert.deepEqual(names("Ife's hand, Ife-like stillness."), ["ife:Ife"], "a possessive and a hyphen still name her");
  assert.deepEqual(names("timi j hums."), [], "a name is matched with its capitals");
  assert.deepEqual(names("Timi\nJ hums."), ["timi-j:Timi J"], "the space inside a name may be any space");
});

test("the longer name keeps its words: a place named for a person is the place", () => {
  assert.deepEqual(names("Wide on Timi J's Dark Set, empty."), ["timi-j-s-dark-set:Timi J's Dark Set"]);
  assert.deepEqual(names("@timi-j-s-dark-set at night: Timi J's Dark Set stands empty."), [], "the cited place still covers its words");
  assert.deepEqual(names("Ade's House, Ikoyi at night; Ade at the door."), ["ade-s-house-ikoyi:Ade's House, Ikoyi", "adeyemi-ade-akinola:Ade"]);
});

test("what rides whatever the text says is not flagged: the scene's own place", () => {
  assert.deepEqual(names("Wide on Timi J's Dark Set, empty.", SHEETS, new Set(["timi-j-s-dark-set"])), []);
});

test("a written short name and an authored alias count; the first-word default never does", () => {
  assert.deepEqual(names("The Lady turns from the window."), ["the-lady-in-white:The Lady"]);
  assert.deepEqual(names("Bimpe at the stall.", [...SHEETS, sheet("tinuke", "Tinuke Lawal", { aliases: ["Bimpe"] })]), ["tinuke:Bimpe"]);
  assert.deepEqual(names("Mrs. Lawal arrives. The light falls on the floor."), [], "\"Mrs.\" and \"The\" are nobody");
  assert.deepEqual(names("Mrs. Abosede Akinola arrives."), ["mrs-abosede-akinola:Mrs. Abosede Akinola"]);
});

test("a short name two sheets share names neither, while each full name still names its own", () => {
  const sheets = [...SHEETS, sheet("ade-bello", "Ade Bello", { shortName: "Ade" })];
  assert.deepEqual(names("Ade at the door.", sheets), []);
  assert.deepEqual(names("Ade Bello at the door.", sheets), ["ade-bello:Ade Bello"]);
  const owner = [...SHEETS, sheet("ade", "Ade")];
  assert.deepEqual(names("Ade at the door.", owner), ["ade:Ade"], "a sheet whose whole name it is keeps it");
});

test("Arke is told, where it adds and edits shots, to cite everyone with a sheet", () => {
  // The shot proposition and the scene draft already said so; the scene command, which is how a
  // turn adds a music video's shots, did not, and from chorus 1 on its shots named people plainly.
  assert.match(WORLD_ACTION_DESCRIPTIONS["production-scene-command"], /cites every person and place that has a sheet with @id/);
  assert.match(WORLD_ACTION_DESCRIPTIONS["production-scene-command"], /a name written plainly sends no picture of them/);
});

test("retired sheets, characters never pictured and factions are not flagged", () => {
  const sheets = [
    sheet("kemi", "Kemi", { retired: true }),
    sheet("the-voice", "The Voice", { neverDepicted: true }),
    ...SHEETS,
  ];
  assert.deepEqual(names("Kemi waits while The Voice speaks to The Ebb Council.", sheets), []);
});
