import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import WebSocket from "ws";
import { ClientMessageSchema, FrameSchema, ulid, type ClientMessage, type DomainEvent, type Frame } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "./helpers.js";
import { until } from "../wait.js";

async function setup(t: TestContext) {
  const { root, worldDir } = await makeTempRoot(), otherDir = join(root, "worlds", "other-world"), otherId = ulid();
  await cp(worldDir, otherDir, { recursive: true });
  const meta = JSON.parse(await readFile(join(otherDir, "world.json"), "utf8"));
  await writeFile(join(otherDir, "world.json"), JSON.stringify({ ...meta, worldId: otherId, slug: "other-world", name: "Other world" }));
  for (const dir of [worldDir, otherDir]) {
    const episodes = join(dir, "productions", "saltlight", "episodes");
    await mkdir(episodes, { recursive: true });
    for (const order of [1, 2]) await writeFile(join(episodes, `${order}.json`), JSON.stringify({ id: `ep_${order}`, version: 1, order, title: `Episode ${order}`, scenes: [] }));
  }
  const provider = new FsWorldProvider(root), events: DomainEvent[] = [];
  const coordinator = new Coordinator({ provider, adapter: null, appVersion: "test",
    changeLogPath: join(root, "logs", "coordinator.jsonl"), observeEvent: event => events.push(event) });
  let socket: WebSocket | undefined;
  t.after(async () => { socket?.terminate(); await coordinator.stop(); });
  const { port, token } = await coordinator.start();
  await coordinator.openWorld(otherId);
  const frames: Frame[] = [];
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.on("message", data => { frames.push(FrameSchema.parse(JSON.parse(String(data)))); });
  await once(socket, "open");
  const send = (message: ClientMessage) => socket!.send(JSON.stringify(ClientMessageSchema.parse(message)));
  send({ kind: "hello", token });
  await until(() => frames.some(frame => frame.kind === "snapshot"), "authenticated initial snapshot", 30_000);
  return { provider, coordinator, frames, events, send, worldDir, otherDir, otherId, store: provider.openStore()! };
}

const staleCommands: ClientMessage[] = [
  { kind: "rename-world", worldId: WORLD_ID, name: "Wrong world" },
  { kind: "reorder-episodes", worldId: WORLD_ID, productionId: "saltlight", orderedIds: ["ep_2", "ep_1"] },
  { kind: "restore-bible", worldId: WORLD_ID, version: 0 },
  { kind: "delete-scene", worldId: WORLD_ID, productionId: "saltlight", sceneFile: "opening" },
  { kind: "set-trim", worldId: WORLD_ID, productionId: "saltlight", shotId: "sh_01", trimInSec: 1 },
  // Routed commands (issue 2796): the router checks the world once; these returned in silence before.
  { kind: "set-guide-entry", worldId: WORLD_ID, change: { entryKind: "characters", id: "maren-kest", entry: { public: true } } },
  { kind: "set-guide-teasers", worldId: WORLD_ID, change: { teasers: [] } },
  { kind: "list-guide-voice-lines", worldId: WORLD_ID, requestId: ulid(), character: "maren-kest" },
  { kind: "set-guide-story", worldId: WORLD_ID, change: { story: "saltlight" } },
  { kind: "draft-guide-description", worldId: WORLD_ID, requestId: ulid() },
  { kind: "bench-open", worldId: WORLD_ID },
  { kind: "bench-set-title", worldId: WORLD_ID, sessionId: `sess_${ulid()}`, requestId: ulid(), title: "Wrong world" },
];
for (const message of staleCommands) it(`refuses ${message.kind} for another world before mutation or selection`, async t => {
  const h = await setup(t), opened = h.events.filter(event => event.type === "world.opened").length;
  const files = [h.worldDir, h.otherDir].flatMap(dir => [join(dir, "world.json"), join(dir, "productions", "saltlight", "episodes", "1.json")]);
  const before = await Promise.all(files.map(file => readFile(file)));
  const commits = t.mock.method(h.store, "commit", h.store.commit.bind(h.store));
  const loads = t.mock.method(h.provider, "loadWorld", h.provider.loadWorld.bind(h.provider));
  h.send(message);
  await until(() => h.frames.some(frame => frame.kind === "event" && frame.event.type === "command.failed" && frame.event.command === message.kind), "wrong-world refusal", 30_000);
  assert.equal(commits.mock.callCount(), 0);
  assert.equal(loads.mock.callCount(), 0);
  assert.equal(h.provider.openStore(), h.store);
  assert.equal(h.coordinator.getState().world?.meta.worldId, h.otherId);
  assert.equal(h.events.filter(event => event.type === "world.opened").length, opened);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
});

it("refreshes valid rename and episode order without loading a world, including the picker row", async t => {
  const h = await setup(t), loads = t.mock.method(h.provider, "loadWorld", h.provider.loadWorld.bind(h.provider));
  h.send({ kind: "rename-world", worldId: h.otherId, name: "Renamed world" });
  await until(() => h.frames.some(frame => frame.kind === "snapshot" && frame.state.world?.meta.name === "Renamed world" &&
    frame.state.worlds.some(world => world.worldId === h.otherId && world.name === "Renamed world")), "renamed snapshot and picker row", 30_000);
  h.send({ kind: "reorder-episodes", worldId: h.otherId, productionId: "saltlight", orderedIds: ["ep_2", "ep_1"] });
  await until(() => h.frames.some(frame => frame.kind === "snapshot" && frame.state.world?.productions.find(p => p.meta.id === "saltlight")?.episodes[0]?.id === "ep_2"), "reordered episodes", 30_000);
  assert.equal(loads.mock.callCount(), 0);
  assert.equal(h.provider.openStore(), h.store);
  assert.equal(JSON.parse(await readFile(join(h.otherDir, "productions", "saltlight", "episodes", "1.json"), "utf8")).order, 2);
  assert.equal(JSON.parse(await readFile(join(h.worldDir, "productions", "saltlight", "episodes", "1.json"), "utf8")).order, 1);
});

it("does not reopen a world when an admitted rename finishes after navigation", async t => {
  const h = await setup(t), rename = h.store.renameWorld.bind(h.store);
  let reached!: () => void, release!: () => void;
  const committed = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(h.store, "renameWorld", async (name: string) => { await rename(name); reached(); await held; });
  h.send({ kind: "rename-world", worldId: h.otherId, name: "Renamed before navigation" });
  try {
    await committed;
    await h.coordinator.openWorld(WORLD_ID);
    const selected = h.provider.openStore();
    const loads = t.mock.method(h.provider, "loadWorld", h.provider.loadWorld.bind(h.provider));
    const lists = t.mock.method(h.provider, "listWorlds", h.provider.listWorlds.bind(h.provider));
    release();
    await until(() => lists.mock.callCount() > 0, "late rename finishing its refresh", 30_000);
    assert.equal(loads.mock.callCount(), 0);
    assert.equal(h.provider.openStore(), selected);
    assert.equal(h.coordinator.getState().world?.meta.worldId, WORLD_ID);
  } finally { release(); }
});
