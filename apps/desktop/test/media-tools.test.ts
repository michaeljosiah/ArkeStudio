import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import { audioMediaOptions, createMediaProcessRunner } from "../src/media-tools.js";

function fixture() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (signal: string) => boolean };
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; return true; };
  const calls: unknown[][] = [];
  const spawn = ((...args: unknown[]) => { calls.push(args); return child; }) as never;
  return { child, calls, killed: () => killed, runner: createMediaProcessRunner({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }, spawn) };
}
const limits = (signal = new AbortController().signal) => ({ signal, timeoutMs: 1000, maxStdoutBytes: 16, maxStderrBytes: 16 });
it("uses explicit unshelled executables and preserves binary stdout until close", async () => {
  const f = fixture();
  const pending = f.runner.run("ffprobe", ["a path & name"], limits());
  f.child.stdout.emit("data", Buffer.from([0, 255, 128]));
  let settled = false; void pending.then(() => { settled = true; });
  f.child.emit("exit", 0); await Promise.resolve(); assert.equal(settled, false);
  f.child.emit("close", 0);
  assert.deepEqual([...(await pending).stdout], [0, 255, 128]);
  assert.deepEqual(f.calls[0], ["ffprobe", ["a path & name"], { windowsHide: true, shell: false }]);
});
it("abort and overflow kill before settling so cleanup cannot race open handles", async () => {
  for (const mode of ["abort", "overflow"] as const) {
    const f = fixture(), controller = new AbortController();
    const pending = f.runner.run("ffmpeg", [], limits(controller.signal));
    if (mode === "abort") controller.abort(); else f.child.stdout.emit("data", Buffer.alloc(100));
    assert.equal(f.killed(), true);
    f.child.emit("close", null);
    const result = await pending;
    assert.equal(mode === "abort" ? result.cancelled : result.outputLimitExceeded, true);
    assert.equal(result.stdout.length, 0);
  }
});
it("pre-abort spawns nothing and a timeout kills the child", async () => {
  const f = fixture();
  assert.equal((await f.runner.run("ffmpeg", [], limits(AbortSignal.abort()))).cancelled, true);
  assert.equal(f.calls.length, 0);
  const pending = f.runner.run("ffmpeg", [], { ...limits(), timeoutMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.killed(), true);
  f.child.emit("close", null);
  assert.equal((await pending).timedOut, true);
  assert.deepEqual(audioMediaOptions(null, "missing"), {});
  assert.deepEqual(audioMediaOptions("missing", "missing"), {});
});
