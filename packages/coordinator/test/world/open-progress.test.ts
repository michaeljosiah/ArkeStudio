import assert from "node:assert/strict";
import { it } from "node:test";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldStore, type WorldStoreOpenProgress } from "../../src/world/store.js";
import { makeTempRoot, makeTempWorld, WORLD_ID } from "./helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * A large world opened behind one unchanging "opening the world" for up to two minutes, which is
 * also what a hang looks like (issue 1844). The open now says which part of it is under way, and
 * how many files it has read while it reads.
 */

const CLOCK = "2026-10-19T12:00:00.000Z";
type OpenProgress = Extract<DomainEvent, { type: "world.open-progress" }>;

function harness(root: string) {
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  closeOnCleanup(() => provider.close());
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    appRoot: root,
    changeLogPath: join(root, "logs", "coordinator.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  const send = (msg: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  const progress = () => events.filter((event): event is OpenProgress => event.type === "world.open-progress");
  return { coordinator, provider, events, send, progress };
}

it("says each part of a world's open as it starts, before the world arrives", async () => {
  const { root, worldDir } = await makeTempRoot();
  const sidecar = JSON.parse(await readFile(join(worldDir, "artifacts/board-v2.png.json"), "utf8"));
  for (let i = 0; i < 300; i++) {
    await writeFile(join(worldDir, "artifacts", `many-${i}.png.json`), JSON.stringify({ ...sidecar, id: `ar_01J8G${String(i).padStart(21, "0")}`, file: `many-${i}.png` }));
  }
  const h = harness(root);
  const started = Date.now();
  await h.send({ kind: "open-world", worldId: WORLD_ID });
  const elapsed = Date.now() - started;

  const said = h.progress();
  assert.deepEqual([...new Set(said.map((event) => event.phase))], ["reading", "checking", "conversations", "finishing"]);
  assert.ok(said.every((event) => event.worldId === WORLD_ID));
  const reading = said.filter((event) => event.phase === "reading");
  assert.equal(reading[0]!.done, 1, "the first file read is said at once");
  // Four a second at most, not once a file: a phase is said when it starts, a count when 250 ms
  // have passed since the last one.
  assert.ok(reading.length <= 1 + Math.ceil(elapsed / 250), `${reading.length} counts in ${elapsed} ms`);
  assert.equal(reading.some((event) => event.total !== undefined), false, "a first open has no last open to count against");
  const opened = h.events.findIndex((event) => event.type === "world.opened");
  assert.ok(opened > h.events.indexOf(said.at(-1)!), "and all of it before the world is opened");
});

it("counts the reading against how many files the world's last open read", async () => {
  const dir = await makeTempWorld();
  // Measured takes, whose media-info.json the manifest takes beside take.json: a count that left
  // them out ended an unchanged world short of its own total (codex on PR 1887).
  const takes = join(dir, "productions/saltlight/takes");
  for (let i = 0; i < 12; i++) {
    const id = `tk_01J8Z${String(i).padStart(21, "0")}`;
    await cp(join(takes, "tk_01J8A0000000000000000000A1"), join(takes, id), { recursive: true });
    const take = JSON.parse(await readFile(join(takes, id, "take.json"), "utf8"));
    await writeFile(join(takes, id, "take.json"), JSON.stringify({ ...take, id }));
    await writeFile(join(takes, id, "media-info.json"), JSON.stringify({ sourceHash: `sha256:${"0".repeat(64)}`, mediaInfo: { durationSec: 4, hasAudio: false }, probedAt: CLOCK }));
  }
  const first = await WorldStore.open(dir, { clock: () => CLOCK });
  await first.close();
  const heard: WorldStoreOpenProgress[] = [];
  const store = await WorldStore.open(dir, { clock: () => CLOCK, onProgress: (progress) => heard.push(progress) });
  closeOnCleanup(() => store.close());

  const reading = heard.filter((progress) => progress.phase === "reading");
  assert.deepEqual(reading.map((progress) => progress.done), reading.map((_, i) => i + 1), "one more for every file read");
  const total = reading[0]!.total!;
  assert.ok(total > 0, "the last open's count is the total");
  assert.ok(reading.every((progress) => progress.total === total));
  assert.equal(reading.at(-1)!.done, total, "an unchanged world ends on its own total");
  assert.deepEqual(heard.at(-1), { phase: "checking" }, "and the checks after the scan are said after it");
  // Said as the last record is read (issue 1888), not after the history and media that follow it.
  assert.deepEqual(heard[heard.indexOf(reading.at(-1)!) + 1], { phase: "checking" });
});

it("tells a window that connects mid-open where it has got, and says nothing once it is over", async () => {
  const { root } = await makeTempRoot();
  const h = harness(root);
  const loadWorld = h.provider.loadWorld.bind(h.provider);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let loaded!: () => void;
  const reached = new Promise<void>((resolve) => { loaded = resolve; });
  h.provider.loadWorld = async (worldId, opts) => {
    const bundle = await loadWorld(worldId, opts);
    loaded();
    await held;
    return bundle;
  };
  const replayed = () => h.coordinator.serverApplication.getInitialEvents!().filter((event) => event.type === "world.open-progress");

  const opening = h.send({ kind: "open-world", worldId: WORLD_ID });
  await reached;
  assert.deepEqual(replayed().map((event) => (event as OpenProgress).phase), ["checking"]);
  release();
  await opening;
  assert.deepEqual(replayed(), [], "an open that is over has nothing to say");
});

it("says nothing more about an open once it has said the world is open", async () => {
  // Every broadcast snapshot is followed by the hello replay, and the snapshot that ends an open
  // came before its progress was forgotten: the last phase arrived after `world.opened` and stayed
  // on the client (codex on PR 1887).
  const { root } = await makeTempRoot();
  let atOpened: DomainEvent[] | null = null;
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  closeOnCleanup(() => provider.close());
  const coordinator: Coordinator = new Coordinator({
    provider,
    adapter: null,
    appRoot: root,
    changeLogPath: join(root, "logs", "coordinator.jsonl"),
    appVersion: "test",
    observeEvent: (event) => {
      if (event.type === "world.opened") atOpened = coordinator.serverApplication.getInitialEvents!();
    },
  });
  await (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage({ kind: "open-world", worldId: WORLD_ID });
  assert.ok(atOpened !== null, "the world opened");
  assert.deepEqual((atOpened as DomainEvent[]).filter((event) => event.type === "world.open-progress"), []);
});

it("keeps the open's progress out of coordinator.jsonl", async () => {
  const { root } = await makeTempRoot();
  const h = harness(root);
  await h.send({ kind: "open-world", worldId: WORLD_ID });
  const log = join(root, "logs", "coordinator.jsonl");
  // The journal is written behind the event; `world.opened` is in it once it has caught up.
  for (let i = 0; i < 100 && !(await readFile(log, "utf8").catch(() => "")).includes("world.opened"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const text = await readFile(log, "utf8");
  assert.ok(text.includes("world.opened"));
  assert.equal(text.includes("world.open-progress"), false);
});
