import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { newId, ulid, type ClientMessage, type SessionId } from "@arke-studio/contracts";
import { openBenchSession, type OpenedBench } from "../../src/bench/service.js";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const CLOCK = () => "2026-10-10T12:00:00.000Z";

async function setup() {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: CLOCK });
  closeOnCleanup(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test" });
  const internals = coordinator as unknown as {
    handleClientMessage(message: ClientMessage): Promise<void>;
    refreshBench(worldId: string, sessionId: SessionId): Promise<void>;
    refreshWorldSnapshot(worldId: string): Promise<void>;
    benchFor(worldId: string, sessionId: SessionId): Promise<OpenedBench | null>;
  };
  const create = async () => {
    const opened = await openBenchSession(worldDir, CLOCK, { fresh: true });
    assert.ok(opened);
    const ids = [newId("tk"), newId("tk")];
    await opened.store.append({ type: "takes-reserved", takes: ids.map((id, index) => ({
      id, n: index + 1, requestId: ulid(), createdAt: CLOCK(), request: {
        mode: "image", brief: "A quiet harbour.", references: [], keyframes: [], provider: "fal",
        model: "test-image", params: { kind: "image", count: 1 },
      },
    })) });
    await opened.store.append({ type: "take-selected", takeId: ids[0]! });
    return { ...opened, ids };
  };
  const open = async (sessionId: SessionId) => internals.handleClientMessage({ kind: "bench-open", worldId: WORLD_ID, sessionId, requestId: ulid() });
  await internals.refreshWorldSnapshot(WORLD_ID);
  return { coordinator, internals, create, open };
}

it("background completion refreshes the session list without displacing the open workspace", async () => {
  const { coordinator, internals, create, open } = await setup();
  const reviewing = await create();
  const background = await create();
  await open(reviewing.session.id);
  const active = coordinator.getState().bench;
  assert.equal(active?.session.id, reviewing.session.id);
  await background.store.append({ type: "take-completed", takeId: background.ids[1]!,
    media: { file: "take.png", hash: "sha256:beefbeef" }, completedAt: CLOCK() });
  await internals.refreshBench(WORLD_ID, background.session.id);
  assert.equal(coordinator.getState().bench, active, "the workspace and its local panels remain mounted");
  assert.equal(coordinator.getState().world?.benchSessions.find(row => row.id === background.session.id)?.waitingCount, 1);
  await internals.handleClientMessage({ kind: "bench-close", worldId: WORLD_ID, requestId: ulid() });
  await internals.refreshBench(WORLD_ID, background.session.id);
  assert.equal(coordinator.getState().bench, null, "completion does not reopen a closed workspace");
  await open(background.session.id);
  assert.equal(coordinator.getState().bench?.session.id, background.session.id, "explicit Open still switches sessions");
});

it("an older filing refresh cannot replace a newer explicit take selection", async () => {
  const { coordinator, internals, create, open } = await setup();
  const reviewing = await create();
  await open(reviewing.session.id);
  const original = internals.benchFor.bind(internals);
  let release!: () => void;
  let captured!: () => void;
  const capturedRead = new Promise<void>(resolve => { captured = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let delay = true;
  internals.benchFor = async (worldId, sessionId) => {
    const answer = await original(worldId, sessionId);
    if (delay) { delay = false; captured(); await held; }
    return answer;
  };
  const oldRefresh = internals.refreshBench(WORLD_ID, reviewing.session.id);
  await capturedRead;
  try {
    await internals.handleClientMessage({ kind: "bench-select-take", worldId: WORLD_ID,
      sessionId: reviewing.session.id, takeId: reviewing.ids[1]!, requestId: ulid() });
    assert.equal(coordinator.getState().bench?.session.selectedTakeId, reviewing.ids[1]);
  } finally { release(); }
  await oldRefresh;
  assert.equal(coordinator.getState().bench?.session.selectedTakeId, reviewing.ids[1]);
});
