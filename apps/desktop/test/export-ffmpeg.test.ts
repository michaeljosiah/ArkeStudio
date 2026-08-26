import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createExportFfmpegRunner } from "../src/export-ffmpeg.js";

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  killed: string | null = null;
  kill(signal: string): boolean {
    this.killed = signal;
    return true;
  }
}

function fakeSpawn() {
  const child = new FakeChild();
  const calls: Array<{ file: string; args: string[] }> = [];
  const spawn = ((file: string, args: string[]) => {
    calls.push({ file, args });
    return child;
  }) as never;
  return { child, calls, spawn };
}

describe("the desktop export ffmpeg runner", () => {
  it("runs unshelled, reports progress, and resolves a clean encode", async () => {
    const { child, calls, spawn } = fakeSpawn();
    const progress: number[] = [];
    const pending = createExportFfmpegRunner("C:\\ffmpeg.exe", "C:\\font.ttf", spawn, () => true).run(
      ["-i", "C:\\a world\\clip.mp4"],
      (value) => progress.push(value),
      new AbortController().signal,
    );
    child.stderr.emit("data", Buffer.from("frame=1 time=00:00:12.00"));
    child.emit("exit", 0);
    await pending;
    assert.deepEqual(calls, [{ file: "C:\\ffmpeg.exe", args: ["-hide_banner", "-i", "C:\\a world\\clip.mp4"] }]);
    assert.deepEqual(progress, [12]);
  });

  it("names drawtext and font failures instead of exposing only the process code", async () => {
    for (const diagnostic of [
      "[Parsed_drawtext_0] Could not load font",
      "Fontconfig error: Cannot load default config file",
      "Error applying option 'fontfile' to filter 'drawtext'",
    ]) {
      const { child, spawn } = fakeSpawn();
      const pending = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true).run(
        ["-filter_complex", "drawtext=fontfile=font.ttf:text=slate"],
        () => {},
        new AbortController().signal,
      );
      child.stderr.emit("data", Buffer.from(diagnostic));
      child.emit("exit", 3221225477);
      await assert.rejects(pending, /could not draw an export slate with the bundled font/);
    }
  });

  it("retains the ordinary exit-code failure for an unrelated encode fault", async () => {
    const { child, spawn } = fakeSpawn();
    const pending = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true).run([], () => {}, new AbortController().signal);
    child.stderr.emit("data", Buffer.from("No such file or directory"));
    child.emit("exit", 2);
    await assert.rejects(pending, /ffmpeg exited 2/);
  });

  it("does not mistake the ffmpeg configuration banner for a font failure", async () => {
    const { child, spawn } = fakeSpawn();
    const pending = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true).run(
      ["-i", "missing.mp4"],
      () => {},
      new AbortController().signal,
    );
    child.stderr.emit("data", Buffer.from("configuration: --enable-libfreetype\nmissing.mp4: No such file"));
    child.emit("exit", 2);
    await assert.rejects(pending, /ffmpeg exited 2/);
  });

  it("does not mistake an unrelated media path containing font for a slate failure", async () => {
    for (const path of ["C:/world/font-reference-missing.mp4", "C:/Users/Fontaine/missing.mp4"]) {
      const { child, spawn } = fakeSpawn();
      const pending = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true).run(
        ["-filter_complex", "drawtext=fontfile=font.ttf:text=slate", "-i", path],
        () => {},
        new AbortController().signal,
      );
      child.stderr.emit("data", Buffer.from(`${path}: No such file or directory`));
      child.emit("exit", 2);
      await assert.rejects(pending, /ffmpeg exited 2/);
    }
  });

  it("names the observed Windows drawtext crash even when it exits before diagnostics", async () => {
    const { child, spawn } = fakeSpawn();
    const pending = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true).run(
      ["-filter_complex", "drawtext=fontfile=font.ttf:text=slate"],
      () => {},
      new AbortController().signal,
    );
    child.emit("exit", 3221225477);
    await assert.rejects(pending, /could not draw an export slate with the bundled font/);
  });

  it("kills an active encode when cancellation is requested", async () => {
    const { child, spawn } = fakeSpawn();
    const controller = new AbortController();
    void createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true).run([], () => {}, controller.signal);
    controller.abort();
    assert.equal(child.killed, "SIGKILL");
  });

  it("refuses a missing bundled font before ffmpeg can fall back to host discovery", async () => {
    const { calls, spawn } = fakeSpawn();
    await assert.rejects(
      createExportFfmpegRunner("ffmpeg", "C:\\missing\\Geist.ttf", spawn, () => false).run(
        ["-filter_complex", "drawtext=text=slate"],
        () => {},
        new AbortController().signal,
      ),
      /bundled font is missing — reinstall Arke Studio/,
    );
    assert.deepEqual(calls, [], "a missing font is refused before ffmpeg starts");
  });

  it("does not require the slate font for an export whose graph draws no text", async () => {
    const { child, spawn } = fakeSpawn();
    const pending = createExportFfmpegRunner("ffmpeg", "C:\\missing\\Geist.ttf", spawn, () => false).run(
      ["-filter_complex", "null"],
      () => {},
      new AbortController().signal,
    );
    child.emit("exit", 0);
    await pending;
  });
});
