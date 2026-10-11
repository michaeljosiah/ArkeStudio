import assert from "node:assert/strict";
import { it } from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClientMessageSchema, storyTimelineFingerprint, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { BrowserMediaImports } from "../../src/artifacts/browser-media-import.js";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { createProduction } from "../../src/productions/ops.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { pngBytes } from "../queue/fake-provider.js";
import { arkeClientCommand } from "../../src/arke-actions/registry.js";
import { WorldStore } from "../../src/world/store.js";

const REQUEST = "01J8E1000000000000000000V1";
const file = { name: "title.png", data: Buffer.from(pngBytes()).toString("base64") };

it("does not grant model actions access to browser file bytes", () => {
  const descriptor = arkeClientCommand("upload-artifacts");
  assert.equal(descriptor.classification, "supported-by-arke");
  if (descriptor.classification !== "supported-by-arke") throw new Error("Missing descriptor");
  assert.equal(descriptor.conversationSchema.safeParse({ kind: "upload-artifacts", worldId: WORLD_ID, requestId: REQUEST, browserFiles: [file] }).success, false);
});

it("confines duplicate filenames to separate files and cleans the spool on success and failure", async () => {
  const imports = new BrowserMediaImports(); let directory = "";
  await imports.run([file, { ...file, data: "YQ==" }], () => false, async paths => {
    directory = dirname(dirname(paths[0]!));
    assert.notEqual(paths[0], paths[1]); assert.equal(await readFile(paths[1]!, "utf8"), "a");
    await assert.rejects(imports.run([file], () => false, async () => {}), /Another browser import/);
  });
  assert.equal(existsSync(directory), false);
  await assert.rejects(imports.run([file], () => false, async paths => { directory = dirname(dirname(paths[0]!)); throw new Error("filing refused"); }), /filing refused/);
  assert.equal(existsSync(directory), false);
  await assert.rejects(imports.run([{ name: "../secret.png", data: "YQ==" }], () => false, async () => assert.fail()), /reserved characters/);
  await assert.rejects(imports.run([file], () => true, async () => assert.fail()), /world closed/);
});

it("imports browser bytes through ordinary filing, measurement and one fenced timeline transaction without a native picker", async t => {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root); await provider.loadWorld(WORLD_ID); t.after(() => provider.close());
  const store = provider.openStore()!;
  const productionId = await createProduction(store, { title: "Browser media", medium: "video", frameRate: 24 });
  const production = () => store.getBundle().productions.find(p => p.meta.id === productionId)!;
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test",
    observeEvent: event => events.push(event), mediaProbe: { async durationSec() { return 3; }, async info() { return { durationSec: 3, hasAudio: true, hasVideo: false }; } } });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(message);
  const songBytes = Buffer.alloc(6 * 1024 * 1024, 5);
  const request = ClientMessageSchema.parse({ kind: "upload-artifacts", worldId: WORLD_ID, requestId: REQUEST,
    browserFiles: [file, { name: "song.mp3", data: songBytes.toString("base64") }],
    editor: { productionId, baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production()), destination: "append" } });
  await send(request);
  const result = events.find(event => event.type === "queue.enqueue-result");
  assert.ok(result?.type === "queue.enqueue-result"); assert.deepEqual(result.failures, []); assert.equal(result.requestedCount, 2);
  assert.deepEqual(await readFile(join(worldDir, "artifacts", "song.mp3")), songBytes);
  const saved = production().timeline; assert.equal(saved?.status, "ready"); if (saved?.status !== "ready") throw new Error("Timeline missing");
  assert.equal(saved.timeline.library.length, 2); assert.equal(saved.timeline.history.undo.length, 1);
  assert.ok(saved.timeline.tracks.some(track => track.kind === "audio" && track.clips[0]?.durationFrames === 72));
  assert.equal(store.getBundle().artifacts.find(artifact => artifact.file === "song.mp3")?.mediaInfo?.hasAudio, true);
  const before = store.getBundle().artifacts.length;
  await send(ClientMessageSchema.parse({ ...request, editor: undefined, sourcePaths: ["C:\\unselected.mp4"] }));
  assert.equal(store.getBundle().artifacts.length, before);
  assert.match(JSON.stringify(events.at(-1)), /either browser files or desktop/);
});

it("refuses browser filing in a read-only world before copying bytes", async t => {
  const { root, worldDir } = await makeTempRoot();
  const store = await WorldStore.open(worldDir, { readOnly: true }); t.after(() => store.close());
  const provider = new FsWorldProvider(root); t.after(() => provider.close());
  t.mock.method(provider, "openStore", () => store);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test", observeEvent: event => events.push(event) });
  const before = store.getBundle().artifacts;
  await (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage({ kind: "upload-artifacts", worldId: WORLD_ID, requestId: REQUEST, browserFiles: [file] });
  assert.match(JSON.stringify(events), /read-only/); assert.deepEqual(store.getBundle().artifacts, before);
});
