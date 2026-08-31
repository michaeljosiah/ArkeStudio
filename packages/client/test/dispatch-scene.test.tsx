import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { retiredDispatchPath, retiredSceneChatPath } from "../src/App.js";

describe("the retired dispatch route (SPEC-036 R-30)", () => {
  it("returns scene-scoped links to the scene owner and bare links to Generate", () => {
    assert.equal(retiredDispatchPath("sc_04"), "../scenes/sc_04");
    assert.equal(retiredDispatchPath("scene with spaces"), "../scenes/scene%20with%20spaces");
    assert.equal(retiredDispatchPath(null), "../generate");
  });

  it("keeps old deep links alive as a redirect, never as the spending screen", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    assert.match(app, /path="generate\/dispatch" element=\{<RetiredDispatchRoute \/>\}/);
    assert.doesNotMatch(app, /<DispatchDialogScreen \/>/);
  });

  it("keeps generation on the workspace's singular shot row, without a rollout query", () => {
    const rows = readFileSync(new URL("../src/screens/scene-workspace/rows.tsx", import.meta.url), "utf8");
    assert.match(rows, /onOpenInGenerator=\{\(\) => onOpenShotInGenerator\(shot\.id\)\}/);
    assert.doesNotMatch(rows, /workspace=1/);
  });

  it("keeps the workspace owner when a filed report links back to its shot", () => {
    const conversation = readFileSync(new URL("../src/components/conversation.tsx", import.meta.url), "utf8");
    assert.match(conversation, /\/scenes\/\$\{sceneId\}\?shot=\$\{shotId\}/);
    assert.doesNotMatch(conversation, /\/scenes\/\$\{sceneId\}\?workspace=1/);
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

  it("keeps only the redirect at the old address and sends in-app entry points to the owner", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const production = readFileSync(new URL("../src/screens/production.tsx", import.meta.url), "utf8");
    assert.match(app, /path="story\/scenes\/:sceneId" element=\{<RetiredSceneChatRoute \/>\}/);
    assert.doesNotMatch(app, /<SceneChatScreen \/>/);
    assert.match(production, /navigate\(`\/w\/\$\{worldId\}\/p\/\$\{prodId\}\/scenes\/\$\{scene\.id\}`\)/);
    assert.match(production, /return <SceneWorkspace key=/);
    assert.match(production, /world=\{world\} production=\{production\} scene=\{record\} \/>/);
    assert.doesNotMatch(production, /workspace=1/);
  });
});
