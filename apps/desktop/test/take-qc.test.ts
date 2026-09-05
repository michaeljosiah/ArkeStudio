import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { QC_MAX_OUTPUT_BYTES } from "@arke-studio/coordinator";
import { createFfmpegProbeRunner, takeQcOptions } from "../src/take-qc.js";

/**
 * #248. A fake spawn stands in for ffmpeg, so these assert the host's bounding behaviour rather
 * than whether the machine running them happens to have a media toolchain installed.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string | null = null;
  kill(signal: string): boolean {
    this.killed = signal;
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
}

function fakeSpawn(): { spawn: never; child: FakeChild; calls: Array<{ file: string; args: string[] }> } {
  const child = new FakeChild();
  const calls: Array<{ file: string; args: string[] }> = [];
  const spawn = ((file: string, args: string[]) => {
    calls.push({ file, args });
    return child;
  }) as never;
  return { spawn, child, calls };
}

describe("desktop take-QC wiring (#248)", () => {
  it("configures take QC only when the ffmpeg executable is available", () => {
    // No ffmpeg is the ordinary state, not a degraded one: no analyzer, and takes simply
    // record no measurement.
    assert.deepEqual(takeQcOptions(null), {});

    const { spawn } = fakeSpawn();
    const configured = takeQcOptions("C:\\Program Files\\Arke\\ffmpeg.exe", spawn);
    assert.ok(configured.takeQcAnalyzer, "a resolved binary is what turns the measurement on");
    assert.equal(typeof configured.takeQcAnalyzer.analyze, "function");
  });

  it("runs the probe unshelled and reports the exit code with captured output", async () => {
    const { spawn, child, calls } = fakeSpawn();
    const runner = createFfmpegProbeRunner("ffmpeg", spawn);
    const pending = runner.run(["-i", "C:\\a world\\clip.mp4"], { timeoutMs: 5_000, maxOutputBytes: 1_000 });

    assert.equal(calls[0]!.file, "ffmpeg");
    assert.deepEqual(calls[0]!.args, ["-i", "C:\\a world\\clip.mp4"], "arguments are passed as an array, never a command string");

    child.stdout.emit("data", Buffer.from("#tb 0: 1/24\n"));
    child.stderr.emit("data", Buffer.from(""));
    child.emit("close", 0);

    const result = await pending;
    assert.deepEqual(result, { code: 0, stdout: "#tb 0: 1/24\n", stderr: "", timedOut: false });
  });

  it("kills the probe on its wall clock and on its output ceiling", async () => {
    // Wall clock: a probe that never exits is stopped and reported as a timeout.
    const slow = fakeSpawn();
    const slowRun = createFfmpegProbeRunner("ffmpeg", slow.spawn).run([], {
      timeoutMs: 5,
      maxOutputBytes: QC_MAX_OUTPUT_BYTES,
    });
    const timedOut = await slowRun;
    assert.equal(timedOut.timedOut, true);
    assert.equal(slow.child.killed, "SIGKILL", "the process is stopped, not merely abandoned");

    // Volume: output past the ceiling stops the process rather than growing in memory.
    const loud = fakeSpawn();
    const loudRun = createFfmpegProbeRunner("ffmpeg", loud.spawn).run([], {
      timeoutMs: 60_000,
      maxOutputBytes: 16,
    });
    loud.child.stdout.emit("data", Buffer.from("x".repeat(64)));
    const flooded = await loudRun;
    assert.equal(loud.child.killed, "SIGKILL");
    assert.equal(flooded.timedOut, false, "it exceeded its size, which is a different fault from exceeding its time");
  });

  it("treats a spawn error as an ordinary result rather than a rejection", async () => {
    const { spawn, child } = fakeSpawn();
    const pending = createFfmpegProbeRunner("ffmpeg", spawn).run([], { timeoutMs: 1_000, maxOutputBytes: 1_000 });
    child.emit("error", new Error("ENOENT"));
    const result = await pending;
    assert.equal(result.code, null, "finalization has nowhere to put a throw, so this path never throws");
  });
});
