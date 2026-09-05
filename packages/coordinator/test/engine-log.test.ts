import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ENGINE_LOG_CAP_BYTES, EngineLog } from "../src/supervisor.js";
import { tempDir } from "./tmp.js";


/** What an engine said is kept, bounded, with one previous generation (SPEC-033 R-70; issue 585). */
describe("engine log", () => {
  it("keeps both streams in arrival order and rotates once past the cap, keeping one generation", async () => {
    const file = join(await tempDir("arke-engine-log-"), "engines", "comfyui.log");
    const log = new EngineLog(file);
    log.open("=== spawned ===\n");
    log.write("out: launch line\n");
    log.write(Buffer.from("err: Traceback (most recent call last)\n"));
    await log.close();
    assert.equal(
      await readFile(file, "utf8"),
      "=== spawned ===\nout: launch line\nerr: Traceback (most recent call last)\n",
      "the directory is made and the streams land as they arrived",
    );

    // A second run appends; the write that would cross the cap moves the file aside first and
    // lands in a fresh one, so what was said before the cap is the generation kept.
    const before = (await stat(file)).size;
    const header = "=== spawned again ===\n";
    const again = new EngineLog(file);
    again.open(header);
    again.write(Buffer.alloc(ENGINE_LOG_CAP_BYTES - before - header.length - 10, 0x61));
    again.write("after the cap\n");
    await again.close();
    const previous = await readFile(`${file}.1`, "utf8");
    assert.ok(previous.startsWith("=== spawned ===\n"), "the earlier run heads the generation kept");
    assert.ok(previous.includes(header), "and it holds everything written before the cap");
    assert.ok((await stat(`${file}.1`)).size <= ENGINE_LOG_CAP_BYTES, "bounded, not merely rotated");
    assert.equal(await readFile(file, "utf8"), "after the cap\n", "the current file holds only what came after");
  });
});
