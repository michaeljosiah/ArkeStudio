import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FSWatcher, watch } from "node:fs";
import { WorldWatcher } from "../../src/world/watcher.js";
import { closeOnCleanup, tempDir } from "../tmp.js";

/** Comfortably past the watcher's 400 ms debounce, so "nothing reported" means nothing reported. */
const PAST_DEBOUNCE_MS = 700;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
  unref(): this {
    return this;
  }
}

/** A stand-in for fs.watch, so the error paths can be driven rather than raced. */
function stubWatch() {
  const watcher = new FakeWatcher();
  let listener: ((event: string, filename: string) => void) | null = null;
  const open = ((_dir: string, _options: unknown, cb: (event: string, filename: string) => void) => {
    listener = cb;
    return watcher as unknown as FSWatcher;
  }) as unknown as typeof watch;
  // A closed watcher delivers nothing — the real one stops at close(), and so does this.
  const change = (filename: string) => {
    if (!watcher.closed) listener?.("rename", filename);
  };
  return { open, watcher, change };
}

describe("the external-edit watcher (R-23)", () => {
  it("a directory that vanished mid-walk is not an external edit, and never a crash", async () => {
    const { open, watcher, change } = stubWatch();
    let reported = 0;
    const w = new WorldWatcher("/world", () => reported++, { watch: open });
    w.start();
    closeOnCleanup(() => w.stop());

    // How Node's emulated recursive watch reports a directory deleted between the change
    // event and its re-read — an accepted proposal taking `.proposals/<id>/` with it.
    const gone = Object.assign(new Error("ENOENT: no such file or directory, scandir '...'"), {
      code: "ENOENT",
    });
    assert.doesNotThrow(
      () => watcher.emit("error", gone),
      "an emitter with no error listener rethrows into the process",
    );
    assert.equal(watcher.closed, false, "one deleted directory does not end the watch");

    change("characters/maren-kest.md");
    await delay(PAST_DEBOUNCE_MS);
    assert.equal(reported, 1, "the watch still reports real edits afterwards");
  });

  it("lets go of a watch that can no longer see the world", async () => {
    const { open, watcher, change } = stubWatch();
    let reported = 0;
    const w = new WorldWatcher("/world", () => reported++, { watch: open });
    w.start();
    closeOnCleanup(() => w.stop());

    // inotify exhausted: the watch is still open but blind, and blind is worse than absent.
    watcher.emit("error", Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
    assert.equal(watcher.closed, true);

    change("characters/maren-kest.md");
    await delay(PAST_DEBOUNCE_MS);
    assert.equal(reported, 0, "a watch we no longer trust reports nothing");
  });

  it("survives proposal directories appearing and vanishing beneath it", async () => {
    const dir = await tempDir("arke-watch-");
    let reported = 0;
    const w = new WorldWatcher(dir, () => reported++);
    w.start();
    closeOnCleanup(() => w.stop());

    // The accept/discard churn that used to kill the test process on Linux: Node attaches a
    // watcher to each new directory, then re-reads it on change — after `rm` removed it.
    for (let i = 0; i < 25; i++) {
      const proposal = join(dir, ".proposals", `pr_${i}`);
      await mkdir(join(proposal, "characters"), { recursive: true });
      await writeFile(join(proposal, "characters", "maren-kest.md"), "sheet\n", "utf8");
      await rm(proposal, { recursive: true, force: true });
    }

    await delay(PAST_DEBOUNCE_MS);
    assert.equal(reported, 0, ".proposals is app-owned: churn there is never an external edit");
  });
});
