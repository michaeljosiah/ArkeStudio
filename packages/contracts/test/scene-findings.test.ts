import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sceneFindings } from "../src/scene-findings.js";
import type { Scene, Shot } from "../src/scene.js";

/**
 * The scene's own review (design turn 102). Nothing here blocks, nothing is stored, and every
 * finding is a sentence naming the shot it is about — the shape the season's findings already
 * hold, one level down.
 */

function shot(over: Partial<Shot> & { id: string; number: number }): Shot {
  return { title: `Shot ${over.number}`, description: "Something happens.", ...over } as Shot;
}

function scene(shots: Shot[], defaults?: Scene["defaults"]): Scene {
  return {
    id: "sc_01",
    number: 1,
    slug: "the-vigil",
    title: "The vigil",
    shots,
    ...(defaults ? { defaults } : {}),
  } as Scene;
}

describe("what a scene can say about itself before an agent reads it", () => {
  it("a scene with no shots says that and nothing else", () => {
    const found = sceneFindings(scene([]));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.kind, "no-shots");
    assert.match(found[0]!.message, /no shots yet/);
  });

  it("names a shot with nothing written, and leaves a written one alone", () => {
    const found = sceneFindings(
      scene([shot({ id: "sh_1", number: 1, description: "  " }), shot({ id: "sh_2", number: 2 })]),
    );
    assert.deepEqual(
      found.map((f) => f.kind),
      ["empty-shot"],
    );
    assert.equal(found[0]!.about, "sh_1");
    assert.match(found[0]!.message, /^Shot 1 has nothing written\.$/);
  });

  it("a prompt written by hand is something written, even with no script", () => {
    const found = sceneFindings(
      scene([
        shot({
          id: "sh_1",
          number: 1,
          description: "",
          promptOverride: { text: "Wide, the door.", sheetVersions: {} },
        }),
      ]),
    );
    assert.deepEqual(found, [], "there is something to generate from");
  });

  it("says which shot moved after it was read, from the digests the caller computed", () => {
    const found = sceneFindings(
      scene([shot({ id: "sh_1", number: 1 }), shot({ id: "sh_2", number: 2 })]),
      ["sh_2"],
    );
    assert.deepEqual(
      found.map((f) => [f.kind, f.about]),
      [["stale-coverage", "sh_2"]],
    );
  });

  it("flags neighbours framed identically, and only neighbours", () => {
    const wide = { framing: { size: "wide" } };
    const found = sceneFindings(
      scene([
        shot({ id: "sh_1", number: 1, ...wide }),
        shot({ id: "sh_2", number: 2, framing: { size: "close-up" } }),
        shot({ id: "sh_3", number: 3, ...wide }),
      ] as Shot[]),
    );
    // A scene may legitimately return to a wide; two in a row is the case worth saying.
    assert.deepEqual(found, [], "1 and 3 are both wide, and that is allowed");

    const adjacent = sceneFindings(
      scene([shot({ id: "sh_1", number: 1, ...wide }), shot({ id: "sh_2", number: 2, ...wide })] as Shot[]),
    );
    assert.deepEqual(
      adjacent.map((f) => f.kind),
      ["repeated-framing"],
    );
    assert.match(adjacent[0]!.message, /Shot 1 and Shot 2 are both wide\./);
  });

  it("reads the scene's own framing default, so an unset shot is not silently different", () => {
    const found = sceneFindings(
      scene(
        [shot({ id: "sh_1", number: 1 }), shot({ id: "sh_2", number: 2 })],
        { size: "medium" } as Scene["defaults"],
      ),
    );
    assert.deepEqual(
      found.map((f) => f.kind),
      ["repeated-framing"],
      "both inherit medium, so both are medium",
    );
  });

  it("says nothing about a scene that is simply finished", () => {
    assert.deepEqual(
      sceneFindings(
        scene([
          shot({ id: "sh_1", number: 1, framing: { size: "wide" } }),
          shot({ id: "sh_2", number: 2, framing: { size: "close-up" } }),
        ] as Shot[]),
      ),
      [],
    );
  });
});
