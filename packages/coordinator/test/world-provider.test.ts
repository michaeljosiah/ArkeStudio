import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorldBundleSchema } from "@arke-studio/contracts";
import { MockWorldProvider } from "../src/world-provider.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "../../../fixtures");
const WORLD_ID = "01J8F3K2QW9VZX4N7M0RTYB6HC";

describe("MockWorldProvider over the fixture world", () => {
  it("lists the fixture world with honest counts", async () => {
    const provider = new MockWorldProvider(FIXTURES);
    const worlds = await provider.listWorlds();
    assert.equal(worlds.length, 1);
    const w = worlds[0]!;
    assert.equal(w.slug, "the-undersong");
    assert.equal(w.worldId, WORLD_ID);
    assert.deepEqual(w.counts, {
      characters: 3,
      locations: 2,
      factions: 1,
      canonEntries: 6,
      productions: 1,
    });
  });

  it("loads a bundle in which every entity round-trips through its schema unchanged (R-2)", async () => {
    const provider = new MockWorldProvider(FIXTURES);
    const bundle = await provider.loadWorld(WORLD_ID);
    assert.deepEqual(WorldBundleSchema.parse(bundle), bundle);
  });

  it("reads sheets with their sections in authored order", async () => {
    const provider = new MockWorldProvider(FIXTURES);
    const bundle = await provider.loadWorld(WORLD_ID);
    const maren = bundle.sheets.find((s) => s.id === "maren-kest");
    assert.ok(maren);
    assert.equal(maren.version, 4);
    assert.equal(maren.status, "locked");
    assert.deepEqual(
      maren.sections.map((s) => s.heading),
      ["Essence", "Appearance", "Relationships", "Voice · written"],
    );
    assert.equal(maren.voice?.provider, "elevenlabs");

    const sketch = bundle.sheets.find((s) => s.id === "the-chorister");
    assert.equal(sketch?.status, "sketch");
  });

  it("reads canon including the open thread, and the timeline entry as canon", async () => {
    const provider = new MockWorldProvider(FIXTURES);
    const bundle = await provider.loadWorld(WORLD_ID);
    assert.equal(bundle.canon.length, 6);
    const thread = bundle.canon.find((c) => c.id === "CANON-044");
    assert.equal(thread?.type, "thread");
    assert.equal(thread?.status, "open");
    const timeline = bundle.canon.find((c) => c.type === "timeline");
    assert.equal(timeline?.id, "CANON-031");
    const amended = bundle.canon.find((c) => c.id === "CANON-002");
    assert.equal(amended?.amendedAt, 42);
    assert.equal(bundle.meta.canonRevision, 42);
  });

  it("reads the production with scenes, takes, reviews and selections separated (§2.3.7)", async () => {
    const provider = new MockWorldProvider(FIXTURES);
    const bundle = await provider.loadWorld(WORLD_ID);
    const saltlight = bundle.productions[0]!;
    assert.equal(saltlight.meta.format, "video");
    assert.equal(saltlight.scenes[0]!.shots.length, 4);
    assert.equal(saltlight.takes.length, 4);
    assert.ok(saltlight.takes.every((t) => !("status" in t)), "takes carry no status field");
    assert.equal(saltlight.reviews.length, 2);
    assert.equal(saltlight.selections["sh_12"]?.acceptedTakeId, "tk_01J8F0000000000000000000B2");
    assert.equal(saltlight.treatment !== null, true);
  });

  it("reads the staged proposal and its advisory ripple preview", async () => {
    const provider = new MockWorldProvider(FIXTURES);
    const bundle = await provider.loadWorld(WORLD_ID);
    assert.equal(bundle.proposals.length, 1);
    const staged = bundle.proposals[0]!;
    assert.equal(staged.proposal.kind, "sheet-edit");
    assert.equal(staged.proposal.targets[0]!.baseVersion, 4);
    assert.equal(staged.ripple?.items.length, 4);
    assert.equal(staged.ripple?.governing, false);
  });

  it("refuses an unknown world id", async () => {
    const provider = new MockWorldProvider(FIXTURES);
    await assert.rejects(() => provider.loadWorld("01J8F3K2QW9VZX4N7M0RTYB6XX"));
  });
});
