import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPerformanceSpool } from "../src/performance-spool.js";
import { microphoneAllowed } from "../src/microphone-permission.js";

it("performance capture grants only the exact studio top-level microphone request", () => {
  for (const rendererUrl of ["file:///C:/Arke/client/index.html", "http://localhost:5173/"]) {
    const input = { permission: "media", sameWebContents: true, isMainFrame: true, requestingUrl: rendererUrl,
      rendererUrl, mediaTypes: ["audio"] };
    assert.equal(microphoneAllowed(input), true);
    for (const change of [{ mediaTypes: ["audio", "video"] }, { mediaTypes: [] }, { isMainFrame: false },
      { sameWebContents: false }, { requestingUrl: "https://example.com/" }, { permission: "geolocation" }]) {
      assert.equal(microphoneAllowed({ ...input, ...change }), false);
    }
  }
  assert.equal(microphoneAllowed({ permission: "media", sameWebContents: true, isMainFrame: true,
    rendererUrl: "file:///C:/Arke/client/index.html", requestingUrl: "file:///C:/other.html", mediaTypes: ["audio"] }), false);
});
it("opaque performance spools validate bytes, allow one claim and forget prior-process claims", async t => {
  const root = await mkdtemp(join(tmpdir(), "arke-performance-spool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spool = createPerformanceSpool(root);
  assert.equal((await spool.stage({ bytes: new Uint8Array(), contentType: "audio/webm" })).ok, false);
  assert.equal((await spool.stage({ bytes: "encoded", contentType: "audio/webm" })).ok, false);
  assert.equal((await spool.stage({ bytes: new Uint8Array([1]), contentType: "video/mp4" })).ok, false);
  const result = await spool.stage({ name: "../../escape", contentType: "audio/webm;codecs=opus", bytes: new Uint8Array([1, 2, 3]) });
  assert.ok(result.ok);
  const claimed = await spool.claim(result.spoolId); assert.ok(claimed);
  assert.deepEqual(await readFile(claimed.absolutePath), Buffer.from([1, 2, 3]));
  assert.equal(await spool.claim(result.spoolId), null);
  assert.equal(await createPerformanceSpool(root).claim(result.spoolId), null);
  await assert.rejects(readFile(claimed.absolutePath));
});
