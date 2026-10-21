import assert from "node:assert/strict";
import { it } from "node:test";
import { linkLookCharacter, lookCharacterHash, type AudiobookLook } from "../src/audiobook-look.js";
const held: AudiobookLook = { chapterHash: "words", at: "2026-10-21T00:00:00Z", characters: { rena: { name: "Rena", text: "An oilskin coat.", blocks: ["p1", "p3"], by: "author" } } };
const input = { key: "rena", expectedName: "Rena", expectedHash: lookCharacterHash(held.characters.rena!), sheet: { id: "maren-kest", name: "Maren Kest" } };
it("links identical words to an explicit sheet, preserving evidence and the original record", () => {
  const before = structuredClone(held); const linked = linkLookCharacter(held, input, "2026-10-21T00:01:00Z");
  assert.equal(linked.characters.rena, undefined);
  assert.deepEqual(linked.characters["maren-kest"], { ...held.characters.rena, sheet: "maren-kest" });
  assert.equal(linked.chapterHash, held.chapterHash); assert.deepEqual(held, before);
});
it("refuses stale names or words, linked sources and authored target collisions", () => {
  assert.throws(() => linkLookCharacter(held, { ...input, expectedName: "Someone else" }, held.at), /changed/);
  const changed = structuredClone(held); changed.characters.rena!.text = "A red coat.";
  assert.throws(() => linkLookCharacter(changed, input, held.at), /changed/);
  const collision = structuredClone(held); collision.characters["maren-kest"] = { name: "Maren Kest", sheet: "maren-kest", text: "The existing line." };
  assert.throws(() => linkLookCharacter(collision, input, held.at), /already has a line/);
  const linked = structuredClone(held); linked.characters.rena!.sheet = "bray-half-hitch";
  assert.throws(() => linkLookCharacter(linked, { ...input, expectedHash: lookCharacterHash(linked.characters.rena!) }, held.at), /already has an identity/);
});
