import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  guestsOf,
  isGuest,
  pickableSheets,
  planScene,
  SheetSchema,
  worldSheets,
  type ManifestModel,
  type Scene,
} from "@arke-studio/contracts";
import { splitSections } from "../../src/frontmatter.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import {
  buildSheetContent,
  createSheetFromSentence,
  stageGuestPromotion,
} from "../../src/sheets/authoring.js";
import { verifyCandidates, type RawCandidate } from "../../src/artifacts/extraction.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";

/**
 * Production-scoped casts — the guest (SPEC-020).
 *
 * Every test here works on a disposable copy of the fixture world and writes its own guests into
 * it. The fixture on disk stays a world with no guests in it on purpose: about thirty assertions
 * across the suite are pinned to its cast and its counts, and a guest added there would be a
 * change to all of them dressed up as a change to none.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

/**
 * Every store this file opens is registered for the sweep as well as closed by hand. A failing
 * assertion skips the hand-written close, and an open WorldStore holds SQLite's handle open,
 * which hangs the runner — so one broken expectation would cost the whole suite rather than one
 * red test. The sweep swallows the second close.
 */
async function openAt(dir: string): Promise<WorldStore> {
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

async function open() {
  const dir = await makeTempWorld();
  const store = await openAt(dir);
  return { dir, store, gate: new ProposalManager(store) };
}

/** Write a guest straight onto disk, before the store opens — the state a scan must survive. */
async function writeGuest(
  dir: string,
  input: { id: string; name: string; production: string; type?: "character" | "location" | "faction" },
): Promise<string> {
  const type = input.type ?? "character";
  const content = buildSheetContent({
    id: input.id,
    type,
    name: input.name,
    status: "sketch",
    sections: { [type === "character" ? "Essence" : type === "location" ? "Look" : "Wants"]: "One line of prose." },
    production: input.production,
    date: "2026-08-01",
  });
  const rel = `${type === "character" ? "characters" : type === "location" ? "locations" : "factions"}/${input.id}.md`;
  await writeFile(join(dir, rel), content, "utf8");
  return rel;
}

// ---------------------------------------------------------------------------
// R-1..R-4 · the field, and the read path
// ---------------------------------------------------------------------------

describe("ownership is a field (R-1, R-2, R-3)", () => {
  it("a guest is an ordinary sheet carrying one more key", () => {
    const content = buildSheetContent({
      id: "the-barman",
      type: "character",
      name: "The barman",
      status: "sketch",
      sections: { Essence: "Two lines and a wet cloth." },
      production: "saltlight",
      date: "2026-08-01",
    });
    const doc = MarkdownFile.parse(content);
    const parsed = SheetSchema.parse({ ...doc.data, type: "character", sections: splitSections(doc.body) });
    assert.equal(parsed.production, "saltlight");
    assert.equal(isGuest(parsed), true);
    // Everything that carries risk is untouched: it versions, statuses and cites like any sheet.
    assert.equal(parsed.version, 1);
    assert.equal(parsed.status, "sketch");
    assert.deepEqual(parsed.canonRules, []);
  });

  it("a world sheet has no production key at all, rather than an empty one", () => {
    const content = buildSheetContent({
      id: "someone",
      type: "character",
      name: "Someone",
      status: "sketch",
      sections: { Essence: "Prose." },
      date: "2026-08-01",
    });
    assert.ok(!content.includes("production:"), "absent means the world's — never an empty string");
    const doc = MarkdownFile.parse(content);
    const parsed = SheetSchema.parse({ ...doc.data, type: "character", sections: splitSections(doc.body) });
    assert.equal(parsed.production, undefined);
    assert.equal(isGuest(parsed), false);
  });

  it("round-trips byte-identically, guest or not (SPEC-002 R-5)", async () => {
    const { dir } = await open();
    const rel = await writeGuest(dir, { id: "the-barman", name: "The barman", production: "saltlight" });
    for (const path of [rel, "characters/maren-kest.md"]) {
      const raw = await readFile(join(dir, path), "utf8");
      assert.equal(MarkdownFile.parse(raw).serialize(), raw, `${path} survives parse → serialise`);
    }
  });
});

describe("the read path stays permissive (R-4)", () => {
  it("a guest of a production that does not exist still parses and still resolves", async () => {
    const dir = await makeTempWorld();
    await writeGuest(dir, { id: "the-ghost", name: "The ghost", production: "a-production-that-was-renamed" });

    const scanned = await scanWorld(dir);
    const ghost = scanned.bundle.sheets.find((s) => s.id === "the-ghost");
    assert.ok(ghost, "the sheet is not dropped for naming a production the world has lost");
    assert.equal(ghost.production, "a-production-that-was-renamed");
    assert.deepEqual(
      scanned.problems.filter((p) => p.path.includes("the-ghost")),
      [],
      "and it is not reported as a problem either",
    );
  });

  it("a guest never costs the world a sheet — the scan returns both kinds together", async () => {
    const dir = await makeTempWorld();
    const before = (await scanWorld(dir)).bundle.sheets.length;
    await writeGuest(dir, { id: "the-barman", name: "The barman", production: "saltlight" });
    const after = (await scanWorld(dir)).bundle.sheets;
    assert.equal(after.length, before + 1);
    assert.equal(worldSheets(after).length, before, "the world's own cast is unchanged by a guest");
  });
});

// ---------------------------------------------------------------------------
// R-2 · one namespace
// ---------------------------------------------------------------------------

describe("guests share the world's slug namespace (R-2, D2)", () => {
  it("the same guest name in two productions takes two slugs", async () => {
    const { dir, store, gate } = await open();
    const first = await createSheetFromSentence(store, gate, {
      sheetType: "location",
      name: "The Inn",
      sentence: "A room above the chandlery.",
      production: "saltlight",
    });
    assert.equal((await gate.accept(first.proposal.id)).status, "accepted");

    const second = await createSheetFromSentence(store, gate, {
      sheetType: "location",
      name: "the inn",
      sentence: "A different inn entirely.",
      production: "the-ledger-of-nights",
    });
    assert.notEqual(second.slug, first.slug, "compared case-insensitively — NTFS is");
    assert.equal(first.slug, "the-inn");
    assert.equal(second.slug, "the-inn-2");
    void dir;
    await store.close();
  });

  it("a guest's slug is taken against the whole world, not against its production", async () => {
    const { store, gate } = await open();
    // `the-vigil` is a location the fixture world already owns.
    const draft = await createSheetFromSentence(store, gate, {
      sheetType: "location",
      name: "The Vigil",
      sentence: "A guest place that happens to share a name.",
      production: "saltlight",
    });
    assert.notEqual(draft.slug, "the-vigil", "a guest may not shadow a world sheet's id");
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// R-5..R-7 · resolution, dispatch, pickers
// ---------------------------------------------------------------------------

const VIDEO_MODEL: ManifestModel = {
  id: "seedance-2.0",
  provider: "fal",
  capability: "video",
  displayName: "Seedance 2.0",
  accepts: { referenceImages: 2, startFrame: true, endFrame: true },
  limits: { maxDurationSec: 15 },
  pricing: { kind: "perSecond", microUsdPerSecond: 21667 },
};

describe("resolution ignores scope, dispatch warns (R-5, R-6, D3)", () => {
  it("a shot citing another production's guest resolves, is named, and still dispatches", async () => {
    const dir = await makeTempWorld();
    await writeGuest(dir, { id: "the-barman", name: "The barman", production: "the-ledger-of-nights" });
    const store = await openAt(dir);
    const bundle = store.getBundle();
    const production = bundle.productions.find((p) => p.meta.id === "saltlight")!;
    const base = production.scenes[0]!;
    const scene: Scene = {
      ...base,
      shots: [{ ...base.shots[0]!, id: "sh_1", number: 1, description: "@the-barman pours." }],
    };

    const plan = planScene(
      {
        world: bundle.meta,
        productionId: "saltlight",
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: {},
        model: VIDEO_MODEL,
      },
      "per-shot",
    );

    assert.deepEqual(plan.warnings.unknownMentions, [], "the mention resolved — scope is not a resolution rule");
    assert.deepEqual(plan.warnings.foreignGuests, [{ name: "The barman", owner: "the-ledger-of-nights" }]);
    assert.ok(plan.totalEstimatedMicroUsd > 0, "named, not blocked — it is still a priced dispatch");
    await store.close();
  });

  it("a production's own guest is cast without a warning", async () => {
    const dir = await makeTempWorld();
    await writeGuest(dir, { id: "the-barman", name: "The barman", production: "saltlight" });
    const store = await openAt(dir);
    const bundle = store.getBundle();
    const base = bundle.productions.find((p) => p.meta.id === "saltlight")!.scenes[0]!;
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: "saltlight",
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: { ...base, shots: [{ ...base.shots[0]!, id: "sh_1", number: 1, description: "@the-barman pours." }] },
        selections: {},
        model: VIDEO_MODEL,
      },
      "per-shot",
    );
    assert.deepEqual(plan.warnings.foreignGuests, []);
    await store.close();
  });

  it("a world sheet never warns, whichever production cites it", async () => {
    const { store } = await open();
    const bundle = store.getBundle();
    const base = bundle.productions.find((p) => p.meta.id === "saltlight")!.scenes[0]!;
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: "saltlight",
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: { ...base, shots: [{ ...base.shots[0]!, id: "sh_1", number: 1, description: "@maren-kest waits." }] },
        selections: {},
        model: VIDEO_MODEL,
      },
      "per-shot",
    );
    assert.deepEqual(plan.warnings.foreignGuests, []);
    await store.close();
  });
});

describe("pickers scope, resolvers do not (R-7, D4)", () => {
  it("offers the world plus this production's guests, and no one else's", async () => {
    const dir = await makeTempWorld();
    await writeGuest(dir, { id: "the-barman", name: "The barman", production: "saltlight" });
    await writeGuest(dir, { id: "the-clerk", name: "The clerk", production: "the-ledger-of-nights" });
    const sheets = (await scanWorld(dir)).bundle.sheets;

    const offered = pickableSheets(sheets, "saltlight").map((s) => s.id);
    assert.ok(offered.includes("maren-kest"), "the world's cast is always offered");
    assert.ok(offered.includes("the-barman"), "so are this production's guests");
    assert.ok(!offered.includes("the-clerk"), "another production's guests are not");

    assert.deepEqual(guestsOf(sheets, "saltlight").map((s) => s.id), ["the-barman"]);
    // A world-level picker (no production) offers no guests at all.
    assert.deepEqual(
      pickableSheets(sheets, undefined).filter(isGuest),
      [],
      "outside a production there is no production to be a guest of",
    );
  });
});

// ---------------------------------------------------------------------------
// R-14, R-15 · promotion
// ---------------------------------------------------------------------------

describe("promotion (R-14, R-15, D6, D7)", () => {
  /**
   * Maren is the fixture's most-connected sheet — citations, takes, a reference kit and a voice.
   * Making her a guest and promoting her back is the strongest available statement that
   * promotion moves nothing: if the flat namespace were not doing the work, this is where it
   * would show.
   */
  async function withMarenAsGuest() {
    const dir = await makeTempWorld();
    const path = join(dir, "characters", "maren-kest.md");
    const doc = MarkdownFile.parse(await readFile(path, "utf8"));
    doc.setData({ production: "saltlight" });
    await writeFile(path, doc.serialize(), "utf8");
    const store = await openAt(dir);
    return { dir, store, gate: new ProposalManager(store) };
  }

  it("clears the field, keeps the id, the file, the citations, the takes and the kit", async () => {
    const { dir, store, gate } = await withMarenAsGuest();
    const index = store.getIndex()!;
    const count = (sql: string) => (index.db.prepare(sql).get() as { n: number }).n;

    const citationsBefore = count("SELECT COUNT(*) AS n FROM citations WHERE target_id = 'maren-kest'");
    const takeRowsBefore = count("SELECT COUNT(*) AS n FROM take_sheets WHERE sheet_id = 'maren-kest'");
    const versionBefore = store.getBundle().sheets.find((s) => s.id === "maren-kest")!.version;
    assert.ok(citationsBefore > 0 && takeRowsBefore > 0, "the fixture gives us something to lose");
    assert.equal(
      (index.db.prepare("SELECT owner_production AS o FROM entities WHERE id = 'maren-kest'").get() as { o: string | null }).o,
      "saltlight",
    );

    const staged = await stageGuestPromotion(store, gate, { path: "characters/maren-kest.md" });
    assert.equal((await gate.accept(staged.id)).status, "accepted");

    const after = store.getBundle().sheets.find((s) => s.id === "maren-kest")!;
    assert.equal(after.production, undefined, "the world owns her now");
    assert.equal(after.id, "maren-kest", "the slug never moves — this is the whole design");
    assert.equal(after.version, versionBefore + 1, "promotion is a real change and cuts a version");
    assert.equal(after.voice?.provider, "elevenlabs", "everything else on the sheet is untouched");

    // The file did not move, and the key is gone rather than emptied.
    const raw = await readFile(join(dir, "characters", "maren-kest.md"), "utf8");
    assert.ok(!raw.includes("production:"), "absent, not empty — an empty owner is a guest of nothing");

    const freshIndex = store.getIndex()!;
    const freshCount = (sql: string) => (freshIndex.db.prepare(sql).get() as { n: number }).n;
    assert.equal(freshCount("SELECT COUNT(*) AS n FROM citations WHERE target_id = 'maren-kest'"), citationsBefore);
    assert.equal(freshCount("SELECT COUNT(*) AS n FROM take_sheets WHERE sheet_id = 'maren-kest'"), takeRowsBefore);
    assert.equal(
      (freshIndex.db.prepare("SELECT owner_production AS o FROM entities WHERE id = 'maren-kest'").get() as {
        o: string | null;
      }).o,
      null,
    );
    // The kit is keyed by slug, so it needed no migration to stay correct.
    assert.ok(
      store.getBundle().referenceKits.some((k) => k.sheetId === "maren-kest"),
      "the reference kit is still hers",
    );
    await store.close();
  });

  it("refuses to promote a sheet the world already owns", async () => {
    const { store, gate } = await open();
    await assert.rejects(
      () => stageGuestPromotion(store, gate, { path: "characters/maren-kest.md" }),
      /not a guest/,
      "there is no such thing as promoting twice",
    );
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// R-17 · the index
// ---------------------------------------------------------------------------

describe("the derived index records scope (R-17, D1)", () => {
  it("carries owner_production on the sheet row, and null for the world's own", async () => {
    const dir = await makeTempWorld();
    await writeGuest(dir, { id: "the-barman", name: "The barman", production: "saltlight" });
    const store = await openAt(dir);
    const rows = store
      .getIndex()!
      .db.prepare("SELECT id, owner_production AS owner FROM entities WHERE id IN ('the-barman','maren-kest') ORDER BY id")
      .all() as Array<{ id: string; owner: string | null }>;
    assert.deepEqual(rows, [
      { id: "maren-kest", owner: null },
      { id: "the-barman", owner: "saltlight" },
    ]);
    await store.close();
  });

  /**
   * The trap this design was shaped to avoid. `applyCommit` deletes every entity row carrying
   * the changed production's `production_id` and re-inserts only scenes, shots and takes. A
   * guest filed under that column would vanish on an unrelated scene edit and stay gone until
   * the next cold rebuild — untouched on disk, missing from every query.
   */
  it("survives a commit to its own production's files", async () => {
    const dir = await makeTempWorld();
    await writeGuest(dir, { id: "the-barman", name: "The barman", production: "saltlight" });
    const store = await openAt(dir);
    const index = store.getIndex()!;
    const present = () =>
      (index.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE id = 'the-barman'").get() as { n: number }).n;
    assert.equal(present(), 1);

    // try/finally, not a trailing close: an assertion that throws here would otherwise leave the
    // store — and SQLite's handle — open, and an open WorldStore hangs the whole test runner
    // rather than failing this one test.
    try {
      const scenePath = "productions/saltlight/scenes/02-the-tables-say-neap.json";
      const raw = await readFile(join(dir, scenePath), "utf8");
      const scene = JSON.parse(raw) as { version: number };
      await store.commit({
        kind: "scene-edit",
        source: "form",
        files: [
          {
            path: scenePath,
            action: "replace",
            content: JSON.stringify({ ...scene, version: scene.version + 1 }, null, 2) + "\n",
            baseHash: sha256(raw),
          },
        ],
      });

      assert.equal(present(), 1, "a scene edit is not a reason for a guest to leave the index");
      assert.equal(
        (index.db.prepare("SELECT owner_production AS o FROM entities WHERE id = 'the-barman'").get() as {
          o: string | null;
        }).o,
        "saltlight",
        "and it still knows whose it is",
      );
    } finally {
      await store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// R-12 · extraction
// ---------------------------------------------------------------------------

describe("extraction from a scoped artifact (R-12, D8)", () => {
  const SOURCE = "The barman pours without being asked. The tide runs backwards on the third night.";
  const raw: RawCandidate[] = [
    {
      kind: "character",
      name: "The barman",
      body: "Pours without being asked.",
      section: "Essence",
      quote: "The barman pours without being asked.",
    },
    {
      kind: "canon",
      name: "The third night",
      body: "The tide runs backwards on the third night.",
      quote: "The tide runs backwards on the third night.",
    },
  ];

  it("offers sheets and refuses canon, counting the refusal rather than hiding it", () => {
    const batch = verifyCandidates(raw, SOURCE, [], "saltlight");
    assert.deepEqual(batch.verified.map((c) => c.kind), ["character"]);
    assert.equal(batch.droppedCount, 1);
    assert.match(batch.droppedReasons[0]!, /canon cannot be proposed from an artifact owned by saltlight/);
  });

  it("the same document filed at world scope reaches canon again", () => {
    const batch = verifyCandidates(raw, SOURCE, []);
    assert.deepEqual(batch.verified.map((c) => c.kind).sort(), ["canon", "character"]);
    assert.equal(batch.droppedCount, 0);
  });

  it("scoping does not weaken quote verification", () => {
    const fabricated: RawCandidate[] = [
      { kind: "character", name: "Nobody", body: "Invented.", section: "Essence", quote: "a line that is not there" },
    ];
    const batch = verifyCandidates(fabricated, SOURCE, [], "saltlight");
    assert.deepEqual(batch.verified, []);
    assert.equal(batch.droppedCount, 1);
  });
});
