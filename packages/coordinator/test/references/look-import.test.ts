import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { importCharacterLook } from "../../src/references/look-import.js";
import { WorldStore } from "../../src/world/store.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { Coordinator } from "../../src/coordinator.js";
import { sha256 } from "../../src/world/text-files.js";
import { makeTempWorld, makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { pngBytes } from "../queue/fake-provider.js";

const requestId = "01J8E1000000000000000000K1";
const input = (): Extract<ClientMessage, { kind: "import-character-look" }> => ({
  kind: "import-character-look", worldId: WORLD_ID, sheetId: "maren-kest", requestId,
  name: "Ward visit", lookKind: "costume", files: [{ name: "ward.jpg", data: Buffer.from(pngBytes()).toString("base64") }],
});

describe("finished character look import", () => {
  it("records a pending immutable user take with the chosen name/type and no identity change", async () => {
    const dir = await makeTempWorld(), store = await WorldStore.open(dir);
    try {
      const before = await readFile(join(dir, "references/maren-kest/kit.json"), "utf8");
      const take = await importCharacterLook(store, input(), () => true);
      assert.equal(take.kind, "look"); assert.equal(take.provider, "user");
      assert.equal(take.jobId, undefined); assert.equal(take.cost.actualMicroUsd, 0);
      assert.equal(take.media, "ward.png", "extension follows the verified bytes");
      assert.equal(take.params["sourceFilename"], "ward.jpg");
      assert.equal(take.params["uploadedHash"], sha256(pngBytes()));
      assert.equal(take.params["lookName"], "Ward visit");
      assert.equal(take.params["lookKind"], "costume");
      assert.deepEqual(await readFile(join(dir, "references/maren-kest/takes", take.id, take.media!)), Buffer.from(pngBytes()));
      assert.equal(await readFile(join(dir, "references/maren-kest/kit.json"), "utf8"), before);
      assert.equal(store.getBundle().referenceReviews.length, 0);
      const replay = await importCharacterLook(store, input(), () => true);
      assert.equal(replay.id, take.id);
      await assert.rejects(importCharacterLook(store, { ...input(), name: "Different" }, () => true), /request changed/);
      await assert.rejects(importCharacterLook(store, { ...input(), files: [{ ...input().files[0]!, name: "renamed.png" }] }, () => true), /request changed/);
      await store.close();
      const reopened = await WorldStore.open(dir);
      try { assert.ok(reopened.getBundle().referenceTakes.some(row => row.id === take.id)); }
      finally { await reopened.close(); }
    } finally { await store.close(); }
  });

  for (const [name, change] of [
    ["non-image bytes", { files: [{ name: "photo.png", data: Buffer.from("not an image").toString("base64") }] }],
    ["unsafe filename", { files: [{ name: "../photo.png", data: Buffer.from(pngBytes()).toString("base64") }] }],
    ["no image", { files: [] }],
    ["several images", { files: [...input().files, ...input().files] }],
    ["non-character", { sheetId: "the-saltmarket" }],
    ["wrong world", { worldId: "01J8F3K2QW9VZX4N7M0RTYB6ZZ" }],
  ] as const) it(`refuses ${name} without a take`, async () => {
    const store = await WorldStore.open(await makeTempWorld());
    try {
      await assert.rejects(importCharacterLook(store, { ...input(), ...change, files: "files" in change ? [...change.files] : input().files }, () => true));
      assert.equal(store.getBundle().referenceTakes.length, 0);
    } finally { await store.close(); }
  });

  it("rechecks the current world inside the write gate", async () => {
    const store = await WorldStore.open(await makeTempWorld()); let checks = 0;
    try {
      await assert.rejects(importCharacterLook(store, input(), () => ++checks === 1), /could not be saved/);
      assert.equal(store.getBundle().referenceTakes.length, 0);
    } finally { await store.close(); }
  });

  it("refuses imported depictions when the character is never depicted", async () => {
    const dir = await makeTempWorld(), path = join(dir, "characters/maren-kest.md");
    await writeFile(path, (await readFile(path, "utf8")).replace("type: character", "type: character\nneverDepicted: true"));
    const store = await WorldStore.open(dir);
    try {
      await assert.rejects(importCharacterLook(store, input(), () => true), /never depicted/);
      assert.equal(store.getBundle().referenceTakes.length, 0);
    } finally { await store.close(); }
  });

  it("deduplicates concurrent copies of the same request inside the write gate", async () => {
    const store = await WorldStore.open(await makeTempWorld());
    try {
      const [first, second] = await Promise.all([importCharacterLook(store, input(), () => true), importCharacterLook(store, input(), () => true)]);
      assert.equal(first.id, second.id);
      assert.equal(store.getBundle().referenceTakes.length, 1);
    } finally { await store.close(); }
  });

  it("refuses a concurrent request-id collision with different look details", async () => {
    const store = await WorldStore.open(await makeTempWorld());
    try {
      const results = await Promise.allSettled([importCharacterLook(store, input(), () => true), importCharacterLook(store, {...input(), name:"Other"}, () => true)]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(store.getBundle().referenceTakes.length, 1);
    } finally { await store.close(); }
  });

  it("imports and accepts through public commands, preserving the main photo and the imported name", async () => {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root); await provider.loadWorld(WORLD_ID);
    const events: DomainEvent[] = [];
    const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "changes.jsonl"), appVersion: "test", observeEvent: event => events.push(event) });
    const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
    try {
      const anchor = provider.openStore()!.getBundle().referenceKits.find(kit => kit.sheetId === "maren-kest")!.anchor;
      await send(input());
      const result = events.find(event => event.type === "character-look.imported");
      assert.ok(result?.type === "character-look.imported" && result.takeId);
      assert.equal(result.status, "landed");
      await send({ kind: "accept-character-look", worldId: WORLD_ID, sheetId: "maren-kest", takeId: result.takeId });
      const kit = provider.openStore()!.getBundle().referenceKits.find(kit => kit.sheetId === "maren-kest")!;
      assert.equal(kit.anchor, anchor);
      assert.equal(kit.looks?.at(-1)?.name, "Ward visit");
      assert.equal(kit.looks?.at(-1)?.sourceTakeId, result.takeId);
    } finally { await provider.close(); }
  });
});
