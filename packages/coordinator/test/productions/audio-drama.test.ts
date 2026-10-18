import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, productionShape, ulid, type ConversationId } from "@arke-studio/contracts";
import { ProductionSetupService } from "../../src/productions/setup.js";
import { createProduction } from "../../src/productions/ops.js";
import { productionSetupBrief } from "../../src/productions/setup-brief.js";
import { WorldStore } from "../../src/world/store.js";
import { AUDIO_DRAMA_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
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
    const film = { ...drama, kind: "film" as const, audioDrama: undefined };
    const screen = await productionSetupBrief(store.getBundle(), film, read, 400_000);
    assert.doesNotMatch(screen, /This production is an audio drama/);
    assert.match(screen, /propose whether the screen keeps, cuts/);
  });
});
