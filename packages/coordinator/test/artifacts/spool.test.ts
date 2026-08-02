import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tempDir } from "../tmp.js";
import { spoolBytes, spoolDir, spoolName, SPOOL_LIMIT_BYTES, sweepSpool } from "../../src/artifacts/spool.js";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("the paste spool", () => {
  it("keeps the name the user would recognise, and puts the randomness in the folder", async () => {
    const root = await tempDir("spool");
    const result = await spoolBytes(root, "Bell Tower.png", bytes("not really a png"));
    assert.ok("path" in result, "it wrote something");
    assert.equal(basename(result.path), "Bell-Tower.png", "the artifact will carry this name");
    assert.notEqual(basename(dirname(result.path)), ".spool", "two pastes of the same name cannot collide");
    assert.equal(await readFile(result.path, "utf8"), "not really a png");
  });

  it("will not let a name steer where the file lands", () => {
    // A clipboard name is data, not a route. Directory parts go, so nothing can be written
    // outside the spool by naming it cleverly.
    for (const hostile of ["../../evil.png", "..\\..\\evil.png", "C:\\Windows\\System32\\evil.png"]) {
      const name = spoolName(hostile);
      assert.equal(name, "evil.png", `${hostile} keeps only its last part`);
      assert.ok(!name.includes("/") && !name.includes("\\") && !name.includes(".."));
    }
  });

  it("gives an extension to bytes that arrived without one, so filing can read the kind", () => {
    assert.equal(spoolName("screenshot"), "screenshot.bin");
    assert.equal(spoolName(""), "pasted.bin");
    assert.equal(spoolName("   "), "pasted.bin");
    assert.equal(spoolName("notes.txt"), "notes.txt");
  });

  it("refuses an empty paste and one far too big, in words that say what to do instead", async () => {
    const root = await tempDir("spool");
    const empty = await spoolBytes(root, "nothing.png", new Uint8Array(0));
    assert.ok("reason" in empty && empty.reason.includes("nothing"));

    const huge = await spoolBytes(root, "film.mp4", new Uint8Array(SPOOL_LIMIT_BYTES + 1));
    assert.ok("reason" in huge && huge.reason.includes("+ button"), "it points at the way that works");
  });

  it("carries a pasted screenshot all the way into the world, as an image with its own name", async () => {
    // The whole point of the spool: bytes off the clipboard end up indistinguishable from a
    // file that was picked, so nothing downstream needs a second idea of what an artifact is.
    const root = await tempDir("spool");
    const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-08-02T09:00:00.000Z" });
    try {
      const spooled = await spoolBytes(root, "Screenshot 2026-08-02.png", bytes("PNG-ish bytes"));
      assert.ok("path" in spooled);

      const filed = await fileArtifact(store, { sourcePath: spooled.path });
      assert.equal(filed.outcome, "filed");
      assert.ok(filed.outcome === "filed");
      assert.equal(filed.artifact.kind, "image", "the extension survived the paste, so the kind is right");
      assert.match(filed.artifact.file, /screenshot-2026-08-02/, "and so did the name");
    } finally {
      // Closed even when an assertion fails: an open world holds the runner open for good.
      await store.close();
    }
  });

  it("sweeps itself, because nothing in there outlives the run that wrote it", async () => {
    const root = await tempDir("spool");
    const written = await spoolBytes(root, "note.txt", bytes("a courier, not a copy of record"));
    assert.ok("path" in written);
    await sweepSpool(root);
    await assert.rejects(stat(written.path), "the courier is gone");
    await assert.rejects(stat(join(spoolDir(root))), "and so is the spool itself");
  });
});
