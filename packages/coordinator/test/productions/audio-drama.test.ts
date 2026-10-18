import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, productionShape, ulid, type ConversationId } from "@arke-studio/contracts";
import { ProductionSetupService, assertSourceReadForPlan } from "../../src/productions/setup.js";
import { createProduction, createProductionFromPlan, planProductionCreation, validateProductionMetadataChanges } from "../../src/productions/ops.js";
import { productionRecord } from "../../src/world-chat/production-record.js";
import { chapterFence } from "../../src/world-chat/target-reads.js";
import { setupSourceDigest } from "../../src/productions/setup-plan.js";
import { productionSetupBrief } from "../../src/productions/setup-brief.js";
import { WorldStore } from "../../src/world/store.js";
import { AUDIO_DRAMA_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { projectWorkspace, wordSourceRead } from "../../src/world-chat/project.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The audio drama (SPEC-057, issue 1857): a Story production of its own kind, created from the door
 * or from setup, that holds its plan in audio-drama.json and none of a book's or a season's records.
 */

const CLOCK = "2026-10-18T09:00:00.000Z";
async function open() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}
const exists = (path: string) => access(path).then(() => true, () => false);
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("an audio drama is a story kind with its own plan (SPEC-057)", () => {
  it("is created from the door as a story with the default plan, raising the world first (D-2, R-82)", async () => {
    const store = await open();
    const id = await createProduction(store, { title: "Low Water", medium: "story", productionKind: "audio-drama" });
    const root = join(store.dir, "productions", id);
    const meta = await json(join(root, "production.json"));
    assert.equal(meta.format, "story");
    assert.equal(meta.medium, "story");
    assert.equal(meta.kind, "audio-drama");
    assert.deepEqual(await json(join(root, "audio-drama.json")), { version: 1, plan: { episodes: 6, minutes: 25, keptFromListener: [] } });
    assert.equal(await exists(join(root, "season.json")), false, "no video season");
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= AUDIO_DRAMA_SCHEMA_VERSION);
    const bundled = store.getBundle().productions.find(production => production.meta.id === id)!;
    assert.equal(productionShape(bundled.meta).isAudioDrama, true);
    assert.equal(bundled.audioDrama?.plan.episodes, 6, "the scan reads the plan back");
  });

  it("starts setup seeded from the door, refusing a source that is not a story to adapt (R-3)", async () => {
    const store = await open();
    const service = new ProductionSetupService(store);
    const refused = `cv_${ulid()}` as ConversationId;
    await assert.rejects(service.start(refused, { kind: "audio-drama", source: { productionId: "saltlight" } }), /Adapt from names a story/);
    const id = `cv_${ulid()}` as ConversationId;
    const state = await service.start(id, { kind: "audio-drama", source: { productionId: "the-ledger-of-nights" }, title: "The Ledger of Nights" });
    assert.equal(state.draft.kind, "audio-drama");
    assert.equal(state.draft.title, "The Ledger of Nights");
    assert.deepEqual(state.draft.source, { productionId: "the-ledger-of-nights" });
    assert.deepEqual(state.draft.audioDrama, { episodes: 6, minutes: 25, keptFromListener: [] });
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= AUDIO_DRAMA_SCHEMA_VERSION, "raised before the first draft naming the kind");
    const again = await service.start(id, { kind: "film" });
    assert.equal(again.draft.kind, "audio-drama", "a seed never rewrites a setup that exists");
    // A retried start is answered by the setup it began, even when its seed would now be refused.
    const retried = await service.start(id, { kind: "audio-drama", source: { productionId: "saltlight" } });
    assert.deepEqual(retried.draft.source, { productionId: "the-ledger-of-nights" });
  });

  it("refuses a plan for a story until every active chapter of it has been read whole (R-5)", async () => {
    const store = await open();
    const service = new ProductionSetupService(store);
    const draft = (await service.start(`cv_${ulid()}` as ConversationId, { kind: "audio-drama", source: { productionId: "the-ledger-of-nights" } })).draft;
    const story = store.getBundle().productions.find(production => production.meta.id === "the-ledger-of-nights")!;
    const chapters = story.chapters.filter(chapter => chapter.retired !== true);
    assert.ok(chapters.length >= 2, "the fixture story has chapters to read");
    const runId = newId("run");
    const whole = (id: string, extra: object = {}) => ({ id: newId("check"), runId, tool: "target-read", status: "complete", consulted: [], at: CLOCK,
      target: { requirement: "chapters", id: `the-ledger-of-nights:${id}` }, complete: true,
      observedRevisionOrDigest: chapterFence(story, id.split(":")[0]!), ...extra }) as never;
    const update = { expectedRevision: 1, fields: { audioDrama: { episodes: 6, minutes: 25, keptFromListener: [] } } };
    const allButLast = chapters.slice(0, -1).map(chapter => whole(chapter.id));
    assert.throws(() => assertSourceReadForPlan(store.getBundle(), update, draft, [...allButLast, whole(`${chapters.at(-1)!.id}:beats`)]),
      new RegExp(`${chapters.length - 1} of ${chapters.length} chapters read whole\\. Still to read with get_chapter \\(no section\\): ${chapters.at(-1)!.id}\\.`),
      "a beats read is not a reading of the chapter");
    assert.throws(() => assertSourceReadForPlan(store.getBundle(), update, draft, [...allButLast, whole(chapters.at(-1)!.id, { complete: false })]),
      /Still to read/, "nor is a page that is not the last");
    assert.throws(() => assertSourceReadForPlan(store.getBundle(), update, draft, [...allButLast, whole(chapters.at(-1)!.id, { observedRevisionOrDigest: "sha256:before-the-edit" })]),
      /Still to read/, "nor is a read of the chapter as it was before an edit");
    assert.doesNotThrow(() => assertSourceReadForPlan(store.getBundle(), update, draft, [...allButLast, whole(chapters.at(-1)!.id)]));
    assert.doesNotThrow(() => assertSourceReadForPlan(store.getBundle(), { expectedRevision: 1, fields: { title: "Low Water" } }, draft, []),
      "only a plan has to rest on the reading");
  });

  it("the reviewed digest covers the adapted story's chapters, so an edit between Review and Create is caught", async () => {
    const store = await open();
    const bundle = store.getBundle();
    const story = bundle.productions.find(production => production.meta.id === "the-ledger-of-nights")!;
    const edited = { ...bundle, productions: bundle.productions.map(production => production !== story ? production
      : { ...production, chapters: production.chapters.map((chapter, i) => i === 0 ? { ...chapter, hash: "sha256:edited" } : chapter) }) };
    assert.notEqual(setupSourceDigest(edited, story.meta.id), setupSourceDigest(bundle, story.meta.id));
    assert.equal(setupSourceDigest(edited), setupSourceDigest(bundle), "a setup that adapts nothing is not held to the story");
  });

  it("a prepared create without setup's content still writes the default plan (World Chat's production-create)", async () => {
    const store = await open();
    const plan = planProductionCreation(store.getBundle(), { title: "Low Water", medium: "story", productionKind: "audio-drama" }, CLOCK);
    await createProductionFromPlan(store, plan, { source: "test", requestId: ulid(), precondition: () => null });
    const root = join(store.dir, "productions", plan.production.id);
    assert.deepEqual(await json(join(root, "audio-drama.json")), { version: 1, plan: { episodes: 6, minutes: 25, keptFromListener: [] } });
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= AUDIO_DRAMA_SCHEMA_VERSION);
    const drama = store.getBundle().productions.find(production => production.meta.id === plan.production.id)!;
    assert.deepEqual((productionRecord(store.getBundle(), drama.meta.id) as { audioDrama?: unknown }).audioDrama, drama.audioDrama,
      "get_production hands Arke the plan its entry context points at");
  });

  it("a kind edit can neither make nor unmake an audio drama", async () => {
    const store = await open();
    const book = await createProduction(store, { title: "Empty book", medium: "story" });
    const drama = await createProduction(store, { title: "Low Water", medium: "story", productionKind: "audio-drama" });
    const of = (id: string) => store.getBundle().productions.find(production => production.meta.id === id)!;
    assert.throws(() => validateProductionMetadataChanges(of(book), { productionKind: "audio-drama" }), /audio drama requires a new production/);
    assert.throws(() => validateProductionMetadataChanges(of(drama), { productionKind: null }), /audio drama requires a new production/);
    assert.doesNotThrow(() => validateProductionMetadataChanges(of(drama), { title: "Low Water, again" }));
  });

  it("creates what setup agreed: the plan and its source, with no season, episodes or scenes (R-7, R-9)", async () => {
    const store = await open();
    const service = new ProductionSetupService(store);
    const id = `cv_${ulid()}` as ConversationId;
    await service.start(id, { kind: "audio-drama", source: { productionId: "the-ledger-of-nights" }, title: "The Ledger, for the ear" });
    const plan = {
      episodes: 6, minutes: 25, narrator: "narrated" as const,
      keptFromListener: [{ fact: "The ledger was forged", revealEpisode: 4 }],
      pilot: { title: "The tide turns", chapters: [3] },
    };
    await service.update(id, { expectedRevision: 1, fields: { audioDrama: plan } });
    const reviewed = await service.review(id, 2);
    assert.equal(reviewed.review!.plan.production.kind, "audio-drama");
    assert.equal(reviewed.review!.plan.production.aspect, undefined, "a story has no aspect");
    const created = await service.create(id, 2, reviewed.review!.id);
    const productionId = created.productionId!;
    const root = join(store.dir, "productions", productionId);
    assert.deepEqual(await json(join(root, "audio-drama.json")), { version: 1, plan, source: { productionId: "the-ledger-of-nights" } });
    assert.equal(await exists(join(root, "season.json")), false);
    assert.equal(await exists(join(root, "narrative.json")), false);
    assert.equal(await exists(join(root, "scenes")), false);
    assert.equal(store.getBundle().productions.find(production => production.meta.id === productionId)!.audioDrama?.plan.narrator, "narrated");
  });

  it("says how much of the story a setup reply read, a partial read by its count (R-5)", () => {
    const setupId = `cv_${ulid()}` as ConversationId;
    const runId = newId("run"), turnId = newId("turn"), messageId = newId("msg");
    const read = (id: string, complete = true) => ({ id: newId("check"), runId, tool: "target-read", status: "complete", consulted: [], at: CLOCK,
      target: { requirement: "chapters", id }, complete });
    const setup = { status: "draft", review: null, draft: {
      schemaVersion: 1, setupId, worldId: "w", revision: 2, title: "Low Water", kind: "audio-drama", aspect: "16:9", frameRate: 24,
      narrative: {}, arcs: [], references: [], openQuestions: [], episodes: [], scenes: [], source: { productionId: "low-water" },
      audioDrama: { episodes: 6, minutes: 25, keptFromListener: [] },
    } };
    const envelope = (seq: number, event: unknown) => ({ schemaVersion: 1, seq, eventId: `ce_${ulid()}`, at: CLOCK, event }) as never;
    const { view } = foldConversation(setupId, CLOCK, [
      envelope(1, { type: "conversation.created", title: "Low Water", entryContext: { kind: "production-setup", setupId } }),
      envelope(2, { type: "turn.completed", productionSetup: setup,
        message: { id: messageId, turnId, role: "studio", text: "Read.", attachmentIds: [], createdAt: CLOCK },
        run: { id: runId, turnId, basedOnConversationSeq: 1, status: "completed", adapter: "fake", harnessCleanup: "not-required",
          contextDigest: `sha256:${"a".repeat(64)}`, startedAt: CLOCK, endedAt: CLOCK },
        receipts: [read("low-water:tide"), read("low-water:bell"), read("low-water:tide"), read("low-water:tide:beats"),
          read("low-water:salt", false), read("undertow:one")],
        candidates: [], groups: [], tombstones: [] }),
    ]);
    assert.deepEqual(view.sourceReads, { [messageId]: { productionId: "low-water", chapters: 2 } }, "whole chapters of the source, each once");
    const projected = projectWorkspace(view, new Map(), { sourceStory: id => id === "low-water" ? { title: "Low Water", chapters: 3 } : null });
    assert.deepEqual(projected.messages[0]!.receipts, ["read Low Water · 2 of 3 chapters · nothing written"]);
    assert.equal(wordSourceRead({ productionId: "gone", chapters: 1 }, () => null), "read gone · 1 chapter · nothing written");
  });

  it("tells Arke to read, ask one question by example and propose one plan, only for an audio drama (R-5..R-8)", async () => {
    const store = await open();
    const service = new ProductionSetupService(store);
    const id = `cv_${ulid()}` as ConversationId;
    const drama = (await service.start(id, { kind: "audio-drama", source: { productionId: "the-ledger-of-nights" } })).draft;
    const read = async (tool: string, args: Record<string, unknown>) => ({
      result: tool === "get_chapter" ? { items: [] } : { id: args.id },
      receipt: { id: newId("check"), runId: newId("run"), tool: "get-entry", status: "complete", consulted: [], at: CLOCK },
    }) as never;
    const brief = await productionSetupBrief(store.getBundle(), drama, read, 400_000);
    assert.match(brief, /This production is an audio drama/);
    assert.match(brief, /exactly one question: whether a narrator guides the listener/);
    assert.match(brief, /"A narrator where needed", then "In the room"/);
    assert.match(brief, /propose one plan in fields\.audioDrama/);
    assert.match(brief, /Do not propose verdicts or an episode outline here/);
    assert.doesNotMatch(brief, /propose whether the screen keeps, cuts/, "a screen's verdicts are not asked of a drama");
    const original = (await service.start(`cv_${ulid()}` as ConversationId, { kind: "audio-drama" })).draft;
    const originalBrief = await productionSetupBrief(store.getBundle(), original, read, 400_000);
    assert.doesNotMatch(originalBrief, /one short moment of the source/, "an original drama has no source to sample");
    assert.match(originalBrief, /one short moment from what the author has told you of the drama/);
    const film = { ...drama, kind: "film" as const, audioDrama: undefined };
    const screen = await productionSetupBrief(store.getBundle(), film, read, 400_000);
    assert.doesNotMatch(screen, /This production is an audio drama/);
    assert.match(screen, /propose whether the screen keeps, cuts/);
  });
});
