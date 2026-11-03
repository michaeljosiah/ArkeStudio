import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { ClientMessageSchema, characterSheetFor, mainPhotoFor, newId, ulid, type ClientMessage, type DomainEvent, type SessionId } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { openBenchSession } from "../../src/bench/service.js";
import { sessionMediaDir } from "../../src/bench/store.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { sha256 } from "../../src/world/text-files.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const CLOCK = () => "2026-11-03T10:00:00.000Z";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S1sAAAAASUVORK5CYII=", "base64");
async function fixture(fullHash = false) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: CLOCK });
  await provider.loadWorld(WORLD_ID);
  const sessionId = newId("sess") as SessionId, takeId = newId("tk");
  const bench = (await openBenchSession(worldDir, CLOCK, { sessionId, defaultModel: { provider: "fal", model: "test-image" }, initial: { mode: "image", brief: "Maren at the rail." } }))!;
  await bench.store.append({ type: "takes-reserved", takes: [{ id: takeId, n: 1, requestId: "fixture",
    request: { mode: "image", brief: "Maren at the rail.", provider: "fal", model: "test-image", references: [], keyframes: [], params: { kind: "image", count: 1, aspect: "16:9" } }, createdAt: CLOCK() }] });
  const media = join(worldDir, sessionMediaDir(sessionId, takeId));
  await mkdir(media, { recursive: true });
  const source = join(media, "picture.png");
  await writeFile(source, PNG);
  // Match the shortened hash emitted by the production bench-take finalizer.
  const hash = fullHash ? sha256(PNG) : sha256(PNG).slice(0, "sha256:".length + 16);
  await bench.store.append({ type: "take-completed", takeId, media: { file: "picture.png", hash }, cost: { estimatedMicroUsd: 80, actualMicroUsd: 73 }, completedAt: CLOCK() });
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "changes.jsonl"), appVersion: "test", observeEvent: event => events.push(event) });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(ClientMessageSchema.parse(message));
  const command = (image: "main-photo" | "character-sheet"): Extract<ClientMessage, { kind: "bench-use-reference" }> => ({ kind: "bench-use-reference", worldId: WORLD_ID, sessionId, takeId, sheetId: "maren-kest", image, requestId: ulid() });
  return { provider, worldDir, source, send, command, events, close: () => provider.close() };
}

for (const fullHash of [false, true]) for (const image of ["main-photo", "character-sheet"] as const) it(`uses a saved Bench image as ${image} with a ${fullHash ? "full" : "production-prefix"} hash without dispatch and replays idempotently`, async () => {
  const w = await fixture(fullHash);
  try {
    const store = w.provider.openStore()!;
    const old = store.getBundle().referenceKits.find(kit => kit.sheetId === "maren-kest");
    const oldFile = old && mainPhotoFor(old)?.file;
    const oldBytes = oldFile ? await readFile(join(w.worldDir, "references/maren-kest", oldFile)) : null;
    const command = w.command(image);
    await w.send(command);
    const answer = w.events.findLast(event => event.type === "bench.reference-used")!;
    assert.equal(answer.accepted, true, answer.reason);
    const kit = store.getBundle().referenceKits.find(kit => kit.sheetId === command.sheetId)!;
    const selected = image === "main-photo" ? mainPhotoFor(kit) : characterSheetFor(kit);
    assert.ok(selected);
    assert.deepEqual(await readFile(join(w.worldDir, "references", command.sheetId, selected.file)), PNG);
    assert.deepEqual(await readFile(w.source), PNG, "Bench's saved image stays intact");
    if (oldBytes) assert.deepEqual(await readFile(join(w.worldDir, "references/maren-kest", oldFile!)), oldBytes);
    const copied = store.getBundle().referenceTakes.find(take => take.params["benchTakeId"] === command.takeId)!;
    assert.equal(copied.provider, "fal");
    assert.equal(copied.cost.actualMicroUsd, 73);
    const count = store.getBundle().referenceTakes.length;
    await w.send(command);
    assert.equal(store.getBundle().referenceTakes.length, count);
    await w.send({ ...command, image: image === "main-photo" ? "character-sheet" : "main-photo" });
    assert.equal(w.events.findLast(event => event.type === "bench.reference-used")?.accepted, false, "a replay cannot change its destination");
    assert.equal(store.getBundle().referenceTakes.length, count);
    assert.equal(w.events.some(event => event.type.startsWith("job.")), false);
  } finally { await w.close(); }
});

it("refuses changed saved bytes, wrong worlds and unavailable characters", async () => {
  const w = await fixture();
  try {
    const store = w.provider.openStore()!;
    const before = store.getBundle().referenceTakes.length;
    const wrong = { ...w.command("main-photo"), worldId: ulid() };
    await w.send(wrong);
    assert.equal(w.events.findLast(event => event.type === "bench.reference-used")?.accepted, false);
    await w.send({ ...w.command("main-photo"), sheetId: "missing-character" });
    assert.equal(w.events.findLast(event => event.type === "bench.reference-used")?.accepted, false);
    await writeFile(w.source, Buffer.concat([PNG, Buffer.from("changed")]));
    await w.send(w.command("main-photo"));
    assert.equal(w.events.findLast(event => event.type === "bench.reference-used")?.accepted, false);
    assert.equal(store.getBundle().referenceTakes.length, before);
  } finally { await w.close(); }
});
