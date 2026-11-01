import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobSchema, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import type { MediaProbe } from "../../src/media/probe.js";

it("measurement wire updates the current world without enqueuing provider work and drains on shutdown", async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root);
  let hang = false, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const probe: MediaProbe = { durationSec: async () => 12, info: async (_path, options) => {
    if (!hang) return { durationSec: 12, hasAudio: true, hasVideo: true };
    started(); return new Promise(resolve => options!.signal!.addEventListener("abort", () => resolve(null), { once: true }));
  } };
  const coordinator = new Coordinator({ provider, adapter: null, appVersion: "test", appRoot: root, changeLogPath: join(root, "logs/changes.jsonl"), mediaProbe: probe });
  const internal = coordinator as unknown as { emit(event: DomainEvent): void; handleClientMessage(message: ClientMessage): Promise<void> };
  const events: DomainEvent[] = [], original = internal.emit.bind(coordinator);
  internal.emit = event => { events.push(event); original(event); };
  await coordinator.start(0);
  const send = (message: ClientMessage) => internal.handleClientMessage(message);
  try {
    await send({ kind: "open-world", worldId: WORLD_ID });
    const store = provider.openStore()!;
    const landing = "productions/saltlight/incoming/wire/clip.mp4";
    await mkdir(join(store.dir, "productions/saltlight/incoming/wire"), { recursive: true });
    await writeFile(join(store.dir, landing), "wire fixture bytes");
    const job = JobSchema.parse({ id: "jb_01J8E0000000000000000000P1", worldId: WORLD_ID, idempotencyKey: WORLD_ID, productionId: "saltlight", target: { kind: "shot", id: "sh_12" },
      provider: "fal", model: "video", capability: "video", params: {}, status: "succeeded", estimatedMicroUsd: 1, landedFiles: [landing], createdAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z" });
    const [take] = await recordTakesFromJob(store, job, null); assert.ok(take);
    const request = { kind: "measure-production-media" as const, worldId: WORLD_ID, productionId: "saltlight", requestId: WORLD_ID, source: { kind: "take" as const, takeId: take.id }, expectedHash: take.mediaHash };
    const jobs = coordinator.getState().app.jobs.length;
    await send(request);
    const result = events.filter(e => e.type === "media.measured").at(-1)!;
    assert.equal(result.result.status, "measured");
    assert.equal(coordinator.getState().world!.productions.find(p => p.meta.id === "saltlight")!.takeMediaInfo[take.id]!.mediaInfo.durationSec, 12);
    assert.equal(coordinator.getState().app.jobs.length, jobs);
    const wrong = "01J8F3K2QW9VZX4N7M0RTYB6HD";
    await send({ ...request, worldId: wrong });
    assert.deepEqual(events.filter(e => e.type === "media.measured").at(-1)!.result, { status: "failed", reason: "unavailable" });

    // A separate unmeasured source reaches the native probe before stop closes admission.
    const landing2 = "productions/saltlight/incoming/wire-2/clip.mp4";
    await mkdir(join(store.dir, "productions/saltlight/incoming/wire-2"), { recursive: true });
    await writeFile(join(store.dir, landing2), "second wire fixture bytes");
    const [second] = await recordTakesFromJob(store, { ...job, id: "jb_01J8E0000000000000000000P2", landedFiles: [landing2] }, null); assert.ok(second);
    hang = true;
    const pending = send({ ...request, source: { kind: "take", takeId: second.id }, expectedHash: second.mediaHash });
    await ready; await coordinator.stop(); await pending;
    assert.equal(store.getBundle().productions.find(p => p.meta.id === "saltlight")!.takeMediaInfo[second.id], undefined);
  } finally { await coordinator.stop(); await provider.close(); }
});
