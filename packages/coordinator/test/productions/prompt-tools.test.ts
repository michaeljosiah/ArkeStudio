import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { orderedShots, foldBenchSession, projectSceneRecord, BenchTakeSchema, JobSchema, type DomainEvent, type ManifestModel, type PromptTarget, type SceneRecord } from "@arke-studio/contracts";
import { readShotPromptHistory, restoreShotPrompt, framePromptInspection, compilePromptInspection, frozenPromptInspection, readPromptBench } from "../../src/productions/prompt-tools.js";
import { compileFrameRun } from "../../src/productions/frame-run.js";
import { planBenchDispatch } from "../../src/bench/service.js";
import { WorldStore } from "../../src/world/store.js";
import { AppSettingsFile } from "../../src/app-settings.js";
import { makeTempWorld, makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { sha256 } from "../../src/world/text-files.js";
import { parseSceneRecord } from "../../src/productions/scene-record.js";
import { startLedgerCoordinator } from "../spend/seeded-ledger.js";

const at = "2026-11-01T12:00:00.000Z", clock = () => at;
const path = "productions/saltlight/scenes/04-the-verse-rises.json";
const image: ManifestModel = { id: "test-image", provider: "fal", capability: "image", displayName: "Test image",
  accepts: { referenceImages: 8, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perImage", microUsdPerImage: 1000 } };
async function fixture() {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir, { clock });
  closeOnCleanup(() => store.close());
  const scene = store.getBundle().productions.find(p => p.meta.id === "saltlight")!.scenes.find(s => s.id === "sc_04")!;
  const target: PromptTarget = { productionId: "saltlight", sceneId: scene.id, shotId: orderedShots(scene)[0]!.id, capability: "image" };
  return { dir, store, target };
}
async function live(store: WorldStore): Promise<SceneRecord> { return JSON.parse(await readFile(join(store.dir, path), "utf8")); }
async function change(store: WorldStore, mutate: (scene: SceneRecord) => void) {
  const raw = await readFile(join(store.dir, path), "utf8"), scene: SceneRecord = JSON.parse(raw);
  mutate(scene);
  await store.commit({ kind: "scene-command", source: "test", files: [{ path, action: "replace", content: JSON.stringify(scene), baseHash: sha256(raw) }] });
}
function restoreInput(history: Awaited<ReturnType<typeof readShotPromptHistory>>, version: number) {
  return { baseVersion: history.currentVersion, baseHash: history.currentHash, assembledHash: history.assembledHash,
    sourceVersion: version, sourceHash: history.entries.find(e => e.version === version)!.hash!, requestId: "restore-test" };
}

it("keeps the optional tools off until enabled, persists the choice and preserves unrelated settings", async () => {
  const { dir } = await fixture(), file = join(dir, "settings.json"), settings = new AppSettingsFile(file);
  assert.notEqual((await settings.load()).promptTools, true);
  await settings.setSpend(7_000_000, 3);
  await settings.setPromptTools(true);
  assert.equal((await new AppSettingsFile(file).load()).promptTools, true);
  await settings.setPromptTools(false);
  assert.equal((await new AppSettingsFile(file).load()).promptTools, false);
  const raw = JSON.parse(await readFile(file, "utf8")); raw.promptTools = "true";
  await writeFile(file, JSON.stringify(raw));
  const reloaded = await new AppSettingsFile(file).load();
  assert.equal(reloaded.promptTools, false);
  assert.equal(reloaded.spend.thresholdMicroUsd, 7_000_000);
});

it("projects retained scene changes and restores only the prompt with its original source pins", async () => {
  const { store, target } = await fixture();
  await change(store, scene => { orderedShots(scene)[0]!.promptOverride = { text: "An older image body.", capability: "image", sheetVersions: { maren: 1 } }; });
  const oldVersion = (await live(store)).version;
  await change(store, scene => { orderedShots(scene)[0]!.title = "Keep this newer title"; });
  await change(store, scene => { orderedShots(scene)[0]!.promptOverride = { text: "The current image body.", capability: "image", sheetVersions: { maren: 8 } }; });
  const before = await live(store), history = await readShotPromptHistory(store, target);
  const selected = history.entries.find(e => e.prompt?.text === "An older image body.")!;
  assert.ok(selected.version >= oldVersion);
  assert.equal(history.entries.filter(e => e.prompt?.text === "An older image body.").length, 1, "unrelated scene edits collapse");
  const historicalFile = join(store.dir, `.history/productions/saltlight/scenes/04-the-verse-rises/v${selected.version}.json`);
  const retained = await readFile(historicalFile, "utf8");
  const version = await restoreShotPrompt(store, target, restoreInput(history, selected.version));
  const after = await live(store), expected = parseSceneRecord(JSON.stringify(before));
  expected.version = before.version + 1;
  orderedShots(expected)[0]!.promptOverride = selected.prompt!;
  assert.equal(version, expected.version); assert.deepEqual(projectSceneRecord(parseSceneRecord(JSON.stringify(after))), projectSceneRecord(expected));
  assert.equal(await readFile(historicalFile, "utf8"), retained, "history is never rewritten");
  const again = await readShotPromptHistory(store, target);
  await assert.rejects(restoreShotPrompt(store, target, restoreInput(again, selected.version)), /already current/);
});

it("refuses moved scenes, altered historical bytes, and the other capability without touching live bytes", async () => {
  const { store, target } = await fixture();
  await change(store, scene => { orderedShots(scene)[0]!.promptOverride = { text: "Older", capability: "image", sheetVersions: {} }; });
  await change(store, scene => { orderedShots(scene)[0]!.promptOverride = { text: "Current", capability: "image", sheetVersions: {} }; });
  const history = await readShotPromptHistory(store, target), older = history.entries.find(e => e.prompt?.text === "Older")!;
  const input = restoreInput(history, older.version);
  await change(store, scene => { orderedShots(scene)[0]!.title = "Moved"; });
  const before = await readFile(join(store.dir, path), "utf8");
  await assert.rejects(restoreShotPrompt(store, target, input), /scene changed/);
  const current = await readShotPromptHistory(store, target);
  await assert.rejects(restoreShotPrompt(store, { ...target, capability: "video" }, restoreInput(current, older.version)), /other capability/);
  await writeFile(join(store.dir, `.history/productions/saltlight/scenes/04-the-verse-rises/v${older.version}.json`), "{}\n");
  await assert.rejects(restoreShotPrompt(store, target, restoreInput(current, older.version)), /historical version changed/);
  assert.equal(await readFile(join(store.dir, path), "utf8"), before);
  const gap = await readShotPromptHistory(store, target);
  assert.equal(gap.partial, true); assert.ok(gap.entries.some(e => e.version === older.version && e.unavailable));
});

it("a no-override version reviews today's assembly and refuses changed source evidence", async () => {
  const { store, target } = await fixture();
  await change(store, scene => { delete orderedShots(scene)[0]!.promptOverride; });
  const absentVersion = (await live(store)).version;
  await change(store, scene => { orderedShots(scene)[0]!.promptOverride = { text: "Current", capability: "image", sheetVersions: {} }; });
  const history = await readShotPromptHistory(store, target), input = restoreInput(history, absentVersion);
  assert.ok(history.assembledBody.length > 0);
  await assert.rejects(restoreShotPrompt(store, target, { ...input, assembledHash: sha256("wrong assembly") }), /sources changed/);
  await restoreShotPrompt(store, target, input);
  assert.equal(orderedShots(await live(store))[0]!.promptOverride, undefined);
});

it("the saved image inspector agrees with the actual frame compiler without writing a run", async () => {
  const { store, target } = await fixture(), world = store.getBundle();
  const production = world.productions.find(p => p.meta.id === target.productionId)!, scene = production.scenes.find(s => s.id === target.sceneId)!;
  const input = { worldId: store.worldId, productionId: target.productionId, scene, production, world, model: image,
    mode: "per-shot" as const, scope: "all" as const, shotId: target.shotId, boardCapSec: 10, eligible: true, clock };
  const before = await readdir(store.dir), run = await compileFrameRun(input), inspected = await framePromptInspection(input);
  assert.equal(inspected.prompt, run.steps[0]!.dispatch.params.prompt);
  assert.deepEqual(inspected.references.filter(r => r.sent).map(r => r.file), run.steps[0]!.dispatch.references);
  assert.equal(inspected.source, "saved-shot"); assert.deepEqual(await readdir(store.dir), before);
});

it("a draft inspection uses dispatch's compiled prompt; missing original jobs never recompile a saved take", async () => {
  const { store } = await fixture(), world = store.getBundle();
  const session = foldBenchSession({ schemaVersion: 1, id: "sess_01J8F3K2QW9VZX4N7M0RTYB6HC", createdAt: at }, []);
  session.composer = { ...session.composer, mode: "image", provider: image.provider, model: image.id, params: { kind: "image", count: 2, aspect: "16:9" }, brief: "An image of the shore." };
  const manifest = { manifestVersion: 1, generated: at, models: [image] }, options = { worldId: store.worldId, requestId: "inspection-test", at };
  const plan = planBenchDispatch(session, world, manifest, options); assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
  const inspected = compilePromptInspection(session, world, manifest, options, "generator-draft", session.id);
  assert.equal(inspected.prompt, plan.inputs[0]!.params.prompt); assert.equal(inspected.quantity, plan.inputs.length);
  const take = BenchTakeSchema.parse({ ...plan.reserved[0]!, status: "queued", disposition: "open", jobId: "jb_01J8F3K2QW9VZX4N7M0RTYB6HC" });
  assert.throws(() => frozenPromptInspection(undefined, take, session, world), /original compiled job is not retained/);
  const job = JobSchema.parse({ ...plan.inputs[0], id: take.jobId, idempotencyKey: WORLD_ID, status: "queued", createdAt: at, updatedAt: at });
  session.composer.brief = "Changed draft after dispatch";
  const frozen = frozenPromptInspection(job, take, session, world);
  assert.equal(frozen.prompt, job.params.prompt); assert.equal(frozen.source, "frozen-request");
});

it("read-only Bench inspection refuses a torn tail without repairing it", async () => {
  const { store } = await fixture(), sessionId = "sess_01J8F3K2QW9VZX4N7M0RTYB6HC", dir = join(store.dir, ".sessions", sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.json"), JSON.stringify({ schemaVersion: 1, id: sessionId, createdAt: at }));
  const torn = '{"seq":1,"event":'; await writeFile(join(dir, "events.jsonl"), torn);
  await assert.rejects(readPromptBench(store, sessionId));
  assert.equal(await readFile(join(dir, "events.jsonl"), "utf8"), torn);
});

it("the coordinator gates reads with the persisted preference and excludes prompt replies from diagnostics", async () => {
  const { root } = await makeTempRoot(), host = await startLedgerCoordinator(root), events: DomainEvent[] = [];
  const emitter = host.coordinator as unknown as { emit(event: DomainEvent): void }, emit = emitter.emit.bind(host.coordinator);
  emitter.emit = event => { events.push(event); emit(event); };
  try {
    await host.send({ kind: "open-world", worldId: WORLD_ID });
    const production = host.coordinator.getState().world!.productions[0]!, scene = production.scenes[0]!;
    const request = { kind: "prompt-history-read" as const, worldId: WORLD_ID, requestId: WORLD_ID, productionId: production.meta.id,
      sceneId: scene.id, shotId: orderedShots(scene)[0]!.id, capability: "image" as const };
    await host.send(request);
    const disabled = events.filter(e => e.type === "prompt-tools.result").at(-1)!;
    assert.equal(disabled.result.kind, "failed");
    await host.send({ kind: "set-prompt-tools", enabled: true });
    assert.equal(host.coordinator.getState().app.promptTools, true);
    assert.equal((await new AppSettingsFile(join(root, "settings.json")).load()).promptTools, true);
    await host.send(request);
    const read = events.filter(e => e.type === "prompt-tools.result").at(-1)!;
    assert.equal(read.result.kind, "history", JSON.stringify(read.result));
    await host.send({ kind: "set-prompt-tools", enabled: false });
    assert.equal(host.coordinator.getState().app.promptTools, false);
  } finally { await host.close(); }
  const diagnostics = await readFile(join(root, "logs", "changes.jsonl"), "utf8");
  assert.doesNotMatch(diagnostics, /prompt-tools.result|currentBody|assembledBody|sheetVersions/);
});
