import assert from "node:assert/strict";
import { appendFile, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type WorldChatStoredEvent } from "@arke-studio/contracts";
import { ConversationIntegrityError, WorldChatStore } from "../../src/world-chat/store.js";
import { tempDir } from "../tmp.js";

/**
 * The conversation log is the only copy of what was said, so these are mostly about what
 * survives a crash rather than what works when nothing goes wrong (#70 §21.2).
 */

const AT = "2026-08-06T09:00:00Z";

async function store(): Promise<WorldChatStore> {
  const dir = await tempDir("arke-world-chat-");
  const id = newId("cv");
  const s = new WorldChatStore(join(dir, id));
  await s.create(id, AT);
  return s;
}

function message(text: string): WorldChatStoredEvent {
  const turnId = newId("turn");
  return {
    type: "turn.started",
    message: { id: newId("msg"), turnId, role: "user", text, attachmentIds: [], createdAt: AT },
    run: {
      id: newId("run"),
      turnId,
      basedOnConversationSeq: 0,
      status: "running",
      adapter: "opencode",
      harnessCleanup: "pending",
      contextDigest: `sha256:${"a".repeat(64)}`,
      startedAt: AT,
    },
  };
}

describe("world chat store", () => {
  it("keeps what was appended, in order, with sequences from one", async () => {
    const s = await store();
    await s.append(message("first"), { at: AT });
    await s.append(message("second"), { at: AT });

    const { events, problems } = await s.read();
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.seq),
      [1, 2],
    );
    assert.equal(problems.length, 0);
  });

  it("gives every append its own sequence, even from stores built separately", async () => {
    const s = await store();
    // Three files dropped into a conversation at once is three client frames, three handlers
    // started without waiting for the one before, and three stores built on the same directory.
    // Each append reads the tail to find its number, so unserialised they read the same tail and
    // claimed the same number — which is how a real conversation ended up with two seq 16s and
    // could never be wrapped up again.
    const concurrent = [new WorldChatStore(s.dir), new WorldChatStore(s.dir), new WorldChatStore(s.dir)];
    await Promise.all(concurrent.map((w, i) => w.append(message(`file ${i}`), { at: AT })));

    const { events, problems } = await new WorldChatStore(s.dir).read();
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((e) => e.seq),
      [1, 2, 3],
      "one sequence number per record, however many stores were holding the file",
    );
    assert.deepEqual(problems, [], "and no writer mistook another's append for a foreign one");
  });

  it("forgets the tail when an append fails after the bytes may have landed", async () => {
    const s = await store();
    await s.append(message("ours"), { at: AT });

    // `sync` failing stands for every step that can throw once the record may be down — close,
    // and the digest read after it. The writer cannot know whether the bytes are there, and a
    // tail it merely believes would make it call the studio's own record a foreign write and
    // refuse every later append to this conversation until the app was restarted.
    const probe = await open(s.eventsPath, "r");
    const handles = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const real = handles.sync;
    handles.sync = () => Promise.reject(new Error("the device is having a moment"));
    try {
      await assert.rejects(() => s.append(message("during the wobble"), { at: AT }));
    } finally {
      handles.sync = real;
    }

    // Whatever landed, a fresh look at the file is the recovery — not a permanent refusal.
    await s.append(message("after"), { at: AT });
    const { events } = await new WorldChatStore(s.dir).read();
    assert.ok(
      events.some((e) => JSON.stringify(e).includes("after")),
      "the conversation can still be written to",
    );
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, i) => i + 1),
      "and its numbering is still one per record",
    );
  });

  it("re-checks a tail it may itself have torn, however often it has checked before", async () => {
    const s = await store();
    await s.append(message("ours"), { at: AT });

    // A write that puts down part of its line and then fails leaves exactly what a crash leaves —
    // but the process carries on, and this store has already spent its one repair. Without that
    // being reconsidered the retry extends the fragment, and the two halves become one line that
    // nothing can read while the append reports success.
    const probe = await open(s.eventsPath, "r");
    const handles = Object.getPrototypeOf(probe) as { appendFile: (data: string) => Promise<void> };
    await probe.close();
    const real = handles.appendFile;
    handles.appendFile = async function (this: unknown, data: string) {
      await real.call(this, data.slice(0, 30));
      throw new Error("no room left on the device");
    };
    try {
      await assert.rejects(() => s.append(message("cut in half"), { at: AT }));
    } finally {
      handles.appendFile = real;
    }

    await s.append(message("after"), { at: AT });
    const { events, problems } = await new WorldChatStore(s.dir).read();
    assert.ok(
      events.every((e) => typeof e.seq === "number"),
      "every line still parses — the fragment was cut, not extended",
    );
    assert.ok(
      events.some((e) => JSON.stringify(e).includes("after")),
      "and the record written after it is there",
    );
    assert.deepEqual(
      problems.filter((p) => p.kind === "interior-corruption"),
      [],
      "with no half-record left in the middle of the log",
    );
  });

  it("has the bytes on disk before the append resolves", async () => {
    const s = await store();
    await s.append(message("her aunt taught her the bells"), { at: AT });
    // No drain, no delay: the append's own promise is the durability guarantee, because the
    // caller's next act is to send this message to a model.
    const raw = await readFile(s.eventsPath, "utf8");
    assert.match(raw, /her aunt taught her the bells/);
    assert.ok(raw.endsWith("\n"), "a complete record ends its line");
  });

  it("treats a repeated request id as the same request", async () => {
    const s = await store();
    const first = await s.append(message("only once"), { at: AT, requestId: "req-1" });
    const again = await s.append(message("only once"), { at: AT, requestId: "req-1" });

    assert.equal(again.deduplicated, true);
    assert.equal(again.envelope.eventId, first.envelope.eventId, "the original is returned");
    const { events } = await s.read();
    assert.equal(events.length, 1, "a retry after a dropped connection must not duplicate a message");
  });

  // A torn tail is what the *previous* process left behind: within one instance every append is
  // fsynced and complete, so these reopen the conversation the way the app does after a crash.
  it("loses only the torn record when a write was cut short", async () => {
    const s = await store();
    await s.append(message("complete"), { at: AT });
    // The crash signature: bytes that are not yet a record and no closing newline.
    await appendFile(s.eventsPath, '{"schemaVersion":1,"seq":2,"eventId":"wce_', "utf8");

    const next = new WorldChatStore(s.dir);
    const { events, problems } = await next.read();
    assert.equal(events.length, 1, "the complete record before it survives");
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.kind, "torn-tail");
    assert.match(problems[0]!.detail, /Everything before it is intact/);
  });

  it("repairs a torn tail before extending it, rather than merging two half lines", async () => {
    const s = await store();
    await s.append(message("complete"), { at: AT });
    await appendFile(s.eventsPath, '{"schemaVersion":1,"seq":2,"partial', "utf8");

    const next = new WorldChatStore(s.dir);
    await next.append(message("after the crash"), { at: AT });

    const { events } = await next.read();
    assert.equal(events.length, 2);
    assert.equal(events[1]!.seq, 2, "the sequence continues from the last complete record");
    const raw = await readFile(next.eventsPath, "utf8");
    assert.ok(!raw.includes('"partial'), "the incomplete bytes are gone, not embedded in a record");
  });

  it("calls a mid-life change to the log a foreign write, not a crash", async () => {
    // The same bytes, arriving while the store is alive, mean another process is writing —
    // which is a different problem from a crash and must not be quietly repaired away.
    const s = await store();
    await s.append(message("ours"), { at: AT });
    await appendFile(s.eventsPath, '{"schemaVersion":1,"seq":2,"partial', "utf8");

    await assert.rejects(
      () => s.append(message("next"), { at: AT }),
      (err: unknown) => err instanceof ConversationIntegrityError && err.problem.kind === "foreign-write",
    );
  });

  it("names interior corruption instead of inventing state around it", async () => {
    const s = await store();
    await s.append(message("before"), { at: AT });
    await s.append(message("after"), { at: AT });

    const raw = await readFile(s.eventsPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    // Corrupt the middle and leave the file otherwise well-formed: this is not a torn tail.
    await writeFile(s.eventsPath, [lines[0], "{not json at all}", lines[1]].join("\n") + "\n", "utf8");

    const fresh = new WorldChatStore(s.dir);
    const { events, problems } = await fresh.read();
    assert.equal(events.length, 2, "the readable records on both sides are kept");
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.kind, "interior-corruption");
  });

  it("refuses to append when something else has written to the log", async () => {
    const s = await store();
    await s.append(message("ours"), { at: AT });
    // Ignoring .conversations in the world watcher means nothing else will notice this.
    await appendFile(s.eventsPath, JSON.stringify({ foreign: true }) + "\n", "utf8");

    await assert.rejects(
      () => s.append(message("next"), { at: AT }),
      (err: unknown) => {
        assert.ok(err instanceof ConversationIntegrityError);
        assert.equal(err.problem.kind, "foreign-write");
        return true;
      },
    );
    const raw = await readFile(s.eventsPath, "utf8");
    assert.ok(!raw.includes('"next"'), "nothing was appended, so no record has been lost");
  });

  it("holds identity in a header that a second create cannot rewrite", async () => {
    const dir = await tempDir("arke-world-chat-");
    const id = newId("cv");
    const s = new WorldChatStore(join(dir, id));
    await s.create(id, AT);
    await s.create(id, "2099-01-01T00:00:00Z");

    const meta = await s.readMeta();
    assert.equal(meta?.id, id);
    assert.equal(meta?.createdAt, AT, "the original creation time stands");
  });

  it("serialises concurrent appends into one ordered log", async () => {
    const s = await store();
    await Promise.all([
      s.append(message("a"), { at: AT }),
      s.append(message("b"), { at: AT }),
      s.append(message("c"), { at: AT }),
    ]);

    const { events, problems } = await s.read();
    assert.deepEqual(
      events.map((e) => e.seq),
      [1, 2, 3],
      "no two events share a sequence, and none is skipped",
    );
    assert.equal(problems.length, 0);
  });
});
