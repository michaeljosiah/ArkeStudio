import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { newId, type ModelWorldChatAction, type SessionId } from "@arke-studio/contracts";
import { openBenchSession } from "../../src/bench/service.js";
import { Coordinator } from "../../src/coordinator.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import type { WorldChatActionAdapterDeps } from "../../src/world-chat/actions.js";
import type { WorldStore } from "../../src/world/store.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

it("persists Bench take identities and exact inputs before approval without reserving or enqueuing", async t => {
  const at = "2026-10-03T12:00:00.000Z";
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => at });
  t.after(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!;
  const sessionId = newId("sess") as SessionId;
  const opened = await openBenchSession(worldDir, () => at, { sessionId,
    defaultModel: { provider: "fal", model: "test-image" }, initial: { mode: "image", brief: "A tide clock" } });
  assert.ok(opened);
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "changes.jsonl"), appVersion: "test",
    manifest: { manifestVersion: 1, generated: "2026-10-03", models: [{ id: "test-image", provider: "fal", capability: "image", displayName: "Test image",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perImage", microUsdPerImage: 10_000 } }] } });
  const internals = coordinator as unknown as {
    conversationActionDependencies(store: WorldStore): WorldChatActionAdapterDeps;
    enqueueWithSpeechChecks(input: EnqueueInput): Promise<{ id: string }>;
  };
  const admitted: EnqueueInput[] = [];
  internals.enqueueWithSpeechChecks = async input => { admitted.push(input); return { id: newId("jb") }; };
  const quotes = () => internals.conversationActionDependencies(store).benchGenerationQuotes!;
  const action: ModelWorldChatAction = { kind: "bench-generation", sessionId, checkReceiptIds: [newId("check")],
    composer: { mode: "image", provider: "fal", model: "test-image", brief: "The approved tide clock", params: { kind: "image", count: 2 } } };
  const id = newId("act");
  const body = await quotes().prepare(action, id, at);
  assert.equal(body.estimatedMicroUsd, 20_000);
  assert.deepEqual(await quotes().prepare(action, id, at), body);
  await quotes().validate(action, id);
  assert.deepEqual((await opened.store.fold())!.takes, []);
  assert.deepEqual(admitted, []);
  const frozen = JSON.parse(await readFile(join(worldDir, ".history/world/prepared", `${id}.generation.json`), "utf8"));
  assert.equal((await quotes().dispatch(action, id)).status, "queued");
  assert.deepEqual(admitted, frozen.inputs);
  assert.deepEqual((await opened.store.fold())!.takes.map(take => take.id), frozen.materialization.map((take: { id: string }) => take.id));
  assert.equal((await quotes().dispatch(action, id)).status, "running");
  assert.equal(admitted.length, 2, "a fresh dependency composition rejoins rather than admitting again");
});
