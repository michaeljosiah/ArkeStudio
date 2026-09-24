import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FSWatcher, watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { exportWorld, WORLD_EXPORT_EXCLUDED } from "../../src/takes/export.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldWatcher } from "../../src/world/watcher.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

/**
 * `.conversations` is unfinished workspace, like `.proposals` (#70 §4.4).
 *
 * Three separate mechanisms have to agree about that, and each fails differently if it does not:
 * the watcher would accuse the app of editing the world behind its own back, scanWorld would try
 * to parse conversation records as world content, and export would hand somebody else's
 * half-finished thinking to whoever received the world.
 */

/** The fixture world, plus whatever conversation records the test wants inside it. */
async function worldWith(files: Record<string, string>): Promise<string> {
  const dir = await makeTempWorld();
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body, "utf8");
  }
  return dir;
}

describe("conversations are operational state, not world content", () => {
  it("is ignored by the external-edit watcher", async () => {
    // Driven through the watcher with a stand-in for fs.watch: an append under .conversations
    // raises nothing, an edit beside it still does. Without the exclusion every message the app
    // appends would read as an outside edit.
    let listener: ((event: string, filename: string) => void) | null = null;
    const open = ((_dir: string, _options: unknown, cb: (event: string, filename: string) => void) => {
      listener = cb;
      return Object.assign(new EventEmitter(), { close() {}, unref() { return this; } }) as unknown as FSWatcher;
    }) as unknown as typeof watch;
    let reported = 0;
    const watcher = new WorldWatcher("/world", () => reported++, { watch: open });
    watcher.start();
    try {
      listener!("change", join(".conversations", "cv_x", "events.jsonl"));
      listener!("rename", ".conversations");
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(reported, 0, "the app's own conversation writes are not an outside edit");
      listener!("change", "notes.md");
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(reported, 1, "an edit to the world beside them still is");
    } finally {
      watcher.stop();
    }
  });

  it("is left out of an export", () => {
    assert.ok(
      WORLD_EXPORT_EXCLUDED.includes(".conversations"),
      "an export is for another machine; unfinished thinking is not part of the world it describes",
    );
  });

  it("really is absent from an exported copy", async () => {
    const dir = await worldWith({
      ".conversations/cv_x/events.jsonl": '{"seq":1}\n',
      ".history/conversation-actions.jsonl": '{"actionId":"act_audit"}\n',
      "canon/CANON-001.md": "---\nid: CANON-001\n---\n",
    });
    const target = join(await tempDir("arke-export-"), "out");
    await exportWorld(dir, target);

    await assert.rejects(
      () => readFile(join(target, ".conversations", "cv_x", "events.jsonl"), "utf8"),
      "the conversation directory should not have been copied",
    );
    assert.equal(
      await readFile(join(target, ".history", "conversation-actions.jsonl"), "utf8"),
      '{"actionId":"act_audit"}\n',
      "the action audit remains part of the exported world history",
    );
    // The world itself still arrives, or the exclusion has taken too much with it.
    assert.ok(await readFile(join(target, "world.json"), "utf8"));
  });

  it("is invisible to scanWorld, which reads named directories rather than walking", async () => {
    const dir = await worldWith({
      ".conversations/cv_x/events.jsonl": "not parseable as anything the world model knows\n",
      ".conversations/cv_x/conversation.json": '{"schemaVersion":1}',
    });

    const world = await scanWorld(dir);
    // A file the scanner cannot parse normally becomes a named world problem. These do not,
    // because the scanner never looks in the directory at all.
    assert.equal(
      world.problems.length,
      0,
      "conversation records must not be reported as unreadable world content",
    );
  });

  it("keeps proposal staging out of the external-edit manifest", async () => {
    const world = await scanWorld(await makeTempWorld());
    assert.equal(
      Object.keys(world.manifest).some((path) => path.startsWith(".proposals/")),
      false,
    );
  });
});
