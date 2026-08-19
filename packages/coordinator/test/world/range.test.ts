import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseByteRange } from "../../src/transport.js";

/**
 * `Range` on the media route. Without it a `<video>` reports `seekable` as empty and refuses
 * every `currentTime` assignment — playback runs, scrubbing silently does nothing, and no error
 * is raised anywhere. Found by scrubbing the Cut screen in the running app, not by a test.
 */

describe("byte ranges on world media", () => {
  it("passes an unranged request through whole", () => {
    assert.equal(parseByteRange(undefined, 1000), null);
    assert.equal(parseByteRange("bytes=-", 1000), null, "no bound either side is not a range");
    assert.equal(parseByteRange("items=0-10", 1000), null, "a unit we do not serve is not a range");
  });

  it("reads the ordinary window a media element asks for", () => {
    assert.deepEqual(parseByteRange("bytes=0-499", 1000), { start: 0, end: 499 });
    assert.deepEqual(parseByteRange("bytes=500-999", 1000), { start: 500, end: 999 });
  });

  it("treats an open end as the rest of the file — the form a seek actually sends", () => {
    assert.deepEqual(parseByteRange("bytes=500-", 1000), { start: 500, end: 999 });
  });

  it("clamps an end past the file rather than refusing it", () => {
    assert.deepEqual(parseByteRange("bytes=900-5000", 1000), { start: 900, end: 999 });
  });

  it("reads a suffix range backwards from the end, which is the one that inverts", () => {
    // `bytes=-200` is the LAST 200 bytes. Read as "0 to 200" it serves the file's head as if it
    // were its tail, and a player looking for the moov atom finds nothing.
    assert.deepEqual(parseByteRange("bytes=-200", 1000), { start: 800, end: 999 });
    assert.deepEqual(parseByteRange("bytes=-5000", 1000), { start: 0, end: 999 }, "longer than the file is the file");
  });

  it("refuses what cannot be served, so the route can answer 416", () => {
    assert.equal(parseByteRange("bytes=1000-1100", 1000), "unsatisfiable", "starts past the end");
    assert.equal(parseByteRange("bytes=600-500", 1000), "unsatisfiable", "ends before it starts");
    assert.equal(parseByteRange("bytes=-0", 1000), "unsatisfiable", "the last zero bytes");
  });

  it("tolerates whitespace, since headers arrive as they were written", () => {
    assert.deepEqual(parseByteRange("  bytes=10-20  ", 1000), { start: 10, end: 20 });
  });
});
