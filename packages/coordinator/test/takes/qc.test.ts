import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTakeQcAnalyzer,
  measureFramemd5,
  parseFramemd5,
  takeQcArgs,
  QC_MAX_OUTPUT_BYTES,
  QC_TIMEOUT_MS,
  type MediaProbeRunner,
} from "../../src/takes/qc.js";

/**
 * #248. Every case runs against a fake runner: ffmpeg is bundled with the packaged build and
 * absent from CI, and a test that needed it would only ever prove which machine it ran on.
 */

/** framemd5 as ffmpeg writes it: a timebase comment, then one row per frame. */
function framemd5(hashes: string[], timeBase = "1/24"): string {
  const header = ["#format: frame checksums", "#version: 2", `#tb 0: ${timeBase}`, "#stream#, dts, pts, duration, size, hash"];
  const rows = hashes.map((hash, index) => `0, ${index}, ${index}, 1, 76800, ${hash}`);
  return [...header, ...rows].join("\n") + "\n";
}

const runnerOf = (result: Partial<Awaited<ReturnType<MediaProbeRunner["run"]>>>): MediaProbeRunner => ({
  run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...result }),
});

describe("take QC — adjacent framemd5 (#248)", () => {
  it("computes effective FPS from adjacent framemd5 hashes deterministically", async () => {
    // 25 rows = 24 transitions across exactly one second at tb 1/24, of which 10 repeat.
    const hashes: string[] = [];
    let distinct = 0;
    for (let index = 0; index < 25; index += 1) {
      // Ten duplicate transitions: rows 1..10 repeat their predecessor.
      if (index >= 1 && index <= 10) hashes.push(`h${distinct}`);
      else hashes.push(`h${++distinct}`);
    }
    const analyzer = createTakeQcAnalyzer(runnerOf({ stdout: framemd5(hashes) }));
    const analysis = await analyzer.analyze("clip.mp4");
    assert.ok(analysis.ok);
    assert.equal(analysis.qc.duplicateFrames, 10);
    assert.equal(analysis.qc.duplicateRatio, 0.416667, "ten of twenty-four transitions, to six places");
    assert.equal(analysis.qc.nominalFps, 24);
    assert.equal(analysis.qc.effectiveFps, 14, "24 × (1 − 10/24)");
    assert.equal(analysis.qc.status, "degraded");
    assert.equal(analysis.qc.sampledFrames, 25);
    assert.equal(analysis.qc.method, "adjacent-framemd5-v1");
    assert.equal(analysis.qc.scope, "source-media", "the file, not an editorial range");

    // No adjacent repeats at all: nominal and effective agree, and nothing is flagged.
    const clean = createTakeQcAnalyzer(
      runnerOf({ stdout: framemd5(Array.from({ length: 25 }, (_, i) => `d${i}`)) }),
    );
    const cleanAnalysis = await clean.analyze("clip.mp4");
    assert.ok(cleanAnalysis.ok);
    assert.equal(cleanAnalysis.qc.duplicateRatio, 0);
    assert.equal(cleanAnalysis.qc.effectiveFps, cleanAnalysis.qc.nominalFps);
    assert.equal(cleanAnalysis.qc.status, "clean");
  });

  it("treats exactly eighty percent effective FPS as clean", () => {
    // 21 rows = 20 transitions; 4 duplicates is exactly 20% lost, so exactly the threshold.
    const hashes = ["a", "a", "b", "b", "c", "c", "d", "d", "e"];
    let next = 0;
    while (hashes.length < 21) hashes.push(`u${next++}`);
    const parsed = parseFramemd5(framemd5(hashes))!;
    const qc = measureFramemd5(parsed)!;
    assert.equal(qc.duplicateFrames, 4);
    assert.equal(qc.duplicateRatio, 0.2);
    assert.equal(qc.status, "clean", "the boundary belongs to clean — a threshold is a floor, not a trap");
    assert.equal(qc.thresholdRatio, 0.8);
  });

  it("refuses malformed timestamps and partial metrics", async () => {
    // Timestamps that do not advance: presentation order is the one thing the metric trusts.
    const stalled = "#tb 0: 1/24\n0, 0, 5, 1, 100, aa\n0, 1, 5, 1, 100, bb\n";
    assert.equal(measureFramemd5(parseFramemd5(stalled)!), null);

    // A missing timebase is unreadable rather than assumed.
    assert.equal(parseFramemd5("0, 0, 0, 1, 100, aa\n0, 1, 1, 1, 100, bb\n"), null);
    // As is a truncated row.
    assert.equal(parseFramemd5("#tb 0: 1/24\n0, 0, 0\n"), null);
    // One frame describes no transition, so there is nothing to measure.
    assert.equal(measureFramemd5(parseFramemd5(framemd5(["only"]))!), null);

    // Each surfaces as a named reason, and never as a half-filled record.
    const malformed = await createTakeQcAnalyzer(runnerOf({ stdout: "not framemd5 at all" })).analyze("c.mp4");
    assert.deepEqual(malformed, { ok: false, reason: "malformed-output" });
    const unsupported = await createTakeQcAnalyzer(runnerOf({ stdout: framemd5(["single"]) })).analyze("c.mp4");
    assert.deepEqual(unsupported, { ok: false, reason: "unsupported-media" });
    const failed = await createTakeQcAnalyzer(runnerOf({ code: 1, stderr: "boom" })).analyze("c.mp4");
    assert.deepEqual(failed, { ok: false, reason: "process-failed" });
    const threw = await createTakeQcAnalyzer({
      run: () => Promise.reject(new Error("spawn ENOENT")),
    }).analyze("c.mp4");
    assert.deepEqual(threw, { ok: false, reason: "process-failed" }, "a runner that throws is a reason, not an exception");
  });

  it("caps decoding by frames, media time, wall clock, and captured output", async () => {
    const args = takeQcArgs("C:\\worlds\\a world\\takes\\clip.mp4");
    assert.deepEqual(
      [args[args.indexOf("-t") + 1], args[args.indexOf("-frames:v") + 1], args[args.indexOf("-vf") + 1]],
      ["8", "180", "scale=320:-2"],
      "eight seconds, 180 frames, thumbnail width — three independent ceilings",
    );
    assert.equal(args[args.length - 1], "-", "hashes to stdout; the probe writes no media anywhere");
    assert.ok(args.includes("framemd5"));
    assert.equal(
      args[args.indexOf("-i") + 1],
      "C:\\worlds\\a world\\takes\\clip.mp4",
      "the path is one argument — a filename is never a place to discover shell quoting",
    );

    let seen: { timeoutMs: number; maxOutputBytes: number } | null = null;
    const analyzer = createTakeQcAnalyzer({
      run: async (_args, limits) => {
        seen = limits;
        return { code: 0, stdout: "", stderr: "", timedOut: true };
      },
    });
    const analysis = await analyzer.analyze("clip.mp4");
    assert.deepEqual(seen, { timeoutMs: QC_TIMEOUT_MS, maxOutputBytes: QC_MAX_OUTPUT_BYTES });
    assert.deepEqual(analysis, { ok: false, reason: "timeout" });

    const oversize = await createTakeQcAnalyzer(
      runnerOf({ stdout: "x".repeat(QC_MAX_OUTPUT_BYTES + 1) }),
    ).analyze("clip.mp4");
    assert.deepEqual(oversize, { ok: false, reason: "output-too-large" });
  });
});
