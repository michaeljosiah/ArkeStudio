import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const CLOCK = "2026-09-05T12:00:00.000Z";

function wav(): Uint8Array {
  const samples = 8;
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24_000, 24);
  out.writeUInt32LE(48_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(out);
}

async function harness() {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const spoken: string[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async (input: { voiceId: string; text: string }) => {
          spoken.push(input.text);
          return wav();
        },
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [],
    },
  });
  const send = (message: ClientMessage) =>
    (
      coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }
    ).handleClientMessage(message);
  return { provider, events, spoken, send };
}

function reads(events: DomainEvent[]) {
  return events.filter((event) => event.type === "voice.audio") as Extract<
    DomainEvent,
    { type: "voice.audio" }
  >[];
}

describe("reading a sheet as a page", () => {
  it("reads the blocks the screen declared, in the order it declared them, one part each", async () => {
    const h = await harness();
    try {
      await h.send({
        kind: "read-sheet-page",
        worldId: WORLD_ID,
        requestId: "01J8F3K2QW9VZX4N7M0RTYB6P1",
        sheetId: "maren-kest",
        // Deliberately not the order the sheet is written in: the page is read the way the
        // screen says it reads, never the way the document happens to be laid out.
        sections: ["Appearance", "Essence"],
      });

      const ready = reads(h.events).filter((event) => event.status === "ready");
      assert.equal(ready.length, 2);
      assert.deepEqual(
        ready.map((event) => [event.sectionHeading, event.part, event.parts]),
        [
          ["Appearance", 0, 2],
          ["Essence", 1, 2],
        ],
      );
      assert.equal(ready[0]!.purpose, "sheet-page");
      assert.notEqual(ready[0]!.file, ready[1]!.file);
      // The Appearance is one sentence pair and the Essence is long enough to be chunked, so
      // this also proves the parts are blocks rather than whatever synthesis produced.
      assert.ok(h.spoken[0]?.startsWith("Salt-crusted braids"));
      assert.ok(h.spoken.at(-1)?.includes("radio"));
    } finally {
      await h.provider.close();
    }
  });

  it("drops a block with nothing in it rather than refusing the page", async () => {
    const h = await harness();
    try {
      // Ines has no Appearance written yet; her Essence is still worth hearing.
      await h.send({
        kind: "read-sheet-page",
        worldId: WORLD_ID,
        requestId: "01J8F3K2QW9VZX4N7M0RTYB6P2",
        sheetId: "ines-half-hitch",
        sections: ["Essence", "Appearance"],
      });

      const ready = reads(h.events).filter((event) => event.status === "ready");
      assert.ok(ready.length >= 1);
      assert.equal(ready[0]!.sectionHeading, "Essence");
      assert.ok(!reads(h.events).some((event) => event.status === "failed"));
    } finally {
      await h.provider.close();
    }
  });
});
