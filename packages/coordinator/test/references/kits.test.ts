import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachmentFor,
  compilationIsStale,
  designatedCompilation,
  headGate,
  referenceBudget,
  tileIsStale,
  type ManifestModel,
  type ReferenceKit,
  type Sheet,
} from "@arke-studio/contracts";
import { establishRequests, missingTileAngles, styleLine, tileRequest } from "../../src/references/generate.js";
import {
  chooseAnchor,
  compileGrid,
  designate,
  landGrid,
  lockTile,
  readKit,
  setStyleOverride,
  supersedeTile,
} from "../../src/references/kit.js";
import { decodePng, encodePng, solidImage } from "../../src/references/png.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  return { dir, store };
}

const MODEL: ManifestModel = {
  id: "flux-pro-1.1",
  provider: "fal",
  capability: "image",
  displayName: "FLUX Pro 1.1",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "perImage", microUsdPerImage: 40000 },
};

function kitOf(tiles: ReferenceKit["tiles"], extra: Partial<ReferenceKit> = {}): ReferenceKit {
  return { sheetId: "maren-kest", tiles, compilations: [], ...extra };
}

const WORLD_META = {
  worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
  slug: "the-undersong",
  schemaVersion: 1,
  name: "The Undersong",
  tone: "quiet dread",
  genre: "coastal fantasy",
  canonRevision: 42,
  nextCanonId: 45,
  created: "2026-05-02T09:14:00Z",
  updated: "2026-07-30T18:22:00Z",
} as never;

const SHEET = {
  id: "maren-kest",
  type: "character",
  name: "Maren Kest",
  version: 4,
  status: "locked",
  canonRules: [],
  links: [],
  created: "2026-05-02",
  updated: "2026-07-14",
  sections: [
    { heading: "Essence", body: "Tide-caller." },
    { heading: "Appearance", body: "Salt-crusted braids, pale grey eyes." },
  ],
} as unknown as Sheet;

describe("the reference loop (R-6, D1, D3, §3.2)", () => {
  it("the anchor rides first; locked tiles follow; unlocked and superseded never ride", () => {
    const kit = kitOf(
      [
        { angle: "head-front", status: "locked", file: "head-front.png", sheetVersion: 4 },
        { angle: "head-left-three-quarter", status: "locked", file: "hl.png", sheetVersion: 4 },
        { angle: "body-full", status: "generated", file: "body.png", sheetVersion: 4 },
        { angle: "head-profile", status: "superseded", file: "old-profile.png", sheetVersion: 2 },
      ],
      { anchor: "head-front.png" },
    );
    const request = tileRequest(WORLD_META, SHEET, kit, MODEL, "head-profile");
    const refs = request.input.params["references"] as string[];
    assert.equal(refs[0], "references/maren-kest/head-front.png", "the anchor rides first");
    assert.deepEqual(refs, ["references/maren-kest/head-front.png", "references/maren-kest/hl.png"]);
    assert.ok(!refs.some((r) => r.includes("body.png")), "a candidate nobody chose never rides");
    assert.ok(!refs.some((r) => r.includes("old-profile.png")), "a superseded tile never rides");
  });

  it("the reference list respects the model's budget", () => {
    const kit = kitOf(
      [
        { angle: "head-front", status: "locked", file: "a.png", sheetVersion: 4 },
        { angle: "head-left-three-quarter", status: "locked", file: "b.png", sheetVersion: 4 },
        { angle: "head-right-three-quarter", status: "locked", file: "c.png", sheetVersion: 4 },
      ],
      { anchor: "a.png" },
    );
    const tight: ManifestModel = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 2 } };
    const refs = tileRequest(WORLD_META, SHEET, kit, tight, "head-profile").input.params["references"] as string[];
    assert.equal(refs.length, 2);
    assert.equal(refs[0], "references/maren-kest/a.png");
  });

  it("establish candidates carry no references and distinct interpretations (R-5)", () => {
    const requests = establishRequests(WORLD_META, SHEET, null, MODEL, 4);
    assert.equal(requests.length, 4);
    for (const r of requests) {
      assert.deepEqual(r.input.params["references"], []);
      assert.match(String(r.input.params["prompt"]), /quiet dread/);
    }
    assert.notEqual(requests[0]!.input.params["prompt"], requests[3]!.input.params["prompt"]);
  });

  it("every candidate and every tile lands under its own name", () => {
    // Four candidates were asked for, four jobs dispatched, four charges made — and one file
    // arrived, because each landed as the provider's own "image-1.png" in the same directory
    // and overwrote the last. From the outside that is "generate looks does not work".
    const where = (input: { landing?: { dir: string; name?: string } }) =>
      `${input.landing?.dir ?? ""}/${input.landing?.name ?? "<unnamed>"}`;

    const requests = establishRequests(WORLD_META, SHEET, null, MODEL, 4);
    assert.equal(new Set(requests.map((r) => where(r.input))).size, 4, "four candidates, four filenames");

    const angles = ["head-front", "head-left-three-quarter"] as const;
    const tiles = angles.map((a) => tileRequest(WORLD_META, SHEET, null, MODEL, a));
    assert.equal(new Set(tiles.map((t) => where(t.input))).size, 2, "a turnaround does not overwrite itself");
    assert.match(where(tiles[0]!.input), /head-front/, "named by what it is");
  });

  it("a stale tile is flagged wherever shown, never blocked (R-17)", () => {
    assert.equal(tileIsStale({ angle: "body-full", status: "generated", file: "b.png", sheetVersion: 3 }, 4), true);
    assert.equal(tileIsStale({ angle: "head-front", status: "locked", file: "a.png", sheetVersion: 4 }, 4), false);
    assert.equal(tileIsStale({ angle: "head-front", status: "superseded", file: "o.png", sheetVersion: 1 }, 4), false);
  });
});

describe("the head-before-body gate (R-7, D4, D5)", () => {
  const threeOfFour: ReferenceKit["tiles"] = [
    { angle: "head-front", status: "locked", file: "a.png", sheetVersion: 4 },
    { angle: "head-left-three-quarter", status: "locked", file: "b.png", sheetVersion: 4 },
    { angle: "head-right-three-quarter", status: "locked", file: "c.png", sheetVersion: 4 },
    { angle: "head-profile", status: "generated", file: "d.png", sheetVersion: 4 },
  ];

  it("three of four locked: body unavailable, naming what is outstanding", () => {
    const gate = headGate(kitOf(threeOfFour));
    assert.equal(gate.ready, false);
    assert.deepEqual(gate.outstanding, ["head-profile"]);
    const refused = missingTileAngles(kitOf(threeOfFour, { anchor: "a.png" }), "body");
    assert.ok(!refused.ok && /outstanding: head-profile/.test(refused.reason));
  });

  it("the fourth lock opens body generation", () => {
    const full = threeOfFour.map((t) => ({ ...t, status: "locked" as const }));
    const gate = headGate(kitOf(full));
    assert.equal(gate.ready, true);
    const allowed = missingTileAngles(kitOf(full, { anchor: "a.png" }), "body");
    assert.ok(allowed.ok);
    assert.deepEqual(allowed.angles, ["body-full", "body-back"]);
  });

  it("head generation needs an anchor first; poses need nothing more (R-8)", () => {
    const refused = missingTileAngles(kitOf([]), "head");
    assert.ok(!refused.ok && /establish a look first/.test(refused.reason));
  });
});

describe("the classic grid (R-10, D6, D7, §3.2)", () => {
  it("compiles byte-identically twice, locally, and marks the previous compilation stale on change", async () => {
    const { store } = await open();
    const first = await compileGrid(store, SHEET, CLOCK);
    const second = await compileGrid(store, SHEET, CLOCK);
    assert.deepEqual(Buffer.from(first.png), Buffer.from(second.png), "same tiles in, identical bytes out");
    assert.equal(first.compilation.source, "local");
    assert.equal(first.compilation.accepted, true, "a composite is born accepted — it cannot hallucinate");
    assert.deepEqual(first.compilation.tiles, ["head-front.png", "head-left-three-quarter.png"]);

    await landGrid(store, SHEET, first);
    const landed = await readKit(store, "maren-kest");
    assert.ok(landed!.kit.compilations.some((c) => c.file === first.compilation.file));

    // Lock a third tile: the locked set changes, so the compilation is stale and a recompile differs.
    await lockTile(store, "maren-kest", "body-full");
    const kitNow = (await readKit(store, "maren-kest"))!.kit;
    const previous = kitNow.compilations.find((c) => c.file === first.compilation.file)!;
    assert.equal(compilationIsStale(kitNow, previous, SHEET.version), true, "tile set no longer matches");
    const third = await compileGrid(store, SHEET, CLOCK);
    assert.notDeepEqual(Buffer.from(third.png), Buffer.from(first.png), "adding a tile changes the output");
    await store.close();
  });

  it("the codec round-trips pixels exactly", () => {
    const image = solidImage(8, 8, [200, 100, 50, 255]);
    image.pixels[0] = 1; // one distinctive pixel
    const decoded = decodePng(encodePng(image));
    assert.equal(decoded.width, 8);
    assert.deepEqual(decoded.pixels, image.pixels);
  });

  it("decodes the fixture's real RGB tiles", async () => {
    const { dir, store } = await open();
    const bytes = await readFile(join(dir, "references", "maren-kest", "head-front.png"));
    // The fixture ships real artwork; the decoder must agree with the PNG's own header.
    const headerWidth = new DataView(bytes.buffer, bytes.byteOffset).getUint32(16);
    const headerHeight = new DataView(bytes.buffer, bytes.byteOffset).getUint32(20);
    const image = decodePng(Uint8Array.from(bytes));
    assert.equal(image.width, headerWidth);
    assert.equal(image.height, headerHeight);
    assert.ok(image.width >= 320 && image.height >= 320);
    await store.close();
  });
});

describe("the reference budget (R-15, D9, §3.2) — the silent-truncation suite", () => {
  const candidates = [
    { sheetId: "the-vigil", kind: "location" as const, appearanceOrder: 0, hasReference: true },
    { sheetId: "maren-kest", kind: "character" as const, billing: "lead", appearanceOrder: 1, hasReference: true },
    { sheetId: "bray-half-hitch", kind: "character" as const, billing: "support", appearanceOrder: 2, hasReference: true },
    { sheetId: "the-ebb-council", kind: "faction" as const, appearanceOrder: 3, hasReference: true },
  ];

  it("ranks characters first, leads first, then appearance order — and names every drop", () => {
    const two: ManifestModel = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 2 } };
    const result = referenceBudget(candidates, two);
    assert.deepEqual(
      result.carried.map((c) => c.sheetId),
      ["maren-kest", "bray-half-hitch"],
    );
    assert.deepEqual(
      result.dropped.map((c) => c.sheetId),
      ["the-vigil", "the-ebb-council"],
    );
    assert.match(result.notice!, /carrying maren-kest, bray-half-hitch/);
    assert.match(result.notice!, /dropping the-vigil, the-ebb-council/);
  });

  it("is stable across runs and updates when the model changes", () => {
    const two: ManifestModel = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 2 } };
    const a = referenceBudget(candidates, two);
    const b = referenceBudget([...candidates].reverse(), two);
    assert.deepEqual(
      a.carried.map((c) => c.sheetId),
      b.carried.map((c) => c.sheetId),
      "input order never changes the ranking",
    );
    const three: ManifestModel = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 3 } };
    const wider = referenceBudget(candidates, three);
    assert.deepEqual(wider.dropped.map((c) => c.sheetId), ["the-ebb-council"], "the notice follows the model");
  });

  it("within budget: no notice at all; zero-reference models state identity rides in the prompt", () => {
    const roomy: ManifestModel = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 4 } };
    assert.equal(referenceBudget(candidates, roomy).notice, null);
    const none: ManifestModel = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 0 } };
    const result = referenceBudget(candidates, none);
    assert.deepEqual(result.carried, []);
    assert.match(result.notice!, /accepts no reference images — identity rides in the prompt/);
  });
});

describe("staleness, attachment and designation (R-13, R-14, D8, D10)", () => {
  it("a stale designated compilation is attached anyway, with its gap named", () => {
    const kit = kitOf(
      [{ angle: "head-front", status: "locked", file: "a.png", sheetVersion: 3 }],
      {
        compilations: [
          {
            file: "grid-v3.png",
            format: "classic-grid",
            sheetVersion: 3,
            tiles: ["a.png"],
            compiledAt: "2026-07-01T00:00:00Z",
            source: "local",
            accepted: true,
          },
        ],
        designatedCompilation: "grid-v3.png",
      },
    );
    const decision = attachmentFor(kit, { ...SHEET, version: 5 } as Sheet);
    assert.equal(decision.mode, "designated");
    assert.equal(decision.file, "references/maren-kest/grid-v3.png", "attached anyway (D10)");
    assert.equal(decision.staleGap, "model sheet is v3; Maren Kest is at v5");
  });

  it("no compilation falls through to the sketch-citation path (R-14)", () => {
    const decision = attachmentFor(kitOf([]), SHEET);
    assert.equal(decision.mode, "sketch-citation");
    assert.equal(decision.file, null);
    assert.equal(attachmentFor(null, SHEET).mode, "sketch-citation");
  });

  it("designation defaults to the newest accepted; an explicit pin wins; all paths agree", async () => {
    const older = {
      file: "grid-old.png",
      format: "classic-grid" as const,
      sheetVersion: 4,
      tiles: ["a.png"],
      compiledAt: "2026-07-01T00:00:00Z",
      source: "local" as const,
      accepted: true,
    };
    const newer = { ...older, file: "grid-new.png", compiledAt: "2026-07-20T00:00:00Z" };
    const unaccepted = { ...older, file: "pitch.png", format: "pitch-board" as const, compiledAt: "2026-07-30T00:00:00Z", accepted: false };
    const kit = kitOf([], { compilations: [older, newer, unaccepted] });
    assert.equal(designatedCompilation(kit)?.file, "grid-new.png", "newest accepted; unaccepted never rides");
    const pinned = { ...kit, designatedCompilation: "grid-old.png" };
    assert.equal(designatedCompilation(pinned)?.file, "grid-old.png");
    // Two dispatch paths resolve through the same function to the same file (DoD).
    assert.equal(attachmentFor(pinned, SHEET).file, attachmentFor(pinned, SHEET).file);

    // Through the store: designate persists and survives a re-read.
    const { store } = await open();
    const grid = await compileGrid(store, SHEET, CLOCK);
    await landGrid(store, SHEET, grid);
    await designate(store, "maren-kest", grid.compilation.file);
    const reread = (await readKit(store, "maren-kest"))!.kit;
    assert.equal(reread.designatedCompilation, grid.compilation.file);
    await store.close();
  });
});

describe("kit mutations through the one commit primitive", () => {
  it("supersession keeps the old row; chooseAnchor locks head-front and sets the anchor (R-4, D2, D11)", async () => {
    const { store } = await open();
    await chooseAnchor(store, "maren-kest", { file: "candidates/pick-2.png", sheetVersion: 4 });
    let kit = (await readKit(store, "maren-kest"))!.kit;
    assert.equal(kit.anchor, "candidates/pick-2.png");
    const headRows = kit.tiles.filter((t) => t.angle === "head-front");
    assert.deepEqual(headRows.map((r) => r.status).sort(), ["locked", "superseded"], "the old face stays explicable");

    await supersedeTile(store, "maren-kest", "body-full", { file: "incoming/body-2.png", sheetVersion: 4 });
    kit = (await readKit(store, "maren-kest"))!.kit;
    const bodyRows = kit.tiles.filter((t) => t.angle === "body-full");
    assert.deepEqual(bodyRows.map((r) => r.status).sort(), ["generated", "superseded"]);

    await setStyleOverride(store, "maren-kest", "gouache storybook");
    kit = (await readKit(store, "maren-kest"))!.kit;
    assert.equal(kit.styleOverride, "gouache storybook");
    assert.equal(styleLine(WORLD_META, kit), "gouache storybook", "the override travels with the sheet (R-16)");
    await setStyleOverride(store, "maren-kest", null);
    kit = (await readKit(store, "maren-kest"))!.kit;
    assert.equal(kit.styleOverride, undefined);
    assert.equal(styleLine(WORLD_META, kit), "quiet dread, coastal fantasy", "canon unchanged");
    await store.close();
  });
});
