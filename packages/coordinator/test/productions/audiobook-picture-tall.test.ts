import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TALL_PICTURE_BRIEF, type ChapterAudiobook, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { readAudiobook, readAudiobookBook } from "../../src/productions/audiobook.js";
import { CHAPTER, IMAGE, LEDGER, WORLD_ID, withHarness, type Harness } from "./picture-harness.js";

/**
 * Picture shapes (design turn 235, SPEC-047 R-195 – R-200): a block's picture made Tall from the
 * picture it has, which rides as the only reference; a new picture keeps its old Tall, marked; the
 * book's missing Talls made one at a time; and a model that makes no 9:16 refused in one clause.
 */
type MadeEvent = Extract<DomainEvent, { type: "audiobook.picture-made" }>;
type TallProgress = Extract<DomainEvent, { type: "audiobook.tall-progress" }>;

// A model whose row lists 9:16; IMAGE lists 16:9 and 1:1 only, so it makes no Tall (R-200).
const TALL_IMAGE = { ...IMAGE, limits: { ...IMAGE.limits, aspects: ["16:9", "9:16", "1:1"] } };
let request = 0;
const nextId = () => `01J0000000000000000001${String((request += 1)).padStart(4, "0")}`;
const make = (send: Harness["send"]) =>
  send({ kind: "make-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", prompt: "Maren on the rail at dawn.", who: [], confirmedMicroUsd: 45_000, requestId: nextId() });
const makeTall = (send: Harness["send"], over: Partial<Extract<ClientMessage, { kind: "make-audiobook-tall-picture" }>> = {}) =>
  send({ kind: "make-audiobook-tall-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", confirmedMicroUsd: 45_000, requestId: nextId(), ...over });
const answer = (events: DomainEvent[]): MadeEvent => {
  const found = events.filter((event): event is MadeEvent => event.type === "audiobook.picture-made").at(-1);
  assert.ok(found, "the make is answered");
  return found;
};
const held = async (h: Pick<Harness, "store">): Promise<ChapterAudiobook> => {
  const record = await readAudiobook(h.store()!, LEDGER, CHAPTER);
  assert.ok(record !== null && record !== "unreadable", "the chapter's record reads");
  return record;
};

describe("a block's picture made Tall (turn 235, R-196, R-197)", () => {
  it("recomposes the picture the block has, with it as the only reference, and files the Tall beside it", () =>
    withHarness(async (h) => {
      await make(h.send);
      assert.equal(answer(h.events).state, "made", answer(h.events).reason);
      const wide = (await held(h)).pictures!["p0.0"]!;

      await makeTall(h.send);
      const made = answer(h.events);
      assert.equal(made.state, "made", made.reason);
      const job = h.enqueued.at(-1)!.params as { references?: string[]; prompt?: string; output?: { aspect?: string; width?: number; height?: number } };
      assert.deepEqual(job.references, [wide.file], "the picture rides alone");
      assert.deepEqual([job.output?.aspect, job.output?.width, job.output?.height], ["9:16", 864, 1536]);
      assert.ok(String(job.prompt ?? "").startsWith(TALL_PICTURE_BRIEF.slice(0, 40)), "sent as the Tall brief");
      const picture = (await held(h)).pictures!["p0.0"]!;
      assert.equal(picture.file, wide.file, "the picture is untouched");
      assert.ok(picture.tall !== undefined && picture.tall.file.startsWith("artifacts/") && picture.tall.file !== wide.file);
      assert.equal(picture.tall.from, wide.file);
    }, { model: TALL_IMAGE }));

  it("keeps the old Tall, marked, when the picture is made again (call 3)", () =>
    withHarness(async (h) => {
      await make(h.send);
      await makeTall(h.send);
      const before = (await held(h)).pictures!["p0.0"]!;
      await make(h.send);
      assert.equal(answer(h.events).state, "made");
      const after = (await held(h)).pictures!["p0.0"]!;
      assert.notEqual(after.file, before.file);
      assert.deepEqual(after.tall, before.tall, "kept, not removed");
      assert.notEqual(after.tall!.from, after.file, "from an earlier picture");
    }, { model: TALL_IMAGE }));

  it("is refused in one clause by a model that makes no 9:16 (R-200)", () =>
    withHarness(async (h) => {
      await make(h.send);
      const jobs = h.enqueued.length;
      await makeTall(h.send);
      const made = answer(h.events);
      assert.equal(made.state, "failed");
      assert.equal(made.reason, "Stair Image makes no 9:16");
      assert.equal(h.enqueued.length, jobs, "nothing was asked for");
    }));

  it("takes the shape from the brief on the ChatGPT route, whose image tool takes no size", () =>
    withHarness(async (h) => {
      await make(h.send);
      await makeTall(h.send);
      assert.equal(answer(h.events).state, "made", answer(h.events).reason);
      // Its client sends no size (manifest: providerSelectedSize), so the brief carries the shape.
      assert.match(String((h.enqueued.at(-1)!.params as { prompt?: string }).prompt), /tall 9:16 portrait/);
    }, { model: { ...IMAGE, id: "codex-image", provider: "codex", limits: { providerSelectedSize: true }, pricing: { kind: "included-plan" } } }));
});

describe("the book's shapes and its missing Talls (turn 235a, R-195, R-199)", () => {
  it("keeps the book's shapes on its record, Wide alone as no field at all", () =>
    withHarness(async (h) => {
      const shapes = async () => {
        const book = await readAudiobookBook(h.store()!, LEDGER);
        return book === null || book === "unreadable" ? undefined : book.pictureShapes;
      };
      await h.send({ kind: "set-audiobook-picture-shapes", worldId: WORLD_ID, productionId: LEDGER, shapes: ["tall", "wide"] });
      assert.deepEqual(await shapes(), ["wide", "tall"], "in their fixed order");
      await h.send({ kind: "set-audiobook-picture-shapes", worldId: WORLD_ID, productionId: LEDGER, shapes: ["wide"] });
      assert.equal(await shapes(), undefined);
    }));

  it("makes a Tall for every picture without one, and none again for one that has it", () =>
    withHarness(async (h) => {
      await make(h.send);
      const progress = () => h.events.filter((event): event is TallProgress => event.type === "audiobook.tall-progress").at(-1)!;
      await h.send({ kind: "make-audiobook-tall-pictures", worldId: WORLD_ID, productionId: LEDGER, confirmedMicroUsd: 100_000, requestId: nextId() });
      assert.deepEqual([progress().state, progress().total, progress().made, progress().failed], ["done", 1, 1, []]);
      assert.ok((await held(h)).pictures!["p0.0"]!.tall !== undefined);
      const jobs = h.enqueued.length;
      await h.send({ kind: "make-audiobook-tall-pictures", worldId: WORLD_ID, productionId: LEDGER, confirmedMicroUsd: 100_000, requestId: nextId() });
      assert.deepEqual([progress().state, progress().total], ["done", 0]);
      assert.equal(h.enqueued.length, jobs, "nothing made twice");
    }, { model: TALL_IMAGE }));
});
