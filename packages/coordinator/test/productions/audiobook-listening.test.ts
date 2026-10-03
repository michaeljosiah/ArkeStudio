import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AudiobookListeningSchema,
  ChapterAudiobookSchema,
  type ClientMessage,
  type DomainEvent,
  type ManifestModel,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AUDIOBOOK_PICTURES_SCHEMA_VERSION } from "../../src/world/commit.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * The book as a listener hears it (design turn 186, SPEC-047 R-57..R-64): the plan the player
 * plays — every chapter in order, a chapter read in part playing its made blocks around its gaps,
 * a chapter not read listed and held — and a picture set on a block, written into the chapter's
 * record past the build before pictures.
 */
const CLOCK = "2026-10-03T09:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const KOKORO: ManifestModel = {
  id: "kokoro-82m",
  provider: "kokoro",
  capability: "voice-tts",
  displayName: "Kokoro",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "wav" },
  pricing: { kind: "unmetered" },
};

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

type Listening = Extract<DomainEvent, { type: "audiobook.listening" }>;
type RecordEvent = Extract<DomainEvent, { type: "audiobook.record" }>;

async function withHarness(run: (h: { worldDir: string; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void>; schemaVersion: () => number }) => Promise<void>): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-03", models: [KOKORO] },
    observeEvent: (event) => events.push(event),
    mediaProbe: { durationSec: async () => 3, info: async () => ({ durationSec: 3, hasAudio: true }) },
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async () => wav(),
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [],
      hostedReaders: [],
    },
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, events, send, schemaVersion: () => provider.openStore!()!.getBundle().meta.schemaVersion });
  } finally {
    await provider.close();
  }
}

const REQUEST = "01J00000000000000000000001";
const read = (send: (message: ClientMessage) => Promise<void>, chapterFile: string, blocks?: string[]) =>
  send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile, ...(blocks !== undefined ? { blocks } : {}) });
async function listen(send: (message: ClientMessage) => Promise<void>, events: DomainEvent[]): Promise<Listening> {
  await send({ kind: "open-audiobook-listening", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST });
  const answer = events.filter((e): e is Listening => e.type === "audiobook.listening").at(-1);
  assert.ok(answer, "the listening plan is answered");
  return answer;
}

describe("the book as a listener hears it (turn 186)", () => {
  it("lists every chapter in order: one read whole, one read in part around its gap, one not read between read ones", () =>
    withHarness(async ({ events, send }) => {
      await read(send, "01-neap");
      // Chapter 2 in part: its title and its first paragraph only.
      await read(send, "02-the-same-ink", ["title", "p0.0"]);
      await read(send, "04-her-own-hand");
      const answer = await listen(send, events);
      assert.equal(answer.refused, undefined);
      const listening = AudiobookListeningSchema.parse(answer.listening);
      assert.deepEqual(listening.chapters.map((chapter) => [chapter.order, chapter.state]), [[1, "read"], [2, "part"], [3, "not read"], [4, "read"]]);
      assert.equal(listening.cover, "world-art.png", "the world's key art is the book's cover");

      const neap = listening.chapters[0]!;
      assert.equal(neap.gaps.length, 0);
      assert.equal(neap.blocks[0]!.key, "title", "the title first");
      assert.equal(neap.seconds, neap.blocks.length * 3, "the takes back to back, nothing added");
      assert.ok(neap.blocks.every((block, index) => block.at === index * 3 && block.file.startsWith("artifacts/")));
      assert.ok(neap.blocks.every((block) => block.artifactId !== undefined), "each block's take by its artifact, for a timing layer to address");
      assert.equal(neap.opening, "world-art.png", "no picture on its opening block: the cover");

      const part = listening.chapters[1]!;
      assert.deepEqual(part.blocks.map((block) => block.key), ["title", "p0.0"]);
      assert.equal(part.gaps.length, 1);
      assert.equal(part.gaps[0]!.from, 3, "the gap starts after the made blocks");
      assert.equal(part.gaps[0]!.at, 6, "where the clock stands when it is reached");

      const unread = listening.chapters[2]!;
      assert.equal(unread.seconds, 0);
      assert.deepEqual(unread.blocks, [], "listed and held, nothing to play");
    }));

  it("sets a picture on a block past the build before pictures, places it on the clock, and takes it off again", () =>
    withHarness(async ({ worldDir, events, send, schemaVersion }) => {
      await read(send, "01-neap");
      assert.ok(schemaVersion() < AUDIOBOOK_PICTURES_SCHEMA_VERSION);
      const set = (block: string, picture: { file: string; source: "world" | "cast" | "scenes" | "generated" } | null) =>
        send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block, picture, requestId: REQUEST });
      const answer = () => events.filter((e): e is RecordEvent => e.type === "audiobook.record").at(-1)!;

      await set("p1.0", { file: "world-art.png", source: "world" });
      assert.equal(answer().refused, undefined);
      assert.equal(answer().record?.pictures?.["p1.0"]?.file, "world-art.png");
      assert.equal(schemaVersion(), AUDIOBOOK_PICTURES_SCHEMA_VERSION, "raised before the first pictured record");
      const onDisk = ChapterAudiobookSchema.parse(JSON.parse(await readFile(join(worldDir, "productions", LEDGER, ".audiobook", "chapters", "01-neap.json"), "utf8")));
      assert.equal(onDisk.pictures?.["p1.0"]?.source, "world");

      const listening = AudiobookListeningSchema.parse((await listen(send, events)).listening);
      const neap = listening.chapters[0]!;
      const placed = neap.pictures[0]!;
      assert.equal(placed.key, "p1.0");
      assert.equal(placed.number, 3);
      assert.equal(placed.at, neap.blocks.find((block) => block.key === "p1.0")!.at);
      assert.equal(placed.seconds, neap.seconds - placed.at, "holds to the chapter's end");

      await set("p0.0", { file: "../outside.png", source: "world" });
      assert.match(answer().refused ?? "", /not in this world/, "only a picture the world holds");

      await set("p1.0", null);
      assert.equal(answer().record?.pictures, undefined);
      const raw = JSON.parse(await readFile(join(worldDir, "productions", LEDGER, ".audiobook", "chapters", "01-neap.json"), "utf8")) as Record<string, unknown>;
      assert.equal("pictures" in raw, false, "a record with none is written without the field");
    }));

  it("refuses a block the chapter no longer has", () =>
    withHarness(async ({ events, send }) => {
      await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block: "p999.0", picture: { file: "world-art.png", source: "world" } });
      const answer = events.filter((e): e is RecordEvent => e.type === "audiobook.record").at(-1);
      assert.match(answer?.refused ?? "", /no longer in the chapter/);
    }));
});
