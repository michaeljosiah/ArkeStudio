import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARTIFACT_POSTER_DIR, artifactPicturePath, artifactPosterPath } from "../src/index.js";

/**
 * The one spelling of an artifact's picture (issue 1037): the coordinator writes to it and the
 * client asks for it, and both import it from here rather than each keeping a copy.
 */
describe("an artifact's picture", () => {
  it("names a video's poster by its id under the derived index, a still by itself, and nothing for sound", () => {
    assert.equal(ARTIFACT_POSTER_DIR, ".index/posters");
    assert.equal(artifactPosterPath("ar_01J8G0000000000000000000R2"), ".index/posters/ar_01J8G0000000000000000000R2.png");
    assert.equal(artifactPicturePath({ id: "ar_1", kind: "video", file: "clip.mkv" }), ".index/posters/ar_1.png", "a video, whatever its container");
    assert.equal(artifactPicturePath({ id: "ar_2", kind: "image", file: "plate.png" }), "artifacts/plate.png");
    assert.equal(artifactPicturePath({ id: "ar_2", kind: "board", file: "board.png" }), "artifacts/board.png");
    assert.equal(artifactPicturePath({ id: "ar_3", kind: "audio", file: "song.wav" }), null);
    assert.equal(artifactPicturePath({ id: "ar_4", kind: "document", file: "notes.md" }), null);
  });
});
