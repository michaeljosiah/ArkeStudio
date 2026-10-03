import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AudiobookBookSchema,
  ChapterAudiobookSchema,
  type ChapterVoices,
  type ClientMessage,
  type DomainEvent,
  type ManifestModel,
} from "@arke-studio/contracts";
import { geminiSpeechModel } from "@arke-studio/providers";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import {
  DIRECTION_CONTEXT_BOUNDS,
  directionPromptFor,
  renderDirectionContext,
  spokenAt,
  verifyDirections,
  type DirectableBlock,
  type DirectionDeriver,
  type DirectionDeriverInput,
  type SpeakerNotesDeriver,
} from "../../src/productions/audiobook-direction.js";
import { prepareChapter } from "../../src/productions/audiobook-run.js";
import type { VoicesDeriver } from "../../src/productions/voices.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * The director reads the book (design turn 184, SPEC-047 R-51..R-55): `Direct this chapter`
 * given what the reading is about, writing turn 181's direction, a book note and a chapter note
 * sent with every block, the lines cast first in the same proposal, speaker notes drafted from
 * the sheets and never over the author's, and a block heard as it would be sent before the
 * proposal is accepted.
 */
const CLOCK = "2026-10-03T09:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const SPAN = "kept in a hand that changes every generation";
const REQUEST = "01J8F3K2QW9VZX4N7M0RTYB6H4";
const KOKORO: ManifestModel = {
  id: "kokoro-82m",
  provider: "kokoro",
  capability: "voice-tts",
  displayName: "Kokoro",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "wav" },
  pricing: { kind: "unmetered" },
  cadence: { deliveries: ["measured", "urgent"], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none",
    deliveryMappings: { measured: { settings: { speed: 0.92 } }, urgent: { settings: { speed: 1.15 } } } },
};
const GEMINI = geminiSpeechModel("flash");
/** Eleven v3 as a tag reader: a note to sixty as a tag, sounds in square brackets. */
const V3: ManifestModel = {
  id: "eleven-v3",
  provider: "elevenlabs",
  capability: "voice-tts",
  displayName: "Eleven v3",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "mp3" },
  pricing: { kind: "perCharacter", microUsdPerCharacter: 100 },
  cadence: {
    deliveries: ["measured", "whispered", "breaking", "cold", "warm", "urgent"],
    speed: { min: 0.7, max: 1.2 },
    pause: "best-effort-audio-tag",
    emphasis: "best-effort-capitalization",
    breath: "best-effort-audio-tag",
    outputTimestamps: "none",
    phrase: "best-effort-tag",
    sounds: { sighs: "sighs", laughs: "laughs", chuckles: "chuckles" },
    deliveryMappings: { measured: { settings: { stability: 0.5 } }, whispered: { settings: { stability: 0.5 }, tag: "whispers" }, warm: { settings: { stability: 0.5 }, tag: "warmly" } },
  },
};
const castRecord = (hash: string): ChapterVoices => ({
  version: 4,
  hash,
  derivedAt: CLOCK,
  passes: 1,
  dropped: 0,
  omitted: 0,
  lines: [{ speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: SPAN }],
});
const BOOK_NOTE = "English as the harbour speaks it, unhurried and close. Old words said plainly, never quaintly.";
const CHAPTER_NOTE = "Night at the rail desk, the binding failing; quiet, then a cold turn when the correction is read.";

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

type Directed = Extract<DomainEvent, { type: "direction.finished" }>;
type Recorded = Extract<DomainEvent, { type: "audiobook.record" }>;
type Finished = Extract<DomainEvent, { type: "audiobook.finished" }>;

async function withDirector(
  input: {
    direction?: DirectionDeriver;
    voices?: VoicesDeriver;
    speakerNotes?: SpeakerNotesDeriver;
    /** Edits to the world's copy before it is loaded. */
    before?: (worldDir: string) => Promise<void>;
    /** No cast written beside chapter 01. */
    uncast?: boolean;
    book?: Record<string, unknown>;
  },
  run: (h: { worldDir: string; store: WorldStore; events: DomainEvent[]; spoken: string[]; send: (message: ClientMessage) => Promise<void> }) => Promise<void>,
): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await input.before?.(worldDir);
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore?.();
  assert.ok(store);
  const chapter = store.getBundle().productions.find((p) => p.meta.id === LEDGER)?.chapters.find((c) => c.id === "neap");
  assert.ok(chapter?.bodyHash);
  if (input.uncast !== true) {
    await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
    await writeFile(join(worldDir, "productions", LEDGER, ".voices", "01-neap.json"), JSON.stringify(castRecord(chapter.bodyHash)), "utf8");
  }
  if (input.book !== undefined) {
    await mkdir(join(worldDir, "productions", LEDGER, ".audiobook"), { recursive: true });
    await writeFile(join(worldDir, "productions", LEDGER, ".audiobook", "book.json"), JSON.stringify({ schemaVersion: 1, ...input.book }), "utf8");
  }
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
    manifest: { manifestVersion: 1, generated: "2026-10-03", models: [KOKORO] },
    observeEvent: (event) => events.push(event),
    ...(input.direction ? { directionDeriver: input.direction } : {}),
    ...(input.voices ? { voicesDeriver: input.voices } : {}),
    ...(input.speakerNotes ? { speakerNotesDeriver: input.speakerNotes } : {}),
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
    },
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, store, events, spoken, send });
  } finally {
    await provider.close();
  }
}

const bookPath = (worldDir: string) => join(worldDir, "productions", LEDGER, ".audiobook", "book.json");
const readBook = async (worldDir: string) => AudiobookBookSchema.parse(JSON.parse(await readFile(bookPath(worldDir), "utf8")));
const recordPath = (worldDir: string) => join(worldDir, "productions", LEDGER, ".audiobook", "chapters", "01-neap.json");
const schemaOf = async (worldDir: string) => (JSON.parse(await readFile(join(worldDir, "world.json"), "utf8")) as { schemaVersion: number }).schemaVersion;
const withPlan = (synopsis: string) => async (worldDir: string) => {
  const file = join(worldDir, "productions", LEDGER, "chapters", "01-neap.md");
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace("status: drafted\n", `status: drafted\nsynopsis: ${JSON.stringify(synopsis)}\npov: maren-kest\n`), "utf8");
};

describe("the director reads the book (design turn 184, SPEC-047 R-51)", () => {
  it("the prompt carries the synopsis, point of view, version, tone, speakers' sheets, narrator, notes and the chapter before, and nothing of it reaches a reader", () => {
    let asked: DirectionDeriverInput | undefined;
    return withDirector(
      {
        before: withPlan("Maren finds a correction in the 1820 ledger that should not be there."),
        book: { reading: "performed", note: BOOK_NOTE, chapterNotes: { neap: CHAPTER_NOTE }, notes: { "maren-kest": "low, clipped" } },
        direction: async (input) => {
          asked = input;
          return { blocks: input.blocks.map((block) => ({ block: block.key, delivery: "measured" })) };
        },
      },
      async ({ events, send, spoken }) => {
        await send({ kind: "direct-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
        const directed = events.find((e): e is Directed => e.type === "direction.finished");
        assert.equal(directed?.outcome, "directed", directed?.reason);
        assert.ok(asked?.context);
        const context = asked.context;
        assert.equal(context.chapter.synopsis, "Maren finds a correction in the 1820 ledger that should not be there.");
        assert.equal(context.chapter.pov, "Maren Kest", "the point of view by the sheet's name");
        assert.equal(context.chapter.version, 4);
        assert.equal(context.tone, "quiet dread", "the world's tone");
        assert.equal(context.bookNote, BOOK_NOTE);
        assert.equal(context.chapterNote, CHAPTER_NOTE);
        const maren = context.speakers.find((speaker) => speaker.key === "maren-kest");
        assert.ok(maren?.essence !== undefined && maren.voice !== undefined, "the speaker's essence and voice, from the sheet");
        assert.equal(maren.note, "low, clipped");
        assert.equal(context.before, null, "the first chapter has none before it");
        const line = asked.blocks.find((block) => block.speaker !== undefined);
        assert.equal(line?.speaker, "Maren Kest", "a spoken line says who speaks it");
        const prompt = directionPromptFor(asked);
        for (const fact of ["Synopsis: Maren finds", "Point of view: Maren Kest", "Tone: quiet dread", "Book note", "Chapter note", "Speaker Maren Kest [maren-kest]", "essence:", "\"note\""]) {
          assert.ok(prompt.includes(fact), `the prompt says ${fact}`);
        }
        assert.ok(!prompt.includes("\"phrase\": \"<optional: how to read it"), "the 60-character phrase is gone from a block");
        assert.equal(spoken.length, 0, "directing sends nothing to a voice");
      },
    );
  });

  it("the context is bounded: a long synopsis is cut at a word, a long sheet section too, and the whole stays under its cap", () => {
    let asked: DirectionDeriverInput | undefined;
    return withDirector(
      {
        before: withPlan(`${"The tide ".repeat(400)}end.`),
        direction: async (input) => {
          asked = input;
          return { blocks: [] };
        },
      },
      async ({ send }) => {
        await send({ kind: "direct-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
        assert.ok(asked?.context?.chapter.synopsis !== undefined);
        assert.ok(asked.context.chapter.synopsis.length <= DIRECTION_CONTEXT_BOUNDS.synopsis);
        assert.ok(asked.context.chapter.synopsis.endsWith("…"));
        for (const speaker of asked.context.speakers) assert.ok((speaker.essence?.length ?? 0) <= DIRECTION_CONTEXT_BOUNDS.section);
        const many = { ...asked.context, speakers: Array.from({ length: 40 }, (_, index) => ({ key: `s${index}`, name: `Speaker ${index}`, essence: "e".repeat(240), voice: "v".repeat(240) })) };
        assert.ok(renderDirectionContext(many).length <= DIRECTION_CONTEXT_BOUNDS.total, "the rendered context never runs past its cap");
      },
    );
  });

  it("the second chapter reads the last directed blocks of the first, and the Reads row says so before anything runs", () =>
    withDirector(
      { direction: async (input) => ({ blocks: input.blocks.map((block, index) => ({ block: block.key, delivery: index === 0 ? "urgent" : "measured" })) }) },
      async ({ events, send }) => {
        await send({ kind: "direct-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
        const first = events.find((e): e is Directed => e.type === "direction.finished")!;
        await send({ kind: "accept-direction", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", requestId: REQUEST, hash: first.hash!, directions: first.proposed! });
        assert.ok(events.find((e): e is Recorded => e.type === "audiobook.record")?.record);
        await send({ kind: "preview-direction", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "02-the-same-ink", requestId: REQUEST });
        const reads = events.find((e): e is Extract<DomainEvent, { type: "direction.reads" }> => e.type === "direction.reads");
        assert.ok(reads?.reads, reads?.refused);
        assert.equal(reads.reads.before?.order, 1);
        assert.ok((reads.reads.before?.blocks ?? 0) > 0, "the chapter before stands directed");
        assert.equal(reads.reads.tone, "quiet dread");
        assert.equal(reads.reads.narrator.label.length > 0, true);
        assert.deepEqual(reads.reads.notes, { book: false, chapter: false, speakers: 0 });
      },
    ));
});

describe("the director writes turn 181's direction (R-52)", () => {
  const narration: DirectableBlock = { key: "p0.0", text: "Ade laughed until his chest hurt. “The goat was in the boot,” he said.", reader: { provider: "google", model: GEMINI.id, voiceId: "Kore" }, model: GEMINI };
  const line: DirectableBlock = { key: "p1.0", text: "“Ade, I am telling you. The goat looked at me like this, like say na me get the car.”", reader: { provider: "google", model: GEMINI.id, voiceId: "Kore" }, model: GEMINI, line: true };

  it("a note to 300 on an instruction reader, sounds only in spoken lines and from the cadence list, a turn over a span", () => {
    const note = "mid-story, enjoying himself, half laughing, ".repeat(5).trim();
    assert.ok(note.length > 60 && note.length <= 300);
    const verified = verifyDirections(
      {
        blocks: [
          {
            block: "p0.0",
            delivery: "warm",
            cues: [
              { kind: "sound", after: "Ade laughed", sound: "laughs" },
              { kind: "sound", after: "was in the boot,”", sound: "chuckles" },
            ],
          },
          {
            block: "p1.0",
            delivery: "warm",
            note,
            cues: [
              { kind: "sound", after: "I am telling you.", sound: "chuckles" },
              { kind: "sound", after: "like this,", sound: "giggles" },
              { kind: "delivery", words: "like say na me get the car.", delivery: "whispered" },
              { kind: "pause", after: "like this,", length: "short" },
            ],
          },
        ],
      },
      [narration, line],
    );
    assert.equal(verified.directed, 2);
    const first = verified.proposed["p0.0"]!;
    assert.deepEqual(first.cues.map((cue) => cue.kind === "sound" && cue.sound), ["chuckles"], "the laugh in narration is dropped; the one right after the closing mark stands");
    const second = verified.proposed["p1.0"]!;
    assert.equal(second.note, note, "an instruction reader takes the note whole");
    assert.deepEqual(second.cues.map((cue) => cue.kind), ["sound", "pause", "delivery"], "the made-up sound is dropped; the turn is anchored to its words");
    const turn = second.cues.find((cue) => cue.kind === "delivery");
    assert.equal(turn?.kind === "delivery" ? turn.span.text : undefined, "like say na me get the car.");
    assert.equal(verified.dropped, 2, "the narration's laugh and the sound off the list, counted");
  });

  it("a tag reader takes a note to 60 only, and a reader that cannot make a sound has it dropped and counted", () => {
    const tagLine: DirectableBlock = { ...line, reader: { provider: "elevenlabs", model: V3.id, voiceId: "Rachel" }, model: V3 };
    const verified = verifyDirections(
      { blocks: [{ block: "p1.0", delivery: "warm", note: "x".repeat(80), cues: [{ kind: "sound", after: "I am telling you.", sound: "groans" }, { kind: "sound", after: "like this,", sound: "chuckles" }] }] },
      [tagLine],
    );
    assert.equal(verified.proposed["p1.0"]?.note, undefined, "a tag reader holds a note past sixty, so the card never proposes it");
    assert.deepEqual(verified.proposed["p1.0"]?.cues.map((cue) => cue.kind === "sound" && cue.sound), ["chuckles"]);
    assert.equal(verified.dropped, 2, "the long note and the sound the row does not make");
  });

  it("the words are never changed: an anchor that is not in the block, or is in it twice, is dropped", () => {
    const verified = verifyDirections({ blocks: [{ block: "p1.0", delivery: "measured", cues: [{ kind: "delivery", words: "the goat looked", delivery: "warm" }, { kind: "sound", after: "like", sound: "chuckles" }] }] }, [line]);
    assert.deepEqual(verified.proposed["p1.0"]?.cues, []);
    assert.equal(verified.dropped, 2, "a paraphrase of the words and an anchor held twice");
  });

  it("a point in narration is spoken only inside quotation marks or right after the closing one", () => {
    const text = "He said, “Not tonight.” Then he went.";
    assert.equal(spokenAt(text, text.indexOf("Then"), false), false);
    assert.equal(spokenAt(text, text.indexOf("”") + 1, false), true);
    assert.equal(spokenAt(text, text.indexOf("tonight"), false), true);
    assert.equal(spokenAt(text, 2, true), true, "anywhere in a line the cast names");
  });
});

describe("the book note and the chapter note (R-53)", () => {
  it("are written to the book record, raise the world first, lead Gemini's style before the block's own, and a tag reader holds a long one and tags a short one", () =>
    withDirector({}, async ({ worldDir, store, send }) => {
      const before = await schemaOf(worldDir);
      await send({ kind: "set-audiobook-reading-note", worldId: WORLD_ID, productionId: LEDGER, note: BOOK_NOTE });
      await send({ kind: "set-audiobook-reading-note", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", note: CHAPTER_NOTE });
      const book = await readBook(worldDir);
      assert.equal(book.note, BOOK_NOTE);
      assert.equal(book.chapterNotes?.["neap"], CHAPTER_NOTE, "keyed by the chapter's id");
      assert.ok((await schemaOf(worldDir)) >= 45 && before < 45, "a build that cannot read the notes refuses the world rather than losing them");

      // Gemini: both notes as sentences in the style, before the delivery's own sentence.
      const gemini = { narrator: { provider: "google", model: GEMINI.id, voiceId: "Kore", label: "Kore" }, models: [GEMINI], catalogue: [] };
      const prepared = await prepareChapter(store, LEDGER, "neap", gemini, () => CLOCK, ["title"], { directions: { title: { delivery: "warm", speed: 1, cues: [] } } });
      assert.equal(prepared.kind, "ready");
      if (prepared.kind !== "ready") return;
      const title = prepared.prepared.speaking.find((block) => block.block.key === "title")!;
      const style = title.direction?.perPart[0]?.instructions ?? "";
      assert.ok(style.startsWith(`${BOOK_NOTE} ${CHAPTER_NOTE}`), `the book note, then the chapter note, lead the style: ${style}`);
      assert.ok(style.endsWith("Read warmly and gently."), "then the block's own direction");
      assert.ok(!title.parts[0]!.includes(BOOK_NOTE), "never in the words a reader speaks");

      // A tag reader: the 94-character book note held; a chapter note short enough is a tag.
      await send({ kind: "set-audiobook-reading-note", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", note: "night, the rail desk, quiet" });
      const v3 = { narrator: { provider: "elevenlabs", model: V3.id, voiceId: "Rachel", label: "Rachel" }, models: [V3], catalogue: [] };
      const tagged = await prepareChapter(store, LEDGER, "neap", v3, () => CLOCK, ["title"], { directions: { title: { delivery: "warm", speed: 1, cues: [] } } });
      assert.equal(tagged.kind, "ready");
      if (tagged.kind !== "ready") return;
      const part = tagged.prepared.speaking[0]!.parts[0]!;
      assert.ok(part.startsWith("[night, the rail desk, quiet] [warmly] "), `the short note as a tag, before the block's own: ${part}`);
      assert.ok(!part.includes("harbour"), "the long book note is held, never spoken");
    }));

  it("are part of a take's direction: a block made under them goes stale when either changes", () =>
    withDirector({}, async ({ worldDir, events, send }) => {
      await send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
      const read = events.filter((e): e is Finished => e.type === "audiobook.finished").at(-1)!;
      assert.equal(read.outcome, "read", read.reason);
      await send({ kind: "set-audiobook-reading-note", worldId: WORLD_ID, productionId: LEDGER, note: BOOK_NOTE });
      await send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
      const again = events.filter((e): e is Finished => e.type === "audiobook.finished").at(-1)!;
      assert.equal(again.made, read.made, "every block made again under the book note, though Kokoro holds it");
      await send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
      assert.equal(events.filter((e): e is Finished => e.type === "audiobook.finished").at(-1)!.made, 0, "and current after");
      const record = ChapterAudiobookSchema.parse(JSON.parse(await readFile(recordPath(worldDir), "utf8")));
      assert.ok(record.takes["title"]?.directionHash, "the take names the notes it was made under");
    }));
});

describe("performed lines are cast first, in the same proposal (R-54)", () => {
  it("an uncast chapter is cast with the directions, nothing written until accepted, then both", () =>
    withDirector(
      {
        uncast: true,
        book: { reading: "performed" },
        voices: async () => ({ lines: [{ speaker: "maren-kest", quote: SPAN }] }),
        direction: async (input) => ({ blocks: input.blocks.map((block) => ({ block: block.key, delivery: "measured" })) }),
      },
      async ({ worldDir, events, send }) => {
        const castFile = join(worldDir, "productions", LEDGER, ".voices", "01-neap.json");
        await send({ kind: "preview-direction", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", requestId: REQUEST });
        const reads = events.find((e): e is Extract<DomainEvent, { type: "direction.reads" }> => e.type === "direction.reads");
        assert.equal(reads?.reads?.cast, "not cast · cast the lines first", "the sheet offers casting first");
        await send({ kind: "direct-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", cast: true });
        const directed = events.find((e): e is Directed => e.type === "direction.finished");
        assert.equal(directed?.outcome, "directed", directed?.reason);
        assert.deepEqual(directed.cast, { lines: 1, speakers: 1 });
        assert.ok(!existsSync(castFile), "the cast is held with the proposal, not written");
        assert.ok(Object.keys(directed.proposed ?? {}).some((key) => key.startsWith("p0.")), "the line the cast makes is directed");
        await send({ kind: "accept-direction", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", requestId: REQUEST, hash: directed.hash!, directions: directed.proposed! });
        const accepted = events.find((e): e is Recorded => e.type === "audiobook.record");
        assert.ok(accepted?.record, accepted?.refused);
        assert.ok(existsSync(castFile), "accepted: the cast is written");
        assert.equal((JSON.parse(await readFile(castFile, "utf8")) as ChapterVoices).lines.length, 1);
      },
    ));

  it("without casting first, an uncast chapter is refused in the run's words", () =>
    withDirector(
      { uncast: true, book: { reading: "performed" }, direction: async (input) => ({ blocks: input.blocks.map((block) => ({ block: block.key })) }) },
      async ({ events, send }) => {
        await send({ kind: "direct-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
        const directed = events.find((e): e is Directed => e.type === "direction.finished");
        assert.equal(directed?.outcome, "failed");
        assert.match(directed.reason ?? "", /not cast/);
      },
    ));

  it("speaker notes are drafted for a speaker with none and written as the sheet's; an author's note is never replaced", () =>
    withDirector(
      {
        book: { reading: "performed" },
        direction: async (input) => ({
          blocks: input.blocks.map((block) => ({ block: block.key, delivery: "measured" })),
          speakerNotes: Object.fromEntries((input.asks?.speakerNotes ?? []).map((speaker) => [speaker.key, "dry, exact, unhurried"])),
          ...(input.asks?.chapterNote === true ? { chapterNote: "Night at the rail desk." } : {}),
        }),
      },
      async ({ worldDir, events, send }) => {
        await send({ kind: "direct-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", speakerNotes: true, chapterNote: true });
        const directed = events.find((e): e is Directed => e.type === "direction.finished")!;
        assert.deepEqual(directed.speakerNotes, { "maren-kest": "dry, exact, unhurried" });
        assert.equal(directed.chapterNote, "Night at the rail desk.");
        assert.ok(!existsSync(bookPath(worldDir)) || (await readBook(worldDir)).notes === undefined, "nothing written before acceptance");
        await send({ kind: "accept-direction", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", requestId: REQUEST, hash: directed.hash!, directions: directed.proposed! });
        const book = await readBook(worldDir);
        assert.equal(book.notes?.["maren-kest"], "dry, exact, unhurried");
        assert.equal(book.noteSources?.["maren-kest"], "sheet", "said where it came from");
        assert.equal(book.chapterNotes?.["neap"], "Night at the rail desk.");

        // The author writes their own: the source goes, and a later draft never replaces it.
        await send({ kind: "set-audiobook-note", worldId: WORLD_ID, productionId: LEDGER, speaker: "maren-kest", note: "low, clipped" });
        assert.equal((await readBook(worldDir)).noteSources, undefined);
        events.length = 0;
        await send({ kind: "direct-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", speakerNotes: true });
        const again = events.find((e): e is Directed => e.type === "direction.finished")!;
        assert.equal(again.speakerNotes, undefined, "no speaker without a note, so none is asked for or proposed");
      },
    ));

  it("Draft from the sheets fills the missing notes at once, marked as the sheet's, and leaves the author's alone", () => {
    const asked: string[][] = [];
    return withDirector(
      {
        book: { reading: "performed", notes: { "someone-else": "the author's own" } },
        speakerNotes: async (input) => {
          asked.push(input.speakers.map((speaker) => speaker.key));
          assert.ok(input.speakers[0]?.essence !== undefined, "drafted from the sheet's essence and voice");
          return { notes: { "maren-kest": "dry, exact, unhurried", "someone-else": "replaced?" } };
        },
      },
      async ({ worldDir, events, send }) => {
        await send({ kind: "draft-audiobook-speaker-notes", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST });
        const answer = events.find((e): e is Extract<DomainEvent, { type: "audiobook.speaker-notes" }> => e.type === "audiobook.speaker-notes");
        assert.equal(answer?.drafted, 1, answer?.refused);
        assert.deepEqual(asked, [["maren-kest"]], "only the speaker with no note is asked about");
        const book = await readBook(worldDir);
        assert.equal(book.notes?.["maren-kest"], "dry, exact, unhurried");
        assert.equal(book.notes?.["someone-else"], "the author's own");
        assert.deepEqual(book.noteSources, { "maren-kest": "sheet" });
      },
    );
  });
});

describe("hear a block before accepting (R-55)", () => {
  it("heard as the proposal would send it, and kept as the take when accepted unchanged", () =>
    withDirector(
      { direction: async (input) => ({ blocks: input.blocks.map((block, index) => ({ block: block.key, delivery: index === 0 ? "urgent" : "measured" })) }) },
      async ({ worldDir, events, spoken, send }) => {
        await send({ kind: "direct-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
        const directed = events.find((e): e is Directed => e.type === "direction.finished")!;
        await send({ kind: "hear-audiobook-line", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, chapterFile: "01-neap", block: "title", proposed: true });
        const heard = events.find((e): e is Extract<DomainEvent, { type: "audiobook.heard" }> => e.type === "audiobook.heard");
        assert.ok(heard?.file, heard?.refused);
        assert.equal(spoken.length, 1, "one read of the block");
        assert.ok(!existsSync(recordPath(worldDir)), "hearing writes no record");
        await send({ kind: "accept-direction", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", requestId: REQUEST, hash: directed.hash!, directions: directed.proposed! });
        const accepted = events.find((e): e is Recorded => e.type === "audiobook.record");
        assert.ok(accepted?.record?.takes["title"], "the heard read is the title's take");
        await send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
        const finished = events.filter((e): e is Finished => e.type === "audiobook.finished").at(-1)!;
        assert.equal(finished.outcome, "read", finished.reason);
        assert.ok(!spoken.slice(1).some((text) => text.startsWith("Chapter 1")), "the title is not read again");
      },
    ));

  it("a proposal accepted with the block changed reads it afresh; with no proposal there is nothing to hear", () =>
    withDirector(
      { direction: async (input) => ({ blocks: input.blocks.map((block, index) => ({ block: block.key, delivery: index === 0 ? "urgent" : "measured" })) }) },
      async ({ events, send }) => {
        await send({ kind: "hear-audiobook-line", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, chapterFile: "01-neap", block: "title", proposed: true });
        assert.match(events.find((e): e is Extract<DomainEvent, { type: "audiobook.heard" }> => e.type === "audiobook.heard")?.refused ?? "", /no proposal/);
        await send({ kind: "direct-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
        const directed = events.find((e): e is Directed => e.type === "direction.finished")!;
        await send({ kind: "hear-audiobook-line", worldId: WORLD_ID, productionId: LEDGER, requestId: REQUEST, chapterFile: "01-neap", block: "title", proposed: true });
        const changed = { ...directed.proposed!, title: { delivery: "measured" as const, speed: 1, cues: [] } };
        await send({ kind: "accept-direction", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", requestId: REQUEST, hash: directed.hash!, directions: changed });
        const accepted = events.find((e): e is Recorded => e.type === "audiobook.record");
        assert.ok(accepted?.record);
        assert.equal(accepted.record.takes["title"], undefined, "what was heard is not what the block now sends");
      },
    ));
});

