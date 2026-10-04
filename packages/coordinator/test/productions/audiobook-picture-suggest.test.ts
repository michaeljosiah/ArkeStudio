import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lookViewFor, pictureLookChanged, ridingPicks, type AudiobookLook, type ClientMessage, type DomainEvent, type ManifestModel, type WorldBundle } from "@arke-studio/contracts";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import { AUDIOBOOK_LOOK_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readAudiobook } from "../../src/productions/audiobook.js";
import { buildPicturePrompt, clipPrompt, pictureAspect, pictureQuote, pictureWho, promptRoom, type PictureDeriverInput } from "../../src/productions/audiobook-picture-suggest.js";
import { acceptCharacterLook } from "../../src/references/kit.js";
import { pngBytes } from "../queue/fake-provider.js";
import { CHAPTER, IMAGE, LEDGER, WORLD_ID, withHarness, type Harness } from "./picture-harness.js";

const LOOK_ID = "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2K1";
const CLOSE_ID = "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2K2";

/**
 * Suggest picture and Generate (design turn 191a, SPEC-047 R-99, R-100): one editable prompt drafted
 * from the block, the chapter and who is in it; each person riding by their sheet's main picture up
 * to the model's limit; nothing made until Generate, which goes through the Bench on the price shown
 * and lands as the block's picture — one that keeps the look it was made under.
 */
const REQUEST = "01J00000000000000000000001";
type SuggestionEvent = Extract<DomainEvent, { type: "audiobook.picture-suggestion" }>;
type MadeEvent = Extract<DomainEvent, { type: "audiobook.picture-made" }>;

const suggest = (send: Harness["send"], block = "p0.0") =>
  send({ kind: "suggest-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block, requestId: REQUEST });
const suggestion = (events: DomainEvent[]): SuggestionEvent => {
  const found = events.filter((event): event is SuggestionEvent => event.type === "audiobook.picture-suggestion").at(-1);
  assert.ok(found, "the suggestion is answered");
  return found;
};
const madeEvents = (events: DomainEvent[]): MadeEvent[] => events.filter((event): event is MadeEvent => event.type === "audiobook.picture-made");

describe("Suggest picture (R-99)", () => {
  it("carries the included-plan identity into a zero-dollar picture authorization", () =>
    withHarness(async ({ events, send, enqueued }) => {
      await suggest(send);
      const picked = suggestion(events).suggestion!;
      assert.equal(picked.model.plan, "included-plan");
      assert.equal(picked.estimatedMicroUsd, 0);
      assert.equal(picked.aspect, undefined);
      assert.equal(enqueued.length, 0);
    }, { model: { ...IMAGE, id: "codex-image", provider: "codex", limits: { providerSelectedSize: true }, pricing: { kind: "included-plan" } } }));
  it("reads the look first, drafts one prompt, and says who rides, the model, the ratio and the price", () =>
    withHarness(async ({ events, send, seen, schemaVersion, store }) => {
      await suggest(send);
      const answer = suggestion(events);
      assert.equal(answer.refused, undefined);
      assert.equal(answer.requestId, REQUEST);
      const picked = answer.suggestion!;
      assert.equal(picked.block, "p0.0");
      assert.match(picked.prompt, /^Maren on the rail with Bray/);
      assert.equal(picked.model.id, "stair-image");
      assert.equal(picked.model.references, 2, "the model's own limit");
      assert.equal(picked.aspect, "16:9");
      // The look the chapter did not have was read for it, kept, and is what the prompt was written from.
      const held = await readAudiobook(store()!, LEDGER, CHAPTER);
      assert.ok(held !== null && held !== "unreadable" && held.look !== undefined);
      assert.equal(schemaVersion(), AUDIOBOOK_LOOK_SCHEMA_VERSION);
      assert.deepEqual(seen[0]!.lines.map((line) => line.label), ["Place", "Maren Kest", "Bray Half-Hitch"]);
      assert.deepEqual(picked.lines.map((line) => line.label), ["Place", "Maren Kest", "Bray Half-Hitch"], "the look lines it used");
      // Who is in it: the model's own names, held to the chapter — "nobody" is no one.
      assert.deepEqual(picked.who.map((who) => [who.key, who.carried, who.reference !== null]), [["maren-kest", true, true], ["bray-half-hitch", false, false]]);
      // The price: one picture and the one reference that rides, from the manifest's own figures.
      assert.equal(picked.estimatedMicroUsd, 45_000);
      assert.equal(picked.look?.who.join(","), "maren-kest,bray-half-hitch");
      // Nothing was made or spent.
      assert.equal(madeEvents(events).length, 0);
    }));

  it("is refused in one clause with no writing service and with no picture model, and leaves the chapter as it was", async () => {
    await withHarness(async ({ events, send, store }) => {
      await suggest(send);
      assert.equal(suggestion(events).refused, "no picture model is on");
      assert.equal(await readAudiobook(store()!, LEDGER, CHAPTER), null, "no look was read for a picture that cannot be made");
    }, { model: null });
  });

  it("holds a prompt to the room the model leaves for the references and the look", async () => {
    const small: ManifestModel = { ...IMAGE, limits: { aspects: ["16:9"], maxPromptChars: 1000 } };
    await withHarness(async ({ events, send }) => {
      await suggest(send);
      const picked = suggestion(events).suggestion!;
      assert.ok(picked.prompt.length <= promptRoom(small));
      assert.ok(picked.prompt.endsWith("."), "cut after a whole sentence, not mid-word");
    }, { model: small, picture: async () => ({ prompt: `${"She stood at the rail. ".repeat(60)}`, who: [], place: null }) });
  });

  it("names no one the sheet says is never to be pictured, and tells the model to leave them out", async () => {
    await withHarness(
      async ({ events, send, seen }) => {
        await suggest(send);
        const picked = suggestion(events).suggestion!;
        assert.ok(!picked.who.some((who) => who.key === "bray-half-hitch"));
        assert.deepEqual(seen[0]!.never, ["Bray Half-Hitch"]);
        assert.ok(!seen[0]!.people.some((person) => person.key === "bray-half-hitch"));
        assert.match(buildPicturePrompt(seen[0]!), /Never show, name or hint at: Bray Half-Hitch/);
      },
      {
        prepare: async (worldDir) => {
          const file = join(worldDir, "characters", "bray-half-hitch.md");
          const text = await readFile(file, "utf8");
          await writeFile(file, text.replace("billing: support", "billing: support\nneverDepicted: true"), "utf8");
        },
      },
    );
  });
});

describe("the art direction gives light and mood only (design turn 193, rule 9, R-117)", () => {
  const AGBADA = "Lagos at night, sodium orange and generator blue-green. Warm dark skin held in low key, sweat and gold and lace-trimmed agbada catching the little light there is. Fine grain.";
  const withArt = async (worldDir: string) => {
    const file = join(worldDir, "art-direction", "art-direction.json");
    const direction = JSON.parse(await readFile(file, "utf8")) as { description: string };
    await writeFile(file, `${JSON.stringify({ ...direction, description: AGBADA }, null, 2)}\n`, "utf8");
  };

  it("never lets a garment the art direction names reach the writing service, a picture prompt or the Bench", () =>
    withHarness(
      async ({ events, send, seen, store, worldDir }) => {
        await suggest(send);
        const picked = suggestion(events).suggestion!;
        // The look was read with a Mood line, cut of the agbada; only that line is given.
        const held = await readAudiobook(store()!, LEDGER, CHAPTER);
        assert.ok(held !== null && held !== "unreadable");
        assert.doesNotMatch(held.look!.mood!.text, /agbada|lace/);
        assert.match(held.look!.mood!.text, /sodium orange/i);
        assert.equal(seen[0]!.mood, held.look!.mood!.text);
        assert.doesNotMatch(buildPicturePrompt(seen[0]!), /agbada|lace-trimmed/);
        await send({ kind: "make-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", prompt: picked.prompt, who: picked.who.map((who) => who.key), confirmedMicroUsd: picked.estimatedMicroUsd, requestId: "01J00000000000000000000006" });
        const done = madeEvents(events).at(-1)!;
        assert.equal(done.state, "made", done.reason);
        const session = await new BenchStore(sessionDir(worldDir, done.sessionId as never)).fold();
        const brief = session!.takes[0]!.request.brief;
        assert.doesNotMatch(brief, /agbada|lace/);
        assert.match(brief, /Light and mood: .*sodium orange/i);
      },
      { prepare: withArt, look: async () => ({ place: { text: "The rail desk at dawn." }, mood: "Sodium orange and generator blue-green, lace-trimmed agbada catching the light, fine grain.", characters: [{ who: "maren-kest", text: "Oilskin coat." }] }) },
    ));

  it("cuts the garment from the art direction itself for a look read without a Mood line", () =>
    withHarness(
      async ({ events, send, seen }) => {
        await suggest(send);
        assert.equal(suggestion(events).refused, undefined);
        assert.ok(seen[0]!.mood !== undefined);
        assert.doesNotMatch(seen[0]!.mood!, /agbada|lace/);
        assert.match(seen[0]!.mood!, /^Lagos at night/);
      },
      { prepare: withArt },
    ));
});

describe("the brief's answer, held and checked (design turn 193k, R-120, R-121)", () => {
  const prepareLook = async (worldDir: string) => {
    for (const [id, name] of [[LOOK_ID, "look.png"], [CLOSE_ID, "close.png"]] as const) {
      await mkdir(join(worldDir, "references", "maren-kest", "takes", id), { recursive: true });
      await writeFile(join(worldDir, "references", "maren-kest", "takes", id, name), pngBytes());
    }
  };
  const chooseMarensLook = async (h: Pick<Harness, "send" | "store">) => {
    await acceptCharacterLook(h.store()!, "maren-kest", { id: LOOK_ID, file: `takes/${LOOK_ID}/look.png`, kind: "costume", prompt: "Oilskin coat, dark with salt; two braids.", takeId: LOOK_ID, artDirectionVersion: 1, framing: "full-body", close: { file: `takes/${CLOSE_ID}/close.png`, takeId: CLOSE_ID } });
    await h.send({ kind: "derive-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, requestId: "01J00000000000000000000007" });
    await h.send({ kind: "choose-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, key: "maren-kest", sheet: "maren-kest", lookId: LOOK_ID, requestId: "01J00000000000000000000008" });
  };
  const CLOSE = { frame: "Close-up, Maren's face", inFrame: ["maren-kest"], notInFrame: ["bray-half-hitch"], expressions: { "maren-kest": "tired, unsmiling, eyes on the ledger" }, details: [], place: null, prompt: "Close-up on Maren's face over the ledger, tired and unsmiling, eyes on the ledger. Oilskin coat, dark with salt, two braids. Grey dawn light from the rail window." };

  it("rides only who is in frame, by their close view for a close frame, and shows the frame, expressions and checks", () =>
    withHarness(
      async (h) => {
        await chooseMarensLook(h);
        await suggest(h.send);
        const picked = suggestion(h.events).suggestion!;
        assert.deepEqual(picked.who.map((who) => [who.key, who.reference, who.look?.view]), [["maren-kest", `references/maren-kest/takes/${CLOSE_ID}/close.png`, "close"]], "Bray is in the scene, not in frame: never carried");
        assert.equal(picked.shot?.frame, "Close-up, Maren's face");
        assert.deepEqual(picked.shot?.notInFrame, ["bray-half-hitch"]);
        assert.equal(picked.shot?.expressions["maren-kest"], "tired, unsmiling, eyes on the ledger");
        assert.ok(picked.shot!.checks.every((check) => check.ok), JSON.stringify(picked.shot!.checks.filter((check) => !check.ok)));
        assert.deepEqual(picked.look?.looks, { "maren-kest": { lookId: LOOK_ID, view: "close" } });
        // Generate carries the frame, so the close view rides at the Bench too, with the app's closing lines.
        await h.send({ kind: "make-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", prompt: picked.prompt, who: picked.who.map((who) => who.key), frame: picked.shot!.frame, confirmedMicroUsd: picked.estimatedMicroUsd, requestId: "01J00000000000000000000009" });
        const done = madeEvents(h.events).at(-1)!;
        assert.equal(done.state, "made", done.reason);
        assert.deepEqual((h.enqueued[0]!.params as { references?: string[] }).references, [`references/maren-kest/takes/${CLOSE_ID}/close.png`]);
        const session = await new BenchStore(sessionDir(h.worldDir, done.sessionId as never)).fold();
        const brief = session!.takes[0]!.request.brief;
        assert.match(brief, /Maren Kest is shown in @Image 1\. Keep each person's identity, hair and clothes as in the references; the expression is as written above, not the reference's\./);
        assert.match(brief, /No text in the picture\.$/);
        assert.deepEqual(done.record!.pictures!["p0.0"]!.look?.looks, { "maren-kest": { lookId: LOOK_ID, view: "close" } });
      },
      { prepare: prepareLook, picture: async () => CLOSE },
    ));

  // 0.5.60-local.14: three pictures of Ife at the club table and her close view were refused by the
  // safety check; their words repeated her look line's "bare shoulders" and "low-backed slip dress"
  // while her full-body look image, the same dress, rode.
  it("never puts a look line's bare shoulders or low-backed slip dress into the picture prompt it sends once the look image rides", () => {
    const asked: PictureDeriverInput[] = [];
    return withHarness(
      async (h) => {
        await acceptCharacterLook(h.store()!, "maren-kest", { id: LOOK_ID, file: `takes/${LOOK_ID}/look.png`, kind: "costume", prompt: "Two braids pinned up, bare shoulders, low-backed slip dress in cream-gold silk.", takeId: LOOK_ID, artDirectionVersion: 1, framing: "full-body", close: { file: `takes/${CLOSE_ID}/close.png`, takeId: CLOSE_ID } });
        await h.send({ kind: "derive-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, requestId: "01J00000000000000000000007" });
        await h.send({ kind: "choose-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, key: "maren-kest", sheet: "maren-kest", lookId: LOOK_ID, requestId: "01J00000000000000000000008" });
        await suggest(h.send);
        const given = asked.at(-1)!.lines.find((line) => line.key === "maren-kest")!;
        assert.equal(given.text, "Two braids pinned up, evening dress in cream-gold silk.", "the writing service is given the garment and its colour");
        assert.match(buildPicturePrompt(asked.at(-1)!), /name each garment once, briefly and neutrally/);
        const picked = suggestion(h.events).suggestion!;
        assert.ok(picked.who.some((who) => who.look !== undefined), "the look image rides");
        for (const words of ["bare shoulders", "low-backed", "slip dress"]) assert.ok(!picked.prompt.includes(words), `suggestion: ${words}`);
        assert.match(picked.prompt, /tired and unsmiling, eyes on the ledger/, "the expression and the frame are kept");
        assert.match(picked.prompt, /^Medium close-up on Maren/);
        await h.send({ kind: "make-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", prompt: picked.prompt, who: picked.who.map((who) => who.key), frame: picked.shot!.frame, confirmedMicroUsd: picked.estimatedMicroUsd, requestId: "01J0000000000000000000000B" });
        const done = madeEvents(h.events).at(-1)!;
        assert.equal(done.state, "made", done.reason);
        const sent = String((h.enqueued.at(-1)!.params as { prompt?: string }).prompt ?? "");
        assert.ok(sent.length > 0, "the job carries the prompt");
        for (const words of ["bare shoulders", "low-backed", "slip dress"]) assert.ok(!sent.includes(words), `sent: ${words}`);
      },
      {
        prepare: prepareLook,
        // A model that copies the line word for word, as the one that wrote the refused pictures did.
        picture: async (input) => {
          asked.push(input);
          return { ...CLOSE, frame: "Medium close-up, Maren", prompt: "Medium close-up on Maren over the ledger, tired and unsmiling, eyes on the ledger, in a low-backed slip dress in cream-gold silk, bare shoulders catching the light. Grey dawn light from the rail window." };
        },
      },
    );
  });

  it("carries no reference for a detail shot, and Generate sends none", () =>
    withHarness(
      async (h) => {
        await chooseMarensLook(h);
        await suggest(h.send);
        const picked = suggestion(h.events).suggestion!;
        assert.deepEqual(picked.who, [], "a detail shot carries no reference");
        assert.equal(picked.estimatedMicroUsd, 40_000, "one picture and no reference");
        assert.equal(picked.shot?.checks.find((check) => check.id === "reference")?.label, "Detail");
        await h.send({ kind: "make-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", prompt: picked.prompt, who: [], frame: picked.shot!.frame, confirmedMicroUsd: picked.estimatedMicroUsd, requestId: "01J0000000000000000000000A" });
        assert.equal(madeEvents(h.events).at(-1)!.state, "made");
        assert.deepEqual((h.enqueued[0]!.params as { references?: string[] }).references ?? [], []);
      },
      { prepare: prepareLook, picture: async () => ({ frame: "Detail, her hand on the ledger", inFrame: [], expressions: {}, details: [{ of: "maren-kest", part: "hand", state: "still" }], notInFrame: [], place: null, prompt: "Detail shot, tight on a hand flat on the open ledger, the oilskin cuff dark with salt. Her face is out of frame. Grey dawn light." }) },
    ));

  it("asks again once, with the reason, when the draft names someone out of frame", () => {
    const asked: string[] = [];
    return withHarness(
      async ({ events, send }) => {
        await suggest(send);
        const picked = suggestion(events).suggestion!;
        assert.equal(asked.length, 2, "asked twice");
        assert.match(asked[1]!, /names Bray Half-Hitch/);
        assert.ok(picked.shot!.checks.find((check) => check.id === "not-in-frame")!.ok, "the second draft is clean");
      },
      {
        picture: async (input) => {
          asked.push(input.retry ?? "");
          return { ...CLOSE, prompt: input.retry === undefined ? `${CLOSE.prompt} Bray Half-Hitch watches from the door.` : CLOSE.prompt };
        },
      },
    );
  });
});

describe("who rides as a reference (R-100)", () => {
  const world = (kits: string[], places: string[] = []): Pick<WorldBundle, "referenceKits" | "sheets"> =>
    ({
      sheets: [
        ...["maren", "bray", "odile"].map((id) => ({ id, type: "character", name: id })),
        ...["stair", "quarter"].map((id) => ({ id, type: "location", name: id })),
      ],
      referenceKits: [...kits, ...places].map((sheetId) => ({ sheetId, tiles: [], compilations: [], mainPhoto: { file: "head-front.png", source: "legacy" }, locationViews: [] })),
    }) as never;
  const chosen = [
    { key: "maren", name: "Maren", sheet: "maren", kind: "character" as const, billing: "lead" },
    { key: "bray", name: "Bray", sheet: "bray", kind: "character" as const, billing: "support" },
    { key: "odile", name: "Odile", sheet: "odile", kind: "character" as const, billing: "support" },
    { key: "stair", name: "The stair", sheet: "stair", kind: "place" as const },
  ];

  it("carries up to the number the model takes, characters before the place, leads first — and names the rest, never silently", () => {
    const model = (referenceImages: number): ManifestModel => ({ ...IMAGE, accepts: { ...IMAGE.accepts, referenceImages } });
    const full = pictureWho({ getBundle: () => world(["maren", "bray", "odile"], ["stair"]) as never }, model(3), chosen);
    assert.deepEqual(full.map((who) => [who.key, who.carried]), [["maren", true], ["bray", true], ["odile", true], ["stair", false]]);
    const wide = pictureWho({ getBundle: () => world(["maren", "bray", "odile"], ["stair"]) as never }, model(9), chosen);
    assert.ok(wide.every((who) => who.carried), "the model's limit is the only limit");
    const none = pictureWho({ getBundle: () => world(["maren"]) as never }, model(0), chosen);
    assert.ok(none.every((who) => !who.carried), "a model that takes none carries none");
    assert.equal(none[0]!.reference, "references/maren/head-front.png", "the picture is still named, for the card");
  });

  it("rides a chapter's chosen look in place of the main photo, the close view only for a frame that shows faces, never both (R-119, R-118)", () => {
    const looks = [
      { id: "tk_storm", file: "takes/tk_storm/storm.png", kind: "costume", prompt: "Storm coat.", acceptedAt: "2026-10-03T09:00:00.000Z", closeFile: "takes/tk_close/close.png" },
      { id: "tk_bare", file: "takes/tk_bare/bare.png", kind: "costume", prompt: "Harbour coat.", acceptedAt: "2026-10-03T09:00:00.000Z" },
    ];
    const bundle = { getBundle: () => ({ ...world(["maren", "bray"]), referenceKits: world(["maren", "bray"]).referenceKits.map((kit) => ({ ...kit, looks })) }) as never };
    const look = (maren: string | undefined, bray: string | undefined): AudiobookLook => ({
      chapterHash: "h",
      at: "2026-10-03T09:00:00.000Z",
      characters: {
        maren: { name: "Maren", sheet: "maren", text: "Storm coat.", ...(maren !== undefined ? { lookId: maren } : {}) },
        bray: { name: "Bray", sheet: "bray", text: "Harbour coat.", ...(bray !== undefined ? { lookId: bray } : {}) },
      },
    });
    const two = chosen.slice(0, 2);
    const wide = pictureWho(bundle, IMAGE, two, { look: look("tk_storm", "tk_bare"), frame: "Wide · from behind" });
    assert.deepEqual(wide.map((who) => [who.reference, who.look]), [["references/maren/takes/tk_storm/storm.png", { lookId: "tk_storm", view: "full" }], ["references/bray/takes/tk_bare/bare.png", { lookId: "tk_bare", view: "full" }]]);
    const close = pictureWho(bundle, IMAGE, two, { look: look("tk_storm", "tk_bare"), frame: "Medium two-shot across the table" });
    assert.deepEqual(close.map((who) => [who.reference, who.look?.view]), [["references/maren/takes/tk_close/close.png", "close"], ["references/bray/takes/tk_bare/bare.png", "full"]], "a look with no close view rides full body");
    assert.ok(close.every((who) => who.carried), "one reference a person, so both fit a model that takes two");
    const none = pictureWho(bundle, IMAGE, two, { look: look(undefined, "tk_gone"), frame: "Close-up" });
    assert.deepEqual(none.map((who) => [who.reference, who.look]), [["references/maren/head-front.png", undefined], ["references/bray/head-front.png", undefined]], "no look chosen, or one the kit no longer holds: the main photo rides");
    assert.deepEqual(ridingPicks(close), { maren: { lookId: "tk_storm", view: "close" }, bray: { lookId: "tk_bare", view: "full" } });
  });

  it("takes the close view for Two-shot, Medium close-up, Close-up and Extreme close-up, the full body for the rest", () => {
    for (const frame of ["Two-shot", "Medium two-shot across the table", "Medium close-up", "Close-up · her face", "Extreme close-up, Ife's eyes"]) assert.equal(lookViewFor(frame), "close", frame);
    for (const frame of ["Establishing", "Wide · from behind", "Medium wide", "Medium", "Detail, her fingers on his forearm", "Over the shoulder", undefined]) assert.equal(lookViewFor(frame), "full", String(frame));
  });

  it("lists a sheet with no picture as having none, so the card can say `Make a reference`", () => {
    const who = pictureWho({ getBundle: () => world(["maren"]) as never }, IMAGE, chosen);
    assert.deepEqual(who.map((entry) => [entry.key, entry.reference, entry.carried]), [["maren", "references/maren/head-front.png", true], ["bray", null, false], ["odile", null, false], ["stair", null, false]]);
  });
});

describe("the prompt and the price", () => {
  it("is cut after the last whole sentence that fits, else at a word", () => {
    assert.equal(clipPrompt("One. Two. Three is longer.", 14), "One. Two.");
    assert.equal(clipPrompt("alpha beta gamma delta", 12), "alpha beta");
    assert.equal(clipPrompt("  short   one  ", 50), "short one");
  });

  it("asks for widescreen only where the model offers it, and prices what the Bench will plan", () => {
    assert.equal(pictureAspect(IMAGE), "16:9");
    assert.equal(pictureAspect({ ...IMAGE, provider: "openai", limits: { aspects: ["1:1"] } }), undefined);
    assert.equal(pictureQuote(IMAGE, 0), 40_000);
    assert.equal(pictureQuote(IMAGE, 2), 50_000);
  });

  it("sends the block, the look lines and the people with their sheets' words, and the chapter's mood", () => {
    const prompt = buildPicturePrompt({
      title: "Her own hand",
      mood: "Salt-bleached realism.",
      synopsis: "Maren audits the ledger.",
      block: { key: "p0.0", text: "Maren reads it twice." },
      before: "The rail is wet.",
      lines: [{ label: "Place", text: "Dawn." }, { label: "Maren", text: "Oilskin." }],
      people: [{ key: "maren-kest", name: "Maren", appearance: "Wiry." }],
      places: [{ key: "the-vigil", name: "The Vigil" }],
      never: [],
      maxChars: 900,
    });
    for (const part of ["Maren: Oilskin.", "[maren-kest] Maren — Wiry.", "[the-vigil] The Vigil", "Salt-bleached realism.", "Before: The rail is wet.", "at most 900 characters", "## The block [p0.0]"]) assert.ok(prompt.includes(part), part);
  });
});

describe("Generate (R-99)", () => {
  const make = (send: Harness["send"], over: Partial<Extract<ClientMessage, { kind: "make-audiobook-picture" }>> = {}) =>
    send({ kind: "make-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", prompt: "Maren on the rail at dawn.", who: ["maren-kest", "bray-half-hitch"], confirmedMicroUsd: 45_000, requestId: "01J00000000000000000000002", ...over });

  it("goes through the Bench: a session of its own, the references attached, the price held to the press, the picture filed on the block", () =>
    withHarness(async ({ events, send, store, worldDir, enqueued, schemaVersion }) => {
      await suggest(send);
      await make(send);
      const states = madeEvents(events).map((event) => event.state);
      assert.deepEqual(states, ["making", "made"]);
      const done = madeEvents(events).at(-1)!;
      assert.ok(done.sessionId, "the Bench session it was made in");
      const record = done.record!;
      const picture = record.pictures!["p0.0"]!;
      assert.equal(picture.source, "generated");
      assert.match(picture.file, /^artifacts\//);
      assert.deepEqual(picture.look?.who, ["maren-kest", "bray-half-hitch"], "it keeps who was in it and the lines it was made under");
      // Every window learns of the picture as it learns of any record write: the margin and the panel read it there.
      const written = events.filter((event) => event.type === "audiobook.record" && event.record?.pictures?.["p0.0"] !== undefined);
      assert.equal(written.length, 1, "the record the picture stands in is sent as a record");
      assert.equal((written[0] as { requestId?: string }).requestId, "01J00000000000000000000002");
      assert.equal(schemaVersion(), AUDIOBOOK_LOOK_SCHEMA_VERSION);
      // The Bench's own gate planned it: one job, the price of one picture and one reference.
      assert.equal(enqueued.length, 1);
      assert.equal(enqueued[0]!.estimatedMicroUsd, 45_000);
      assert.deepEqual((enqueued[0]!.params as { references?: string[] }).references, ["references/maren-kest/head-front.png"], "Maren by her sheet's main picture; Bray has none and is not sent");
      const session = await new BenchStore(sessionDir(worldDir, done.sessionId as never)).fold();
      const take = session!.takes[0]!;
      assert.equal(take.request.references.length, 1);
      assert.match(take.request.brief, /Maren on the rail at dawn\./);
      assert.match(take.request.brief, /Maren Kest is shown in @Image 1\./);
      assert.match(take.request.brief, /Light and mood: /);
      assert.equal(take.disposition, "filed", "kept as an artifact of the world");
      assert.ok(store()!.getBundle().artifacts.some((artifact) => `artifacts/${artifact.file}` === picture.file));
      // The look has since changed: the picture is marked, never remade.
      const look: AudiobookLook = { ...(record.look as AudiobookLook), characters: { ...record.look!.characters, "maren-kest": { ...record.look!.characters["maren-kest"]!, text: "A red coat." } } };
      assert.equal(pictureLookChanged(picture.look, look), true);
    }));

  it("sends the chosen look's image and not the main photo, and the picture keeps which look rode (R-119)", () =>
    withHarness(
      async ({ events, send, enqueued, store }) => {
        await acceptCharacterLook(store()!, "maren-kest", { id: LOOK_ID, file: `takes/${LOOK_ID}/look.png`, kind: "costume", prompt: "Storm coat, hood up.", takeId: LOOK_ID, artDirectionVersion: 1, framing: "full-body", close: { file: `takes/${CLOSE_ID}/close.png`, takeId: CLOSE_ID } });
        await suggest(send);
        const before = suggestion(events).suggestion!;
        assert.equal(before.who[0]!.reference, "references/maren-kest/head-front.png", "no look chosen yet: the main photo");
        await send({ kind: "choose-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, key: "maren-kest", sheet: "maren-kest", lookId: LOOK_ID, requestId: "01J00000000000000000000003" });
        await suggest(send);
        const after = suggestion(events).suggestion!;
        assert.deepEqual([after.who[0]!.reference, after.who[0]!.look], [`references/maren-kest/takes/${LOOK_ID}/look.png`, { lookId: LOOK_ID, view: "full" }], "no frame named: the full body");
        assert.deepEqual(after.look?.looks, { "maren-kest": { lookId: LOOK_ID, view: "full" } });
        await make(send);
        const done = madeEvents(events).at(-1)!;
        assert.equal(done.state, "made", done.reason);
        assert.deepEqual((enqueued[0]!.params as { references?: string[] }).references, [`references/maren-kest/takes/${LOOK_ID}/look.png`], "the look, never the main photo beside it");
        const picture = done.record!.pictures!["p0.0"]!;
        assert.deepEqual(picture.look?.looks, { "maren-kest": { lookId: LOOK_ID, view: "full" } });
        assert.equal(pictureLookChanged(picture.look, done.record!.look), false);
      },
      {
        prepare: async (worldDir) => {
          for (const [id, name] of [[LOOK_ID, "look.png"], [CLOSE_ID, "close.png"]] as const) {
            await mkdir(join(worldDir, "references", "maren-kest", "takes", id), { recursive: true });
            await writeFile(join(worldDir, "references", "maren-kest", "takes", id, name), pngBytes());
          }
        },
      },
    ));

  it("refuses a price that has moved past the one the press showed, and spends nothing", () =>
    withHarness(async ({ events, send, enqueued }) => {
      await suggest(send);
      await make(send, { confirmedMicroUsd: 44_999 });
      const failed = madeEvents(events).at(-1)!;
      assert.equal(failed.state, "failed");
      assert.match(failed.reason ?? "", /^the price moved · ~\$0\.05/);
      assert.equal(enqueued.length, 0, "no job was queued");
      assert.ok(failed.sessionId, "the session stays in the Bench to be opened");
    }));

  it("holds a take that fails with the provider's reason and leaves the block as it was", async () => {
    await withHarness(async ({ events, send, store }) => {
      await suggest(send);
      await make(send);
      const failed = madeEvents(events).at(-1)!;
      assert.equal(failed.state, "failed");
      assert.equal(failed.reason, "the provider refused the prompt");
      assert.equal(failed.record, undefined);
      const held = await readAudiobook(store()!, LEDGER, CHAPTER);
      assert.ok(held !== null && held !== "unreadable");
      assert.equal(held.pictures, undefined, "no picture was set on the block");
    }, { land: "fail" });
  });

  it("makes only a block the chapter still has, and says so in one clause", () =>
    withHarness(async ({ events, send, enqueued }) => {
      await suggest(send);
      await make(send, { block: "p99.0" });
      const failed = madeEvents(events).at(-1)!;
      assert.equal(failed.state, "failed");
      assert.equal(failed.reason, "that block is no longer in the chapter");
      assert.equal(enqueued.length, 0);
    }));
});
