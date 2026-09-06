import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chapterParagraphs, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { MarkdownFile } from "../../src/world/text-files.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * The chapter through the coordinator (design turn 126, issue 874): opened on demand, saved
 * against the base it read, made by a press, and read aloud a paragraph at a time. The words
 * never travel for the read — every source is an address the coordinator resolves off disk.
 */
const CLOCK = "2026-09-06T12:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const REQUEST = "01J8F3K2QW9VZX4N7M0RTYB6H";

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

type Harness = {
  worldDir: string;
  events: DomainEvent[];
  spoken: string[];
  send: (message: ClientMessage) => Promise<void>;
  /** When set, every synthesis waits on it: a read can be caught between blocks. */
  gate: { hold: Promise<void> | null };
};

/** Every test closes what it opened: an open WorldStore's watchers keep the runner alive. */
async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const spoken: string[] = [];
  const gate: { hold: Promise<void> | null } = { hold: null };
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
          if (gate.hold) await gate.hold;
          return wav();
        },
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [],
    },
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  try {
    await run({ worldDir, events, spoken, send, gate });
  } finally {
    await provider.close();
  }
}

const requestId = (n: number) => `${REQUEST}${n}`;
type Opened = Extract<DomainEvent, { type: "chapter.open-result" }>;
type Saved = Extract<DomainEvent, { type: "chapter.save-result" }>;
type Made = Extract<DomainEvent, { type: "chapter.create-result" }>;
type Audio = Extract<DomainEvent, { type: "voice.audio" }>;
const last = <T extends DomainEvent>(events: DomainEvent[], type: T["type"]): T =>
  events.filter((e) => e.type === type).at(-1) as T;

describe("the chapter through the coordinator (turn 126)", () => {
  it("open answers the body it read, and a save answers the base the next save must name", () =>
    withHarness(async ({ events, send }) => {
      await send({ kind: "open-chapter", requestId: requestId(1), worldId: WORLD_ID, productionId: LEDGER, chapterId: "neap" });
      const opened = last<Opened>(events, "chapter.open-result");
      assert.equal(opened.disposition, "opened");
      assert.equal(opened.version, 4);
      assert.match(opened.body ?? "", /The ledger of the Vigil/);
      assert.match(opened.hash ?? "", /^sha256:/);

      await send({
        kind: "save-chapter",
        requestId: requestId(2),
        worldId: WORLD_ID,
        productionId: LEDGER,
        chapterFile: "01-neap",
        body: "Rewritten.\n\nTwo.",
        baseHash: opened.hash!,
      });
      const saved = last<Saved>(events, "chapter.save-result");
      assert.equal(saved.requestId, requestId(2));
      assert.equal(saved.disposition, "saved");
      assert.equal(saved.version, 4, "a direct save keeps the version");
      assert.notEqual(saved.hash, opened.hash);

      // The editor that still holds the first base is refused by name, and nothing is written.
      await send({
        kind: "save-chapter",
        requestId: requestId(3),
        worldId: WORLD_ID,
        productionId: LEDGER,
        chapterFile: "01-neap",
        body: "Overwritten.",
        baseHash: opened.hash!,
      });
      const refused = last<Saved>(events, "chapter.save-result");
      assert.equal(refused.requestId, requestId(3));
      assert.equal(refused.disposition, "refused");
      await send({ kind: "open-chapter", requestId: requestId(4), worldId: WORLD_ID, productionId: LEDGER, chapterId: "neap" });
      const reopened = last<Opened>(events, "chapter.open-result");
      assert.equal(reopened.body?.trim(), "Rewritten.\n\nTwo.");
      assert.equal(reopened.hash, saved.hash);
    }));

  it("a chapter that is gone is refused by name rather than answered with the wrong one", () =>
    withHarness(async ({ events, send }) => {
      await send({ kind: "open-chapter", requestId: requestId(5), worldId: WORLD_ID, productionId: LEDGER, chapterId: "no-such" });
      const failed = last<Opened>(events, "chapter.open-result");
      assert.equal(failed.disposition, "failed");
      assert.match(failed.reason ?? "", /no longer in this production/);
    }));

  it("New chapter is answered with the id it made, so the press can open it", () =>
    withHarness(async ({ events, send }) => {
      await send({ kind: "create-chapter", requestId: requestId(6), worldId: WORLD_ID, productionId: LEDGER, title: "Untitled", order: 5 });
      const made = last<Made>(events, "chapter.create-result");
      assert.equal(made.disposition, "created");
      assert.equal(made.chapterId, "untitled");
      await send({ kind: "open-chapter", requestId: requestId(7), worldId: WORLD_ID, productionId: LEDGER, chapterId: "untitled" });
      const opened = last<Opened>(events, "chapter.open-result");
      assert.equal(opened.disposition, "opened");
      assert.equal(opened.body, "");
      assert.equal(opened.version, 1);
    }));

  it("reads a chapter as a page, one part per paragraph, off the saved file", () =>
    withHarness(async ({ worldDir, events, spoken, send }) => {
      const raw = await readFile(join(worldDir, "productions", LEDGER, "chapters", "01-neap.md"), "utf8");
      const paragraphs = chapterParagraphs(MarkdownFile.parse(raw).body);
      assert.ok(paragraphs.length >= 3, "the fixture chapter has paragraphs to position by");

      await send({
        kind: "read-prose-page",
        requestId: requestId(8),
        worldId: WORLD_ID,
        sources: [0, 1, 2].map((paragraph) => ({ of: "chapter" as const, productionId: LEDGER, chapterId: "neap", paragraph })),
      });
      const parts = events.filter(
        (e): e is Audio => e.type === "voice.audio" && e.requestId === requestId(8) && e.status === "ready",
      );
      assert.equal(parts.length, 3, "three sources, three parts");
      assert.deepEqual(
        parts.map((p) => p.sectionHeading),
        [1, 2, 3].map((n) => `Neap · ${n} of ${paragraphs.length}`),
      );
      assert.deepEqual(parts.map((p) => [p.part, p.parts]), [[0, 3], [1, 3], [2, 3]]);
      assert.equal(spoken.length, 3);
      assert.ok(spoken[0]!.startsWith("The ledger of the Vigil"), "the first part is the first paragraph, off disk");
      assert.ok(spoken[1]!.startsWith("Maren has the 1820 volume"), "the second part is the second paragraph");
    }));

  it("Stop ends a long read at the next paragraph rather than after the last (codex, PR 879)", () =>
    withHarness(async ({ events, spoken, send, gate }) => {
      let release = () => {};
      gate.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = send({
        kind: "read-prose-page",
        requestId: requestId(1),
        worldId: WORLD_ID,
        sources: [0, 1, 2].map((paragraph) => ({ of: "chapter" as const, productionId: LEDGER, chapterId: "neap", paragraph })),
      });
      // The first block is being made; the stop arrives while it is.
      while (spoken.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      await send({ kind: "stop-prose-page", worldId: WORLD_ID, requestId: requestId(1) });
      release();
      await reading;
      const parts = events.filter(
        (e): e is Audio => e.type === "voice.audio" && e.requestId === requestId(1) && e.status === "ready",
      );
      assert.equal(spoken.length, 1, "nothing after the block in flight was synthesised");
      assert.equal(parts.length, 1);
    }));

  it("a paragraph past the saved chapter drops out of the page rather than reading the wrong words", () =>
    withHarness(async ({ events, spoken, send }) => {
      await send({
        kind: "read-prose-page",
        requestId: requestId(9),
        worldId: WORLD_ID,
        sources: [
          { of: "chapter", productionId: LEDGER, chapterId: "neap", paragraph: 0 },
          { of: "chapter", productionId: LEDGER, chapterId: "neap", paragraph: 999 },
        ],
      });
      const parts = events.filter(
        (e): e is Audio => e.type === "voice.audio" && e.requestId === requestId(9) && e.status === "ready",
      );
      assert.equal(parts.length, 1);
      assert.equal(spoken.length, 1);
    }));
});
