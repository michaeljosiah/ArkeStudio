import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClientState } from "@arke-studio/contracts";
import { scenePlayerBeats } from "../src/screens/branch-map.js";
import { shotFramePath } from "../src/screens/scene-workspace/boards.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A visual novel's preview reads its scenes as beats (turn 172): the picture a shot shows in the
 * rows, its covered lines under their speakers' names, and the table read's voice where there is
 * one — through the same `playerBeats` the export builds its package from.
 */
describe("a visual novel's scene in the preview", () => {
  it("carries each beat's picture, line, speaker's name and prepared voice", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const world = state.world!;
    const production = world.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as {
      script?: unknown;
      shots: Array<{ id: string; covers?: unknown; beat?: unknown }>;
    };
    scene.script = {
      blocks: [
        { id: "blk_wash", kind: "action", text: "They hung the washing out." },
        { id: "blk_verse", kind: "dialogue", speaker: "maren-kest", text: "The verse, under the water." },
      ],
    };
    scene.shots[0]!.covers = [{ blockId: "blk_wash", textDigest: "sha256:12345678" }, { blockId: "blk_verse", textDigest: "sha256:12345678" }];
    scene.shots[1]!.beat = { samePicture: true, advance: "hold", holdSec: 6 };
    // A visual novel accepts a picture, not footage: the fixture's frame take is sh_12's.
    production.selections.sh_12 = { acceptedTakeId: "tk_01J8A0000000000000000000A1", trimInSec: 0 };
    const voices = new Map([["sc_04/sh_12/blk_verse", ".cache/voice-previews/verse.mp3"]]);
    const beats = scenePlayerBeats(production, world.artifacts, world.sheets, world.meta.slug, production.scenes.find((c) => c.id === "sc_04")!, voices);
    const picture = shotFramePath(production, world.artifacts, "sh_12").path;
    assert.ok(picture, "the fixture's first shot has a picture");
    assert.equal(beats.length, 3);
    assert.equal(beats[0]!.text, "They hung the washing out.");
    assert.equal(beats[0]!.speaker, undefined, "narration names nobody");
    assert.equal(beats[0]!.audio, undefined, "an unvoiced line reads as text");
    assert.equal(beats[1]!.speaker, "Maren Kest");
    assert.match(beats[1]!.audio ?? "", /voice-previews\/verse\.mp3/);
    assert.equal(beats[2]!.text, undefined, "sh_13 covers nothing: the picture alone");
    assert.equal(beats[2]!.picture, beats[0]!.picture, "and keeps sh_12's picture");
    assert.deepEqual([beats[2]!.advance, beats[2]!.holdSec], ["hold", 6]);
  });
});
