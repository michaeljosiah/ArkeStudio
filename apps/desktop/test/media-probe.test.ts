import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createFfprobe } from "../src/media-probe.js";

/**
 * The host half of media measurement (#253), and its cancellation (issue 288).
 *
 * A fake spawn stands in for ffprobe so these assert what the host does with the process rather
 * than whether the machine running them happens to have a media toolchain on it. The process is
 * the whole subject: a probe holds the file it is reading open, and on Windows a world folder
 * with an open handle inside it cannot be renamed into `archive/`.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function fakeSpawn(): { spawn: never; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawn = (() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as never;
  return { spawn, children };
}

const ANSWER = JSON.stringify({ streams: [{ codec_type: "audio", channels: 2, sample_rate: "48000" }], format: { duration: "4.5" } });

describe("running ffprobe (#253, issue 288)", () => {
  it("measures a file the probe could read", async () => {
    const { spawn, children } = fakeSpawn();
    const pending = createFfprobe("ffprobe.exe", spawn).info!("C:\\a world\\artifacts\\bed.wav");
    children[0]!.stdout.emit("data", Buffer.from(ANSWER));
    children[0]!.emit("close", 0);
    assert.deepEqual(await pending, { durationSec: 4.5, hasAudio: true, hasVideo: false, audioChannels: 2, audioSampleRateHz: 48000 });
  });

  it("kills the process when the measurement is cancelled", async () => {
    // Not "stops waiting for it". The caller aborts because the world is closing and about to
    // be moved, so the handle has to go — an abort that left ffprobe running would leave the
    // hazard exactly where it was and only hide it from the caller.
    const { spawn, children } = fakeSpawn();
    const abort = new AbortController();
    const pending = createFfprobe("ffprobe.exe", spawn).info!("C:\\a world\\artifacts\\clip.mp4", {
      signal: abort.signal,
    });
    assert.equal(children[0]!.killed, false, "nothing to kill until the caller withdraws");
    abort.abort();
    assert.equal(await pending, null, "a cancelled measurement is no measurement");
    assert.equal(children[0]!.killed, true, "the child process is stopped, not merely abandoned");
  });

  it("spawns nothing at all for a measurement already withdrawn", async () => {
    const { spawn, children } = fakeSpawn();
    assert.equal(await createFfprobe("ffprobe.exe", spawn).durationSec("C:\\gone\\clip.mp4", { signal: AbortSignal.abort() }), null);
    assert.equal(children.length, 0, "a probe started now would hold the world open for its whole timeout");
  });

  it("still kills a probe that outruns its own clock", async () => {
    const { spawn, children } = fakeSpawn();
    assert.equal(await createFfprobe("ffprobe.exe", spawn, 5).durationSec("C:\\a world\\artifacts\\bad.mp4"), null);
    assert.equal(children[0]!.killed, true);
  });

  it("lets a finished probe settle once, and stops listening for the abort", async () => {
    // The listener is removed on settle: a probe that has already answered must not have a
    // later cancellation re-enter its promise, and a long-lived signal must not accumulate
    // one listener per file measured.
    const { spawn, children } = fakeSpawn();
    const abort = new AbortController();
    const pending = createFfprobe("ffprobe.exe", spawn).info!("C:\\a world\\artifacts\\bed.wav", { signal: abort.signal });
    children[0]!.stdout.emit("data", Buffer.from(ANSWER));
    children[0]!.emit("close", 0);
    await pending;
    abort.abort();
    assert.equal(children[0]!.killed, false, "nothing is killed after the answer arrived");
  });
});
