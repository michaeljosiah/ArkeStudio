import assert from "node:assert/strict";
import { it } from "node:test";
import { CharacterLookSchema, lookName } from "../src/reference.js";

const look = { id: "look-000001", kind: "costume" as const, file: "looks/coat.png", prompt: "Hair first. A charcoal coat, pale shirt and boots.", acceptedAt: "2026-10-10T10:10:10.000Z" };
it("keeps optional names separate from prompts and accepts old kits without one", () => {
  assert.deepEqual(CharacterLookSchema.parse(look), look);
  const named = CharacterLookSchema.parse({ ...look, name: "  Charcoal coat  " });
  assert.equal(named.name, "Charcoal coat");
  assert.equal(named.prompt, look.prompt);
  assert.equal(lookName(named), "Charcoal coat");
  assert.equal(CharacterLookSchema.safeParse({ ...look, name: " " }).success, false);
  assert.equal(CharacterLookSchema.safeParse({ ...look, name: "x".repeat(61) }).success, false);
});
it("distinguishes legacy looks accepted in the same displayed minute without inventing an outfit", () => {
  const other = { ...look, id: "look-000002", acceptedAt: "2026-10-10T10:10:20.000Z" };
  assert.match(lookName(look), /^Look · 10 Oct 2026/);
  assert.doesNotMatch(lookName(look), /Hair|charcoal|000001/);
  assert.match(lookName(look, [look, other]), / · 000001$/);
  assert.match(lookName(other, [look, other]), / · 000002$/);
  assert.doesNotMatch(lookName(look, [look, { ...other, name: "Other coat" }]), /000001/);
});
