import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderedShots, type WorldBundle } from "@arke-studio/contracts";
import { scanWorld } from "../../src/world/scan.js";
import { beforeShotNotes } from "../../src/world-chat/before-shot.js";
import { FIXTURE_WORLD } from "../world/helpers.js";

/** The before-the-shot checks a generation card carries (design turn 287), a line a shot with something to fix. */
describe("a generation card's before-the-shot notes", () => {
  async function world(edit: (shot: Record<string, unknown>) => Record<string, unknown>) {
    const scanned = (await scanWorld(FIXTURE_WORLD)).bundle;
    const production = scanned.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => orderedShots(candidate).length > 1)!;
    const shots = orderedShots(scene);
    const patched: WorldBundle = { ...scanned, productions: scanned.productions.map((candidate) => candidate.meta.id !== "saltlight" ? candidate : {
      ...candidate, meta: { ...candidate.meta, look: { camera: { kind: "handheld" } } },
      scenes: candidate.scenes.map((s) => s.id !== scene.id ? s : { ...s, defaults: undefined,
        shots: (s as { shots?: Array<Record<string, unknown>> }).shots?.map((shot) => shot["id"] === shots[1]!.id ? edit(shot) : shot) } as typeof s) }) };
    return { bundle: patched, sceneId: scene.id, first: shots[0]!.id, second: shots[1]!.id };
  }

  it("names the shot by its place in the scene and what it has to fix", async () => {
    const { bundle, sceneId, second } = await world((shot) => ({ ...shot, camera: "the camera is locked off" }));
    const [note] = beforeShotNotes(bundle, "saltlight", sceneId, [second], "video");
    assert.ok(note, "a shot with something to fix has a note");
    assert.match(note!, /^Shot 2 before it is made: /);
    assert.match(note!, /camera says locked off/);
    assert.match(note!, /light none named/);
  });

  it("asks a still only for its people and its light", async () => {
    const { bundle, sceneId, second } = await world((shot) => ({ ...shot, camera: "the camera is locked off" }));
    const [note] = beforeShotNotes(bundle, "saltlight", sceneId, [second], "image");
    assert.doesNotMatch(note ?? "", /camera|first frame|beat/);
    assert.match(note ?? "", /light none named/);
  });

  it("says nothing of a shot with nothing to fix, or one it cannot find", async () => {
    const { bundle, sceneId } = await world((shot) => shot);
    assert.deepEqual(beforeShotNotes(bundle, "saltlight", sceneId, ["sh_404"], "video"), []);
    assert.deepEqual(beforeShotNotes(bundle, "nowhere", sceneId, ["sh_12"], "video"), []);
  });
});
