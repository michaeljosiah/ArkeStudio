import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { pngBytes } from "../queue/fake-provider.js";
import { tempDir } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Filing artifacts from the panel beside the cut (82a).
 *
 * The picker itself is Electron's and cannot run here, so it is stubbed and everything after it
 * is real: `fileArtifact` copying bytes, writing a sidecar, and deduplicating by hash.
 */

const REQUEST = "01J8E1000000000000000000V1";

async function harness(picked: () => readonly string[]) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => "2026-08-14T12:00:00.000Z" });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
    pickFiles: async () => picked(),
  });
  const send = (msg: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  // Returned so every test can close it: an open WorldStore keeps the runner alive forever.
  return { provider, worldDir, events, send };
}

/** Distinct bytes per file: `pngBytes()` is a constant, and identical files deduplicate. */
function distinctPng(seed: number): Uint8Array {
  const bytes = Uint8Array.from(pngBytes());
  bytes[12] = seed;
  return bytes;
}

async function sourceFile(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await tempDir("upload-src");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

const upload = { kind: "upload-artifacts", worldId: WORLD_ID, requestId: REQUEST } as ClientMessage;
const results = (events: DomainEvent[]) =>
  events.filter((e) => e.type === "queue.enqueue-result") as Array<Record<string, unknown>>;

describe("filing artifacts from the panel (82a)", () => {
  it("copies what was picked onto the world's shelf, with a sidecar each", async () => {
    const a = await sourceFile("harbour-plate.png", distinctPng(1));
    const b = await sourceFile("bell-market.png", distinctPng(2));
    const { provider, worldDir, events, send } = await harness(() => [a, b]);
    try {
      await send(upload);

      const filed = (await readdir(join(worldDir, "artifacts"))).sort();
      assert.ok(filed.includes("harbour-plate.png"), "the bytes land in the world");
      assert.ok(filed.includes("harbour-plate.png.json"), "and the sidecar beside them");
      assert.ok(filed.includes("bell-market.png") && filed.includes("bell-market.png.json"));
      const [result] = results(events);
      assert.equal(result?.["requestedCount"], 2);
      assert.deepEqual(result?.["failures"], []);
      assert.equal(result?.["command"], "upload-artifacts");
    } finally {
      await provider.close();
    }
  });

  it("says nothing when the dialog is closed — that is not a failure", async () => {
    const { provider, events, send } = await harness(() => []);
    try {
      await send(upload);
      const [result] = results(events);
        assert.equal(result?.["requestedCount"], 0);
      assert.equal(result?.["disposition"], "not-queued", "a closed dialog is not a failure");
    } finally {
      await provider.close();
    }
  });

  it("files the same bytes once, however they are named", async () => {
    // fileArtifact deduplicates on content hash; the panel must not grow a second row for a file
    // the world already has under another name.
    const bytes = distinctPng(7);
    const first = await sourceFile("plate.png", bytes);
    const again = await sourceFile("plate-copy.png", bytes);
    const { provider, worldDir, send } = await harness(() => [first, again]);
    try {
      await send(upload);
      // Only what this test filed: the fixture world already ships a board png of its own.
      const filed = (await readdir(join(worldDir, "artifacts"))).filter((f) => f.startsWith("plate"));
      assert.deepEqual(filed.sort(), ["plate.png", "plate.png.json"], "one set of bytes, one artifact");
    } finally {
      await provider.close();
    }
  });

  it("refuses when the host has no picker, rather than failing silently", async () => {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: () => "2026-08-14T12:00:00.000Z" });
    await provider.loadWorld(WORLD_ID);
    const events: DomainEvent[] = [];
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      observeEvent: (event) => events.push(event),
      // No pickFiles: the browser dev host, where the dialog does not exist.
    });
    try {
      await (coordinator as unknown as { handleClientMessage(m: ClientMessage): Promise<void> }).handleClientMessage(upload);
      // rejectEnqueue carries the sentence in `failures`, not at the top level.
      const [result] = results(events);
      assert.equal(result?.["disposition"], "rejected");
      const failures = result?.["failures"] as Array<{ reason: string }>;
      assert.match(failures[0]?.reason ?? "", /unavailable/i);
    } finally {
      await provider.close();
    }
  });
});
