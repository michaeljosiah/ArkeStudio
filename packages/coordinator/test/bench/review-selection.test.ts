import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { newId, ulid, type ClientMessage, type SessionId, type BenchSession } from "@arke-studio/contracts";
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
    backfillBenchPosters(store: NonNullable<ReturnType<FsWorldProvider["openStore"]>>, session: BenchSession): Promise<void>;
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
  const open = async (sessionId: SessionId) => internals.handleClientMessage({ kind: "bench-open", worldId: WORLD_ID, sessionId });
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
  await internals.handleClientMessage({ kind: "bench-close", worldId: WORLD_ID });
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

it('delayed hydration keeps freshly added references (#1703)', async () => {
  const { coordinator, internals, create, open } = await setup();
  const fresh = await create();
  await open(fresh.session.id);
  const control = internals;
  const backfill = control.backfillBenchPosters.bind(control);
  let release!: () => void, captured!: () => void;
  const entered = new Promise<void>(resolve => { captured = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  control.backfillBenchPosters = async (...args: Parameters<typeof control.backfillBenchPosters>) => { if (first) { first = false; captured(); await held; } return backfill(...args); };
  const hydration = open(fresh.session.id);
  await entered;
  try {
    for (let i = 1; i <= 2; i++) await fresh.store.append({ type: 'reference-added', entry: { token: 'Image ' + i, kind: 'image', source: { source: 'world-file', path: 'references/test-' + i + '.png', hash: 'sha256:' + 'a'.repeat(64) } } }, { at: CLOCK() });
    await internals.refreshBench(WORLD_ID, fresh.session.id);
    assert.equal(coordinator.getState().bench!.session.composer.activeTokens.length, 2);
  } finally { release(); }
  await hydration;
  assert.equal(coordinator.getState().bench!.session.composer.activeTokens.length, 2, 'fresh references remain visible after hydration');
  assert.equal((await fresh.store.fold())!.composer.activeTokens.length, 2, 'durable references remain');
});

it("a subject open cannot cancel a newer workspace open during hydration", { timeout: 20_000 }, async () => {
  const { coordinator, internals, create, open } = await setup();
  const later = await create();
  const backfill = internals.backfillBenchPosters.bind(internals);
  const gates = [0, 1].map(() => {
    let release!: () => void, entered!: () => void;
    return { waiting: new Promise<void>(resolve => { release = resolve; }), ready: new Promise<void>(resolve => { entered = resolve; }), release: () => release(), entered: () => entered() };
  });
  let count = 0;
  internals.backfillBenchPosters = async (...args) => {
    const gate = gates[count++];
    if (gate) { gate.entered(); await gate.waiting; }
    return backfill(...args);
  };
  const subject = internals.handleClientMessage({ kind: "bench-open-subject", worldId: WORLD_ID, requestId: ulid(), productionId: "saltlight", sceneId: "sc_04", subject: { kind: "shot", shotId: "sh_12" } });
  try {
    await gates[0]!.ready;
    const newer = open(later.session.id);
    await gates[1]!.ready;
    gates[0]!.release();
    await subject;
    gates[1]!.release();
    await newer;
    assert.equal(coordinator.getState().bench?.session.id, later.session.id);
  } finally { gates.forEach(gate => gate.release()); }
});

for (const action of ['close', 'open another'] as const) it('delayed hydration cannot undo ' + action, async () => {
  const { coordinator, internals, create, open } = await setup();
  const first = await create(), second = await create();
  await open(first.session.id);
  const backfill = internals.backfillBenchPosters.bind(internals);
  let release!: () => void, entered!: () => void;
  const captured = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let hold = true;
  internals.backfillBenchPosters = async (...args) => { if (hold) { hold = false; entered(); await gate; } return backfill(...args); };
  const hydration = open(first.session.id);
  await captured;
  try {
    if (action === 'close') await internals.handleClientMessage({kind:'bench-close',worldId:WORLD_ID});
    else await open(second.session.id);
  } finally { release(); }
  await hydration;
  assert.equal(coordinator.getState().bench?.session.id ?? null, action === 'close' ? null : second.session.id);
});
