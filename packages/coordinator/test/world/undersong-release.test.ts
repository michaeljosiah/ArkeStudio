import assert from "node:assert/strict";
import { it } from "node:test";
import { readdir } from "node:fs/promises";
import { UNDERSONG_RELEASE } from "../../src/world/undersong-release.js";
import { inspectStoryDownload } from "../../src/world/story-download.js";
import { storyDownloadRequiredBytes } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";

it("admits the pinned multipart release without downloading it or allocating story media", async () => {
  const root = await tempDir("story-pin-"), release = UNDERSONG_RELEASE;
  const status = await inspectStoryDownload(release, root);
  assert.equal(status.requiredBytes, storyDownloadRequiredBytes(release));
  assert.equal(status.hasRetainedData, false);
  assert.ok(release.parts && release.parts.length > 1);
  release.parts.forEach((part, index) => assert.equal(part.url,
    `https://github.com/michaeljosiah/ArkeStudio/releases/download/undersong-${release.version}/undersong-${release.version}.zip.part-${String(index + 1).padStart(3, "0")}`));
  assert.match(release.summary, /listening qualification pending/i);
  assert.match(release.summary, /video paused unfinished/i);
  assert.deepEqual(await readdir(root), []);
});
