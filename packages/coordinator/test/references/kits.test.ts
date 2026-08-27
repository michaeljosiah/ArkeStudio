import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachmentFor,
  compilationIsStale,
  designatedCompilation,
  headGate,
  mainPhotoFor,
  mainPhotoGate,
  newId,
  orderedLocationViews,
  referenceBudget,
  tileIsStale,
  type AppSettings,
  type ManifestModel,
  type ModelManifest,
  type ReferenceKit,
  type Sheet,
  type Take,
} from "@arke-studio/contracts";
import {
  characterLookRequests,
  characterSheetRequest,
  establishRequests,
  imageModelFor,
  locationViewRequests,
  mainPhotoRequests,
  referenceBudgetFor,
  tierFor,
  missingTileAngles,
  styleLine,
  tileRequest,
} from "../../src/references/generate.js";
import {
  acceptCharacterLook,
  acceptCharacterSheet,
  acceptLocationView,
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
import { sha256 } from "../../src/world/text-files.js";
import { WorldStore } from "../../src/world/store.js";
import {
  pendingReferenceTake,
  recordReferenceReview,
  recordReferenceTake,
  recordUploadedCharacterSheetTake,
  referenceReviewDecision,
} from "../../src/references/takes.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

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
  audio: { music: "environmental-only" as const, subtitles: "never" as const },
  failureModes: [],
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
    assert.equal(sheetRequest.input.params["characterName"], "Maren Kest");
    assert.ok(!(sheetRequest.input.params["references"] as string[]).includes("world-art.png"));
    assert.match(String(sheetRequest.input.params["prompt"]), /Painterly, tidal, restrained/);

    const textOnly = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 0 } };
    assert.throws(
      () => characterSheetRequest(WORLD_META, DIRECTION, SHEET, kit, textOnly, "g0"),
      /cannot receive the accepted main photo/,
    );
    assert.throws(
      () =>
        characterLookRequests(WORLD_META, DIRECTION, SHEET, kit, textOnly, {
          kind: "costume",
          mode: "stay-close",
          prompt: "Council coat",
          count: 1,
          generationKey: "g0",
        }),
      /cannot receive the accepted main photo/,
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

  it("within budget: no notice at all; zero-reference models state images are omitted", () => {
    const roomy: ManifestModel = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 4 } };
    assert.equal(referenceBudget(candidates, roomy).notice, null);
    const none: ManifestModel = { ...MODEL, accepts: { ...MODEL.accepts, referenceImages: 0 } };
    const result = referenceBudget(candidates, none);
    assert.deepEqual(result.carried, []);
    assert.match(result.notice!, /accepts no reference images — those images are omitted/);
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

  it("never marks an uploaded sheet stale for a main photo it was never drawn from", () => {
    const uploaded = kitOf([], {
      mainPhoto: { file: "main-photo-v2.png", source: "upload", sheetVersion: 4 },
      compilations: [
        {
          file: "takes/tk_01J8E0000000000000000000T7/character-sheet-upload-a1.png",
          format: "character-sheet",
          sheetVersion: 4,
          tiles: [],
          compiledAt: CLOCK(),
          source: "tk_01J8E0000000000000000000T7",
          accepted: true,
        },
      ],
    });
    assert.equal(
      compilationIsStale(uploaded, uploaded.compilations[0]!, 4),
      false,
      "no anchor claimed, so no anchor to fall out of date",
    );
    // The one staleness an upload still answers to: the character's own text moved on.
    assert.equal(compilationIsStale(uploaded, uploaded.compilations[0]!, 5), true);
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

  /* One look per scope (design 67). The production's cast row offers one choice per character,
     and the resolver picks the first look whose scope matches — so two looks claiming the same
     production is a question with no answer, whichever way the row was driven. */
  it("displaces the look a production already held, and leaves other scopes alone", async () => {
    const { store } = await open();
    await chooseAnchor(store, "maren-kest", {
      file: "main-photo.png",
      jobId: "jb_01J8E0000000000000000000J1",
      sheetVersion: 4,
      artDirectionVersion: 3,
      acceptedAt: CLOCK(),
    });
    for (const [id, file] of [
      ["council-coat", "looks/council-coat.png"],
      ["storm-oilskin", "looks/storm-oilskin.png"],
    ] as const) {
      await acceptCharacterLook(store, "maren-kest", {
        id,
        file,
        kind: "costume",
        prompt: id,
        takeId: "tk_01J8E0000000000000000000T3",
        artDirectionVersion: 3,
      });
    }
    const held = async () =>
      Object.fromEntries(
        ((await readKit(store, "maren-kest"))!.kit.looks ?? []).map((look) => [look.id, look.attachedTo]),
      );

    await attachCharacterLook(store, "maren-kest", "council-coat", {
      kind: "production",
      productionId: "saltlight",
    });
    await attachCharacterLook(store, "maren-kest", "storm-oilskin", {
      kind: "production",
      productionId: "saltlight",
    });
    let scopes = await held();
    assert.equal(scopes["storm-oilskin"]?.kind, "production");
    assert.equal(scopes["council-coat"], undefined, "the incumbent is displaced, not joined");

    // A scene is a different scope, so it never displaces the production-wide choice.
    await attachCharacterLook(store, "maren-kest", "council-coat", {
      kind: "scene",
      productionId: "saltlight",
      sceneId: "sc_04",
    });
    scopes = await held();
    assert.equal(scopes["council-coat"]?.kind, "scene");
    assert.equal(scopes["storm-oilskin"]?.kind, "production", "the production keeps its own choice");
    await store.close();
  });

  /* Detaching empties the scope, it does not hand it to the next claimant (codex round 2). A
     world written before attaching displaced can hold two looks claiming one production, and
     clearing one of two left the row still showing a look after the reader asked for the
     identity package. */
  it("empties the scope a detached look was holding, legacy collision and all", async () => {
    const { store } = await open();
    await chooseAnchor(store, "maren-kest", {
      file: "main-photo.png",
      jobId: "jb_01J8E0000000000000000000J1",
      sheetVersion: 4,
      artDirectionVersion: 3,
      acceptedAt: CLOCK(),
    });
    for (const [id, file] of [
      ["council-coat", "looks/council-coat.png"],
      ["storm-oilskin", "looks/storm-oilskin.png"],
      ["winter-greys", "looks/winter-greys.png"],
    ] as const) {
      await acceptCharacterLook(store, "maren-kest", {
        id,
        file,
        kind: "costume",
        prompt: id,
        takeId: "tk_01J8E0000000000000000000T3",
        artDirectionVersion: 3,
      });
    }
    // The legacy state, written straight past the mutation that now forbids it.
    const loaded = (await readKit(store, "maren-kest"))!;
    const collided = loaded.kit.looks!.map((look) =>
      look.id === "winter-greys"
        ? look
        : { ...look, attachedTo: { kind: "production" as const, productionId: "saltlight" } },
    );
    await store.commit({
      kind: "reference.kit",
      source: "test",
      files: [
        {
          path: "references/maren-kest/kit.json",
          action: "replace",
          content: `${JSON.stringify({ ...loaded.kit, looks: collided }, null, 2)}\n`,
          baseHash: sha256(loaded.raw),
        },
      ],
    });

    await attachCharacterLook(store, "maren-kest", "council-coat", null);
    const after = (await readKit(store, "maren-kest"))!.kit.looks!;
    assert.deepEqual(
      after.filter((look) => look.attachedTo !== undefined).map((look) => look.id),
      [],
      "the production holds nothing, rather than falling back to the other claimant",
    );
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

  it("takes an uploaded character sheet without a provider, a cost, or the file the user picked", async () => {
    const { dir, store } = await open();
    const outside = join(await tempDir("arke-upload-"), "my-own-sheet.png");
    const bytes = new TextEncoder().encode("hand-drawn-sheet-bytes");
    await writeFile(outside, bytes);

    // Derived, never hardcoded: the fixture character's version moves, and a literal here would
    // fail somewhere unrelated to what this test is about.
    const live = store.getBundle().sheets.find((candidate) => candidate.id === "maren-kest")!;

    const take = await recordUploadedCharacterSheetTake(store, "maren-kest", "character-sheet-upload-a1.png", bytes);
    assert.equal(take.kind, "sheet");
    assert.equal(take.provider, "user");
    assert.equal(take.model, "upload");
    assert.deepEqual(take.cost, { estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "local-zero" });
    assert.equal(take.provenance.sheets["maren-kest"], live.version, "frozen at the version it came in against");
    const stored = join(dir, "references", "maren-kest", "takes", take.id, "character-sheet-upload-a1.png");
    assert.equal(await readFile(stored, "utf8"), "hand-drawn-sheet-bytes");
    assert.equal(await readFile(outside, "utf8"), "hand-drawn-sheet-bytes", "the user's own file is left alone");
    // Straight into the take, so there is no second copy loose in the world to explain.
    await assert.rejects(readFile(join(dir, "references", "maren-kest", "incoming", "character-sheet-upload-a1.png")));

    await acceptCharacterSheet(store, live, {
      file: `takes/${take.id}/${take.media}`,
      takeId: take.id,
      sheetVersion: live.version,
      artDirectionVersion: 3,
      review: referenceReviewDecision(store.now(), take, "accept"),
    });
    const kit = (await readKit(store, "maren-kest"))!.kit;
    const compilation = designatedCompilation(kit)!;
    assert.equal(compilation.file, `takes/${take.id}/${take.media}`);
    assert.equal(compilation.source, take.id);
    assert.equal(compilation.anchorFile, undefined, "an upload claims no lineage it does not have");
    assert.equal(
      store.getBundle().referenceReviews.find((candidate) => candidate.takeId === take.id)?.decision,
      "accept",
      "the human's own action reviews itself; nothing is left waiting",
    );

    // Replacing the identity afterwards must not tell the user to regenerate their own artwork.
    await chooseAnchor(store, "maren-kest", {
      file: "new-main-photo.png",
      sheetVersion: live.version,
      artDirectionVersion: 3,
      acceptedAt: CLOCK(),
    });
    const after = (await readKit(store, "maren-kest"))!.kit;
    assert.equal(compilationIsStale(after, designatedCompilation(after)!, live.version), false);
    await store.close();
  });

  it("gives each hand-carried sheet its own take, so a corrected export never keeps the old bytes", async () => {
    const { dir, store } = await open();
    const encode = (text: string) => new TextEncoder().encode(text);
    const first = await recordUploadedCharacterSheetTake(
      store,
      "maren-kest",
      "character-sheet-upload-a1.png",
      encode("first-export"),
    );
    const second = await recordUploadedCharacterSheetTake(
      store,
      "maren-kest",
      "character-sheet-upload-a2.png",
      encode("corrected-export"),
    );

    assert.notEqual(second.id, first.id, "the same path picked twice is two deliberate acts");
    assert.equal(
      await readFile(join(dir, "references", "maren-kest", "takes", second.id, second.media!), "utf8"),
      "corrected-export",
    );
    assert.equal(
      await readFile(join(dir, "references", "maren-kest", "takes", first.id, first.media!), "utf8"),
      "first-export",
      "and the earlier one stays explicable",
    );
    await store.close();
  });

  it("refuses a media name that is not a plain filename, and writes nothing when it does", async () => {
    const { dir, store } = await open();
    const takesDir = join(dir, "references", "maren-kest", "takes");
    const before = await readdir(takesDir).catch(() => []);
    // "." and ".." survive a basename check — basename("..") is ".." — and each names a directory
    // that already exists, so the write lands somewhere real rather than failing cleanly.
    for (const media of ["../../world.json", "..", ".", "a/b.png"]) {
      await assert.rejects(
        recordUploadedCharacterSheetTake(store, "maren-kest", media, new TextEncoder().encode("bytes")),
        /unsafe media name/,
        `"${media}" must be refused`,
      );
    }
    assert.deepEqual(await readdir(takesDir).catch(() => []), before, "and no take directory was made");
    await store.close();
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
    const ledgerEntry = {
      ts: CLOCK(),
      worldId: job.worldId,
      jobId: job.id,
      provider: job.provider,
      model: job.model,
      outcome: "succeeded" as const,
      estimatedMicroUsd: job.estimatedMicroUsd,
      actualMicroUsd: 38000,
      actualSource: "provider-reported" as const,
    };
    const take = await recordReferenceTake(store, job as never, ledgerEntry);
    assert.ok(take);
    assert.equal(take.id, `tk_${job.id.slice(3)}`);
    assert.deepEqual(take.cost, {
      estimatedMicroUsd: 40000,
      actualMicroUsd: 38000,
      actualSource: "provider-reported",
    });
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

    // Its own landing, because that is what a second job has: the landing names carry the
    // generation key precisely so two requests never write over one another. The directory is
    // re-created here for the same reason the dispatcher re-creates it — the first take took
    // its staging copy with it and left nothing behind (issue 231).
    const secondLanded = "references/maren-kest/incoming/character-sheet-ga.png";
    await mkdir(join(dir, "references", "maren-kest", "incoming"), { recursive: true });
    await writeFile(join(dir, secondLanded), "second-generated-sheet-bytes");
    const second = await recordReferenceTake(store, {
      ...job,
      id: "jb_01J8E0000000000000000000JA",
      landedFiles: [secondLanded],
    } as never);
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

describe("a per-generation model and size (SPEC-008, design turn 39)", () => {
  const TIERED: ManifestModel = {
    ...MODEL,
    id: "nano-banana-2",
    displayName: "Nano Banana 2",
    limits: { resolutions: ["1K", "2K", "4K"], tiers: { "1K": "1K", "2K": "2K", "4K": "4K" } },
    pricing: { kind: "perImage", microUsdPerImage: 80000, byResolution: { "4K": 160000 } },
  };
  const UNVERIFIED: ManifestModel = {
    ...MODEL,
    id: "seedream-4",
    displayName: "Seedream 4",
    accepts: { referenceImages: 8, startFrame: false, endFrame: false },
    limits: {},
    unverified: true,
    pricing: { kind: "perImage", microUsdPerImage: 40000 },
  };
  const SETTINGS = { models: { disabled: [] } } as unknown as AppSettings;
  const MANIFEST: ModelManifest = {
    manifestVersion: 1,
    generated: "2026-08-05",
    models: [MODEL, TIERED, UNVERIFIED],
  };

  it("the chosen tier reaches the job as the provider's own word for it", () => {
    const [request] = mainPhotoRequests(WORLD_META, DIRECTION, SHEET, null, TIERED, {
      prompt: "a portrait",
      count: 1,
      identityReferences: [],
      generationKey: "k",
      tier: "4K",
    });
    const output = request!.input.params["output"] as { resolution?: string };
    assert.equal(output.resolution, "4K");
    assert.equal(request!.estimatedMicroUsd, 160000, "the estimate follows the tier, not the first one");
  });

  it("a tier the model cannot reach falls back rather than promising it", () => {
    const [request] = mainPhotoRequests(WORLD_META, DIRECTION, SHEET, null, MODEL, {
      prompt: "a portrait",
      count: 1,
      identityReferences: [],
      generationKey: "k",
      tier: "4K",
    });
    const output = request!.input.params["output"] as { resolution?: string };
    assert.equal(output.resolution, undefined, "no tiers declared means no resolution claimed");
  });

  it("an unverified model runs at the floor: no references, no size", () => {
    assert.equal(referenceBudgetFor(UNVERIFIED), 0, "what it accepts was never checked");
    assert.equal(tierFor(UNVERIFIED, "2K"), undefined, "so the provider keeps its own default");
    assert.throws(
      () =>
        mainPhotoRequests(WORLD_META, DIRECTION, SHEET, null, UNVERIFIED, {
          prompt: "a portrait",
          count: 1,
          identityReferences: ["references/maren-kest/main.png"],
          generationKey: "k",
        }),
      /cannot receive identity reference images/,
    );
  });

  it("an override picks that model; an unavailable one is refused, never quietly swapped", () => {
    assert.equal(imageModelFor(SETTINGS, MANIFEST, "nano-banana-2")?.id, "nano-banana-2");
    assert.equal(imageModelFor(SETTINGS, MANIFEST, "no-such-model"), null);
    const off = { models: { disabled: ["nano-banana-2"] } } as unknown as AppSettings;
    assert.equal(imageModelFor(off, MANIFEST, "nano-banana-2"), null, "switched off is not a fallback");
    assert.equal(imageModelFor(SETTINGS, MANIFEST)?.id, MODEL.id, "no override means the routed default");
  });

  it("refuses a routed default that was switched off, for callers that pass no model at all", () => {
    // World key art, establish looks and missing tiles never pass an id — they went straight to
    // routing, so a model switched off in Providers kept taking paid work. Refused, not
    // replaced: choosing the substitute is the user's, and the fault is already named in
    // Who does what with both repairs.
    const off = {
      ...SETTINGS,
      models: { disabled: [MODEL.id] },
    } as unknown as AppSettings;
    assert.equal(imageModelFor(off, MANIFEST), null);
    assert.equal(imageModelFor(SETTINGS, MANIFEST)?.id, MODEL.id, "and is unaffected when it is on");
  });
});

// ---------------------------------------------------------------------------
// Location reference kits (#243, design turn 57). Every rule the turn made
// binding, exercised against a real store.
// ---------------------------------------------------------------------------

describe("standing failure modes ride every reference generation (#244, round 2)", () => {
  const MODES = { ...DIRECTION, failureModes: ["Hands stay whole and countable."] };
  const VIGIL = { id: "the-vigil", type: "location", name: "The Vigil", version: 3,
    sections: [{ heading: "Look", body: "A watchtower of black stone." }] } as unknown as Sheet;

  it("main photos, sheets, looks and location views all carry them; none invents one", () => {
    const photo = mainPhotoRequests(WORLD_META, MODES, SHEET, null, MODEL, {
      prompt: "A clear portrait.", count: 1, identityReferences: [], generationKey: "fm1",
    })[0]!;
    assert.match(String(photo.input.params["prompt"]), /Hands stay whole and countable\.$/);

    const kit = kitOf([], { anchor: "main-photo.png", mainPhoto: { file: "main-photo.png", source: "generated", sheetVersion: 4 } });
    const sheet = characterSheetRequest(WORLD_META, MODES, SHEET, kit, MODEL, "fm2");
    assert.match(String(sheet.input.params["prompt"]), /Hands stay whole and countable\.$/);

    const look = characterLookRequests(WORLD_META, MODES, SHEET, kit, MODEL, {
      kind: "costume", mode: "stay-close", prompt: "Council coat", count: 1, generationKey: "fm3",
    })[0]!;
    assert.match(String(look.input.params["prompt"]), /Hands stay whole and countable\.$/);

    const view = locationViewRequests(WORLD_META, MODES, VIGIL, null, MODEL, {
      name: "Establishing view", count: 1, generationKey: "fm4",
    })[0]!;
    assert.match(String(view.input.params["prompt"]), /Hands stay whole and countable\.$/);

    // The two builders I wrongly called unreachable last round (round 3's P2): the coordinator
    // dispatches both — establishRequests for initial character establishment, tileRequest for a
    // missing angle — so they spend money and must obey the same rules.
    const establish = establishRequests(WORLD_META, SHEET, null, MODEL, 1, MODES)[0]!;
    assert.match(String(establish.input.params["prompt"]), /Hands stay whole and countable\.$/);
    const tile = tileRequest(WORLD_META, SHEET, null, MODEL, "head-front", MODES);
    assert.match(String(tile.input.params["prompt"]), /Hands stay whole and countable\.$/);

    // And a world with none leaves the prompt exactly as it was — no trailing space, no empty
    // clause. The suffix is "" then, not " ".
    const bare = mainPhotoRequests(WORLD_META, DIRECTION, SHEET, null, MODEL, {
      prompt: "A clear portrait.", count: 1, identityReferences: [], generationKey: "fm5",
    })[0]!;
    assert.match(String(bare.input.params["prompt"]), /no text or montage\.$/);
  });
});

describe("location views and the sheet they assemble (#243)", () => {
  const VIGIL = { id: "the-vigil", name: "The Vigil", version: 3 } as unknown as Sheet;

  /**
   * A clock that moves, unlike the frozen one the rest of this file uses.
   *
   * Panel order is an ordering over acceptance instants, and under a frozen clock every view is
   * accepted at the same instant — so the order fell through to the id tie-break and these tests
   * passed without ever exercising the thing they are named after. A minute per acceptance is
   * enough to tell "ordered by when it happened" from "ordered by v1, v2, v3".
   */
  async function openTicking() {
    let minute = 0;
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, {
      clock: () => `2026-08-01T12:${String(minute++).padStart(2, "0")}:00.000Z`,
    });
    return { dir, store };
  }

  /** Write a distinguishable PNG where an accepted view file would live. */
  async function landView(dir: string, takeId: string, rgb: [number, number, number]): Promise<string> {
    const rel = `takes/${takeId}/view.png`;
    await mkdir(join(dir, "references", VIGIL.id, "takes", takeId), { recursive: true });
    await writeFile(
      join(dir, "references", VIGIL.id, rel),
      Buffer.from(encodePng(solidImage(640, 360, [rgb[0], rgb[1], rgb[2], 255]))),
    );
    return rel;
  }

  async function acceptView(
    store: WorldStore,
    dir: string,
    n: number,
    name: string,
    extra: { establishing?: boolean; replaceExistingName?: boolean } = {},
  ) {
    const takeId = newId("tk");
    const file = await landView(dir, takeId, [40 * n, 60, 200 - 20 * n]);
    await acceptLocationView(store, VIGIL, {
      id: `v${n}`,
      name,
      file,
      takeId,
      sheetVersion: 3,
      artDirectionVersion: 4,
      ...extra,
    });
  }

  it("makes the first accepted view the establishing one and designates a sheet", async () => {
    const { dir, store } = await openTicking();
    await acceptView(store, dir, 1, "Establishing view");

    const kit = (await readKit(store, VIGIL.id))!.kit;
    assert.equal(kit.locationViews?.length, 1);
    assert.equal(kit.establishingViewId, "v1", "the first angle is the anchor, whatever it is called");
    const sheet = kit.compilations.find((c) => c.format === "location-sheet")!;
    assert.equal(kit.designatedCompilation, sheet.file, "the sheet is what dispatch carries");
    assert.equal(sheet.source, "local", "assembled here — no provider, no cost");
    assert.equal(sheet.accepted, true);

    // The PNG exists beside the kit, and the designation names a file that is really there.
    const files = await readdir(join(dir, "references", VIGIL.id));
    assert.ok(files.includes(sheet.file), `expected ${sheet.file} on disk, saw ${files.join(", ")}`);
    await store.close();
  });

  it("keeps panel order establishing-first and rebuilds the sheet on every acceptance", async () => {
    const { dir, store } = await openTicking();
    await acceptView(store, dir, 1, "Establishing view");
    const first = (await readKit(store, VIGIL.id))!.kit.designatedCompilation;

    await acceptView(store, dir, 2, "Reverse angle");
    await acceptView(store, dir, 3, "Day");
    const kit = (await readKit(store, VIGIL.id))!.kit;

    const sheet = kit.compilations.find((c) => c.format === "location-sheet")!;
    assert.notEqual(kit.designatedCompilation, first, "a new view is a new sheet");
    assert.equal(
      kit.compilations.filter((c) => c.format === "location-sheet").length,
      1,
      "one sheet, replaced — not a pile",
    );
    assert.deepEqual(
      sheet.tiles,
      orderedLocationViews(kit).map((v) => v.file),
      "the compilation records exactly the panels it was built from, in order",
    );
    assert.deepEqual(orderedLocationViews(kit).map((v) => v.name), ["Establishing view", "Reverse angle", "Day"]);
    await store.close();
  });

  it("asks before replacing a name, then supersedes without reordering the rest", async () => {
    const { dir, store } = await openTicking();
    await acceptView(store, dir, 1, "Establishing view");
    await acceptView(store, dir, 2, "Reverse angle");
    await acceptView(store, dir, 3, "Day");

    // Unconfirmed: refused, and nothing moves.
    const before = (await readKit(store, VIGIL.id))!.kit;
    await assert.rejects(
      () => acceptView(store, dir, 4, "  reverse   ANGLE  "),
      /already an active view/,
      "case and spacing do not make it a different name",
    );
    assert.deepEqual((await readKit(store, VIGIL.id))!.kit, before, "a refusal leaves the kit exactly as it was");

    // Confirmed: the old record is superseded, kept, and the order of the others is untouched.
    await acceptView(store, dir, 4, "Reverse angle", { replaceExistingName: true });
    const kit = (await readKit(store, VIGIL.id))!.kit;
    const superseded = kit.locationViews!.filter((v) => v.status === "superseded");
    assert.deepEqual(superseded.map((v) => v.id), ["v2"], "history keeps the take that was replaced");
    assert.deepEqual(
      orderedLocationViews(kit).map((v) => v.name),
      ["Establishing view", "Reverse angle", "Day"],
      "the replacement inherits panel 2 from the view it superseded, and Day stays panel 3",
    );
    // Stated as the slot rather than as a position, because that is the invariant: a prompt that
    // already cited panel 2 is describing the same side of the room after the replacement.
    const replacement = kit.locationViews!.find((v) => v.id === "v4")!;
    const replaced = kit.locationViews!.find((v) => v.id === "v2")!;
    assert.equal(replacement.slotAt, replaced.acceptedAt, "the slot is inherited, not the timestamp");
    assert.notEqual(replacement.acceptedAt, replaced.acceptedAt, "while acceptedAt still says when it really arrived");
    await store.close();
  });

  it("replaces the establishing view without disturbing the additional ones", async () => {
    const { dir, store } = await openTicking();
    await acceptView(store, dir, 1, "Establishing view");
    await acceptView(store, dir, 2, "Reverse angle");
    await acceptView(store, dir, 3, "Day");

    await acceptView(store, dir, 4, "Establishing view", { establishing: true, replaceExistingName: true });
    const kit = (await readKit(store, VIGIL.id))!.kit;
    assert.equal(kit.establishingViewId, "v4");
    assert.equal(kit.locationViews!.find((v) => v.id === "v1")!.status, "superseded");
    assert.deepEqual(
      orderedLocationViews(kit).map((v) => v.name),
      ["Establishing view", "Reverse angle", "Day"],
      "a new anchor leads; the additional views keep the order they were accepted in",
    );
    await store.close();
  });

  it("refuses the seventh active view and leaves the sixth sheet standing", async () => {
    const { dir, store } = await openTicking();
    await acceptView(store, dir, 1, "Establishing view");
    for (let n = 2; n <= 6; n += 1) await acceptView(store, dir, n, `View ${n}`);

    const sixKit = (await readKit(store, VIGIL.id))!.kit;
    assert.equal(orderedLocationViews(sixKit).length, 6);

    await assert.rejects(() => acceptView(store, dir, 7, "View 7"), /already has 6 active views/);
    assert.deepEqual((await readKit(store, VIGIL.id))!.kit, sixKit, "the refusal costs the world nothing");

    // Replacing one of the six is still allowed — the ceiling counts what is left behind.
    await acceptView(store, dir, 8, "View 6", { replaceExistingName: true });
    assert.equal(orderedLocationViews((await readKit(store, VIGIL.id))!.kit).length, 6);
    await store.close();
  });

  it("a failed assembly changes nothing at all", async () => {
    const { dir, store } = await openTicking();
    await acceptView(store, dir, 1, "Establishing view");
    const before = (await readKit(store, VIGIL.id))!;
    const filesBefore = (await readdir(join(dir, "references", VIGIL.id))).sort();

    // A view whose media cannot be decoded: composition throws before anything is committed.
    const takeId = newId("tk");
    await mkdir(join(dir, "references", VIGIL.id, "takes", takeId), { recursive: true });
    await writeFile(join(dir, "references", VIGIL.id, "takes", takeId, "view.png"), Buffer.from("not a png"));
    await assert.rejects(() =>
      acceptLocationView(store, VIGIL, {
        id: "v9",
        name: "Broken",
        file: `takes/${takeId}/view.png`,
        takeId,
        sheetVersion: 3,
        artDirectionVersion: 4,
      }),
    );

    const after = (await readKit(store, VIGIL.id))!;
    assert.deepEqual(after.kit, before.kit, "the candidate stays unreviewed and the old sheet stays designated");
    assert.deepEqual(
      (await readdir(join(dir, "references", VIGIL.id))).sort(),
      filesBefore,
      "and no half-written sheet is left behind",
    );
    await store.close();
  });

  it("assembles the same bytes when the same views are accepted again", async () => {
    const { dir: dirA, store: storeA } = await openTicking();
    await acceptView(storeA, dirA, 1, "Establishing view");
    await acceptView(storeA, dirA, 2, "Reverse angle");
    const a = (await readKit(storeA, VIGIL.id))!.kit.designatedCompilation!;
    const bytesA = await readFile(join(dirA, "references", VIGIL.id, a));
    await storeA.close();

    const { dir: dirB, store: storeB } = await openTicking();
    await acceptView(storeB, dirB, 1, "Establishing view");
    await acceptView(storeB, dirB, 2, "Reverse angle");
    const b = (await readKit(storeB, VIGIL.id))!.kit.designatedCompilation!;
    const bytesB = await readFile(join(dirB, "references", VIGIL.id, b));
    await storeB.close();

    assert.equal(a, b, "content-addressed: the same views in the same order are the same file");
    assert.deepEqual(bytesA, bytesB);
  });
});

describe("generating a location view (#243)", () => {
  const VIGIL = {
    id: "the-vigil",
    type: "location",
    name: "The Vigil",
    version: 3,
    status: "locked",
    sections: [
      { heading: "Look", body: "A watchtower of black stone at the harbour mouth, ringed by a worn rail." },
      { heading: "Sound", body: "The bell, and water under it." },
    ],
  } as unknown as Sheet;
  const WORLD = { worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", canonRevision: 12 } as never;
  const DIRECTION = { version: 4, description: "Painterly, tidal, restrained." } as never;
  const noRefs: ManifestModel = { ...MODEL, id: "no-refs", accepts: { ...MODEL.accepts, referenceImages: 0 } };

  it("generates the establishing view from the location's own words, unanchored", () => {
    const [request] = locationViewRequests(WORLD, DIRECTION, VIGIL, null, MODEL, {
      name: "Establishing view",
      count: 1,
      generationKey: "k1",
    });
    const params = request!.input.params as Record<string, unknown>;
    assert.equal(request!.input.target.kind, "location-view-candidate");
    assert.match(request!.input.target.id!, /^the-vigil\/k1\/1$/);
    assert.deepEqual(params["references"], [], "the first angle has nothing to be anchored to");
    assert.match(params["prompt"] as string, /A watchtower of black stone/, "the Look is what a place is generated from");
    assert.match(params["prompt"] as string, /Painterly, tidal, restrained/, "under the world's art direction");
    assert.match(params["prompt"] as string, /no people in frame/, "a location view is a place, not a scene");
    assert.deepEqual((params["locationView"] as { name: string }).name, "Establishing view");
    assert.match((request!.input.landing as { dir: string }).dir, /references\/the-vigil\/candidates$/);
  });

  it("anchors every later angle to the accepted establishing view", () => {
    const [request] = locationViewRequests(WORLD, DIRECTION, VIGIL, null, MODEL, {
      name: "Reverse angle",
      prompt: "from the seaward stair looking back",
      count: 1,
      anchorFile: "takes/tk_a/view.png",
      generationKey: "k2",
    });
    const params = request!.input.params as Record<string, unknown>;
    // World-relative, because that is what the dispatcher resolves against. The view's own
    // `file` is kit-relative, and this assertion used to repeat it verbatim — so the test agreed
    // with the bug, and every anchored angle failed in a shipped build with "an image reference
    // is missing" while the suite stayed green.
    assert.deepEqual(params["references"], ["references/the-vigil/takes/tk_a/view.png"]);
    assert.deepEqual(params["referenceRoles"], [
      { file: "references/the-vigil/takes/tk_a/view.png", role: "environment" },
    ]);
    assert.ok(
      (params["references"] as string[]).every((file) => file.startsWith("references/")),
      "a reference the dispatcher cannot resolve is the same as no reference at all",
    );
    assert.match(
      params["prompt"] as string,
      /same place; keep its architecture, materials, light and time of day/,
      "the anchor is stated as the same room rather than a mood board",
    );
    assert.match(params["prompt"] as string, /from the seaward stair looking back/);
    assert.equal((params["provenance"] as { anchorFile?: string }).anchorFile, "takes/tk_a/view.png");
  });

  it("refuses to make an unanchored angle on a model that cannot carry the reference", () => {
    // Unanchored is fine on any model — the establishing view needs no reference.
    assert.doesNotThrow(() =>
      locationViewRequests(WORLD, DIRECTION, VIGIL, null, noRefs, { name: "Establishing view", count: 1, generationKey: "k3" }),
    );
    // Anchored is not: silently dropping the anchor would produce a second room that merely
    // answers the same description, which is the failure the feature exists to prevent.
    assert.throws(
      () =>
        locationViewRequests(WORLD, DIRECTION, VIGIL, null, noRefs, {
          name: "Reverse angle",
          count: 1,
          anchorFile: "takes/tk_a/view.png",
          generationKey: "k4",
        }),
      /cannot be anchored to the establishing view/,
    );
  });

  it("refuses a sheet that is not a location", () => {
    const maren = { id: "maren-kest", type: "character", name: "Maren Kest", version: 4, sections: [] } as unknown as Sheet;
    assert.throws(
      () => locationViewRequests(WORLD, DIRECTION, maren, null, MODEL, { name: "Establishing view", count: 1, generationKey: "k5" }),
      /is not a location/,
    );
  });

  it("fans out one job per candidate, priced individually", () => {
    const requests = locationViewRequests(WORLD, DIRECTION, VIGIL, null, MODEL, {
      name: "Day",
      count: 3,
      anchorFile: "takes/tk_a/view.png",
      generationKey: "k6",
    });
    assert.equal(requests.length, 3, "a failure must not take the candidates that already arrived with it");
    assert.deepEqual(
      requests.map((r) => r.input.target.id),
      ["the-vigil/k6/1", "the-vigil/k6/2", "the-vigil/k6/3"],
    );
    assert.ok(requests.every((r) => r.estimatedMicroUsd === requests[0]!.estimatedMicroUsd));
  });
});
