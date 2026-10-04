import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AUDIOBOOK_LOOKS_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readAudiobook } from "../../src/productions/audiobook.js";
import { bookLookChoices, carriedLooks, lookUsage, type ChapterLookChoices } from "../../src/productions/audiobook-look-book.js";
import { buildLookPrompt, verifyLook, type LookDeriver, type LookDeriverInput } from "../../src/productions/audiobook-look.js";
import { acceptCharacterLook } from "../../src/references/kit.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Carrying a look (design turn 193, SPEC-047 R-114, R-116): a new chapter starts each character
 * with the look most recently chosen in an earlier chapter, tagged with where it came from; the
 * chapter's own reading is a conflict beside it and never replaces it; a derive again never undoes
 * a choice, a carried one included, and never carries a look back over a choice of none.
 */
const CLOCK = "2026-10-04T09:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const STORM = "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G1";
type RecordEvent = Extract<DomainEvent, { type: "audiobook.record" }>;
type LooksEvent = Extract<DomainEvent, { type: "audiobook.looks" }>;

type Harness = { store: () => WorldStore; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void>; asked: LookDeriverInput[] };
async function withHarness(deriver: LookDeriver, run: (h: Harness) => Promise<void>): Promise<void> {
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
    manifest: { manifestVersion: 1, generated: "2026-10-04", models: [] },
    observeEvent: (event) => events.push(event),
    lookDeriver: (input, signal) => {
      asked.push(input);
      return deriver(input, signal);
    },
  });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await acceptCharacterLook(provider.openStore!()!, "maren-kest", { id: STORM, file: "takes/storm/storm.png", kind: "costume", prompt: "Storm coat, hood up; two braids.", takeId: STORM as never, artDirectionVersion: 3, framing: "full-body" });
    await run({ events, send, asked, store: () => provider.openStore!()! });
  } finally {
    await provider.close();
  }
}

const derive = (send: (message: ClientMessage) => Promise<void>, chapterFile: string) => send({ kind: "derive-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile, requestId: "01J00000000000000000000001" });
const choose = (send: (message: ClientMessage) => Promise<void>, chapterFile: string, lookId: string | null) =>
  send({ kind: "choose-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile, key: "maren-kest", sheet: "maren-kest", lookId, requestId: "01J00000000000000000000002" });
const lastRecord = (events: DomainEvent[]): RecordEvent => {
  const found = events.filter((event): event is RecordEvent => event.type === "audiobook.record").at(-1);
  assert.ok(found, "a record is answered");
  return found;
};

/** What a model says of any chapter: Maren in an oilskin coat, hood down, and — when told of a chosen look — the part where the two disagree. */
const SAYS: LookDeriver = async (input) => ({
  characters: [
    {
      who: "maren-kest",
      text: "Oilskin coat, hood down.",
      blocks: [input.blocks[1]!.key],
      ...(input.people.find((person) => person.key === "maren-kest")?.look !== undefined ? { conflicts: [{ part: "Hood", chapter: "down", look: "up" }] } : {}),
    },
  ],
});

describe("a new chapter starts with the look most recently chosen", () => {
  it("carries the choice of an earlier chapter, tagged with that chapter, the chapter's own reading kept beside it as a conflict", () =>
    withHarness(SAYS, async ({ events, send, asked, store }) => {
      await choose(send, "01-neap", STORM);
      assert.equal(lastRecord(events).record!.look!.characters["maren-kest"]!.lookId, STORM);
      await derive(send, "02-the-same-ink");
      const done = lastRecord(events);
      assert.equal(done.refused, undefined);
      const maren = done.record!.look!.characters["maren-kest"]!;
      assert.equal(maren.lookId, STORM, "the look chosen in chapter 1");
      assert.equal(maren.from, "01-neap", "tagged with where it came from");
      assert.equal(maren.text, "Storm coat, hood up; two braids.", "the line is the look's own words");
      assert.equal(maren.reading, "Oilskin coat, hood down.", "the chapter's reading, beside it");
      assert.deepEqual(maren.conflicts, [{ kind: "chapter", part: "Hood", a: "down", b: "up" }]);
      assert.equal(maren.by, undefined, "carrying is nobody's edit");
      const told = asked.at(-1)!.people.find((person) => person.key === "maren-kest");
      assert.equal(told?.look, "Storm coat, hood up; two braids.", "the writing service is told the look it will be compared with");
      assert.match(buildLookPrompt(asked.at(-1)!), /the look chosen for them: Storm coat, hood up; two braids\./);
      const held = await readAudiobook(store(), LEDGER, "02-the-same-ink");
      assert.ok(held !== null && held !== "unreadable");
      assert.equal(held.look!.characters["maren-kest"]!.lookId, STORM, "kept on the record");
      assert.equal(store().getBundle().meta.schemaVersion, AUDIOBOOK_LOOKS_SCHEMA_VERSION);
    }));

  it("never undoes a choice on a derive again, and never carries a look back over a choice of none", () =>
    withHarness(SAYS, async ({ events, send }) => {
      await choose(send, "01-neap", STORM);
      await derive(send, "02-the-same-ink");
      await derive(send, "02-the-same-ink");
      assert.equal(lastRecord(events).record!.look!.characters["maren-kest"]!.lookId, STORM, "a carried choice survives a derive again");
      await choose(send, "02-the-same-ink", null);
      const none = lastRecord(events).record!.look!.characters["maren-kest"]!;
      assert.deepEqual([none.lookId, none.from, none.text], [undefined, undefined, "Oilskin coat, hood down."], "chosen away: back to the chapter's words");
      await derive(send, "02-the-same-ink");
      assert.equal(lastRecord(events).record!.look!.characters["maren-kest"]!.lookId, undefined, "the author chose the main photo; a derive leaves it");
    }));

  it("starts with none where no look was chosen anywhere, and the writing service is told of none", () =>
    withHarness(SAYS, async ({ events, send, asked }) => {
      await derive(send, "02-the-same-ink");
      const maren = lastRecord(events).record!.look!.characters["maren-kest"]!;
      assert.deepEqual([maren.lookId, maren.from, maren.conflicts], [undefined, undefined, undefined]);
      assert.equal(asked.at(-1)!.people.find((person) => person.key === "maren-kest")?.look, undefined);
      assert.doesNotMatch(buildLookPrompt(asked.at(-1)!), /the look chosen for them|"conflicts"/);
    }));

  it("keeps naming the chapter a carried choice began in when it is carried again", () =>
    withHarness(SAYS, async ({ events, send, store }) => {
      await choose(send, "01-neap", STORM);
      await derive(send, "02-the-same-ink");
      await derive(send, "03-nothing-wrong-with-it");
      assert.equal(lastRecord(events).record!.look!.characters["maren-kest"]!.from, "01-neap", "from chapter 1, not from chapter 2");
      const usage = lookUsage(await bookLookChoices(store(), LEDGER));
      assert.deepEqual(usage[STORM], [1, 2, 3]);
    }));

  it("answers which chapters chose each look, and changes nothing", () =>
    withHarness(SAYS, async ({ events, send, store }) => {
      await choose(send, "01-neap", STORM);
      await derive(send, "02-the-same-ink");
      const before = store().getBundle().meta.schemaVersion;
      await send({ kind: "read-audiobook-looks", worldId: WORLD_ID, productionId: LEDGER, requestId: "01J00000000000000000000003" });
      const answered = events.filter((event): event is LooksEvent => event.type === "audiobook.looks").at(-1)!;
      assert.equal(answered.requestId, "01J00000000000000000000003");
      assert.deepEqual(answered.usage, { [STORM]: [1, 2] });
      assert.equal(store().getBundle().meta.schemaVersion, before);
    }));
});

describe("which look is carried (R-116)", () => {
  const maren = { key: "maren-kest", name: "Maren Kest", sheet: "maren-kest" };
  const looks = [
    { id: "tk_a", file: "a.png", kind: "costume", prompt: "Storm coat.", acceptedAt: CLOCK },
    { id: "tk_b", file: "b.png", kind: "costume", prompt: "Harbour coat.", acceptedAt: CLOCK },
    { id: "tk_pose", file: "p.png", kind: "pose-expression", prompt: "Laughing.", acceptedAt: CLOCK },
  ];
  const kit = () => ({ looks }) as never;
  const book: ChapterLookChoices[] = [
    { file: "01", order: 1, choices: { "maren-kest": { lookId: "tk_a" } } },
    { file: "02", order: 2, choices: { "maren-kest": { lookId: "tk_b" } } },
    { file: "03", order: 3, choices: {} },
    { file: "04", order: 4, choices: { "maren-kest": { lookId: "tk_a" } } },
  ];

  it("is the nearest earlier chapter's choice, in chapter order and not later ones", () => {
    assert.equal(carriedLooks(book, 3, [maren], kit)["maren-kest"]!.lookId, "tk_b");
    assert.equal(carriedLooks(book, 2, [maren], kit)["maren-kest"]!.lookId, "tk_a");
    assert.equal(carriedLooks(book, 1, [maren], kit)["maren-kest"], undefined, "nothing before the first chapter");
    assert.equal(carriedLooks(book, 5, [maren], kit)["maren-kest"]!.from, "04");
  });

  it("passes over a look the kit no longer holds, or that is no costume, for the choice before it", () => {
    const gone = { looks: looks.filter((look) => look.id !== "tk_b") } as never;
    assert.equal(carriedLooks(book, 3, [maren], () => gone)["maren-kest"]!.lookId, "tk_a");
    const posed = [{ file: "05", order: 5, choices: { "maren-kest": { lookId: "tk_pose" } } }];
    assert.equal(carriedLooks([...book.slice(0, 1), ...posed], 6, [maren], kit)["maren-kest"]!.lookId, "tk_a");
  });

  it("gives a person with no sheet nothing, and names where a carried choice began", () => {
    assert.deepEqual(carriedLooks(book, 3, [{ key: "the harbour master", name: "The Harbour Master" }], kit), {});
    const chained = [{ file: "02", order: 2, choices: { "maren-kest": { lookId: "tk_a", from: "01" } } }];
    assert.equal(carriedLooks(chained, 3, [maren], kit)["maren-kest"]!.from, "01");
  });
});

describe("the conflicts the writing service names", () => {
  const people = [{ key: "maren-kest", name: "Maren Kest" }];
  const blocks = [{ key: "p0.0" }];

  it("keeps a part with both sides, bounded, and drops one that says nothing or says the same", () => {
    const verified = verifyLook(
      {
        characters: [
          {
            who: "maren-kest",
            text: "Oilskin coat.",
            conflicts: [
              { part: "Hood", chapter: "down", look: "up" },
              { part: "Boots", chapter: "Sea boots", look: "sea boots" },
              { part: "  ", chapter: "x", look: "y" },
              { part: "Hair", chapter: "z".repeat(300), look: "braids" },
            ],
          },
        ],
      },
      { people, blocks },
    );
    const conflicts = verified.look.characters[0]!.conflicts!;
    assert.deepEqual(conflicts.map((conflict) => [conflict.kind, conflict.part, conflict.b]), [["chapter", "Hood", "up"], ["chapter", "Hair", "braids"]]);
    assert.ok(conflicts[1]!.a.length <= 120);
  });
});
