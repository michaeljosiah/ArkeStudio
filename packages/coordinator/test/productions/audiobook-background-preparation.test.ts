import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { readAudiobook } from "../../src/productions/audiobook.js";
import { readVoices } from "../../src/productions/voices.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const productionId = "the-ledger-of-nights";
const command = (kind: "cast-voices" | "group-chapter-beats", chapterFile = "01-neap"): ClientMessage => ({ kind, worldId: WORLD_ID, productionId, chapterFile });
const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

async function harness(wait: (signal?: AbortSignal) => Promise<void> = async () => {}) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  const selected = await provider.createWorld({ name: "Selected world" });
  await provider.loadWorld(selected.worldId);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider, adapter: null, appVersion: "test", appRoot: root,
    changeLogPath: join(root, "logs", "changes.jsonl"), cipher: devCipher(), credentialsFileName: "credentials.dev.dat",
    observeEvent: event => { events.push(event); },
    voicesDeriver: async (_input, signal) => { await wait(signal); return { lines: [] }; },
    beatsDeriver: async (input, signal) => { await wait(signal); return { beats: [{ start: input.blocks[0]!.key }] }; },
  });
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  const send = (msg: ClientMessage) => (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  return { coordinator, provider, selected, worldDir, events, send };
}

for (const kind of ["cast-voices", "group-chapter-beats"] as const) {
  it(`${kind} retains an unselected world through navigation and persists its result`, { timeout: 20_000 }, async () => {
    const started = latch(), release = latch();
    let signal: AbortSignal | undefined;
    const h = await harness(async value => { signal = value; started.resolve(); await release.promise; });
    const work = h.send(command(kind));
    try {
      await started.promise;
      assert.equal(h.provider.openStore()?.worldId, h.selected.worldId);
      assert.ok(h.events.some(e => "worldId" in e && e.worldId === WORLD_ID &&
        (e.type === "voices.started" || (e.type === "audiobook.beats" && e.outcome === "grouping"))));
      const third = await h.provider.createWorld({ name: "Another selected world" });
      await h.provider.loadWorld(third.worldId);
      assert.equal(signal?.aborted, false);
      release.resolve(); await work;
      assert.equal(h.provider.openStore()?.worldId, third.worldId);
      assert.ok(h.events.some(e => "worldId" in e && e.worldId === WORLD_ID &&
        ((e.type === "voices.finished" && e.outcome === "cast") || (e.type === "audiobook.beats" && e.outcome === "grouped"))));
      await h.provider.withWorldStore(WORLD_ID, async store => {
        const record = kind === "cast-voices" ? await readVoices(store, productionId, "01-neap") : await readAudiobook(store, productionId, "01-neap");
        assert.ok(record && record !== "unreadable", "the result survives release and reopening");
      });
    } finally { release.resolve(); await work; await h.provider.close(); }
  });

  it(`${kind} refuses an owned world and missing targets without changing selection`, { timeout: 20_000 }, async () => {
    const h = await harness();
    const owner = await WorldStore.open(h.worldDir);
    try {
      await h.send(command(kind));
      assert.ok(h.events.some(e => e.type === "command.failed" && e.command === kind && e.reason.length > 0));
      await owner.assertOwnership();
      assert.equal(h.provider.openStore()?.worldId, h.selected.worldId);
    } finally { await owner.close(); }
    try {
      h.events.length = 0;
      await h.send(command(kind, "missing-chapter"));
      assert.ok(h.events.some(e => e.type === "command.failed" && /chapter.*no longer available/.test(e.reason)));
      h.events.length = 0;
      await h.send({ ...command(kind), worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD" } as ClientMessage);
      assert.ok(h.events.some(e => e.type === "command.failed" && e.command === kind));
      assert.equal(h.provider.openStore()?.worldId, h.selected.worldId);
    } finally { await h.provider.close(); }
  });
}

for (const chapterFile of ["neap", "01-neap"]) {
  it(`stops a background cast by ${chapterFile} and answers a duplicate request`, { timeout: 20_000 }, async () => {
    const started = latch();
    const h = await harness(async signal => {
      started.resolve();
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
      signal!.throwIfAborted();
    });
    const work = h.send(command("cast-voices"));
    try {
      await started.promise;
      await h.send(command("cast-voices"));
      assert.ok(h.events.some(e => e.type === "command.failed" && /casting/.test(e.reason)));
      await h.send({ kind: "stop-voices", worldId: WORLD_ID, productionId, chapterFile });
      await work;
      assert.ok(h.events.some(e => e.type === "voices.finished" && e.outcome === "stopped" && e.worldId === WORLD_ID));
      assert.equal(h.provider.openStore()?.worldId, h.selected.worldId);
    } finally { await h.provider.close(); await work; }
  });
}

it("grouping stays in progress until timing ends and shutdown cancels that follow-up", { timeout: 20_000 }, async () => {
  const h = await harness();
  const timing = latch();
  const internals = h.coordinator as unknown as {
    timeMarkedTakes(store: WorldStore, production: string, chapter: string, signal?: AbortSignal): Promise<void>;
    activeMessages: Set<Promise<void>>;
    groupingChapters: Map<string, unknown>;
  };
  internals.timeMarkedTakes = async (_store, _production, _chapter, signal) => {
    assert.ok(signal);
    timing.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const work = h.send(command("group-chapter-beats"));
  internals.activeMessages.add(work);
  try {
    await timing.promise;
    assert.equal(internals.groupingChapters.size, 1, "reconnecting windows still see the pending operation");
    assert.equal(h.events.some(e => e.type === "audiobook.beats" && e.outcome === "grouped"), false);
    await h.coordinator.stop();
    await work;
    assert.equal(internals.groupingChapters.size, 0);
    assert.ok(h.events.some(e => e.type === "audiobook.beats" && e.outcome === "grouped"), "the terminal event follows all pending work");
  } finally { await h.provider.close(); }
});

it("mark timing inherits its grouping cancellation and releases its controller", { timeout: 20_000 }, async () => {
  const h = await harness();
  const started = latch(), release = latch();
  const parent = new AbortController();
  const internals = h.coordinator as unknown as {
    voiceService: { wordTimingAvailability(): Promise<{ ready: false }> };
    timeMarkedTakes(store: WorldStore, production: string, chapter: string, signal?: AbortSignal): Promise<void>;
    timingMarks: Map<string, AbortController>;
  };
  internals.voiceService = { wordTimingAvailability: async () => { started.resolve(); await release.promise; return { ready: false }; } };
  const work = h.provider.withBackgroundWorldStore(WORLD_ID, store => internals.timeMarkedTakes(store, productionId, "neap", parent.signal));
  try {
    await started.promise;
    const control = [...internals.timingMarks.values()][0]!;
    assert.equal(control.signal.aborted, false);
    parent.abort();
    assert.equal(control.signal.aborted, true, "the transcriber's signal stops before the store closes");
    release.resolve(); await work;
    assert.equal(internals.timingMarks.size, 0);
  } finally { release.resolve(); await work; await h.provider.close(); }
});
