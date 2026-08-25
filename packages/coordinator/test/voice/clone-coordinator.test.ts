import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const CLOCK = "2026-08-25T12:00:00.000Z";

function wav(): Uint8Array {
  const dataBytes = 64;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(10, 24);
  bytes.writeUInt32LE(20, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

async function harness() {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  const send = (message: ClientMessage) =>
    (
      coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }
    ).handleClientMessage(message);
  return { root, worldDir, provider, events, send };
}

function staged(events: DomainEvent[]) {
  return events.findLast((event) => event.type === "voice.clip-staged") as
    Extract<DomainEvent, { type: "voice.clip-staged" }> | undefined;
}

function cloned(events: DomainEvent[]) {
  return events.findLast((event) => event.type === "voice.cloned") as
    Extract<DomainEvent, { type: "voice.cloned" }> | undefined;
}

describe("clone command world ownership", () => {
  it("rejects a stale-world stage command before retaining a clip", async () => {
    const h = await harness();
    try {
      const staleWorld = "01J8F3K2QW9VZX4N7M0RTYB6HD";
      await h.send({
        kind: "stage-voice-clip",
        worldId: staleWorld,
        requestId: "stale-stage",
        source: {
          from: "recorded",
          audioBase64: Buffer.from(wav()).toString("base64"),
          contentType: "audio/wav",
        },
      });

      const result = staged(h.events);
      assert.ok(result);
      assert.equal(result.worldId, staleWorld);
      assert.equal(result.clipId, null);
      assert.match(result.reason ?? "", /no longer open/);
      assert.deepEqual(h.provider.openStore()?.getBundle().clonedVoices, []);

      h.events.length = 0;
      await h.send({
        kind: "clone-voice",
        worldId: staleWorld,
        clipId: "clip_stale",
        name: "Stale clone",
        description: "Low and dry.",
        consent: true,
      });
      const cloneResult = cloned(h.events);
      assert.ok(cloneResult);
      assert.equal(cloneResult.worldId, staleWorld);
      assert.equal(cloneResult.voiceId, null);
      assert.match(cloneResult.reason ?? "", /no longer open/);
    } finally {
      await h.provider.close();
    }
  });

  it("binds a staged clip to its world and refuses it after a world switch", async () => {
    const h = await harness();
    try {
      await h.send({
        kind: "stage-voice-clip",
        worldId: WORLD_ID,
        requestId: "stage-for-first-world",
        source: {
          from: "recorded",
          audioBase64: Buffer.from(wav()).toString("base64"),
          contentType: "audio/wav",
        },
      });
      const first = staged(h.events);
      assert.ok(first?.clipId);

      const second = await h.provider.createWorld({ name: "Second world" });
      await h.provider.loadWorld(second.worldId);
      await h.send({
        kind: "clone-voice",
        worldId: second.worldId,
        clipId: first.clipId,
        name: "Wrong world",
        description: "Low and dry.",
        consent: true,
      });
      const crossed = cloned(h.events);
      assert.ok(crossed);
      assert.equal(crossed.worldId, second.worldId);
      assert.equal(crossed.voiceId, null);
      assert.match(crossed.reason ?? "", /no longer staged/);

      await h.send({
        kind: "clone-voice",
        worldId: WORLD_ID,
        clipId: first.clipId,
        name: "Stale command",
        description: "Low and dry.",
        consent: true,
      });

      const result = cloned(h.events);
      assert.ok(result);
      assert.equal(result.worldId, WORLD_ID);
      assert.equal(result.voiceId, null);
      assert.match(result.reason ?? "", /no longer open/);
      assert.deepEqual(h.provider.openStore()?.getBundle().clonedVoices, []);
      await assert.rejects(() => readFile(join(h.root, "worlds", "second-world", "voices", "voices.json")));
    } finally {
      await h.provider.close();
    }
  });

  it("rejects cloning through a provider that still exposes a closed store", async () => {
    const h = await harness();
    try {
      await h.send({
        kind: "stage-voice-clip",
        worldId: WORLD_ID,
        requestId: "closed-store-stage",
        source: {
          from: "recorded",
          audioBase64: Buffer.from(wav()).toString("base64"),
          contentType: "audio/wav",
        },
      });
      const clip = staged(h.events)?.clipId;
      assert.ok(clip);
      await h.provider.openStore()!.close();

      await h.send({
        kind: "clone-voice",
        worldId: WORLD_ID,
        clipId: clip,
        name: "Closed world",
        description: "Low and dry.",
        consent: true,
      });

      const result = cloned(h.events);
      assert.ok(result);
      assert.equal(result.voiceId, null);
      assert.match(result.reason ?? "", /no longer open/);
      await assert.rejects(() => readFile(join(h.worldDir, "voices", "voices.json")));
    } finally {
      await h.provider.close().catch(() => {});
    }
  });
});
