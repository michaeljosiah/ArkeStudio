import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationId } from "@arke-studio/contracts";
import { WorldChatRunnerCache } from "../../src/world-chat/runner-cache.js";

/**
 * Which runner serves a conversation after the world has been closed and opened again (#70 §8).
 *
 * A runner closes over the WorldStore it was built from. Keep it too long and every later turn
 * reads a world nobody has open; drop it too soon and a turn in flight loses the only handle that
 * can stop it. The rule is per conversation, and the version that was per world looked right in
 * every test that only ever had one.
 */

class FakeRunner {
  private readonly running = new Set<string>();

  constructor(readonly label: string) {}

  begin(conversationId: ConversationId): void {
    this.running.add(conversationId);
  }

  end(conversationId: ConversationId): void {
    this.running.delete(conversationId);
  }

  isRunning(conversationId: ConversationId): boolean {
    return this.running.has(conversationId);
  }

  hasRunning(): boolean {
    return this.running.size > 0;
  }
}

const WORLD = "wld_one";
const TALKING = "cv_talking" as ConversationId;
const OTHER = "cv_other" as ConversationId;

/** Stores are compared by identity, so anything distinct will do. */
const open = () => ({});

describe("the runner a conversation is served by", () => {
  it("hands back the same one while the store it was built from is still open", () => {
    const cache = new WorldChatRunnerCache<FakeRunner>();
    const store = open();
    const runner = new FakeRunner("first");
    cache.remember(WORLD, store, runner);

    assert.equal(cache.runnerFor(WORLD, store, TALKING), runner);
    assert.equal(cache.runnerFor(WORLD, store, OTHER), runner, "one world, one runner");
  });

  it("asks for a new one once the world has been closed and opened again", () => {
    const cache = new WorldChatRunnerCache<FakeRunner>();
    const closed = open();
    cache.remember(WORLD, closed, new FakeRunner("first"));

    assert.equal(
      cache.runnerFor(WORLD, open(), TALKING),
      undefined,
      "the callbacks of the old one read a store nobody has open",
    );
  });

  /*
   * The failure this is really about. A runner mid-turn is worth keeping — it holds the abort
   * controller, and nothing else can stop that turn — but keeping it for the whole world meant a
   * new turn in a *different* conversation was served by it too, and answered out of the closed
   * store. The turn that was already running was the reason given for a decision that had nothing
   * to do with it.
   */
  it("keeps the old runner for the turn in flight and nobody else", () => {
    const cache = new WorldChatRunnerCache<FakeRunner>();
    const closed = open();
    const midTurn = new FakeRunner("first");
    midTurn.begin(TALKING);
    cache.remember(WORLD, closed, midTurn);

    const reopened = open();
    assert.equal(
      cache.runnerFor(WORLD, reopened, TALKING),
      midTurn,
      "the conversation being answered keeps the runner that can stop it",
    );
    assert.equal(
      cache.runnerFor(WORLD, reopened, OTHER),
      undefined,
      "and every other conversation gets one built against the store that is open",
    );

    const fresh = new FakeRunner("second");
    cache.remember(WORLD, reopened, fresh);
    assert.equal(cache.runnerFor(WORLD, reopened, OTHER), fresh);
    assert.equal(
      cache.runnerFor(WORLD, reopened, TALKING),
      midTurn,
      "the turn in flight is still reachable — a cancel has to land on the run, not on its replacement",
    );
  });

  it("lets go of the old runner once its last turn has ended", () => {
    const cache = new WorldChatRunnerCache<FakeRunner>();
    const closed = open();
    const midTurn = new FakeRunner("first");
    midTurn.begin(TALKING);
    cache.remember(WORLD, closed, midTurn);

    const reopened = open();
    const fresh = new FakeRunner("second");
    cache.runnerFor(WORLD, reopened, OTHER);
    cache.remember(WORLD, reopened, fresh);

    midTurn.end(TALKING);
    assert.equal(
      cache.runnerFor(WORLD, reopened, TALKING),
      fresh,
      "the conversation comes back to the open world rather than staying on a runner that is done",
    );
  });

  it("keeps worlds apart", () => {
    const cache = new WorldChatRunnerCache<FakeRunner>();
    const here = open();
    const there = open();
    const mine = new FakeRunner("here");
    const theirs = new FakeRunner("there");
    cache.remember("wld_here", here, mine);
    cache.remember("wld_there", there, theirs);

    assert.equal(cache.runnerFor("wld_here", here, TALKING), mine);
    assert.equal(cache.runnerFor("wld_there", there, TALKING), theirs);
  });
});
