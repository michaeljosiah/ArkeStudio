import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { DomainEventSchema, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until } from "../wait.js";

const book = "the-ledger-of-nights", requestId = "01J8F3K2QW9VZX4N7M0RTYB6HD";
const words = (action: "check" | "stop"): ClientMessage => ({ kind: "audiobook-words", worldId: WORLD_ID, productionId: book, requestId, action, chapters: ["neap"] });
const timing = (action: "prepare" | "read" | "status" | "stop", productionId = book, chapters: string[] = []): ClientMessage => ({ kind: "audiobook-word-timing", worldId: WORLD_ID, productionId, requestId, action, chapters });
type Harness = { send(message: ClientMessage): Promise<void>; events: DomainEvent[]; calls: () => number };
async function withHarness(run: (h: Harness) => Promise<void>, options: { identity?: (signal: AbortSignal) => Promise<null>; health?: () => Promise<void> } = {}) {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = []; let calls = 0;
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "changes.jsonl"), appRoot: root, appVersion: "test", cipher: devCipher(), credentialsFileName: "credentials.dev.dat",
    observeEvent: event => { DomainEventSchema.parse(event); events.push(event); },
    voice: { sidecar: { health: async () => { await options.health?.(); return { wordTiming: { ready: true } }; },
      transcriptionIdentity: options.identity ?? (async () => null),
      transcribeWords: async () => { calls++; throw Error("No audio work expected"); },
    } as never, localPresets: [], cloudSources: [], hostedReaders: [] },
  });
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  try { await run({ send, events, calls: () => calls }); } finally { await provider.close(); }
}
const timingState = (events: DomainEvent[]) => {
  const answer = events.filter(event => event.type === "audiobook.word-timing").at(-1);
  assert(answer?.type === "audiobook.word-timing"); return answer.state;
};

it("refuses timing explicitly during Words, including reconnect and other chapters, without cancelling that check", async () => {
  let entered = false, stopped = false;
  await withHarness(async h => {
    const checking = h.send(words("check"));
    try {
      await until(() => entered, "Words owns the local check");
      for (const action of ["prepare", "read", "status"] as const) {
        await h.send(timing(action, book, ["the-same-ink"]));
        const state = timingState(h.events);
        assert.equal(state.available, true); assert.equal(state.running, false);
        assert.match(state.reason!, /Not started: a Words check is running/);
      }
      await h.send(timing("status", "another-production"));
      assert.equal(timingState(h.events).reason, undefined, "the exclusion is production-scoped");
      await h.send(timing("stop")); assert.equal(stopped, false, "timing Stop cannot stop Words");
      assert.equal(h.calls(), 0);
    } finally { await h.send(words("stop")); await checking; }
    assert(stopped);
    await h.send(timing("status")); assert.equal(timingState(h.events).reason, undefined);
  }, { identity: signal => new Promise((_, reject) => { entered = true; signal.addEventListener("abort", () => { stopped = true; reject(signal.reason); }, { once: true }); }) });
});

it("refuses Words while timing owns preparation and keeps cancellation with its owner", async () => {
  let checks = 0, entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await withHarness(async h => {
    const preparing = h.send(timing("prepare"));
    try {
      await until(() => entered, "timing owns preparation before its progress report");
      await h.send(words("check"));
      const answer = h.events.filter(event => event.type === "audiobook.words").at(-1);
      assert(answer?.type === "audiobook.words"); assert.equal(answer.state.running, false);
      assert.match(answer.state.reason!, /word timing is running/);
      await h.send(words("stop")); await h.send(timing("status"));
      assert.equal(timingState(h.events).running, true);
      assert.equal(h.calls(), 0);
    } finally { await h.send(timing("stop")); release(); await preparing; }
    await h.send(timing("status")); assert.equal(timingState(h.events).running, false);
  }, { health: async () => { if (++checks === 2) { entered = true; await held; } } });
});
