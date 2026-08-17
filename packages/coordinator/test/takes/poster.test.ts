import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tempDir } from "../tmp.js";
import {
  backfillPosters,
  createTakePosterMaker,
  isVideoMedia,
  posterArgs,
  posterNameFor,
  writePosterFor,
  POSTER_MAX_WIDTH,
  POSTER_NAME,
  type TakePosterMaker,
} from "../../src/takes/poster.js";
import type { MediaProbeRunner } from "../../src/takes/qc.js";

/**
 * The poster seam (2026-08-17): a video take's first frame, written beside the clip.
 *
 * The tests that matter here are the refusals. This runs inside finalization, which is not
 * replayable — so every way the extraction can go wrong has to end with the take intact and a
 * reason reported, and none of them may throw.
 */

function runner(result: Partial<Awaited<ReturnType<MediaProbeRunner["run"]>>>): {
  runner: MediaProbeRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run: async (args) => {
        calls.push([...args]);
        return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
      },
    },
  };
}

describe("which media gets a picture drawn", () => {
  it("knows a clip from a still", () => {
    for (const video of ["output-1.mp4", "clip.webm", "TAKE.MOV", "a.m4v"]) {
      assert.equal(isVideoMedia(video), true, video);
      assert.equal(posterNameFor(video), POSTER_NAME, video);
    }
    for (const still of ["image-1.png", "take.jpg", "speech.wav", "speech.mp3"]) {
      assert.equal(isVideoMedia(still), false, still);
      assert.equal(posterNameFor(still), still, "a picture, or a sound, is named directly");
    }
  });

  it("asks for nothing at all when the media is not a video", async () => {
    let asked = 0;
    const drawn = await writePosterFor("/w/take/speech.wav", {
      write: async () => {
        asked += 1;
        return { ok: true };
      },
    });
    assert.equal(drawn, false);
    assert.equal(asked, 0, "no subprocess for a sound");
  });
});

describe("the command", () => {
  it("takes one frame, never upscales, and hands paths as arguments", () => {
    const args = posterArgs("C:/worlds/a world/clip.mp4", "C:/worlds/a world/frame.png");
    assert.deepEqual(args.slice(-2), ["-y", "C:/worlds/a world/frame.png"]);
    // A path with a space is one argument, not a string a shell would split.
    assert.ok(args.includes("C:/worlds/a world/clip.mp4"));
    assert.deepEqual(
      [args[args.indexOf("-frames:v")], args[args.indexOf("-frames:v") + 1]],
      ["-frames:v", "1"],
      "the first frame, and only it",
    );
    assert.ok(
      args.some((a) => a === `scale='min(${POSTER_MAX_WIDTH},iw)':-2`),
      "a 320px clip keeps its size rather than being blown up to 960",
    );
  });
});

describe("when the drawing fails", () => {
  it("reports the reason and never throws", async () => {
    const cases: Array<[Partial<Awaited<ReturnType<MediaProbeRunner["run"]>>>, string]> = [
      [{ timedOut: true }, "timeout"],
      [{ code: 1, stderr: "moov atom not found" }, "process-failed"],
      [{ code: null }, "process-failed"],
    ];
    for (const [result, expected] of cases) {
      const reasons: string[] = [];
      const drawn = await writePosterFor(
        "/w/take/clip.mp4",
        createTakePosterMaker(runner(result).runner),
        (reason) => reasons.push(reason),
      );
      assert.equal(drawn, false);
      assert.deepEqual(reasons, [expected]);
    }
  });

  it("survives a runner that throws, and a reporter that throws with it", async () => {
    const thrower: MediaProbeRunner = {
      run: async () => {
        throw new Error("spawn ENOENT");
      },
    };
    const drawn = await writePosterFor("/w/take/clip.mp4", createTakePosterMaker(thrower), () => {
      throw new Error("the log is broken too");
    });
    assert.equal(drawn, false, "a diagnostic that fails is still only a diagnostic");
  });

  it("says so when there is no ffmpeg at all — the ordinary state of most builds", async () => {
    const reasons: string[] = [];
    const drawn = await writePosterFor("/w/take/clip.mp4", undefined, (r) => reasons.push(r));
    assert.equal(drawn, false);
    assert.deepEqual(reasons, ["not-configured"]);
  });
});

describe("when it works", () => {
  it("writes the poster beside its clip, whichever separator the host uses", async () => {
    for (const [media, poster] of [
      ["/worlds/u/takes/tk_1/output-1.mp4", "/worlds/u/takes/tk_1/frame.png"],
      ["C:\\worlds\\u\\takes\\tk_1\\clip.webm", "C:\\worlds\\u\\takes\\tk_1\\frame.png"],
    ]) {
      const { runner: r, calls } = runner({ code: 0 });
      const drawn = await writePosterFor(media!, createTakePosterMaker(r));
      assert.equal(drawn, true);
      assert.equal(calls[0]!.at(-1), poster);
    }
  });
});

/**
 * The one-time backfill. Every video take that landed before posters existed is a grey box, and
 * the client's `Portrait` remembers a failed decode per source URL — so a picture drawn after
 * the screen renders would sit on disk unseen. Hence: before the snapshot, and bounded.
 */
describe("catching up the takes that landed before this existed", () => {
  it("draws only what is missing, and only for video", async () => {
    const dir = await tempDir("poster-backfill");
    const drawn: string[] = [];
    const maker: TakePosterMaker = {
      write: async (_input, output) => {
        drawn.push(output);
        await writeFile(output, Buffer.from("png"));
        return { ok: true };
      },
    };
    const candidates = [
      { id: "tk_a", dir: join(dir, "tk_a"), file: "output-1.mp4" },
      { id: "tk_b", dir: join(dir, "tk_b"), file: "image-1.png" }, // already a picture
      { id: "tk_c", dir: join(dir, "tk_c"), file: "clip.webm" }, // already drawn, below
      { id: "tk_d", dir: join(dir, "tk_d"), file: "speech.wav" }, // nothing to look at
    ];
    for (const c of candidates) await mkdir(c.dir, { recursive: true });
    await writeFile(join(dir, "tk_c", "frame.png"), Buffer.from("drawn earlier"));

    const count = await backfillPosters(candidates, maker, { budgetMs: 10_000 });
    assert.equal(count, 1);
    // Ends-with, not equals: paths go to ffmpeg through `toExtendedLength`, so they carry the
    // `\\?\` prefix that lets a world sit deeper than 260 characters.
    assert.equal(drawn.length, 1);
    assert.ok(drawn[0]!.endsWith(join("tk_a", "frame.png")), drawn[0]);
    // The one that already had a picture keeps the one it had — never redrawn over.
    assert.equal(await readFile(join(dir, "tk_c", "frame.png"), "utf8"), "drawn earlier");

    // A second pass over the same session costs a stat each and draws nothing.
    drawn.length = 0;
    assert.equal(await backfillPosters(candidates, maker, { budgetMs: 10_000 }), 0);
    assert.deepEqual(drawn, []);
  });

  it("stops at the budget rather than holding the session shut", async () => {
    const dir = await tempDir("poster-budget");
    const drawn: string[] = [];
    const maker: TakePosterMaker = {
      write: async (_i, output) => {
        drawn.push(output);
        return { ok: true };
      },
    };
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      id: `tk_${i}`,
      dir: join(dir, `tk_${i}`),
      file: "clip.mp4",
    }));
    for (const c of candidates) await mkdir(c.dir, { recursive: true });

    // A clock that spends a second per take: three fit inside a 2.5s budget, the rest wait for
    // the next open. Nothing is lost — a later pass finds them still missing and draws them.
    let clock = 0;
    const count = await backfillPosters(candidates, maker, {
      budgetMs: 2_500,
      now: () => (clock += 1_000) - 1_000,
    });
    assert.ok(count > 0 && count < candidates.length, `drew ${count} of ${candidates.length}`);
  });

  it("does nothing at all on a build with no ffmpeg", async () => {
    const count = await backfillPosters(
      [{ id: "tk_a", dir: "/nowhere", file: "clip.mp4" }],
      undefined,
      { budgetMs: 10_000 },
    );
    assert.equal(count, 0);
  });
});
