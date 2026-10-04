import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChapterAudiobookSchema, type ClientMessage, type DomainEvent, type ManifestModel } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AUDIOBOOK_LOOKS_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readAudiobook } from "../../src/productions/audiobook.js";
import { characterLookRequests } from "../../src/references/generate.js";
import { acceptCharacterLook, attachCloseView, readKit } from "../../src/references/kit.js";
import { recordReferenceTake } from "../../src/references/takes.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Making a look (design turn 193, SPEC-047 R-118, R-112): candidates through the kit's own look
 * machinery, a full-body look accepted as a kit look of kind costume with its main photo and its
 * close view, and chosen for the chapter by pointer — the look left unattached (SPEC-017 R-18).
 */
const CLOCK = "2026-10-04T09:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const CHAPTER = "01-neap";
const MODEL: ManifestModel = {
  id: "gpt-image-2",
  provider: "openai",
  capability: "image",
  displayName: "GPT Image 2",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "perImage", microUsdPerImage: 40000 },
};

type Harness = { store: () => WorldStore; worldDir: string; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void>; schemaVersion: () => number };
async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
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
  });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, events, send, store: () => provider.openStore!()!, schemaVersion: () => provider.openStore!()!.getBundle().meta.schemaVersion });
  } finally {
    await provider.close();
  }
}

type RecordEvent = Extract<DomainEvent, { type: "audiobook.record" }>;
const answer = (events: DomainEvent[]): RecordEvent => {
  const found = events.filter((event): event is RecordEvent => event.type === "audiobook.record").at(-1);
  assert.ok(found, "the record is answered");
  return found;
};

/** A reference take as a finished look job leaves it: the job's own params, its picture under the kit's takes. */
async function lookTake(store: WorldStore, worldDir: string, id: string, params: Record<string, unknown>, name: string) {
  const landed = `references/maren-kest/looks/incoming/${name}.png`;
  await mkdir(join(worldDir, "references", "maren-kest", "looks", "incoming"), { recursive: true });
  await writeFile(join(worldDir, landed), `bytes-of-${name}`);
  const job = {
    id: `jb_${id}`,
    idempotencyKey: `01J8E1000000000000000000${id.slice(-2)}`,
    worldId: WORLD_ID,
    target: { kind: "character-look", id: `maren-kest/${name}/1` },
    capability: "image",
    provider: "openai",
    model: "gpt-image-2",
    params,
    estimatedMicroUsd: 40000,
    status: "succeeded",
    providerJobId: `p-${name}`,
    attempt: 1,
    landedFiles: [landed],
    error: null,
    createdAt: CLOCK,
    updatedAt: CLOCK,
  };
  const take = await recordReferenceTake(store, job as never);
  assert.ok(take);
  return take;
}

describe("the candidates of a look for a chapter", () => {
  const meta = { worldId: WORLD_ID, slug: "the-undersong", schemaVersion: 1, name: "The Undersong", canonRevision: 42, nextCanonId: 45, created: "2026-05-02T09:14:00Z", updated: "2026-07-30T18:22:00Z" } as never;
  const direction = { version: 3, description: "Painterly, tidal, restrained.", masterLook: "world-art.png", acceptedAt: "2026-07-18T10:00:00Z", audio: { music: "environmental-only" as const, subtitles: "never" as const }, failureModes: [], history: [], derived: false, reach: { visualAssets: 1, referenceKits: 1, productions: 1, earlierAcceptedTakes: 0 }, overrides: [] };
  const sheet = { id: "maren-kest", type: "character", name: "Maren Kest", version: 4, status: "locked", canonRules: [], links: [], created: "2026-05-02", updated: "2026-07-14", sections: [{ heading: "Appearance", body: "Salt-crusted braids." }] } as never;
  const kit = { sheetId: "maren-kest", tiles: [], compilations: [], mainPhoto: { file: "head-front.png", source: "generated" as const } };

  it("asks for full-length pictures on a plain ground, from the main photo, and names the batch they belong to", () => {
    const requests = characterLookRequests(meta, direction as never, sheet, kit, MODEL, { kind: "costume", mode: "stay-close", prompt: "Oilskin coat, hood up; two braids.", count: 3, generationKey: "g1", framing: "full-body", batch: "01J00000000000000000000009" });
    assert.equal(requests.length, 3);
    const params = requests[0]!.input.params;
    assert.deepEqual(params["references"], ["references/maren-kest/head-front.png"], "the main photo is the face reference");
    assert.match(String(params["prompt"]), /Painterly, tidal, restrained\./, "the art direction is on, as the sheet says");
    assert.match(String(params["prompt"]), /Oilskin coat, hood up; two braids\./);
    assert.match(String(params["prompt"]), /Full body, head to toe/);
    assert.match(String(params["prompt"]), /plain neutral background/);
    assert.equal(params["lookFraming"], "full-body");
    assert.equal(params["lookMain"], "head-front.png");
    assert.equal(params["lookBatch"], "01J00000000000000000000009");
    assert.equal(params["lookKind"], "costume");
    assert.equal(params["lookPrompt"], "Oilskin coat, hood up; two braids.");
  });

  it("leaves the Cast page's exploration exactly as it was", () => {
    const [plain] = characterLookRequests(meta, direction as never, sheet, kit, MODEL, { kind: "costume", mode: "stay-close", prompt: "Formal council coat", count: 1, generationKey: "g1" });
    const params = plain!.input.params;
    assert.doesNotMatch(String(params["prompt"]), /Full body|plain neutral/);
    for (const key of ["lookFraming", "lookMain", "lookBatch", "lookOfTake", "lookOfLook"]) assert.equal(key in params, false, key);
  });

  it("makes the close view of a candidate from the main photo and that candidate, one picture", () => {
    const [close] = characterLookRequests(meta, direction as never, sheet, kit, MODEL, {
      kind: "costume",
      mode: "stay-close",
      prompt: "Oilskin coat, hood up; two braids.",
      count: 1,
      generationKey: "g2",
      framing: "close",
      closeOf: { file: "references/maren-kest/takes/tk_B/b.png", takeId: "tk_B" },
      batch: "01J00000000000000000000009",
    });
    const params = close!.input.params;
    assert.deepEqual(params["references"], ["references/maren-kest/head-front.png", "references/maren-kest/takes/tk_B/b.png"], "the face first, then the clothes it is to keep");
    assert.match(String(params["prompt"]), /Head and shoulders of the same person in the same clothes/);
    assert.equal(params["lookFraming"], "close");
    assert.equal(params["lookOfTake"], "tk_B");
    assert.throws(() => characterLookRequests(meta, direction as never, sheet, kit, MODEL, { kind: "costume", mode: "stay-close", prompt: "x", count: 1, generationKey: "g3", framing: "close" }), /close view is made from a look/);
  });
});

describe("a look filed in the kit (R-112, R-118)", () => {
  it("keeps its framing, the main photo it was made from and its close view, and raises the world past the builds that read them as an unreadable kit", () =>
    withHarness(async ({ store, schemaVersion }) => {
      const before = schemaVersion();
      assert.ok(before < AUDIOBOOK_LOOKS_SCHEMA_VERSION);
      await acceptCharacterLook(store(), "maren-kest", { id: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G3", file: "takes/a/a.png", kind: "costume", prompt: "Storm coat.", takeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G3", artDirectionVersion: 3, framing: "full-body", mainFile: "head-front.png", close: { file: "takes/b/b.png", takeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G4" } });
      assert.equal(schemaVersion(), AUDIOBOOK_LOOKS_SCHEMA_VERSION);
      const look = (await readKit(store(), "maren-kest"))!.kit.looks![0]!;
      assert.deepEqual([look.framing, look.mainFile, look.closeFile, look.closeTakeId, look.attachedTo], ["full-body", "head-front.png", "takes/b/b.png", "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G4", undefined]);
    }));

  it("leaves a look the Cast page accepts as it always was, at the world's own version", () =>
    withHarness(async ({ store, schemaVersion }) => {
      const before = schemaVersion();
      await acceptCharacterLook(store(), "maren-kest", { id: "council-coat", file: "looks/c.png", kind: "costume", prompt: "Formal council coat", takeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G5", artDirectionVersion: 3 });
      assert.equal(schemaVersion(), before);
      const look = (await readKit(store(), "maren-kest"))!.kit.looks!.find((candidate) => candidate.id === "council-coat")!;
      assert.equal(look.framing, undefined);
    }));

  it("files a close view on a look that has none, once, and refuses a look that is not there", () =>
    withHarness(async ({ store }) => {
      await acceptCharacterLook(store(), "maren-kest", { id: "tk_a", file: "takes/a/a.png", kind: "costume", prompt: "Storm coat.", takeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G3", artDirectionVersion: 3 });
      await attachCloseView(store(), "maren-kest", "tk_a", { file: "takes/c/c.png", takeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G6" });
      const look = (await readKit(store(), "maren-kest"))!.kit.looks!.find((candidate) => candidate.id === "tk_a")!;
      assert.equal(look.closeFile, "takes/c/c.png");
      assert.equal(look.file, "takes/a/a.png", "the look's own image is untouched");
      await assert.rejects(attachCloseView(store(), "maren-kest", "nope", { file: "x.png", takeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G6" }), /no accepted look/);
    }));
});

describe("accepting a look for the chapter that asked for it", () => {
  const params = (framing: "full-body" | "close", extra: Record<string, unknown> = {}) => ({
    prompt: "Painterly. Maren Kest. Oilskin coat.",
    references: ["references/maren-kest/head-front.png"],
    artDirection: { version: 3 },
    provenance: { canonRevision: 42, sheets: { "maren-kest": 4 }, artDirectionVersion: 3, anchorFile: "head-front.png" },
    lookKind: "costume",
    lookPrompt: "Oilskin coat, hood up; two braids.",
    lookFraming: framing,
    lookMain: "head-front.png",
    lookBatch: "01J00000000000000000000009",
    ...extra,
  });

  it("files the look with its close view, chooses it for the character and attaches it to nothing", () =>
    withHarness(async ({ store, worldDir, send, events, schemaVersion }) => {
      const full = await lookTake(store(), worldDir, "01J8E0000000000000000000B1", params("full-body"), "g1-2");
      const close = await lookTake(store(), worldDir, "01J8E0000000000000000000B2", params("close", { lookOfTake: "tk_B" }), "g2-1");
      await send({ kind: "accept-character-look", worldId: WORLD_ID, sheetId: "maren-kest", takeId: full.id, closeTakeId: close.id, choose: { productionId: LEDGER, chapterFile: CHAPTER, key: "maren-kest", name: "Maren Kest", sheet: "maren-kest" } });
      const look = (await readKit(store(), "maren-kest"))!.kit.looks!.find((candidate) => candidate.id === full.id)!;
      assert.equal(look.kind, "costume");
      assert.equal(look.framing, "full-body");
      assert.equal(look.mainFile, "head-front.png", "the photo it was made from, so a later one marks it older face");
      assert.equal(look.closeFile, `takes/${close.id}/${close.media}`);
      assert.equal(look.closeTakeId, close.id);
      assert.equal(look.attachedTo, undefined, "a chapter chooses by pointer; R-18 holds");
      assert.equal(look.prompt, "Oilskin coat, hood up; two braids.");
      const reviews = store().getBundle().referenceReviews;
      assert.deepEqual([reviews.find((review) => review.takeId === full.id)?.decision, reviews.find((review) => review.takeId === close.id)?.decision], ["accept", "accept"], "both pictures are decided; neither lingers as a candidate");
      const record = answer(events).record!;
      assert.equal(record.look!.characters["maren-kest"]!.lookId, full.id);
      assert.equal(record.look!.characters["maren-kest"]!.text, "Oilskin coat, hood up; two braids.", "the chapter's line is the look's own words");
      assert.equal(schemaVersion(), AUDIOBOOK_LOOKS_SCHEMA_VERSION);
      assert.ok(ChapterAudiobookSchema.safeParse(JSON.parse(JSON.stringify(record))).success);
    }));

  it("files a close view made afterwards on the look that already stands, not as a look of its own", () =>
    withHarness(async ({ store, worldDir, send }) => {
      const full = await lookTake(store(), worldDir, "01J8E0000000000000000000B3", params("full-body"), "g3-1");
      await send({ kind: "accept-character-look", worldId: WORLD_ID, sheetId: "maren-kest", takeId: full.id });
      let look = (await readKit(store(), "maren-kest"))!.kit.looks!.find((candidate) => candidate.id === full.id)!;
      assert.equal(look.closeFile, undefined, "made without a close view");
      const close = await lookTake(store(), worldDir, "01J8E0000000000000000000B4", params("close", { lookOfLook: full.id }), "g4-1");
      await send({ kind: "accept-character-look", worldId: WORLD_ID, sheetId: "maren-kest", takeId: close.id, closeFor: full.id });
      const kit = (await readKit(store(), "maren-kest"))!.kit;
      look = kit.looks!.find((candidate) => candidate.id === full.id)!;
      assert.equal(look.closeFile, `takes/${close.id}/${close.media}`);
      assert.equal(kit.looks!.some((candidate) => candidate.id === close.id), false, "the close view is not a look");
      assert.equal(store().getBundle().referenceReviews.find((review) => review.takeId === close.id)?.decision, "accept");
    }));
});

describe("choosing a look for a character in a chapter (R-112)", () => {
  const choose = (send: (message: ClientMessage) => Promise<void>, lookId: string | null, key = "maren-kest") =>
    send({ kind: "choose-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, key, ...(key === "maren-kest" ? { sheet: "maren-kest" } : {}), lookId, requestId: "01J00000000000000000000001" });

  it("chooses a look the kit holds, which may be one the Cast page made without a framing, and takes the choice away again", () =>
    withHarness(async ({ store, send, events }) => {
      await acceptCharacterLook(store(), "maren-kest", { id: "council-coat", file: "looks/c.png", kind: "costume", prompt: "Formal council coat", takeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G5", artDirectionVersion: 3 });
      await choose(send, "council-coat");
      let done = answer(events);
      assert.equal(done.refused, undefined);
      assert.equal(done.requestId, "01J00000000000000000000001");
      assert.deepEqual([done.record!.look!.characters["maren-kest"]!.lookId, done.record!.look!.characters["maren-kest"]!.text, done.record!.look!.characters["maren-kest"]!.name], ["council-coat", "Formal council coat", "Maren Kest"]);
      const held = await readAudiobook(store(), LEDGER, CHAPTER);
      assert.ok(held !== null && held !== "unreadable");
      assert.equal(held.look!.characters["maren-kest"]!.lookId, "council-coat", "kept on the record");
      await choose(send, null);
      done = answer(events);
      assert.equal(done.record!.look!.characters["maren-kest"]!.lookId, undefined);
    }));

  it("gives the chapter a Cast page look's clothing, never its directions to the image model (Na Love or Juju)", () =>
    withHarness(async ({ store, send, events }) => {
      const prompt = "OUTFIT FOR THIS LOOK, overriding any clothing named earlier in this prompt. Full-length standing figure, head to shoes fully in frame, plain dark neutral studio backdrop, even soft light. Maren wears an oilskin coat, dark and stiff with salt, and sea boots. No agbada, no lace. Upright, looking at the camera.";
      await acceptCharacterLook(store(), "maren-kest", { id: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G6", file: "takes/tk_x/look.png", kind: "costume", prompt, takeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G6", artDirectionVersion: 3 });
      await choose(send, "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G6");
      const done = answer(events);
      assert.equal(done.refused, undefined);
      assert.equal(done.record!.look!.characters["maren-kest"]!.text, "Maren wears an oilskin coat, dark and stiff with salt, and sea boots.");
    }));

  it("says why in one clause for a look that is gone and for a character with no sheet, and writes nothing", () =>
    withHarness(async ({ store, send, events, schemaVersion }) => {
      const before = schemaVersion();
      await choose(send, "no-such-look");
      assert.equal(answer(events).refused, "that look is gone");
      await choose(send, "council-coat", "the-harbour-master");
      assert.equal(answer(events).refused, "that character has no sheet, so no looks");
      assert.equal(schemaVersion(), before, "a refused choice raises nothing");
      assert.equal(await readAudiobook(store(), LEDGER, CHAPTER), null);
    }));
});
