import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pictureLookFor, type AudiobookLook, type ChapterAudiobook } from "@arke-studio/contracts";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AUDIOBOOK_LOOKS_SCHEMA_VERSION, AUDIOBOOK_LOOK_SCHEMA_VERSION } from "../../src/world/commit.js";
import { SUPPORTED_SCHEMA_VERSION, readWorldMeta } from "../../src/world/scan.js";
import { readAudiobook, writeAudiobook } from "../../src/productions/audiobook.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Looks per character (design turn 193, SPEC-047 R-112): the world is raised past the builds that
 * read a chosen look, the mood line or a picture's look stamp as an unreadable record — before the
 * first write of any of them, and not before.
 */
const CLOCK = "2026-10-04T09:00:00.000Z";
const LEDGER = "the-ledger-of-nights";

const LOOK: AudiobookLook = {
  chapterHash: "h1",
  at: CLOCK,
  place: { text: "The flooded quarter, dusk." },
  characters: { "maren-kest": { name: "Maren Kest", sheet: "maren-kest", text: "Oilskin coat." } },
};

const record = (look: AudiobookLook, pictureLook?: ReturnType<typeof pictureLookFor>): ChapterAudiobook => ({
  schemaVersion: 1,
  chapterVersion: 1,
  hash: "h1",
  updatedAt: CLOCK,
  takes: {},
  flags: {},
  direction: {},
  look,
  ...(pictureLook !== undefined ? { pictures: { "p0.0": { file: "artifacts/a.png", source: "generated" as const, textHash: "t", at: CLOCK, look: pictureLook } } } : {}),
});

async function withStore(run: (h: { store: NonNullable<ReturnType<NonNullable<FsWorldProvider["openStore"]>>>; worldDir: string }) => Promise<void>): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  try {
    await run({ store: provider.openStore!()!, worldDir });
  } finally {
    await provider.close();
  }
}

describe("the world boundary for looks per character (schema 52)", () => {
  it("is the newest this build reads, above world chat's two", () => {
    assert.equal(AUDIOBOOK_LOOKS_SCHEMA_VERSION, 52);
    assert.ok(SUPPORTED_SCHEMA_VERSION >= AUDIOBOOK_LOOKS_SCHEMA_VERSION, "this build reads what it writes");
  });

  it("leaves a look as turn 191 wrote it at schema 49", () =>
    withStore(async ({ store }) => {
      await writeAudiobook(store, LEDGER, "01-neap", record(LOOK, pictureLookFor(LOOK, ["maren-kest"])));
      assert.equal(store.getBundle().meta.schemaVersion, AUDIOBOOK_LOOK_SCHEMA_VERSION);
    }));

  it("raises the world before the first record with a look chosen, and an older build is then refused by name", () =>
    withStore(async ({ store, worldDir }) => {
      const chosen: AudiobookLook = { ...LOOK, characters: { "maren-kest": { ...LOOK.characters["maren-kest"]!, lookId: "tk_storm", from: "01-neap" } } };
      await writeAudiobook(store, LEDGER, "01-neap", record(chosen));
      assert.equal(store.getBundle().meta.schemaVersion, AUDIOBOOK_LOOKS_SCHEMA_VERSION);
      const held = await readAudiobook(store, LEDGER, "01-neap");
      assert.ok(held !== null && held !== "unreadable");
      assert.equal(held.look!.characters["maren-kest"]!.lookId, "tk_storm", "the choice reads back");
      await assert.rejects(readWorldMeta(worldDir, { supports: AUDIOBOOK_LOOKS_SCHEMA_VERSION - 1 }), /newer|schema|version/i);
    }));

  it("raises it for a mood line alone, and for a picture that keeps the look each person rode", async () => {
    await withStore(async ({ store }) => {
      await writeAudiobook(store, LEDGER, "01-neap", record({ ...LOOK, mood: { text: "Teal water, fine grain." } }));
      assert.equal(store.getBundle().meta.schemaVersion, AUDIOBOOK_LOOKS_SCHEMA_VERSION);
    });
    await withStore(async ({ store }) => {
      const rode = pictureLookFor(LOOK, ["maren-kest"], { "maren-kest": { lookId: "tk_storm", view: "close" } });
      await writeAudiobook(store, LEDGER, "01-neap", record(LOOK, rode));
      assert.equal(store.getBundle().meta.schemaVersion, AUDIOBOOK_LOOKS_SCHEMA_VERSION);
    });
  });
});
