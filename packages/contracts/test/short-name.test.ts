import assert from "node:assert/strict";
import { test } from "node:test";
import { SheetSchema, characterLabels, defaultShortName, shortNameOf } from "../src/world.js";

/**
 * A character's short name (design turn 194, rule 12b): the quoted nickname, else the first word;
 * the one written on the sheet when there is one; and the full names where two would share it.
 */

const sheet = (id: string, name: string, shortName?: string, type: "character" | "location" = "character") =>
  ({ id, type, name, ...(shortName !== undefined ? { shortName } : {}) }) as const;

test("the default is the quoted nickname, in straight or curly quotes, else the first word", () => {
  assert.equal(defaultShortName('Adeyemi "Ade" Akinola'), "Ade");
  assert.equal(defaultShortName("Adeyemi “Ade” Akinola"), "Ade");
  assert.equal(defaultShortName("Ife"), "Ife");
  assert.equal(defaultShortName("  Maren Kest "), "Maren");
  assert.equal(defaultShortName("Tunde O'Brien"), "Tunde", "an apostrophe is not a nickname");
  assert.equal(defaultShortName('"" Nobody'), '""', "an empty pair of quotes names no one: the first word stands");
});

test("a short name written on the sheet wins, and an empty one is the default", () => {
  assert.equal(shortNameOf(sheet("a", 'Adeyemi "Ade" Akinola', "Yemi")), "Yemi");
  assert.equal(shortNameOf(sheet("a", 'Adeyemi "Ade" Akinola', "   ")), "Ade");
  assert.equal(shortNameOf(sheet("a", "Ife")), "Ife");
});

test("two characters who would share a short name both go by their full names", () => {
  const labels = characterLabels([sheet("ade", 'Adeyemi "Ade" Akinola'), sheet("ife", "Ife"), sheet("ade-b", "Ade Bello"), sheet("vigil", "The Vigil", undefined, "location")]);
  assert.deepEqual(labels.get("ade"), { label: 'Adeyemi "Ade" Akinola', full: 'Adeyemi "Ade" Akinola' });
  assert.deepEqual(labels.get("ade-b"), { label: "Ade Bello", full: "Ade Bello" });
  assert.deepEqual(labels.get("ife"), { label: "Ife", full: "Ife" }, "the others keep theirs");
  assert.equal(labels.has("vigil"), false, "only characters are named this way");
  assert.equal(characterLabels([sheet("a", "Ade Bello", "ade"), sheet("b", 'Adeyemi "Ade" Akinola')]).get("a")?.label, "Ade Bello", "case does not tell two apart");
});

test("a sheet with a short name is still a sheet, and one without is unchanged", () => {
  const base = { id: "ade", type: "character", name: "Ade", version: 1, status: "sketch", canonRules: [], links: [], created: "2026-10-04", updated: "2026-10-04", sections: [] };
  assert.equal(SheetSchema.parse({ ...base, shortName: "A" }).shortName, "A");
  assert.equal(SheetSchema.parse(base).shortName, undefined);
});
