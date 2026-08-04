import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachmentFor,
  compilationIsStale,
  designatedCompilation,
  headGate,
  mainPhotoFor,
  mainPhotoGate,
  referenceBudget,
  tileIsStale,
  type ManifestModel,
  type ReferenceKit,
  type Sheet,
  type Take,
} from "@arke-studio/contracts";
import {
  characterLookRequests,
  characterSheetRequest,
  establishRequests,
  mainPhotoRequests,
  missingTileAngles,
  styleLine,
  tileRequest,
} from "../../src/references/generate.js";
import {
  acceptCharacterLook,
  acceptCharacterSheet,
  attachCharacterLook,
  chooseAnchor,
  compileGrid,
  designate,
  landGrid,
  lockTile,
  readKit,
  promoteCharacterLook,
  setStyleOverride,
  supersedeTile,
} from "../../src/references/kit.js";
import { decodePng, encodePng, solidImage } from "../../src/references/png.js";
import { WorldStore } from "../../src/world/store.js";
import {
  pendingReferenceTake,
  recordReferenceReview,
  recordReferenceTake,
  referenceReviewDecision,
} from "../../src/references/takes.js";
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

const PER_MEGAPIXEL_MODEL: ManifestModel = {
  ...MODEL,
  id: "flux-2-pro",
  displayName: "Flux 2 Pro",
  pricing: { kind: "perMegapixel", microUsdPerMegapixel: 30000 },
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

const DIRECTION = {
  version: 3,
  description: "Painterly, tidal, restrained.",
  masterLook: "world-art.png",
  acceptedAt: "2026-07-18T10:00:00Z",
  history: [],
  derived: false,
  reach: { visualAssets: 1, referenceKits: 1, productions: 1, earlierAcceptedTakes: 0 },
  overrides: [],
};

describe("the reference loop (R-6, D1, D3, §3.2)", () => {
  it("separates identity from style and never carries the world's subject as a reference", () => {
    const kit = kitOf([], {
      anchor: "main-photo.png",
      mainPhoto: { file: "main-photo.png", source: "generated", sheetVersion: 4 },
    });
    const sheetRequest = characterSheetRequest(WORLD_META, DIRECTION, SHEET, kit, MODEL, "g1");
    assert.deepEqual(sheetRequest.input.params["references"], ["references/maren-kest/main-photo.png"]);
    assert.deepEqual(sheetRequest.input.params["referenceRoles"], [
      { file: "references/maren-kest/main-photo.png", role: "identity" },
    ]);
    assert.ok(!(sheetRequest.input.params["references"] as string[]).includes("world-art.png"));
    assert.match(String(sheetRequest.input.params["prompt"]), /Painterly, tidal, restrained/);

    const textOnly = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 0 } };
    const fallback = characterSheetRequest(WORLD_META, DIRECTION, SHEET, kit, textOnly, "g0");
    assert.deepEqual(fallback.input.params["references"], []);
    assert.equal(
      (fallback.input.params["artDirection"] as { identityTransport: string }).identityTransport,
      "text",
    );

    const mainRequests = mainPhotoRequests(WORLD_META, DIRECTION, SHEET, null, MODEL, {
      prompt: "A clear portrait.",
      count: 2,
      identityReferences: [],
      generationKey: "g2",
    });
    assert.equal(mainRequests.length, 2);
    assert.deepEqual(mainRequests[0]!.input.params["references"], []);
    assert.equal((mainRequests[0]!.input.params["artDirection"] as { transport: string }).transport, "text");
  });

  it("uses explicit output sizes and non-zero estimates for every character image workflow", () => {
    const kit = kitOf([], {
      anchor: "main-photo.png",
      mainPhoto: { file: "main-photo.png", source: "generated", sheetVersion: 4 },
    });
    const main = mainPhotoRequests(WORLD_META, DIRECTION, SHEET, kit, PER_MEGAPIXEL_MODEL, {
      prompt: "A clear portrait.",
      count: 4,
      identityReferences: [],
      generationKey: "priced-main",
    });
    const sheet = characterSheetRequest(WORLD_META, DIRECTION, SHEET, kit, PER_MEGAPIXEL_MODEL, "priced-sheet");
    const looks = characterLookRequests(WORLD_META, DIRECTION, SHEET, kit, PER_MEGAPIXEL_MODEL, {
      kind: "costume",
      mode: "stay-close",
      prompt: "Council coat",
      count: 4,
      generationKey: "priced-looks",
    });
    for (const request of [...main, sheet, ...looks]) {
      assert.ok(request.estimatedMicroUsd > 0);
      assert.deepEqual(request.input.estimatedMicroUsd, request.estimatedMicroUsd);
      assert.ok(request.input.params["output"]);
    }
    assert.equal(main.reduce((total, request) => total + request.estimatedMicroUsd, 0), main[0]!.estimatedMicroUsd * 4);
    assert.equal(looks.reduce((total, request) => total + request.estimatedMicroUsd, 0), looks[0]!.estimatedMicroUsd * 4);
  });

  it("refuses positively priced character work when the selected parameters cannot be estimated", () => {
    const unpriceable: ManifestModel = {
      ...MODEL,
      pricing: { kind: "perSecond", microUsdPerSecond: 10000 },
    };
    assert.throws(
      () =>
        mainPhotoRequests(WORLD_META, DIRECTION, SHEET, null, unpriceable, {
          prompt: "A clear portrait.",
          count: 1,
          identityReferences: [],
          generationKey: "unpriceable",
        }),
      /could not be priced/,
    );
  });

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

  it("spends one slot per character before a second slot on the lead", () => {
    const threeCharacters = [
      {
        sheetId: "maren-kest",
        kind: "character" as const,
        billing: "lead",
        appearanceOrder: 0,
        hasReference: true,
        hasSecondaryReference: true,
      },
      {
        sheetId: "bray-half-hitch",
        kind: "character" as const,
        billing: "support",
        appearanceOrder: 1,
        hasReference: true,
        hasSecondaryReference: true,
      },
      {
        sheetId: "the-chorister",
        kind: "character" as const,
        billing: "support",
        appearanceOrder: 2,
        hasReference: true,
        hasSecondaryReference: true,
      },
    ];
    const three: ManifestModel = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 3 } };
    const result = referenceBudget(threeCharacters, three);
    assert.deepEqual(
      result.carried.map((candidate) => `${candidate.sheetId}:${candidate.referenceRole}`),
      ["maren-kest:primary", "bray-half-hitch:primary", "the-chorister:primary"],
    );
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
  it("uses the sheet for one slot, photo plus sheet for two, and photo alone before a sheet", () => {
    const direct = kitOf([], {
      anchor: "main-photo.png",
      mainPhoto: { file: "main-photo.png", source: "generated", sheetVersion: 4 },
      compilations: [
        {
          file: "character-sheet.png",
          format: "character-sheet",
          sheetVersion: 4,
          tiles: [],
          compiledAt: CLOCK(),
          source: "jb_01J8E0000000000000000000J2",
          accepted: true,
          anchorFile: "main-photo.png",
        },
      ],
      designatedCompilation: "character-sheet.png",
    });
    assert.equal(attachmentFor(direct, SHEET).file, "references/maren-kest/character-sheet.png");
    assert.equal(
      attachmentFor(direct, SHEET, "secondary").file,
      "references/maren-kest/main-photo.png",
    );

    const photoOnly = kitOf([], {
      anchor: "main-photo.png",
      mainPhoto: { file: "main-photo.png", source: "upload", sheetVersion: 4 },
    });
    assert.equal(attachmentFor(photoOnly, SHEET).file, "references/maren-kest/main-photo.png");
    assert.equal(mainPhotoGate(photoOnly).ready, true);
    assert.equal(mainPhotoFor(photoOnly)?.file, "main-photo.png");
  });

  it("marks a direct character sheet stale when the main photo changes", () => {
    const direct = kitOf([], {
      mainPhoto: { file: "main-photo-v2.png", source: "promotion", sheetVersion: 4 },
      compilations: [
        {
          file: "character-sheet.png",
          format: "character-sheet",
          sheetVersion: 4,
          tiles: [],
          compiledAt: CLOCK(),
          source: "jb_01J8E0000000000000000000J2",
          accepted: true,
          anchorFile: "main-photo-v1.png",
        },
      ],
    });
    assert.equal(compilationIsStale(direct, direct.compilations[0]!, 4), true);
  });

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
  it("resolves pending reference takes by id when media basenames collide", () => {
    const first = {
      id: "tk_01J8A0000000000000000000R1",
      kind: "sheet",
      reference: { sheetId: "maren-kest" },
      media: "character-sheet.png",
    } as Take;
    const second = {
      id: "tk_01J8A0000000000000000000R2",
      kind: "sheet",
      reference: { sheetId: "maren-kest" },
      media: "character-sheet.png",
    } as Take;
    assert.equal(pendingReferenceTake([first, second], [], second.id, "maren-kest", "sheet")?.id, second.id);
    assert.equal(pendingReferenceTake([first, second], [], second.id, "the-chorister", "sheet"), null);
    assert.equal(pendingReferenceTake([first, second], [], second.id, "maren-kest", "look"), null);
    assert.equal(
      pendingReferenceTake(
        [first, second],
        [{ ts: CLOCK(), takeId: second.id, decision: "reject", by: "user" }],
        second.id,
        "maren-kest",
        "sheet",
      ),
      null,
    );
  });

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

  it("accepts a direct sheet, keeps looks optional, and promotion takes the anchor-replacement path", async () => {
    const { store } = await open();
    await chooseAnchor(store, "maren-kest", {
      file: "main-photo.png",
      jobId: "jb_01J8E0000000000000000000J1",
      sheetVersion: 4,
      artDirectionVersion: 3,
      acceptedAt: CLOCK(),
    });
    await acceptCharacterSheet(store, SHEET, {
      file: "character-sheet.png",
      takeId: "tk_01J8E0000000000000000000T2",
      sheetVersion: 4,
      anchorFile: "main-photo.png",
      artDirectionVersion: 3,
    });
    let kit = (await readKit(store, "maren-kest"))!.kit;
    assert.equal(kit.designatedCompilation, "character-sheet.png");
    assert.equal(kit.compilations.find((candidate) => candidate.file === "character-sheet.png")?.tiles.length, 0);

    await acceptCharacterLook(store, "maren-kest", {
      id: "council-coat",
      file: "looks/council-coat.png",
      kind: "costume",
      prompt: "Formal council coat",
      jobId: "jb_01J8E0000000000000000000J3",
      takeId: "tk_01J8E0000000000000000000T3",
      artDirectionVersion: 3,
    });
    kit = (await readKit(store, "maren-kest"))!.kit;
    assert.equal(kit.mainPhoto?.file, "main-photo.png", "accepting a look does not change identity");

    await attachCharacterLook(store, "maren-kest", "council-coat", {
      kind: "production",
      productionId: "saltlight",
    });
    assert.equal((await readKit(store, "maren-kest"))!.kit.looks?.[0]?.attachedTo?.kind, "production");

    await promoteCharacterLook(store, SHEET, "council-coat");
    kit = (await readKit(store, "maren-kest"))!.kit;
    assert.equal(kit.mainPhoto?.file, "looks/council-coat.png");
    assert.equal(compilationIsStale(kit, designatedCompilation(kit)!, SHEET.version), true);
    await store.close();
  });

  it("generates looks only after a main photo and carries it as identity", () => {
    const kit = kitOf([], {
      anchor: "main-photo.png",
      mainPhoto: { file: "main-photo.png", source: "generated", sheetVersion: 4 },
    });
    const requests = characterLookRequests(WORLD_META, DIRECTION, SHEET, kit, MODEL, {
      kind: "costume",
      mode: "stay-close",
      prompt: "Formal council coat",
      count: 4,
      generationKey: "g3",
    });
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[0]!.input.params["references"], ["references/maren-kest/main-photo.png"]);
  });

  it("records immutable reference takes and accepts review plus kit designation atomically", async () => {
    const { dir, store } = await open();
    const landed = "references/maren-kest/incoming/character-sheet-test.png";
    await mkdir(join(dir, "references", "maren-kest", "incoming"), { recursive: true });
    await writeFile(join(dir, landed), "generated-sheet-bytes");
    const job = {
      id: "jb_01J8E0000000000000000000J9",
      idempotencyKey: "01J8E1000000000000000000K9",
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      target: { kind: "character-sheet", id: "maren-kest/g9" },
      capability: "image",
      provider: "fal",
      model: "flux-pro-1.1",
      params: {
        prompt: "one composite",
        references: ["references/maren-kest/head-front.png"],
        artDirection: { version: 3 },
        provenance: {
          canonRevision: 42,
          sheets: { "maren-kest": 4 },
          artDirectionVersion: 3,
          anchorFile: "head-front.png",
        },
      },
      estimatedMicroUsd: 40000,
      status: "succeeded",
      providerJobId: "fal-g9",
      attempt: 1,
      landedFiles: [landed],
      error: null,
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    } as const;
    const take = await recordReferenceTake(store, job as never);
    assert.ok(take);
    assert.deepEqual(
      take.params,
      job.params,
      "non-main-photo takes keep what acceptance needs after the queue is gone",
    );
    const takePath = join(dir, "references", "maren-kest", "takes", take.id, "take.json");
    const before = await readFile(takePath);

    const review = referenceReviewDecision(store.now(), take, "accept");
    await acceptCharacterSheet(store, SHEET, {
      file: `takes/${take.id}/${take.media}`,
      takeId: take.id,
      sheetVersion: take.provenance.sheets["maren-kest"]!,
      anchorFile: (take.params["provenance"] as { anchorFile: string }).anchorFile,
      artDirectionVersion: 3,
      review,
    });
    const after = store.getBundle();
    assert.equal(after.referenceReviews.find((candidate) => candidate.takeId === take.id)?.decision, "accept");
    assert.equal(
      after.referenceKits.find((kit) => kit.sheetId === "maren-kest")?.designatedCompilation,
      `takes/${take.id}/${take.media}`,
    );
    assert.deepEqual(await readFile(takePath), before, "review never rewrites take.json");

    // The world moves after dispatch. Accepting this take must preserve what generated it and
    // remain stale against the newer sheet/photo rather than laundering it as current.
    await chooseAnchor(store, "maren-kest", {
      file: "new-main-photo.png",
      sheetVersion: 5,
      artDirectionVersion: 3,
      acceptedAt: CLOCK(),
    });
    const accepted = (await readKit(store, "maren-kest"))!.kit.compilations.find(
      (candidate) => candidate.file === `takes/${take.id}/${take.media}`,
    )!;
    assert.equal(accepted.sheetVersion, 4);
    assert.equal(accepted.anchorFile, "head-front.png");
    assert.equal(compilationIsStale((await readKit(store, "maren-kest"))!.kit, accepted, 5), true);

    const second = await recordReferenceTake(store, { ...job, id: "jb_01J8E0000000000000000000JA" } as never);
    assert.ok(second);
    await recordReferenceReview(store, second, "reject", { field: "identity", note: "profile drifted" });
    const final = store.getBundle();
    assert.equal(final.referenceReviews.find((candidate) => candidate.takeId === second.id)?.decision, "reject");
    assert.equal(
      final.referenceKits.find((kit) => kit.sheetId === "maren-kest")?.designatedCompilation,
      `takes/${take.id}/${take.media}`,
      "rejection leaves accepted identity untouched",
    );
    await store.close();
  });
});
