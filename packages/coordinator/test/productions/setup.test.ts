import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid, type ConversationId } from "@arke-studio/contracts";
import { ProductionSetupService, recoverProductionSetups } from "../../src/productions/setup.js";
import { ProductionSetupConversationStore } from "../../src/productions/setup-store.js";
import { createProductionFromPlan } from "../../src/productions/ops.js";
import { saveProductionNarrative } from "../../src/productions/narrative.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { discoverConversations } from "../../src/world-chat/discover.js";
import { WorldStore } from "../../src/world/store.js";
import { CrashSignal } from "../../src/world/commit.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const CLOCK = "2026-09-08T09:00:00.000Z";
async function open() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  const service = new ProductionSetupService(store);
  const id = `cv_${ulid()}` as ConversationId;
  await service.start(id);
  await service.update(id, { expectedRevision: 1, fields: {
    title: "The crossing", narrative: { direction: "A return becomes a departure." }, openQuestions: ["What happens next?"],
  }, scenes: [{ key: "arrival", title: "Arrival", synopsis: "The boat returns." }] });
  return { store, service, id };
}

describe("durable production setup lifecycle (issue #976)", () => {
  it("resumes an empty setup header without duplicating initialization", async () => {
    const { store, service } = await open();
    const id = `cv_${ulid()}` as ConversationId;
    await store.ownedWrite(() => new WorldChatStore(conversationDir(store.dir, id)).create(id, CLOCK));
    assert.equal((await service.resume(id)).draft.revision, 1);
    assert.equal((await service.resume(id)).draft.revision, 1);
    await service.discard(id);
  });

  it("recovers other setups even when one private record cannot be repaired", async () => {
    const { store, service, id } = await open();
    const badId = `cv_${ulid()}` as ConversationId;
    const reviewed = await service.review(id, 2);
    await store.ownedWrite(async () => {
      const log = new WorldChatStore(conversationDir(store.dir, badId));
      await log.create(badId, CLOCK);
      await log.append({ type: "conversation.created", title: "Invalid setup", entryContext: { kind: "production-setup", setupId: id } }, { at: "2026-09-08T10:00:00.000Z" });
      await new WorldChatStore(conversationDir(store.dir, id)).append({
        type: "production-setup.updated", state: { ...reviewed, status: "creating" },
      }, { at: CLOCK });
    });
    await store.close();
    const reopened = await WorldStore.open(store.dir, { clock: () => CLOCK });
    closeOnCleanup(() => reopened.close());
    const found = await reopened.ownedWrite(() => discoverConversations(reopened.dir));
    assert.ok(found.summaries.findIndex(row => row.id === badId) < found.summaries.findIndex(row => row.id === id));
    await assert.rejects(recoverProductionSetups(reopened), AggregateError);
    assert.equal((await new ProductionSetupService(reopened).resume(id)).status, "draft");
  });

  it("completes a setup interrupted between its context and initial draft, then permits resume and discard", async () => {
    const { store } = await open();
    const id = `cv_${ulid()}` as ConversationId;
    const log = new WorldChatStore(conversationDir(store.dir, id));
    await store.ownedWrite(async () => {
      await log.create(id, CLOCK);
      await log.append({ type: "conversation.created", title: "New production", entryContext: { kind: "production-setup", setupId: id } }, { at: CLOCK });
    });
    await store.close();
    const reopened = await WorldStore.open(store.dir, { clock: () => CLOCK });
    closeOnCleanup(() => reopened.close());
    await recoverProductionSetups(reopened);
    const service = new ProductionSetupService(reopened);
    const state = await service.resume(id);
    assert.equal(state.draft.revision, 1);
    assert.equal(state.status, "draft");
    assert.deepEqual(await service.resume(id), state, "recovery initializes only once");
    await service.discard(id);
    await assert.rejects(access(conversationDir(reopened.dir, id)));
  });

  for (const stage of ["prepared-written", "staged-written", "committing-marked", "renamed:0", "changes-appended"] as const) {
    it(`recovers setup creation at ${stage} without duplicating or losing the outline`, async () => {
      const { store, service, id } = await open();
      const reviewed = await service.review(id, 2);
      const commit = store.commit.bind(store);
      store.commit = (input, hooks, precondition) => commit(input, input.kind === "production-create"
        ? { at: at => { if (at === stage) throw new CrashSignal(stage); } } : hooks, precondition);
      await assert.rejects(service.create(id, 2, reviewed.review!.id), CrashSignal);
      await store.close();
      const reopened = await WorldStore.open(store.dir, { clock: () => CLOCK });
      closeOnCleanup(() => reopened.close());
      assert.deepEqual(reopened.getBundle().externalEdits, []);
      await recoverProductionSetups(reopened);
      const recovered = new ProductionSetupService(reopened);
      const state = await recovered.resume(id);
      assert.equal(state.draft.scenes[0]!.synopsis, "The boat returns.");
      const rolledBack = stage === "prepared-written" || stage === "staged-written";
      assert.equal(state.status, rolledBack ? "draft" : "created");
      if (rolledBack) {
        assert.equal(reopened.getBundle().productions.some(p => p.meta.id === "the-crossing"), false);
        const next = await recovered.review(id, 2);
        await recovered.create(id, 2, next.review!.id);
      } else await recovered.create(id, 2, reviewed.review!.id);
      assert.equal(reopened.getBundle().productions.filter(p => p.meta.id === "the-crossing").length, 1);
    });
  }

  it("resumes a reviewed draft and redelivers one committed production with the conversation attached", async () => {
    const { store, service, id } = await open();
    const reviewed = await service.review(id, 2);
    assert.deepEqual(await service.resume(id), reviewed);
    const created = await service.create(id, 2, reviewed.review!.id);
    assert.equal(created.status, "created");
    assert.deepEqual(await service.create(id, 2, reviewed.review!.id), created);
    assert.equal(store.getBundle().productions.filter(p => p.meta.id === created.productionId).length, 1);
    const loaded = await new WorldChatService(store.dir).load(id);
    assert.deepEqual(loaded!.entryContext, { kind: "production", productionId: created.productionId });
    assert.deepEqual(loaded!.productionSetup!.draft.openQuestions, ["What happens next?"]);
    await assert.rejects(service.discard(id), /creation/);
  });

  it("refuses a moved draft, keeps independent drafts separate, and discards only private setup", async () => {
    const { store, service, id } = await open();
    const reviewed = await service.review(id, 2);
    const other = `cv_${ulid()}` as ConversationId;
    await service.start(other);
    await service.update(id, { expectedRevision: 2, fields: { title: "Changed title" } });
    await assert.rejects(service.create(id, 2, reviewed.review!.id), /review has changed/);
    assert.equal((await service.resume(other)).draft.title, "");
    const before = store.getBundle().productions.length;
    await service.discard(id);
    await assert.rejects(access(conversationDir(store.dir, id)));
    assert.equal(store.getBundle().productions.length, before);
    assert.equal((await service.resume(other)).status, "draft");
  });

  it("finishes attachment after a crash between authored commit and conversation acknowledgement", async () => {
    const { store, service, id } = await open();
    const reviewed = await service.review(id, 2);
    const log = new WorldChatStore(conversationDir(store.dir, id));
    await store.ownedWrite(() => log.append({
      type: "production-setup.updated", state: { ...reviewed, status: "creating" },
    }, { at: CLOCK }));
    await createProductionFromPlan(store, reviewed.review!.plan, {
      source: "test-crash", requestId: reviewed.review!.id, precondition: () => null,
    });
    await store.close();
    const reopened = await WorldStore.open(store.dir, { clock: () => CLOCK });
    closeOnCleanup(() => reopened.close());
    await recoverProductionSetups(reopened);
    const loaded = await new WorldChatService(reopened.dir).load(id);
    assert.equal(loaded!.productionSetup!.status, "created");
    assert.deepEqual(loaded!.entryContext, { kind: "production", productionId: "the-crossing" });
    assert.equal(reopened.getBundle().productions.filter(p => p.meta.id === "the-crossing").length, 1);
  });

  it("never retries a creating record before startup journal recovery", async () => {
    const { store, service, id } = await open();
    const reviewed = await service.review(id, 2);
    await store.ownedWrite(() => new WorldChatStore(conversationDir(store.dir, id)).append({
      type: "production-setup.updated", state: { ...reviewed, status: "creating" },
    }, { at: CLOCK }));
    await assert.rejects(new ProductionSetupService(store).create(id, 2, reviewed.review!.id), /awaiting recovery/);
    await assert.rejects(service.discard(id), /creation/);
    await store.close();
    const reopened = await WorldStore.open(store.dir, { clock: () => CLOCK });
    closeOnCleanup(() => reopened.close());
    await recoverProductionSetups(reopened);
    assert.equal((await new ProductionSetupService(reopened).resume(id)).status, "draft");
  });

  it("versions a film narrative after handoff and rejects stale saves", async () => {
    const { store, service, id } = await open();
    const reviewed = await service.review(id, 2);
    await service.create(id, 2, reviewed.review!.id);
    await saveProductionNarrative(store, "the-crossing", 1, { direction: "A new direction.", ending: "Home." });
    await assert.rejects(saveProductionNarrative(store, "the-crossing", 1, { ending: "Old draft." }), /changed/);
    assert.equal(store.getBundle().productions.find(p => p.meta.id === "the-crossing")!.narrative!.version, 2);
    const v1 = JSON.parse(await readFile(join(store.dir, ".history/productions/the-crossing/narrative/v1.json"), "utf8"));
    assert.equal(v1.direction, "A return becomes a departure.");
  });

  it("refuses conversation writes after the world has closed", async () => {
    const { store, id } = await open();
    const log = new ProductionSetupConversationStore(store, id);
    await store.close();
    await assert.rejects(log.append({ type: "conversation.archived" }, { at: CLOCK }), /closed|writable/);
  });
});
