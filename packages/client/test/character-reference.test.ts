import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sheet } from "@arke-studio/contracts";
import { mainPhotoPromptFor } from "../src/screens/character-reference.js";
import {
  __applyEventForTest,
  __mainPhotoAcceptanceForTest,
  __setStateForTest,
  chooseAnchor,
} from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

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

describe("main-photo acceptance feedback", () => {
  it("moves from pending to a safe retryable failure", () => {
    __setStateForTest(FIXTURE_STATE);
    chooseAnchor(FIXTURE_STATE.world!.meta.worldId, "maren-kest", {
      source: "candidate",
      file: "upload-test.png",
    });
    assert.equal(__mainPhotoAcceptanceForTest()["maren-kest"]?.status, null);
    __applyEventForTest({
      at: "2026-08-04T08:00:00Z",
      type: "main-photo.acceptance",
      worldId: FIXTURE_STATE.world!.meta.worldId,
      sheetId: "maren-kest",
      status: "failed",
      reason: "The main photo was not changed. The candidate is still here; try again.",
      candidateRetained: true,
    });
    const result = __mainPhotoAcceptanceForTest()["maren-kest"];
    assert.equal(result?.status, "failed");
    assert.equal(result?.candidateRetained, true);
    assert.match(result?.reason ?? "", /try again/);
  });
});
