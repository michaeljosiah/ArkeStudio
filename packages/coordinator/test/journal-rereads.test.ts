import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import WebSocket from "ws";
import type { DomainEvent, WorldBundle } from "@arke-studio/contracts";
import { Coordinator } from "../src/coordinator.js";
import type { ChangeLog } from "../src/change-log.js";
import { tracksProductionSpend } from "../src/spend/rollups.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { WorldStore } from "../src/world/store.js";
import { makeTempRoot, makeTempWorld, WORLD_ID } from "./world/helpers.js";
import { closeOnCleanup } from "./tmp.js";

/**
 * The rereads of whole journals on the hot paths (issue 2779): a finished job asked for a
 * production-spend pass over all history, and every hello reparsed the whole change log.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const OTHER_WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HD";
const AT = "2026-11-08T10:00:00.000Z";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

it("asks for one production-spend pass per burst, only for the open world, and none where nothing is tracked", async () => {
  const job = JSON.parse((await readFile(join(FIXTURES, "queue", "jobs.jsonl"), "utf8")).split("\n")[0]!);
  const dir = await makeTempWorld(), store = await WorldStore.open(dir);
  closeOnCleanup(() => store.close());
  const coordinator = new Coordinator({ provider: { listWorlds: async () => [], loadWorld: async () => store.getBundle(), openStore: () => store },
    adapter: null, appVersion: "test", changeLogPath: join(dir, ".cache/test-events.jsonl") });
  const host = coordinator as unknown as { emit(event: DomainEvent): void; setDisplayWorld(world: WorldBundle | null): void;
    scheduleProductionSpend(): Promise<void>; productionSpendWork: Promise<void> | null; changeLog: ChangeLog };
  const finished = (worldId: string, n: number) => ({ at: AT, type: "job.updated",
    job: { ...job, id: `jb_01J8E00000000000000000${String(n).padStart(4, "0")}`, worldId, status: "succeeded" } }) as DomainEvent;
  try {
    host.setDisplayWorld(store.getBundle());
    await host.productionSpendWork;
    let passes = 0;
    const pass = host.scheduleProductionSpend.bind(host);
    host.scheduleProductionSpend = () => { passes++; return pass(); };

    for (let n = 0; n < 20; n++) host.emit(finished(WORLD_ID, n));
    assert.equal(passes, 0, "a burst waits for its window");
    await sleep(1_800);
    assert.equal(passes, 1, "and twenty finished jobs cost one pass");

    host.emit(finished(OTHER_WORLD, 20));
    await sleep(1_800);
    assert.equal(passes, 1, "a job in another world asks for nothing here");

    const untracked = { ...store.getBundle(), productions: store.getBundle().productions.filter((p) => !tracksProductionSpend(p)) };
    host.setDisplayWorld(untracked);
    await host.productionSpendWork;
    assert.deepEqual(coordinator.getState().productionSpend, { worldId: WORLD_ID, productions: {} }, "nothing tracked projects nothing");
    const before = passes;
    host.emit(finished(WORLD_ID, 21));
    await sleep(1_800);
    assert.equal(passes, before, "and its finished jobs ask for no pass at all");
  } finally {
    await coordinator.stop();
    await host.changeLog.drain();
  }
});

it("recovers an interrupted export from the change log once, then answers later hellos from memory", async () => {
  const job = JSON.parse((await readFile(join(FIXTURES, "queue", "jobs.jsonl"), "utf8")).split("\n")[0]!);
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => AT });
  await provider.loadWorld(WORLD_ID);
  const changeLogPath = join(root, "logs", "changes.jsonl");
  await mkdir(dirname(changeLogPath), { recursive: true });
  const exportRow = (worldId: string, exportId: string) =>
    ({ at: AT, type: "export.progress", worldId, productionId: "saltlight", exportId, status: "running", percent: 40, output: null, error: null });
  await writeFile(changeLogPath, [
    { at: 1, seq: 1, event: exportRow(WORLD_ID, "ex_interrupted") },
    { at: 2, seq: 2, event: exportRow(OTHER_WORLD, "ex_elsewhere") },
    { at: 3, seq: 3, event: { at: AT, type: "job.updated", job } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath, appVersion: "test" });
  const host = coordinator as unknown as { changeLog: ChangeLog; exportReads: Map<string, { status: string; error?: string | null }> };
  let reads = 0;
  const readAll = host.changeLog.readAll.bind(host.changeLog);
  host.changeLog.readAll = () => { reads++; return readAll(); };
  const { port, token } = await coordinator.start(0);
  const hello = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((done, fail) => { socket.once("open", () => done()); socket.once("error", fail); });
    const snapshot = new Promise<void>((done) => socket.on("message", (data) => { if (String(data).includes('"kind":"snapshot"')) done(); }));
    socket.send(JSON.stringify({ kind: "hello", token, lastSeq: 0 }));
    await snapshot;
    socket.close();
  };
  try {
    await hello();
    const afterFirst = reads;
    assert.ok(afterFirst >= 1, "the log is read for this world once");
    assert.equal(host.exportReads.get("ex_interrupted")?.status, "failed", "an export the process died during is not still running");
    assert.equal(host.exportReads.get("ex_interrupted")?.error, "export interrupted");
    assert.equal(host.exportReads.has("ex_elsewhere"), false, "another world's row is filtered before it is parsed");
    await hello();
    assert.equal(reads, afterFirst, "a second window is answered from memory");
  } finally {
    await coordinator.stop();
    await provider.close();
  }
});
