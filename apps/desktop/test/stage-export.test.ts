import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { createStageExporter } from "../src/stage-export.js";

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed: string | null = null;
  frames: Buffer[] = [];
  stdin: Writable;

  constructor(output: string) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.frames.push(Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        void writeFile(output, new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70]))
          .then(() => {
            this.exitCode = 0;
            this.emit("exit", 0);
            callback();
          }, callback);
      },
    });
  }

  kill(signal: string): boolean {
    this.killed = signal;
    this.exitCode = 1;
    this.emit("exit", 1);
    return true;
  }
}

function fakeSpawn() {
  const calls: Array<{ file: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawn = ((file: string, args: string[]) => {
    calls.push({ file, args });
    const child = new FakeChild(args.at(-1)!);
    children.push(child);
    return child;
  }) as never;
  return { calls, children, spawn };
}

describe("the deterministic Stage exporter", () => {
  it("pipes ordered RGBA frames to a fixed single-threaded MP4 encode", async () => {
    const root = await mkdtemp(join(tmpdir(), "arke-stage-export-"));
    const { calls, children, spawn } = fakeSpawn();
    const exporter = createStageExporter(root, "C:\\ffmpeg.exe", spawn);
    const started = await exporter.start({ width: 2, height: 2, frameRate: 30, frameCount: 2 });
    assert.ok(started.ok);
    if (!started.ok) return;
    assert.deepEqual(await exporter.start({ width: 2, height: 2, frameRate: 30, frameCount: 2 }), { ok: false, reason: "another Stage export is already running" });
    const args = calls[0]!.args;
    assert.equal(calls[0]!.file, "C:\\ffmpeg.exe");
    assert.ok(args.includes("rawvideo"));
    assert.ok(args.includes("vflip,format=yuv420p"));
    assert.deepEqual(args.slice(args.indexOf("-threads"), args.indexOf("-threads") + 2), ["-threads", "1"]);
    assert.match(args.at(-1)!, /playblast\.mp4$/);

    assert.deepEqual(await exporter.write(started.jobId, 1, new Uint8Array(16)), { ok: false, reason: "the Stage export expected frame 0" });
    assert.deepEqual(await exporter.write(started.jobId, 0, new Uint8Array(16).fill(1)), { ok: true });
    assert.deepEqual(await exporter.write(started.jobId, 1, new Uint8Array(16).fill(2)), { ok: true });
    assert.deepEqual(await exporter.write(started.jobId, 2, new Uint8Array(16)), { ok: false, reason: "the Stage export already has all 2 frames" });
    const finishing = exporter.finish(started.jobId);
    assert.deepEqual(await exporter.finish(started.jobId), { ok: false, reason: "that Stage export is already finishing" });
    const finished = await finishing;
    assert.ok(finished.ok);
    assert.deepEqual(children[0]!.frames.map((frame) => frame[0]), [1, 2]);
  });

  it("refuses malformed and incomplete frame streams", async () => {
    const root = await mkdtemp(join(tmpdir(), "arke-stage-export-"));
    const { children, spawn } = fakeSpawn();
    const exporter = createStageExporter(root, "ffmpeg", spawn);
    const started = await exporter.start({ width: 2, height: 2, frameRate: 30, frameCount: 2 });
    assert.ok(started.ok);
    if (!started.ok) return;
    assert.match((await exporter.write(started.jobId, 0, new Uint8Array(15)) as { reason: string }).reason, /wrong byte length/);
    assert.deepEqual(await exporter.write(started.jobId, 0, new Uint8Array(16)), { ok: true });
    const finished = await exporter.finish(started.jobId);
    assert.equal(finished.ok, false);
    assert.equal(children[0]!.killed, "SIGKILL");
  });
});
