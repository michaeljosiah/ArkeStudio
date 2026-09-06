import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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

/*
 * The app root is not always spelled the way the filesystem spells it back.
 *
 * The spool refused itself whenever `realpath` of its directory differed from the path it was
 * built from — which is every Windows temp directory reached through its 8.3 alias, and every
 * profile behind folder redirection. Staging then failed with "could not stage this recording"
 * for a spool that was in exactly the right place. What has to be refused is a spool directory
 * that redirects writes somewhere else, and that is asked here of both directories the spool
 * makes rather than of a string comparison the filesystem never promised.
 */
it("stages through an app root reached by a link, and still refuses a redirected spool", async t => {
  const base = await mkdtemp(join(tmpdir(), "arke-spool-alias-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = join(base, "real"), alias = join(base, "alias");
  await mkdir(real);
  await symlink(real, alias, "junction");
  const viaLink = await createPerformanceSpool(alias).stage({
    contentType: "audio/webm;codecs=opus",
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.equal(viaLink.ok, true);

  const redirected = join(base, "redirected"), elsewhere = join(base, "elsewhere");
  await mkdir(join(redirected));
  await mkdir(elsewhere);
  await symlink(elsewhere, join(redirected, ".spool"), "junction");
  const away = await createPerformanceSpool(redirected).stage({
    contentType: "audio/webm;codecs=opus",
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.equal(away.ok, false);
});
