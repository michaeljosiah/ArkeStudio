import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sheet } from "@arke-studio/contracts";
import { mainPhotoPromptFor } from "../src/screens/character-reference.js";

function character(overrides: Partial<Sheet> = {}): Sheet {
  return {
    id: "iona-vale",
    type: "character",
    name: "Iona Vale",
    role: "Lockkeeper",
    version: 1,
    status: "sketch",
    canonRules: [],
    links: [],
    created: "2026-08-04",
    updated: "2026-08-04",
    sections: [{ heading: "Appearance", body: "Cropped copper hair and a brass lock badge." }],
    ...overrides,
  };
}

describe("main-photo prompt", () => {
  it("uses the active character's name, role, and visible traits", () => {
    const prompt = mainPhotoPromptFor(character());
    assert.match(prompt, /Iona Vale/);
    assert.match(prompt, /Lockkeeper/);
    assert.match(prompt, /Cropped copper hair/);
    assert.doesNotMatch(prompt, /Maren|her salt-worn|wet braids/);
  });

  it("stays neutral and useful when appearance and role are absent", () => {
    const prompt = mainPhotoPromptFor(character({ name: "The Witness", role: undefined, sections: [] }));
    assert.match(prompt, /The Witness/);
    assert.match(prompt, /established physical identity/);
    assert.doesNotMatch(prompt, /\b(?:he|she|his|her)\b/i);
  });
});
