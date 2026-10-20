import assert from "node:assert/strict";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { it } from "node:test";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { UNDERSONG_RELEASE } from "../../src/world/undersong-release.js";
import { tempDir } from "../tmp.js";

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
  try { await internal.handleClientMessage({ kind: "install-sample-world" }); assert.equal(installs, 1); }
  finally { release(); }
  await first;
  assert.equal(events.filter(e => e.type === "sample-world.installed").length, 1);
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
    changeLogPath: join(root, "changes.jsonl"), sampleWorldDownload: { ...UNDERSONG_RELEASE, bytes: 1, unpackedBytes: 1 }, observeEvent: e => events.push(e),
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
