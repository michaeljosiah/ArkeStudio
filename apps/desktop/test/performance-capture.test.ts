import assert from "node:assert/strict";
import { it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
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
  /*
   * Through `realpath` so the paths below compare literally. The spool used to refuse a root that
   * was not already its own canonical path, which a Windows CI runner's 8.3 TEMP (`RUNNER~1`)
   * tripped on every stage; it now works from the canonical path itself (issue 871), and the
   * test below is where that is proven.
   */
  const root = await realpath(await mkdtemp(join(tmpdir(), "arke-performance-spool-")));
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
it("works from the store's canonical path: an alias on the way in is accepted, a link at the store is refused (issue 871)", async t => {
  /*
   * The promise is that nothing has substituted the store directory, not that it sits at the
   * exact string the app composed. A junctioned app root, a redirected profile and an 8.3 short
   * path are all aliases on the way in and all used to refuse every recording, permanently.
   */
  const base = await realpath(await mkdtemp(join(tmpdir(), "arke-performance-spool-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const linkKind = process.platform === "win32" ? "junction" : "dir";
  const real = join(base, "real");
  await mkdir(real);
  const alias = join(base, "alias");
  await symlink(real, alias, linkKind);
  const recording = { contentType: "audio/webm", bytes: new Uint8Array([1, 2, 3]) };
  const aliased = createPerformanceSpool(alias);
  const staged = await aliased.stage(recording);
  assert.ok(staged.ok, staged.ok ? undefined : staged.reason);
  const claimed = await aliased.claim(staged.spoolId);
  assert.ok(claimed !== null && claimed.absolutePath.startsWith(join(real, ".spool", "performance")), "the store lives at the canonical path");
  if (process.platform === "win32") {
    // The 8.3 name is an alias too — the shape a CI runner's TEMP takes. Skipped where the volume
    // has short names disabled, which the shell reports by handing the long path back.
    const short = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${real}').ShortPath`,
    ]).toString().trim();
    if (short.length > 0 && short.toLowerCase() !== real.toLowerCase()) {
      const viaShort = await createPerformanceSpool(short).stage(recording);
      assert.ok(viaShort.ok, viaShort.ok ? undefined : viaShort.reason);
    }
  }
  // A link AT the store is a substituted directory: refused, and said as a setup problem rather
  // than as a recording that failed to write.
  const linked = join(base, "linked");
  await mkdir(join(linked, ".spool"), { recursive: true });
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, join(linked, ".spool", "performance"), linkKind);
  const refused = await createPerformanceSpool(linked).stage(recording);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /could not open\. .*is a link\. Replace it with a folder/);
  await assert.rejects(createPerformanceSpool(linked).claim("x"), /is a link/);
});
