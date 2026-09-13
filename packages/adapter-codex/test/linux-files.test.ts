import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureRootIdentity, ConfinedFiles, resolveRoot } from "../src/confined-files.js";

test("Linux FIFO reads refuse without blocking cancellation or subsequent file operations", { skip: process.platform !== "linux", timeout: 15_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "arke-codex-fifo-"));
  const fifo = join(base, "waiting.pipe");
  const abort = new AbortController();
  let files: ConfinedFiles | undefined;
  let reading: Promise<Buffer> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await promisify(execFile)("mkfifo", [fifo], { timeout: 5000 });
    await writeFile(join(base, "regular.txt"), "regular content");
    const root = await resolveRoot(base); const identity = await captureRootIdentity(root);
    files = await ConfinedFiles.create(root, identity, abort.signal);
    reading = files.read("waiting.pipe");
    await assert.rejects(Promise.race([
      reading,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          abort.abort();
          reject(new Error("FIFO read remained blocked instead of refusing the special file."));
        }, 5000);
      }),
    ]), /confinement/);
    clearTimeout(deadline);
    assert.equal((await files.read("regular.txt")).toString(), "regular content");
    abort.abort();
    await assert.rejects(files.read("regular.txt"), /abort/i);
    await files.close(); files = undefined;
    files = await ConfinedFiles.create(root, identity, new AbortController().signal);
    assert.equal((await files.read("regular.txt")).toString(), "regular content");
  } finally {
    clearTimeout(deadline); abort.abort();
    // If O_NONBLOCK is accidentally removed, the failed assertion must not strand libuv's
    // read-open worker. A nonblocking writer releases that pending open without hanging
    // cleanup when the implementation correctly refused the FIFO and no reader exists.
    const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).catch(() => undefined);
    await writer?.close();
    await reading?.catch(() => {});
    await files?.close();
    await rm(base, { recursive: true, force: true });
  }
});
