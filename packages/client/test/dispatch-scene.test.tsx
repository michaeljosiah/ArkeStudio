import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { retiredDispatchPath } from "../src/App.js";
import { dispatchPath } from "../src/screens/production.js";

describe("the retired dispatch route (SPEC-036 R-30)", () => {
  it("returns scene-scoped links to the scene owner and bare links to Generate", () => {
    assert.equal(retiredDispatchPath("sc_04"), "../scenes/sc_04?workspace=1");
    assert.equal(retiredDispatchPath("scene with spaces"), "../scenes/scene%20with%20spaces?workspace=1");
    assert.equal(retiredDispatchPath(null), "../generate");
  });

  it("keeps old deep links alive as a redirect, never as the spending screen", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    assert.match(app, /path="generate\/dispatch" element=\{<RetiredDispatchRoute \/>\}/);
    assert.doesNotMatch(app, /<DispatchDialogScreen \/>/);
  });

  it("sends legacy shot-card generation links straight to the scene owner", () => {
    const storyboard = readFileSync(new URL("../src/screens/storyboard.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(storyboard, /\/generate\?shot=/);
    assert.match(storyboard, /\/scenes\/\$\{scene\.id\}\?workspace=1&shot=\$\{shot\.id\}/);
  });

  it("keeps the workspace owner when a filed report links back to its shot", () => {
    const conversation = readFileSync(new URL("../src/components/conversation.tsx", import.meta.url), "utf8");
    assert.match(conversation, /\/scenes\/\$\{m\.benchOutcome!\.sceneId\}\?workspace=1&shot=\$\{row\.shotId\}/);
  });
});

describe("legacy deep-link construction", () => {
  it("still carries the scene so the redirect can preserve its subject", () => {
    assert.equal(dispatchPath("w1", "p1", "sc_04"), "/w/w1/p/p1/generate/dispatch?scene=sc_04");
    assert.equal(dispatchPath("w1", "p1", null), "/w/w1/p/p1/generate/dispatch");
    assert.equal(dispatchPath("w1", "p1", undefined), "/w/w1/p/p1/generate/dispatch");
  });
});
