import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { takeMediaFacts, type Take } from "../src/take.js";

describe("immutable take media facts (#1234)", () => {
  const take: Pick<Take, "kind" | "params" | "segment"> = {
    kind: "clip", params: { durationSec: 4, aspect: " 9 : 16 ", width: 720, height: 1280 },
  };

  it("uses measured media before saved generation settings", () => {
    assert.deepEqual(takeMediaFacts(take, { durationSec: 4.086, width: 1080, height: 1920 }), {
      durationSec: 4.086, dimensions: { width: 1080, height: 1920 }, aspect: "9:16",
    });
    assert.deepEqual(takeMediaFacts(take, { durationSec: Infinity, width: 0, height: 1920 }), {
      durationSec: 4, dimensions: { width: 720, height: 1280 }, aspect: "9:16",
    });
  });

  it("leaves absent or invalid facts unknown", () => {
    for (const params of [{}, { durationSec: "4", aspect: "bad", width: -1, height: 2 },
      { durationSec: NaN, aspect: "0:9", width: 1.5, height: 2 }]) {
      assert.deepEqual(takeMediaFacts({ kind: "clip", params }), {
        durationSec: undefined, dimensions: undefined, aspect: undefined,
      });
    }
  });

  it("labels a pass segment by its range rather than the backing file", () => {
    const segment = { passTakeId: "tk_01J8F0000000000000000000P1", inSec: 4, outSec: 9 };
    assert.equal(takeMediaFacts({ ...take, segment }, { durationSec: 20 }).durationSec, 5);
  });

  it("does not give stills a runtime from stale parameters", () => {
    for (const kind of ["still", "frame"] as const) {
      assert.equal(takeMediaFacts({ ...take, kind }, { durationSec: 8 }).durationSec, undefined);
    }
  });
});
