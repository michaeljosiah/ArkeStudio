import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChapterVoices, ClientMessage, DomainEvent, ManifestModel } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { planAudiobook, readAudiobook } from "../../src/productions/audiobook.js";
import { beatsPromptFor, type BeatsDeriver, type BeatsDeriverInput } from "../../src/productions/audiobook-beats.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Group by beats (SPEC-047 R-172): the director names where each beat of a chapter begins, and the
 * blocks of a beat are joined by the chapter's seams — a beat one block, one read, one direction.
 */
const CLOCK = "2026-10-08T09:00:00.000Z";
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
const NARRATOR = { provider: "kokoro", model: KOKORO.id, voiceId: "bm_george" };
const castRecord = (hash: string): ChapterVoices => ({ version: 4, hash, derivedAt: CLOCK, passes: 1, dropped: 0, omitted: 0, lines: [{ speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: SPAN }] });
type Beats = Extract<DomainEvent, { type: "audiobook.beats" }>;

async function withHarness(
  beatsDeriver: BeatsDeriver | undefined,
  run: (h: { worldDir: string; store: WorldStore; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void> }) => Promise<void>,
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
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-08", models: [KOKORO] },
    observeEvent: (event) => events.push(event),
    ...(beatsDeriver !== undefined ? { beatsDeriver } : {}),
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async () => new Uint8Array(),
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
    await run({ worldDir, store: provider.openStore!()!, events, send });
  } finally {
    await provider.close();
  }
}

const group = (send: (message: ClientMessage) => Promise<void>) => send({ kind: "group-chapter-beats", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
const lastBeats = (events: DomainEvent[]) => events.filter((e): e is Beats => e.type === "audiobook.beats").at(-1)!;
const plan = (store: WorldStore) => planAudiobook(store, LEDGER, "neap", { narrator: NARRATOR });

describe("Group by beats (SPEC-047 R-172)", () => {
  it("asks the director for beats over the chapter's blocks, joins each beat into one block and says how many there were and are", async () => {
    const asked: BeatsDeriverInput[] = [];
    const deriver: BeatsDeriver = async (input) => {
      asked.push(input);
      const keys = input.blocks.map((block) => block.key);
      // Two beats, the second from the third block, and one key the chapter does not hold.
      return { beats: [{ start: keys[0]!, name: "The ledger", whose: "Maren" }, { start: keys[2]!, name: "The correction", whose: "Maren" }, { start: "p99.0" }], summary: "From the routine to the stroke." };
    };
    await withHarness(deriver, async ({ store, events, send }) => {
      const before = await plan(store);
      assert.ok(before.blocks.length >= 4, "the fixture chapter has a block a paragraph");
      await group(send);
      const beats = lastBeats(events);
      assert.equal(beats.outcome, "grouped", beats.reason);
      assert.equal(beats.before, before.blocks.length);
      assert.equal(beats.after, 3, "the title and two beats");
      assert.deepEqual(beats.beats?.map((beat) => [beat.name, beat.whose]), [["The ledger", "Maren"], ["The correction", "Maren"]]);
      assert.equal(beats.dropped, 1, "the key the chapter does not hold is dropped and counted");
      assert.equal(beats.summary, "From the routine to the stroke.");
      const after = await plan(store);
      assert.equal(after.blocks.length, 3);
      assert.ok(after.blocks.slice(1).every((planned) => planned.block.shaped === true));
      const record = await readAudiobook(store, LEDGER, "01-neap");
      assert.ok(record !== null && record !== "unreadable");
      assert.equal(record.seams?.length, before.blocks.length - 3, "a join between every two blocks of a beat");
      assert.ok(events.some((event) => event.type === "audiobook.record" && event.record !== undefined), "the record answered to every window");
      // The director was shown every block once, each with its key and its speakers.
      assert.equal(asked.length, 1);
      assert.deepEqual(asked[0]!.blocks.map((block) => block.key), before.blocks.slice(1).map((planned) => planned.block.key));
      assert.equal(asked[0]!.blocks[0]!.speakers, "Maren Kest");
      const prompt = beatsPromptFor(asked[0]!);
      assert.match(prompt, /A beat is the stretch where one character's intention and the pressure of the scene hold/);
      assert.match(prompt, /\[p0\.0\] narration with lines spoken by Maren Kest/);
      // Grouping again starts from the automatic blocks: the seams are replaced, not added to.
      await group(send);
      const again = await readAudiobook(store, LEDGER, "01-neap");
      assert.ok(again !== null && again !== "unreadable");
      assert.equal(again.seams?.length, record.seams?.length);
    });
  });

  it("is refused under Cast, where each voice is read apart, and writes nothing", async () => {
    let asked = 0;
    await withHarness(async () => { asked += 1; return { beats: [] }; }, async ({ worldDir, store, events, send }) => {
      await mkdir(join(worldDir, "productions", LEDGER, ".audiobook"), { recursive: true });
      await writeFile(join(worldDir, "productions", LEDGER, ".audiobook", "book.json"), JSON.stringify({ schemaVersion: 1, reading: "cast" }), "utf8");
      await store.reload();
      await group(send);
      const beats = lastBeats(events);
      assert.equal(beats.outcome, "refused");
      assert.match(beats.reason ?? "", /Cast reads each voice apart/);
      assert.equal(asked, 0);
      assert.equal(await readAudiobook(store, LEDGER, "01-neap"), null);
    });
  });

  it("says the writing service is not running when there is no director", async () => {
    await withHarness(undefined, async ({ events, send }) => {
      await group(send);
      assert.equal(lastBeats(events).outcome, "unavailable");
    });
  });
});
