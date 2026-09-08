import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, unlink, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid, type ClientMessage, type DomainEvent, type Job } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { recordReferenceTake } from "../../src/references/takes.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { pngBytes } from "../queue/fake-provider.js";

it("borrows only image bytes without opening the source, and freezes their origin into a take", async () => {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  const source = await provider.createWorld({ name: "Another world" });
  const sourceDir = await provider.worldDir(source.worldId);
  const image = "references/face/main-photo.png";
  await mkdir(join(sourceDir, "references/face"), { recursive: true });
  await writeFile(join(sourceDir, image), pngBytes());
  await writeFile(join(sourceDir, "references/face/kit.json"), JSON.stringify({
    sheetId: "face", anchor: "main-photo.png", tiles: [], compilations: [],
  }));

  await writeFile(join(sourceDir, "references/face/private.json"), '{"canon":"never imported"}');
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!;
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ provider, adapter: null, appVersion: "test",
    changeLogPath: join(root, "changes.jsonl"), observeEvent: event => events.push(event) });
  const internals = coordinator as unknown as {
    handleClientMessage(message: ClientMessage): Promise<void>;
    freezeLocalIdentity(input: EnqueueInput): EnqueueInput;
  };
  const send = (message: ClientMessage) => internals.handleClientMessage(message);
  try {
    await send({ kind: "browse-reference-images", slug: source.slug, requestId: ulid() });
    assert.deepEqual(events.find(event => event.type === "reference.images")?.images, [{ file: image, name: "face · Main photo", role: "identity", group: "Cast" }]);
    assert.equal(provider.openStore(), store);
    assert.equal(await stat(join(sourceDir, "world.lock")).then(() => true, () => false), false);
    await send({ kind: "pick-staged-reference", worldId: WORLD_ID, key: "main-photo--maren-kest",
      requestId: ulid(), image: { slug: source.slug, path: image } });
    const copied = store.getBundle().stagedReferences["main-photo--maren-kest"]!;
    assert.ok(copied);
    assert.deepEqual(await readFile(join(worldDir, copied)), Buffer.from(pngBytes()));
    const origin = store.getBundle().stagedReferenceOrigins[copied]!;
    assert.equal(origin.worldName, "Another world");
    assert.equal(origin.imageName, "main-photo.png");
    assert.deepEqual(Object.keys(origin).sort(), ["copiedAt", "imageName", "worldName"]);

    await writeFile(join(sourceDir, image), "changed source");
    assert.deepEqual(await readFile(join(worldDir, copied)), Buffer.from(pngBytes()));
    await send({ kind: "pick-staged-reference", worldId: WORLD_ID, key: "main-photo--maren-kest",
      requestId: ulid(), image: { slug: source.slug, path: "references/face/private.json" } });
    assert.equal(events.at(-1)?.type, "queue.enqueue-result");
    assert.deepEqual(await readFile(join(worldDir, copied)), Buffer.from(pngBytes()), "refusal preserves the staged copy");
    await provider.archiveWorld(source.worldId);
    await provider.close();
    await provider.loadWorld(WORLD_ID);
    const reopened = provider.openStore()!;
    assert.deepEqual(reopened.getBundle().stagedReferenceOrigins[copied], origin);
    assert.deepEqual(await readFile(join(worldDir, copied)), Buffer.from(pngBytes()));

    const request: EnqueueInput = { worldId: WORLD_ID, target: { kind: "main-photo-candidate", id: "maren-kest" },
      capability: "image", provider: "fal", model: "test", estimatedMicroUsd: 0,
      params: { references: [copied], provenance: { canonRevision: 42, sheets: { "maren-kest": 4 } } } };
    const frozen = internals.freezeLocalIdentity(request);
    const dropped = internals.freezeLocalIdentity({ ...request, params: { ...request.params, references: [] } });
    assert.equal((dropped.params.provenance as { borrowedImages?: unknown }).borrowedImages, undefined);
    await send({ kind: "clear-staged-reference", worldId: WORLD_ID, key: "main-photo--maren-kest" });
    const landed = "references/maren-kest/candidates/result.png";
    await mkdir(join(worldDir, "references/maren-kest/candidates"), { recursive: true });
    await writeFile(join(worldDir, landed), pngBytes());
    const job: Job = { ...frozen, id: `jb_${ulid()}`, idempotencyKey: ulid(), status: "succeeded",
      attempt: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      landedFiles: [landed], providerJobId: null, error: null };
    const take = await recordReferenceTake(reopened, job);
    assert.deepEqual(take?.provenance.borrowedImages, [origin]);
    const saved = JSON.parse(await readFile(join(worldDir, "references/maren-kest/takes", take!.id, "take.json"), "utf8"));
    assert.deepEqual(saved.provenance.borrowedImages, [origin]);
  } finally { await provider.close(); }
});

it("does not browse or serve image paths escaping the source world", async () => {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "private.png"), pngBytes());
  await symlink(outside, join(worldDir, "references/escape"), process.platform === "win32" ? "junction" : "dir");
  try {
    assert.equal(await provider.serveMedia("the-undersong", "../outside/private.png"), null);
    assert.equal(await provider.serveMedia("the-undersong", "references/escape/private.png"), null);
    assert.ok(!(await provider.listReferenceImages("the-undersong")).some(image => image.file.includes("escape")));
  } finally { await unlink(join(worldDir, "references/escape")); await provider.close(); }
});
