import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorldBundleSchema } from "@arke-studio/contracts";
import { scanWorld } from "../src/world/scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_WORLD = resolve(here, "../../../fixtures/worlds/the-undersong");

describe("scanWorld over the fixture corpus (T-18)", () => {
  it("loads a bundle in which every entity round-trips through its schema unchanged (R-2)", async () => {
    const { bundle, problems } = await scanWorld(FIXTURE_WORLD);
    assert.deepEqual(problems, []);
    assert.deepEqual(WorldBundleSchema.parse(bundle), bundle);
  });

  it("reads sheets with their sections in authored order", async () => {
    const { bundle } = await scanWorld(FIXTURE_WORLD);
    const maren = bundle.sheets.find((s) => s.id === "maren-kest");
    assert.ok(maren);
    assert.equal(maren.version, 4);
    assert.equal(maren.status, "locked");
    assert.deepEqual(
      maren.sections.map((s) => s.heading),
      ["Essence", "Appearance", "Relationships", "Voice · written"],
    );
    assert.equal(maren.voice?.provider, "elevenlabs");
    assert.equal(bundle.sheets.find((s) => s.id === "the-chorister")?.status, "sketch");
  });

  it("reads canon including the open thread and the timeline entry", async () => {
    const { bundle } = await scanWorld(FIXTURE_WORLD);
    assert.equal(bundle.canon.length, 6);
    const thread = bundle.canon.find((c) => c.id === "CANON-044");
    assert.equal(thread?.type, "thread");
    assert.equal(thread?.status, "open");
    assert.equal(bundle.canon.find((c) => c.type === "timeline")?.id, "CANON-031");
    assert.equal(bundle.canon.find((c) => c.id === "CANON-002")?.amendedAt, 42);
    assert.equal(bundle.meta.canonRevision, 42);
  });

  it("reads the production with takes, reviews and selections separated (§2.3.7)", async () => {
    const { bundle } = await scanWorld(FIXTURE_WORLD);
    const saltlight = bundle.productions[0]!;
    assert.equal(saltlight.meta.format, "video");
    assert.equal(saltlight.scenes[0]!.shots.length, 4);
    assert.equal(saltlight.takes.length, 4);
    assert.equal(saltlight.reviews.length, 2);
    assert.equal(saltlight.selections["sh_12"]?.acceptedTakeId, "tk_01J8F0000000000000000000B2");
  });

  it("reads the staged proposal and its advisory ripple preview", async () => {
    const { bundle } = await scanWorld(FIXTURE_WORLD);
    assert.equal(bundle.proposals.length, 1);
    assert.equal(bundle.proposals[0]!.proposal.kind, "sheet-edit");
    assert.equal(bundle.proposals[0]!.ripple?.items.length, 4);
  });

  it("produces the reconciliation manifest over gated text files", async () => {
    const { manifest } = await scanWorld(FIXTURE_WORLD);
    assert.ok(manifest["world.json"]);
    assert.ok(manifest["characters/maren-kest.md"]?.startsWith("sha256:"));
    assert.ok(manifest["canon/CANON-002.md"]);
    assert.ok(manifest["productions/saltlight/scenes/04-the-verse-rises.json"]);
  });
});
