import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertNoticeMatchesLicence,
  assertPeArchitecture,
  citedGplVersions,
  gplVersionOf,
  manifestFor,
  peArchitecture,
  pruneEmptyDirectories,
  swapStagedDirectory,
  verifyManifest,
} from "../scripts/runtime-support.mjs";

async function pe(machine) {
  const path = join(tmpdir(), `arke-pe-${machine}-${Date.now()}.exe`);
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "ascii");
  bytes.writeUInt16LE(machine, 68);
  await writeFile(path, bytes);
  return path;
}

describe("runtime preparation primitives", () => {
  it("recognises x64 and arm64 PE files and rejects mismatches", async () => {
    const x64 = await pe(0x8664);
    const arm64 = await pe(0xaa64);
    try {
      assert.equal(peArchitecture(x64), "x64");
      assert.equal(peArchitecture(arm64), "arm64");
      assert.throws(() => assertPeArchitecture(x64, "arm64"), /expected arm64/);
    } finally {
      await rm(x64, { force: true });
      await rm(arm64, { force: true });
    }
  });

  it("creates a stable target-only checksum manifest", async () => {
    const root = join(tmpdir(), `arke-runtime-${Date.now()}`);
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "voxa.exe"), "one");
    await writeFile(join(root, "nested", "runtime.dll"), "two");
    try {
      const manifest = manifestFor(root, { component: "voxa", arch: "x64" });
      await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(manifest));
      assert.deepEqual(manifest.files.map((file) => file.path), ["nested/runtime.dll", "voxa.exe"]);
      assert.equal(manifest.files.every((file) => /^[A-F0-9]{64}$/.test(file.sha256)), true);
      assert.equal(verifyManifest(root).component, "voxa");
      await writeFile(join(root, "unlisted.dll"), "three");
      assert.throws(() => verifyManifest(root), /every staged file/);
      await rm(join(root, "unlisted.dll"));
      await writeFile(join(root, "voxa.exe"), "changed");
      assert.throws(() => verifyManifest(root), /manifest|checksum|size/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The check that would have caught a source notice drifting away from the licence beside it.
 *
 * ffmpeg shipped GPLv3 text next to a notice citing GPLv2 §3(b) for two releases, because the
 * two files were written at different times and nothing ever read them together. The staged
 * pair is compared at package time; these are the comparison's own edge cases.
 */
describe("a source notice against the licence it ships beside", () => {
  const GPL3 = "                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n\n Copyright (C) 2007 Free Software Foundation, Inc.";
  const GPL2 = "\t\t    GNU GENERAL PUBLIC LICENSE\n\t\t       Version 2, June 1991\n\n Copyright (C) 1989, 1991 Free Software Foundation, Inc.";

  it("reads the version off the licence's own heading", () => {
    assert.equal(gplVersionOf(GPL3), "3");
    assert.equal(gplVersionOf(GPL2), "2");
    assert.equal(gplVersionOf("Permission is hereby granted, free of charge"), null, "an MIT text is not a GPL");
  });

  it("collects every GPL version a notice claims to be written under", () => {
    assert.deepEqual([...citedGplVersions("given under section 6(d) of the GNU General Public License version 3.")], ["3"]);
    assert.deepEqual(
      [...citedGplVersions("under the General Public License version 2 and the General Public License, version 3")].sort(),
      ["2", "3"],
      "a notice citing two versions is reported as citing both, not resolved to one",
    );
    assert.equal(citedGplVersions("a notice that never says which licence it is under").size, 0);
  });

  it("passes a notice written under the licence beside it", () => {
    const notice = "These directions are given under section 6(d) of the GNU General Public License version 3.";
    assert.doesNotThrow(() => assertNoticeMatchesLicence(GPL3, notice, "ffmpeg"));
  });

  it("refuses the pairing that actually shipped, and names both versions", () => {
    const notice = "This offer is made under section 3(b) of the GNU General Public License version 2.";
    assert.throws(() => assertNoticeMatchesLicence(GPL3, notice, "ffmpeg"), /cites GPL version 2 .*is GPL version 3/);
  });

  it("refuses a notice that names no licence version at all", () => {
    assert.throws(() => assertNoticeMatchesLicence(GPL3, "Source on request.", "ffmpeg"), /does not say which GPL version/);
  });

  it("refuses to judge a licence text it cannot identify", () => {
    // Silence here would be the worst answer: an unrecognised licence means the pairing is
    // unchecked, which is the state that let the mismatch ship in the first place.
    assert.throws(() => assertNoticeMatchesLicence("Apache License, Version 2.0", "under the GNU General Public License version 3", "ffmpeg"), /not a recognised GPL/);
  });
});

/**
 * The half of a prepare run that decides what a *failed* prepare costs (#581).
 *
 * Driven directly rather than through `prepare:runtimes`, which wants Windows, a .NET SDK and
 * three network downloads before it reaches the swap. The case that matters here is the one that
 * broke the build in the first place -- the fresh copy never arrives -- and it has to be tried,
 * because its whole job is to do nothing.
 */
describe("swapping a staged runtime into place", () => {
  async function scene() {
    const root = join(tmpdir(), `arke-swap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const fresh = join(root, "work", "stage", "ffmpeg");
    const stage = join(root, "build-resources", "ffmpeg");
    const attic = join(root, ".runtime-previous", "ffmpeg");
    await mkdir(fresh, { recursive: true });
    await writeFile(join(fresh, "ffmpeg.exe"), "new");
    return { root, fresh, stage, attic };
  }

  it("replaces the staged copy wholesale, leaving nothing of the old one behind", async () => {
    const { root, fresh, stage, attic } = await scene();
    try {
      await mkdir(join(stage, "doc"), { recursive: true });
      await writeFile(join(stage, "ffmpeg.exe"), "old");
      await writeFile(join(stage, "doc", "stale.html"), "from the previous pin");
      swapStagedDirectory(fresh, stage, attic);
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "new");
      assert.deepEqual(await readdir(stage), ["ffmpeg.exe"], "a file only the old build had must not survive");
      assert.equal(existsSync(attic), false, "the displaced copy is dropped once the new one is in");
      assert.equal(existsSync(fresh), false, "and the work copy is moved, not left as a duplicate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages into an empty build-resources, creating the parent it needs", async () => {
    const { root, fresh, attic } = await scene();
    const stage = join(root, "build-resources", "voxa", "x64");
    try {
      swapStagedDirectory(fresh, stage, attic);
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "new");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a working staged copy untouched when the fresh one was never prepared", async () => {
    // #581 exactly: the pinned ffmpeg release was deleted upstream, the download 404'd, and the
    // old clear-then-fetch order had already taken the only ffmpeg on the machine with it.
    const { root, stage, attic } = await scene();
    try {
      await mkdir(stage, { recursive: true });
      await writeFile(join(stage, "ffmpeg.exe"), "old but working");
      assert.throws(() => swapStagedDirectory(join(root, "never-built"), stage, attic), /was never prepared/);
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "old but working");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears a leftover attic rather than swapping the wrong copy into it", async () => {
    // A swap killed part-way leaves the attic populated. While there is still a stage to displace
    // that attic is stale, and must not be mistaken for the copy being displaced — or a
    // two-runs-old ffmpeg becomes the one that gets restored.
    const { root, fresh, stage, attic } = await scene();
    try {
      await mkdir(attic, { recursive: true });
      await writeFile(join(attic, "ffmpeg.exe"), "two runs old");
      await mkdir(stage, { recursive: true });
      await writeFile(join(stage, "ffmpeg.exe"), "old");
      swapStagedDirectory(fresh, stage, attic);
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "new");
      assert.equal(existsSync(attic), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adopts the attic when a killed run left it holding the only copy", async () => {
    // The other half of the rule above (Codex round 1). Interrupted between displacing the stage
    // and landing the new copy, a run leaves the attic as the only working runtime and nothing at
    // `stage`. Clearing it unconditionally destroyed exactly the copy the attic exists to save.
    const { root, fresh, stage, attic } = await scene();
    try {
      await mkdir(attic, { recursive: true });
      await writeFile(join(attic, "ffmpeg.exe"), "the only copy left");
      assert.equal(existsSync(stage), false, "the interrupted run left no stage");
      swapStagedDirectory(fresh, stage, attic);
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "new");
      assert.equal(existsSync(attic), false, "and the survivor is released once the new copy is in");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lands the fresh copy beside the attic, never part-written into the live stage", async () => {
    // The cross-volume path copies rather than renames, and a copy can die half-way. It must not
    // do that inside `stage`: electron-builder reads that directory, and a partial runtime there
    // cannot be renamed back over. The landing spot is a sibling of the attic, and nothing of it
    // survives a completed swap.
    const { root, fresh, stage, attic } = await scene();
    const landing = `${attic}.incoming`;
    try {
      await mkdir(landing, { recursive: true });
      await writeFile(join(landing, "ffmpeg.exe"), "wreckage of a copy that died");
      swapStagedDirectory(fresh, stage, attic);
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "new", "the wreckage is not what got staged");
      assert.equal(existsSync(landing), false, "and the landing spot is left empty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tidies the attic root without touching another run's survivor", async () => {
    // Both architectures and both prepare scripts keep survivors under one root, so the tidy-up
    // at the end of a run cannot be a delete of that root (Codex round 2). An x64 stage saved by
    // a run that died an hour ago has to still be there after an arm64 run, or after the
    // prepare:opencode2 that follows in `package`.
    const { root } = await scene();
    const attic = join(root, ".runtime-previous");
    try {
      await mkdir(join(attic, "voxa", "x64"), { recursive: true });
      await writeFile(join(attic, "voxa", "x64", "voxa.exe"), "an interrupted x64 run's only copy");
      await mkdir(join(attic, "voxa", "arm64"), { recursive: true });
      await mkdir(join(attic, "ffmpeg"), { recursive: true });
      pruneEmptyDirectories(attic);
      assert.equal(
        await readFile(join(attic, "voxa", "x64", "voxa.exe"), "utf8"),
        "an interrupted x64 run's only copy",
      );
      assert.equal(existsSync(join(attic, "voxa", "arm64")), false, "the empty ones do go");
      assert.equal(existsSync(join(attic, "ffmpeg")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the attic root once nothing is left in it", async () => {
    const { root } = await scene();
    const attic = join(root, ".runtime-previous");
    try {
      await mkdir(join(attic, "voxa", "x64"), { recursive: true });
      pruneEmptyDirectories(attic);
      assert.equal(existsSync(attic), false);
      assert.doesNotThrow(() => pruneEmptyDirectories(attic), "and an absent root is not an error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses before displacing anything when the attic location is unusable", async () => {
    // Every rename here assumes the attic can be created. If it cannot, the failure has to happen
    // while the stage is still whole rather than after it has been moved out of the way.
    const { root, fresh, stage } = await scene();
    const blocked = join(root, "not-a-directory");
    try {
      await writeFile(blocked, "a file where the attic's parent should be");
      await mkdir(stage, { recursive: true });
      await writeFile(join(stage, "ffmpeg.exe"), "old but working");
      assert.throws(() => swapStagedDirectory(fresh, stage, join(blocked, "ffmpeg")));
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "old but working");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
