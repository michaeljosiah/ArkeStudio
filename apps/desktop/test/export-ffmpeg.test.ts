import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as waitForImmediate } from "node:timers/promises";
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
  const children: FakeChild[] = [];
  const calls: Array<{ file: string; args: string[] }> = [];
  const spawn = ((file: string, args: string[]) => {
    const child = new FakeChild();
    children.push(child);
    calls.push({ file, args });
    return child;
  }) as never;
  return { children, calls, spawn };
}

const DRAW_ARGS = ["-filter_complex", "drawtext=fontfile=font.ttf:text=slate"];

describe("the desktop export ffmpeg runner", () => {
  it("probes the exact escaped font before a slate encode, then reports encode progress", async () => {
    const font = "C:\\Users\\D'Angelo\\Arke Studio, Inc; Stable [x64]\\Geist-Regular.ttf";
    const { children, calls, spawn } = fakeSpawn();
    const progress: number[] = [];
    const pending = createExportFfmpegRunner("C:\\ffmpeg.exe", font, spawn, () => true).run(
      DRAW_ARGS,
      (value) => progress.push(value),
      new AbortController().signal,
    );

    const escaped = String.raw`C\\:/Users/D\\\'Angelo/Arke Studio\, Inc\; Stable \[x64\]/Geist-Regular.ttf`;
    assert.ok(
      calls[0]!.args.join(" ").includes(`drawtext=expansion=none:fontfile=${escaped}:text=probe`),
      `expected escaped probe font path in ${calls[0]!.args.join(" ")}`,
    );
    children[0]!.emit("exit", 0);
    await waitForImmediate();
    assert.deepEqual(calls[1], { file: "C:\\ffmpeg.exe", args: ["-hide_banner", ...DRAW_ARGS] });
    children[1]!.stderr.emit("data", Buffer.from("frame=1 time=00:00:12.00"));
    children[1]!.emit("exit", 0);
    await pending;
    assert.deepEqual(progress, [12]);
  });

  it("caches only a successful drawtext probe", async () => {
    const { children, calls, spawn } = fakeSpawn();
    const runner = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true);
    const first = runner.run(DRAW_ARGS, () => {}, new AbortController().signal);
    children[0]!.emit("exit", 0);
    await waitForImmediate();
    children[1]!.emit("exit", 0);
    await first;

    const second = runner.run(DRAW_ARGS, () => {}, new AbortController().signal);
    await waitForImmediate();
    assert.equal(calls.length, 3, "the second encode starts without another probe");
    children[2]!.emit("exit", 0);
    await second;
  });

  it("names a failed drawtext capability probe without inspecting user-influenced encode stderr", async () => {
    const { children, calls, spawn } = fakeSpawn();
    const pending = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true).run(
      DRAW_ARGS,
      () => {},
      new AbortController().signal,
    );
    children[0]!.emit("exit", 3221225477);
    await assert.rejects(pending, /could not draw an export slate with the bundled font/);
    assert.equal(calls.length, 1, "the real encode never starts after a failed probe");
  });

  it("leaves every real encode failure in its original exit-code category", async () => {
    const { children, spawn } = fakeSpawn();
    const runner = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true);
    const warm = runner.run(DRAW_ARGS, () => {}, new AbortController().signal);
    children[0]!.emit("exit", 0);
    await waitForImmediate();
    children[1]!.emit("exit", 0);
    await warm;
    const paths = [
      "option fontfile-reference-missing.mp4",
      "filter drawtext-reference-missing.mp4",
      "[Parsed_drawtext_0]-invalid-reference-missing.mp4",
      "[drawtext]-failed-reference-missing.mp4",
    ];
    for (const path of paths) {
      const pending = runner.run([...DRAW_ARGS, "-i", path], () => {}, new AbortController().signal);
      await waitForImmediate();
      const encode = children.at(-1)!;
      encode.stderr.emit("data", Buffer.from(`Error opening input file ${path}`));
      encode.emit("exit", 2);
      await assert.rejects(pending, /ffmpeg exited 2/);
    }
  });

  it("refuses a missing bundled font before ffmpeg can fall back to host discovery", async () => {
    const { calls, spawn } = fakeSpawn();
    await assert.rejects(
      createExportFfmpegRunner("ffmpeg", "C:\\missing\\Geist.ttf", spawn, () => false).run(
        DRAW_ARGS,
        () => {},
        new AbortController().signal,
      ),
      /bundled font is missing — reinstall Arke Studio/,
    );
    assert.deepEqual(calls, []);
  });

  it("skips the font probe for an export whose graph draws no text", async () => {
    const { children, calls, spawn } = fakeSpawn();
    const pending = createExportFfmpegRunner("ffmpeg", "C:\\missing\\Geist.ttf", spawn, () => false).run(
      ["-filter_complex", "null"],
      () => {},
      new AbortController().signal,
    );
    assert.equal(calls.length, 1);
    children[0]!.emit("exit", 0);
    await pending;
  });

  it("does not infer drawtext use from input paths or metadata", async () => {
    for (const args of [
      ["-i", "C:/world/drawtext=notes.mp4", "-filter_complex", "null"],
      ["-metadata", "comment=drawtext=example", "-filter_complex", "null"],
    ]) {
      const { children, calls, spawn } = fakeSpawn();
      const pending = createExportFfmpegRunner("ffmpeg", "C:\\missing\\Geist.ttf", spawn, () => false).run(
        args,
        () => {},
        new AbortController().signal,
      );
      assert.equal(calls.length, 1, "a no-slate export starts without a font probe");
      children[0]!.emit("exit", 0);
      await pending;
    }
  });

  it("kills a drawtext probe when cancellation is requested", async () => {
    const { children, spawn } = fakeSpawn();
    const controller = new AbortController();
    const pending = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true).run(
      DRAW_ARGS,
      () => {},
      controller.signal,
    );
    controller.abort();
    assert.equal(children[0]!.killed, "SIGKILL");
    children[0]!.emit("exit", null);
    await assert.rejects(pending, /cancelled before start|could not draw an export slate/);
  });

  it("does not start an encode when cancellation lands at probe completion", async () => {
    const { children, calls, spawn } = fakeSpawn();
    const controller = new AbortController();
    const pending = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true).run(
      DRAW_ARGS,
      () => {},
      controller.signal,
    );
    children[0]!.on("exit", () => controller.abort());
    children[0]!.emit("exit", 0);
    await assert.rejects(pending, /cancelled before start/);
    assert.equal(calls.length, 1, "the encode never starts from an already-cancelled signal");
  });

  it("coalesces concurrent probes while keeping caller cancellation independent", async () => {
    const { children, calls, spawn } = fakeSpawn();
    const runner = createExportFfmpegRunner("ffmpeg", "font.ttf", spawn, () => true);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = runner.run(DRAW_ARGS, () => {}, firstController.signal);
    const second = runner.run(DRAW_ARGS, () => {}, secondController.signal);
    assert.equal(calls.length, 1, "both callers share one cold probe");

    firstController.abort();
    await assert.rejects(first, /cancelled before start/);
    assert.equal(children[0]!.killed, null, "one cancelled waiter does not kill another's probe");

    children[0]!.emit("exit", 0);
    await waitForImmediate();
    assert.equal(calls.length, 2, "only the surviving caller starts an encode");
    children[1]!.emit("exit", 0);
    await second;
  });
});
