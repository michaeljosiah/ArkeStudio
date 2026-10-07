import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChapterAudiobookSchema,
  audiobookBlockPlan,
  audiobookSeamHash,
  type AudiobookSeamAnchor,
  type ChapterAudiobook,
  type ChapterVoices,
  type ClientMessage,
  type DomainEvent,
  type ManifestModel,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { planAudiobook, readAudiobook, writeAudiobook } from "../../src/productions/audiobook.js";
import { AUDIOBOOK_OWN_LOOKS_SCHEMA_VERSION, AUDIOBOOK_SEAMS_SCHEMA_VERSION, CAST_PARAGRAPHS_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta, SUPPORTED_SCHEMA_VERSION } from "../../src/world/scan.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Block seams (design turn 198, SPEC-047 R-147..R-152): Join, Split and Reset are commands on the
 * chapter's audiobook record. Nothing is read and nothing deleted: a block whose shape changed is
 * not read until the chapter is, and a block put back finds its old take by its key and its
 * words, made again at no cost.
 */
const CLOCK = "2026-10-05T09:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const SPAN = "kept in a hand that changes every generation";
const KOKORO: ManifestModel = {
  id: "kokoro-82m",
  provider: "kokoro",
  capability: "voice-tts",
  displayName: "Kokoro",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "wav" },
  pricing: { kind: "unmetered" },
  cadence: { deliveries: ["measured", "urgent"], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none", deliveryMappings: { measured: { settings: { speed: 0.92 } }, urgent: { settings: { speed: 1.15 } } } },
};
const castRecord = (hash: string): ChapterVoices => ({ version: 4, hash, derivedAt: CLOCK, passes: 1, dropped: 0, omitted: 0, lines: [{ speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: SPAN }] });

function wav(): Uint8Array {
  const out = Buffer.alloc(44 + 16);
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
  out.writeUInt32LE(16, 40);
  return new Uint8Array(out);
}

type Recorded = Extract<DomainEvent, { type: "audiobook.record" }>;

async function withHarness(
  run: (h: { worldDir: string; store: WorldStore; events: DomainEvent[]; spoken: string[]; send: (message: ClientMessage) => Promise<void>; coordinator: Coordinator }) => Promise<void>,
): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  const castDir = join(worldDir, "productions", LEDGER, ".voices");
  await mkdir(castDir, { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore!()!;
  const chapter = store.getBundle().productions.find((p) => p.meta.id === LEDGER)?.chapters.find((c) => c.id === "neap");
  assert.ok(chapter?.bodyHash);
  await writeFile(join(castDir, "01-neap.json"), JSON.stringify(castRecord(chapter.bodyHash)), "utf8");
  await store.reload();
  const events: DomainEvent[] = [];
  const spoken: string[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-05", models: [KOKORO] },
    observeEvent: (event) => events.push(event),
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async (request: { text: string }) => {
          spoken.push(request.text);
          return wav();
        },
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [],
      hostedReaders: [],
    },
  });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, store: provider.openStore!()!, events, spoken, send, coordinator });
  } finally {
    await provider.close();
  }
}

const NARRATOR = { provider: "kokoro", model: KOKORO.id, voiceId: "bm_george" };
const read = (send: (message: ClientMessage) => Promise<void>) => send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
const seam = (send: (message: ClientMessage) => Promise<void>, press: "join" | "split", anchor: AudiobookSeamAnchor) => send({ kind: "set-audiobook-seam", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", press, anchor });
const reset = (send: (message: ClientMessage) => Promise<void>) => send({ kind: "reset-audiobook-seams", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
const lastRecord = (events: DomainEvent[]) => events.filter((e): e is Recorded => e.type === "audiobook.record").at(-1)!;
const plan = (store: WorldStore) => planAudiobook(store, LEDGER, "neap", { narrator: NARRATOR });
/** The gap a press there would name: a Join under a block, or a Split after a row of one. */
const gapAt = async (store: WorldStore, press: "join" | "split", block: string, row?: number) => {
  const gap = (await plan(store)).seams.gaps.find((candidate) => candidate.press === press && candidate.block === block && (row === undefined || candidate.row === row));
  assert.ok(gap?.anchor, `a ${press} at ${block}`);
  return gap.anchor;
};

describe("Join, Split and Reset (design turn 198)", () => {
  it("a join marks one block not read, the neighbours keep their takes, and Reset finds the old takes again at no cost", () =>
    withHarness(async ({ worldDir, store, events, spoken, send }) => {
      await read(send);
      const made = (await readAudiobook(store, LEDGER, "01-neap")) as ChapterAudiobook;
      const firstTakes = Object.fromEntries(Object.entries(made.takes).map(([key, take]) => [key, take.artifactId]));
      assert.ok(firstTakes["p1.0"] && firstTakes["p2.0"]);

      await seam(send, "join", await gapAt(store, "join", "p2.0"));
      const joined = lastRecord(events);
      assert.equal(joined.refused, undefined);
      assert.equal(joined.record?.seams?.length, 1);
      assert.equal(store.getBundle().meta.schemaVersion, AUDIOBOOK_SEAMS_SCHEMA_VERSION, "the world raised before the first record with a seam");
      const after = await plan(store);
      assert.deepEqual(after.blocks.filter((planned) => planned.state !== "made").map((planned) => [planned.block.key, planned.state]), [["p1.0", "not made"]], "the joined block is not read; nothing else moved");
      assert.equal(after.blocks.some((planned) => planned.block.key === "p2.0"), false);
      assert.deepEqual(Object.keys(joined.record!.takes).sort(), Object.keys(firstTakes).sort(), "nothing is deleted");

      // Read the chapter: only the joined block is read.
      const before = spoken.length;
      await read(send);
      assert.equal(spoken.length, before + 1);
      assert.notEqual(((await readAudiobook(store, LEDGER, "01-neap")) as ChapterAudiobook).takes["p1.0"]!.artifactId, firstTakes["p1.0"]);

      // Reset: one block a paragraph again, each finding its old take by key and words, nothing read.
      await reset(send);
      const back = lastRecord(events);
      assert.equal(back.refused, undefined);
      assert.equal(back.record?.seams, undefined);
      assert.equal(spoken.length, before + 1, "nothing read on Reset");
      assert.equal(back.record!.takes["p1.0"]!.artifactId, firstTakes["p1.0"], "the old take found again");
      assert.ok((await plan(store)).blocks.every((planned) => planned.state === "made"), "made again, no price");
      const onDisk = ChapterAudiobookSchema.parse(JSON.parse(await readFile(join(worldDir, "productions", LEDGER, ".audiobook", "chapters", "01-neap.json"), "utf8")));
      assert.equal("seams" in onDisk, false, "a record with no seam is written without the field");
    }));

  it("splits a block between its lines, and the opposite press on the same seam undoes it", () =>
    withHarness(async ({ store, events, send }) => {
      const anchor = await gapAt(store, "split", "p0.0", 1);
      await seam(send, "split", anchor);
      assert.equal(lastRecord(events).record?.seams?.[0]?.kind, "split");
      const split = await plan(store);
      assert.deepEqual(split.blocks.slice(1, 3).map((planned) => planned.block.key), ["p0.0", "p0.1"]);
      assert.equal(split.blocks[2]!.block.text.startsWith("and a form"), true);
      assert.equal(split.seams.changed, 2);
      // Join on the same gap, now between two blocks: the split is taken away, not a join added.
      await seam(send, "join", anchor);
      assert.equal(lastRecord(events).record?.seams, undefined);
      assert.equal((await plan(store)).seams.changed, 0);
    }));

  it("refuses words changed since the press was drawn, a press the gap does not offer, and a change while the book is read", () =>
    withHarness(async ({ store, events, send, coordinator }) => {
      const anchor = await gapAt(store, "join", "p2.0");
      await seam(send, "join", { ...anchor, textHash: audiobookSeamHash("other", "words") });
      assert.equal(lastRecord(events).refused, "the words changed · look again");
      await seam(send, "split", anchor);
      assert.equal(lastRecord(events).refused, "that seam changed · look again");
      (coordinator as unknown as { readingBooks: Map<string, unknown> }).readingBooks.set(`${WORLD_ID}/${LEDGER}`, {});
      await seam(send, "join", anchor);
      assert.equal(lastRecord(events).refused, "reading · seams wait until it ends");
      assert.equal(((await readAudiobook(store, LEDGER, "01-neap")) ?? null) === null || ((await readAudiobook(store, LEDGER, "01-neap")) as ChapterAudiobook).seams === undefined, true, "nothing written");
    }));

  it("keeps the blocks a join took in their own directions, and directs the joined block from them", () =>
    withHarness(async ({ store, events, send }) => {
      await send({ kind: "set-audiobook-block", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p1.0", direction: { delivery: "urgent", speed: 1, cues: [] } });
      await seam(send, "join", await gapAt(store, "join", "p2.0"));
      const joined = (await plan(store)).blocks.find((planned) => planned.block.key === "p1.0")!;
      const record = lastRecord(events).record!;
      assert.equal(audiobookBlockPlan(record, joined.block)?.delivery, "urgent", "the first block's delivery");
      // A direction written on another block carries every other entry on as it stands.
      await send({ kind: "set-audiobook-block", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p3.0", direction: { delivery: "measured", speed: 1, cues: [] } });
      const kept = lastRecord(events).record!;
      assert.equal(kept.direction["p1.0"]?.textHash, record.direction["p1.0"]?.textHash, "the first block's own entry, not rewritten for the joined words");
      await reset(send);
      assert.equal(lastRecord(events).record!.direction["p1.0"]?.plan.delivery, "urgent");
    }));
});

describe("the world boundary for seams (schema 66)", () => {
  it("is above the looks for one picture, and below the cast's paragraph hashes this build also reads", () => {
    assert.equal(AUDIOBOOK_SEAMS_SCHEMA_VERSION, 66);
    assert.equal(AUDIOBOOK_SEAMS_SCHEMA_VERSION, AUDIOBOOK_OWN_LOOKS_SCHEMA_VERSION + 1);
    // Part B of the same turn (the cast's paragraph hashes) takes the next number.
    assert.equal(CAST_PARAGRAPHS_SCHEMA_VERSION, AUDIOBOOK_SEAMS_SCHEMA_VERSION + 1);
    // A character's narration (design turn 200) took the number after it; this build reads both.
    assert.ok(SUPPORTED_SCHEMA_VERSION >= CAST_PARAGRAPHS_SCHEMA_VERSION);
  });

  it("raises the world before the first record with a seam, and an older build is then refused by name", async () => {
    const { root, worldDir } = await makeTempRoot();
    await mkdir(join(worldDir, "productions", LEDGER, ".audiobook"), { recursive: true });
    const provider = new FsWorldProvider(root, { clock: () => CLOCK });
    await provider.loadWorld(WORLD_ID);
    try {
      const store = provider.openStore!()!;
      const bare: ChapterAudiobook = { schemaVersion: 1, chapterVersion: 1, hash: "h", updatedAt: CLOCK, takes: {}, flags: {}, direction: {}, seams: [] };
      await writeAudiobook(store, LEDGER, "01-neap", bare);
      assert.equal(store.getBundle().meta.schemaVersion < AUDIOBOOK_SEAMS_SCHEMA_VERSION, true, "an empty list raises nothing");
      await writeAudiobook(store, LEDGER, "01-neap", { ...bare, seams: [{ kind: "join", before: { paragraph: 1, turn: 0 }, after: { paragraph: 2, turn: 0 }, textHash: "seam-v1:x", at: CLOCK }] });
      assert.equal(store.getBundle().meta.schemaVersion, AUDIOBOOK_SEAMS_SCHEMA_VERSION);
      const held = await readAudiobook(store, LEDGER, "01-neap");
      assert.ok(held !== null && held !== "unreadable");
      assert.equal(held.seams?.length, 1, "the seam reads back");
      await assert.rejects(readWorldMeta(worldDir, { supports: AUDIOBOOK_SEAMS_SCHEMA_VERSION - 1 }), /newer|schema|version/i);
    } finally {
      await provider.close();
    }
  });
});
