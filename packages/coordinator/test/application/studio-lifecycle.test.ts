import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import type { ClientMessage, DomainEvent, WorldBundle } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { createEngine } from "../../src/application/engine.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

it("concurrent Studio opens pair every recovery with the owning world", async t => {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  const other = await provider.createWorld({ name: "Second world" });
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root,
    changeLogPath: join(root, "changes.jsonl"), appVersion: "test", observeEvent: event => events.push(event) });
  t.after(() => coordinator.stop());
  const internal = coordinator as unknown as { engine: ReturnType<typeof createEngine>;
    recoverFrameRuns(store: WorldStore, bundle: WorldBundle): Promise<void> };
  const read = internal.engine.worlds.read;
  let entered!: () => void; let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  internal.engine.worlds.read = async (context, worldId) => {
    const result = await read(context, worldId);
    if (worldId === WORLD_ID) { entered(); await held; }
    return result;
  };
  const recovered: string[] = [];
  internal.recoverFrameRuns = async (store, bundle) => {
    assert.equal(store.worldId, bundle.meta.worldId);
    assert.equal(provider.openStore(), store);
    recovered.push(store.worldId);
  };
  const first = coordinator.openWorld(WORLD_ID);
  await reading;
  const second = coordinator.openWorld(other.worldId);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(provider.openStore()!.worldId, WORLD_ID, "second open waits for the first read and recovery");
  } finally { release(); }
  await Promise.all([first, second]);
  assert.deepEqual(recovered, [WORLD_ID, other.worldId]);
  assert.equal(provider.openStore()!.worldId, other.worldId);
  assert.deepEqual(events.filter(e => e.type === "world.opened").map(e => e.worldId), [WORLD_ID, other.worldId]);
});

it("a provider close failure keeps a closed engine out of service while cleanup can retry", async t => {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root,
    changeLogPath: join(root, "changes.jsonl"), appVersion: "test" });
  const close = provider.close.bind(provider);
  t.after(async () => { provider.close = close; await coordinator.stop(); });
  await coordinator.openWorld(WORLD_ID);
  provider.close = async () => { throw new Error("Save unavailable"); };
  await assert.rejects(coordinator.stop(), /Save unavailable/);
  await assert.rejects(coordinator.start(), /coordinator is closed/);
  await assert.rejects(coordinator.openWorld(WORLD_ID), /stopping/);
  const internal = coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> };
  provider.loadWorld = async () => { throw new Error("Must not admit work after shutdown"); };
  await internal.handleClientMessage({ kind: "open-world", worldId: WORLD_ID });
  provider.close = close;
  await coordinator.stop();
});


it("a read-only provider opens once and keeps the first successful bundle", async t => {
  const { root } = await makeTempRoot();
  const source = new FsWorldProvider(root);
  const bundle = await source.loadWorld(WORLD_ID);
  await source.close();
  let loads = 0;
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ appRoot: root, adapter: null, appVersion: "test",
    changeLogPath: join(root, "changes.jsonl"), observeEvent: event => events.push(event),
    provider: { async listWorlds() { return []; }, async loadWorld() {
      if (++loads > 1) throw new Error("World loaded twice");
      return bundle;
    } },
  });
  t.after(() => coordinator.stop());
  await coordinator.openWorld(WORLD_ID);
  assert.equal(loads, 1);
  assert.equal(events.filter(event => event.type === "world.opened").length, 1);
});


it("shutdown refuses a queued world switch before loading or resuming it", async t => {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  const other = await provider.createWorld({ name: "Second world" });
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root,
    changeLogPath: join(root, "changes.jsonl"), appVersion: "test", observeEvent: event => events.push(event) });
  t.after(() => coordinator.stop());
  const internal = coordinator as unknown as { engine: ReturnType<typeof createEngine> };
  const read = internal.engine.worlds.read;
  let entered!: () => void; let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  internal.engine.worlds.read = async (context, worldId) => {
    const result = await read(context, worldId); entered(); await held; return result;
  };
  const loads: string[] = []; const load = provider.loadWorld.bind(provider);
  provider.loadWorld = async id => { loads.push(id); return load(id); };
  const first = coordinator.openWorld(WORLD_ID);
  await reading;
  const second = assert.rejects(coordinator.openWorld(other.worldId), /stopping/);
  const stopping = coordinator.stop();
  release();
  await Promise.all([first, second, stopping]);
  assert.deepEqual(loads, [WORLD_ID]);
  assert.equal(events.some(event => event.type === "world.opened"), false);
});


it("overlapping provider closes keep admission shut until the detached store finishes draining", async t => {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  t.after(() => provider.close());
  const other = await provider.createWorld({ name: "Second world" });
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!;
  const close = store.close.bind(store);
  let entered!: () => void; let release!: () => void;
  const draining = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  store.close = async () => { entered(); await held; return close(); };
  const first = provider.close();
  await draining;
  const second = provider.close();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(provider.loadWorld(other.worldId), /closing/);
  } finally { release(); }
  await Promise.all([first, second]);
  assert.equal(provider.openStore(), null);
  assert.equal(store.isClosed(), true);
  await provider.loadWorld(other.worldId);
  assert.equal(provider.openStore()!.worldId, other.worldId);
});
