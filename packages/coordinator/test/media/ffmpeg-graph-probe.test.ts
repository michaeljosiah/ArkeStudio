import assert from "node:assert/strict";
import { test } from "node:test";
import { probeFfmpegGraphFileOption } from "../../src/media/ffmpeg-graph-probe.js";
import type { MediaProcessRunner } from "../../src/audio/media-tools.js";

test("graph-file capability discovery is bounded, names failures and does not guess", async () => {
  const result = { code: 0, stdout: new TextEncoder().encode("ffmpeg version 9.0\n"), stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false };
  const runner: MediaProcessRunner = { run: async (tool, args, limits) => {
    assert.equal(tool, "ffmpeg"); assert.deepEqual(args, ["-version"]);
    assert.equal(limits.timeoutMs, 10_000); assert.equal(limits.maxStdoutBytes, 65_536); assert.equal(limits.maxStderrBytes, 16_384);
    return result;
  } };
  const signal = new AbortController().signal;
  assert.equal(await probeFfmpegGraphFileOption(runner, signal), "-/filter_complex");
  for (const failed of [{ code: 1 }, { timedOut: true }, { outputLimitExceeded: true }]) {
    await assert.rejects(probeFfmpegGraphFileOption({ run: async () => ({ ...result, ...failed }) }, signal), /graph-file support/);
  }
  await assert.rejects(probeFfmpegGraphFileOption({ run: async () => ({ ...result, cancelled: true }) }, signal), /cancelled/);
  await assert.rejects(probeFfmpegGraphFileOption({ run: async () => ({ ...result, stdout: new TextEncoder().encode("unknown encoder") }) }, signal));
});
