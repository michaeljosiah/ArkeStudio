import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runExport, type FfmpegRunner } from "../../src/takes/export.js";
import { tempDir } from "../tmp.js";

/**
 * A subtitle sidecar lands with the video or not at all (SPEC-038 R-27, R-30, A-10; issue 683):
 * staged beside the encode, renamed after it, and gone with it when the encode is cancelled or
 * fails. No partial video, no orphaned subtitle file.
 */

const font = "/fonts/Geist-Regular.ttf";
const args = (stage: string): string[] => ["-y", "-f", "lavfi", "-t", "1", "-i", "color=c=black", stage];
const sidecar = { name: "film.en.srt", text: "1\n00:00:00,000 --> 00:00:01,000\nHello.\n" };

describe("subtitle sidecars beside an export", () => {
  it("delivers the sidecar with a finished video and names it in the result", async () => {
    const worldDir = await tempDir("arke-sidecar-");
    const runner: FfmpegRunner = {
      slateFont: font,
      run: async (argv) => {
        await writeFile(argv[argv.length - 1]!, "rendered");
      },
    };
    const exportId = "ex_01J8F3K2QW9VZX4N7M0RTYB6HC";
    const handle = runExport(worldDir, args, "film.mp4", runner, () => {}, sidecar, exportId);
    assert.equal(handle.id, exportId, "an approved conversation action fixes its export identity before encoding");
    const result = await handle.done;
    assert.equal(result.status, "done");
    if (result.status !== "done") return;
    assert.equal(result.output, "exports/film.mp4");
    assert.equal(result.sidecar, "exports/film.en.srt");
    assert.equal(await readFile(join(worldDir, "exports", "film.en.srt"), "utf8"), sidecar.text);
    const staged = await readdir(join(worldDir, ".cache", "exports")).catch(() => [] as string[]);
    assert.deepEqual(staged, [], "nothing is left in the stage");
  });

  it("leaves neither the video nor the sidecar behind when the encode is cancelled or fails", async () => {
    const worldDir = await tempDir("arke-sidecar-");
    let release: () => void = () => {};
    const slow: FfmpegRunner = {
      slateFont: font,
      run: (argv, _progress, signal) =>
        new Promise((_resolve, reject) => {
          void writeFile(argv[argv.length - 1]!, "partial");
          release = () => reject(new Error("killed"));
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const cancelled = runExport(worldDir, args, "cancelled.mp4", slow, () => {}, sidecar);
    cancelled.cancel();
    const outcome = await cancelled.done;
    release();
    assert.equal(outcome.status, "cancelled");
    await assert.rejects(() => stat(join(worldDir, "exports", "cancelled.mp4")));
    await assert.rejects(() => stat(join(worldDir, "exports", "film.en.srt")));
    const staged = await readdir(join(worldDir, ".cache", "exports")).catch(() => [] as string[]);
    assert.deepEqual(staged, [], "the stage holds neither half");

    const failing: FfmpegRunner = {
      slateFont: font,
      run: async () => {
        throw new Error("encoder exploded");
      },
    };
    const failed = await runExport(worldDir, args, "failed.mp4", failing, () => {}, sidecar).done;
    assert.equal(failed.status, "failed");
    await assert.rejects(() => stat(join(worldDir, "exports", "film.en.srt")));
  });
});

describe("a sidecar that cannot be published takes the video with it", () => {
  it("removes the already-published video when the sidecar rename fails", async () => {
    const worldDir = await tempDir("arke-sidecar-");
    // A directory where the sidecar must land: rename refuses it on every platform.
    await mkdir(join(worldDir, "exports", sidecar.name), { recursive: true });
    const runner: FfmpegRunner = {
      slateFont: font,
      run: async (argv) => {
        await writeFile(argv[argv.length - 1]!, "rendered");
      },
    };
    const result = await runExport(worldDir, args, "film.mp4", runner, () => {}, sidecar).done;
    assert.equal(result.status, "failed", "both or neither (SPEC-038 A-10)");
    await assert.rejects(() => stat(join(worldDir, "exports", "film.mp4")), "the video does not stay behind without its subtitles");
    const staged = await readdir(join(worldDir, ".cache", "exports")).catch(() => [] as string[]);
    assert.deepEqual(staged, [], "the stage is clean");
  });
});
