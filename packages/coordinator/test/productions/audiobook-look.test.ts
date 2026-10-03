import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChapterAudiobookSchema, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AUDIOBOOK_LOOK_SCHEMA_VERSION } from "../../src/world/commit.js";
import { audiobookPath, readAudiobook } from "../../src/productions/audiobook.js";
import { buildLookPrompt, verifyLook, type LookDeriver, type LookDeriverInput } from "../../src/productions/audiobook-look.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * The chapter's look (design turn 191c, SPEC-047 R-98): read once from the prose by the writing
 * service, held to the chapter's people and blocks, kept on the chapter's record, every line the
 * author's to change, and never replaced by a derive again.
 */
const CLOCK = "2026-10-03T09:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const REQUEST = "01J00000000000000000000001";
type RecordEvent = Extract<DomainEvent, { type: "audiobook.record" }>;

async function withHarness(run: (h: { worldDir: string; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void>; schemaVersion: () => number; store: () => WorldStore; asked: LookDeriverInput[] }) => Promise<void>, deriver?: LookDeriver): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const asked: LookDeriverInput[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-03", models: [] },
    observeEvent: (event) => events.push(event),
    ...(deriver !== undefined ? { lookDeriver: (input, signal) => { asked.push(input); return deriver(input, signal); } } : {}),
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, events, send, asked, schemaVersion: () => provider.openStore!()!.getBundle().meta.schemaVersion, store: () => provider.openStore!()! });
  } finally {
    await provider.close();
  }
}

const derive = (send: (message: ClientMessage) => Promise<void>) =>
  send({ kind: "derive-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", requestId: REQUEST });
const answer = (events: DomainEvent[]): RecordEvent => {
  const found = events.filter((event): event is RecordEvent => event.type === "audiobook.record").at(-1);
  assert.ok(found, "the record is answered");
  return found;
};

/** What a model says of chapter 1: Maren's coat from the block with the ledger, the vigil's light, and one name the chapter does not hold. */
const SAYS: LookDeriver = async (input) => ({
  place: { text: "The Vigil's rail desk, early morning, grey light through salt-streaked glass.", blocks: [input.blocks[1]!.key, "no-such-block"] },
  characters: [
    { who: "maren-kest", text: "Oilskin coat dark with salt; hair tied back; a failing volume under one arm.", blocks: [input.blocks[1]!.key] },
    { who: "nobody-in-this-chapter", text: "A grey scarf." },
    { who: "Maren Kest", text: "A second line for the same person." },
  ],
});

describe("reading a chapter for its look (R-98)", () => {
  it("keeps what the model said of the people and blocks the chapter holds, and raises the world past the build before it", () =>
    withHarness(async ({ events, send, schemaVersion, worldDir, asked }) => {
      const before = schemaVersion();
      assert.ok(before < AUDIOBOOK_LOOK_SCHEMA_VERSION);
      await derive(send);
      const done = answer(events);
      assert.equal(done.refused, undefined);
      assert.equal(done.requestId, REQUEST, "answered under the request's own id");
      const look = done.record?.look;
      assert.ok(look, "the record carries the look");
      assert.deepEqual(Object.keys(look.characters), ["maren-kest"], "a name the chapter does not hold is dropped; the same person twice is kept once");
      assert.equal(look.characters["maren-kest"]!.name, "Maren Kest");
      assert.equal(look.characters["maren-kest"]!.sheet, "maren-kest");
      assert.equal(look.characters["maren-kest"]!.by, undefined, "derived, not the author's");
      assert.deepEqual(look.place?.blocks, [asked[0]!.blocks[1]!.key], "a block the chapter does not hold is not kept");
      assert.equal(done.dropped, 2, "the dropped lines are counted");
      assert.equal(schemaVersion(), AUDIOBOOK_LOOK_SCHEMA_VERSION, "the first record with a look raises the world");
      const onDisk = JSON.parse(await readFile(join(worldDir, audiobookPath(LEDGER, "01-neap")), "utf8"));
      assert.ok(ChapterAudiobookSchema.safeParse(onDisk).success);
      assert.equal(asked[0]!.people.some((person) => person.key === "maren-kest"), true);
      assert.equal(asked[0]!.places.some((place) => place.key === "the-vigil"), true, "the places the prose names ride with the cast");
    }, SAYS));

  it("never replaces a line the author wrote, and gives the author's other lines back as they were", () =>
    withHarness(async ({ events, send, store }) => {
      await derive(send);
      await send({ kind: "set-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", target: { kind: "character", key: "maren-kest" }, text: "Her father's reefer jacket, two sizes big.", requestId: "01J00000000000000000000002" });
      let record = answer(events).record!;
      assert.equal(record.look!.characters["maren-kest"]!.by, "author");
      await send({ kind: "set-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", target: { kind: "place" }, text: "A rail desk lit by one lamp.", requestId: "01J00000000000000000000003" });
      record = answer(events).record!;
      assert.equal(record.look!.place!.by, "author");
      await derive(send);
      record = answer(events).record!;
      assert.equal(record.look!.characters["maren-kest"]!.text, "Her father's reefer jacket, two sizes big.", "the author's line stands over a later derive");
      assert.equal(record.look!.place!.text, "A rail desk lit by one lamp.");
      const held = await readAudiobook(store(), LEDGER, "01-neap");
      assert.ok(held !== null && held !== "unreadable");
      assert.equal(held.look!.characters["maren-kest"]!.by, "author");
    }, SAYS));

  it("replaces a derived line with the new reading, and drops a derived character the new reading does not find", async () => {
    let round = 0;
    const deriver: LookDeriver = async (input) => {
      round += 1;
      return round === 1
        ? { characters: [{ who: "maren-kest", text: "Oilskin coat." }, { who: "bray-half-hitch", text: "Three belts." }] }
        : { characters: [{ who: "maren-kest", text: "Oilskin coat, torn at the cuff." }], place: { text: "Dusk.", blocks: [input.blocks[0]!.key] } };
    };
    await withHarness(async ({ events, send }) => {
      await derive(send);
      await derive(send);
      const look = answer(events).record!.look!;
      assert.equal(look.characters["maren-kest"]!.text, "Oilskin coat, torn at the cuff.");
      assert.equal(look.characters["bray-half-hitch"], undefined);
      assert.equal(look.place!.text, "Dusk.");
    }, deriver);
  });

  it("an edit to the same words changes nothing, so a derived line is not made the author's by a press in and out of its field", () =>
    withHarness(async ({ events, send }) => {
      await derive(send);
      const first = answer(events).record!;
      await send({ kind: "set-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", target: { kind: "character", key: "maren-kest" }, text: first.look!.characters["maren-kest"]!.text, requestId: "01J00000000000000000000004" });
      const second = answer(events).record!;
      assert.equal(second.look!.characters["maren-kest"]!.by, undefined);
      assert.equal(second.updatedAt, first.updatedAt, "nothing was written");
    }, SAYS));

  it("takes a line away when the author clears it, and adds one for a character the look missed", () =>
    withHarness(async ({ events, send }) => {
      await derive(send);
      await send({ kind: "set-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", target: { kind: "character", key: "bray-half-hitch", name: "Bray Half-Hitch", sheet: "bray-half-hitch" }, text: "Three belts and a wet cap.", requestId: "01J00000000000000000000005" });
      let look = answer(events).record!.look!;
      assert.equal(look.characters["bray-half-hitch"]!.by, "author");
      assert.equal(look.characters["bray-half-hitch"]!.sheet, "bray-half-hitch");
      await send({ kind: "set-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", target: { kind: "character", key: "maren-kest" }, text: null, requestId: "01J00000000000000000000006" });
      look = answer(events).record!.look!;
      assert.equal(look.characters["maren-kest"], undefined);
      assert.ok(look.characters["bray-half-hitch"]);
    }, SAYS));

  it("says so in one clause when the writing service is not running, and writes nothing", () =>
    withHarness(async ({ events, send, schemaVersion, store }) => {
      const before = schemaVersion();
      await derive(send);
      assert.equal(answer(events).refused, "the writing service is not running");
      assert.equal(schemaVersion(), before, "a refused read raises nothing");
      assert.equal(await readAudiobook(store(), LEDGER, "01-neap"), null);
    }));

  it("is refused when the prose moves while the model reads it, since a look read from other words is not this chapter's", () => {
    let moved: (() => Promise<void>) | undefined;
    const deriver: LookDeriver = async (input) => {
      await moved?.();
      return { characters: [{ who: "maren-kest", text: "Oilskin coat.", blocks: [input.blocks[1]!.key] }] };
    };
    return withHarness(async ({ events, send, store, worldDir }) => {
      moved = async () => {
        const { writeFile } = await import("node:fs/promises");
        const file = join(worldDir, "productions", LEDGER, "chapters", "01-neap.md");
        const body = await readFile(file, "utf8");
        await writeFile(file, body.replace("Maren has the 1820 volume", "Maren has the 1821 volume"), "utf8");
        await store().reload();
      };
      await derive(send);
      assert.equal(answer(events).refused, "the prose moved · read the look again");
      assert.equal(await readAudiobook(store(), LEDGER, "01-neap"), null, "nothing written for words that are gone");
    }, deriver);
  });
});

describe("what the look is asked, and what is kept of the answer", () => {
  const input: LookDeriverInput = {
    title: "Neap",
    art: "Salt-bleached realism, teal and amber.",
    people: [{ key: "maren-kest", name: "Maren Kest", appearance: "Wiry; cropped dark hair." }],
    places: [{ key: "the-vigil", name: "The Vigil", look: "A stone tower over the harbour." }],
    blocks: [{ key: "title", text: "Chapter 1 · Neap" }, { key: "p0.0", text: "Maren has the 1820 volume open on the rail desk." }],
  };

  it("sends the chapter's blocks by key with the cast's sheets, the places and the art direction", () => {
    const prompt = buildLookPrompt(input);
    for (const part of ["[p0.0] Maren has the 1820 volume", "[maren-kest] Maren Kest — the sheet says: Wiry; cropped dark hair.", "The Vigil — A stone tower", "Salt-bleached realism", "Never personality, feelings or backstory"]) assert.ok(prompt.includes(part), part);
  });

  it("cuts a line over the bound at a word, drops one with no words, and takes a name for the character it names", () => {
    const long = `${"A heavy oilskin coat ".repeat(40)}`;
    const verified = verifyLook({ characters: [{ who: "maren kest", text: long }, { who: "maren-kest", text: "again" }, { who: "x", text: "   " }], place: { text: "  " } }, { people: input.people, blocks: input.blocks });
    assert.equal(verified.look.characters.length, 1);
    assert.ok(verified.look.characters[0]!.text.length <= 400);
    assert.ok(verified.look.characters[0]!.text.endsWith("…"));
    assert.equal(verified.look.place, undefined);
    assert.equal(verified.dropped, 2);
  });

  it("gives a character the sheet never lets be pictured no line", () => {
    const verified = verifyLook({ characters: [{ who: "maren-kest", text: "Oilskin." }] }, { people: input.people, blocks: input.blocks, hidden: ["maren-kest"] });
    assert.equal(verified.look.characters.length, 0);
    assert.equal(verified.dropped, 1);
  });
});
