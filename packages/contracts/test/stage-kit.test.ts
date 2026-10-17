import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandStageSet, expandStageSets, STAGE_KIT_KINDS, STAGE_KIT_SIZES, StagingSetSchema, type StagingSet } from "../src/index.js";

/** The set kit (issue 1819, design turn 228e): one entry, expanded into primitives every renderer shares. */

const lobby: StagingSet = {
  name: "lobby", x: 0, z: 0, w: 8, h: 5, d: 12,
  kit: { kind: "room", open: ["front"], openings: [{ wall: "right", kind: "door", at: -2, w: 1.2, h: 2.3 }, { wall: "left", kind: "glass", at: 0, w: 10, h: 4.5, sill: 0 }] },
};
const part = (set: StagingSet, name: string) => expandStageSet(set).find((candidate) => candidate.name === `${set.name} · ${name}`);

describe("the set kit (issue 1819)", () => {
  it("builds a room from walls that meet, with no wall on an open side", () => {
    const parts = expandStageSet(lobby);
    assert.equal(parts.some((candidate) => candidate.name.includes("front wall")), false, "the camera's side is open");
    const back = part(lobby, "back wall")!;
    assert.equal(back.w, 8, "the back wall spans the room's width");
    assert.equal(back.z, -6);
    assert.ok(part(lobby, "floor"), "and stands on a floor");
  });

  it("cuts each opening out of its wall, with a header above a door and glass in a glazed opening", () => {
    const right = expandStageSet(lobby).filter((candidate) => candidate.name.startsWith("lobby · right wall"));
    // The door is 1.2 m wide at -2 m along the wall: no wall piece may stand inside it below its head.
    for (const piece of right) {
      const from = piece.z - piece.d / 2, to = piece.z + piece.d / 2;
      const inside = from < -2 + .6 - 1e-9 && to > -2 - .6 + 1e-9;
      if (inside) assert.ok((piece.y ?? 0) >= 2.3 - 1e-9, `${piece.name} stands in the doorway`);
    }
    assert.ok(right.some((piece) => (piece.y ?? 0) >= 2.3 - 1e-9), "a header closes the wall above the door");
    const glass = expandStageSet(lobby).find((candidate) => candidate.name === "lobby · left wall glass");
    assert.ok(glass, "glass fills a glazed opening");
    assert.equal(glass.solid, false, "and the camera sees through it");
    assert.equal(glass.surface, "glass");
  });

  it("turns its parts with the item and keeps them inside the set budgets", () => {
    const turned = expandStageSet({ name: "sofa", x: 2, z: 1, w: 2, h: .85, d: .9, rotation: [0, 90, 0], kit: { kind: "sofa" } });
    const back = turned.find((candidate) => candidate.name === "sofa · back")!;
    // Unturned the back is behind the seat (−z); a quarter turn about +Y puts it toward −x.
    assert.ok(back.x < 2 && Math.abs(back.z - 1) < 1e-9, "the back turns with the sofa");
    for (const kind of STAGE_KIT_KINDS) {
      const [w, h, d] = STAGE_KIT_SIZES[kind];
      for (const piece of expandStageSet({ name: kind, x: 0, z: 0, w, h, d, kit: { kind, ...(kind === "table" ? { seats: 4 } : {}) } })) {
        const { surface: _surface, ...plain } = piece;
        assert.ok(StagingSetSchema.safeParse(plain).success, `${piece.name} is an ordinary set entry`);
        assert.ok(piece.w > 0 && piece.h > 0 && piece.d > 0);
      }
    }
  });

  it("keeps a plain set as itself and numbers every part by the entry it came from", () => {
    const plain: StagingSet = { name: "desk", x: 0, z: 0, w: 1, h: .75, d: .6 };
    assert.deepEqual(expandStageSet(plain).map(({ surface: _surface, ...rest }) => rest), [plain]);
    const all = expandStageSets([plain, lobby]);
    assert.equal(all[0]!.index, 0);
    assert.ok(all.slice(1).every((candidate) => candidate.index === 1));
  });
});
