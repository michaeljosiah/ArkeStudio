import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retiredDispatchPath, retiredSceneChatPath } from "../src/App.js";

/**
 * Where the two retired addresses send a link. What the app does when one is opened — the scene
 * workspace for a scoped dispatch link, Generate for a bare one, the workspace with its shot for
 * an old Scene Chat link — is mounted and read in retired-routes.test.tsx.
 */

describe("the retired dispatch route (SPEC-036 R-30)", () => {
  it("returns scene-scoped links to the scene owner and bare links to Generate", () => {
    assert.equal(retiredDispatchPath("sc_04"), "../scenes/sc_04");
    assert.equal(retiredDispatchPath("scene with spaces"), "../scenes/scene%20with%20spaces");
    assert.equal(retiredDispatchPath(null), "../generate");
  });
});

describe("the retired Scene Chat route (SPEC-036 R-26)", () => {
  it("returns old conversation links to the scene workspace with their shot intact", () => {
    assert.equal(
      retiredSceneChatPath("world 1", "film 1", "scene 4", "shot 12"),
      "/w/world%201/p/film%201/scenes/scene%204?shot=shot%2012",
    );
    assert.equal(retiredSceneChatPath("w1", "p1", "sc_04"), "/w/w1/p/p1/scenes/sc_04");
  });
});
