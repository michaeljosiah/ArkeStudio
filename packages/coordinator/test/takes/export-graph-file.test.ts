import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { graphInFile, INLINE_ARGUMENTS_MOST, runExport, type FfmpegRunner } from "../../src/takes/export.js";
import { tempDir } from "../tmp.js";

/**
 * A long filter graph reaches the encoder in a file. Windows gives a process 32,767 characters
 * of arguments, and a scene's cut passes that before it is large: a gated take's chain spells
 * every stretch it keeps, and a room laid from pieces is a chain a piece. The effects export has
 * always written its graph out; the plain export handed it over inline, and on such a cut the
 * encoder never started (`spawn ENAMETOOLONG`).
 */

const font = "/fonts/Geist-Regular.ttf", exportId = "ex_01J8F3K2QW9VZX4N7M0RTYB6HC";
const chain = (index: number) => `[${index}:a]aresample=48000,volume=-6dB[ac${index}]`;
const graphOf = (chains: number) => Array.from({ length: chains }, (_, index) => chain(index)).join(";");
const argsWith = (graph: string) => (stage: string): string[] => ["-y", "-i", "a.wav", "-filter_complex", graph, "-map", "[aout]", stage];

describe("a long filter graph goes to the encoder in a file", () => {
  it("leaves a short export's arguments as they were built", async () => {
    const worldDir = await tempDir("arke-graph-file-"), seen: string[][] = [];
    const runner: FfmpegRunner = { slateFont: font, graphFileOption: async () => assert.fail("a short graph asks the encoder nothing"),
      run: async argv => { seen.push(argv); await writeFile(argv.at(-1)!, "rendered"); } };
    const short = graphOf(20);
    assert.equal((await runExport(worldDir, argsWith(short), "film.mp4", runner, () => {}, undefined, exportId).done).status, "done");
    assert.deepEqual(seen[0]!.slice(0, 7), ["-y", "-i", "a.wav", "-filter_complex", short, "-map", "[aout]"]);
  });

  it("writes a long one beside the stage, names it with the option the encoder reads, and removes it whatever the encode did", async () => {
    const worldDir = await tempDir("arke-graph-file-"), long = graphOf(900), stageDir = join(worldDir, ".cache", "exports");
    assert.ok(long.length > INLINE_ARGUMENTS_MOST && long.length < 60_000, `${long.length} characters`);
    let read = "", seen: string[] = [];
    const runner = (fail: boolean): FfmpegRunner => ({ slateFont: font, graphFileOption: async () => "-/filter_complex",
      run: async argv => {
        seen = argv; read = await readFile(argv[argv.indexOf("-/filter_complex") + 1]!, "utf8");
        if (fail) throw new Error("encoder exploded");
        await writeFile(argv.at(-1)!, "rendered");
      } });
    const done = await runExport(worldDir, argsWith(long), "film.mp4", runner(false), () => {}, undefined, exportId).done;
    assert.equal(done.status, "done");
    assert.deepEqual(seen.slice(0, 5), ["-y", "-i", "a.wav", "-/filter_complex", join(stageDir, `${exportId}.ffgraph`)]);
    assert.deepEqual(seen.slice(5, 7), ["-map", "[aout]"], "everything after the graph is where it was");
    assert.equal(seen.includes("-filter_complex"), false);
    assert.equal(read, long, "the encoder reads the graph that was built, whole");
    assert.ok(seen.reduce((sum, arg) => sum + arg.length + 3, 0) < 1000, "and its arguments are short again");
    assert.deepEqual(await readdir(stageDir), [], "nothing is left in the stage");
    assert.equal((await stat(join(worldDir, "exports", "film.mp4"))).isFile(), true);

    const failed = await runExport(worldDir, argsWith(long), "failed.mp4", runner(true), () => {}, undefined, "ex_01J8F3K2QW9VZX4N7M0RTYB6HD").done;
    assert.deepEqual(failed, { status: "failed", error: "encoder exploded" });
    assert.deepEqual(await readdir(stageDir), [], "a failed encode leaves no graph behind either");

    // An older encoder reads the same file by its older option.
    const older: FfmpegRunner = { ...runner(false), graphFileOption: async () => "-filter_complex_script" };
    assert.deepEqual((await graphInFile(argsWith(long)("out.mp4"), older, join(worldDir, "older.ffgraph"), new AbortController().signal)).slice(3, 5), ["-filter_complex_script", join(worldDir, "older.ffgraph")]);
  });

  it("hands a long graph over inline where the encoder cannot say how it reads a file, and counts every argument, not the graph alone", async () => {
    const worldDir = await tempDir("arke-graph-file-"), long = graphOf(900), signal = new AbortController().signal;
    const plain: FfmpegRunner = { slateFont: font, run: async () => {} };
    assert.equal((await graphInFile(argsWith(long)("out.mp4"), plain, join(worldDir, "x.ffgraph"), signal))[4], long);
    // Two hundred sounds' paths with a modest graph are as long as one long graph.
    const many = ["-y", ...Array.from({ length: 220 }, (_, index) => ["-i", `C:/Users/someone/ArkeStudio/worlds/a-world-with-a-long-name/productions/the-film/takes/tk_${String(index).padStart(26, "0")}/clip.mp4`]).flat(),
      "-filter_complex", graphOf(40), "-map", "[aout]", "out.mp4"];
    const moved = await graphInFile(many, { graphFileOption: async () => "-/filter_complex" }, join(worldDir, "many.ffgraph"), signal);
    assert.equal(moved.includes("-/filter_complex"), true);
    assert.equal(await readFile(join(worldDir, "many.ffgraph"), "utf8"), graphOf(40));
    // No graph at all is nothing to move.
    const none = ["-y", "-i", "a.wav", "out.mp4"];
    assert.equal(await graphInFile(none, { graphFileOption: async () => assert.fail("nothing to ask") }, join(worldDir, "none.ffgraph"), signal), none);
  });
});