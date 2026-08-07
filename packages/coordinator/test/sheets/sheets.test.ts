import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SHEET_SHAPES, SheetSchema } from "@arke-studio/contracts";
import { splitSections } from "../../src/frontmatter.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import {
  buildSheetContent,
  createSheetFromImage,
  createSheetFromSentence,
  duplicateSheet,
  scopeImageExtraction,
  stageSheetRename,
  stageSheetStatus,
  stageVoiceAssignment,
} from "../../src/sheets/authoring.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  return { dir, store, gate: new ProposalManager(store) };
}

describe("shapes (R-1, D1, D2)", () => {
  it("builds valid sheets of all three shapes from the declarative table", () => {
    for (const type of ["character", "location", "faction"] as const) {
      const shape = SHEET_SHAPES[type];
      const sections: Record<string, string> = {};
      for (const s of shape.sections) sections[s.heading] = `${s.heading} prose.`;
      const content = buildSheetContent({
        id: `test-${type}`,
        type,
        name: `Test ${type}`,
        status: "sketch",
        sections,
        date: "2026-08-01",
      });
      const doc = MarkdownFile.parse(content);
      const parsed = SheetSchema.parse({ ...doc.data, type, sections: splitSections(doc.body) });
      assert.equal(parsed.status, "sketch");
      assert.deepEqual(
        parsed.sections.map((s) => s.heading),
        shape.sections.map((s) => s.heading),
        `${type} sections come out in schema order`,
      );
    }
  });
});

describe("identity and rename (R-2, R-3, D3, D4)", () => {
  it("rename edits frontmatter only — no file moves, every citation resolves", async () => {
    const { dir, store, gate } = await open();
    const index = store.getIndex()!;
    const citedBefore = index.db
      .prepare("SELECT COUNT(*) AS n FROM citations WHERE target_id = 'maren-kest'")
      .get() as { n: number };
    assert.ok(citedBefore.n > 0);

    const staged = await stageSheetRename(store, gate, {
      path: "characters/maren-kest.md",
      name: "Maren Kestrel",
    });
    const outcome = await gate.accept(staged.id);
    assert.equal(outcome.status, "accepted");

    const raw = await readFile(join(dir, "characters", "maren-kest.md"), "utf8");
    const doc = MarkdownFile.parse(raw);
    assert.equal(doc.data["name"], "Maren Kestrel");
    assert.equal(doc.data["id"], "maren-kest", "the id never changes");

    const citedAfter = index.db
      .prepare("SELECT COUNT(*) AS n FROM citations WHERE target_id = 'maren-kest'")
      .get() as { n: number };
    assert.equal(citedAfter.n, citedBefore.n, "every citation still resolves");
    const sheet = store.getBundle().sheets.find((s) => s.id === "maren-kest");
    assert.equal(sheet?.name, "Maren Kestrel", "the display name comes from frontmatter");
    await store.close();
  });
});

describe("lifecycle (R-5..R-9, D5, D6)", () => {
  it("locks with no tiles required, through the gate, bumping the version", async () => {
    const { store, gate } = await open();
    // the-chorister is a sketch with no reference kit at all.
    const staged = await stageSheetStatus(store, gate, {
      path: "characters/the-chorister.md",
      status: "locked",
    });
    const outcome = await gate.accept(staged.id);
    assert.equal(outcome.status, "accepted");
    const sheet = store.getBundle().sheets.find((s) => s.id === "the-chorister");
    assert.equal(sheet?.status, "locked");
    assert.equal(sheet?.version, 6);
    await store.close();
  });

  it("unlocking works and its proposal ripples name the citing work (R-8)", async () => {
    const { store, gate } = await open();
    const staged = await stageSheetStatus(store, gate, {
      path: "characters/maren-kest.md",
      status: "sketch",
    });
    const bundle = store.getBundle();
    const stagedProposal = bundle.proposals.find((p) => p.proposal.id === staged.id);
    assert.ok(stagedProposal?.ripple);
    const kinds = stagedProposal.ripple.items.map((i) => i.kind);
    assert.ok(kinds.includes("takes-pinned-to-old-version"), "citing takes are named");
    assert.ok(kinds.includes("productions-pick-up"), "citing productions are named");
    assert.match(stagedProposal.proposal.summary, /everything citing it did so as settled/);
    await store.close();
  });
});

describe("creation paths (R-10..R-12, D7, D9)", () => {
  it("from a sentence: lands as a sketch with the sentence seeding the first section", async () => {
    const { store, gate } = await open();
    const draft = await createSheetFromSentence(store, gate, {
      sheetType: "character",
      name: "Ola Ninefinger",
      sentence: "A rope-seller who remembers every knot she has ever sold.",
    });
    assert.equal(draft.slug, "ola-ninefinger");
    assert.match(draft.scope, /canon v104/);
    assert.match(draft.scope, /5 existing characters/);
    const outcome = await gate.accept(draft.proposal.id);
    assert.equal(outcome.status, "accepted");
    const sheet = store.getBundle().sheets.find((s) => s.id === "ola-ninefinger");
    assert.equal(sheet?.status, "sketch");
    assert.ok(sheet?.sections.some((s) => s.body.includes("rope-seller")));
    await store.close();
  });

  it("settling one leaves a sheet and nothing waiting to be decided", async () => {
    // What beginning a world now does per character and per place. The gate still ran — this is
    // an accept, not a bypass — but nobody was asked, because pressing Begin was the yes.
    const { store, gate } = await open();
    const draft = await createSheetFromSentence(store, gate, {
      sheetType: "location",
      name: "The Bell Towers",
      sentence: "Salt-eaten stone that rings itself when the tide turns.",
    });
    const before = store.getBundle().proposals.length;
    assert.ok(before > 0, "it is staged first, like everything else");

    assert.equal((await gate.accept(draft.proposal.id)).status, "accepted");

    const sheet = store.getBundle().sheets.find((s) => s.id === "the-bell-towers");
    assert.equal(sheet?.status, "sketch", "a sketch, changeable by typing in it");
    assert.equal(
      store.getBundle().proposals.some((p) => p.proposal.id === draft.proposal.id),
      false,
      "and nothing left in Needs you",
    );
    await store.close();
  });

  it("duplication: source byte-identical, origin recorded at copy-time version (R-12, D9)", async () => {
    const { dir, store, gate } = await open();
    const sourceBefore = await readFile(join(dir, "characters", "bray-half-hitch.md"), "utf8");

    const staged = await duplicateSheet(store, gate, {
      path: "characters/bray-half-hitch.md",
      newName: "Sella Half-Hitch",
    });
    const outcome = await gate.accept(staged.id);
    assert.equal(outcome.status, "accepted");

    assert.equal(
      await readFile(join(dir, "characters", "bray-half-hitch.md"), "utf8"),
      sourceBefore,
      "the source is byte-identical",
    );
    const copy = store.getBundle().sheets.find((s) => s.id === "sella-half-hitch");
    assert.equal(copy?.status, "sketch");
    assert.deepEqual(copy?.origin, { sheet: "bray-half-hitch", version: 6 });

    // Advance the source; the copy's origin record does not move (a record, not a dependency).
    const live = await readFile(join(dir, "characters", "bray-half-hitch.md"), "utf8");
    const doc = MarkdownFile.parse(live);
    doc.setBody(doc.body + "\nAdvanced.");
    await store.commit({
      kind: "sheet-edit",
      source: "test",
      files: [{ path: "characters/bray-half-hitch.md", action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
    });
    const copyAfter = store.getBundle().sheets.find((s) => s.id === "sella-half-hitch");
    assert.deepEqual(copyAfter?.origin, { sheet: "bray-half-hitch", version: 2 }, "unmoved");
    await store.close();
  });

  it("image extraction is scoped by field — the adversarial cases (R-11, D7)", () => {
    // A model that invents a name, history and relationships alongside the coat colour.
    const inventive = scopeImageExtraction("character", {
      appearance: "Salt-stained oilskin coat, grey eyes.",
      wardrobe: "Three belts.",
      apparentAge: "Mid-forties.",
      mood: "Watchful.",
      name: "Captain Aldous Vane", // invented — dies
      relationships: "Brother to the harbourmaster", // invented — dies
      history: "Veteran of the drowning", // invented — dies
    });
    assert.deepEqual(Object.keys(inventive), ["Appearance"]);
    assert.ok(!JSON.stringify(inventive).includes("Aldous"), "no name is invented");
    assert.ok(!JSON.stringify(inventive).includes("harbourmaster"), "text in the image is not a relationship");

    // An unreadable image produces empty fields, never plausible ones.
    assert.deepEqual(scopeImageExtraction("character", {}), {});
    assert.deepEqual(scopeImageExtraction("character", { name: "Someone" }), {});

    // Factions have no image-evidence section at all.
    assert.deepEqual(scopeImageExtraction("faction", { appearance: "banners" }), {});
  });

  it("from an image: empty un-evidenced fields, artifact recorded as the drafting source", async () => {
    const { store, gate } = await open();
    const staged = await createSheetFromImage(store, gate, {
      sheetType: "character",
      name: "Unnamed from image",
      extraction: { appearance: "A red coat.", name: "Invented Name" },
      sourceArtifactId: "ar_01J8G0000000000000000000R1",
    });
    assert.equal(staged.source, "import:ar_01J8G0000000000000000000R1");
    const outcome = await gate.accept(staged.id);
    assert.equal(outcome.status, "accepted");
    const sheet = store.getBundle().sheets.find((s) => s.name === "Unnamed from image");
    assert.ok(sheet);
    assert.equal(sheet.status, "sketch");
    const appearance = sheet.sections.find((s) => s.heading === "Appearance");
    assert.ok(appearance?.body.includes("red coat"));
    assert.ok(!sheet.sections.some((s) => s.body.includes("Invented Name")));
    assert.deepEqual(sheet.voice, undefined, "voice left for the author");
    assert.deepEqual(sheet.links, [], "relationships left for the author");
    await store.close();
  });
});

describe("voice and links (R-4, R-15, D10)", () => {
  it("voice assignment is gated, versions, and lands at the accepted version", async () => {
    const { store, gate } = await open();
    const staged = await stageVoiceAssignment(store, gate, {
      path: "characters/bray-half-hitch.md",
      voice: { provider: "elevenlabs", voiceId: "v_rope", label: "Rope and rum" },
    });
    const outcome = await gate.accept(staged.id);
    assert.equal(outcome.status, "accepted");
    const sheet = store.getBundle().sheets.find((s) => s.id === "bray-half-hitch");
    assert.equal(sheet?.version, 7);
    assert.equal(sheet?.voice?.voiceId, "v_rope");
    assert.equal(sheet?.voice?.assignedAtVersion, 7, "the assignment records the version it landed at");
    await store.close();
  });

  it("links are one-sided; the reverse lookup comes from the index (R-4, D10)", async () => {
    const { dir, store, gate } = await open();
    // The chorister does not link bray. Bray links the chorister; the chorister's file never moves.
    const choristerBefore = await readFile(join(dir, "characters", "the-chorister.md"), "utf8");
    const brayLive = await readFile(join(dir, "characters", "bray-half-hitch.md"), "utf8");
    const doc = MarkdownFile.parse(brayLive);
    doc.setData({ links: [...(doc.data["links"] as string[]), "the-chorister"] });
    const staged = await gate.stage({
      kind: "sheet-edit",
      summary: "Bray links the Chorister",
      source: "form",
      targets: [{ path: "characters/bray-half-hitch.md", content: doc.serialize() }],
    });
    const outcome = await gate.accept(staged.id);
    assert.equal(outcome.status, "accepted");

    assert.equal(
      await readFile(join(dir, "characters", "the-chorister.md"), "utf8"),
      choristerBefore,
      "linking A→B does not modify B",
    );
    const index = store.getIndex()!;
    const incoming = index.db
      .prepare(
        "SELECT source_id AS id FROM citations WHERE target_id = 'the-chorister' AND relation = 'sheet-link' ORDER BY id",
      )
      .all() as Array<{ id: string }>;
    assert.ok(incoming.some((r) => r.id === "bray-half-hitch"), "reverse lookup shows the new incoming link");
    assert.ok(incoming.some((r) => r.id === "maren-kest"), "and the fixture's existing one");
    await store.close();
  });

  it("editing a sheet with canon rules names their owners in the ripple (R-14, SPEC-006)", async () => {
    const { dir, store, gate } = await open();
    // Maren's rules belong to CANON-002. Any staged edit to her sheet says so before accept.
    const live = await readFile(join(dir, "characters", "maren-kest.md"), "utf8");
    const doc = MarkdownFile.parse(live);
    doc.setBody(doc.body.replace("Salt-crusted braids", "Salt-white braids"));
    const staged = await gate.stage({
      kind: "sheet-edit",
      summary: "Appearance drift",
      source: "chat:studio",
      targets: [{ path: "characters/maren-kest.md", content: doc.serialize() }],
    });
    const preview = store.getBundle().proposals.find((p) => p.proposal.id === staged.id);
    assert.ok(preview?.ripple);
    const owning = preview.ripple.items.find((i) => i.kind === "owning-canon-rules");
    assert.ok(owning, "the ripple names the canon entries owning this sheet's rules");
    assert.ok(owning.targets.includes("CANON-002"));
    await store.close();
  });
});
