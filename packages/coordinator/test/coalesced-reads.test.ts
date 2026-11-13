import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { CoalescedReads, ReadStalledError, type ReadTurn } from "../src/coalesced-reads.js";

/** A read the test finishes by hand, and every turn it was given. */
function reads() {
  const turns: Array<{ turn: ReadTurn; finish(value: string): void; fail(error: Error): void }> = [];
  const read = (turn: ReadTurn) => new Promise<string>((resolve, reject) => { turns.push({ turn, finish: resolve, fail: reject }); });
  return { turns, read };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

it("asks made while a read runs share one waiting read, started when the running one ends", async () => {
  const coalesced = new CoalescedReads<string>(60_000);
  const { turns, read } = reads();
  const first = coalesced.ask("book", read);
  const second = coalesced.ask("book", read);
  const third = coalesced.ask("book", read);
  const chapter = coalesced.ask("chapter-1", read);
  assert.equal(turns.length, 2, "one read for the book and one for the chapter; the later book asks wait");
  turns[0]!.finish("as it was when first was asked");
  assert.equal(await first, "as it was when first was asked");
  await settle();
  assert.equal(turns.length, 3, "the waiting read starts once the running one has answered");
  turns[2]!.finish("read after second and third were asked");
  assert.deepEqual(await Promise.all([second, third]), ["read after second and third were asked", "read after second and third were asked"]);
  turns[1]!.finish("chapter");
  assert.equal(await chapter, "chapter");
  await settle();
  assert.equal(coalesced.size, 0, "nothing is held once every ask is answered");
});

it("answers a read past its deadline as stalled, with where it was, stops it, and still reads for the asks behind it (2026-10-24)", async () => {
  const coalesced = new CoalescedReads<string>(30);
  const { turns, read } = reads();
  const stuck = coalesced.ask("book", (turn) => { turn.stage("waiting for the world"); return read(turn); });
  const behind = coalesced.ask("book", read);
  const error = await stuck.then(() => null, (reason: unknown) => reason);
  assert.ok(error instanceof ReadStalledError);
  assert.equal(error.stage, "waiting for the world");
  assert.match(error.message, /^stalled for \d+ s waiting for the world$/);
  assert.equal(turns[0]!.turn.signal.aborted, true, "the stalled read is told to stop");
  await settle();
  assert.equal(turns.length, 2, "a read that never ends no longer holds the asks behind it");
  turns[1]!.finish("read");
  assert.equal(await behind, "read");
  // The stalled read answering late changes nothing.
  turns[0]!.finish("too late");
  await settle();
  assert.equal(coalesced.size, 0);
});

it("holds the process open until a stalled read's deadline answers it", () => {
  // The runner cannot witness this itself: Node 22 cancels a file whose loop drains mid-test (the
  // book-read tests went down that way on Windows CI from PR #2181 on) and Node 24 parks on a
  // keep-alive of its own. A bare child process can.
  const fixture = fileURLToPath(new URL("./fixtures/stalled-read-holds-loop.ts", import.meta.url));
  const child = spawnSync(process.execPath, ["--import", "tsx", fixture], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.status, 0, child.error ? String(child.error) : child.stderr);
  assert.deepEqual(child.stdout.trim().split(/\r?\n/), ["stalled: waiting for the world", "beforeExit"]);
});

it("answers a failed read with its error, and a later ask reads again", async () => {
  const coalesced = new CoalescedReads<string>(60_000);
  const { turns, read } = reads();
  const failing = coalesced.ask("book", read);
  turns[0]!.fail(new Error("That production is no longer in this world."));
  await assert.rejects(failing, /no longer in this world/);
  const again = coalesced.ask("book", read);
  assert.equal(turns.length, 2);
  turns[1]!.finish("read");
  assert.equal(await again, "read");
  await assert.rejects(coalesced.ask("book", () => { throw new Error("thrown at once"); }), /thrown at once/);
});
