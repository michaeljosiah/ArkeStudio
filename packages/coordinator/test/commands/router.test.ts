import assert from "node:assert/strict";
import { it } from "node:test";
import { ulid, type ClientMessage } from "@arke-studio/contracts";
import { CommandRouter, WORLD_NOT_OPEN, type CommandModule } from "../../src/commands/router.js";
import type { WorldStore } from "../../src/world/store.js";

/** The router alone, with a fake open world (issue 2796). */
function harness(openWorldId: string | null) {
  const failures: Array<{ command: string; requestId: string | null; error: unknown }> = [];
  const store = openWorldId === null ? undefined : ({ worldId: openWorldId } as WorldStore);
  return { failures, store, ctx: { openStore: () => store, fail: (command: string, requestId: string | null, error: unknown) => { failures.push({ command, requestId, error }); } } };
}

const OPEN = ulid(), OTHER = ulid();
const voiceLines = (worldId: string): ClientMessage => ({ kind: "list-guide-voice-lines", worldId, requestId: ulid(), character: "maren-kest" });

it("hands an open-world command the open world's store, and refuses one naming another world without running it", async () => {
  const h = harness(OPEN), seen: Array<WorldStore> = [];
  const router = new CommandRouter(h.ctx, [{ "list-guide-voice-lines": { scope: "open-world", handle(_msg, store) { seen.push(store); } } }]);
  assert.equal(await router.dispatch(voiceLines(OPEN)), true);
  assert.deepEqual(seen, [h.store]);
  const stale = voiceLines(OTHER);
  assert.equal(await router.dispatch(stale), true, "answered, not left to the switch");
  assert.equal(seen.length, 1, "the handler never ran");
  assert.deepEqual(h.failures, [{ command: "list-guide-voice-lines", requestId: (stale as { requestId: string }).requestId, error: WORLD_NOT_OPEN }]);
});

it("refuses an open-world command when no world is open", async () => {
  const h = harness(null);
  const router = new CommandRouter(h.ctx, [{ "list-guide-voice-lines": { scope: "open-world", handle() { throw new Error("must not run"); } } }]);
  await router.dispatch(voiceLines(OPEN));
  assert.equal(h.failures[0]?.error, WORLD_NOT_OPEN);
});

it("runs an any-world command whatever is open, and answers a thrown error on the toaster", async () => {
  const h = harness(OPEN), boom = new Error("the reviewer is unavailable");
  const router = new CommandRouter(h.ctx, [{ "chapter-review-read": { scope: "any-world", handle() { throw boom; } } }]);
  await router.dispatch({ kind: "chapter-review-read", worldId: OTHER, productionId: "saltlight", chapterId: "neap" } as ClientMessage);
  assert.deepEqual(h.failures, [{ command: "chapter-review-read", requestId: null, error: boom }]);
});

it("leaves a kind no module owns to the coordinator's switch, and refuses a kind routed twice", async () => {
  const h = harness(OPEN), account: CommandModule = { "account-sign-in": { scope: "none", handle() {} } };
  const router = new CommandRouter(h.ctx, [account]);
  assert.equal(await router.dispatch({ kind: "account-sign-out" }), false);
  assert.equal(await router.dispatch({ kind: "account-sign-in" }), true);
  assert.throws(() => new CommandRouter(h.ctx, [account, account]), /account-sign-in is routed twice/);
});
