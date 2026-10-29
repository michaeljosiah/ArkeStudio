import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AppStorageService } from "../../src/storage/service.js";
import { fileArtifact, retireArtifact } from "../../src/artifacts/filing.js";
import { withBrowserImportBatch } from "../../src/artifacts/browser-import-batch.js";
import { ImportFileStorage } from "../../src/storage/import-files.js";
import { openAudioStudio } from "../../src/productions/audio-studio.js";
import { writeStereoWav } from "../../src/audio/stereo-wav.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const GiB = 1024 ** 3, MiB = 1024 ** 2, REQUEST = "01J8E1000000000000000000V1";
async function fixture(free: number) {
  const { root, worldDir } = await makeTempRoot(), provider = new FsWorldProvider(root); await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!, events: DomainEvent[] = [];
  let available = free, roots: readonly { rootId: string; path: string }[] = [];
  const storage = new AppStorageService({ appRoot: root, native: {
    setRoots(value) { roots = value; }, async stop() {}, async probe(rootId) {
      const artifact = roots.find(row => row.rootId === rootId)!.path === join(worldDir, "artifacts");
      return { state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: artifact ? "artifact-volume" : "app-volume", mappingRevision: rootId,
        measuredAt: Date.now(), availableBytes: artifact ? available : 100 * GiB, totalBytes: 200 * GiB } };
    },
  } }); storage.setWorld(worldDir);
  const coordinator = new Coordinator({ provider, adapter: null, storageHealth: storage, changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test", observeEvent: event => events.push(event) });
  return { root, worldDir, store, storage, events, async full() {
    available = 0; const rootId = roots.find(row => row.path === join(worldDir, "artifacts"))!.rootId;
    storage.writeFailed(rootId); assert.equal((await storage.measure(rootId, new AbortController().signal, Date.now()))?.availableBytes, 0);
  },
    async send(files: Array<{ name: string; data: string }>, target: Pick<Extract<ClientMessage, { kind: "upload-artifacts" }>, "audioStudio" | "music"> = {}) {
      events.length = 0;
      await (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage({ kind: "upload-artifacts", worldId: WORLD_ID, requestId: REQUEST, browserFiles: files, ...target });
      const result = events.find(event => event.type === "queue.enqueue-result"); assert(result?.type === "queue.enqueue-result"); return result;
    },
    async close() { await coordinator.stop(); await provider.close(); await storage.stop(); },
  };
}
const first = { name: "batch-first.txt", data: Buffer.alloc(2 * MiB, 65).toString("base64") };
const second = { name: "batch-second.txt", data: Buffer.alloc(2 * MiB, 66).toString("base64") };
it("a batch shortfall holds before the first world copy even when either file would fit", async () => {
  const h = await fixture(GiB + 3 * MiB), before = h.store.getBundle().artifacts.length;
  try {
    const result = await h.send([first, second]); assert.match(result.failures[0]!.reason, /storage/);
    assert.equal(h.store.getBundle().artifacts.length, before);
    assert(!existsSync(join(h.worldDir, "artifacts", first.name))); assert(!existsSync(join(h.worldDir, "artifacts", second.name)));
    assert.equal(h.storage.reservations.snapshot().records.length, 0); assert(!JSON.stringify(h.events).includes("arke-browser-import-"));
  } finally { await h.close(); }
});
it("an exactly fitting batch files both payloads without reserving their parent budget twice", async () => {
  const h = await fixture(GiB + 4 * MiB + 128 * 1024), before = h.store.getBundle().artifacts.length;
  try {
    const result = await h.send([first, second]); assert.deepEqual(result.failures, []);
    assert.equal(h.store.getBundle().artifacts.length, before + 2);
    assert.equal((await readFile(join(h.worldDir, "artifacts", first.name))).length, 2 * MiB);
    assert.equal((await readFile(join(h.worldDir, "artifacts", second.name)))[0], 66);
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await h.close(); }
});
it("identical batch payloads require one new world copy and retain normal deduplication", async () => {
  const h = await fixture(GiB + 2 * MiB + 64 * 1024), before = h.store.getBundle().artifacts.length;
  try {
    assert.deepEqual((await h.send([first, { ...first, name: second.name }])).failures, []);
    assert.equal(h.store.getBundle().artifacts.length, before + 1); assert(!existsSync(join(h.worldDir, "artifacts", second.name)));
    assert.equal((await readFile(join(h.worldDir, "artifacts", first.name)))[0], 65);
  } finally { await h.close(); }
});
it("Audio Studio rejects non-audio before world planning and files the fitting audio from a mixed batch", async () => {
  const pcm = new Float32Array(4800).fill(.1), wav = writeStereoWav({ rate: 48000, channels: 2, left: pcm, right: pcm });
  const h = await fixture(GiB + wav.length + 64 * 1024), productionId = "the-ledger-of-nights", chapterFile = "01-neap";
  try {
    const opened = await openAudioStudio(h.store, productionId, chapterFile);
    const result = await h.send([{ ...first, name: "unsupported.png" }, { name: "fitting.wav", data: Buffer.from(wav).toString("base64") }], {
      audioStudio: { productionId, chapterFile, base: opened.base, destination: "library" },
    });
    assert.equal(result.failures.length, 1); assert.equal(result.failures[0]!.index, 0); assert.match(result.failures[0]!.reason, /supported audio/);
    assert(!existsSync(join(h.worldDir, "artifacts", "unsupported.png")));
    assert.deepEqual(await readFile(join(h.worldDir, "artifacts", "fitting.wav")), Buffer.from(wav));
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await h.close(); }
});
it("a zero-copy browser batch can restore retained media without reserving new payload on a full volume", async () => {
  const h = await fixture(GiB + 2 * MiB + 64 * 1024);
  try {
    assert.deepEqual((await h.send([first])).failures, []);
    const original = h.store.getBundle().artifacts.find(row => row.file === first.name)!; await retireArtifact(h.store, original.id);
    await h.full();
    assert.deepEqual((await h.send([first])).failures, []);
    const restored = h.store.getBundle().artifacts.find(row => row.id === original.id)!; assert.equal(restored.retiredAt, undefined);
    assert.equal((await readFile(join(h.worldDir, "artifacts", first.name)))[0], 65);
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await h.close(); }
});
it("a changed retained file cannot turn a zero-copy batch plan into an unreserved replacement", async () => {
  const h = await fixture(GiB + 2 * MiB + 64 * 1024), bytes = Buffer.from(first.data, "base64"), source = join(h.root, first.name);
  try {
    assert.deepEqual((await h.send([first])).failures, []); await writeFile(source, bytes);
    const original = h.store.getBundle().artifacts.find(row => row.file === first.name)!;
    await withBrowserImportBatch(h.store, [{ digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }], new ImportFileStorage(h.storage), async space => {
      await writeFile(join(h.worldDir, "artifacts", original.file), "CHANGED_CREATIVE_BYTES");
      const result = await fileArtifact(h.store, { sourcePath: source, importSpace: space });
      assert.equal(result.outcome, "refused"); if (result.outcome === "refused") assert.match(result.reason, /storage/);
    });
    assert.equal(await readFile(join(h.worldDir, "artifacts", original.file), "utf8"), "CHANGED_CREATIVE_BYTES");
    assert(!existsSync(join(h.worldDir, "artifacts", "batch-first-2.txt"))); assert.deepEqual(await readFile(source), bytes);
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await h.close(); }
});
