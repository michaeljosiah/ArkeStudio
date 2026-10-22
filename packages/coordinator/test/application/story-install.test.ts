import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ZipFile } from "yazl";
import { setImmediate as nextTurn } from "node:timers/promises";
import { it } from "node:test";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import type { StoryDownload } from "../../src/world/story-download.js";
import { tempDir } from "../tmp.js";
import { FIXTURE_WORLD } from "../world/helpers.js";

// Small transfer fixtures must not inherit the live release's transport layout or size.
const TEST_RELEASE: StoryDownload = { url: "https://github.com/owner/repo/releases/download/test/story.zip", bytes: 100,
  unpackedBytes: 100, sha256: "0".repeat(64), version: "test", summary: "Transport fixture" };

it("overlapping install commands admit only one copy", async t => {
  const root = await tempDir("story-admission-");
  let enter!: () => void, release!: () => void, installs = 0;
  const entered = new Promise<void>(r => { enter = r; });
  const held = new Promise<void>(r => { release = r; });
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ adapter: null, appRoot: root, appVersion: "test",
    changeLogPath: join(root, "changes.jsonl"), sampleWorldPath: "fixture", observeEvent: e => events.push(e),
    provider: { async listWorlds() { return []; }, async loadWorld() { throw Error("unused"); },
      async installSampleWorld() { installs++; enter(); await held; return { worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", slug: "sample", name: "Sample" }; } } });
  t.after(() => coordinator.stop());
  const internal = coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> };
  const first = internal.handleClientMessage({ kind: "install-sample-world" });
  await entered;
  try {
    await internal.handleClientMessage({ kind: "install-sample-world" }); assert.equal(installs, 1);
    await internal.handleClientMessage({ kind: "cancel-sample-world-download" });
    await internal.handleClientMessage({ kind: "discard-sample-world-download" });
    assert.equal(installs, 1, "download controls cannot interrupt the independent world copy");
  }
  finally { release(); }
  await first;
  assert.equal(events.filter(e => e.type === "sample-world.installed").length, 1);
});

it("the public cancel command retains a prefix across coordinator restart and explicit removal", async t => {
  const root = await tempDir("story-cancel-");
  const release = TEST_RELEASE;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(50)); } })));
  let installs = 0;
  const options = { adapter: null, appRoot: root, appVersion: "test", changeLogPath: join(root, "changes.jsonl"), sampleWorldDownload: release,
    provider: { async listWorlds() { return []; }, async loadWorld() { throw Error("unused"); }, async installSampleWorld() { installs++; throw Error("must not install"); } } };
  const first = new Coordinator(options), internal = first as unknown as { handleClientMessage(msg: ClientMessage): Promise<void>; readModel: { getState(): import("@arke-studio/contracts").ClientState } };
  const attempt = internal.handleClientMessage({ kind: "install-sample-world" });
  const file = join(root, "downloads", `story-${release.sha256}.part`);
  try {
    for (let i = 0; i < 1000 && (await stat(file).catch(() => null))?.size !== 50; i++) await nextTurn();
    assert.equal((await stat(file)).size, 50);
    assert.equal(internal.readModel.getState().app.sampleWorld.cancellable, true);
    await internal.handleClientMessage({ kind: "cancel-sample-world-download" });
    await attempt;
    const sample = internal.readModel.getState().app.sampleWorld;
    assert.equal(sample.installing, false); assert.equal(sample.cancellable, false); assert.equal(sample.note?.refused, false);
    assert.equal(sample.download?.retainedBytes, 50); assert.equal(installs, 0);
  } finally { await first.stop(); }
  const second = new Coordinator(options), restarted = second as unknown as typeof internal;
  try {
    await restarted.handleClientMessage({ kind: "refresh-sample-world-download" });
    assert.equal(restarted.readModel.getState().app.sampleWorld.download?.retainedBytes, 50);
    await restarted.handleClientMessage({ kind: "discard-sample-world-download" });
    assert.equal(restarted.readModel.getState().app.sampleWorld.download?.retainedBytes, 0);
    assert.deepEqual(await readdir(join(root, "downloads")), []);
  } finally { await second.stop(); }
});

it("shutdown aborts a story download, cleans scratch and never installs it", async t => {
  const root = await tempDir("story-shutdown-");
  let enter!: () => void, installs = 0;
  const entered = new Promise<void>(r => { enter = r; });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    enter();
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  });
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ adapter: null, appRoot: root, appVersion: "test",
    changeLogPath: join(root, "changes.jsonl"), sampleWorldDownload: { ...TEST_RELEASE, bytes: 1, unpackedBytes: 1 }, observeEvent: e => events.push(e),
    provider: { async listWorlds() { return []; }, async loadWorld() { throw Error("unused"); },
      async installSampleWorld() { installs++; throw Error("must not install"); } } });
  t.after(() => coordinator.stop());
  const internal = coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> };
  const installing = internal.handleClientMessage({ kind: "install-sample-world" });
  await entered;
  await Promise.all([coordinator.stop(), installing]);
  assert.equal(installs, 0);
  assert.deepEqual(await readdir(join(root, "downloads")), []);
  assert.equal(events.some(e => e.type === "sample-world.installed" || e.type === "sample-world.refused"), false);
});

it("retries a failed independent copy without downloading the verified archive again", async t => {
  const root = await tempDir("story-copy-retry-"), world = await readFile(join(FIXTURE_WORLD, "world.json"));
  const zip = new ZipFile(), chunks: Buffer[] = [];
  const collect = (async () => { for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); })();
  zip.addBuffer(world, "world.json"); zip.end(); await collect;
  const data = Buffer.concat(chunks), release = { ...TEST_RELEASE, bytes: data.length, unpackedBytes: world.length, sha256: createHash("sha256").update(data).digest("hex") };
  let requests = 0, installs = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(new Uint8Array(data)); });
  const coordinator = new Coordinator({ adapter: null, appRoot: root, appVersion: "test", changeLogPath: join(root, "changes.jsonl"), sampleWorldDownload: release,
    provider: { async listWorlds() { return []; }, async loadWorld() { throw Error("unused"); }, async installSampleWorld() {
      if (++installs === 1) throw new Error("Temporary copy failure");
      return { worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", slug: "sample", name: "Sample" };
    } } });
  const internal = coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void>; readModel: { getState(): import("@arke-studio/contracts").ClientState } };
  try {
    await internal.handleClientMessage({ kind: "install-sample-world" });
    assert.equal(internal.readModel.getState().app.sampleWorld.download?.retainedBytes, data.length);
    assert.equal(internal.readModel.getState().app.sampleWorld.note?.refused, true);
    assert.deepEqual(await readdir(join(root, "downloads")), [`story-${release.sha256}.part`], "only the verified archive survives the failed copy");
    await internal.handleClientMessage({ kind: "install-sample-world" });
    assert.equal(requests, 1); assert.equal(installs, 2);
    assert.equal(internal.readModel.getState().app.sampleWorld.note?.refused, false);
    assert.deepEqual(await readdir(join(root, "downloads")), []);
  } finally { await coordinator.stop(); }
});
